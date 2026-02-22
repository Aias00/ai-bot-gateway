import fs from "node:fs/promises";
import path from "node:path";

export class StateStore {
  #path;
  #state;
  #legacyThreadsDropped;

  constructor(filePath) {
    this.#path = filePath;
    this.#state = {
      schemaVersion: 2,
      threadBindings: {}
    };
    this.#legacyThreadsDropped = 0;
  }

  async load() {
    await fs.mkdir(path.dirname(this.#path), { recursive: true });
    try {
      const raw = await fs.readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw);
      const legacyThreads =
        parsed && typeof parsed.threads === "object" && parsed.threads !== null
          ? parsed.threads
          : {};
      this.#legacyThreadsDropped = Object.keys(legacyThreads).length;
      this.#state = {
        schemaVersion: 2,
        threadBindings:
          parsed && typeof parsed.threadBindings === "object" && parsed.threadBindings !== null
            ? { ...parsed.threadBindings }
            : parsed && typeof parsed.channelBindings === "object" && parsed.channelBindings !== null
              ? { ...parsed.channelBindings }
              : {}
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await this.save();
    }
  }

  consumeLegacyDropCount() {
    const count = this.#legacyThreadsDropped;
    this.#legacyThreadsDropped = 0;
    return count;
  }

  async save() {
    const tempPath = `${this.#path}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.#state, null, 2), "utf8");
    await fs.rename(tempPath, this.#path);
  }

  getBinding(discordThreadChannelId) {
    return this.#state.threadBindings[discordThreadChannelId] ?? null;
  }

  setBinding(discordThreadChannelId, binding) {
    this.#state.threadBindings[discordThreadChannelId] = {
      ...binding,
      updatedAt: new Date().toISOString()
    };
  }

  clearBinding(discordThreadChannelId) {
    delete this.#state.threadBindings[discordThreadChannelId];
  }

  clearAllBindings() {
    this.#state.threadBindings = {};
  }

  findConversationChannelIdByCodexThreadId(codexThreadId) {
    for (const [discordThreadChannelId, binding] of Object.entries(this.#state.threadBindings)) {
      if (binding?.codexThreadId === codexThreadId) {
        return discordThreadChannelId;
      }
    }
    return null;
  }

  countBindingsForRepoChannel(repoChannelId) {
    let count = 0;
    for (const binding of Object.values(this.#state.threadBindings)) {
      if (binding?.repoChannelId === repoChannelId) {
        count += 1;
      }
    }
    return count;
  }

  snapshot() {
    return structuredClone(this.#state);
  }
}
