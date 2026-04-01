import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createBackendHttpRuntime } from "../src/backend/httpRuntime.js";
import { makeScopedRouteId } from "../src/bots/scopedRoutes.js";

const runtimes = [];
const fakeServers = new Map<number, FakeHttpServer>();
const originalFetch = globalThis.fetch;
let nextFakePort = 46000;

class FakeHttpServer {
  constructor(handler) {
    this.handler = handler;
    this.onceListeners = new Map();
    this.addressInfo = null;
  }

  once(event, listener) {
    const listeners = this.onceListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.onceListeners.set(event, listeners);
    return this;
  }

  off(event, listener) {
    this.onceListeners.get(event)?.delete(listener);
    return this;
  }

  listen(requestedPort, host, callback) {
    const port = requestedPort || nextFakePort++;
    this.addressInfo = {
      address: host || "127.0.0.1",
      family: "IPv4",
      port
    };
    fakeServers.set(port, this);
    queueMicrotask(() => {
      callback?.();
    });
    return this;
  }

  close(callback) {
    if (this.addressInfo?.port) {
      fakeServers.delete(this.addressInfo.port);
    }
    this.addressInfo = null;
    queueMicrotask(() => {
      callback?.();
    });
    return this;
  }

  address() {
    return this.addressInfo;
  }

  async dispatch(url, init = {}) {
    const request = {
      method: String(init.method ?? "GET"),
      url: `${url.pathname}${url.search}`,
      headers: {},
      body: init.body
    };
    let statusCode = 200;
    let body = "";
    const headers = {};
    const response = {
      headersSent: false,
      writableEnded: false,
      writeHead(nextStatusCode, nextHeaders = {}) {
        statusCode = nextStatusCode;
        Object.assign(headers, nextHeaders);
        response.headersSent = true;
        return response;
      },
      end(chunk = "") {
        body += typeof chunk === "string" ? chunk : String(chunk ?? "");
        response.writableEnded = true;
        return response;
      }
    };

    await this.handler(request, response);
    await Promise.resolve();

    return new Response(body, {
      status: statusCode,
      headers
    });
  }
}

function createTestRuntime(deps) {
  const runtime = createBackendHttpRuntime({
    ...deps,
    createServer: (handler) => new FakeHttpServer(handler)
  });
  runtimes.push(runtime);
  return runtime;
}

async function fakeFetch(url, init) {
  const parsed = new URL(String(url));
  const port = Number(parsed.port);
  const server = fakeServers.get(port);
  if (!server) {
    throw new Error(`No fake server registered for ${parsed.href}`);
  }
  return server.dispatch(parsed, init);
}

beforeAll(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  fakeServers.clear();
});

afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    await runtime?.stop?.();
  }
  fakeServers.clear();
});

describe("backend http runtime multi-bot", () => {
  test("accepts bot_id plus external route_id for scoped turn records", async () => {
    const scopedRouteId = makeScopedRouteId("discord-main", "123");
    const runtime = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-04-01T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      getTurnRequestStatus: (requestId: string) =>
        requestId === "req-scoped"
          ? {
              requestId,
              platform: "discord",
              botId: "discord-main",
              externalRouteId: "123",
              repoChannelId: scopedRouteId,
              status: "processing"
            }
          : null,
      findTurnRequestStatusBySource: ({ sourceMessageId, routeId }: { sourceMessageId: string; routeId?: string }) =>
        sourceMessageId === "msg-scoped" && routeId === scopedRouteId
          ? {
              requestId: "req-scoped",
              sourceMessageId,
              platform: "discord",
              botId: "discord-main",
              externalRouteId: "123",
              repoChannelId: scopedRouteId,
              status: "processing"
            }
          : null,
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const byRequest = await fetch(`${baseUrl}/turns/req-scoped?platform=discord&bot_id=discord-main&route_id=123`);
    expect(byRequest.status).toBe(200);
    const byRequestPayload = await byRequest.json();
    expect(byRequestPayload.repoChannelId).toBe(scopedRouteId);
    expect(byRequestPayload.scopeVerified).toBe(true);

    const bySource = await fetch(
      `${baseUrl}/turns/by-source/msg-scoped?platform=discord&bot_id=discord-main&route_id=123`
    );
    expect(bySource.status).toBe(200);
    const bySourcePayload = await bySource.json();
    expect(bySourcePayload.repoChannelId).toBe(scopedRouteId);
    expect(bySourcePayload.scopeVerified).toBe(true);
  });
});
