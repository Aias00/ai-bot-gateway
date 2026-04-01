import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/loadConfig.js";

const ENV_KEYS = [
  "DISCORD_ALLOWED_USER_IDS",
  "FEISHU_ALLOWED_OPEN_IDS",
  "CODEX_APPROVAL_POLICY",
  "CODEX_SANDBOX_MODE",
  "AGENT_RUNTIME"
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function writeJsonTempFile(payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-load-config-multibot-"));
  const filePath = path.join(dir, "channels.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

describe("loadConfig multi-bot", () => {
  test("parses config-defined bots and bot-local routes", async () => {
    const configPath = writeJsonTempFile({
      defaultModel: "gpt-5.3-codex",
      agents: {
        "codex-default": {
          model: "gpt-5.3-codex",
          runtime: "codex",
          enabled: true
        },
        "claude-default": {
          model: "claude-sonnet-4-6",
          runtime: "claude",
          enabled: true
        }
      },
      bots: {
        "discord-codex-main": {
          platform: "discord",
          runtime: "codex",
          auth: {
            tokenEnv: "DISCORD_BOT_TOKEN_MAIN"
          },
          settings: {
            guildId: "guild-1"
          },
          routes: {
            "123": {
              cwd: "./repo-a",
              agentId: "codex-default"
            }
          }
        },
        "feishu-claude-main": {
          platform: "feishu",
          runtime: "claude",
          auth: {
            appIdEnv: "FEISHU_APP_ID_MAIN",
            appSecretEnv: "FEISHU_APP_SECRET_MAIN"
          },
          routes: {
            oc_repo_1: {
              cwd: "./repo-b",
              agent: "claude-default"
            }
          }
        }
      }
    });

    const config = await loadConfig(configPath);

    expect(config.bots).toEqual({
      "discord-codex-main": {
        platform: "discord",
        runtime: "codex",
        auth: {
          tokenEnv: "DISCORD_BOT_TOKEN_MAIN"
        },
        settings: {
          guildId: "guild-1"
        },
        routes: {
          "123": {
            cwd: path.resolve("./repo-a"),
            agentId: "codex-default"
          }
        }
      },
      "feishu-claude-main": {
        platform: "feishu",
        runtime: "claude",
        auth: {
          appIdEnv: "FEISHU_APP_ID_MAIN",
          appSecretEnv: "FEISHU_APP_SECRET_MAIN"
        },
        routes: {
          oc_repo_1: {
            cwd: path.resolve("./repo-b"),
            agentId: "claude-default"
          }
        }
      }
    });
  });

  test("synthesizes legacy default bots from top-level channels", async () => {
    const configPath = writeJsonTempFile({
      runtime: "claude",
      channels: {
        "123": {
          cwd: "./repo-a",
          agentId: "claude-default"
        },
        "feishu:oc_repo_1": {
          cwd: "./repo-b",
          model: "claude-sonnet-4-6"
        }
      }
    });

    const config = await loadConfig(configPath);

    expect(config.bots).toEqual({
      "discord-default": {
        platform: "discord",
        runtime: "claude",
        auth: {
          tokenEnv: "DISCORD_BOT_TOKEN"
        },
        settings: {
          allowedUserIdsEnv: "DISCORD_ALLOWED_USER_IDS"
        },
        routes: {
          "123": {
            cwd: path.resolve("./repo-a"),
            agentId: "claude-default"
          }
        }
      },
      "feishu-default": {
        platform: "feishu",
        runtime: "claude",
        auth: {
          appIdEnv: "FEISHU_APP_ID",
          appSecretEnv: "FEISHU_APP_SECRET",
          verificationTokenEnv: "FEISHU_VERIFICATION_TOKEN"
        },
        settings: {
          allowedOpenIdsEnv: "FEISHU_ALLOWED_OPEN_IDS"
        },
        routes: {
          oc_repo_1: {
            cwd: path.resolve("./repo-b"),
            model: "claude-sonnet-4-6"
          }
        }
      }
    });
  });

  test("rejects routes whose agent runtime is incompatible with the bot runtime", async () => {
    const configPath = writeJsonTempFile({
      agents: {
        "claude-default": {
          model: "claude-sonnet-4-6",
          runtime: "claude",
          enabled: true
        }
      },
      bots: {
        "discord-codex-main": {
          platform: "discord",
          runtime: "codex",
          auth: {
            tokenEnv: "DISCORD_BOT_TOKEN_MAIN"
          },
          routes: {
            "123": {
              cwd: "./repo-a",
              agentId: "claude-default"
            }
          }
        }
      }
    });

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Route discord-codex-main/123 references agent claude-default which is incompatible with bot runtime codex"
    );
  });
});
