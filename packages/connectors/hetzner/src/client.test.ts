import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeSleep, fixture, hetznerFetch, param } from "./__fixtures__/fixtures";
import { HetznerClient } from "./client";

const token = fakeSecret("hcloud-token");
const unauthorized = {
  status: 401,
  body: { error: { code: "unauthorized", message: "unable to authenticate" } },
};

function client(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { now?: () => number; version?: string; timeoutMs?: number } = {},
) {
  const fake = hetznerFetch(routes);
  const sleeper = fakeSleep();
  const c = new HetznerClient({ token, fetch: fake.fetch, sleep: sleeper.sleep, ...extra });
  return { client: c, calls: fake.calls, waits: sleeper.waits };
}

describe("HetznerClient", () => {
  it("follows pagination over two pages with per_page=50", async () => {
    const { client: c, calls } = client({
      "/server_types?page=1": { body: fixture("server-types-page1.json") },
      "/server_types?page=2": { body: fixture("server-types-page2.json") },
    });
    const types = await c.listServerTypes();
    expect(types.map((t) => t.name)).toEqual(["cx23", "cpx22", "cx22", "cax11"]);
    expect(calls.map((call) => param(call, "page"))).toEqual(["1", "2"]);
    expect(calls.every((call) => param(call, "per_page") === "50")).toBe(true);
    expect(calls[0]?.url).toMatch(/^https:\/\/api\.hetzner\.cloud\/v1\/server_types\?/);
  });

  it("keeps unknown fields (passthrough) and sends auth and User-Agent headers", async () => {
    const { client: c, calls } = client(
      {
        "/server_types?page=1": { body: fixture("server-types-page1.json") },
        "/server_types?page=2": { body: fixture("server-types-page2.json") },
      },
      { version: "1.2.3" },
    );
    const [first] = await c.listServerTypes();
    expect((first as Record<string, unknown>).future_field).toEqual({ kept: true });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${token}`);
    expect(calls[0]?.headers["User-Agent"]).toBe("opscrew/1.2.3");
  });

  it("uses opscrew/<version> as the default User-Agent", async () => {
    const { client: c, calls } = client({ "/locations": { body: fixture("locations.json") } });
    await c.listLocations();
    expect(calls[0]?.headers["User-Agent"]).toMatch(/^opscrew\/\d+\.\d+\.\d+/);
  });

  it("parses net prices from decimal strings", async () => {
    const { client: c } = client({
      "/server_types?page=1": { body: fixture("server-types-page1.json") },
      "/server_types?page=2": { body: fixture("server-types-page2.json") },
    });
    const [cx23] = await c.listServerTypes();
    expect(cx23?.prices[0]?.price_monthly.net).toBe(5.49);
  });

  it("retries a 429 until RateLimit-Reset, then succeeds", async () => {
    const nowMs = 1_800_000_000_000;
    const {
      client: c,
      calls,
      waits,
    } = client(
      {
        "/locations": [
          {
            status: 429,
            body: { error: { code: "rate_limit_exceeded", message: "limit reached" } },
            headers: { "RateLimit-Reset": String(nowMs / 1000 + 5) },
          },
          { body: fixture("locations.json") },
        ],
      },
      { now: () => nowMs },
    );
    const locations = await c.listLocations();
    expect(locations).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([5000]);
  });

  it("backs off 2^n seconds on 429 without RateLimit-Reset and gives up after 3 retries", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({
      "/locations": {
        status: 429,
        body: { error: { code: "rate_limit_exceeded", message: "slow down" } },
      },
    });
    const error = await c.listLocations().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("PROVIDER_ERROR");
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(calls).toHaveLength(4);
  });

  it("retries 5xx at most twice", async () => {
    const { client: c, calls } = client({
      "/pricing": { status: 503, body: { error: { code: "unavailable", message: "maintenance" } } },
    });
    const error = (await c.getPricing().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("maintenance");
    expect(calls).toHaveLength(3);
  });

  it("recovers from a 5xx followed by success", async () => {
    const { client: c } = client({
      "/pricing": [{ status: 502 }, { body: fixture("pricing.json") }],
    });
    const pricing = await c.getPricing();
    expect(pricing.server_backup?.percentage).toBe(20);
  });

  it("maps 401 to CREDENTIALS_INVALID with the API message and no token", async () => {
    const { client: c, calls } = client({ "/locations": unauthorized });
    const error = (await c.verifyToken().catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("unable to authenticate");
    expect(error.hint).toContain("HCLOUD_TOKEN");
    expect(`${error.message} ${error.hint}`).not.toContain(token);
    expect(calls).toHaveLength(1);
    expect(param(calls[0], "per_page")).toBe("1");
  });

  it("maps other errors to PROVIDER_ERROR", async () => {
    const { client: c } = client({
      "/actions/42": {
        status: 404,
        body: { error: { code: "not_found", message: "action not found" } },
      },
    });
    const error = (await c.getAction(42).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("action not found");
  });

  it("rejects responses that do not match the schema", async () => {
    const { client: c } = client({ "/pricing": { body: { pricing: { nope: true } } } });
    const error = (await c.getPricing().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("unexpected response");
  });

  it("gives every request a 15-second timeout signal by default", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const c = new HetznerClient({
      token,
      fetch: async (_input, init) => {
        seen.push(init?.signal);
        return new Response(JSON.stringify(fixture("locations.json")), { status: 200 });
      },
    });
    await c.listLocations();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("retries a request that never answers, then fails with a plain-English timeout", async () => {
    const { client: c, calls, waits } = client({ "/pricing": { hang: true } }, { timeoutMs: 5 });
    const error = (await c.getPricing().catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not answer within");
    expect(error.message).toContain("/pricing");
    expect(error.hint).toMatch(/try again/i);
    expect(`${error.message} ${error.hint}`).not.toContain(token);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("aborts a hanging fetch through its signal and recovers on the retry", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client(
      { "/pricing": [{ hang: true }, { body: fixture("pricing.json") }] },
      { timeoutMs: 5 },
    );
    const pricing = await c.getPricing();
    expect(pricing.server_backup?.percentage).toBe(20);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });
});
