import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import { CodexRpcClient } from "../codexRpcClient.js";
import { maybeSendAttachmentsForItem as maybeSendAttachmentsForItemFromService } from "../attachments/service.js";
import { createAttachmentInputBuilder } from "../attachments/inputBuilder.js";
import { createChannelMessaging } from "./channelMessaging.js";
import { createRuntimeAdapters } from "./runtimeAdapters.js";
import { loadConfig } from "../config/loadConfig.js";
import { loadRuntimeEnv } from "../config/runtimeEnv.js";
import { isThreadNotFoundError } from "../codex/eventUtils.js";
import { createSandboxPolicyResolver } from "../codex/sandboxPolicy.js";
import { createTurnRunner } from "../codex/turnRunner.js";
import { sendChunkedToChannel as sendChunkedToChannelFromRenderer } from "../render/messageRenderer.js";
import { StateStore } from "../stateStore.js";
import { createTurnRecoveryStore } from "../turns/recoveryStore.js";
import { statusLabelForItemType, truncateStatusText } from "../turns/turnFormatting.js";
import { createDebugLog, formatInputTextForSetup } from "./runtimeUtils.js";

export async function initializeRuntimeContext() {
  dotenv.config();

  const discordToken = process.env.DISCORD_BOT_TOKEN;
  if (!discordToken) {
    console.error("Missing DISCORD_BOT_TOKEN");
    process.exit(1);
  }

  const runtimeEnv = loadRuntimeEnv();
  const {
    configPath,
    statePath,
    codexBin,
    imageCacheDir,
    maxImagesPerMessage,
    attachmentMaxBytes,
    attachmentRoots,
    attachmentInferFromText,
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    inFlightRecoveryPath,
    debugLoggingEnabled,
    extraWritableRoots
  } = runtimeEnv;
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
  const processStartedAt = new Date().toISOString();
  const refs = {
    runtimeOps: null,
    discordRuntime: null,
    notificationRuntime: null,
    serverRequestRuntime: null,
    shutdown: null,
    turnRunner: null
  };
  let nextApprovalToken = 1;
  const createApprovalToken = () => String(nextApprovalToken++).padStart(4, "0");
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
    getTurnRunner: () => refs.turnRunner,
    getNotificationRuntime: () => refs.notificationRuntime,
    getServerRequestRuntime: () => refs.serverRequestRuntime,
    getDiscordRuntime: () => refs.discordRuntime,
    getRuntimeOps: () => refs.runtimeOps,
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

  refs.turnRunner = createTurnRunner({
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
    onActiveTurnsChanged: () => refs.runtimeOps?.writeHeartbeatFile()
  });

  return {
    fs,
    path,
    execFileAsync,
    runtimeEnv,
    discordToken,
    discordMaxMessageLength,
    debugLog,
    config,
    state,
    getChannelSetups: () => channelSetups,
    setChannelSetups: (nextSetups) => {
      channelSetups = nextSetups;
    },
    discord,
    codex,
    safeReply,
    safeSendToChannel,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    refs,
    runtimeAdapters,
    turnRecoveryStore,
    createApprovalToken
  };
}
