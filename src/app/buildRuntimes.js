import { buildCommandRuntime } from "./buildCommandRuntime.js";
import { buildBackendRuntime } from "./buildBackendRuntime.js";
import { buildNotificationRuntime } from "./buildNotificationRuntime.js";
import { buildApprovalRuntime } from "./buildApprovalRuntime.js";
import { buildDiscordRuntime } from "./buildDiscordRuntime.js";
import { buildFeishuRuntime } from "./buildFeishuRuntime.js";
import { createPlatformRegistry } from "../platforms/platformRegistry.js";
import { createDiscordPlatform } from "../platforms/discordPlatform.js";
import { createFeishuPlatform } from "../platforms/feishuPlatform.js";
import { buildTurnRequestId } from "../turns/requestId.js";

export function buildBridgeRuntimes(deps) {
  const {
    ChannelType,
    MessageFlags,
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    fetchChannelByRouteId,
    processStartedAt,
    config,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    renderVerbosity,
    backendHttpEnabled,
    backendHttpHost,
    backendHttpPort,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    sendChunkedToChannel
  } = deps;

  let platformRegistry = null;
  const getPlatformRegistry = () => platformRegistry;

  const {
    bootstrapChannelMappings,
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand
  } = buildCommandRuntime({
    ChannelType,
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    config,
    state,
    pendingApprovals,
    projectsCategoryName,
    repoRootPath,
    managedThreadTopicPrefix,
    managedChannelTopicPrefix,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
    getPlatformRegistry
  });

  const notificationRuntime = buildNotificationRuntime({
    activeTurns,
    renderVerbosity,
    runtimeAdapters,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    sendChunkedToChannel,
  });

  const serverRequestRuntime = buildApprovalRuntime({
    codex,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    safeSendToChannel,
    createApprovalToken,
    fetchChannelByRouteId
  });

  const discordRuntime = buildDiscordRuntime({
    ChannelType,
    MessageFlags,
    discord,
    config,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    projectsCategoryName,
    managedChannelTopicPrefix,
    bootstrapChannelMappings,
    runManagedRouteCommand,
    runtimeAdapters,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    approvalButtonPrefix,
    pendingApprovals,
    safeReply,
  });

  const feishuRuntime = buildFeishuRuntime({
    config,
    runtimeEnv: {
      feishuEnabled: deps.feishuEnabled,
      feishuAppId: deps.feishuAppId,
      feishuAppSecret: deps.feishuAppSecret,
      feishuVerificationToken: deps.feishuVerificationToken,
      feishuTransport: deps.feishuTransport,
      feishuPort: deps.feishuPort,
      feishuHost: deps.feishuHost,
      feishuWebhookPath: deps.feishuWebhookPath,
      imageCacheDir: deps.imageCacheDir,
      feishuGeneralChatId: deps.feishuGeneralChatId,
      feishuGeneralCwd: deps.feishuGeneralCwd,
      feishuRequireMentionInGroup: deps.feishuRequireMentionInGroup,
      feishuUnboundChatMode: deps.feishuUnboundChatMode,
      feishuUnboundChatCwd: deps.feishuUnboundChatCwd
    },
    getChannelSetups,
    bootstrapChannelMappings,
    runManagedRouteCommand,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleSetPathCommand,
    runtimeAdapters,
    safeReply
  });

  platformRegistry = createPlatformRegistry([
    createDiscordPlatform({
      discord,
      discordToken: deps.discordToken,
      waitForDiscordReady: deps.waitForDiscordReady,
      runtime: discordRuntime,
      bootstrapChannelMappings
    }),
    createFeishuPlatform({
      runtime: feishuRuntime
    })
  ]);

  const backendRuntime = buildBackendRuntime({
    enabled: backendHttpEnabled,
    host: backendHttpHost,
    port: backendHttpPort,
    processStartedAt,
    activeTurns,
    pendingApprovals,
    getTurnRequestStatus: (requestId) => turnRecoveryStore.getRequestStatus(requestId),
    findTurnRequestStatusBySource: ({ sourceMessageId, routeId, platform }) =>
      turnRecoveryStore.findRequestStatusBySource({ sourceMessageId, routeId, platform }),
    retryTurnRequest: async ({ requestId, requestStatus }) => {
      const routeId = String(requestStatus?.repoChannelId ?? requestStatus?.channelId ?? "").trim();
      if (!routeId) {
        return { ok: false, error: "missing route for retry" };
      }
      const setup = getChannelSetups()?.[routeId];
      if (!setup) {
        return { ok: false, error: "route setup not found; retry manually from chat" };
      }
      const sourceMessageId = String(requestStatus?.sourceMessageId ?? "").trim();
      if (!sourceMessageId) {
        return { ok: false, error: "missing source message id; retry manually from chat" };
      }

      const channel = await platformRegistry?.fetchChannelByRouteId?.(routeId);
      if (!channel || !channel.isTextBased?.()) {
        return { ok: false, error: "route channel unavailable" };
      }

      if (!channel.messages?.fetch) {
        return { ok: false, error: "platform does not support automatic retry yet" };
      }

      const sourceMessage = await channel.messages.fetch(sourceMessageId).catch(() => null);
      if (!sourceMessage) {
        return { ok: false, error: "source message not found; retry manually from chat" };
      }

      const content = String(sourceMessage.content ?? "").trim();
      const imageAttachments = runtimeAdapters.collectImageAttachments?.(sourceMessage) ?? [];
      const inputItems = await runtimeAdapters.buildTurnInputFromMessage(sourceMessage, content, imageAttachments, setup);
      if (!Array.isArray(inputItems) || inputItems.length === 0) {
        return { ok: false, error: "could not rebuild turn input from source message" };
      }

      const retryRequestId = buildTurnRequestId({
        platform: String(requestStatus?.platform ?? "discord") || "discord",
        routeId,
        messageId: `${sourceMessageId}-retry-${Date.now()}`
      });
      runtimeAdapters.enqueuePrompt(routeId, {
        inputItems,
        message: sourceMessage,
        setup,
        repoChannelId: routeId,
        platform: String(requestStatus?.platform ?? "discord") || "discord",
        requestId: retryRequestId
      });
      return {
        ok: true,
        requestId,
        retryRequestId
      };
    },
    getMappedChannelCount: () => Object.keys(getChannelSetups()).length,
    platformRegistry
  });

  return {
    bootstrapChannelMappings,
    registerSlashCommands: discordRuntime.registerSlashCommands,
    backendRuntime,
    platformRegistry,
    feishuRuntime,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  };
}
