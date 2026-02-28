import { createServerRequestRuntime } from "../approvals/serverRequestRuntime.js";
import { createBootstrapService } from "../channels/bootstrapService.js";
import { isGeneralChannel, resolveRepoContext } from "../channels/context.js";
import { createCommandRouter } from "../commands/router.js";
import {
  buildApprovalActionRows,
  buildResponseForServerRequest,
  describeToolRequestUserInput,
  parseApprovalButtonCustomId
} from "../codex/approvalPayloads.js";
import { normalizeCodexNotification } from "../codex/notificationMapper.js";
import { extractAgentMessageText, extractThreadId, isTransientReconnectErrorMessage } from "../codex/eventUtils.js";
import { createDiscordRuntime } from "./discordRuntime.js";
import { buildTurnRenderPlan, truncateForDiscordMessage } from "../render/messageRenderer.js";
import { TURN_PHASE, transitionTurnPhase } from "../turns/lifecycle.js";
import { createNotificationRuntime } from "../turns/notificationRuntime.js";
import {
  buildFileDiffSection,
  extractWebSearchDetails,
  recordFileChanges,
  summarizeItemForStatus,
  truncateStatusText
} from "../turns/turnFormatting.js";
import { normalizeFinalSummaryText } from "../turns/textNormalization.js";

export function buildBridgeRuntimes(deps) {
  const {
    ChannelType,
    MessageFlags,
    path,
    fs,
    execFileAsync,
    discord,
    codex,
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

  const bootstrapService = createBootstrapService({
    ChannelType,
    path,
    discord,
    codex,
    config,
    state,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups
  });
  const { bootstrapChannelMappings, makeChannelName } = bootstrapService;

  const commandRouter = createCommandRouter({
    ChannelType,
    isGeneralChannel,
    fs,
    path,
    execFileAsync,
    repoRootPath,
    managedChannelTopicPrefix,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    config,
    state,
    codex,
    pendingApprovals,
    makeChannelName,
    collectImageAttachments: runtimeAdapters.collectImageAttachments,
    buildTurnInputFromMessage: runtimeAdapters.buildTurnInputFromMessage,
    enqueuePrompt: runtimeAdapters.enqueuePrompt,
    getQueue: runtimeAdapters.getQueue,
    findActiveTurnByRepoChannel: runtimeAdapters.findActiveTurnByRepoChannel,
    requestSelfRestartFromDiscord: runtimeAdapters.requestSelfRestartFromDiscord,
    findLatestPendingApprovalTokenForChannel: runtimeAdapters.findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision: runtimeAdapters.applyApprovalDecision,
    safeReply,
    getChannelSetups,
    setChannelSetups
  });
  const { handleCommand, handleInitRepoCommand } = commandRouter;

  const notificationRuntime = createNotificationRuntime({
    activeTurns,
    renderVerbosity,
    TURN_PHASE,
    transitionTurnPhase,
    normalizeCodexNotification,
    extractAgentMessageText,
    maybeSendAttachmentsForItem: runtimeAdapters.maybeSendAttachmentsForItem,
    recordFileChanges,
    summarizeItemForStatus,
    extractWebSearchDetails,
    buildFileDiffSection,
    buildTurnRenderPlan,
    sendChunkedToChannel,
    normalizeFinalSummaryText,
    truncateStatusText,
    isTransientReconnectErrorMessage,
    safeSendToChannel,
    truncateForDiscordMessage,
    discordMaxMessageLength: 1900,
    debugLog,
    writeHeartbeatFile: runtimeAdapters.writeHeartbeatFile,
    onTurnFinalized: async (tracker) => {
      await turnRecoveryStore.removeTurn(tracker?.threadId);
    }
  });

  const serverRequestRuntime = createServerRequestRuntime({
    codex,
    discord,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    isGeneralChannel,
    extractThreadId,
    describeToolRequestUserInput,
    buildApprovalActionRows,
    buildResponseForServerRequest,
    truncateStatusText,
    truncateForDiscordMessage,
    safeSendToChannel,
    createApprovalToken
  });

  const discordRuntime = createDiscordRuntime({
    discord,
    config,
    resolveRepoContext,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    bootstrapChannelMappings,
    shouldHandleAsSelfRestartRequest: runtimeAdapters.shouldHandleAsSelfRestartRequest,
    requestSelfRestartFromDiscord: runtimeAdapters.requestSelfRestartFromDiscord,
    collectImageAttachments: runtimeAdapters.collectImageAttachments,
    buildTurnInputFromMessage: runtimeAdapters.buildTurnInputFromMessage,
    enqueuePrompt: runtimeAdapters.enqueuePrompt,
    handleCommand,
    handleInitRepoCommand,
    parseApprovalButtonCustomId,
    approvalButtonPrefix,
    pendingApprovals,
    applyApprovalDecision: runtimeAdapters.applyApprovalDecision,
    safeReply,
    MessageFlags
  });

  return {
    bootstrapChannelMappings,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  };
}
