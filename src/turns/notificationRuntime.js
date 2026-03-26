import { isMissingRolloutPathError } from "../app/runtimeUtils.js";
import { extractStreamingAppend, normalizeStreamingSnapshotText } from "./textNormalization.js";

export function createNotificationRuntime(deps) {
  const {
    renderVerbosity = "user",
    activeTurns,
    TURN_PHASE,
    transitionTurnPhase,
    normalizeCodexNotification,
    extractAgentMessageText,
    maybeSendAttachmentsForItem = async () => {},
    recordFileChanges,
    buildFileDiffSection,
    sanitizeSummaryForDiscord = (text) => String(text ?? "").trim(),
    sendChunkedToChannel,
    normalizeFinalSummaryText,
    truncateStatusText,
    isTransientReconnectErrorMessage,
    safeSendToChannel,
    truncateForDiscordMessage,
    discordMaxMessageLength = 1900,
    feishuMaxMessageLength = 8000,
    disableStreamingOutput = false,
    discordSegmentedStreaming = true,
    discordStreamFlushMs = 900,
    discordStreamMinChars: discordStreamMinCharsInput,
    feishuSegmentedStreaming = false,
    feishuStreamMinChars = 80,
    debugLog,
    writeHeartbeatFile,
    onTurnFinalized,
    splitTextForMessages = splitTextForMessagesFallback,
    turnCompletionQuietMs = 3000,
    turnCompletionMaxWaitMs = 12000,
    reconnectSettleQuietMs = 5000
  } = deps;
  const discordStreamMinChars = Number.isFinite(Number(discordStreamMinCharsInput))
    ? Math.max(20, Number(discordStreamMinCharsInput))
    : 32;

  async function handleNotification({ method, params }) {
    const normalized = normalizeCodexNotification({ method, params });

    if (normalized.kind === "agent_delta") {
      const threadId = normalized.threadId;
      const delta = normalized.delta;
      if (!threadId || !delta) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      noteTurnActivity(tracker);
      await ensureThinkingStage(tracker);
      transitionTurnPhase(tracker, TURN_PHASE.RUNNING);
      debugLog("item-delta", "agent delta", {
        threadId,
        turnId: threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        deltaLength: delta.length
      });
      appendTrackerText(tracker, delta, { fromDelta: true });
      return;
    }

    if (normalized.kind === "item_lifecycle") {
      const threadId = normalized.threadId;
      if (!threadId) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      noteTurnActivity(tracker);
      const item = normalized.item;
      const state = normalized.state;
      updateLifecycleItemState(tracker, item, state);
      if (isToolCallItemType(item?.type)) {
        noteToolCallObserved(tracker);
        await ensureWorkingStage(tracker);
      }
      await ensureThinkingStage(tracker);
      if (state === "started") {
        transitionTurnPhase(tracker, TURN_PHASE.RUNNING);
      }

      if (tracker.turnCompletionRequested) {
        scheduleTurnFinalizeWhenSettled(threadId, tracker);
      }
      debugLog("item-event", "item lifecycle", {
        threadId,
        turnId: threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        state,
        itemType: item?.type,
        itemId: item?.id ?? null
      });

      if (item?.type === "fileChange" && method === "item/completed") {
        recordFileChanges(tracker, item);
      }

      if (state === "completed") {
        if (item?.type === "imageView") {
          await maybeSendAttachmentsForItem(tracker, item);
        }
      }

      if (state === "started") {
        return;
      }

      const messageText = extractAgentMessageText(item);
      if (!messageText) {
        return;
      }
      if (tracker.seenDelta || tracker.fullText.length > 0) {
        return;
      }
      appendTrackerText(tracker, messageText, { fromDelta: false });
      return;
    }

    if (normalized.kind === "turn_completed") {
      const threadId = normalized.threadId;
      if (!threadId) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      noteTurnActivity(tracker);
      tracker.turnCompletionRequested = true;
      if (!tracker.turnCompletionRequestedAt) {
        tracker.turnCompletionRequestedAt = Date.now();
      }
      scheduleTurnFinalizeWhenSettled(threadId, tracker);
      return;
    }

    if (normalized.kind === "error") {
      const threadId = normalized.threadId;
      const message = normalized.errorMessage;
      if (threadId) {
        const tracker = activeTurns.get(threadId);
        if (tracker && isTransientReconnectErrorMessage(message)) {
          noteReconnectObserved(tracker);
          markTurnReconnecting(tracker, "🔄 Temporary reconnect while processing. Continuing automatically while connection recovers...");
          debugLog("transport", "transient reconnect while turn active", {
            threadId,
            turnId: threadId,
            discordMessageId: tracker.statusMessageId ?? null,
            message: truncateStatusText(String(message ?? ""), 200)
          });
          return;
        }
        if (isMissingRolloutPathError(message)) {
          debugLog("transport", "ignoring missing rollout path error", {
            threadId,
            turnId: threadId,
            discordMessageId: tracker?.statusMessageId ?? null,
            message: truncateStatusText(String(message ?? ""), 200)
          });
          return;
        }
        await finalizeTurn(threadId, new Error(message));
      }
    }
  }

  function onTurnReconnectPending(threadId, context = {}) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    const attempt = Number.isFinite(Number(context.attempt)) ? Number(context.attempt) : 1;
    const suffix = attempt > 1 ? ` (retry ${attempt})` : "";
    markTurnReconnecting(
      tracker,
      `🔄 Temporary reconnect while processing. Continuing automatically while connection recovers...${suffix}`
    );
  }

  function scheduleFlush(tracker) {
    if (tracker.flushTimer) {
      return;
    }
    const elapsed = Date.now() - tracker.lastFlushAt;
    const targetDelay = isDiscordTracker(tracker) ? discordStreamFlushMs : 800;
    const delay = Math.max(0, targetDelay - elapsed);
    tracker.flushTimer = setTimeout(() => {
      tracker.flushTimer = null;
      void flushTrackerParagraphs(tracker, { force: false }).catch((error) => {
        console.error(`tracker flush failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
      });
    }, delay);
  }

  async function flushTrackerParagraphs(tracker, { force }) {
    if (!force && !activeTurns.has(tracker.threadId)) {
      return;
    }
    if (canSegmentStreamTrackerOutput(tracker)) {
      if (isDiscordTracker(tracker)) {
        await flushDiscordStreamSegments(tracker, { force });
      } else {
        await flushFeishuStreamSegments(tracker, { force });
      }
      tracker.lastFlushAt = Date.now();
      return;
    }
    const content = buildTrackerMessageContent(tracker);
    await editTrackerMessage(tracker, content);
    tracker.lastFlushAt = Date.now();
  }

  async function finalizeTurn(threadId, error) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    if (tracker.finalizing) {
      return;
    }
    if (!transitionTurnPhase(tracker, TURN_PHASE.FINALIZING)) {
      return;
    }
    tracker.finalizing = true;
    clearTurnFinalizeTimer(tracker);
    tracker.turnCompletionRequested = false;
    let finalError = error ? toError(error) : null;
    let resolvedText = null;

    if (tracker.flushTimer) {
      clearTimeout(tracker.flushTimer);
      tracker.flushTimer = null;
    }

    try {
      clearThinkingTicker(tracker);
      if (finalError) {
        tracker.failed = true;
        tracker.completed = true;
        tracker.failureMessage = finalError.message;
        transitionTurnPhase(tracker, TURN_PHASE.FAILED);
        if (isTransientReconnectErrorMessage(finalError.message)) {
          pushStatusLine(
            tracker,
            "🔄 Temporary reconnect while processing did not recover in time. Please retry."
          );
        } else {
          pushStatusLine(tracker, `❌ Error: ${truncateStatusText(finalError.message, 220)}`);
        }
        await safeSendToChannel(tracker.channel, `❌ Error: ${truncateStatusText(finalError.message, 220)}`).catch((sendError) => {
          console.error(`failed to send turn error for ${threadId}: ${formatErrorMessage(sendError)}`);
        });
        return;
      }

      tracker.completed = true;
      transitionTurnPhase(tracker, TURN_PHASE.DONE);
      await finalizeUxFlowStages(tracker);

      tracker.fullText = normalizeFinalSummaryText(tracker.fullText);
      const summaryTextForDiscord = sanitizeSummaryForDiscord(tracker.fullText);
      const diffBlock = renderVerbosity === "ops" ? buildFileDiffSection(tracker) : "";
      debugLog("summary", "prepared summary text", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        rawLength: tracker.fullText.length,
        sanitizedLength: summaryTextForDiscord.length,
        rawPreview: summarizeForDebug(tracker.fullText, 180),
        sanitizedPreview: summarizeForDebug(summaryTextForDiscord, 180)
      });
      if (summaryTextForDiscord) {
        await sendFinalSummary(tracker, summaryTextForDiscord);
      }
      if (diffBlock) {
        await sendChunkedToChannel(tracker.channel, diffBlock);
      }
      resolvedText = tracker.fullText;
    } catch (caughtError) {
      const normalizedError = toError(caughtError);
      if (!finalError) {
        finalError = normalizedError;
        tracker.failed = true;
        tracker.completed = true;
        tracker.failureMessage = normalizedError.message;
        transitionTurnPhase(tracker, TURN_PHASE.FAILED);
        pushStatusLine(tracker, `❌ Error: ${truncateStatusText(normalizedError.message, 220)}`);
        await safeSendToChannel(tracker.channel, `❌ Error: ${truncateStatusText(normalizedError.message, 220)}`).catch(
          (sendError) => {
            console.error(`failed to send turn error for ${threadId}: ${formatErrorMessage(sendError)}`);
          }
        );
      }
      console.error(`turn finalization failed for ${threadId}: ${formatErrorMessage(normalizedError)}`);
    } finally {
      clearWorkingTicker(tracker);
      clearThinkingTicker(tracker);
      activeTurns.delete(threadId);
      if (finalError) {
        settleTracker(tracker, "reject", finalError);
      } else {
        settleTracker(tracker, "resolve", resolvedText ?? tracker.fullText);
      }
      if (typeof onTurnFinalized === "function") {
        try {
          await onTurnFinalized(tracker);
        } catch (finalizeError) {
          console.error(`onTurnFinalized failed for ${threadId}: ${formatErrorMessage(finalizeError)}`);
        }
      }
      try {
        await writeHeartbeatFile();
      } catch (heartbeatError) {
        console.error(`failed to write heartbeat after turn ${threadId}: ${formatErrorMessage(heartbeatError)}`);
      }
    }
  }

  function noteTurnActivity(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    tracker.lastTurnActivityAt = Date.now();
  }

  function noteToolCallObserved(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    const now = Date.now();
    tracker.hasToolCall = true;
    if (!Number.isFinite(tracker.firstToolCallAt) || tracker.firstToolCallAt <= 0) {
      tracker.firstToolCallAt = now;
      return;
    }
    if (now < tracker.firstToolCallAt) {
      tracker.firstToolCallAt = now;
    }
  }

  function noteReconnectObserved(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    tracker.lastReconnectAt = Date.now();
  }

  function updateLifecycleItemState(tracker, item, state) {
    if (!tracker || !item || typeof item !== "object" || typeof state !== "string") {
      return;
    }
    if (!tracker.activeLifecycleItemKeys) {
      tracker.activeLifecycleItemKeys = new Set();
    }
    if (!tracker.completedLifecycleItemKeys) {
      tracker.completedLifecycleItemKeys = new Set();
    }
    const key = makeLifecycleItemKey(item);
    if (!key) {
      return;
    }
    if (state === "completed") {
      tracker.completedLifecycleItemKeys.add(key);
      tracker.activeLifecycleItemKeys.delete(key);
      return;
    }
    if (state === "started") {
      if (tracker.completedLifecycleItemKeys.has(key)) {
        return;
      }
      tracker.activeLifecycleItemKeys.add(key);
    }
  }

  function makeLifecycleItemKey(item) {
    if (!item || typeof item !== "object") {
      return "";
    }
    const type = typeof item.type === "string" ? item.type : "unknown";
    const id = item.id !== undefined && item.id !== null ? String(item.id) : "";
    if (id) {
      return `${type}:${id}`;
    }
    return "";
  }

  function clearTurnFinalizeTimer(tracker) {
    if (!tracker?.turnFinalizeTimer) {
      return;
    }
    clearTimeout(tracker.turnFinalizeTimer);
    tracker.turnFinalizeTimer = null;
  }

  function scheduleTurnFinalizeWhenSettled(threadId, tracker) {
    if (!tracker || tracker.finalizing || tracker.completed) {
      return;
    }
    clearTurnFinalizeTimer(tracker);
    tracker.turnFinalizeTimer = setTimeout(() => {
      void maybeFinalizeTurnWhenSettled(threadId).catch((error) => {
        console.error(`turn settlement check failed for ${threadId}: ${formatErrorMessage(error)}`);
      });
    }, turnCompletionQuietMs);
    if (typeof tracker.turnFinalizeTimer?.unref === "function") {
      tracker.turnFinalizeTimer.unref();
    }
  }

  async function maybeFinalizeTurnWhenSettled(threadId) {
    const tracker = activeTurns.get(threadId);
    if (!tracker || tracker.finalizing || tracker.completed) {
      return;
    }
    const now = Date.now();
    const lastActivityAt = Number.isFinite(tracker.lastTurnActivityAt) ? tracker.lastTurnActivityAt : now;
    const quietForMs = now - lastActivityAt;
    const activeItemCount = tracker.activeLifecycleItemKeys?.size ?? 0;
    const requestedAt = Number.isFinite(tracker.turnCompletionRequestedAt) ? tracker.turnCompletionRequestedAt : now;
    const waitedMs = now - requestedAt;
    const lastReconnectAt = Number.isFinite(tracker.lastReconnectAt) ? tracker.lastReconnectAt : 0;
    const reconnectQuietForMs = lastReconnectAt > 0 ? now - lastReconnectAt : Infinity;
    const reconnectSettled = reconnectQuietForMs >= reconnectSettleQuietMs;

    if ((quietForMs < turnCompletionQuietMs || activeItemCount > 0 || !reconnectSettled) && waitedMs < turnCompletionMaxWaitMs) {
      debugLog("turn", "turn completion deferred until stream settles", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        quietForMs,
        activeItemCount,
        reconnectQuietForMs: Number.isFinite(reconnectQuietForMs) ? reconnectQuietForMs : null,
        reconnectSettled,
        waitedMs,
        quietWindowMs: turnCompletionQuietMs,
        reconnectQuietWindowMs: reconnectSettleQuietMs,
        maxWaitMs: turnCompletionMaxWaitMs
      });
      scheduleTurnFinalizeWhenSettled(threadId, tracker);
      return;
    }

    await finalizeTurn(threadId, null);
  }

  function markTurnReconnecting(tracker, line) {
    if (!tracker) {
      return;
    }
    transitionTurnPhase(tracker, TURN_PHASE.RECONNECTING);
    pushStatusLine(tracker, line);
    scheduleFlush(tracker);
  }

  async function ensureThinkingStage(tracker) {
    if (!tracker?.channel || !tracker?.statusMessageId || tracker?.hasToolCall) {
      clearThinkingTicker(tracker);
      return;
    }
    if (!tracker.thinkingStartedAt) {
      tracker.thinkingStartedAt = Date.now();
    }
    if (tracker.thinkingTicker) {
      return;
    }
    const tick = async () => {
      if (!tracker?.channel || !tracker?.statusMessageId || tracker?.hasToolCall) {
        clearThinkingTicker(tracker);
        return;
      }
      const startedAt = tracker.thinkingStartedAt || Date.now();
      const elapsed = formatDuration(Date.now() - startedAt);
      const payload = `⏳ Thinking... (${elapsed})`;
      pushStatusLine(tracker, payload);
      await editTrackerMessage(tracker, buildTrackerMessageContent(tracker));
    };
    void tick().catch((error) => {
      console.error(`thinking ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
    });
    tracker.thinkingTicker = setInterval(() => {
      void tick().catch((error) => {
        console.error(`thinking ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
      });
    }, 3000);
    if (typeof tracker.thinkingTicker?.unref === "function") {
      tracker.thinkingTicker.unref();
    }
  }

  async function ensureWorkingStage(tracker) {
    if (!tracker?.channel || tracker?.workingMessageId || (tracker?.hasToolCall && tracker?.workingTicker)) {
      return;
    }
    if (tracker.workingMessageCreatePromise) {
      await tracker.workingMessageCreatePromise;
      return;
    }
    tracker.hasToolCall = true;
    clearThinkingTicker(tracker);
    if (!tracker.firstToolCallAt) {
      tracker.firstToolCallAt = Date.now();
    }
    const createPromise = (async () => {
      const elapsed = formatDuration(Date.now() - tracker.firstToolCallAt);
      if (tracker.statusMessageId) {
        const payload = `👷 Working (${elapsed})`;
        pushStatusLine(tracker, payload);
        await editTrackerMessage(tracker, buildTrackerMessageContent(tracker));
        startWorkingTicker(tracker);
        return;
      }
      const message = await safeSendToChannel(tracker.channel, `👷 Working (${elapsed})`);
      if (!message) {
        return;
      }
      tracker.workingMessage = message;
      tracker.workingMessageId = message.id;
      startWorkingTicker(tracker);
    })();
    tracker.workingMessageCreatePromise = createPromise;
    try {
      await createPromise;
    } finally {
      tracker.workingMessageCreatePromise = null;
    }
  }

  function startWorkingTicker(tracker) {
    if (!tracker?.channel) {
      return;
    }
    clearWorkingTicker(tracker);
    const tick = async () => {
      if (!tracker?.channel) {
        return;
      }
      const firstToolAt = tracker.firstToolCallAt || Date.now();
      const elapsed = formatDuration(Date.now() - firstToolAt);
      const payload = `👷 Working (${elapsed})`;
      if (tracker.statusMessageId) {
        pushStatusLine(tracker, payload);
        await editTrackerMessage(tracker, buildTrackerMessageContent(tracker));
        tracker.workingLastRefreshAt = Date.now();
        debugLog("status", "working ticker refreshed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          discordMessageId: tracker.statusMessageId ?? null,
          workingMessageId: tracker.workingMessageId ?? null,
          elapsed,
          payload
        });
        return;
      }
      if (!tracker.workingMessageId) {
        return;
      }
      try {
        const edited = await tracker.channel.messages.edit(tracker.workingMessageId, payload);
        if (edited) {
          tracker.workingMessage = edited;
        }
        tracker.workingLastRefreshAt = Date.now();
        debugLog("status", "working ticker refreshed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          discordMessageId: tracker.statusMessageId ?? null,
          workingMessageId: tracker.workingMessageId ?? null,
          elapsed,
          payload
        });
      } catch (error) {
        debugLog("status", "working ticker update failed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          discordMessageId: tracker.statusMessageId ?? null,
          workingMessageId: tracker.workingMessageId ?? null,
          error: truncateStatusText(String(error?.message ?? error ?? "unknown"), 220)
        });
      }
    };

    void tick().catch((error) => {
      console.error(`working ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
    });
    tracker.workingTicker = setInterval(() => {
      void tick().catch((error) => {
        console.error(`working ticker failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
      });
    }, 3000);
    if (typeof tracker.workingTicker?.unref === "function") {
      tracker.workingTicker.unref();
    }
  }

  async function finalizeUxFlowStages(tracker) {
    clearWorkingTicker(tracker);
    if (tracker.hasToolCall && tracker.firstToolCallAt) {
      tracker.lastToolCompletedAt = Date.now();
      const elapsed = formatDuration(tracker.lastToolCompletedAt - tracker.firstToolCallAt);
      if (tracker.statusMessageId) {
        pushStatusLine(tracker, `✅ Work complete (${elapsed})`);
        await editTrackerMessage(tracker, buildTrackerMessageContent(tracker));
        return;
      }
      await safeSendToChannel(tracker.channel, `✅ Work complete (${elapsed})`);
    }
  }

  function clearWorkingTicker(tracker) {
    if (!tracker?.workingTicker) {
      return;
    }
    clearInterval(tracker.workingTicker);
    tracker.workingTicker = null;
  }

  function clearThinkingTicker(tracker) {
    if (!tracker?.thinkingTicker) {
      return;
    }
    clearInterval(tracker.thinkingTicker);
    tracker.thinkingTicker = null;
  }

  function appendTrackerText(tracker, text, { fromDelta }) {
    if (!text) {
      return;
    }
    const nextText = fromDelta ? normalizeStreamingSnapshotText(text) : text;
    const appendText = fromDelta ? extractStreamingAppend(tracker.fullText, nextText) : nextText;
    if (!appendText) {
      return;
    }
    tracker.fullText += appendText;
    if (fromDelta) {
      tracker.seenDelta = true;
      ensureSegmentedStreamState(tracker);
      tracker.segmentedStreamBuffer += appendText;
    }
    if (canStreamTrackerOutput(tracker)) {
      scheduleFlush(tracker);
    }
  }

  function pushStatusLine(tracker, line) {
    if (!tracker || typeof line !== "string") {
      return;
    }
    const normalized = line.trim();
    if (!normalized) {
      return;
    }
    if (tracker.currentStatusLine === normalized) {
      return;
    }
    tracker.currentStatusLine = normalized;
  }

  function buildTrackerMessageContent(tracker) {
    if (canInlineStreamTrackerOutput(tracker) && !isDiscordTracker(tracker)) {
      const firstChunk = String(splitTextForMessages(tracker.fullText, messageChunkLimitForTracker(tracker))[0] ?? "").trim();
      if (firstChunk) {
        return firstChunk;
      }
    }
    return truncateForDiscordMessage(tracker.currentStatusLine || "⏳ Thinking...", messageChunkLimitForTracker(tracker));
  }

  async function sendFinalSummary(tracker, summaryTextForDiscord) {
    const summaryChunks = splitTextForMessages(summaryTextForDiscord, messageChunkLimitForTracker(tracker));
    if (summaryChunks.length === 0) {
      return;
    }
    if (canSegmentStreamTrackerOutput(tracker)) {
      await sendFeishuFinalSummary(tracker, summaryTextForDiscord);
      return;
    }
    if (!canInlineStreamTrackerOutput(tracker)) {
      await sendChunkedToChannel(tracker.channel, summaryTextForDiscord, messageChunkLimitForTracker(tracker));
      return;
    }

    await editTrackerMessage(tracker, summaryChunks[0]);
    const remaining = summaryChunks.slice(1).join("");
    if (remaining) {
      await sendChunkedToChannel(tracker.channel, remaining, messageChunkLimitForTracker(tracker));
    }
  }

  function canStreamTrackerOutput(tracker) {
    if (disableStreamingOutput) {
      return false;
    }
    if (!tracker?.channel) {
      return false;
    }
    if (tracker.seenDelta !== true) {
      return false;
    }
    return typeof tracker.fullText === "string" && tracker.fullText.trim().length > 0;
  }

  function canInlineStreamTrackerOutput(tracker) {
    if (isDiscordTracker(tracker)) {
      return false;
    }
    return canStreamTrackerOutput(tracker) && !canSegmentStreamTrackerOutput(tracker) && Boolean(tracker?.statusMessageId);
  }

  function canSegmentStreamTrackerOutput(tracker) {
    return canStreamTrackerOutput(tracker) && feishuSegmentedStreaming && isFeishuTracker(tracker);
  }

  function isFeishuTracker(tracker) {
    const platform = String(tracker?.channel?.platform ?? tracker?.statusMessage?.platform ?? "")
      .trim()
      .toLowerCase();
    return platform === "feishu";
  }

  function isDiscordTracker(tracker) {
    const platform = String(tracker?.channel?.platform ?? tracker?.statusMessage?.platform ?? "")
      .trim()
      .toLowerCase();
    return !platform || platform === "discord";
  }

  async function flushDiscordStreamSegments(tracker, { force }) {
    ensureSegmentedStreamState(tracker);
    const pendingText = String(tracker.segmentedStreamBuffer ?? "");
    if (!pendingText) {
      return;
    }

    const readySegments = collectDiscordReadySegments(pendingText, {
      force,
      limit: messageChunkLimitForTracker(tracker),
      minChars: streamTailMinCharsForTracker(tracker)
    });
    if (readySegments.length === 0) {
      return;
    }

    let consumedLength = 0;
    for (const segment of readySegments) {
      const payload = String(segment?.text ?? "");
      if (!payload.trim()) {
        consumedLength = Math.max(consumedLength, Number(segment?.endOffset) || 0);
        continue;
      }
      const normalizedPayload = payload.trim();
      if (hasSeenDiscordSegment(tracker, normalizedPayload)) {
        consumedLength = Math.max(consumedLength, Number(segment?.endOffset) || 0);
        continue;
      }
      const sentMessage = await safeSendToChannel(tracker.channel, payload.trimEnd());
      if (!sentMessage) {
        debugLog("render", "discord stream segment deferred", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          segmentLength: payload.length,
          streamedTextOffset: tracker.streamedTextOffset
        });
        break;
      }
      noteSeenDiscordSegment(tracker, normalizedPayload);
      consumedLength = Math.max(consumedLength, Number(segment?.endOffset) || 0);
      tracker.streamedSummaryText += payload;
      tracker.streamedTextOffset = tracker.streamedSummaryText.length;
      debugLog("render", "sent discord stream segment", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        segmentLength: payload.length,
        streamedTextOffset: tracker.streamedTextOffset
      });
    }
    if (consumedLength > 0) {
      tracker.segmentedStreamBuffer = pendingText.slice(consumedLength);
    }
  }

  async function flushFeishuStreamSegments(tracker, { force }) {
    ensureSegmentedStreamState(tracker);
    const pendingText = String(tracker.segmentedStreamBuffer ?? "");
    if (!pendingText) {
      return;
    }

    const chunks = splitTextForMessages(pendingText, messageChunkLimitForTracker(tracker)).filter((chunk) => typeof chunk === "string" && chunk.length > 0);
    if (chunks.length === 0) {
      return;
    }

    const minChars = streamTailMinCharsForTracker(tracker);
    if (!force) {
      const trimmed = pendingText.replace(/\s+$/u, "");
      if (trimmed.length < minChars && !/(?:\r?\n|[。！？.!?])$/u.test(trimmed)) {
        return;
      }
    }

    const readyChunks = [];
    if (force) {
      readyChunks.push(...chunks);
    } else if (chunks.length === 1) {
      if (shouldSendStreamTail(chunks[0], minChars)) {
        readyChunks.push(chunks[0]);
      }
    } else {
      readyChunks.push(...chunks.slice(0, -1));
      const tail = chunks[chunks.length - 1];
      if (shouldSendStreamTail(tail, minChars)) {
        readyChunks.push(tail);
      }
    }

    let consumedLength = 0;
    for (const chunk of readyChunks) {
      const payload = String(chunk ?? "");
      if (!payload.trim()) {
        consumedLength += payload.length;
        continue;
      }
      const sentMessage = await safeSendToChannel(tracker.channel, payload);
      if (!sentMessage) {
        debugLog("render", "stream segment deferred", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          segmentLength: payload.length,
          streamedTextOffset: tracker.streamedTextOffset
        });
        break;
      }
      consumedLength += payload.length;
      tracker.streamedSummaryText += payload;
      tracker.streamedTextOffset = tracker.streamedSummaryText.length;
      debugLog("render", "sent stream segment", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        segmentLength: payload.length,
        streamedTextOffset: tracker.streamedTextOffset
      });
    }
    if (consumedLength > 0) {
      tracker.segmentedStreamBuffer = pendingText.slice(consumedLength);
    }
  }

  function shouldSendStreamTail(text, minChars) {
    const normalized = String(text ?? "").replace(/\s+$/u, "");
    if (!normalized.trim()) {
      return false;
    }
    if (normalized.length >= minChars) {
      return true;
    }
    return /(?:\r?\n|[。！？.!?])$/u.test(normalized);
  }

  function streamTailMinCharsForTracker(tracker) {
    return isFeishuTracker(tracker) ? feishuStreamMinChars : discordStreamMinChars;
  }

  function ensureSegmentedStreamState(tracker) {
    if (!tracker || typeof tracker !== "object") {
      return;
    }
    if (!Number.isFinite(tracker.streamedTextOffset) || tracker.streamedTextOffset < 0) {
      tracker.streamedTextOffset = 0;
    }
    if (typeof tracker.streamedSummaryText !== "string") {
      tracker.streamedSummaryText = "";
    }
    if (typeof tracker.segmentedStreamBuffer !== "string") {
      tracker.segmentedStreamBuffer = "";
    }
    if (!(tracker.sentDiscordSegmentKeys instanceof Set)) {
      tracker.sentDiscordSegmentKeys = new Set();
    }
  }

  async function sendFeishuFinalSummary(tracker, summaryTextForDiscord) {
    ensureSegmentedStreamState(tracker);
    const normalizedSummary = normalizeFinalSummaryText(String(summaryTextForDiscord ?? ""));
    let remaining = normalizedSummary;
    if (tracker.streamedSummaryText && normalizedSummary.startsWith(tracker.streamedSummaryText)) {
      remaining = normalizedSummary.slice(tracker.streamedSummaryText.length);
    } else if (tracker.streamedTextOffset > 0) {
      remaining = normalizedSummary.slice(Math.min(normalizedSummary.length, tracker.streamedTextOffset));
    }
    if (!remaining.trim()) {
      tracker.streamedSummaryText = normalizedSummary;
      tracker.streamedTextOffset = normalizedSummary.length;
      tracker.segmentedStreamBuffer = "";
      return;
    }
    await sendChunkedToChannel(tracker.channel, remaining, messageChunkLimitForTracker(tracker));
    tracker.streamedSummaryText = normalizedSummary;
    tracker.streamedTextOffset = normalizedSummary.length;
    tracker.segmentedStreamBuffer = "";
  }

  async function sendDiscordFinalSummary(tracker, summaryTextForDiscord) {
    ensureSegmentedStreamState(tracker);
    await flushDiscordStreamSegments(tracker, { force: true });
    const normalizedSummary = String(summaryTextForDiscord ?? "");
    let remaining = normalizedSummary;
    if (tracker.streamedSummaryText && normalizedSummary.startsWith(tracker.streamedSummaryText)) {
      remaining = normalizedSummary.slice(tracker.streamedSummaryText.length);
    } else if (tracker.streamedTextOffset > 0) {
      remaining = normalizedSummary.slice(Math.min(normalizedSummary.length, tracker.streamedTextOffset));
    }
    if (remaining.trim()) {
      const remainingSegments = collectDiscordReadySegments(remaining, {
        force: true,
        limit: messageChunkLimitForTracker(tracker),
        minChars: streamTailMinCharsForTracker(tracker)
      });
      for (const segment of remainingSegments) {
        const payload = String(segment?.text ?? "").trim();
        if (!payload || hasSeenDiscordSegment(tracker, payload)) {
          continue;
        }
        await sendChunkedToChannel(tracker.channel, payload, messageChunkLimitForTracker(tracker));
        noteSeenDiscordSegment(tracker, payload);
      }
    }
    tracker.streamedSummaryText = normalizedSummary;
    tracker.streamedTextOffset = normalizedSummary.length;
    tracker.segmentedStreamBuffer = "";
  }

  function messageChunkLimitForTracker(tracker) {
    return isFeishuTracker(tracker) ? feishuMaxMessageLength : discordMaxMessageLength;
  }

  function summarizeForDebug(text, max = 180) {
    if (typeof text !== "string" || !text) {
      return "";
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 3))}...`;
  }

  async function editTrackerMessage(tracker, content) {
    if (!tracker?.channel || !content) {
      return;
    }
    if (tracker.lastRenderedContent === content) {
      return;
    }
    const payload = truncateForDiscordMessage(content, discordMaxMessageLength);
    try {
      if (tracker.statusMessage) {
        await tracker.statusMessage.edit(payload);
        tracker.lastRenderedContent = payload;
        debugLog("render", "edited status message", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          messageId: tracker.statusMessageId
        });
        return;
      }
    } catch (error) {
      debugLog("render", "direct edit failed", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        messageId: tracker.statusMessageId,
        error: String(error?.message ?? error)
      });
    }

    if (tracker.statusMessageId && tracker.channel?.isTextBased?.()) {
      try {
        const fetched = await tracker.channel.messages.fetch(tracker.statusMessageId);
        if (fetched) {
          await fetched.edit(payload);
          tracker.statusMessage = fetched;
          tracker.lastRenderedContent = payload;
          debugLog("render", "fetched and edited status message", {
            threadId: tracker.threadId,
            turnId: tracker.threadId,
            messageId: tracker.statusMessageId
          });
          return;
        }
      } catch (error) {
        debugLog("render", "fetch/edit fallback failed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          messageId: tracker.statusMessageId,
          error: String(error?.message ?? error)
        });
      }
    }

    const replacement = await safeSendToChannel(tracker.channel, payload);
    if (replacement) {
      const previousDiscordMessageId = tracker.statusMessageId ?? null;
      tracker.statusMessage = replacement;
      tracker.statusMessageId = replacement.id;
      tracker.lastRenderedContent = payload;
      debugLog("render", "sent replacement status message", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        previousDiscordMessageId,
        messageId: replacement.id
      });
    }
  }

  function isToolCallItemType(itemType) {
    return (
      itemType === "toolCall" ||
      itemType === "mcpToolCall" ||
      itemType === "commandExecution" ||
      itemType === "webSearch"
    );
  }

  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  return {
    handleNotification,
    finalizeTurn,
    onTurnReconnectPending
  };
}

function splitTextForMessagesFallback(text, limit = 1900) {
  const normalized = typeof text === "string" ? text : String(text ?? "");
  if (!normalized) {
    return [];
  }
  if (normalized.length <= limit) {
    return [normalized];
  }
  const chunks = [];
  for (let offset = 0; offset < normalized.length; offset += limit) {
    chunks.push(normalized.slice(offset, offset + limit));
  }
  return chunks;
}

function collectDiscordReadySegments(text, { force, limit, minChars }) {
  const source = typeof text === "string" ? text : String(text ?? "");
  if (!source) {
    return [];
  }
  if (force) {
    const chunks = splitTextForMessagesFallback(source, limit);
    let offset = 0;
    return chunks.map((chunk) => {
      offset += chunk.length;
      return { text: chunk, endOffset: offset };
    });
  }

  const ready = [];
  let offset = 0;
  while (offset < source.length) {
    const remaining = source.slice(offset);
    const boundary = findDiscordStreamBoundary(remaining, { limit, minChars });
    if (boundary <= 0) {
      break;
    }
    ready.push({
      text: remaining.slice(0, boundary),
      endOffset: offset + boundary
    });
    offset += boundary;
  }
  return ready;
}

function findDiscordStreamBoundary(text, { limit, minChars }) {
  const source = typeof text === "string" ? text : String(text ?? "");
  if (!source) {
    return 0;
  }
  const slice = source.slice(0, limit);
  const preferredBoundary = Math.max(
    findLastMatchEnd(slice, /\n{2,}/gu),
    findLastMatchEnd(slice, /\n/gu),
    findLastMatchEnd(slice, /(?:[。！？.!?]+["'”’」』》】）]?(?:\s+|$))/gu)
  );
  if (preferredBoundary >= minChars) {
    return preferredBoundary;
  }
  if (slice.length < limit) {
    return 0;
  }
  const whitespaceBoundary = slice.lastIndexOf(" ");
  if (whitespaceBoundary >= minChars) {
    return whitespaceBoundary + 1;
  }
  return limit;
}

function findLastMatchEnd(text, pattern) {
  if (typeof text !== "string" || !text) {
    return 0;
  }
  let lastEnd = 0;
  for (const match of text.matchAll(pattern)) {
    const matchText = String(match[0] ?? "");
    const start = Number(match.index ?? -1);
    if (start < 0 || !matchText) {
      continue;
    }
    lastEnd = start + matchText.length;
  }
  return lastEnd;
}

function hasSeenDiscordSegment(tracker, text) {
  if (!tracker || !(tracker.sentDiscordSegmentKeys instanceof Set)) {
    return false;
  }
  const key = normalizeDiscordSegmentKey(text);
  if (!key) {
    return false;
  }
  return tracker.sentDiscordSegmentKeys.has(key);
}

function noteSeenDiscordSegment(tracker, text) {
  if (!tracker) {
    return;
  }
  if (!(tracker.sentDiscordSegmentKeys instanceof Set)) {
    tracker.sentDiscordSegmentKeys = new Set();
  }
  const key = normalizeDiscordSegmentKey(text);
  if (!key) {
    return;
  }
  tracker.sentDiscordSegmentKeys.add(key);
}

function normalizeDiscordSegmentKey(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text.trim();
}

function settleTracker(tracker, action, value) {
  if (!tracker || tracker.promiseSettled) {
    return;
  }
  tracker.promiseSettled = true;
  const settle = action === "reject" ? tracker.reject : tracker.resolve;
  if (typeof settle !== "function") {
    return;
  }
  try {
    settle(value);
  } catch (error) {
    console.error(`turn ${action} callback failed for ${tracker?.threadId ?? "unknown"}: ${formatErrorMessage(error)}`);
  }
}

function toError(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(formatErrorMessage(error));
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}
