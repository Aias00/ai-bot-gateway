import { isFeishuRouteId, parseFeishuRouteId } from "../feishu/ids.js";
import { isFeishuWebhookTransport } from "../feishu/transport.js";

export function createFeishuPlatform(deps) {
  const { bot, runtime } = deps;
  const botId = String(bot?.botId ?? "").trim();
  const instanceKey = botId || "feishu";
  const enabled = runtime?.enabled === true;
  const supportsWebhookIngress = enabled && isFeishuWebhookTransport(runtime?.transport);

  return {
    platformId: "feishu",
    ...(botId ? { botId } : {}),
    instanceKey,
    enabled,
    capabilities: {
      supportsPlainMessages: true,
      supportsSlashCommands: false,
      supportsButtons: false,
      supportsAttachments: true,
      supportsRepoBootstrap: false,
      supportsAutoDiscovery: false,
      supportsWebhookIngress
    },
    canHandleRouteId(routeId) {
      const normalizedRouteId = String(routeId ?? "").trim();
      return isFeishuRouteId(normalizedRouteId) || isRawFeishuChatId(normalizedRouteId);
    },
    async fetchChannelByRouteId(routeId) {
      if (!enabled) {
        return null;
      }
      const normalizedRouteId = String(routeId ?? "").trim();
      const targetRouteId = parseFeishuRouteId(normalizedRouteId) ?? normalizedRouteId;
      if (!targetRouteId) {
        return null;
      }
      return await runtime.fetchChannelByRouteId(targetRouteId);
    },
    getHttpEndpoints() {
      if (!supportsWebhookIngress || !runtime?.webhookPath) {
        return [];
      }
      return [runtime.webhookPath];
    },
    matchesHttpRequest({ pathname }) {
      return supportsWebhookIngress && pathname === runtime?.webhookPath;
    },
    async handleHttpRequest(request, response, options = {}) {
      await runtime.handleHttpRequest(request, response, options);
    },
    async start() {
      const summary = (await runtime?.start?.()) ?? {};
      return {
        platformId: "feishu",
        ...(botId ? { botId } : {}),
        instanceKey,
        started: enabled,
        transport: runtime?.transport ?? null,
        ...summary
      };
    },
    async stop() {
      const summary = (await runtime?.stop?.()) ?? {};
      return {
        platformId: "feishu",
        ...(botId ? { botId } : {}),
        instanceKey,
        ...summary
      };
    }
  };
}

function isRawFeishuChatId(routeId) {
  const normalizedRouteId = String(routeId ?? "").trim();
  return normalizedRouteId.startsWith("oc_");
}
