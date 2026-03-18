import { describe, expect, test } from "bun:test";
import { registerShutdownSignals } from "../src/app/signalHandlers.js";

describe("signal handlers", () => {
  test("registers process shutdown signal handlers only", () => {
    const originalOn = process.on.bind(process);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const calls: Array<{ exitCode: number; metadata: unknown }> = [];

    process.on = ((event: string, listener: (...args: unknown[]) => void) => {
      handlers.set(event, listener);
      return process;
    }) as typeof process.on;

    try {
      registerShutdownSignals((exitCode: number, metadata: unknown) => {
        calls.push({ exitCode, metadata });
      });
      handlers.get("SIGINT")?.();
      handlers.get("SIGTERM")?.();
    } finally {
      process.on = originalOn;
    }

    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(false);
    expect(handlers.has("uncaughtException")).toBe(false);
    expect(calls).toEqual([
      { exitCode: 0, metadata: { reason: "signal", signal: "SIGINT" } },
      { exitCode: 0, metadata: { reason: "signal", signal: "SIGTERM" } }
    ]);
  });
});
