import { afterEach, describe, expect, test } from "bun:test";
import { createTurnRunner } from "../src/codex/turnRunner.js";

const ORIGINAL_SETTLE_TIMEOUT = process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS;
const ORIGINAL_RPC_MAX_ATTEMPTS = process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS;

afterEach(() => {
  if (ORIGINAL_SETTLE_TIMEOUT === undefined) {
    delete process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS;
  } else {
    process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS = ORIGINAL_SETTLE_TIMEOUT;
  }
  if (ORIGINAL_RPC_MAX_ATTEMPTS === undefined) {
    delete process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS;
  } else {
    process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS = ORIGINAL_RPC_MAX_ATTEMPTS;
  }
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 800, stepMs = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await delay(stepMs);
  }
  return false;
}

function createDeps() {
  const queues = new Map();
  const activeTurns = new Map<string, TestTurnTracker>();
  const stateByChannel = new Map<string, { codexThreadId: string; repoChannelId: string; cwd: string }>();

  const state = {
    getBinding(repoChannelId: string) {
      return stateByChannel.get(repoChannelId) ?? null;
    },
    setBinding(repoChannelId: string, binding: { codexThreadId: string; repoChannelId: string; cwd: string }) {
      stateByChannel.set(repoChannelId, binding);
    },
    clearBinding(repoChannelId: string) {
      stateByChannel.delete(repoChannelId);
    },
    async save() {}
  };

  const channel = {
    id: "channel-1",
    isTextBased: () => true
  };

  const safeReply = async () => ({
    id: "status-1",
    channel,
    async edit() {}
  });

  return {
    queues,
    activeTurns,
    state,
    safeReply,
    channel
  };
}

type TestTurnTracker = {
  fullText?: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

function createFinalizeTurn(
  activeTurns: Map<string, TestTurnTracker>,
  calls: Array<{ threadId: string; error: string | null }>
) {
  return async (threadId: string, error: Error | null) => {
    calls.push({ threadId, error: error?.message ?? null });
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    activeTurns.delete(threadId);
    if (error) {
      tracker.reject(error);
      return;
    }
    tracker.resolve(tracker.fullText ?? "");
  };
}

describe("turnRunner restart/reconnect integration", () => {
  test("keeps in-flight turn alive after reconnect and settles without replay", async () => {
    process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS = "500";
    process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS = "1";
    const deps = createDeps();
    const reconnectPendingCalls: Array<{ threadId: string; attempt: number }> = [];
    const finalizeCalls: Array<{ threadId: string; error: string | null }> = [];
    const requestLog: string[] = [];

    let turnStartCalls = 0;
    const codex = {
      async request(method: string) {
        requestLog.push(method);
        if (method === "thread/start") {
          return { thread: { id: "thread-1" } };
        }
        if (method === "turn/start") {
          turnStartCalls += 1;
          throw new Error("Reconnecting... 2/5");
        }
        return {};
      }
    };

    const runner = createTurnRunner({
      queues: deps.queues,
      activeTurns: deps.activeTurns,
      state: deps.state,
      codex,
      config: {
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "never",
        sandboxMode: "workspace-write"
      },
      safeReply: deps.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: createFinalizeTurn(deps.activeTurns, finalizeCalls),
      onTurnReconnectPending: (threadId: string, context: { attempt?: number }) => {
        reconnectPendingCalls.push({ threadId, attempt: Number(context.attempt ?? 0) });
      },
      onActiveTurnsChanged: () => {
        const tracker = deps.activeTurns.get("thread-1");
        if (tracker && !tracker.fullText) {
          tracker.fullText = "partial output";
        }
      }
    });

    runner.enqueuePrompt("channel-1", {
      message: { channelId: "channel-1" },
      setup: { cwd: "/tmp/repo", model: "gpt-5.3-codex" },
      inputItems: [{ type: "text", text: "restart test" }]
    });

    const seenTracker = await waitUntil(() => deps.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);

    const tracker = deps.activeTurns.get("thread-1");

    await delay(650);
    tracker.resolve("final output");

    const queueSettled = await waitUntil(() => !runner.getQueue("channel-1").running, 1200, 10);
    expect(queueSettled).toBe(true);
    expect(turnStartCalls).toBe(1);
    expect(reconnectPendingCalls.length).toBeGreaterThan(0);
    expect(finalizeCalls).toEqual([]);
  });

  test("finalizes with error when reconnect does not settle in time", async () => {
    process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS = "500";
    process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS = "1";
    const deps = createDeps();
    const finalizeCalls: Array<{ threadId: string; error: string | null }> = [];

    const codex = {
      async request(method: string) {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" } };
        }
        if (method === "turn/start") {
          throw new Error("Reconnecting... 2/5");
        }
        return {};
      }
    };

    const runner = createTurnRunner({
      queues: deps.queues,
      activeTurns: deps.activeTurns,
      state: deps.state,
      codex,
      config: {
        defaultModel: "gpt-5.3-codex",
        defaultEffort: "medium",
        approvalPolicy: "never",
        sandboxMode: "workspace-write"
      },
      safeReply: deps.safeReply,
      buildSandboxPolicyForTurn: async () => null,
      isThreadNotFoundError: () => false,
      finalizeTurn: createFinalizeTurn(deps.activeTurns, finalizeCalls),
      onTurnReconnectPending: () => {},
      onActiveTurnsChanged: () => {
        const tracker = deps.activeTurns.get("thread-1");
        if (tracker && !tracker.fullText) {
          tracker.fullText = "partial output";
        }
      }
    });

    runner.enqueuePrompt("channel-1", {
      message: { channelId: "channel-1" },
      setup: { cwd: "/tmp/repo", model: "gpt-5.3-codex" },
      inputItems: [{ type: "text", text: "restart test" }]
    });

    const seenTracker = await waitUntil(() => deps.activeTurns.has("thread-1"));
    expect(seenTracker).toBe(true);
    const queueSettled = await waitUntil(() => !runner.getQueue("channel-1").running, 2500, 10);
    expect(queueSettled).toBe(true);
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]?.threadId).toBe("thread-1");
    expect(String(finalizeCalls[0]?.error ?? "")).toContain("Reconnecting");
  });
});
