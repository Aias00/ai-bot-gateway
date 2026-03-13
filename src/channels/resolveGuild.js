export async function resolveDiscordGuild(discord, options = {}) {
  const configuredGuildId = String(options.guildId ?? process.env.DISCORD_GUILD_ID ?? "").trim();
  if (configuredGuildId) {
    const guild = discord.guilds.cache.get(configuredGuildId);
    if (guild) {
      return guild;
    }

    const fetchedGuild = await fetchGuildById(discord, configuredGuildId);
    if (fetchedGuild) {
      return fetchedGuild;
    }

    const allGuilds = await fetchAllGuilds(discord);
    const knownGuilds = [...allGuilds.values()].map((entry) => `${entry.name} (${entry.id})`);
    const appId = discord.application?.id;
    throw new Error(
      [
        `DISCORD_GUILD_ID=${configuredGuildId} is not visible to this bot.`,
        knownGuilds.length > 0
          ? `Bot can access: ${knownGuilds.join(", ")}`
          : "Bot is not in any guilds.",
        appId
          ? `Re-invite with guild install + bot scope: https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=274877975552`
          : "Re-invite the bot with guild install and bot scope."
      ].join(" ")
    );
  }

  const guilds = [...discord.guilds.cache.values()];
  if (guilds.length === 1) {
    return guilds[0];
  }

  const fetched = await fetchAllGuilds(discord);
  if (fetched.size === 1) {
    return [...fetched.values()][0];
  }

  throw new Error("Set DISCORD_GUILD_ID (bot is in multiple guilds).");
}

async function fetchGuildById(discord, guildId) {
  if (typeof discord?.guilds?.fetch !== "function") {
    return null;
  }
  return await discord.guilds.fetch(guildId).catch(() => null);
}

async function fetchAllGuilds(discord) {
  if (typeof discord?.guilds?.fetch !== "function") {
    return discord?.guilds?.cache instanceof Map ? discord.guilds.cache : new Map();
  }
  return await discord.guilds.fetch().catch(() => new Map());
}
