import { describe, expect, test } from "bun:test";
import { createDiscordPlatform } from "../src/platforms/discordPlatform.js";

describe("discord platform multi-bot", () => {
  test("includes bot identity in startup and shutdown summaries", async () => {
    const discord = {
      application: {
        fetch: async () => {}
      },
      channels: {
        fetch: async (routeId: string) => ({ id: routeId })
      },
      async login() {},
      destroy() {}
    };

    const platform = createDiscordPlatform({
      bot: {
        botId: "discord-review"
      },
      discord,
      discordToken: "token-review",
      waitForDiscordReady: async () => {},
      runtime: {
        handleMessage: async () => {},
        handleInteraction: async () => {},
        registerSlashCommands: async () => ({ scope: "guild", count: 1, guildId: "g-review" })
      },
      bootstrapChannelMappings: async () => ({ discoveredCwds: 1 })
    });

    expect(await platform.start()).toEqual({
      platformId: "discord",
      botId: "discord-review",
      instanceKey: "discord-review",
      started: true,
      commandRegistration: { scope: "guild", count: 1, guildId: "g-review" },
      commandRegistrationError: null
    });
    expect(await platform.stop()).toEqual({
      platformId: "discord",
      botId: "discord-review",
      instanceKey: "discord-review",
      stopped: true
    });
  });
});
