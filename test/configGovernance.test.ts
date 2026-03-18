import { describe, expect, test } from "bun:test";
import { enforceOperationalConfig, validateOperationalConfig } from "../src/config/governance.js";

describe("config governance", () => {
  test("validates happy path", () => {
    const result = validateOperationalConfig({
      DISCORD_LOG_ROTATE_MAX_BYTES: "2097152",
      DISCORD_LOG_ROTATE_MAX_FILES: "10",
      RESTART_MIN_INTERVAL: "15",
      RESTART_DRAIN_TIMEOUT: "120",
      RESTART_DRAIN_POLL: "2",
      RESTART_MAX_ATTEMPTS_WINDOW: "6",
      RESTART_WINDOW_SECONDS: "300",
      RESTART_COOLDOWN_SECONDS: "120",
      DISCORD_RESTART_NOTIFY_ROUTE_ID: "feishu:oc_xxx",
      BACKEND_HTTP_PORT: "8788"
    });
    expect(result.errors).toEqual([]);
  });

  test("reports invalid values", () => {
    const result = validateOperationalConfig({
      DISCORD_LOG_ROTATE_MAX_BYTES: "100",
      DISCORD_LOG_ROTATE_MAX_FILES: "0",
      RESTART_MIN_INTERVAL: "0",
      RESTART_DRAIN_TIMEOUT: "1",
      RESTART_DRAIN_POLL: "2",
      DISCORD_RESTART_NOTIFY_ROUTE_ID: "bad-route",
      BACKEND_HTTP_PORT: "70000"
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("enforce throws under strict mode", () => {
    expect(() =>
      enforceOperationalConfig({
        CONFIG_GOVERNANCE_MODE: "strict",
        DISCORD_LOG_ROTATE_MAX_BYTES: "100"
      })
    ).toThrow("Operational config validation failed");
  });

  test("enforce does not throw under warn mode", () => {
    expect(() =>
      enforceOperationalConfig({
        CONFIG_GOVERNANCE_MODE: "warn",
        DISCORD_LOG_ROTATE_MAX_BYTES: "100"
      })
    ).not.toThrow();
  });
});

