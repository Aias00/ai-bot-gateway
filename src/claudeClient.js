/**
 * Claude Code SDK client wrapper that provides the same EventEmitter interface as CodexRpcClient.
 *
 * This allows the existing notificationRuntime and serverRequestRuntime to work with Claude Code
 * without modification.
 *
 * Events emitted (same as CodexRpcClient):
 * - "notification": { method, params } - Streaming updates and turn events
 * - "serverRequest": { id, method, params } - Permission requests that need a response
 * - "error": Error - Process or connection errors
 * - "exit": { code, signal } - Process exit
 * - "stderr": string - stderr output from CLI
 * - "ready": () - Client is ready to accept requests
 */

import { EventEmitter } from "node:events";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const MIN_REQUEST_TIMEOUT_MS = 1000;
const MIN_CLI_MAJOR = 2;

// Required CLI flags for SDK compatibility
const REQUIRED_CLI_FLAGS = ["output-format", "input-format", "permission-mode", "setting-sources"];

/**
 * Parse a version string like "2.3.1" or "claude 2.3.1" into a major number.
 * @param {string} versionOutput
 * @returns {number | undefined}
 */
function parseCliMajorVersion(versionOutput) {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Check if a CLI path points to a compatible (>= 2.x) Claude CLI.
 * @param {string} cliPath
 * @param {Record<string, string>} [env]
 * @returns {{ compatible: boolean; version: string; major: number | undefined; missingFlags?: string[] } | undefined}
 */
function checkCliCompatibility(cliPath, env) {
  let version;
  try {
    version = execSync(`"${cliPath}" --version`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return undefined;
  }

  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }

  // Check required flags
  let helpText;
  try {
    helpText = execSync(`"${cliPath}" --help`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    return { compatible: true, version, major };
  }

  const missing = REQUIRED_CLI_FLAGS.filter((flag) => !helpText.includes(flag));
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined
  };
}

/**
 * Resolve all `claude` executables found in PATH.
 * @returns {string[]}
 */
function findAllInPath() {
  try {
    if (process.platform === "win32") {
      return execSync("where claude", { encoding: "utf-8", timeout: 3000 })
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return execSync("which -a claude", { encoding: "utf-8", timeout: 3000 })
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a path is executable.
 * @param {string} p
 * @returns {boolean}
 */
function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to the `claude` CLI executable.
 * Priority:
 *   1. CLAUDE_BIN env var (explicit override)
 *   2. All `claude` executables in PATH — pick first compatible (>= 2.x)
 *   3. Common install locations — pick first compatible (>= 2.x)
 *
 * @returns {string | undefined}
 */
function resolveClaudeCliPath() {
  // 1. Explicit env var — trust the user
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv && isExecutable(fromEnv)) {
    return fromEnv;
  }

  // 2. Gather all candidates
  const pathCandidates = findAllInPath();
  const wellKnown =
    process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : "",
          "C:\\Program Files\\claude\\claude.exe"
        ].filter(Boolean)
      : [
          `${process.env.HOME}/.claude/local/claude`,
          `${process.env.HOME}/.local/bin/claude`,
          "/usr/local/bin/claude",
          "/opt/homebrew/bin/claude",
          `${process.env.HOME}/.npm-global/bin/claude`
        ];

  // Deduplicate while preserving order
  const seen = new Set();
  const allCandidates = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  // 3. Pick the first compatible candidate
  let firstUnverifiable;
  for (const p of allCandidates) {
    if (!isExecutable(p)) continue;

    const compat = checkCliCompatibility(p);
    if (compat?.compatible) {
      if (p !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(`[claudeClient] Skipping incompatible CLI at "${pathCandidates[0]}", using "${p}" (${compat.version})`);
      }
      return p;
    }
    if (compat) {
      // Version detected but too old — skip it
      console.warn(`[claudeClient] CLI at "${p}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`);
    } else if (!firstUnverifiable) {
      // Executable exists but --version failed
      firstUnverifiable = p;
    }
  }

  // Fall back to unverifiable only if no known-old candidate
  return firstUnverifiable;
}

/**
 * Build a clean env for the CLI subprocess.
 * @returns {Record<string, string | undefined>}
 */
function buildSubprocessEnv() {
  const envWhitelist = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TERM",
    "COLORTERM",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "SSH_AUTH_SOCK"
  ]);

  const alwaysStrip = ["CLAUDECODE"];
  const out = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (alwaysStrip.includes(k)) continue;
    if (envWhitelist.has(k) || k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_")) {
      out[k] = v;
    }
  }

  return out;
}

/**
 * @typedef {Object} NormalizedNotification
 * @property {string} kind - One of: agent_delta, item_lifecycle, turn_completed, error, system_init, tool_progress
 * @property {string} method - The Codex notification method
 * @property {string|null} threadId - Session/thread ID
 * @property {string} [delta] - For agent_delta
 * @property {string} [state] - For item_lifecycle: 'started' or 'completed'
 * @property {Object} [item] - For item_lifecycle: item details
 * @property {string} [errorMessage] - For error
 * @property {string} [sessionId] - For system_init and result
 * @property {string} [model] - For system_init
 */

/**
 * Map a Claude SDK message to a Codex-compatible notification.
 *
 * @param {Object} msg - The SDK message
 * @param {string} sessionId - The current session ID
 * @returns {NormalizedNotification | NormalizedNotification[] | null}
 */
function mapClaudeMessageToNotification(msg, sessionId) {
  if (!msg || typeof msg !== "object") {
    return null;
  }

  const threadId = sessionId || msg.session_id || null;

  switch (msg.type) {
    case "stream_event": {
      const event = msg.event;
      if (!event) {
        console.log(`[claudeClient] stream_event has no event: ${JSON.stringify(msg).slice(0, 200)}`);
        return null;
      }

      // Log all event types for debugging
      console.log(`[claudeClient] stream_event type=${event.type}, delta_type=${event.delta?.type}, index=${event.index}`);

      // Text delta
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const delta = event.delta.text || "";
        console.log(`[claudeClient] Emitting agent_delta: threadId=${threadId}, delta_len=${delta.length}`);
        return {
          kind: "agent_delta",
          method: "item/agentMessage/delta",
          threadId,
          delta
        };
      }

      // Tool use start
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        return {
          kind: "item_lifecycle",
          method: "item/started",
          threadId,
          state: "started",
          item: {
            type: "toolCall",
            id: event.content_block.id,
            name: event.content_block.name,
            input: {}
          }
        };
      }

      // Thinking delta
      if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        return {
          kind: "agent_delta",
          method: "item/agentMessage/delta",
          threadId,
          delta: event.delta.thinking || ""
        };
      }

      return null;
    }

    case "assistant": {
      // Full assistant message - contains content blocks including tool uses
      const content = msg.message?.content || [];
      const results = [];

      for (const block of content) {
        if (block.type === "text" && block.text) {
          results.push({
            kind: "item_lifecycle",
            method: "item/completed",
            threadId,
            state: "completed",
            item: {
              type: "message",
              content: block.text
            }
          });
        } else if (block.type === "tool_use") {
          results.push({
            kind: "item_lifecycle",
            method: "item/completed",
            threadId,
            state: "completed",
            item: {
              type: "toolCall",
              id: block.id,
              name: block.name,
              input: block.input || {}
            }
          });
        }
      }

      // Return first meaningful result
      return results[0] || null;
    }

    case "user": {
      // User messages contain tool results
      const content = msg.message?.content || [];
      const toolResults = Array.isArray(content)
        ? content.filter((block) => block.type === "tool_result")
        : [];

      if (toolResults.length > 0) {
        return {
          kind: "item_lifecycle",
          method: "item/completed",
          threadId,
          state: "completed",
          item: {
            type: "toolResult",
            results: toolResults.map((r) => ({
              tool_use_id: r.tool_use_id,
              content: r.content,
              is_error: r.is_error || false
            }))
          }
        };
      }

      return null;
    }

    case "result": {
      // Log full result for debugging
      console.log(`[claudeClient] result: subtype=${msg.subtype}, result=${JSON.stringify(msg.result).slice(0, 500)}`);

      if (msg.subtype === "success") {
        // Extract text from result for display
        const resultText = typeof msg.result === "string"
          ? msg.result
          : msg.result?.text || msg.result?.content || null;

        if (resultText) {
          console.log(`[claudeClient] result text length=${resultText.length}`);
        }

        return {
          kind: "turn_completed",
          method: "turn/completed",
          threadId,
          sessionId: msg.session_id,
          result: msg.result,
          resultText,
          usage: msg.usage,
          total_cost_usd: msg.total_cost_usd,
          num_turns: msg.num_turns,
          is_error: msg.is_error || false
        };
      }

      // Error result
      return {
        kind: "error",
        method: "error",
        threadId,
        errorMessage: msg.errors?.join("; ") || "Unknown error",
        errorSubtype: msg.subtype
      };
    }

    case "system": {
      if (msg.subtype === "init") {
        return {
          kind: "system_init",
          method: "system/init",
          threadId,
          sessionId: msg.session_id,
          model: msg.model,
          cwd: msg.cwd,
          tools: msg.tools,
          permissionMode: msg.permissionMode
        };
      }

      if (msg.subtype === "hook_response") {
        return {
          kind: "system_hook",
          method: "system/hook_response",
          threadId,
          hook_name: msg.hook_name,
          hook_event: msg.hook_event,
          stdout: msg.stdout,
          stderr: msg.stderr,
          exit_code: msg.exit_code
        };
      }

      return null;
    }

    case "tool_progress": {
      return {
        kind: "tool_progress",
        method: "item/progress",
        threadId,
        tool_use_id: msg.tool_use_id,
        tool_name: msg.tool_name,
        elapsed_time_seconds: msg.elapsed_time_seconds
      };
    }

    case "auth_status": {
      return {
        kind: "auth_status",
        method: "system/auth_status",
        threadId,
        isAuthenticating: msg.isAuthenticating,
        output: msg.output,
        error: msg.error
      };
    }

    default:
      return null;
  }
}

/**
 * Generate a random UUID v4.
 * @returns {string}
 */
function generateUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isValidUuid(str) {
  if (typeof str !== "string" || str.length !== 36) {
    return false;
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Map a tool name to a Codex-style approval method.
 *
 * @param {string} toolName - The Claude SDK tool name
 * @returns {string} The Codex approval method
 */
function mapToolToApprovalMethod(toolName) {
  const mappings = {
    Bash: "item/commandExecution/requestApproval",
    Edit: "item/fileChange/requestApproval",
    Write: "item/fileChange/requestApproval",
    MultiEdit: "item/fileChange/requestApproval",
    NotebookEdit: "item/fileChange/requestApproval",
    Read: "item/fileRead/requestApproval",
    Glob: "item/fileRead/requestApproval",
    Grep: "item/fileRead/requestApproval"
  };

  return mappings[toolName] || "item/tool/requestApproval";
}

/**
 * Build a permission result for Claude SDK from a Codex approval decision.
 *
 * @param {string} decision - 'accept', 'decline', or 'cancel'
 * @param {Object} [updatedInput] - Optional updated tool input
 * @returns {{ behavior: 'allow' | 'deny'; updatedInput?: Object; message?: string }}
 */
function buildPermissionResult(decision, updatedInput = null) {
  if (decision === "accept") {
    const result = { behavior: "allow", updatedInput: updatedInput || {} };
    return result;
  }

  return {
    behavior: "deny",
    message: decision === "cancel" ? "Operation cancelled by user" : "Operation denied by user"
  };
}

function parseRequestTimeout() {
  const raw = process.env.CLAUDE_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_REQUEST_TIMEOUT_MS) {
    console.warn(`[claudeClient] Invalid CLAUDE_REQUEST_TIMEOUT_MS '${raw}', using default ${DEFAULT_REQUEST_TIMEOUT_MS}ms`);
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

const REQUEST_TIMEOUT_MS = parseRequestTimeout();

/**
 * Claude Code SDK client that provides CodexRpcClient-compatible interface.
 */
export class ClaudeClient extends EventEmitter {
  #claudeBin;
  #configOverrides;
  #requestTimeoutMs;
  #sessionId = null;
  #currentCwd = null;
  #isRunning = false;
  #cliVersion = null;
  #pendingApprovals = new Map();
  #nextApprovalId = 1;
  #isResuming = false;  // Track if this is a resume session

  constructor(options = {}) {
    super();
    this.#claudeBin = options.claudeBin || "claude";
    this.#configOverrides = Array.isArray(options.configOverrides)
      ? options.configOverrides.filter((v) => typeof v === "string" && v.trim().length > 0)
      : [];
    this.#requestTimeoutMs =
      typeof options.requestTimeoutMs === "number" && options.requestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS
        ? options.requestTimeoutMs
        : REQUEST_TIMEOUT_MS;
  }

  /**
   * Start the Claude Code CLI process and verify compatibility.
   */
  async start() {
    if (this.#isRunning) {
      throw new Error("Claude client already started");
    }

    console.log(`[claudeClient] ClaudeClient.start() called - VERSION WITH SESSION ID FIX v6`);

    // Resolve CLI path
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) {
      throw new Error(
        "Claude CLI not found or incompatible. " +
          "Install Claude Code CLI >= 2.x from https://docs.anthropic.com/en/docs/claude-code " +
          "or set CLAUDE_BIN environment variable."
      );
    }

    // Verify CLI version
    const compat = checkCliCompatibility(cliPath);
    if (compat) {
      this.#cliVersion = compat.version;
      if (!compat.compatible) {
        if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
          throw new Error(
            `Claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x). ` +
              `Update with: claude update`
          );
        }
        if (compat.missingFlags) {
          console.warn(
            `[claudeClient] CLI ${compat.version} may be missing flags: ${compat.missingFlags.join(", ")}. ` +
              `Consider updating: claude update`
          );
        }
      }
      console.log(`[claudeClient] CLI version: ${compat.version} at ${cliPath}`);
    }

    this.#claudeBin = cliPath;
    this.#isRunning = true;
    this.emit("ready");
  }

  /**
   * Stop the client and clean up resources.
   */
  async stop() {
    this.#isRunning = false;

    // Deny any pending approvals
    for (const { resolve } of this.#pendingApprovals.values()) {
      resolve({ behavior: "deny", message: "Claude client stopped" });
    }
    this.#pendingApprovals.clear();

    this.emit("exit", { code: 0, signal: null });
  }

  /**
   * Send an RPC-style request.
   * Supports: "thread/start", "thread/resume", "turn/start"
   */
  async request(method, params = {}, options = {}) {
    if (!this.#isRunning) {
      throw new Error("Claude client not started. Call start() before making requests.");
    }

    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs >= MIN_REQUEST_TIMEOUT_MS
        ? options.timeoutMs
        : this.#requestTimeoutMs;

    switch (method) {
      case "thread/start":
        return this.#threadStart(params);

      case "thread/resume":
        return this.#threadResume(params);

      case "turn/start":
        return this.#turnStart(params, timeoutMs);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Send a one-way notification. Not used for Claude SDK.
   */
  notify(method, params = {}) {
    console.log(`[claudeClient] notify: ${method}`, params);
  }

  /**
   * Respond to a server request (approval).
   */
  respond(id, result) {
    const approvalId = String(id);
    const pending = this.#pendingApprovals.get(approvalId);
    if (pending) {
      this.#pendingApprovals.delete(approvalId);
      const permissionResult = buildPermissionResult(result.decision, result.updatedInput);
      pending.resolve(permissionResult);
    }
  }

  /**
   * Respond to a server request with an error.
   */
  respondWithError(id, code, message) {
    const approvalId = String(id);
    const pending = this.#pendingApprovals.get(approvalId);
    if (pending) {
      this.#pendingApprovals.delete(approvalId);
      pending.resolve({ behavior: "deny", message: message || `Error ${code}` });
    }
  }

  /**
   * Get the current session ID.
   */
  getSessionId() {
    return this.#sessionId;
  }

  // --- Private methods ---

  async #threadStart(params) {
    const cwd = params.cwd || process.cwd();
    // Clear session ID for new thread - will be set by system/init during turn/start
    this.#sessionId = null;
    this.#currentCwd = cwd;
    this.#isResuming = false;  // This is a new session

    console.log(`[claudeClient] thread/start: cwd=${cwd}, starting new session`);

    // Return null to indicate no session ID yet
    return {
      thread: {
        id: null
      }
    };
  }

  async #threadResume(params) {
    const sessionId = params.threadId;
    console.log(`[claudeClient] thread/resume: threadId=${sessionId}, valid=${isValidUuid(sessionId)}`);
    this.#sessionId = sessionId;
    this.#currentCwd = params.cwd || process.cwd();
    this.#isResuming = true;  // This is a resume session

    return { resumed: true };
  }

  async #turnStart(params, timeoutMs) {
    const threadId = params.threadId || this.#sessionId;
    const input = params.input || [];
    const cwd = this.#currentCwd || process.cwd();
    const model = params.model;
    const approvalPolicy = params.approvalPolicy;
    const sandboxPolicy = params.sandboxPolicy;

    // Build the prompt from input items
    const prompt = this.#buildPromptFromInput(input);

    // Create abort controller for this turn
    const abortController = new AbortController();

    // Map approval policy to permission mode
    const permissionMode = this.#mapApprovalPolicy(approvalPolicy);

    // Verify cwd exists before starting the CLI
    try {
      const fs = await import("node:fs/promises");
      await fs.access(cwd, fs.constants.F_OK);
    } catch (cwdError) {
      const error = new Error(`Working directory does not exist: ${cwd}`);
      // Use sessionId if available (for resume), otherwise temp threadId
      const errorThreadId = this.#sessionId || threadId;
      this.emit("notification", {
        method: "error",
        params: {
          threadId: errorThreadId,
          error: { message: error.message }
        }
      });
      throw error;
    }

    console.log(`[claudeClient] Starting turn: cwd=${cwd}, model=${model || "default"}, permissionMode=${permissionMode}, isResuming=${this.#isResuming}, sessionId=${this.#sessionId || "none"}`);
    const subprocessEnv = buildSubprocessEnv();
    // Build query options
    // Only pass resume if we're explicitly resuming a session AND have a valid session ID
    const validResumeId = this.#isResuming && this.#sessionId && isValidUuid(this.#sessionId) ? this.#sessionId : undefined;
    if (this.#isResuming && !validResumeId) {
      console.log(`[claudeClient] Warning: resume requested but sessionId "${this.#sessionId}" is not a valid UUID, starting new session`);
    }
    const queryOptions = {
      cwd,
      resume: validResumeId,
      abortController,
      permissionMode,
      includePartialMessages: true,
      env: subprocessEnv,
      // Use --bare to skip hooks, LSP, plugins which can cause non-zero exit codes
      extraArgs: { bare: null },
      pathToClaudeCodeExecutable: this.#claudeBin,
      stderr: (data) => {
        const msg = typeof data === "string" ? data.trim() : String(data);
        if (msg) {
          console.error(`[claudeClient] CLI stderr: ${msg}`);
        }
        this.emit("stderr", data);
      },
      canUseTool: async (toolName, toolInput, opts) => {
        // Use sessionId if available (set after system_init), otherwise fall back to temp threadId
        const effectiveThreadId = this.#sessionId || threadId;
        return this.#handleCanUseTool(effectiveThreadId, toolName, toolInput, opts);
      }
    };

    if (model) {
      queryOptions.model = model;
    }

    // Apply sandbox policy if provided
    if (sandboxPolicy) {
      Object.assign(queryOptions, this.#mapSandboxPolicy(sandboxPolicy));
    }

    // Set up timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    // Track if we received a successful result (CLI may exit with code 1 on success with some API proxies)
    let receivedSuccessResult = false;
    let messageCount = 0;

    console.log(`[claudeClient] Starting query iterator...`);

    try {
      // Execute the query
      const queryIterator = query({ prompt, options: queryOptions });

      console.log(`[claudeClient] Query iterator created, starting to iterate...`);

      // Process messages
      for await (const msg of queryIterator) {
        if (abortController.signal.aborted) {
          console.log(`[claudeClient] Aborted, breaking loop`);
          break;
        }
        messageCount++;
        console.log(`[claudeClient] Message ${messageCount}: type=${msg.type}, subtype=${msg.subtype || 'none'}`);
        this.#handleMessage(msg, threadId);
        // Track successful completion
        if (msg.type === "result" && msg.subtype === "success") {
          receivedSuccessResult = true;
          console.log(`[claudeClient] Received success result after ${messageCount} messages`);
        }
      }

      console.log(`[claudeClient] Query completed, received ${messageCount} messages, success=${receivedSuccessResult}`);
      return { completed: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'N/A';
      console.error(`[claudeClient] Query error after ${messageCount} messages, success=${receivedSuccessResult}: ${errorMessage}`);
      console.error(`[claudeClient] Error stack: ${errorStack}`);

      // If we received a successful result, ignore the exit code error
      // This happens with some API proxies that don't properly signal shutdown to the CLI
      if (receivedSuccessResult && errorMessage.includes("exited with code")) {
        console.log(`[claudeClient] Ignoring exit code error after successful result`);
        return { completed: true };
      }

      // Check if it was aborted
      if (abortController.signal.aborted) {
        const timeoutError = new Error(`Turn timed out after ${timeoutMs}ms`);
        // Use sessionId if available, since tracker may have been updated from temp ID
        const errorThreadId = this.#sessionId || threadId;
        console.log(`[claudeClient] Emitting timeout error: threadId=${errorThreadId} (sessionId=${this.#sessionId}, originalThread=${threadId})`);
        this.emit("notification", {
          method: "error",
          params: {
            threadId: errorThreadId,
            error: { message: timeoutError.message }
          }
        });
        throw timeoutError;
      }

      // Emit error notification - use sessionId if available
      const errorThreadId = this.#sessionId || threadId;
      console.log(`[claudeClient] Emitting error notification: threadId=${errorThreadId} (sessionId=${this.#sessionId}, originalThread=${threadId})`);
      this.emit("notification", {
        method: "error",
        params: {
          threadId: errorThreadId,
          error: { message: errorMessage }
        }
      });

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * @param {Object} msg - The SDK message
   * @param {string} threadId - The original thread ID (may be a temp ID for new sessions)
   */
  #handleMessage(msg, threadId) {
    // Log all messages for debugging
    console.log(`[claudeClient] Handling message: type=${msg.type}, subtype=${msg.subtype || 'none'}, session_id=${msg.session_id || 'none'}, threadId=${threadId}, currentSessionId=${this.#sessionId || 'none'}`);

    // Log full message for error types
    if (msg.type === "result" && msg.subtype !== "success") {
      console.log(`[claudeClient] Error result: ${JSON.stringify(msg, null, 2)}`);
    }

    // For system_init message, use the ORIGINAL threadId (temp ID) so notificationRuntime
    // can find the tracker and update it. Set sessionId AFTER processing this message.
    const isSystemInit = msg.type === "system" && msg.subtype === "init";

    // ONLY set sessionId from system_init message - not from other messages
    // This ensures we have the correct ID at the right time
    if (isSystemInit && msg.session_id) {
      console.log(`[claudeClient] Setting sessionId from system_init: ${msg.session_id}`);
      this.#sessionId = msg.session_id;
    }

    // Use the current session ID for notifications if available, EXCEPT for system_init
    // which must use the original temp ID so the tracker can be found and updated
    const effectiveThreadId = (isSystemInit || !this.#sessionId) ? threadId : this.#sessionId;

    if (this.#sessionId && this.#sessionId !== threadId && !isSystemInit) {
      console.log(`[claudeClient] Using sessionId=${this.#sessionId} instead of threadId=${threadId}`);
    }

    // Map message to notification, using the effective threadId
    // This ensures activeTurns can find the tracker after it's updated by system_init
    const normalized = mapClaudeMessageToNotification(msg, effectiveThreadId);
    if (!normalized) {
      // Log why we're skipping this message
      if (msg.type === "stream_event") {
        const event = msg.event;
        console.log(`[claudeClient] Skipping stream_event: type=${event?.type}, delta_type=${event?.delta?.type}`);
      }
      return;
    }

    console.log(`[claudeClient] Normalized: kind=${normalized.kind}, threadId=${normalized.threadId}`);

    // For system_init, include the real session_id for state updates
    if (normalized.kind === "system_init" && msg.session_id) {
      normalized.realSessionId = msg.session_id;
    }

    // Handle different notification kinds
    switch (normalized.kind) {
      case "agent_delta":
        console.log(`[claudeClient] EMIT agent_delta: threadId=${normalized.threadId}, delta_len=${normalized.delta?.length}`);
        this.emit("notification", {
          method: normalized.method,
          params: {
            threadId: normalized.threadId,
            delta: normalized.delta
          }
        });
        break;

      case "item_lifecycle":
        console.log(`[claudeClient] EMIT item_lifecycle: method=${normalized.method}, threadId=${normalized.threadId}`);
        this.emit("notification", {
          method: normalized.method,
          params: {
            threadId: normalized.threadId,
            item: normalized.item
          }
        });
        break;

      case "turn_completed":
        console.log(`[claudeClient] EMIT turn_completed: threadId=${normalized.threadId}, sessionId=${normalized.sessionId}, resultText=${normalized.resultText?.slice(0, 50)}`);
        this.emit("notification", {
          method: normalized.method,
          params: {
            threadId: normalized.threadId,
            sessionId: normalized.sessionId,
            result: normalized.result,
            resultText: normalized.resultText,
            usage: normalized.usage,
            is_error: normalized.is_error
          }
        });
        break;

      case "error":
        console.log(`[claudeClient] EMIT error: threadId=${normalized.threadId}, message=${normalized.errorMessage}`);
        this.emit("notification", {
          method: normalized.method,
          params: {
            threadId: normalized.threadId,
            error: { message: normalized.errorMessage }
          }
        });
        break;

      case "system_init":
        // Capture session info
        if (normalized.sessionId) {
          const prevSessionId = this.#sessionId;
          this.#sessionId = normalized.sessionId;
          console.log(`[claudeClient] system/init: updated sessionId from ${prevSessionId} to ${normalized.sessionId}`);
        }
        console.log(`[claudeClient] EMIT system/init: threadId=${normalized.threadId}, sessionId=${normalized.sessionId}, realSessionId=${normalized.realSessionId}`);
        this.emit("notification", {
          method: "system/init",
          params: {
            threadId: normalized.threadId,
            sessionId: normalized.sessionId,
            model: normalized.model,
            realSessionId: normalized.realSessionId
          }
        });
        break;

      case "tool_progress":
        console.log(`[claudeClient] EMIT tool_progress: threadId=${normalized.threadId}, tool=${normalized.tool_name}`);
        this.emit("notification", {
          method: normalized.method,
          params: {
            threadId: normalized.threadId,
            tool_use_id: normalized.tool_use_id,
            tool_name: normalized.tool_name,
            elapsed_time_seconds: normalized.elapsed_time_seconds
          }
        });
        break;

      default:
        console.log(`[claudeClient] EMIT unknown kind=${normalized.kind}`);
    }
  }

  /**
   * Handle permission callback from Claude SDK.
   * Emits a serverRequest and waits for response.
   */
  async #handleCanUseTool(threadId, toolName, toolInput, opts) {
    const approvalId = String(this.#nextApprovalId++);

    return new Promise((resolve) => {
      this.#pendingApprovals.set(approvalId, { resolve });

      const method = mapToolToApprovalMethod(toolName);

      // Emit serverRequest for approval handling
      this.emit("serverRequest", {
        id: approvalId,
        method,
        params: {
          threadId,
          tool: toolName,
          input: toolInput,
          toolUseId: opts?.toolUseID,
          suggestions: opts?.suggestions,
          blockedPath: opts?.blockedPath,
          decisionReason: opts?.decisionReason
        }
      });

      // The approval will be resolved via respond() or respondWithError()
    });
  }

  /**
   * @param {Array} inputItems
   * @returns {string | AsyncIterable}
   */
  #buildPromptFromInput(inputItems) {
    if (!Array.isArray(inputItems) || inputItems.length === 0) {
      return "";
    }

    // Check for image inputs
    const imageBlocks = [];
    const textParts = [];

    for (const item of inputItems) {
      if (typeof item === "string") {
        textParts.push(item);
      } else if (item && typeof item === "object") {
        if (item.type === "text" && item.text) {
          textParts.push(item.text);
        } else if (item.type === "image" && item.source?.data) {
          imageBlocks.push({
            type: "image",
            source: item.source
          });
        }
      }
    }

    // If no images, return simple text prompt
    if (imageBlocks.length === 0) {
      return textParts.join("\n\n");
    }

    // With images, return async iterable with multi-modal content
    const contentBlocks = [...imageBlocks];
    const textContent = textParts.join("\n\n");
    if (textContent) {
      contentBlocks.push({ type: "text", text: textContent });
    }

    const msg = {
      type: "user",
      message: { role: "user", content: contentBlocks },
      parent_tool_use_id: null,
      session_id: this.#sessionId || ""
    };

    // Return async iterable
    return (async function* () {
      yield msg;
    })();
  }

  /**
   * @param {string} policy
   * @returns {string | undefined}
   */
  #mapApprovalPolicy(policy) {
    switch (policy) {
      case "bypass":
      case "skip-all":
        return "bypassPermissions"; // --dangerously-skip-permissions
      case "never":
        return "acceptEdits"; // Auto-approve edits, still some permission checks
      case "on-failure":
      case "on-request":
      case "untrusted":
        return "default"; // Prompt for permissions
      default:
        return "default";
    }
  }

  /**
   * @param {Object} sandboxPolicy
   * @returns {Object}
   */
  #mapSandboxPolicy(sandboxPolicy) {
    const options = {};

    if (sandboxPolicy.mode === "read-only") {
      options.permissionMode = "plan";
    } else if (sandboxPolicy.mode === "danger-full-access") {
      options.permissionMode = "acceptEdits";
    }

    // Handle writable roots
    if (sandboxPolicy.writableRoots && sandboxPolicy.writableRoots.length > 0) {
      options.additionalDirectories = sandboxPolicy.writableRoots;
    }

    return options;
  }
}
