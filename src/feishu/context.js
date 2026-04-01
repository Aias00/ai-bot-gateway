import { makeFeishuRouteId, parseFeishuRouteId } from "./ids.js";
import { resolveSetupAgentAndModel } from "../agents/setupResolution.js";
import { makeScopedRouteId } from "../bots/scopedRoutes.js";

export function resolveFeishuContext(message, options) {
  const { channelSetups, config, generalChat, unboundChat, bot } = options;
  const routeId = String(message?.channelId ?? "").trim();
  if (!routeId) {
    return null;
  }

  const externalRouteId = parseFeishuRouteId(routeId) ?? routeId;
  const scopedRouteId = resolveScopedRouteId(bot, externalRouteId, routeId);
  const setup =
    channelSetups[scopedRouteId] ?? channelSetups[routeId] ?? channelSetups[externalRouteId] ?? bot?.routes?.[externalRouteId];
  if (setup) {
    const resolvedRepo = resolveSetupAgentAndModel(setup, config);
    const normalizedSetupAgentId = String(setup?.agentId ?? "").trim();
    const shouldAttachResolvedModel =
      typeof resolvedRepo.resolvedModel === "string" &&
      resolvedRepo.resolvedModel.length > 0 &&
      resolvedRepo.resolvedModel !== String(setup?.model ?? "").trim();
    const shouldAttachResolvedAgent =
      !normalizedSetupAgentId &&
      typeof resolvedRepo.resolvedAgentId === "string" &&
      resolvedRepo.resolvedAgentId.length > 0;

    return {
      repoChannelId: scopedRouteId,
      ...(buildContextBot(bot) ? { bot: buildContextBot(bot) } : {}),
      setup: {
        ...setup,
        ...(shouldAttachResolvedModel ? { resolvedModel: resolvedRepo.resolvedModel } : {}),
        ...(shouldAttachResolvedAgent ? { resolvedAgentId: resolvedRepo.resolvedAgentId } : {}),
        ...(typeof bot?.runtime === "string" ? { runtime: bot.runtime } : {}),
        bindingKind: "repo",
        mode: "repo",
        sandboxMode: config.sandboxMode,
        allowFileWrites: true
      }
    };
  }

  if (isFeishuGeneralChat(message, generalChat)) {
    const resolvedGeneral = resolveSetupAgentAndModel({}, config);
    return {
      repoChannelId: scopedRouteId,
      ...(buildContextBot(bot) ? { bot: buildContextBot(bot) } : {}),
      setup: {
        cwd: generalChat.cwd,
        resolvedModel: resolvedGeneral.resolvedModel ?? config.defaultModel,
        ...(typeof resolvedGeneral.resolvedAgentId === "string" && resolvedGeneral.resolvedAgentId.length > 0
          ? { resolvedAgentId: resolvedGeneral.resolvedAgentId }
          : {}),
        ...(typeof bot?.runtime === "string" ? { runtime: bot.runtime } : {}),
        bindingKind: "general",
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    };
  }

  if (String(unboundChat?.mode ?? "").trim().toLowerCase() !== "open") {
    return null;
  }

  const resolvedUnbound = resolveSetupAgentAndModel({}, config);
  return {
    repoChannelId: scopedRouteId,
    ...(buildContextBot(bot) ? { bot: buildContextBot(bot) } : {}),
    setup: {
      cwd: unboundChat?.cwd,
      resolvedModel: resolvedUnbound.resolvedModel ?? config.defaultModel,
      ...(typeof resolvedUnbound.resolvedAgentId === "string" && resolvedUnbound.resolvedAgentId.length > 0
        ? { resolvedAgentId: resolvedUnbound.resolvedAgentId }
        : {}),
      ...(typeof bot?.runtime === "string" ? { runtime: bot.runtime } : {}),
      bindingKind: "unbound-open",
      mode: "repo",
      sandboxMode: config.sandboxMode,
      allowFileWrites: true
    }
  };
}

export function isFeishuGeneralChat(messageOrChannel, generalChat) {
  const generalChatId = String(generalChat?.id ?? "").trim();
  if (!generalChatId) {
    return false;
  }

  const routeId = String(messageOrChannel?.channelId ?? messageOrChannel?.id ?? "").trim();
  if (!routeId) {
    return false;
  }

  return routeId === makeFeishuRouteId(generalChatId) || routeId === generalChatId;
}

function resolveScopedRouteId(bot, externalRouteId, fallbackRouteId) {
  const scopedRouteId = makeScopedRouteId(bot?.botId, externalRouteId);
  return scopedRouteId || String(fallbackRouteId ?? "").trim();
}

function buildContextBot(bot) {
  const botId = String(bot?.botId ?? "").trim();
  const runtime = String(bot?.runtime ?? "").trim();
  if (!botId && !runtime) {
    return null;
  }
  return {
    ...(botId ? { botId } : {}),
    ...(runtime ? { runtime } : {})
  };
}
