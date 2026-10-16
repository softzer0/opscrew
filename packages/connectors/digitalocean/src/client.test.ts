import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  action,
  digitaloceanFetch,
  fakeClock,
  fakeSleep,
  fixture,
  param,
} from "./__fixtures__/fixtures";
import { DIGITALOCEAN_SCOPES, DigitalOceanClient } from "./client";

const token = fakeSecret("digitalocean-token");
const NOW_MS = Date.UTC(2026, 9, 12, 10, 0, 0);

function client(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { now?: () => number; version?: string; timeoutMs?: number } = {},
) {
  const fake = digitaloceanFetch(routes);
  const sleeper = fakeSleep();
  const c = new DigitalOceanClient({
    token,
    fetch: fake.fetch,
    sleep: sleeper.sleep,
    now: () => NOW_MS,
    ...extra,
  });
  return { client: c, calls: fake.calls, waits: sleeper.waits };
}

/** A client whose sleeps advance its clock, for polling tests. */
function pollingClient(routes: Record<string, FakeReply | FakeReply[]>) {
  const clock = fakeClock();
  const fake = digitaloceanFetch(routes);
  const c = new DigitalOceanClient({
    token,
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { client: c, calls: fake.calls, waits: clock.waits };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  expect(`${opsError.message} ${opsError.hint ?? ""}`).not.toContain(token);
  return opsError;
}

const sizesRoutes = {
  "/v2/sizes?page=1": { body: fixture("sizes-page1.json") },
  "/v2/sizes?page=2": { body: fixture("sizes-page2.json") },
};

describe("DigitalOceanClient requests", () => {
  it("sends the bearer token, JSON accept and User-Agent headers to the v2 API", async () => {
    const { client: c, calls } = client(
      { "/v2/account": { body: fixture("account.json") } },
      { version: "1.2.3" },
    );
    const account = await c.getAccount();
    expect(account.status).toBe("active");
    expect(account.team?.name).toBe("Shop Team");
    expect((account as Record<string, unknown>).future_field).toEqual({ kept: true });
    expect(calls[0]?.url).toBe("https://api.digitalocean.com/v2/account");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "opscrew/1.2.3",
    });
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
  });

  it("honours a custom base URL", async () => {
    const fake = fakeFetch(
      { "/v2/account": { body: fixture("account.json") } },
      { base: "http://localhost:9999" },
    );
    const c = new DigitalOceanClient({
      token,
      fetch: fake.fetch,
      baseUrl: "http://localhost:9999/",
    });
    await c.getAccount();
    expect(fake.calls[0]?.url).toBe("http://localhost:9999/v2/account");
  });
});

describe("DigitalOceanClient pagination", () => {
  it("follows links.pages.next with per_page=200 and keeps unknown fields", async () => {
    const { client: c, calls } = client(sizesRoutes);
    const sizes = await c.listSizes();
    expect(sizes.map((s) => s.slug)).toEqual([
      "s-1vcpu-512mb-10gb",
      "s-1vcpu-1gb",
      "s-1vcpu-1gb-intel",
      "s-2vcpu-4gb",
      "s-4vcpu-8gb",
      "c-2",
      "c2-2vcpu-4gb",
      "g-2vcpu-8gb",
      "gpu-h100x1-80gb",
    ]);
    expect(calls.map((call) => param(call, "page"))).toEqual(["1", "2"]);
    expect(calls.every((call) => param(call, "per_page") === "200")).toBe(true);
    expect((sizes[1] as Record<string, unknown>).future_field).toEqual({ kept: true });
    expect(sizes[1]).toMatchObject({ memory: 1024, price_monthly: 6 });
  });

  it("stops at an empty page even when a next link is present", async () => {
    const next = { pages: { next: "https://api.digitalocean.com/v2/regions?page=2" } };
    const { client: c, calls } = client({
      "/v2/regions?page=1": {
        body: { regions: [{ slug: "fra1", available: true, sizes: ["s-1vcpu-1gb"] }], links: next },
      },
      "/v2/regions?page=2": {
        body: {
          regions: [],
          links: { pages: { next: "https://api.digitalocean.com/v2/regions?page=3" } },
        },
      },
    });
    const regions = await c.listRegions();
    expect(regions.map((r) => r.slug)).toEqual(["fra1"]);
    expect(calls).toHaveLength(2);
  });

  it("stops when there is no links object at all", async () => {
    const { client: c, calls } = client({ "/v2/regions": { body: fixture("regions.json") } });
    const regions = await c.listRegions();
    expect(regions).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });
});

describe("DigitalOceanClient Droplets, actions and snapshots", () => {
  it("lists Droplets by tag with string ids and lenient networks", async () => {
    const { client: c, calls } = client({ "/v2/droplets": { body: fixture("droplets.json") } });
    const droplets = await c.listDropletsByTag("opscrew-app:shop");
    expect(param(calls[0], "tag_name")).toBe("opscrew-app:shop");
    expect(droplets.map((d) => d.id)).toEqual(["3164444", "3164445"]);
    expect(droplets[0]?.networks?.v4?.find((n) => n.type === "public")?.ip_address).toBe(
      "203.0.113.10",
    );
    expect(droplets[1]?.networks?.v4?.[0]?.ip_address).toBeUndefined();
  });

  it("starts a snapshot action with a POST body of type and name", async () => {
    const { client: c, calls } = client({
      "POST /v2/droplets/3164444/actions": { status: 201, body: action(36804745, "in-progress") },
    });
    const started = await c.snapshotDroplet("3164444", "opscrew-shop-before-destroy");
    expect(started).toMatchObject({
      id: "36804745",
      status: "in-progress",
      resource_id: "3164444",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ type: "snapshot", name: "opscrew-shop-before-destroy" });
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("waits for an action, polling every 5 seconds", async () => {
    const {
      client: c,
      calls,
      waits,
    } = pollingClient({
      "/v2/actions/36804745": [
        { body: action(36804745, "in-progress") },
        { body: action(36804745, "in-progress") },
        { body: action(36804745, "completed") },
      ],
    });
    const done = await c.waitForAction("36804745", { timeoutMs: 60_000 });
    expect(done.status).toBe("completed");
    expect(waits).toEqual([5000, 5000]);
    expect(calls).toHaveLength(3);
  });

  it("throws a PROVIDER_ERROR when the action errored", async () => {
    const { client: c } = client({ "/v2/actions/9": { body: action(9, "errored") } });
    const error = await failure(c.waitForAction(9, { timeoutMs: 60_000 }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("action 9 (snapshot) failed");
    expect(error.hint).toContain("control panel");
  });

  it("throws a PROVIDER_ERROR when the action does not finish in time", async () => {
    const { client: c, waits } = pollingClient({
      "/v2/actions/9": { body: action(9, "in-progress") },
    });
    const error = await failure(c.waitForAction(9, { timeoutMs: 12_000 }));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not finish within 12 seconds");
    expect(waits).toEqual([5000, 5000, 2000]);
  });

  it("lists a Droplet's snapshots with string ids", async () => {
    const { client: c, calls } = client({
      "/v2/droplets/3164444/snapshots": { body: fixture("snapshots.json") },
    });
    const snapshots = await c.listDropletSnapshots(3164444);
    expect(snapshots.map((s) => s.id)).toEqual(["6372321", "6372399", "6372400"]);
    expect(param(calls[0], "per_page")).toBe("200");
  });
});

describe("DigitalOceanClient errors", () => {
  it("maps 401 to CREDENTIALS_INVALID without the token, even if the API echoes it", async () => {
    const { client: c, calls } = client({
      "/v2/account": {
        status: 401,
        body: { id: "unauthorized", message: `Unable to authenticate you (${token}).` },
      },
    });
    const error = await failure(c.getAccount());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("DigitalOcean rejected the API token");
    expect(error.message).toContain("Unable to authenticate you");
    expect(error.hint).toContain("DIGITALOCEAN_TOKEN");
    expect(error.hint).toContain("https://cloud.digitalocean.com/account/api/tokens");
    expect(calls).toHaveLength(1);
  });

  it("maps 403 to a missing-scope error that lists every scope", async () => {
    const { client: c } = client({
      "/v2/sizes": {
        status: 403,
        body: { id: "forbidden", message: "You are not authorized to perform this operation." },
      },
    });
    const error = await failure(c.listSizes());
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("HTTP 403");
    expect(error.message).toContain("missing a scope");
    for (const scope of DIGITALOCEAN_SCOPES) expect(error.hint).toContain(scope);
    expect(error.hint).toContain("https://cloud.digitalocean.com/account/api/tokens");
  });

  it("maps 404 to a PROVIDER_ERROR", async () => {
    const { client: c } = client({
      "/v2/droplets/42/snapshots": {
        status: 404,
        body: { id: "not_found", message: "The resource you were accessing could not be found." },
      },
    });
    const error = await failure(c.listDropletSnapshots("42"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("HTTP 404");
    expect(error.message).toContain("could not be found");
  });

  it("maps 422 to a PROVIDER_ERROR carrying the API message, and never retries a POST", async () => {
    const { client: c, calls } = client({
      "POST /v2/droplets/7/actions": {
        status: 422,
        body: { id: "unprocessable_entity", message: "Droplet already has a pending event." },
      },
    });
    const error = await failure(c.snapshotDroplet(7, "snap"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Droplet already has a pending event.");
    expect(calls).toHaveLength(1);
  });

  it("waits until ratelimit-reset after a 429 and retries once", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({
      "/v2/account": [
        {
          status: 429,
          body: { id: "too_many_requests", message: "API Rate limit exceeded." },
          headers: { "ratelimit-reset": String(NOW_MS / 1000 + 7) },
        },
        { body: fixture("account.json") },
      ],
    });
    const account = await c.getAccount();
    expect(account.status).toBe("active");
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([7000]);
  });

  it("waits at most 60 seconds and gives up after one retry with a plain rate-limit error", async () => {
    const {
      client: c,
      calls,
      waits,
    } = client({
      "/v2/account": {
        status: 429,
        body: { id: "too_many_requests", message: "API Rate limit exceeded." },
        headers: { "ratelimit-reset": String(NOW_MS / 1000 + 3600) },
      },
    });
    const error = await failure(c.getAccount());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("rate limit reached");
    expect(error.hint).toMatch(/try again/i);
    expect(waits).toEqual([60_000]);
    expect(calls).toHaveLength(2);
  });

  it("retries a rate-limited POST once (it was not accepted)", async () => {
    const { client: c, calls } = client({
      "POST /v2/droplets/7/actions": [
        { status: 429, body: { id: "too_many_requests", message: "slow down" } },
        { status: 201, body: action(1, "in-progress") },
      ],
    });
    const started = await c.snapshotDroplet(7, "snap");
    expect(started.id).toBe("1");
    expect(calls).toHaveLength(2);
  });

  it("turns a network failure into a PROVIDER_ERROR that suggests retrying (GET retried once)", async () => {
    const { client: c, calls } = client({
      "/v2/regions": { error: new TypeError(`fetch failed for ${token}`) },
    });
    const error = await failure(c.listRegions());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Could not reach the DigitalOcean API");
    expect(error.hint).toMatch(/try again/i);
    expect(calls).toHaveLength(2);
  });

  it("never repeats a POST after a network failure", async () => {
    const { client: c, calls } = client({
      "POST /v2/droplets/7/actions": { error: new TypeError("socket hang up") },
    });
    const error = await failure(c.snapshotDroplet(7, "snap"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.hint).toContain("may still have been made");
    expect(calls).toHaveLength(1);
  });

  it("gives up on a request that never answers", async () => {
    const { client: c } = client({ "/v2/account": { hang: true } }, { timeoutMs: 5 });
    const error = await failure(c.getAccount());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not answer within");
  });

  it("retries a 5xx on a GET once, then reports it", async () => {
    const { client: c, calls } = client({
      "/v2/account": { status: 503, body: { id: "service_unavailable", message: "maintenance" } },
    });
    const error = await failure(c.getAccount());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("HTTP 503");
    expect(error.message).toContain("maintenance");
    expect(calls).toHaveLength(2);
  });

  it("never suggests a plain retry after a 5xx on the snapshot POST", async () => {
    const { client: c, calls } = client({
      "POST /v2/droplets/7/actions": {
        status: 500,
        body: { id: "server_error", message: "Server was unable to give you a response." },
      },
    });
    const error = await failure(c.snapshotDroplet(7, "snap"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("HTTP 500");
    expect(error.hint).toBe(
      "The change may still have been made: check the DigitalOcean control panel before trying again.",
    );
    expect(calls).toHaveLength(1);
  });

  it("gives the control-panel hint for an unreadable or unexpected snapshot POST response", async () => {
    const hint =
      "The change may still have been made: check the DigitalOcean control panel before trying again.";
    const shape = client({ "POST /v2/droplets/7/actions": { status: 201, body: { nope: 1 } } });
    const shapeError = await failure(shape.client.snapshotDroplet(7, "snap"));
    expect(shapeError.message).toContain("unexpected response");
    expect(shapeError.hint).toContain(hint);

    const text = client({ "POST /v2/droplets/7/actions": { status: 201, text: "not json" } });
    const jsonError = await failure(text.client.snapshotDroplet(7, "snap"));
    expect(jsonError.message).toContain("invalid JSON");
    expect(jsonError.hint).toBe(hint);
  });

  it("rejects responses that do not match the schema", async () => {
    const { client: c } = client({ "/v2/account": { body: { account: { nope: true } } } });
    const error = await failure(c.getAccount());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("unexpected response");
  });
});
