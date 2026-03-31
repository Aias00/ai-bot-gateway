import { isBenignCodexStderrLine, isMissingRolloutPathError } from "./runtimeUtils.js";

function runDetached(label, action) {
  void Promise.resolve()
    .then(action)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.error(`${label}: ${message}`);
    });
}

/**
 * Wire event listeners to an agent client.
 * @param {string} runtime - The runtime name (claude, codex)
 * @param {object} client - The client instance
 * @param {function} handleNotification - Notification handler
 * @param {function} handleServerRequest - Server request handler
 */
function wireClientListeners(runtime, client, handleNotification, handleServerRequest) {
  console.log(`[wireListeners] Wiring listeners for ${runtime} client`);

  client.on("notification", (event) => {
    console.log(`[wireListeners] ${runtime} notification: method=${event?.method}, threadId=${event?.params?.threadId}`);
    runDetached(`${runtime} notification handler for ${event?.method ?? "unknown"}`, () => handleNotification(event));
  });

  client.on("serverRequest", (request) => {
    console.log(`[wireListeners] ${runtime} serverRequest: method=${request?.method}`);
    runDetached(`${runtime} serverRequest handler for ${request?.method ?? "unknown"}`, () => handleServerRequest(request));
  });

  client.on("error", (error) => {
    console.error(`[${runtime}] client error: ${error.message}`);
  });

  client.on("exit", ({ code, signal }) => {
    console.error(`[${runtime}] client exited (code=${code}, signal=${signal ?? "none"})`);
  });

  client.on("stderr", (data) => {
    const line = typeof data === "string" ? data.trim() : String(data);
    if (!line) {
      return;
    }
    if (isMissingRolloutPathError(line)) {
      console.warn(`[wireListeners] Ignoring missing rollout path error: ${line.slice(0, 100)}`);
      return;
    }
    if (isBenignCodexStderrLine(line)) {
      return;
    }
    console.error(`[${runtime}] ${line}`);
  });
}

export function wireBridgeListeners({
  codex,
  agentClientRegistry,
  discord,
  handleNotification,
  handleServerRequest,
  handleChannelCreate,
  handleMessage,
  handleInteraction
}) {
  // Wire listeners for legacy codex client (if provided - for backward compatibility)
  if (codex) {
    wireClientListeners("codex", codex, handleNotification, handleServerRequest);
  }

  // Pre-create and wire the claude client from the registry
  // This ensures the client exists and has listeners before any turn is started
  if (agentClientRegistry && typeof agentClientRegistry.getClient === "function") {
    console.log(`[wireListeners] Pre-creating claude client from registry`);
    const claudeClient = agentClientRegistry.getClient("claude");
    wireClientListeners("claude", claudeClient, handleNotification, handleServerRequest);
    console.log(`[wireListeners] Claude client wired, clients in registry: [${Array.from(agentClientRegistry.getAllClients().keys()).join(', ')}]`);
  }

  discord.on("clientReady", () => {
    console.log(`Discord connected as ${discord.user?.tag}`);
  });
  discord.on("error", (error) => {
    console.error(`discord client error: ${error.message}`);
  });
  discord.on("shardError", (error, shardId) => {
    console.error(`discord shard error (shard=${shardId}): ${error.message}`);
  });

  discord.on("messageCreate", (message) => {
    runDetached(`message handler failed in channel ${message.channelId}`, () => handleMessage(message));
  });
  discord.on("channelCreate", (channel) => {
    runDetached(`channelCreate handler failed for ${channel?.id ?? "unknown"}`, () => handleChannelCreate(channel));
  });
  discord.on("interactionCreate", (interaction) => {
    runDetached("interaction handler failed", () => handleInteraction(interaction));
  });
}
