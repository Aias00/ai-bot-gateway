import { SlashCommandBuilder } from "discord.js";
import { resolveDiscordGuild } from "../channels/resolveGuild.js";

export function buildSlashCommandPayloads() {
  return [
    new SlashCommandBuilder().setName("help").setDescription("Show bridge commands and usage notes"),
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Send a prompt into the current Codex thread")
      .addStringOption((option) =>
        option.setName("prompt").setDescription("Prompt text to send").setRequired(true)
      ),
    new SlashCommandBuilder().setName("status").setDescription("Show queue, thread, and sandbox status for this channel"),
    new SlashCommandBuilder().setName("where").setDescription("Show runtime paths and current channel binding"),
    new SlashCommandBuilder().setName("new").setDescription("Clear the current Codex thread binding for this channel"),
    new SlashCommandBuilder().setName("interrupt").setDescription("Interrupt the active turn in this channel"),
    new SlashCommandBuilder()
      .setName("runtime")
      .setDescription("Bridge runtime and restart actions")
      .addSubcommand((subcommand) =>
        subcommand.setName("help").setDescription("Show bridge commands and usage notes")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("status").setDescription("Show queue, thread, and sandbox status for this channel")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("where").setDescription("Show runtime paths and current channel binding")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("restart").setDescription("Request a host-managed bridge restart").addStringOption((option) =>
          option.setName("reason").setDescription("Optional reason recorded in the restart request").setRequired(false)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("interrupt").setDescription("Interrupt the active turn in this channel")
      ),
    new SlashCommandBuilder()
      .setName("repo")
      .setDescription("Repo binding and channel bootstrap commands")
      .addSubcommand((subcommand) =>
        subcommand.setName("bind").setDescription("Bind this channel to an existing repo path").addStringOption((option) =>
          option.setName("path").setDescription("Absolute repo path to bind").setRequired(true)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("rebind").setDescription("Rebind this channel to a different repo path").addStringOption((option) =>
          option.setName("path").setDescription("Absolute repo path to bind").setRequired(true)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("unbind").setDescription("Remove the repo binding from this channel")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("mkrepo").setDescription("Create a new text channel and bind a new project directory under WORKSPACE_ROOT").addStringOption((option) =>
          option.setName("name").setDescription("Channel and project name").setRequired(true)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("mkchannel").setDescription("Create a new text channel").addStringOption((option) =>
          option.setName("name").setDescription("Channel name").setRequired(true)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("mkbind").setDescription("Create a new text channel and bind it to an existing repo path")
          .addStringOption((option) =>
            option.setName("name").setDescription("Channel name").setRequired(true)
          )
          .addStringOption((option) =>
            option.setName("path").setDescription("Absolute repo path to bind").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("init").setDescription("Create or rebind a repo for this channel under WORKSPACE_ROOT").addBooleanOption((option) =>
          option.setName("force").setDescription("Rebind even if the path or channel is already in use").setRequired(false)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("setpath").setDescription("Bind this chat to an existing repo path").addStringOption((option) =>
          option.setName("path").setDescription("Absolute repo path to bind").setRequired(true)
        )
      ),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Model inspection and override commands")
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("Show current and configured model ids")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("set").setDescription("Set a model override for this channel").addStringOption((option) =>
          option.setName("model").setDescription("Model id").setRequired(true).setAutocomplete(true)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("clear").setDescription("Clear this channel's model override")
      ),
    new SlashCommandBuilder()
      .setName("agent")
      .setDescription("Agent inspection and override commands")
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("Show configured agents and current selection")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("set").setDescription("Set an agent override for this channel").addStringOption((option) =>
          option.setName("agent").setDescription("Agent id").setRequired(true).setAutocomplete(true)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("clear").setDescription("Clear this channel's agent override")
      ),
    new SlashCommandBuilder()
      .setName("approval")
      .setDescription("Approval workflow actions")
      .addSubcommand((subcommand) =>
        subcommand.setName("approve").setDescription("Approve the latest or specified pending request").addStringOption((option) =>
          option.setName("id").setDescription("Approval id shown in Discord").setRequired(false)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("decline").setDescription("Decline the latest or specified pending request").addStringOption((option) =>
          option.setName("id").setDescription("Approval id shown in Discord").setRequired(false)
        )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("cancel").setDescription("Cancel the latest or specified pending request").addStringOption((option) =>
          option.setName("id").setDescription("Approval id shown in Discord").setRequired(false)
        )
      ),
    new SlashCommandBuilder()
      .setName("ops")
      .setDescription("Managed route maintenance")
      .addSubcommand((subcommand) =>
        subcommand.setName("resync").setDescription("Rescan Codex projects and sync managed channels")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("rebuild").setDescription("Rebuild the managed channel layout from scratch")
      )
  ].map((command) => command.toJSON());
}

export function buildCommandTextFromInteraction(interaction) {
  const commandName = String(interaction.commandName ?? "").trim().toLowerCase();
  const subcommand = getInteractionSubcommand(interaction);
  const getString = (name) => normalizeOption(interaction.options?.getString?.(name));
  const getBoolean = (name) => interaction.options?.getBoolean?.(name) === true;

  switch (commandName) {
    case "help":
      return "!help";
    case "ask":
      return joinCommand("!ask", getString("prompt"));
    case "status":
      return "!status";
    case "where":
      return "!where";
    case "new":
      return "!new";
    case "interrupt":
      return "!interrupt";
    case "runtime":
      switch (subcommand) {
        case "help":
          return "!help";
        case "status":
          return "!status";
        case "where":
          return "!where";
        case "restart":
          return joinCommand("!restart", getString("reason"));
        case "interrupt":
          return "!interrupt";
        default:
          return "";
      }
    case "repo":
      switch (subcommand) {
        case "bind":
          return joinCommand("!bind", getString("path"));
        case "rebind":
          return joinCommand("!rebind", getString("path"));
        case "unbind":
          return "!unbind";
        case "mkrepo":
          return joinCommand("!mkrepo", getString("name"));
        case "mkchannel":
          return joinCommand("!mkchannel", getString("name"));
        case "mkbind":
          return joinCommand("!mkbind", [getString("name"), getString("path")].filter(Boolean).join(" "));
        case "init":
          return getBoolean("force") ? "!initrepo force" : "!initrepo";
        case "setpath":
          return joinCommand("!setpath", getString("path"));
        default:
          return "";
      }
    case "model":
      switch (subcommand) {
        case "list":
          return "!models";
        case "set":
          return joinCommand("!setmodel", getString("model"));
        case "clear":
          return "!clearmodel";
        default:
          return "";
      }
    case "agent":
      switch (subcommand) {
        case "list":
          return "!agents";
        case "set":
          return joinCommand("!setagent", getString("agent"));
        case "clear":
          return "!clearagent";
        default:
          return "";
      }
    case "approval":
      switch (subcommand) {
        case "approve":
          return joinCommand("!approve", getString("id"));
        case "decline":
          return joinCommand("!decline", getString("id"));
        case "cancel":
          return joinCommand("!cancel", getString("id"));
        default:
          return "";
      }
    case "ops":
      switch (subcommand) {
        case "resync":
          return "!resync";
        case "rebuild":
          return "!rebuild";
        default:
          return "";
      }
    default:
      return "";
  }
}

export function buildAutocompleteChoices({ interaction, config, getChannelSetups }) {
  const commandName = String(interaction?.commandName ?? "").trim().toLowerCase();
  const subcommand = getInteractionSubcommand(interaction);
  const focused = interaction?.options?.getFocused?.(true);
  const focusedName = String(focused?.name ?? "").trim().toLowerCase();
  const focusedValue = String(focused?.value ?? "").trim().toLowerCase();

  if (commandName === "model" && subcommand === "set" && focusedName === "model") {
    return collectModelChoices({ config, getChannelSetups, interactionChannelId: interaction?.channelId, query: focusedValue });
  }
  if (commandName === "agent" && subcommand === "set" && focusedName === "agent") {
    return collectAgentChoices({ config, query: focusedValue });
  }
  return [];
}

export async function syncSlashCommands({ discord, resolveGuild = resolveDiscordGuild, logger = console }) {
  const payloads = buildSlashCommandPayloads();
  const configuredGuildId = String(process.env.DISCORD_GUILD_ID ?? "").trim();

  try {
    const guild = await resolveGuild(discord);
    await guild.commands.set(payloads);
    return {
      scope: "guild",
      guildId: guild.id,
      count: payloads.length
    };
  } catch (error) {
    if (configuredGuildId) {
      throw error;
    }
    logger?.warn?.(`slash command registration falling back to global scope: ${error.message}`);
  }

  const application = discord.application ?? (await discord.application?.fetch().catch(() => null));
  if (!application) {
    throw new Error("Discord application is not ready for slash command registration.");
  }
  await application.commands.set(payloads);
  return {
    scope: "global",
    count: payloads.length
  };
}

function getInteractionSubcommand(interaction) {
  return normalizeOption(interaction?.options?.getSubcommand?.(false));
}

function collectModelChoices({ config, getChannelSetups, interactionChannelId, query }) {
  const modelsByKey = new Map();
  const addModel = (value, meta = "") => {
    const normalized = normalizeOption(value).toLowerCase();
    if (!normalized) {
      return;
    }
    if (!modelsByKey.has(normalized)) {
      modelsByKey.set(normalized, {
        name: meta ? `${normalized} ${meta}`.trim() : normalized,
        value: normalized
      });
    }
  };

  addModel(config?.defaultModel, "(default)");
  const agents = config?.agents && typeof config.agents === "object" ? config.agents : {};
  for (const [agentId, agent] of Object.entries(agents)) {
    addModel(agent?.model, `(${agentId})`);
  }
  const channelSetups = typeof getChannelSetups === "function" ? getChannelSetups() : {};
  for (const [channelId, setup] of Object.entries(channelSetups ?? {})) {
    if (channelId === interactionChannelId) {
      addModel(setup?.model, "(current channel)");
    } else {
      addModel(setup?.model);
    }
  }

  return [...modelsByKey.values()]
    .filter((choice) => !query || choice.value.includes(query))
    .slice(0, 25);
}

function collectAgentChoices({ config, query }) {
  const agents = config?.agents && typeof config.agents === "object" ? config.agents : {};
  return Object.entries(agents)
    .map(([agentId, agent]) => {
      const enabled = agent?.enabled === false ? "disabled" : "enabled";
      const model = normalizeOption(agent?.model) || "default model";
      return {
        name: `${agentId} (${enabled}, ${model})`.slice(0, 100),
        value: agentId
      };
    })
    .filter((choice) => !query || choice.value.toLowerCase().includes(query))
    .slice(0, 25);
}

function joinCommand(command, value) {
  return value ? `${command} ${value}` : command;
}

function normalizeOption(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "";
}
