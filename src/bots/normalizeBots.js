import path from "node:path";

const BOT_RUNTIME_VALUES = new Set(["codex", "claude"]);
const BOT_PLATFORM_VALUES = new Set(["discord", "feishu"]);

export function normalizeBots({ rawBots, legacyChannels, agents, defaultRuntime }) {
  if (rawBots && typeof rawBots === "object" && !Array.isArray(rawBots) && Object.keys(rawBots).length > 0) {
    return normalizeDeclaredBots(rawBots, agents, defaultRuntime);
  }
  return synthesizeLegacyBots(legacyChannels, agents, defaultRuntime);
}

function normalizeDeclaredBots(rawBots, agents, defaultRuntime) {
  const normalizedBots = {};
  for (const [botId, rawBot] of Object.entries(rawBots)) {
    if (!rawBot || typeof rawBot !== "object" || Array.isArray(rawBot)) {
      throw new Error(`Bot ${botId} must be an object`);
    }
    const normalizedPlatform = normalizeBotPlatform(rawBot.platform, botId);
    const normalizedRuntime = normalizeBotRuntime(rawBot.runtime ?? defaultRuntime, botId);
    const routes = normalizeRoutes(rawBot.routes, {
      botId,
      botRuntime: normalizedRuntime,
      agents,
      platform: normalizedPlatform
    });

    normalizedBots[botId] = {
      platform: normalizedPlatform,
      runtime: normalizedRuntime,
      auth: normalizePlainObject(rawBot.auth),
      ...(rawBot.settings && typeof rawBot.settings === "object" && !Array.isArray(rawBot.settings)
        ? { settings: normalizePlainObject(rawBot.settings) }
        : {}),
      routes
    };
  }
  return normalizedBots;
}

function synthesizeLegacyBots(legacyChannels, agents, defaultRuntime) {
  const discordRoutes = {};
  const feishuRoutes = {};

  for (const [routeId, setup] of Object.entries(legacyChannels ?? {})) {
    if (isLegacyFeishuRouteId(routeId)) {
      feishuRoutes[stripLegacyFeishuPrefix(routeId)] = { ...setup };
      continue;
    }
    discordRoutes[routeId] = { ...setup };
  }

  const normalizedBots = {};
  if (Object.keys(discordRoutes).length > 0) {
    normalizedBots["discord-default"] = {
      platform: "discord",
      runtime: defaultRuntime,
      auth: {
        tokenEnv: "DISCORD_BOT_TOKEN"
      },
      settings: {
        allowedUserIdsEnv: "DISCORD_ALLOWED_USER_IDS"
      },
      routes: normalizeRoutes(discordRoutes, {
        botId: "discord-default",
        botRuntime: defaultRuntime,
        agents,
        platform: "discord"
      })
    };
  }
  if (Object.keys(feishuRoutes).length > 0) {
    normalizedBots["feishu-default"] = {
      platform: "feishu",
      runtime: defaultRuntime,
      auth: {
        appIdEnv: "FEISHU_APP_ID",
        appSecretEnv: "FEISHU_APP_SECRET",
        verificationTokenEnv: "FEISHU_VERIFICATION_TOKEN"
      },
      settings: {
        allowedOpenIdsEnv: "FEISHU_ALLOWED_OPEN_IDS"
      },
      routes: normalizeRoutes(feishuRoutes, {
        botId: "feishu-default",
        botRuntime: defaultRuntime,
        agents,
        platform: "feishu"
      })
    };
  }

  return normalizedBots;
}

function normalizeRoutes(rawRoutes, options) {
  const { botId, botRuntime, agents } = options;
  const routes = {};
  const entries =
    rawRoutes && typeof rawRoutes === "object" && !Array.isArray(rawRoutes)
      ? Object.entries(rawRoutes)
      : [];

  for (const [routeId, value] of entries) {
    const normalizedRouteId = String(routeId ?? "").trim();
    if (!normalizedRouteId) {
      continue;
    }
    const normalizedSetup = normalizeRouteSetup(normalizedRouteId, value);
    const agentRuntime = getAgentRuntime(normalizedSetup.agentId, agents);
    if (agentRuntime && agentRuntime !== botRuntime) {
      throw new Error(
        `Route ${botId}/${normalizedRouteId} references agent ${normalizedSetup.agentId} which is incompatible with bot runtime ${botRuntime}`
      );
    }
    routes[normalizedRouteId] = normalizedSetup;
  }

  return routes;
}

function normalizeRouteSetup(routeId, value) {
  if (typeof value === "string") {
    return { cwd: path.resolve(value) };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.cwd === "string") {
    const explicitAgentId =
      typeof value.agentId === "string" ? value.agentId : typeof value.agent === "string" ? value.agent : undefined;
    return {
      cwd: path.resolve(value.cwd),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof explicitAgentId === "string" && explicitAgentId.trim() ? { agentId: explicitAgentId.trim() } : {})
    };
  }
  throw new Error(`Mapping ${routeId} must map to a cwd string or { cwd, model?, agentId? } object`);
}

function getAgentRuntime(agentId, agents) {
  const normalizedAgentId = String(agentId ?? "").trim();
  if (!normalizedAgentId) {
    return null;
  }
  const agent = agents?.[normalizedAgentId];
  return agent?.runtime === "claude" || agent?.runtime === "codex" ? agent.runtime : null;
}

function normalizeBotRuntime(value, botId) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!BOT_RUNTIME_VALUES.has(normalized)) {
    throw new Error(`Bot ${botId} has invalid runtime '${value}'. Use one of: codex, claude.`);
  }
  return normalized;
}

function normalizeBotPlatform(value, botId) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!BOT_PLATFORM_VALUES.has(normalized)) {
    throw new Error(`Bot ${botId} has invalid platform '${value}'. Use one of: discord, feishu.`);
  }
  return normalized;
}

function normalizePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key).trim(), normalizeSettingValue(entryValue)])
      .filter(([key, entryValue]) => key.length > 0 && entryValue !== undefined)
  );
}

function normalizeSettingValue(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function isLegacyFeishuRouteId(routeId) {
  return String(routeId ?? "").trim().startsWith("feishu:");
}

function stripLegacyFeishuPrefix(routeId) {
  return String(routeId ?? "").trim().slice("feishu:".length).trim();
}
