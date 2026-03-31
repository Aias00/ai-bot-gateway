/**
 * Agent Client Registry - manages multiple agent clients by runtime type.
 *
 * Instead of a single global client, this registry creates and caches clients
 * per runtime type (codex, claude). Each channel can use a different runtime
 * based on its agent configuration.
 */

import { CodexRpcClient } from "../codexRpcClient.js";
import { ClaudeClient } from "../claudeClient.js";

/**
 * @typedef {"codex" | "claude"} RuntimeType
 */

/**
 * @typedef {Object} AgentClientRegistryOptions
 * @property {string} [codexBin] - Path to codex binary
 * @property {string} [claudeBin] - Path to claude binary
 * @property {string[]} [configOverrides] - Config overrides for clients
 * @property {number} [requestTimeoutMs] - Request timeout in milliseconds
 * @property {function} [onNotification] - Callback for notification events
 * @property {function} [onServerRequest] - Callback for server request events
 * @property {function} [onError] - Callback for error events
 * @property {function} [onExit] - Callback for exit events
 * @property {function} [onStderr] - Callback for stderr events
 */

/**
 * Create an agent client registry.
 *
 * @param {AgentClientRegistryOptions} options
 * @returns {import("./createAgentClient.js").AgentClientRegistry}
 */
export function createAgentClientRegistry(options = {}) {
  const { codexBin, claudeBin, configOverrides, requestTimeoutMs, onNotification, onServerRequest, onError, onExit, onStderr } = options;
  const clients = new Map();
  let started = false;

  /**
   * Wire event listeners to a client.
   * @param {string} runtime
   * @param {CodexRpcClient | ClaudeClient} client
   */
  function wireClientListeners(runtime, client) {
    if (onNotification) {
      client.on("notification", (event) => {
        console.log(`[agentClientRegistry] ${runtime} notification: method=${event?.method}, threadId=${event?.params?.threadId}`);
        onNotification(runtime, event);
      });
    }
    if (onServerRequest) {
      client.on("serverRequest", (request) => {
        console.log(`[agentClientRegistry] ${runtime} serverRequest: method=${request?.method}`);
        onServerRequest(runtime, request);
      });
    }
    if (onError) {
      client.on("error", (error) => {
        console.error(`[agentClientRegistry] ${runtime} error: ${error.message}`);
        onError(runtime, error);
      });
    }
    if (onExit) {
      client.on("exit", (data) => {
        console.error(`[agentClientRegistry] ${runtime} exit: code=${data?.code}`);
        onExit(runtime, data);
      });
    }
    if (onStderr) {
      client.on("stderr", (data) => {
        onStderr(runtime, data);
      });
    }
  }

  /**
   * Get or create a client for the specified runtime.
   *
   * @param {RuntimeType} runtime
   * @returns {CodexRpcClient | ClaudeClient}
   */
  function getClient(runtime) {
    const normalizedRuntime = runtime === "claude" ? "claude" : "codex";

    if (clients.has(normalizedRuntime)) {
      return clients.get(normalizedRuntime);
    }

    console.log(`[agentClientRegistry] Creating ${normalizedRuntime} client`);
    const client =
      normalizedRuntime === "claude"
        ? new ClaudeClient({
            claudeBin: claudeBin || "claude",
            configOverrides,
            requestTimeoutMs
          })
        : new CodexRpcClient({
            codexBin: codexBin || "codex",
            configOverrides,
            requestTimeoutMs
          });

    // Wire event listeners before the client is used
    wireClientListeners(normalizedRuntime, client);

    clients.set(normalizedRuntime, client);

    // Auto-start if registry has already been started
    if (started && typeof client.start === "function") {
      client.start().catch((error) => {
        console.error(`[agentClientRegistry] Failed to auto-start ${normalizedRuntime} client: ${error.message}`);
      });
    }

    return client;
  }

  /**
   * Start all clients that have been created.
   */
  async function startAll() {
    const startPromises = [];
    for (const [runtime, client] of clients) {
      if (typeof client.start === "function") {
        startPromises.push(
          client.start().catch((error) => {
            console.error(`[agentClientRegistry] Failed to start ${runtime} client: ${error.message}`);
            throw error;
          })
        );
      }
    }
    await Promise.all(startPromises);
    started = true;
  }

  /**
   * Stop all clients.
   */
  async function stopAll() {
    const stopPromises = [];
    for (const [runtime, client] of clients) {
      if (typeof client.stop === "function") {
        stopPromises.push(
          client.stop().catch((error) => {
            console.error(`[agentClientRegistry] Failed to stop ${runtime} client: ${error.message}`);
          })
        );
      }
    }
    clients.clear();
    await Promise.all(stopPromises);
  }

  /**
   * Get all created clients.
   *
   * @returns {Map<RuntimeType, CodexRpcClient | ClaudeClient>}
   */
  function getAllClients() {
    return new Map(clients);
  }

  /**
   * Check if a client has been created for the given runtime.
   *
   * @param {RuntimeType} runtime
   * @returns {boolean}
   */
  function hasClient(runtime) {
    return clients.has(runtime === "claude" ? "claude" : "codex");
  }

  return {
    getClient,
    startAll,
    stopAll,
    getAllClients,
    hasClient
  };
}

/**
 * Get the runtime for a given agent.
 *
 * @param {string | null} agentId
 * @param {Object} config
 * @param {Object} [config.agents]
 * @param {string} [config.defaultAgent]
 * @param {string} [config.runtime]
 * @returns {RuntimeType}
 */
export function getRuntimeForAgent(agentId, config) {
  if (config?.agents && agentId) {
    const agent = config.agents[agentId];
    if (agent?.runtime === "claude" || agent?.runtime === "codex") {
      return agent.runtime;
    }
  }
  return config?.runtime || "codex";
}
