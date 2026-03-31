import process from "node:process";

const REGISTERED_FLAG = Symbol.for("agent-gateway.runtime-error-guards");

export function isIgnorableDiscordGatewayError(error) {
  const message = String(error?.message ?? "");
  const code = String(error?.code ?? "");
  const host = String(error?.host ?? "");
  const stack = String(error?.stack ?? "");
  const mentionsDiscordGateway = host === "gateway.discord.gg" || message.includes("gateway.discord.gg") || stack.includes("gateway.discord.gg");

  if (!mentionsDiscordGateway) {
    return false;
  }

  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return true;
  }

  return code === "ECONNRESET" && message.includes("Client network socket disconnected before secure TLS connection was established");
}

/**
 * Check if an error is the SDK's "exited with code" error that occurs after
 * successful completion. This happens with some API proxies that don't signal
 * proper shutdown to the CLI process.
 */
export function isIgnorableClaudeExitError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = String(error.message ?? "");
  const stack = String(error.stack ?? "");
  // SDK throws this after successful completion with some API configurations
  // The error is raised asynchronously after the result has been consumed
  return (
    message.includes("Claude Code process exited with code 1") ||
    (message.includes("exited with code") && stack.includes("ProcessTransport.getProcessExitError"))
  );
}

export function registerRuntimeErrorGuards({ processRef = process, shutdown } = {}) {
  if (processRef[REGISTERED_FLAG]) {
    return;
  }
  processRef[REGISTERED_FLAG] = true;

  processRef.on("uncaughtException", (error) => {
    if (isIgnorableDiscordGatewayError(error)) {
      console.warn(`ignoring uncaught Discord gateway websocket error: ${error.message}`);
      return;
    }
    console.error(`uncaught exception: ${error?.stack ?? error?.message ?? String(error)}`);
    terminateProcess({ processRef, shutdown });
  });

  processRef.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason ?? "Unhandled promise rejection"));
    if (isIgnorableDiscordGatewayError(error)) {
      console.warn(`ignoring unhandled Discord gateway rejection: ${error.message}`);
      return;
    }
    if (isIgnorableClaudeExitError(error)) {
      console.warn(`ignoring Claude SDK exit error (likely after successful completion): ${error.message}`);
      return;
    }
    if (!shouldGracefullyShutdownForRejection(reason)) {
      return;
    }
    console.error(`unhandled rejection: ${error.stack ?? error.message}`);
    terminateProcess({ processRef, shutdown });
  });
}

function shouldGracefullyShutdownForRejection(reason) {
  if (!(reason instanceof Error)) {
    return false;
  }

  return String(reason?.name ?? "") !== "AbortError" && String(reason?.code ?? "") !== "ABORT_ERR";
}

function terminateProcess({ processRef, shutdown }) {
  if (typeof shutdown === "function") {
    void shutdown(1, { reason: "runtime_error" });
    return;
  }

  processRef.exitCode = 1;
  processRef.exit?.(1);
}
