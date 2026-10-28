import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  FAKE_VISITOR_IP,
  type FakeWorkerRequest,
  FakeZone,
} from "@opscrew/connector-cloudflare/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { generatedValuesFile } from "../provision/secrets";
import { createTestPhaseDeps, fakeCloudflare } from "../testing";
import { sitePlan } from "../testing/serverless";
import type { LogLine, LogRead } from "./lines";
import { readLogs } from "./read";

/** The test clock's time (`createTestPhaseDeps`). */
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const SSR = sitePlan({ render: "ssr", deployed: true });

/** A request to the Worker `example-app`, `minutes` before the test clock's time. */
function request(id: string, minutes: number, o: Partial<FakeWorkerRequest> = {}) {
  return {
    worker: "example-app",
    requestId: id,
    time: NOW - minutes * 60_000,
    method: "GET",
    url: `https://docs.example.com/api/${id}?token=query-value-0001`,
    status: 200,
    ...o,
  };
}

/** A Cloudflare account with the Worker, OpsCrew's client to it, and deps with its token. */
async function cloudflare(o: { now?: string } = {}) {
  const zone = new FakeZone();
  zone.workers.set("example-app", { versions: [], deployments: [] });
  const client = new CloudflareClient({
    token: fakeSecret("cloudflare-token", "logs"),
    fetch: zone.fetch,
    sleep: async () => undefined,
    webSocket: zone.webSocket,
  });
  const deps = await createTestPhaseDeps(
    o.now === undefined ? {} : { clock: { now: () => new Date(o.now as string) } },
  );
  const services = { cloudflare: fakeCloudflare(), sharedCloudflare: client };
  return { zone, deps, services };
}

async function collect(read: LogRead): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for await (const line of read) lines.push(line);
  return lines;
}

describe("readLogs on Cloudflare's hosting, a server-rendered app", () => {
  it("reads the Worker's past requests, each with its status and outcome, then its lines", async () => {
    const { zone, deps, services } = await cloudflare();
    zone.requests.push(
      request("b", 2, {
        method: "POST",
        status: 500,
        logs: [{ message: "saving the order" }, { message: "the database said no", level: "warn" }],
        exception: { name: "TypeError", message: "x is undefined" },
      }),
      request("a", 5, { logs: [{ message: "hello" }] }),
    );

    const read = await readLogs(deps, SSR, { services });

    expect(await collect(read)).toEqual([
      {
        time: "2026-10-11T11:55:00.000Z",
        service: "example-app",
        stream: "stdout",
        text: "GET /api/a 200 ok",
      },
      { time: "2026-10-11T11:55:00.001Z", service: "example-app", stream: "stdout", text: "hello" },
      {
        time: "2026-10-11T11:58:00.000Z",
        service: "example-app",
        stream: "stderr",
        text: "POST /api/b 500 exception",
      },
      expect.objectContaining({ stream: "stdout", text: "saving the order" }),
      expect.objectContaining({ stream: "stderr", text: "the database said no" }),
      expect.objectContaining({ stream: "stderr", text: "TypeError: x is undefined" }),
    ]);
    // Never the query string, a header or `cf`.
    const text = JSON.stringify(await collect(read));
    expect(text).not.toContain("query-value");
    expect(text).not.toContain(FAKE_VISITOR_IP);
    expect(text).not.toContain("Belgrade");
    // The last 7 days, the newest 200 requests.
    const query = zone.calls.find((call) => call.path.endsWith("/telemetry/query"));
    expect(query?.body).toMatchObject({
      timeframe: { from: NOW - 7 * 86_400_000, to: NOW },
      limit: 200,
    });
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "provider-call", target: "cloudflare" }),
    ]);
  });

  it("states the dated allowance, that lines past it are not kept, and the half-minute delay", async () => {
    const before = await cloudflare();
    const first = (await readLogs(before.deps, SSR, { services: before.services })).first;
    expect(first).toBe(
      "Cloudflare keeps a Worker's logs 3 days on Workers Free, up to 200,000 events a day, and 7 days on Workers Paid, up to 20 million a month; each request and each console line is one event (Cloudflare's prices as of 2026-10-28). On the Free plan, lines past the allowance are not kept, and Cloudflare does not say when that happens. Requests from the last half-minute may not show yet (`--follow` shows them at once).",
    );
    const after = await cloudflare({ now: "2026-12-02T08:00:00.000Z" });
    expect((await readLogs(after.deps, SSR, { services: after.services })).first).toContain(
      "Cloudflare keeps a Worker's logs 7 days, up to 0.5 GB a day on the Free plan (then none until 00:00 UTC) and 50 GB a month on a paid plan (then $0.25 per GB)",
    );
  });

  it("keeps the latest --tail requests, and reads only --since", async () => {
    const { zone, deps, services } = await cloudflare();
    zone.requests.push(
      request("old", 50, { logs: [{ message: "old line" }] }),
      request("new", 1, { logs: [{ message: "one" }, { message: "two" }] }),
    );

    const lines = await collect(await readLogs(deps, SSR, { services, tail: 2, since: "15m" }));

    expect(lines.map((line) => line.text)).toEqual(["GET /api/new 200 ok", "one", "two"]);
    const query = zone.calls.find((call) => call.path.endsWith("/telemetry/query"));
    expect(query?.body).toMatchObject({
      timeframe: { from: NOW - 15 * 60_000, to: NOW },
      limit: 2,
    });
  });

  it("counts --tail in whole requests, never cutting one's lines", async () => {
    const { deps, zone, services } = await cloudflare();
    zone.requests.push(
      request("earlier", 3, { logs: [{ message: "earlier line" }] }),
      request("latest", 1, { logs: [{ message: "first" }, { message: "second" }] }),
    );

    const lines = await collect(await readLogs(deps, SSR, { services, tail: 1 }));

    // A cut by lines would keep only "second", without its request.
    expect(lines.map((line) => line.text)).toEqual(["GET /api/latest 200 ok", "first", "second"]);
  });

  it("follows new requests through the Worker's live tail until aborted, then deletes it", async () => {
    const { zone, deps, services } = await cloudflare();
    zone.requests.push(request("past", 3));
    zone.tailRequests.push(
      request("live-1", 0, { logs: [{ message: "live line" }] }),
      request("live-2", 0, { exception: { name: "Error", message: "boom" }, status: 500 }),
    );
    const controller = new AbortController();

    const read = await readLogs(deps, SSR, {
      services,
      follow: true,
      signal: controller.signal,
    });
    const seen: string[] = [];
    for await (const line of read) {
      seen.push(line.text);
      if (seen.length === 5) controller.abort();
    }

    expect(seen).toEqual([
      "GET /api/past 200 ok",
      "GET /api/live-1 200 ok",
      "live line",
      "GET /api/live-2 500 exception",
      "Error: boom",
    ]);
    expect(zone.tails.size).toBe(0);
    expect(zone.sockets).toHaveLength(1);
    expect(zone.sockets[0]?.closeCalls).toBe(1);
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({ kind: "provider-call", detail: "example-app, following" }),
    ]);
  });

  it("masks a registered secret and a token-shaped value in console lines", async () => {
    const session = "session-value-not-shaped-like-a-token-0002";
    const token = fakeSecret("github-token", "worker-logs");
    const { zone, deps, services } = await cloudflare();
    const file = generatedValuesFile(deps);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ env: { SESSION_SECRET: session } })}\n`);
    zone.requests.push(
      request("a", 1, { logs: [{ message: `session ${session}` }, { message: `token ${token}` }] }),
    );

    const lines = await collect(await readLogs(deps, SSR, { services }));

    const text = JSON.stringify(lines);
    expect(text).not.toContain(session);
    expect(text).not.toContain(token);
    expect(lines.map((line) => line.text)).toEqual([
      "GET /api/a 200 ok",
      expect.stringMatching(/^session \[REDACTED[^\]]*\]$/),
      expect.stringMatching(/^token \[REDACTED[^\]]*\]$/),
    ]);
  });

  it("names the permission Cloudflare refused", async () => {
    const { zone, deps, services } = await cloudflare();
    zone.denied.add("logs");
    const error = await readLogs(deps, SSR, { services }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CREDENTIALS_INVALID",
      hint: expect.stringContaining("Workers Observability → Read"),
    });
  });

  it("takes no --service but the Worker's own", async () => {
    const { deps, services } = await cloudflare();
    await expect(readLogs(deps, SSR, { services, service: "edge" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("one part on Cloudflare's hosting"),
    });
    const read = await readLogs(deps, SSR, { services, service: "example-app" });
    expect(await collect(read)).toEqual([]);
  });
});
