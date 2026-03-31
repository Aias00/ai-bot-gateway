import process from "node:process";

export function createShutdownHandler({ codex, agentClientRegistry, discord, stopHeartbeatLoop, stopBackendRuntime, stopPlatformRuntimes }) {
  let shuttingDown = false;
  return async function shutdown(exitCode) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopHeartbeatLoop?.();
    try {
      await codex.stop();
    } catch {}
    if (agentClientRegistry && typeof agentClientRegistry.stopAll === "function") {
      try {
        await agentClientRegistry.stopAll();
      } catch {}
    }
    await stopBackendRuntime?.();
    await stopPlatformRuntimes?.();
    discord.destroy();
    process.exit(exitCode);
  };
}
