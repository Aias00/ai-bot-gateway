import { describe, expect, test } from "bun:test";
import { createFeishuPlatform } from "../src/platforms/feishuPlatform.js";

describe("feishu platform multi-bot", () => {
  test("uses bot-specific webhook path and exposes bot identity", async () => {
    const platform = createFeishuPlatform({
      bot: {
        botId: "feishu-support"
      },
      runtime: {
        enabled: true,
        transport: "webhook",
        webhookPath: "/feishu/support/events",
        fetchChannelByRouteId: async (routeId: string) => ({ id: routeId, botId: "feishu-support" }),
        start: async () => ({ startedAt: "now" }),
        stop: async () => ({
          platformId: "feishu",
          stopped: true
        })
      }
    });

    expect(platform.getHttpEndpoints()).toEqual(["/feishu/support/events"]);
    expect(platform.matchesHttpRequest({ pathname: "/feishu/support/events" })).toBe(true);
    expect(await platform.fetchChannelByRouteId("oc_1")).toEqual({ id: "oc_1", botId: "feishu-support" });
    expect(await platform.start()).toEqual({
      platformId: "feishu",
      botId: "feishu-support",
      instanceKey: "feishu-support",
      started: true,
      transport: "webhook",
      startedAt: "now"
    });
  });

  test("includes bot identity in shutdown summaries", async () => {
    const platform = createFeishuPlatform({
      bot: {
        botId: "feishu-review"
      },
      runtime: {
        enabled: true,
        transport: "long-connection",
        fetchChannelByRouteId: async () => null,
        stop: async () => ({
          platformId: "feishu",
          stopped: true
        })
      }
    });

    expect(await platform.stop()).toEqual({
      platformId: "feishu",
      botId: "feishu-review",
      instanceKey: "feishu-review",
      stopped: true
    });
  });

  test("only accepts prefixed routes or raw Feishu chat ids", () => {
    const platform = createFeishuPlatform({
      bot: {
        botId: "feishu-support"
      },
      runtime: {
        enabled: true,
        transport: "webhook",
        fetchChannelByRouteId: async () => null
      }
    });

    expect(platform.canHandleRouteId("feishu:oc_1")).toBe(true);
    expect(platform.canHandleRouteId("oc_1")).toBe(true);
    expect(platform.canHandleRouteId("123")).toBe(false);
  });
});
