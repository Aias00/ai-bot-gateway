import process from "node:process";

export function createRuntimeOps(deps) {
  const {
    fs,
    path,
    debugLog,
    activeTurns,
    pendingApprovals,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    restartLifecycleStatePath,
    restartLifecycleLogPath,
    restartNotifyRouteId,
    processStartedAt,
    heartbeatIntervalMs,
    exitOnRestartAck,
    safeReply,
    safeSendToChannel,
    fetchChannelByRouteId,
    truncateStatusText,
    shutdown
  } = deps;

  let heartbeatTimer = null;
  let restartAckHandled = false;
  let restartRequestHandled = false;
  let startupAnnounced = false;
  const selfRestartOnRequestRaw = String(process.env.DISCORD_SELF_RESTART_ON_REQUEST ?? "").trim();
  const selfRestartOnRequest = selfRestartOnRequestRaw
    ? selfRestartOnRequestRaw !== "0"
    : !exitOnRestartAck;

  function startHeartbeatLoop() {
    void writeHeartbeatFile();
    void maybeHandleRestartAckSignal();
    void maybeHandleRestartRequestSignal();
    heartbeatTimer = setInterval(() => {
      void writeHeartbeatFile();
      void maybeHandleRestartAckSignal();
      void maybeHandleRestartRequestSignal();
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer?.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  function stopHeartbeatLoop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function writeHeartbeatFile() {
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        startedAt: processStartedAt,
        pid: process.pid,
        activeTurns: activeTurns.size,
        pendingApprovals: pendingApprovals.size,
        restartRequestPath,
        restartAckPath
      };
      await fs.mkdir(path.dirname(heartbeatPath), { recursive: true });
      const tempPath = `${heartbeatPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
      await fs.rename(tempPath, heartbeatPath);
    } catch (error) {
      debugLog("ops", "heartbeat write failed", { message: String(error?.message ?? error) });
    }
  }

  async function maybeHandleRestartAckSignal() {
    if (!exitOnRestartAck || restartAckHandled) {
      return;
    }
    try {
      const raw = await fs.readFile(restartAckPath, "utf8");
      const parsed = JSON.parse(raw);
      const acknowledgedAt = typeof parsed?.acknowledgedAt === "string" ? parsed.acknowledgedAt : "";
      if (!acknowledgedAt) {
        return;
      }
      if (new Date(acknowledgedAt).getTime() <= new Date(processStartedAt).getTime()) {
        return;
      }
      restartAckHandled = true;
      console.log(`restart ack detected at ${restartAckPath}; exiting for host-managed restart`);
      await notifyRestartInProgress({ reason: "host_restart_ack", detail: `acknowledgedAt=${acknowledgedAt}` });
      await shutdown(0, {
        reason: "host_restart_ack",
        detail: `acknowledgedAt=${acknowledgedAt}`
      });
    } catch {}
  }

  async function maybeHandleRestartRequestSignal() {
    if (!selfRestartOnRequest || restartRequestHandled) {
      return;
    }

    let parsed;
    try {
      const raw = await fs.readFile(restartRequestPath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const requestedAt = typeof parsed?.requestedAt === "string" ? parsed.requestedAt : "";
    if (!requestedAt) {
      return;
    }
    if (new Date(requestedAt).getTime() <= new Date(processStartedAt).getTime()) {
      return;
    }

    restartRequestHandled = true;
    console.log(`restart request detected at ${restartRequestPath}; exiting for launchd/self-managed restart`);

    const requestSource = typeof parsed?.requestedBy === "string" ? parsed.requestedBy : "unknown";
    await notifyRestartInProgress({ reason: "self_restart_request", detail: `requestedBy=${requestSource}` });

    await fs.mkdir(path.dirname(restartAckPath), { recursive: true }).catch(() => {});
    await fs
      .writeFile(
        restartAckPath,
        JSON.stringify(
          {
            acknowledgedAt: new Date().toISOString(),
            handledBy: "bridge-self",
            requestSource: typeof parsed?.requestedBy === "string" ? parsed.requestedBy : null,
            requestPid: Number.isFinite(Number(parsed?.pid)) ? Number(parsed.pid) : null
          },
          null,
          2
        ),
        "utf8"
      )
      .catch(() => {});
    await fs.unlink(restartRequestPath).catch(() => {});
    await shutdown(0, {
      reason: "self_restart_request",
      detail: `requestedBy=${requestSource}`
    });
  }

  async function requestSelfRestartFromDiscord(message, reason) {
    const status = await safeReply(message, "🔄 Restart requested. I will confirm here when I am back.");
    if (!status) {
      return;
    }
    const normalizedReason = truncateStatusText(typeof reason === "string" ? reason : "", 200) || "discord restart request";
    const requestPayload = {
      requestedAt: new Date().toISOString(),
      requestedBy: "discord",
      pid: process.pid,
      channelId: status.channelId,
      statusMessageId: status.id,
      reason: normalizedReason
    };
    await fs.mkdir(path.dirname(restartNoticePath), { recursive: true });
    await fs.writeFile(restartNoticePath, JSON.stringify(requestPayload, null, 2), "utf8");
    await fs.mkdir(path.dirname(restartRequestPath), { recursive: true });
    await fs.writeFile(restartRequestPath, JSON.stringify(requestPayload, null, 2), "utf8");
  }

  async function maybeCompletePendingRestartNotice() {
    let pending;
    try {
      const raw = await fs.readFile(restartNoticePath, "utf8");
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    const channelId = typeof pending?.channelId === "string" ? pending.channelId : "";
    const statusMessageId = typeof pending?.statusMessageId === "string" ? pending.statusMessageId : "";
    if (!channelId || !statusMessageId) {
      await fs.unlink(restartNoticePath).catch(() => {});
      return;
    }
    const channel = await fetchChannelByRouteId(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await fs.unlink(restartNoticePath).catch(() => {});
      return;
    }
    const notice = `✅ Restarted at ${new Date().toISOString()}`;
    try {
      const statusMessage = await channel.messages.fetch(statusMessageId);
      if (statusMessage) {
        await statusMessage.edit(notice);
        await fs.unlink(restartNoticePath).catch(() => {});
        return;
      }
    } catch {}
    await safeSendToChannel(channel, notice);
    await fs.unlink(restartNoticePath).catch(() => {});
  }

  async function appendLifecycleLog(event, data = {}) {
    if (!restartLifecycleLogPath) {
      return;
    }
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      event,
      ...data
    };
    try {
      await fs.mkdir(path.dirname(restartLifecycleLogPath), { recursive: true });
      await fs.appendFile(restartLifecycleLogPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {}
  }

  async function writeLifecycleState(state) {
    if (!restartLifecycleStatePath) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(restartLifecycleStatePath), { recursive: true });
      await fs.writeFile(restartLifecycleStatePath, JSON.stringify(state, null, 2), "utf8");
    } catch {}
  }

  async function readLifecycleState() {
    if (!restartLifecycleStatePath) {
      return null;
    }
    try {
      const raw = await fs.readFile(restartLifecycleStatePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  async function resolveRestartNotifyChannel() {
    const routeId = String(restartNotifyRouteId ?? "").trim();
    if (!routeId) {
      return null;
    }
    try {
      const channel = await fetchChannelByRouteId(routeId);
      if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
        return null;
      }
      return channel;
    } catch {
      return null;
    }
  }

  async function notifyRestartInProgress({ reason, detail } = {}) {
    const channel = await resolveRestartNotifyChannel();
    const now = new Date().toISOString();
    const body = [`🟠 agent-gateway 准备重启`, `time: ${now}`];
    if (reason) {
      body.push(`reason: ${reason}`);
    }
    if (detail) {
      body.push(`detail: ${truncateStatusText(String(detail), 200)}`);
    }
    if (channel) {
      await safeSendToChannel(channel, body.join("\n")).catch(() => {});
    }
    await appendLifecycleLog("restart_in_progress", {
      reason: reason ?? null,
      detail: detail ?? null
    });
  }

  async function recordShutdown(metadata = {}) {
    const normalized = {
      recordedAt: new Date().toISOString(),
      pid: process.pid,
      exitCode: Number.isFinite(Number(metadata?.exitCode)) ? Number(metadata.exitCode) : null,
      reason: typeof metadata?.reason === "string" ? metadata.reason : "unknown",
      signal: typeof metadata?.signal === "string" ? metadata.signal : null,
      detail: typeof metadata?.detail === "string" ? truncateStatusText(metadata.detail, 200) : null
    };
    await writeLifecycleState({ type: "shutdown", ...normalized });
    await appendLifecycleLog("shutdown", normalized);
  }

  async function announceStartup({ readiness } = {}) {
    if (startupAnnounced) {
      return;
    }
    startupAnnounced = true;
    const lastState = await readLifecycleState();
    const lastShutdownReason =
      lastState?.type === "shutdown" && typeof lastState?.reason === "string" ? lastState.reason : null;
    const readinessLabel = readiness?.ready === true ? "ready" : "degraded";
    const channel = await resolveRestartNotifyChannel();
    if (channel) {
      const lines = [
        "🟢 agent-gateway 已启动",
        `time: ${new Date().toISOString()}`,
        `pid: ${process.pid}`,
        `status: ${readinessLabel}`
      ];
      if (lastShutdownReason) {
        lines.push(`last_shutdown: ${lastShutdownReason}`);
      }
      if (lastState?.detail) {
        lines.push(`last_detail: ${truncateStatusText(String(lastState.detail), 200)}`);
      }
      await safeSendToChannel(channel, lines.join("\n")).catch(() => {});
    }
    await appendLifecycleLog("startup", {
      status: readinessLabel,
      lastShutdownReason: lastShutdownReason ?? null,
      lastShutdownDetail: typeof lastState?.detail === "string" ? lastState.detail : null,
      degradedPlatforms: Array.isArray(readiness?.degradedPlatforms)
        ? readiness.degradedPlatforms.map((entry) => ({
            platformId: entry?.platformId ?? null,
            reason: entry?.reason ?? null
          }))
        : []
    });
    await writeLifecycleState({
      type: "startup",
      recordedAt: new Date().toISOString(),
      pid: process.pid,
      status: readinessLabel
    });
  }

  function shouldHandleAsSelfRestartRequest(content) {
    const text = String(content ?? "").trim().toLowerCase();
    if (!text || text.startsWith("!")) {
      return false;
    }
    if (!/\brestart\b/.test(text)) {
      return false;
    }
    return (
      /\b(restart (yourself|the bot|bot)|please restart|restart with the cli|cli commands|agent-gateway restart)\b/.test(
        text
      ) && text.length <= 220
    );
  }

  return {
    startHeartbeatLoop,
    stopHeartbeatLoop,
    writeHeartbeatFile,
    maybeHandleRestartAckSignal,
    maybeHandleRestartRequestSignal,
    requestSelfRestartFromDiscord,
    maybeCompletePendingRestartNotice,
    announceStartup,
    recordShutdown,
    shouldHandleAsSelfRestartRequest
  };
}
