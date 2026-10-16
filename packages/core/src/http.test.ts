import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type JsonClient, pollAction, type RequestFailure, requestJson } from "./http";
import { type FakeReply, fakeFetch } from "./testing";

const BASE = "https://api.example.test/v1";
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const ThingSchema = z.object({ thing: z.object({ id: z.number() }) });

function setup(routes: Record<string, FakeReply | FakeReply[]>, timeoutMs = 1_000) {
  const fake = fakeFetch(routes, { base: BASE });
  const waits: number[] = [];
  const client: JsonClient = {
    fetch: fake.fetch,
    timeoutMs,
    retry: {
      serverErrors: 2,
      serverErrorDelayMs: (attempt) => 1_000 * 2 ** attempt,
      rateLimits: 2,
      rateLimitDelayMs: () => 5_000,
    },
    sleep: async (ms) => void waits.push(ms),
    now: () => NOW,
  };
  const failures: RequestFailure[] = [];
  const send = (method: "GET" | "POST", body?: unknown) =>
    requestJson(client, {
      url: `${BASE}/things/7`,
      method,
      headers: { Authorization: "Bearer test" },
      ...(body === undefined ? {} : { body }),
      schema: ThingSchema,
      fail: (failure) => {
        failures.push(failure);
        return new Error(`failed: ${failure.kind}`);
      },
    });
  return { ...fake, waits, failures, send };
}

describe("requestJson", () => {
  it("sends the method, headers and JSON body and returns the validated answer", async () => {
    const h = setup({ "POST /things/7": { body: { thing: { id: 7 }, extra: true } } });
    await expect(h.send("POST", { name: "x" })).resolves.toEqual({ thing: { id: 7 } });
    expect(h.calls).toEqual([
      {
        method: "POST",
        url: `${BASE}/things/7`,
        path: "/things/7",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: { name: "x" },
      },
    ]);
  });

  it("gives every attempt its own timeout signal", async () => {
    const signals: AbortSignal[] = [];
    const client: JsonClient = {
      fetch: async (_input, init) => {
        signals.push(init?.signal as AbortSignal);
        return signals.length === 1
          ? new Response("busy", { status: 503 })
          : Response.json({ thing: { id: 1 } });
      },
      timeoutMs: 15_000,
      retry: {
        serverErrors: 1,
        serverErrorDelayMs: () => 0,
        rateLimits: 0,
        rateLimitDelayMs: () => 0,
      },
      sleep: async () => {},
      now: () => NOW,
    };
    await requestJson(client, { url: BASE, schema: ThingSchema, fail: () => new Error("no") });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
  });

  it("repeats a GET after a 5xx, a lost connection and a timeout, then reports the failure", async () => {
    const h = setup(
      {
        "/things/7": [{ status: 502 }, { error: new TypeError("socket hang up") }, { hang: true }],
      },
      5,
    );
    await expect(h.send("GET")).rejects.toThrow("failed: unreachable");
    expect(h.calls).toHaveLength(3);
    expect(h.waits).toEqual([1_000, 2_000]);
    expect(h.failures).toEqual([
      expect.objectContaining({ kind: "unreachable", timedOut: true, idempotent: true }),
    ]);
  });

  it("reports a GET that keeps failing with 5xx by its last answer", async () => {
    const h = setup({ "/things/7": { status: 500, body: { error: "down" } } });
    await expect(h.send("GET")).rejects.toThrow("failed: status");
    expect(h.calls).toHaveLength(3);
    const failure = h.failures[0] as Extract<RequestFailure, { kind: "status" }>;
    expect(failure.response.status).toBe(500);
    expect(failure.idempotent).toBe(true);
    await expect(failure.response.json()).resolves.toEqual({ error: "down" });
  });

  it.each<[string, FakeReply]>([
    ["a 5xx", { status: 503 }],
    ["a lost connection", { error: new TypeError("fetch failed") }],
    ["a timeout", { hang: true }],
  ])("never repeats a POST after %s", async (_what, reply) => {
    const h = setup({ "POST /things/7": [reply, { body: { thing: { id: 7 } } }] }, 5);
    await expect(h.send("POST", {})).rejects.toThrow("failed:");
    expect(h.calls).toHaveLength(1);
    expect(h.waits).toEqual([]);
    expect(h.failures[0]?.idempotent).toBe(false);
  });

  it("says whether an unanswered request timed out or lost its connection", async () => {
    const lost = setup({ "POST /things/7": { error: new TypeError("fetch failed") } });
    await expect(lost.send("POST", {})).rejects.toThrow();
    expect(lost.failures[0]).toMatchObject({ kind: "unreachable", timedOut: false });
    const slow = setup({ "POST /things/7": { hang: true } }, 5);
    await expect(slow.send("POST", {})).rejects.toThrow();
    expect(slow.failures[0]).toMatchObject({ kind: "unreachable", timedOut: true });
  });

  it("repeats any request answered with 429, waiting until RateLimit-Reset (at most 60 s)", async () => {
    const reset = (seconds: number) => ({ "RateLimit-Reset": String(NOW / 1000 + seconds) });
    const h = setup({
      "POST /things/7": [
        { status: 429, headers: reset(3) },
        { status: 429, headers: reset(600) },
        { body: { thing: { id: 7 } } },
      ],
    });
    await expect(h.send("POST", {})).resolves.toEqual({ thing: { id: 7 } });
    expect(h.waits).toEqual([3_000, 60_000]);
  });

  it("waits the client's delay after a 429 without RateLimit-Reset, then reports it", async () => {
    const h = setup({ "/things/7": { status: 429 } });
    await expect(h.send("GET")).rejects.toThrow("failed: status");
    expect(h.calls).toHaveLength(3);
    expect(h.waits).toEqual([5_000, 5_000]);
  });

  it("reports an answer that is not JSON and one that does not match the schema", async () => {
    const text = setup({ "/things/7": { text: "<html>" } });
    await expect(text.send("GET")).rejects.toThrow("failed: invalid-json");
    const wrong = setup({ "/things/7": { body: { thing: { id: "7" } } } });
    await expect(wrong.send("GET")).rejects.toThrow("failed: unexpected");
    expect(wrong.failures[0]).toMatchObject({ kind: "unexpected" });
    expect((wrong.failures[0] as { issues: string }).issues).toMatch(/^thing\.id: /);
  });

  it("reports a 4xx at once, without retrying", async () => {
    const h = setup({ "/things/7": { status: 404 } });
    await expect(h.send("GET")).rejects.toThrow("failed: status");
    expect(h.calls).toHaveLength(1);
  });
});

describe("pollAction", () => {
  function clock() {
    let now = NOW;
    const waits: number[] = [];
    return {
      waits,
      now: () => now,
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    };
  }

  it("reads until the action is finished and returns its last state", async () => {
    const states = ["running", "running", "done"];
    const c = clock();
    const action = await pollAction({
      read: async () => states.shift() as string,
      finished: (state) => state === "done",
      timedOut: () => new Error("too slow"),
      timeoutMs: 60_000,
      intervalMs: 2_000,
      ...c,
    });
    expect(action).toBe("done");
    expect(c.waits).toEqual([2_000, 2_000]);
  });

  it("stops with what finished throws", async () => {
    await expect(
      pollAction({
        read: async () => "error",
        finished: () => {
          throw new Error("the action failed");
        },
        timedOut: () => new Error("too slow"),
        timeoutMs: 60_000,
        intervalMs: 2_000,
        ...clock(),
      }),
    ).rejects.toThrow("the action failed");
  });

  it("gives up after the timeout, shortening the last wait to keep the deadline", async () => {
    const c = clock();
    await expect(
      pollAction({
        read: async () => "running",
        finished: () => false,
        timedOut: (state) => new Error(`still ${state}`),
        timeoutMs: 5_000,
        intervalMs: 2_000,
        ...c,
      }),
    ).rejects.toThrow("still running");
    expect(c.waits).toEqual([2_000, 2_000, 1_000]);
  });
});
