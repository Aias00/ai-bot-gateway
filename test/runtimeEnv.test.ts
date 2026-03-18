import { describe, expect, test } from "bun:test";
import { loadRuntimeEnv } from "../src/config/runtimeEnv.js";

describe("runtime env", () => {
  test("loads restart notify fallback without reference errors", () => {
    const previous = process.env.FEISHU_GENERAL_CHAT_ID;
    delete process.env.FEISHU_GENERAL_CHAT_ID;
    try {
      const env = loadRuntimeEnv();
      expect(typeof env.restartNotifyRouteId).toBe("string");
    } finally {
      if (previous === undefined) {
        delete process.env.FEISHU_GENERAL_CHAT_ID;
      } else {
        process.env.FEISHU_GENERAL_CHAT_ID = previous;
      }
    }
  });
});

