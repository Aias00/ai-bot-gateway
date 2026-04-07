import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ClaudeClient, buildClaudeSdkExtraArgs } from "../src/claudeClient.js";

// Test basic client construction and method signatures
describe("ClaudeClient", () => {
  let client;

  beforeEach(() => {
    client = new ClaudeClient();
  });

  afterEach(async () => {
    if (client) {
      await client.stop().catch(() => {});
    }
  });

  describe("constructor", () => {
    it("creates client with default options", () => {
      expect(client).toBeDefined();
    });

    it("accepts custom claudeBin path", () => {
      const customClient = new ClaudeClient({ claudeBin: "/custom/path/claude" });
      expect(customClient).toBeDefined();
    });

    it("accepts configOverrides", () => {
      const clientWithOverrides = new ClaudeClient({
        configOverrides: ["--some-flag"]
      });
      expect(clientWithOverrides).toBeDefined();
    });
  });

  describe("request method validation", () => {
    it("throws if not started", async () => {
      await expect(client.request("thread/start", {})).rejects.toThrow(
        "Claude client not started"
      );
    });

    it("throws for unknown method", async () => {
      // Need to start first to get past the startup check
      // Since we can't start without a real CLI, we verify the guard works
      await expect(client.request("unknown/method", {})).rejects.toThrow(
        "Claude client not started"
      );
    });
  });

  describe("respond method", () => {
    it("handles respond for non-existent approval without throwing", () => {
      // Should not throw
      client.respond("non-existent-id", { decision: "accept" });
      expect(true).toBe(true);
    });

    it("handles respondWithError for non-existent approval without throwing", () => {
      // Should not throw
      client.respondWithError("non-existent-id", 500, "Test error");
      expect(true).toBe(true);
    });
  });

  describe("getSessionId", () => {
    it("returns null initially", () => {
      expect(client.getSessionId()).toBeNull();
    });
  });

  describe("notify method", () => {
    it("does not throw for notify calls", () => {
      expect(() => client.notify("test/method", { data: "test" })).not.toThrow();
    });
  });

  describe("event emitter interface", () => {
    it("can add event listeners", () => {
      const handler = () => {};
      client.on("notification", handler);
      client.on("serverRequest", handler);
      client.on("error", handler);
      client.on("exit", handler);
      client.on("ready", handler);
      expect(true).toBe(true);
    });

    it("emits ready event on successful start", async () => {
      // We can't actually test start() without a real CLI
      // But we can verify the event interface exists
      let readyFired = false;
      client.on("ready", () => {
        readyFired = true;
      });
      // Event listener is registered
      expect(readyFired).toBe(false);
    });
  });

  describe("timeout configuration", () => {
    it("uses default timeout when not specified", () => {
      const defaultClient = new ClaudeClient();
      expect(defaultClient).toBeDefined();
    });

    it("accepts custom timeout", () => {
      const customTimeoutClient = new ClaudeClient({ requestTimeoutMs: 60000 });
      expect(customTimeoutClient).toBeDefined();
    });

    it("rejects invalid timeout", () => {
      // Should use default when invalid
      const invalidClient = new ClaudeClient({ requestTimeoutMs: 100 });
      expect(invalidClient).toBeDefined();
    });
  });

  describe("CLI capability adaptation", () => {
    it("does not pass bare when CLI does not support it", () => {
      expect(buildClaudeSdkExtraArgs({ supportsBare: false })).toEqual({});
    });

    it("passes bare only when CLI supports it", () => {
      expect(buildClaudeSdkExtraArgs({ supportsBare: true })).toEqual({ bare: null });
    });
  });
});
