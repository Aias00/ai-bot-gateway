function parseOptionalInt(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    return NaN;
  }
  return Math.floor(parsed);
}

function isValidRouteId(routeId) {
  if (!routeId) {
    return true;
  }
  if (routeId.startsWith("feishu:")) {
    return routeId.length > "feishu:".length;
  }
  return /^[0-9]{6,}$/.test(routeId);
}

export function validateOperationalConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  const rotateMaxBytes = parseOptionalInt(env.DISCORD_LOG_ROTATE_MAX_BYTES);
  if (Number.isNaN(rotateMaxBytes) || (rotateMaxBytes !== null && rotateMaxBytes < 1_048_576)) {
    errors.push("DISCORD_LOG_ROTATE_MAX_BYTES must be an integer >= 1048576 (1 MiB).");
  }

  const rotateMaxFiles = parseOptionalInt(env.DISCORD_LOG_ROTATE_MAX_FILES);
  if (Number.isNaN(rotateMaxFiles) || (rotateMaxFiles !== null && (rotateMaxFiles < 1 || rotateMaxFiles > 100))) {
    errors.push("DISCORD_LOG_ROTATE_MAX_FILES must be an integer between 1 and 100.");
  }

  const restartMinInterval = parseOptionalInt(env.RESTART_MIN_INTERVAL);
  const restartDrainTimeout = parseOptionalInt(env.RESTART_DRAIN_TIMEOUT);
  const restartDrainPoll = parseOptionalInt(env.RESTART_DRAIN_POLL);
  const restartMaxWindow = parseOptionalInt(env.RESTART_MAX_ATTEMPTS_WINDOW);
  const restartWindowSeconds = parseOptionalInt(env.RESTART_WINDOW_SECONDS);
  const restartCooldown = parseOptionalInt(env.RESTART_COOLDOWN_SECONDS);

  if (Number.isNaN(restartMinInterval) || (restartMinInterval !== null && restartMinInterval < 1)) {
    errors.push("RESTART_MIN_INTERVAL must be an integer >= 1.");
  }
  if (Number.isNaN(restartDrainTimeout) || (restartDrainTimeout !== null && restartDrainTimeout < 1)) {
    errors.push("RESTART_DRAIN_TIMEOUT must be an integer >= 1.");
  }
  if (Number.isNaN(restartDrainPoll) || (restartDrainPoll !== null && restartDrainPoll < 1)) {
    errors.push("RESTART_DRAIN_POLL must be an integer >= 1.");
  }
  if (
    restartDrainTimeout !== null &&
    restartDrainPoll !== null &&
    Number.isFinite(restartDrainTimeout) &&
    Number.isFinite(restartDrainPoll) &&
    restartDrainTimeout < restartDrainPoll
  ) {
    errors.push("RESTART_DRAIN_TIMEOUT must be >= RESTART_DRAIN_POLL.");
  }
  if (Number.isNaN(restartMaxWindow) || (restartMaxWindow !== null && restartMaxWindow < 1)) {
    errors.push("RESTART_MAX_ATTEMPTS_WINDOW must be an integer >= 1.");
  }
  if (Number.isNaN(restartWindowSeconds) || (restartWindowSeconds !== null && restartWindowSeconds < 10)) {
    errors.push("RESTART_WINDOW_SECONDS must be an integer >= 10.");
  }
  if (Number.isNaN(restartCooldown) || (restartCooldown !== null && restartCooldown < 1)) {
    errors.push("RESTART_COOLDOWN_SECONDS must be an integer >= 1.");
  }

  const notifyRouteId = String(env.DISCORD_RESTART_NOTIFY_ROUTE_ID ?? "").trim();
  if (!isValidRouteId(notifyRouteId)) {
    errors.push("DISCORD_RESTART_NOTIFY_ROUTE_ID must be a Discord channel id or feishu:<chat_id>.");
  }

  const backendPort = parseOptionalInt(env.BACKEND_HTTP_PORT ?? env.FEISHU_PORT);
  if (backendPort !== null && (Number.isNaN(backendPort) || backendPort < 1 || backendPort > 65535)) {
    errors.push("BACKEND_HTTP_PORT/FEISHU_PORT must be a valid TCP port (1-65535).");
  }

  if (!String(env.DISCORD_STDOUT_LOG_PATH ?? "").trim()) {
    warnings.push("DISCORD_STDOUT_LOG_PATH is unset; default bridge stdout log path will be used.");
  }
  if (!String(env.DISCORD_STDERR_LOG_PATH ?? "").trim()) {
    warnings.push("DISCORD_STDERR_LOG_PATH is unset; default bridge stderr log path will be used.");
  }

  return { errors, warnings };
}

export function enforceOperationalConfig(env = process.env) {
  const mode = String(env.CONFIG_GOVERNANCE_MODE ?? "strict").trim().toLowerCase();
  const { errors, warnings } = validateOperationalConfig(env);
  for (const warning of warnings) {
    console.warn(`[config-governance] ${warning}`);
  }
  if (errors.length === 0 || mode === "warn") {
    return;
  }
  const detail = errors.map((entry, index) => `${index + 1}. ${entry}`).join("\n");
  throw new Error(`Operational config validation failed:\n${detail}`);
}

