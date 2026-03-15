import { makeFeishuRouteId } from "./ids.js";

export function resolveFeishuContext(message, options) {
  const { channelSetups, config, generalChat, unboundChat } = options;
  const routeId = String(message?.channelId ?? "").trim();
  console.error(`[DEBUG] resolveFeishuContext called with routeId: ${routeId}`);
  if (!routeId) {
    console.error(`[DEBUG] routeId is empty, returning null`);
    return null;
  }

  const setup = channelSetups[routeId];
  if (setup) {
    console.error(`[DEBUG] Found setup in channelSetups`);
    return {
      repoChannelId: routeId,
      setup: {
        ...setup,
        mode: "repo",
        sandboxMode: config.sandboxMode,
        allowFileWrites: true
      }
    };
  }

  console.error(`[DEBUG] No setup found for routeId, checking generalChat...`);
  if (isFeishuGeneralChat(message, generalChat)) {
    console.error(`[DEBUG] Is general chat`);
    return {
      repoChannelId: routeId,
      setup: {
        cwd: generalChat.cwd,
        model: config.defaultModel,
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    };
  }

  console.error(`[DEBUG] Checking unboundChat mode: ${String(unboundChat?.mode ?? "").trim().toLowerCase()}`);
  if (String(unboundChat?.mode ?? "").trim().toLowerCase() !== "open") {
    console.error(`[DEBUG] Unbound chat mode is not 'open', returning null`);
    return null;
  }

  console.error(`[DEBUG] Using unbound chat mode with cwd: ${unboundChat?.cwd}`);
  return {
    repoChannelId: routeId,
    setup: {
      cwd: unboundChat?.cwd,
      model: config.defaultModel,
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
