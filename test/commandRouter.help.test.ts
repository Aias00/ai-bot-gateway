import { describe, expect, test } from "bun:test";
import { createCommandRouter } from "../src/commands/router.js";
import { makeScopedRouteId } from "../src/bots/scopedRoutes.js";

function createRouterWithRegistry(registry: unknown) {
  return createCommandRouter({
    ChannelType: { GuildText: 0 },
    isGeneralChannel: () => false,
    fs: { mkdir: async () => {}, stat: async () => {} },
    path: { join: (...parts: string[]) => parts.join("/"), dirname: () => "/tmp" },
    execFileAsync: async () => {},
    repoRootPath: "/tmp/repos",
    managedChannelTopicPrefix: "codex-cwd:",
    codexBin: "codex",
    codexHomeEnv: null,
    statePath: "/tmp/state.json",
    configPath: "/tmp/channels.json",
    config: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      defaultModel: "gpt-5.3-codex"
    },
    state: {
      getBinding: () => null,
      clearBinding: () => {},
      save: async () => {}
    },
    codex: {
      request: async () => {}
    },
    pendingApprovals: new Map(),
    makeChannelName: (name: string) => name,
    collectImageAttachments: () => [],
    buildTurnInputFromMessage: async () => [],
    enqueuePrompt: () => {},
    getQueue: () => ({ jobs: [] }),
    findActiveTurnByRepoChannel: () => null,
    requestSelfRestartFromDiscord: async () => {},
    findLatestPendingApprovalTokenForChannel: () => null,
    applyApprovalDecision: async () => ({ ok: true }),
    safeReply: async () => null,
    getChannelSetups: () => ({}),
    setChannelSetups: () => {},
    getPlatformRegistry: () => registry
  });
}

describe("command router help text", () => {
  test("shows Discord interactive capabilities when supported", () => {
    const router = createRouterWithRegistry({
      getCapabilities: () => ({
        supportsSlashCommands: true,
        supportsButtons: true,
        supportsRepoBootstrap: true
      }),
      anyPlatformSupports: () => true,
      platformSupports: () => true
    });

    const helpText = router.getHelpText({ platformId: "discord" });
    expect(helpText).toContain("use `!command` or `/command`");
    expect(helpText).toContain("`!initrepo [force]`");
    expect(helpText).toContain("Approve/Decline/Cancel buttons");
    expect(helpText).toContain("`!resync`");
  });

  test("omits unsupported Discord-only commands in Feishu help text", () => {
    const router = createRouterWithRegistry({
      getCapabilities: () => ({
        supportsSlashCommands: false,
        supportsButtons: false,
        supportsRepoBootstrap: false
      }),
      anyPlatformSupports: () => false,
      platformSupports: () => false
    });

    const helpText = router.getHelpText({ platformId: "feishu" });
    expect(helpText).toContain("use `/command`");
    expect(helpText).not.toContain("`/initrepo [force]`");
    expect(helpText).not.toContain("buttons on approval messages");
    expect(helpText).toContain("Feishu repo chat bindings are config-driven");
  });

  test("where command shows bot identity and fixed runtime", async () => {
    const replies: string[] = [];
    const router = createCommandRouter({
      ChannelType: { GuildText: 0 },
      isGeneralChannel: () => false,
      fs: { mkdir: async () => {}, stat: async () => {} },
      path: { join: (...parts: string[]) => parts.join("/"), dirname: () => "/tmp" },
      execFileAsync: async () => {},
      repoRootPath: "/tmp/repos",
      managedChannelTopicPrefix: "codex-cwd:",
      codexBin: "codex",
      codexHomeEnv: null,
      statePath: "/tmp/state.json",
      configPath: "/tmp/channels.json",
      config: {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        defaultModel: "gpt-5.3-codex"
      },
      state: {
        getBinding: () => ({ codexThreadId: "session-42" }),
        clearBinding: () => {},
        save: async () => {}
      },
      codex: {
        request: async () => {}
      },
      bot: {
        botId: "discord-review",
        runtime: "claude"
      },
      pendingApprovals: new Map(),
      makeChannelName: (name: string) => name,
      collectImageAttachments: () => [],
      buildTurnInputFromMessage: async () => [],
      enqueuePrompt: () => {},
      getQueue: () => ({ jobs: [] }),
      findActiveTurnByRepoChannel: () => null,
      requestSelfRestartFromDiscord: async () => {},
      findLatestPendingApprovalTokenForChannel: () => null,
      applyApprovalDecision: async () => ({ ok: true }),
      safeReply: async (_message: unknown, text: string) => {
        replies.push(text);
        return null;
      },
      getChannelSetups: () => ({}),
      setChannelSetups: () => {},
      getPlatformRegistry: () => null
    });

    await router.handleCommand(
      {
        channelId: "123",
        author: { id: "u1" }
      },
      "!where",
      {
        repoChannelId: makeScopedRouteId("discord-review", "123"),
        bot: {
          botId: "discord-review",
          runtime: "claude"
        },
        setup: {
          cwd: "/tmp/review-repo",
          mode: "repo",
          runtime: "claude",
          allowFileWrites: true
        }
      }
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("bot: `discord-review`");
    expect(replies[0]).toContain("runtime: `claude`");
    expect(replies[0]).toContain("session: `session-42`");
  });

  test("refuses managed route sync for discord bots fixed to claude", async () => {
    const replies: string[] = [];
    let bootstrapCalled = false;
    const router = createCommandRouter({
      ChannelType: { GuildText: 0 },
      isGeneralChannel: () => false,
      fs: { mkdir: async () => {}, stat: async () => {} },
      path: { join: (...parts: string[]) => parts.join("/"), dirname: () => "/tmp" },
      execFileAsync: async () => {},
      repoRootPath: "/tmp/repos",
      managedChannelTopicPrefix: "codex-cwd:",
      codexBin: "codex",
      codexHomeEnv: null,
      statePath: "/tmp/state.json",
      configPath: "/tmp/channels.json",
      config: {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        defaultModel: "gpt-5.3-codex"
      },
      state: {
        getBinding: () => null,
        clearBinding: () => {},
        save: async () => {}
      },
      codex: {
        request: async () => {}
      },
      bot: {
        botId: "discord-review",
        platform: "discord",
        runtime: "claude"
      },
      bootstrapManagedRoutes: async () => {
        bootstrapCalled = true;
        return { discoveredCwds: 1, createdChannels: 1, movedChannels: 0, prunedBindings: 0 };
      },
      pendingApprovals: new Map(),
      makeChannelName: (name: string) => name,
      collectImageAttachments: () => [],
      buildTurnInputFromMessage: async () => [],
      enqueuePrompt: () => {},
      getQueue: () => ({ jobs: [] }),
      findActiveTurnByRepoChannel: () => null,
      requestSelfRestartFromDiscord: async () => {},
      findLatestPendingApprovalTokenForChannel: () => null,
      applyApprovalDecision: async () => ({ ok: true }),
      safeReply: async (_message: unknown, text: string) => {
        replies.push(text);
        return null;
      },
      getChannelSetups: () => ({}),
      setChannelSetups: () => {},
      getPlatformRegistry: () => null
    });

    await router.runManagedRouteCommand({ channelId: "123" }, { forceRebuild: false });

    expect(bootstrapCalled).toBe(false);
    expect(replies).toEqual(["Managed route sync is only available on Discord bots fixed to `codex`."]);
  });
});
