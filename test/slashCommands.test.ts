import { describe, expect, test } from "bun:test";
import { buildCommandTextFromInteraction, buildSlashCommandPayloads, syncSlashCommands } from "../src/commands/slashCommands.js";

function createOptions(values: Record<string, unknown> = {}) {
  return {
    getSubcommand() {
      const value = values.__subcommand;
      return typeof value === "string" ? value : null;
    },
    getString(name: string) {
      const value = values[name];
      return typeof value === "string" ? value : null;
    },
    getBoolean(name: string) {
      const value = values[name];
      return typeof value === "boolean" ? value : null;
    }
  };
}

describe("slash commands", () => {
  test("builds the expected command set", () => {
    const payloads = buildSlashCommandPayloads();
    const names = payloads.map((payload) => payload.name);

    expect(names).toEqual([
      "help",
      "ask",
      "status",
      "where",
      "new",
      "interrupt",
      "runtime",
      "repo",
      "model",
      "agent",
      "approval",
      "ops"
    ]);
  });

  test("maps slash interactions back to the existing !command text", () => {
    expect(buildCommandTextFromInteraction({ commandName: "status", options: createOptions() })).toBe("!status");
    expect(buildCommandTextFromInteraction({ commandName: "ask", options: createOptions({ prompt: "ship it" }) })).toBe(
      "!ask ship it"
    );
    expect(
      buildCommandTextFromInteraction({
        commandName: "approval",
        options: createOptions({ __subcommand: "approve", id: "0007" })
      })
    ).toBe(
      "!approve 0007"
    );
    expect(
      buildCommandTextFromInteraction({
        commandName: "repo",
        options: createOptions({ __subcommand: "setpath", path: "/tmp/repo-one" })
      })
    ).toBe("!setpath /tmp/repo-one");
    expect(
      buildCommandTextFromInteraction({
        commandName: "repo",
        options: createOptions({ __subcommand: "bind", path: "/tmp/repo-one" })
      })
    ).toBe(
      "!bind /tmp/repo-one"
    );
    expect(
      buildCommandTextFromInteraction({
        commandName: "repo",
        options: createOptions({ __subcommand: "rebind", path: "/tmp/repo-two" })
      })
    ).toBe("!rebind /tmp/repo-two");
    expect(
      buildCommandTextFromInteraction({ commandName: "repo", options: createOptions({ __subcommand: "unbind" }) })
    ).toBe("!unbind");
    expect(
      buildCommandTextFromInteraction({
        commandName: "repo",
        options: createOptions({ __subcommand: "mkchannel", name: "repo-two" })
      })
    ).toBe(
      "!mkchannel repo-two"
    );
    expect(
      buildCommandTextFromInteraction({
        commandName: "repo",
        options: createOptions({ __subcommand: "mkrepo", name: "repo-two" })
      })
    ).toBe(
      "!mkrepo repo-two"
    );
    expect(
      buildCommandTextFromInteraction({
        commandName: "repo",
        options: createOptions({ __subcommand: "mkbind", name: "repo-two", path: "/tmp/repo-two" })
      })
    ).toBe("!mkbind repo-two /tmp/repo-two");
    expect(
      buildCommandTextFromInteraction({
        commandName: "model",
        options: createOptions({ __subcommand: "set", model: "gpt-5.4-codex" })
      })
    ).toBe("!setmodel gpt-5.4-codex");
    expect(
      buildCommandTextFromInteraction({ commandName: "model", options: createOptions({ __subcommand: "clear" }) })
    ).toBe("!clearmodel");
    expect(
      buildCommandTextFromInteraction({
        commandName: "agent",
        options: createOptions({ __subcommand: "set", agent: "claude" })
      })
    ).toBe("!setagent claude");
    expect(
      buildCommandTextFromInteraction({ commandName: "agent", options: createOptions({ __subcommand: "clear" }) })
    ).toBe("!clearagent");
    expect(
      buildCommandTextFromInteraction({ commandName: "agent", options: createOptions({ __subcommand: "list" }) })
    ).toBe("!agents");
    expect(
      buildCommandTextFromInteraction({ commandName: "model", options: createOptions({ __subcommand: "list" }) })
    ).toBe("!models");
    expect(
      buildCommandTextFromInteraction({ commandName: "repo", options: createOptions({ __subcommand: "init", force: true }) })
    ).toBe(
      "!initrepo force"
    );
    expect(
      buildCommandTextFromInteraction({ commandName: "runtime", options: createOptions({ __subcommand: "restart", reason: "manual" }) })
    ).toBe("!restart manual");
    expect(
      buildCommandTextFromInteraction({ commandName: "ops", options: createOptions({ __subcommand: "resync" }) })
    ).toBe("!resync");
  });

  test("prefers guild registration when a guild can be resolved", async () => {
    const calls: Array<{ target: string; count: number }> = [];
    const discord = {
      application: {
        commands: {
          set: async (payloads: Array<unknown>) => {
            calls.push({ target: "global", count: payloads.length });
          }
        }
      }
    };
    const guild = {
      id: "guild-1",
      commands: {
        set: async (payloads: Array<unknown>) => {
          calls.push({ target: "guild", count: payloads.length });
        }
      }
    };

    const summary = await syncSlashCommands({
      discord,
      resolveGuild: async () => guild,
      logger: { warn() {} }
    });

    expect(summary).toEqual({
      scope: "guild",
      guildId: "guild-1",
      count: 12
    });
    expect(calls).toEqual([{ target: "guild", count: 12 }]);
  });
});
