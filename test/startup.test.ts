import { describe, expect, test } from "bun:test";
import { startBridgeRuntime } from "../src/app/startup.js";

describe("startup runtime", () => {
  test("marks backend unready when an enabled platform fails startup", async () => {
    const readyUpdates = [];
    const startupAnnouncements = [];

    await startBridgeRuntime({
      codex: {
        async start() {}
      },
      fs: {
        async mkdir() {}
      },
      generalChannelCwd: "/tmp/general",
      platformRegistry: {
        listEnabledPlatforms: () => [{ platformId: "discord" }, { platformId: "feishu" }],
        async start() {
          return [
            {
              platformId: "discord",
              started: false,
              startError: new Error("discord startup timed out")
            },
            {
              platformId: "feishu",
              started: true,
              transport: "long-connection"
            }
          ];
        },
        async bootstrapRoutes() {
          return [];
        }
      },
      maybeCompletePendingRestartNotice: async () => {},
      announceStartup: async (readiness) => {
        startupAnnouncements.push(readiness);
      },
      turnRecoveryStore: {
        async reconcilePending() {
          return {
            reconciled: 0,
            resumedKnown: 0,
            missingThread: 0,
            skipped: 0
          };
        }
      },
      safeSendToChannel: async () => null,
      fetchChannelByRouteId: async () => null,
      startBackendRuntime: async () => {},
      setBackendReady: (value) => {
        readyUpdates.push(value);
      },
      getMappedChannelCount: () => 0,
      startHeartbeatLoop: () => {}
    });

    expect(readyUpdates).toEqual([
      false,
      {
        ready: false,
        degradedPlatforms: [
          {
            platformId: "discord",
            reason: "startup_failed",
            message: "discord startup timed out"
          }
        ]
      }
    ]);
    expect(startupAnnouncements).toEqual([
      {
        ready: false,
        degradedPlatforms: [
          {
            platformId: "discord",
            reason: "startup_failed",
            message: "discord startup timed out"
          }
        ]
      }
    ]);
  });

  test("ensures feishu default workspace directories exist before platform startup", async () => {
    const createdDirs = [];

    await startBridgeRuntime({
      codex: {
        async start() {}
      },
      fs: {
        async mkdir(targetPath) {
          createdDirs.push(targetPath);
        }
      },
      generalChannelCwd: "/tmp/general",
      repoRootPath: "/tmp/agent-gateway-workspace",
      feishuGeneralCwd: "/tmp/feishu-general",
      feishuUnboundChatCwd: "/tmp/agent-gateway-workspace",
      platformRegistry: {
        listEnabledPlatforms: () => [{ platformId: "feishu" }],
        async start() {
          return [
            {
              platformId: "feishu",
              started: true,
              transport: "long-connection"
            }
          ];
        },
        async bootstrapRoutes() {
          return [];
        }
      },
      maybeCompletePendingRestartNotice: async () => {},
      announceStartup: async () => {},
      turnRecoveryStore: {
        async reconcilePending() {
          return {
            reconciled: 0,
            resumedKnown: 0,
            missingThread: 0,
            skipped: 0
          };
        }
      },
      safeSendToChannel: async () => null,
      fetchChannelByRouteId: async () => null,
      startBackendRuntime: async () => {},
      setBackendReady: () => {},
      getMappedChannelCount: () => 0,
      startHeartbeatLoop: () => {}
    });

    expect(createdDirs).toEqual([
      "/tmp/general",
      "/tmp/agent-gateway-workspace",
      "/tmp/feishu-general"
    ]);
  });
});
