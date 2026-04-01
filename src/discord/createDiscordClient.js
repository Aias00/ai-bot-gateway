import { EventEmitter } from "node:events";

export async function createDiscordClient() {
  const { Client, GatewayIntentBits } = await import("discord.js");
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
}

export function createDisabledDiscordClient() {
  const client = new EventEmitter();
  client.channels = {
    fetch: async () => null
  };
  client.application = null;
  client.user = null;
  client.isReady = () => false;
  client.login = async () => null;
  client.destroy = () => {};
  return client;
}
