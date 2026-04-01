import { createBootstrapService } from "../channels/bootstrapService.js";
import { isGeneralChannel } from "../channels/context.js";
import { createCommandRouter } from "../commands/router.js";

export function buildCommandRuntime(deps) {
  const {
    bot,
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
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
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
  } = deps;

  const bootstrapService =
    String(bot?.platform ?? "").trim().toLowerCase() === "discord" && discord
      ? createBootstrapService({
          bot,
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
        })
      : null;
  const bootstrapChannelMappings = bootstrapService?.bootstrapChannelMappings ?? null;
  const makeChannelName = bootstrapService?.makeChannelName ?? fallbackMakeChannelName;

  const commandRouter = createCommandRouter({
    bot,
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
    setChannelSetups,
    bootstrapManagedRoutes: bootstrapChannelMappings,
    getPlatformRegistry,
    getOutputBufferSnapshot: (tracker, lineCount) => {
      if (!tracker?.outputBuffer || tracker.outputBuffer.length === 0) {
        return [];
      }
      const start = Math.max(0, tracker.outputBuffer.length - lineCount);
      return tracker.outputBuffer.slice(start);
    }
  });
  const {
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand
  } = commandRouter;

  return {
    bootstrapChannelMappings,
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand
  };
}

function fallbackMakeChannelName(input) {
  const cleaned = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return (cleaned || "repo").slice(0, 100);
}
