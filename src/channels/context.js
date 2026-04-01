import { DISCORD_CHANNEL_TYPES } from "../discord/constants.js";
import { resolveSetupAgentAndModel } from "../agents/setupResolution.js";
import { makeScopedRouteId } from "../bots/scopedRoutes.js";

export function isGeneralChannel(channel, generalChannel) {
  if (channel?.type !== DISCORD_CHANNEL_TYPES.GuildText) {
    return false;
  }
  const generalChannelId = String(generalChannel?.id ?? "").trim();
  if (generalChannelId) {
    return channel.id === generalChannelId;
  }
  const configuredName = String(generalChannel?.name ?? "general")
    .trim()
    .toLowerCase();
  return channel.name.toLowerCase() === configuredName;
}

export function resolveRepoContext(message, options) {
  const { channelSetups, config, generalChannel, bot } = options;
  if (message.channel.type !== DISCORD_CHANNEL_TYPES.GuildText) {
    return null;
  }

  const externalRouteId = String(message?.channelId ?? "").trim();
  const scopedRouteId = resolveScopedRouteId(bot, externalRouteId);
  const setup = channelSetups[scopedRouteId] ?? bot?.routes?.[externalRouteId] ?? channelSetups[externalRouteId];
  if (!setup) {
    const resolvedGeneral = resolveSetupAgentAndModel({}, config);
    if (!isGeneralChannel(message.channel, generalChannel)) {
      return null;
    }
    return {
      repoChannelId: scopedRouteId,
      ...(buildContextBot(bot) ? { bot: buildContextBot(bot) } : {}),
      setup: {
        cwd: generalChannel.cwd,
        resolvedModel: resolvedGeneral.resolvedModel ?? config.defaultModel,
        ...(typeof resolvedGeneral.resolvedAgentId === "string" && resolvedGeneral.resolvedAgentId.length > 0
          ? { resolvedAgentId: resolvedGeneral.resolvedAgentId }
          : {}),
        ...(typeof bot?.runtime === "string" ? { runtime: bot.runtime } : {}),
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    };
  }

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
      mode: "repo",
      sandboxMode: config.sandboxMode,
      allowFileWrites: true
    }
  };
}

function resolveScopedRouteId(bot, externalRouteId) {
  const normalizedExternalRouteId = String(externalRouteId ?? "").trim();
  const scopedRouteId = makeScopedRouteId(bot?.botId, normalizedExternalRouteId);
  return scopedRouteId || normalizedExternalRouteId;
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
