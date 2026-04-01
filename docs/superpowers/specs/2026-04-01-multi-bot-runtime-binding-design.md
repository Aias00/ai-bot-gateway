# Multi-Bot Fixed-Runtime Design

Date: 2026-04-01
Status: Proposed

## Summary

The gateway currently supports both `codex` and `claude`, but runtime selection is effectively global or route-driven, and each chat platform is modeled as a single runtime instance. This does not support the target operating model:

- Multiple Discord bot instances online in one process
- Multiple Feishu bot instances online in one process
- Each bot instance fixed to one runtime: `codex` or `claude`
- Each channel/chat handled by exactly one bot instance

This design introduces bot instances as first-class configuration and runtime objects. Route ownership becomes bot-scoped, persistent state is namespaced by bot instance, and runtime choice is derived from the bot instance rather than from per-route fallback logic.

## Goals

- Support multiple Discord bot instances online at the same time
- Support multiple Feishu bot instances online at the same time
- Bind each bot instance to exactly one runtime
- Ensure all route/session state is isolated per bot instance
- Preserve backward compatibility for existing single-bot deployments

## Non-Goals

- Multiple bots responding in the same channel/chat
- Per-route runtime switching inside a bot instance
- Separate backend client processes per bot instance when the runtime type is the same
- New operator UX beyond what is required to expose bot identity and scoped bindings

## Current Constraints

The current implementation has three architectural constraints that block the target behavior:

1. Platform bootstrap is singleton-oriented.
   - `loadRuntimeBootstrapConfig()` reads one `DISCORD_BOT_TOKEN` and one Feishu app credential pair.
   - `buildRuntimes()` creates at most one Discord platform and one Feishu platform.

2. Runtime selection is not bot-scoped.
   - `turnRunner` resolves runtime from persisted binding runtime, then agent runtime, then global runtime.
   - `resolveRuntimeForAgent()` assumes runtime is an agent or global property.

3. Persistent state is not namespaced by bot instance.
   - Discord route ids are raw channel ids.
   - Feishu route ids are `feishu:<chat_id>`.
   - `state.json` bindings are keyed only by route id, with no bot instance dimension.

## Accepted Product Decisions

- Discord and Feishu both need multi-bot instance support
- Each bot instance is fixed to `codex` or `claude`
- Each channel/chat is owned by exactly one bot instance
- Route ownership should not require a repeated explicit `botId` field on every route

## Proposed Approach

Recommended approach: introduce a top-level `bots` registry in `config/channels.json`, with routes nested under each bot instance.

This was chosen over:

- Flat global routes with `botId` on every route
  - Smaller code diff, but higher long-term config error rate
- One process per bot
  - Smaller code diff, but avoids the core product requirement and fragments operations/state

## Configuration Model

### Top-Level Shape

```json
{
  "defaultModel": "gpt-5.3-codex",
  "defaultEffort": "medium",
  "approvalPolicy": "never",
  "sandboxMode": "workspace-write",
  "agents": {
    "codex-default": {
      "model": "gpt-5.3-codex",
      "runtime": "codex",
      "enabled": true
    },
    "claude-default": {
      "model": "claude-sonnet-4-6",
      "runtime": "claude",
      "enabled": true
    }
  },
  "bots": {
    "discord-codex-main": {
      "platform": "discord",
      "runtime": "codex",
      "auth": {
        "tokenEnv": "DISCORD_BOT_TOKEN_MAIN"
      },
      "settings": {
        "guildId": "123456789012345678",
        "allowedUserIdsEnv": "DISCORD_ALLOWED_USER_IDS_MAIN",
        "generalChannelId": "123456789012345679",
        "generalCwd": "/workspace/general"
      },
      "routes": {
        "123456789012345680": {
          "cwd": "/workspace/repo-a",
          "agentId": "codex-default"
        }
      }
    },
    "feishu-claude-support": {
      "platform": "feishu",
      "runtime": "claude",
      "auth": {
        "appIdEnv": "FEISHU_APP_ID_SUPPORT",
        "appSecretEnv": "FEISHU_APP_SECRET_SUPPORT",
        "verificationTokenEnv": "FEISHU_VERIFICATION_TOKEN_SUPPORT"
      },
      "settings": {
        "transport": "webhook",
        "webhookPath": "/feishu/support/events",
        "allowedOpenIdsEnv": "FEISHU_ALLOWED_OPEN_IDS_SUPPORT",
        "generalChatId": "oc_xxx",
        "generalCwd": "/workspace/support"
      },
      "routes": {
        "oc_repo_1": {
          "cwd": "/workspace/repo-b",
          "agentId": "claude-default"
        }
      }
    }
  }
}
```

### Rules

- `bot.runtime` is authoritative for runtime selection
- Routes are implicitly owned by the bot they are nested under
- Agent runtime metadata is retained for compatibility and validation only
- Secrets remain in environment variables; config points to env names rather than storing raw secrets
- Shared operational settings stay global unless they must vary by bot instance

## Core Internal Model

### New Identity Fields

- `botId`: stable identifier from `config.bots`
- `platform`: `discord` or `feishu`
- `externalRouteId`: raw platform route id
  - Discord: channel id
  - Feishu: chat id
- `scopedRouteId`: internal persistent route key

Recommended `scopedRouteId` format:

```text
bot:<botId>:route:<externalRouteId>
```

### Why `scopedRouteId` Exists

`bot token` identifies which bot received an inbound event, but it is not enough to safely key state and recovery. The gateway also needs a stable bot-aware key for:

- `state.json` binding isolation
- turn recovery and retry bookkeeping
- approval callback routing
- notification callback routing
- restart notice and route lookup flows

## Runtime Resolution

Runtime resolution changes from agent/global fallback to bot-scoped selection.

### New Rule

1. Determine the inbound `botId`
2. Load `bot.runtime`
3. Validate any referenced agent is compatible with that runtime
4. Use the shared backend client for that runtime type

### Consequences

- `resolveRuntimeForAgent()` no longer decides the execution runtime for a turn
- `binding.runtime` is persisted as diagnostic/state metadata, not as the source of runtime truth
- A `claude` bot cannot execute a `codex` agent, and vice versa; startup should fail fast on incompatible configuration

## Platform Instance Model

Platform registration moves from one platform object per platform type to one platform instance per configured bot.

### Discord

- Each Discord bot instance gets its own `discord.js` client
- Each client listens only for its own events
- Each client has its own slash command registration lifecycle
- Discord route handling remains single-owner because one channel is owned by one bot instance

### Feishu

- Each Feishu bot instance gets its own runtime object
- Long-connection mode runs independently per bot instance
- Webhook mode requires a unique `webhookPath` per Feishu bot instance
- A safe default may be derived as `/feishu/<botId>/events`

### Shared Backend Runtime Clients

Backend agent clients remain shared by runtime type:

- One shared Codex client for all `codex` bots
- One shared Claude client for all `claude` bots

This keeps process overhead low while still isolating chat platform state per bot.

## State and Recovery Changes

### `state.json`

Bindings move from:

- `threadBindings[repoChannelId]`

to:

- `threadBindings[scopedRouteId]`

Binding entries should include:

- `botId`
- `platform`
- `externalRouteId`
- `repoChannelId` set to `scopedRouteId` for compatibility with existing code paths
- `runtime`
- `agentId`
- `cwd`
- `codexThreadId`
- `updatedAt`

### Active Turn and Approval Tracking

The following stores move to `scopedRouteId`-based addressing:

- turn queues
- `activeTurns`
- `pendingApprovals`
- turn recovery snapshots
- source-message request lookup

Trackers should also carry:

- `botId`
- `platform`
- `externalRouteId`

This keeps callback routing precise when multiple bots of the same platform are online.

### Session Id Update Path

When Claude emits a real session id after a placeholder id, the update path must:

1. Find the binding by prior agent thread/session id
2. Resolve the owning `scopedRouteId`
3. Update only that binding

No global platform assumption is allowed in this flow.

## Message Routing and Commands

### Inbound Flow

1. A platform instance receives an event
2. The instance determines its own `botId`
3. The raw platform route id is converted to `scopedRouteId`
4. Route setup is resolved from the bot-local route registry
5. The turn is enqueued against `scopedRouteId`

### Commands

Existing commands stay in place, but scope becomes bot-aware.

Commands such as these act only on the current bot instance and current route:

- `!where`
- `!new`
- `!interrupt`
- approval actions
- retry flows

`!where` should expose:

- current `botId`
- current bot runtime
- current `scopedRouteId`
- current session binding

### Discord Repo Bootstrap

Discord auto-discovery and managed repo bootstrap currently depend on Codex project discovery. To reduce risk:

- Full `resync` and `rebuild` support stays enabled for Discord bots with `runtime=codex`
- Discord bots with `runtime=claude` support static routes, general channel behavior, approvals, and normal turn handling
- Claude-specific Discord auto-discovery is not part of this change

## Validation and Error Handling

Startup should fail fast on invalid bot configuration:

- missing or invalid `bot.runtime`
- missing auth env references
- duplicate external route ids under the same bot
- same platform webhook path collision
- route or agent incompatible with `bot.runtime`

Readiness becomes instance-aware:

- one degraded bot instance should not force unrelated bot instances offline
- readiness output should report degraded bot instances with `botId` and `platform`

Logging should include:

- `botId`
- `platform`
- `scopedRouteId` when present

## Backward Compatibility

### Config Compatibility

If `config.bots` is absent, the runtime should synthesize legacy defaults:

- `discord-default` when legacy Discord env vars are present
- `feishu-default` when legacy Feishu env vars are present

Legacy global `channels` entries should be attached to the synthesized default bot.

Legacy env support remains for single-bot mode:

- `DISCORD_BOT_TOKEN`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- related allowlist/general-channel env vars

### State Compatibility

Legacy `state.json` entries are upgraded when route ownership is unambiguous.

Rules:

- If only one bot exists for a platform, old bindings can be migrated into that bot namespace
- If multiple bots exist for a platform and a legacy binding lacks bot identity, the binding is dropped as ambiguous and a warning is logged

## Implementation Phases

### Phase 1: Config and Runtime Model

- Add `bots` schema and validation
- Add legacy-to-bot compatibility synthesis
- Introduce bot descriptors and bot-local route resolution

### Phase 2: Namespaced State

- Introduce `scopedRouteId`
- Migrate state store, queue keys, trackers, approvals, and recovery records
- Update session id replacement logic

### Phase 3: Multi-Instance Platform Startup

- Create one Discord client per Discord bot
- Create one Feishu runtime per Feishu bot
- Update platform registry to handle bot instances

### Phase 4: Runtime Decision Cleanup

- Remove agent/global fallback as the source of runtime execution
- Enforce bot-fixed runtime selection end-to-end

### Phase 5: Documentation and Operator UX

- Update README and examples for single-bot compatibility mode
- Add multi-bot config examples for Discord and Feishu
- Update operator commands and status output to show `botId`

## Testing Strategy

### Config Tests

- legacy single-bot config still loads
- multi-bot config loads successfully
- invalid bot/runtime/env combinations fail fast
- webhook path collisions are rejected

### State and Recovery Tests

- legacy bindings migrate into a bot namespace when unambiguous
- ambiguous bindings are dropped with a warning
- `scopedRouteId` persists correctly
- Claude session id replacement updates the correct binding

### Platform Tests

- two Discord bots online at once, with isolated inbound handling
- two Feishu bots online at once, with isolated inbound handling
- webhook and long-connection separation by bot instance
- Codex and Claude bots coexist without crossed callbacks

### Command and Approval Tests

- `!where`, `!new`, and `!interrupt` act on the current bot scope only
- approvals resolve to the correct channel/chat and bot instance
- retry and turn-status lookups resolve through `scopedRouteId`

## Risks

- The current codebase still contains many assumptions that route id implies platform identity; these must be removed carefully
- Discord repo bootstrap has Codex-specific behavior that should not be generalized blindly to Claude bots
- Backward-compatible state migration must prefer safe drop-with-warning over unsafe inference

## Recommended Initial Delivery Scope

Deliver the smallest complete slice that proves the target model:

- Discord multi-bot support
- Feishu multi-bot support
- fixed runtime per bot
- namespaced route/session state
- approvals, notifications, and turn recovery working under bot scope

Do not expand this change set with:

- cross-bot operator dashboards
- migration CLIs beyond automatic safe migration
- new UX not required for bot identity visibility

## Approval Notes

This document reflects the following accepted decisions from the design discussion:

- both Discord and Feishu need multi-bot support
- each bot instance is fixed to `codex` or `claude`
- each channel/chat is owned by one bot only
- route ownership should be implicit from the bot-local route configuration
