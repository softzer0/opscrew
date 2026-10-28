import { errorText, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_OBSERVABILITY_PERMISSIONS,
  CloudflareClient,
  CloudflareError,
  type TailSocket,
} from "./client";
import { cloudflareConnector } from "./connector";
import type { TailEvent } from "./observability";
import {
  FAKE_ACCOUNT_ID as ACCOUNT_ID,
  FAKE_VISITOR_IP,
  FakeTailSocket,
  type FakeWorkerRequest,
  FakeZone,
} from "./testing";

const TOKEN = fakeSecret("cloudflare-token");
const WORKER = "example-app";
const SCRIPT = `/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER}`;
const T0 = Date.parse("2026-10-28T10:00:00.000Z");

const WORKERS = "Account → Workers Scripts → Edit";
const OBSERVABILITY = "Account → Workers Observability → Read";

/** A request with a plain `console.log`, a `console.warn` and an exception. */
const FAILED: FakeWorkerRequest = {
  worker: WORKER,
  requestId: "req-2",
  time: T0 + 60_000,
  method: "POST",
  url: "https://example.com/api/orders?session=abc123",
  status: 500,
  logs: [{ message: "creating order" }, { message: "stock is low", level: "warn" }],
  exception: { name: "TypeError", message: "x is undefined" },
};
const PLAIN: FakeWorkerRequest = {
  worker: WORKER,
  requestId: "req-1",
  time: T0,
  method: "GET",
  url: "https://example.com/?q=1",
  status: 200,
};

function setup() {
  const zone = new FakeZone();
  zone.workers.set(WORKER, { versions: [], deployments: [] });
  const client = new CloudflareClient({
    token: TOKEN,
    fetch: zone.fetch,
    sleep: async () => {},
    webSocket: zone.webSocket,
  });
  return { zone, client };
}

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("workersLogs", () => {
  it("reads each request, then its console lines and exceptions, oldest first, without the visitor's details", async () => {
    const { zone, client } = setup();
    zone.requests.push(FAILED, PLAIN, { ...PLAIN, worker: "other-app", requestId: "req-x" });
    const entries = await client.workersLogs(ACCOUNT_ID, WORKER, {
      from: T0 - 1000,
      to: T0 + 120_000,
      limit: 100,
    });
    expect(entries).toEqual([
      {
        time: "2026-10-28T10:00:00.000Z",
        level: "info",
        message: "GET /",
        status: 200,
        outcome: "ok",
      },
      {
        time: "2026-10-28T10:01:00.000Z",
        level: "error",
        message: "POST /api/orders",
        status: 500,
        outcome: "exception",
      },
      { time: "2026-10-28T10:01:00.001Z", level: "log", message: "creating order" },
      { time: "2026-10-28T10:01:00.002Z", level: "warn", message: "stock is low" },
      {
        time: "2026-10-28T10:01:00.003Z",
        level: "error",
        message: "x is undefined",
        error: "TypeError",
      },
    ]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain(FAKE_VISITOR_IP);
    expect(text).not.toContain("session=");
    expect(text).not.toContain("q=1");
    expect(zone.calls.at(-1)).toEqual({
      method: "POST",
      path: `/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
      body: {
        queryId: "opscrew-logs",
        timeframe: { from: T0 - 1000, to: T0 + 120_000 },
        view: "invocations",
        limit: 100,
        parameters: {
          filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: WORKER }],
        },
      },
    });
  });

  it("writes console arguments that are not text as JSON", async () => {
    const { zone, client } = setup();
    zone.requests.push(PLAIN);
    zone.faults.push({
      match: "POST /accounts/",
      reply: {
        body: {
          success: true,
          errors: [],
          result: {
            invocations: {
              "req-1": [
                {
                  timestamp: T0,
                  source: { message: ["order", { id: 7 }] },
                  $metadata: { type: "cf-worker", requestId: "req-1" },
                },
              ],
            },
          },
        },
      },
    });
    const entries = await client.workersLogs(ACCOUNT_ID, WORKER, { from: 0, to: T0, limit: 1 });
    expect(entries).toEqual([
      { time: "2026-10-28T10:00:00.000Z", level: "log", message: 'order {"id":7}' },
    ]);
  });

  it("answers no lines when the Worker had no requests", async () => {
    const { client } = setup();
    expect(await client.workersLogs(ACCOUNT_ID, WORKER, { from: 0, to: T0, limit: 10 })).toEqual(
      [],
    );
  });

  it("keeps the newest requests when there are more than the limit", async () => {
    const { zone, client } = setup();
    zone.requests.push(FAILED, PLAIN, { ...PLAIN, requestId: "req-3", time: T0 + 30_000 });
    const entries = await client.workersLogs(ACCOUNT_ID, WORKER, {
      from: T0,
      to: T0 + 120_000,
      limit: 2,
    });
    expect(entries.filter((e) => e.outcome !== undefined).map((e) => e.time)).toEqual([
      "2026-10-28T10:00:30.000Z",
      "2026-10-28T10:01:00.000Z",
    ]);
    expect(entries).toHaveLength(5);
  });

  it("names the missing permission on a 403, without the token", async () => {
    const { zone, client } = setup();
    zone.denied.add("logs");
    const error = await rejection(
      client.workersLogs(ACCOUNT_ID, WORKER, { from: 0, to: 1, limit: 1 }),
    );
    expect(error).toBeInstanceOf(CloudflareError);
    expect(errorText(error)).toContain(OBSERVABILITY);
    expect(errorText(error)).not.toContain(TOKEN);
  });
});

describe("workersTail", () => {
  it("calls onEvent per message, then on abort deletes the tail, closes without waiting and settles", async () => {
    const { zone, client } = setup();
    zone.tailRequests.push(PLAIN, FAILED, { ...PLAIN, requestId: "req-3" });
    const controller = new AbortController();
    const events: TailEvent[] = [];
    await client.workersTail(ACCOUNT_ID, WORKER, {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (events.length === 2) controller.abort();
      },
    });
    expect(events).toEqual([
      {
        time: "2026-10-28T10:00:00.000Z",
        outcome: "ok",
        method: "GET",
        path: "/",
        status: 200,
        logs: [],
        exceptions: [],
      },
      {
        time: "2026-10-28T10:01:00.000Z",
        outcome: "exception",
        method: "POST",
        path: "/api/orders",
        status: 500,
        logs: [
          { level: "log", message: "creating order" },
          { level: "warn", message: "stock is low" },
        ],
        exceptions: [{ name: "TypeError", message: "x is undefined" }],
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(FAKE_VISITOR_IP);
    const [socket] = zone.sockets;
    expect(zone.sockets).toHaveLength(1);
    expect(socket?.protocol).toBe("trace-v1");
    expect(socket?.binaryType).toBe("arraybuffer");
    expect(socket?.closeCalls).toBe(1);
    expect(zone.tails.size).toBe(0);
    expect(zone.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${SCRIPT}/tails`,
      expect.stringMatching(new RegExp(`^DELETE ${SCRIPT}/tails/[0-9a-f]+$`)),
    ]);
    expect(zone.writes()[0]?.body).toEqual({});
  });

  it("settles on abort although the socket never emits close", async () => {
    const { zone } = setup();
    const socket = new FakeTailSocket("", "");
    const client = new CloudflareClient({
      token: TOKEN,
      fetch: zone.fetch,
      webSocket: (): TailSocket => socket,
    });
    const controller = new AbortController();
    const following = client.workersTail(ACCOUNT_ID, WORKER, {
      signal: controller.signal,
      onEvent: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(following).resolves.toBeUndefined();
    expect(socket.closeCalls).toBe(1);
    expect(zone.tails.size).toBe(0);
  });

  it("does nothing when already stopped", async () => {
    const { zone, client } = setup();
    await client.workersTail(ACCOUNT_ID, WORKER, {
      signal: AbortSignal.abort(),
      onEvent: () => {},
    });
    expect(zone.calls).toEqual([]);
  });

  it("fails plainly and deletes the tail when the connection ends", async () => {
    const { zone, client } = setup();
    const created = client.workersTail(ACCOUNT_ID, WORKER, {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    zone.sockets[0]?.emit("close");
    const error = await rejection(created);
    expect(error.message).toBe(`The live logs of the Worker ${WORKER} stopped.`);
    expect(zone.tails.size).toBe(0);
    expect(zone.sockets[0]?.closeCalls).toBe(1);
  });

  it("names the missing permission on a 403, without the token", async () => {
    const { zone, client } = setup();
    zone.denied.add("tail");
    const error = await rejection(
      client.workersTail(ACCOUNT_ID, WORKER, {
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    );
    expect(error).toBeInstanceOf(CloudflareError);
    expect(errorText(error)).toContain(WORKERS);
    expect(errorText(error)).not.toContain(TOKEN);
    expect(zone.sockets).toEqual([]);
  });

  it("passes Cloudflare's refusal to create a tail through, redacted", async () => {
    const { zone, client } = setup();
    const leaked = fakeSecret("github-token");
    zone.faults.push({
      match: `POST ${SCRIPT}/tails`,
      reply: {
        status: 400,
        body: {
          success: false,
          errors: [
            { code: 10057, message: `Too many clients are following this Worker ${leaked}` },
          ],
          result: null,
        },
      },
    });
    const error = await rejection(
      client.workersTail(ACCOUNT_ID, WORKER, {
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    );
    expect(errorText(error)).toContain("Too many clients are following this Worker");
    expect(errorText(error)).not.toContain(leaked);
  });
});

describe("workersAnalytics", () => {
  it("reads requests, exceptions and CPU time in ms for the Worker since the time given", async () => {
    const { zone, client } = setup();
    zone.figures.set(WORKER, { requests: 273, errors: 5, cpuTimeP50: 331, cpuTimeP99: 991 });
    const since = new Date(T0);
    expect(await client.workersAnalytics(ACCOUNT_ID, WORKER, since)).toEqual({
      requests: 273,
      errors: 5,
      cpuTimeP50Ms: 0.331,
      cpuTimeP99Ms: 0.991,
    });
    expect(zone.calls.at(-1)).toEqual({
      method: "POST",
      path: "/graphql",
      body: {
        query: expect.stringMatching(
          /workersInvocationsAdaptive[\s\S]*dimensions \{ scriptName \}/,
        ),
        variables: { account: ACCOUNT_ID, since: "2026-10-28T10:00:00.000Z", worker: WORKER },
      },
    });
  });

  it("reads zero when the Worker had no requests", async () => {
    const { client } = setup();
    expect(await client.workersAnalytics(ACCOUNT_ID, WORKER, new Date(T0))).toEqual({
      requests: 0,
      errors: 0,
      cpuTimeP50Ms: 0,
      cpuTimeP99Ms: 0,
    });
  });

  it("names the missing permission when GraphQL refuses the account", async () => {
    const { zone, client } = setup();
    zone.denied.add("analytics");
    const error = await rejection(client.workersAnalytics(ACCOUNT_ID, WORKER, new Date(T0)));
    expect(error).toBeInstanceOf(CloudflareError);
    expect(errorText(error)).toContain("does not have permission");
    expect(errorText(error)).toContain(WORKERS);
    expect(errorText(error)).not.toContain(TOKEN);
  });

  it("names the missing permission on a 403", async () => {
    const { zone, client } = setup();
    zone.faults.push({ match: "POST /graphql", reply: { status: 403, body: { errors: [] } } });
    const error = await rejection(client.workersAnalytics(ACCOUNT_ID, WORKER, new Date(T0)));
    expect(error).toBeInstanceOf(CloudflareError);
    expect(errorText(error)).toContain(WORKERS);
  });
});

describe("observabilityPermissions", () => {
  it("finds none missing, reading the last minute of logs by the client's clock", async () => {
    const { zone } = setup();
    const client = new CloudflareClient({ token: TOKEN, fetch: zone.fetch, now: () => T0 });
    expect(await client.observabilityPermissions(ACCOUNT_ID, WORKER)).toEqual({ missing: [] });
    expect(zone.calls).toEqual([
      {
        method: "POST",
        path: `/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
        body: expect.objectContaining({ timeframe: { from: T0 - 60_000, to: T0 }, limit: 1 }),
      },
    ]);
  });

  it("names Workers Observability Read when the logs are refused", async () => {
    const { zone, client } = setup();
    zone.denied.add("logs");
    expect(await client.observabilityPermissions(ACCOUNT_ID, WORKER)).toEqual({
      missing: [OBSERVABILITY],
    });
  });
});

describe("CLOUDFLARE_OBSERVABILITY_PERMISSIONS", () => {
  it("holds Workers Observability Read, marked as only for logs, and the connector asks for it", () => {
    expect(CLOUDFLARE_OBSERVABILITY_PERMISSIONS).toEqual([
      `${OBSERVABILITY} (only for logs on Cloudflare hosting)`,
    ]);
    const { credentials } = cloudflareConnector({ env: {}, fetch: new FakeZone().fetch });
    expect(credentials.scopes).toEqual(
      expect.arrayContaining([...CLOUDFLARE_OBSERVABILITY_PERMISSIONS]),
    );
  });
});
