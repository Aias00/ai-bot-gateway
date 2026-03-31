import { CodexRpcClient } from "../codexRpcClient.js";
import { ClaudeClient } from "../claudeClient.js";

/**
 * Create an agent client based on runtime type.
 *
 * @param {Object} options
 * @param {string} options.runtime - "codex" or "claude"
 * @param {string} [options.codexBin] - Path to codex binary
 * @param {string} [options.claudeBin] - Path to claude binary
 * @param {string[]} [options.configOverrides] - Config overrides to pass to the client
 * @param {number} [options.requestTimeoutMs] - Request timeout in milliseconds
 * @returns {CodexRpcClient|ClaudeClient}
 */
export function createAgentClient({ runtime, codexBin, claudeBin, configOverrides, requestTimeoutMs }) {
  if (runtime === "claude") {
    return new ClaudeClient({
      claudeBin: claudeBin || "claude",
      configOverrides,
      requestTimeoutMs
    });
  }

  return new CodexRpcClient({
    codexBin: codexBin || "codex",
    configOverrides,
    requestTimeoutMs
  });
}
