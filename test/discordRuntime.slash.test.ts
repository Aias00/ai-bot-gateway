import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { createDiscordRuntime } from "../src/app/discordRuntime.js";

function createInteraction(
  commandName: string,
  options: Record<string, unknown> = {},
  extras: { subcommand?: string; isAutocomplete?: boolean; focused?: { name: string; value: string } } = {}
) {
  const replies: string[] = [];
  const autocompleteChoices: Array<{ name: string; value: string }> = [];
  const channel = {
    id: "channel-1",
    name: "repo-one",
    type: ChannelType.GuildText
  };
  const statusMessage = {
    id: "msg-1",
    channel,
    channelId: channel.id,
    async edit(content: string) {
      replies.push(content);
      return this;
    }
  };

  return {
    replies,
    autocompleteChoices,
    interaction: {
      id: `ix-${commandName}`,
      user: { id: "user-1" },
      channel,
      channelId: channel.id,
      commandName,
      customId: "",
      deferred: false,
      replied: false,
      options: {
        getString(name: string) {
          const value = options[name];
          return typeof value === "string" ? value : null;
        },
        getBoolean(name: string) {
          const value = options[name];
          return typeof value === "boolean" ? value : null;
        },
        getSubcommand(required?: boolean) {
          if (extras.subcommand) {
            return extras.subcommand;
          }
          if (required === false) {
            return null;
          }
          throw new Error("subcommand not set");
        },
        getFocused(withMeta?: boolean) {
          if (!extras.focused) {
            return withMeta ? { name: "", value: "" } : "";
          }
          return withMeta ? extras.focused : extras.focused.value;
        }
      },
      isButton() {
        return false;
      },
      isAutocomplete() {
        return extras.isAutocomplete === true;
      },
      isChatInputCommand() {
        return extras.isAutocomplete !== true;
      },
      async deferReply() {
        this.deferred = true;
      },
      async editReply(content: { content?: string } | string) {
        this.replied = true;
        const text = typeof content === "string" ? content : String(content?.content ?? "");
        replies.push(text);
        return statusMessage;
      },
      async reply(content: { content?: string } | string) {
        this.replied = true;
        const text = typeof content === "string" ? content : String(content?.content ?? "");
        replies.push(text);
        return statusMessage;
      },
      async followUp(content: { content?: string } | string) {
        const text = typeof content === "string" ? content : String(content?.content ?? "");
        replies.push(text);
        return statusMessage;
      },
      async respond(choices: Array<{ name: string; value: string }>) {
        autocompleteChoices.push(...choices);
      }
    }
  };
}

function createRuntime(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ type: string; payload?: unknown }> = [];
  const runtime = createDiscordRuntime({
    ChannelType,
    discord: { user: { id: "bot-1" } },
    config: {
      allowedUserIds: ["user-1"],
      defaultModel: "gpt-5.3-codex",
      sandboxMode: "workspace-write"
    },
    resolveRepoContext: (message: { channelId: string }) => ({
      repoChannelId: message.channelId,
      setup: {
        cwd: "/tmp/repo-one",
        model: "gpt-5.3-codex",
        mode: "repo",
        sandboxMode: "workspace-write",
        allowFileWrites: true
      }
    }),
    generalChannelId: "general-1",
    generalChannelName: "general",
    generalChannelCwd: "/tmp/general",
    getChannelSetups: () => ({
      "channel-1": {
        cwd: "/tmp/repo-one",
        model: "gpt-5.3-codex"
      }
    }),
    projectsCategoryName: "codex-projects",
    managedChannelTopicPrefix: "codex-cwd:",
    runManagedRouteCommand: async (message: { reply: (text: string) => Promise<unknown> }, options?: Record<string, unknown>) => {
      calls.push({ type: "bootstrap", payload: options ?? null });
      await message.reply("Resynced channels. discovered=3, created=1, moved=0, pruned=0, mapped=1");
    },
    shouldHandleAsSelfRestartRequest: () => false,
    requestSelfRestartFromDiscord: async () => {},
    collectImageAttachments: () => [],
    buildTurnInputFromMessage: async () => [],
    enqueuePrompt: () => {},
    getHelpText: () => "help text",
    isCommandSupportedForPlatform: () => true,
    handleCommand: async (message: { reply: (text: string) => Promise<unknown> }, content: string, context: unknown) => {
      calls.push({ type: "command", payload: { content, context } });
      await message.reply(`handled ${content}`);
    },
    handleInitRepoCommand: async (message: { reply: (text: string) => Promise<unknown> }, rest: string) => {
      calls.push({ type: "initrepo", payload: rest });
      await message.reply(`initrepo ${rest}`);
    },
    buildCommandTextFromInteraction: (interaction: {
      commandName: string;
      options: {
        getString: (name: string) => string | null;
        getBoolean: (name: string) => boolean | null;
        getSubcommand?: (required?: boolean) => string | null;
      };
    }) => {
      const subcommand = interaction.options.getSubcommand?.(false) ?? "";
      switch (interaction.commandName) {
        case "status":
          return "!status";
        case "runtime":
          if (subcommand === "status") return "!status";
          if (subcommand === "restart") return `!restart ${interaction.options.getString("reason") ?? ""}`.trim();
          if (subcommand === "interrupt") return "!interrupt";
          if (subcommand === "where") return "!where";
          if (subcommand === "help") return "!help";
          return "";
        case "model":
          if (subcommand === "list") return "!models";
          if (subcommand === "set") return `!setmodel ${interaction.options.getString("model") ?? ""}`.trim();
          if (subcommand === "clear") return "!clearmodel";
          return "";
        case "agent":
          if (subcommand === "list") return "!agents";
          if (subcommand === "set") return `!setagent ${interaction.options.getString("agent") ?? ""}`.trim();
          if (subcommand === "clear") return "!clearagent";
          return "";
        case "ops":
          if (subcommand === "resync") return "!resync";
          if (subcommand === "rebuild") return "!rebuild";
          return "";
        case "repo":
          if (subcommand === "bind" || subcommand === "rebind" || subcommand === "setpath") {
            return `!${subcommand === "setpath" ? "setpath" : subcommand} ${interaction.options.getString("path") ?? ""}`.trim();
          }
          if (subcommand === "mkchannel" || subcommand === "mkrepo") {
            return `!${subcommand} ${interaction.options.getString("name") ?? ""}`.trim();
          }
          if (subcommand === "mkbind") {
            return `!mkbind ${interaction.options.getString("name") ?? ""} ${interaction.options.getString("path") ?? ""}`.trim();
          }
          if (subcommand === "init") {
            return interaction.options.getBoolean("force") ? "!initrepo force" : "!initrepo";
          }
          if (subcommand === "unbind") return "!unbind";
          return "";
        case "approval":
          return `!${subcommand} ${interaction.options.getString("id") ?? ""}`.trim();
        default:
          return `!${interaction.commandName} ${interaction.options.getString("reason") ?? interaction.options.getString("model") ?? interaction.options.getString("agent") ?? ""}`.trim();
      }
    },
    handleSetPathCommand: async (message: { reply: (text: string) => Promise<unknown> }, rest: string) => {
      calls.push({ type: "setpath", payload: rest });
      await message.reply(`setpath ${rest}`);
    },
    handleMakeChannelCommand: async (
      message: { reply: (text: string) => Promise<unknown> },
      rest: string,
      options?: Record<string, unknown>
    ) => {
      calls.push({ type: "make-channel", payload: { rest, options: options ?? null } });
      await message.reply(`make-channel ${rest}`);
    },
    handleBindCommand: async (
      message: { reply: (text: string) => Promise<unknown> },
      rest: string,
      options?: Record<string, unknown>
    ) => {
      calls.push({ type: "bind", payload: { rest, options: options ?? null } });
      await message.reply(`bind ${rest}`);
    },
    handleUnbindCommand: async (message: { reply: (text: string) => Promise<unknown> }) => {
      calls.push({ type: "unbind", payload: null });
      await message.reply("unbind");
    },
    buildAutocompleteChoices: ({ interaction }: { interaction: { commandName: string; options: { getSubcommand?: (required?: boolean) => string | null } } }) => {
      const subcommand = interaction.options.getSubcommand?.(false);
      if (interaction.commandName === "model" && subcommand === "set") {
        return [
          { name: "gpt-5.3-codex (default)", value: "gpt-5.3-codex" },
          { name: "gpt-5.4", value: "gpt-5.4" }
        ];
      }
      if (interaction.commandName === "agent" && subcommand === "set") {
        return [{ name: "builder (enabled, gpt-5.3-codex)", value: "builder" }];
      }
      return [];
    },
    registerSlashCommands: async () => ({ scope: "guild", guildId: "guild-1", count: 26 }),
    parseApprovalButtonCustomId: () => null,
    approvalButtonPrefix: "approval",
    pendingApprovals: new Map(),
    applyApprovalDecision: async () => ({ ok: true }),
    safeReply: async (message: { reply: (content: string) => Promise<unknown> }, content: string) => await message.reply(content),
    MessageFlags: { Ephemeral: 64 },
    ...overrides
  });

  return { runtime, calls };
}

describe("discord runtime slash commands", () => {
  test("routes /status through the existing command handler with a deferred reply", async () => {
    const { runtime, calls } = createRuntime();
    const { interaction, replies } = createInteraction("status");

    await runtime.handleInteraction(interaction);

    expect(interaction.deferred).toBe(true);
    expect(calls).toEqual([
      {
        type: "command",
        payload: {
          content: "!status",
          context: {
            repoChannelId: "channel-1",
            setup: {
              cwd: "/tmp/repo-one",
              model: "gpt-5.3-codex",
              mode: "repo",
              sandboxMode: "workspace-write",
              allowFileWrites: true
            }
          }
        }
      }
    ]);
    expect(replies).toEqual(["handled !status"]);
  });

  test("handles /resync before repo context lookup", async () => {
    const { runtime, calls } = createRuntime({
      resolveRepoContext: () => null
    });
    const { interaction } = createInteraction("ops", {}, { subcommand: "resync" });

    await runtime.handleInteraction(interaction);

    expect(calls).toEqual([{ type: "bootstrap", payload: { forceRebuild: false } }]);
  });

  test("handles /bind before repo context lookup", async () => {
    const { runtime, calls } = createRuntime({
      resolveRepoContext: () => null
    });
    const { interaction, replies } = createInteraction("repo", { path: "/tmp/repo-two" }, { subcommand: "bind" });

    await runtime.handleInteraction(interaction);

    expect(calls).toEqual([{ type: "bind", payload: { rest: "/tmp/repo-two", options: null } }]);
    expect(replies).toEqual(["bind /tmp/repo-two"]);
  });

  test("handles /mkrepo without requiring existing repo context", async () => {
    const { runtime, calls } = createRuntime({
      resolveRepoContext: () => null
    });
    const { interaction, replies } = createInteraction("repo", { name: "repo-two" }, { subcommand: "mkrepo" });

    await runtime.handleInteraction(interaction);

    expect(calls).toEqual([{ type: "make-channel", payload: { rest: "repo-two", options: { initRepo: true } } }]);
    expect(replies).toEqual(["make-channel repo-two"]);
  });

  test("handles /model list without requiring existing repo context", async () => {
    const { runtime, calls } = createRuntime({
      resolveRepoContext: () => null
    });
    const { interaction, replies } = createInteraction("model", {}, { subcommand: "list" });

    await runtime.handleInteraction(interaction);

    expect(calls).toEqual([
      {
        type: "command",
        payload: {
          content: "!models",
          context: null
        }
      }
    ]);
    expect(replies).toEqual(["handled !models"]);
  });

  test("responds to model autocomplete requests", async () => {
    const { runtime } = createRuntime();
    const { interaction, autocompleteChoices } = createInteraction(
      "model",
      {},
      { subcommand: "set", isAutocomplete: true, focused: { name: "model", value: "gpt" } }
    );

    await runtime.handleInteraction(interaction);

    expect(autocompleteChoices).toEqual([
      { name: "gpt-5.3-codex (default)", value: "gpt-5.3-codex" },
      { name: "gpt-5.4", value: "gpt-5.4" }
    ]);
  });

  test("responds to agent autocomplete requests", async () => {
    const { runtime } = createRuntime();
    const { interaction, autocompleteChoices } = createInteraction(
      "agent",
      {},
      { subcommand: "set", isAutocomplete: true, focused: { name: "agent", value: "bui" } }
    );

    await runtime.handleInteraction(interaction);

    expect(autocompleteChoices).toEqual([{ name: "builder (enabled, gpt-5.3-codex)", value: "builder" }]);
  });

  test("auto-initializes a new text channel created under the managed projects category", async () => {
    const { runtime, calls } = createRuntime();
    const replies: string[] = [];
    const channel = {
      id: "channel-2",
      name: "repo-two",
      type: ChannelType.GuildText,
      topic: "",
      parent: { name: "codex-projects" },
      async send(content: string) {
        replies.push(content);
        return this;
      }
    };

    await runtime.handleChannelCreate(channel);

    expect(calls).toEqual([{ type: "initrepo", payload: "" }]);
    expect(replies).toEqual(["initrepo "]);
  });

  test("skips auto-init for bridge-managed channels that already have a cwd topic", async () => {
    const { runtime, calls } = createRuntime();
    const replies: string[] = [];
    const channel = {
      id: "channel-2",
      name: "repo-two",
      type: ChannelType.GuildText,
      topic: "codex-cwd:/tmp/repo-two",
      parent: { name: "codex-projects" },
      async send(content: string) {
        replies.push(content);
        return this;
      }
    };

    await runtime.handleChannelCreate(channel);

    expect(calls).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("does not auto-init channels outside the managed projects category", async () => {
    const { runtime, calls } = createRuntime();
    const replies: string[] = [];
    const channel = {
      id: "channel-2",
      name: "repo-two",
      type: ChannelType.GuildText,
      topic: "",
      parent: { name: "other-category" },
      async send(content: string) {
        replies.push(content);
        return this;
      }
    };

    await runtime.handleChannelCreate(channel);

    expect(calls).toEqual([]);
    expect(replies).toEqual([]);
  });

  test("treats unrecognized bang-prefixed text as a prompt instead of a command", async () => {
    const enqueued: Array<{ repoChannelId: string; promptText: string }> = [];
    const { runtime, calls } = createRuntime({
      buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
      enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
        enqueued.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
      }
    });

    await runtime.handleMessage({
      author: { id: "user-1", bot: false },
      content: "!Volumes/data 1/ rename this path",
      channelId: "channel-1",
      channel: {
        id: "channel-1",
        name: "repo-one",
        type: ChannelType.GuildText
      }
    });

    expect(calls).toEqual([]);
    expect(enqueued).toEqual([
      {
        repoChannelId: "channel-1",
        promptText: "!Volumes/data 1/ rename this path"
      }
    ]);
  });

  test("treats plain text as a prompt instead of an unknown command", async () => {
    const enqueued: Array<{ repoChannelId: string; promptText: string }> = [];
    const { runtime, calls } = createRuntime({
      buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
      enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
        enqueued.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
      }
    });

    await runtime.handleMessage({
      author: { id: "user-1", bot: false },
      content: "咋了",
      channelId: "channel-1",
      channel: {
        id: "channel-1",
        name: "repo-one",
        type: ChannelType.GuildText
      }
    });

    expect(calls).toEqual([]);
    expect(enqueued).toEqual([
      {
        repoChannelId: "channel-1",
        promptText: "咋了"
      }
    ]);
  });

  test("blocks image prompts when current agent does not support image input", async () => {
    const replies: string[] = [];
    let buildCalled = 0;
    const enqueued: Array<unknown> = [];
    const { runtime } = createRuntime({
      config: {
        allowedUserIds: ["user-1"],
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        defaultAgent: "codex",
        agents: {
          codex: { capabilities: { supportsImageInput: true } },
          claude: { capabilities: { supportsImageInput: false } }
        }
      },
      resolveRepoContext: (message: { channelId: string }) => ({
        repoChannelId: message.channelId,
        setup: {
          cwd: "/tmp/repo-one",
          model: "gpt-5.3-codex",
          mode: "repo",
          sandboxMode: "workspace-write",
          allowFileWrites: true,
          agentId: "claude"
        }
      }),
      collectImageAttachments: () => [{ attachment: "https://example.com/a.png", contentType: "image/png" }],
      buildTurnInputFromMessage: async () => {
        buildCalled += 1;
        return [{ type: "text", text: "x" }];
      },
      enqueuePrompt: (_repoChannelId: string, job: unknown) => {
        enqueued.push(job);
      }
    });

    await runtime.handleMessage({
      author: { id: "user-1", bot: false },
      content: "",
      channelId: "channel-1",
      channel: {
        id: "channel-1",
        name: "repo-one",
        type: ChannelType.GuildText
      },
      async reply(content: string) {
        replies.push(content);
      }
    });

    expect(buildCalled).toBe(0);
    expect(enqueued).toEqual([]);
    expect(replies.at(-1)).toContain("Image input is not supported for `claude`");
  });
});
