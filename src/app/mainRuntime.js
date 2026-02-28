import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { ChannelType, Client, GatewayIntentBits, MessageFlags } from "discord.js";
import { CodexRpcClient } from "../codexRpcClient.js";
import { maybeSendAttachmentsForItem as maybeSendAttachmentsForItemFromService } from "../attachments/service.js";
import { createAttachmentInputBuilder } from "../attachments/inputBuilder.js";
import { createRuntimeOps } from "./runtimeOps.js";
import { createChannelMessaging } from "./channelMessaging.js";
import { buildBridgeRuntimes } from "./buildRuntimes.js";
import { createRuntimeAdapters } from "./runtimeAdapters.js";
import { createShutdownHandler } from "./shutdown.js";
import { startBridgeRuntime } from "./startup.js";
import { wireBridgeListeners } from "./wireListeners.js";
import { loadConfig } from "../config/loadConfig.js";
import { loadRuntimeEnv } from "../config/runtimeEnv.js";
import { isThreadNotFoundError } from "../codex/eventUtils.js";
import { createSandboxPolicyResolver } from "../codex/sandboxPolicy.js";
import { createTurnRunner } from "../codex/turnRunner.js";
import { sendChunkedToChannel as sendChunkedToChannelFromRenderer } from "../render/messageRenderer.js";
import { StateStore } from "../stateStore.js";
import { createTurnRecoveryStore } from "../turns/recoveryStore.js";
import { statusLabelForItemType, truncateStatusText } from "../turns/turnFormatting.js";
import {
  createDebugLog,
  formatInputTextForSetup,
  isDiscordMissingPermissionsError,
  waitForDiscordReady
} from "./runtimeUtils.js";

export async function startMainRuntime() {
  dotenv.config();

  const discordToken = process.env.DISCORD_BOT_TOKEN;
  if (!discordToken) {
    console.error("Missing DISCORD_BOT_TOKEN");
    process.exit(1);
  }

  const {
    configPath,
    statePath,
    codexBin,
    codexHomeEnv,
    repoRootPath,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    approvalButtonPrefix,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    imageCacheDir,
    maxImagesPerMessage,
    attachmentMaxBytes,
    attachmentRoots,
    attachmentInferFromText,
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    renderVerbosity,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    inFlightRecoveryPath,
    exitOnRestartAck,
    heartbeatIntervalMs,
    debugLoggingEnabled,
    projectsCategoryName,
    extraWritableRoots
  } = loadRuntimeEnv();
  const discordMaxMessageLength = 1900;
  const execFileAsync = promisify(execFile);
  const defaultModel = "gpt-5.3-codex";
  const defaultEffort = "medium";
  const debugLog = createDebugLog(debugLoggingEnabled);

  const config = await loadConfig(configPath, { defaultModel, defaultEffort });
  let channelSetups = { ...config.channels };
  const state = new StateStore(statePath);
  await state.load();
  const legacyThreadsDropped = state.consumeLegacyDropCount();
  if (legacyThreadsDropped > 0) {
    console.warn(`Cutover: dropped ${legacyThreadsDropped} legacy channel thread bindings from state.`);
    await state.save();
  }

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  const codex = new CodexRpcClient({
    codexBin
  });
  const channelMessaging = createChannelMessaging({ discord });
  const { safeReply, safeSendToChannel, safeSendToChannelPayload } = channelMessaging;
  const sandboxPolicyResolver = createSandboxPolicyResolver({
    path,
    execFileAsync,
    extraWritableRoots
  });
  const { buildSandboxPolicyForTurn } = sandboxPolicyResolver;
  const turnRecoveryStore = createTurnRecoveryStore({
    fs,
    path,
    recoveryPath: inFlightRecoveryPath,
    debugLog
  });
  await turnRecoveryStore.load();

  const queues = new Map();
  const activeTurns = new Map();
  const pendingApprovals = new Map();
  let nextApprovalToken = 1;
  const processStartedAt = new Date().toISOString();
  let runtimeOps = null;
  let discordRuntime = null;
  let notificationRuntime = null;
  let serverRequestRuntime = null;
  let shutdown = null;
  let turnRunner = null;
  const attachmentInputBuilder = createAttachmentInputBuilder({
    fs,
    imageCacheDir,
    maxImagesPerMessage,
    discordToken,
    fetch,
    formatInputTextForSetup,
    logger: console
  });
  const runtimeAdapters = createRuntimeAdapters({
    attachmentInputBuilder,
    getTurnRunner: () => turnRunner,
    getNotificationRuntime: () => notificationRuntime,
    getServerRequestRuntime: () => serverRequestRuntime,
    getDiscordRuntime: () => discordRuntime,
    getRuntimeOps: () => runtimeOps,
    getDiscord: () => discord,
    maybeSendAttachmentsForItemFromService,
    sendChunkedToChannelFromRenderer,
    attachmentConfig: {
      attachmentsEnabled,
      attachmentItemTypes,
      attachmentMaxBytes,
      attachmentRoots,
      imageCacheDir,
      attachmentInferFromText,
      attachmentIssueLimitPerTurn
    },
    channelMessagingConfig: {
      statusLabelForItemType,
      safeSendToChannel,
      safeSendToChannelPayload,
      truncateStatusText,
      discordMaxMessageLength
    }
  });
  turnRunner = createTurnRunner({
    queues,
    activeTurns,
    state,
    codex,
    config,
    safeReply,
    buildSandboxPolicyForTurn,
    isThreadNotFoundError,
    finalizeTurn: runtimeAdapters.finalizeTurn,
    onTurnReconnectPending: runtimeAdapters.onTurnReconnectPending,
    onTurnCreated: async (tracker) => {
      await turnRecoveryStore.upsertTurnFromTracker(tracker);
    },
    onTurnAborted: async (threadId) => {
      await turnRecoveryStore.removeTurn(threadId);
    },
    onActiveTurnsChanged: () => runtimeOps?.writeHeartbeatFile()
  });

  wireBridgeListeners({
    codex,
    discord,
    handleNotification: runtimeAdapters.handleNotification,
    handleServerRequest: runtimeAdapters.handleServerRequest,
    handleMessage: runtimeAdapters.handleMessage,
    handleInteraction: runtimeAdapters.handleInteraction
  });

  runtimeOps = createRuntimeOps({
    fs,
    path,
    debugLog,
    activeTurns,
    pendingApprovals,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    processStartedAt,
    heartbeatIntervalMs,
    exitOnRestartAck,
    safeReply,
    safeSendToChannel,
    truncateStatusText,
    shutdown: (...args) => shutdown?.(...args)
  });
  const {
    bootstrapChannelMappings,
    notificationRuntime: builtNotificationRuntime,
    serverRequestRuntime: builtServerRequestRuntime,
    discordRuntime: builtDiscordRuntime
  } = buildBridgeRuntimes({
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
    getChannelSetups: () => channelSetups,
    setChannelSetups: (nextSetups) => {
      channelSetups = nextSetups;
    },
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    createApprovalToken: () => String(nextApprovalToken++).padStart(4, "0"),
    sendChunkedToChannel: runtimeAdapters.sendChunkedToChannel
  });
  notificationRuntime = builtNotificationRuntime;
  serverRequestRuntime = builtServerRequestRuntime;
  discordRuntime = builtDiscordRuntime;

  shutdown = createShutdownHandler({
    codex,
    discord,
    stopHeartbeatLoop: () => runtimeOps?.stopHeartbeatLoop()
  });
  await startBridgeRuntime({
    codex,
    fs,
    generalChannelCwd,
    discord,
    discordToken,
    waitForDiscordReady,
    maybeCompletePendingRestartNotice: runtimeAdapters.maybeCompletePendingRestartNotice,
    turnRecoveryStore,
    safeSendToChannel,
    bootstrapChannelMappings,
    getMappedChannelCount: () => Object.keys(channelSetups).length,
    startHeartbeatLoop: runtimeAdapters.startHeartbeatLoop
  });

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
}
