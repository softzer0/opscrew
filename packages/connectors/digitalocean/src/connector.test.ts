import type { ServerSnapshotApi, VpsConnector } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  action,
  type FakeReply,
  fakeClock,
  fakeFetch,
  fakeSleep,
  fixture,
} from "./__fixtures__/fake-fetch";
import { DigitalOceanCatalog, StaticDigitalOceanCatalog } from "./catalog";
import { DigitalOceanClient } from "./client";
import { DIGITALOCEAN_CREDENTIALS, digitaloceanConnector } from "./connector";

const token = fakeSecret("digitalocean-token");
const otherToken = fakeSecret("digitalocean-token", "access");
const ctx = { phase: "design" as const, projectRoot: "/tmp/project" };
const SNAPSHOT_NAME = "opscrew-shop-before-destroy-20261012T100000Z";

// Type-level check: the connector satisfies the provider-neutral contract.
const typeCheck = digitaloceanConnector({ env: {} }) satisfies VpsConnector;

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string | undefined> = { DIGITALOCEAN_TOKEN: token },
  extra: { redactor?: Redactor; clock?: ReturnType<typeof fakeClock> } = {},
) {
  const fake = fakeFetch(routes);
  const clock = extra.clock;
  return {
    connector: digitaloceanConnector({
      env,
      fetch: fake.fetch,
      sleep: clock?.sleep ?? fakeSleep().sleep,
      ...(clock && { now: () => new Date(clock.now()) }),
      ...(extra.redactor && { redactor: extra.redactor }),
    }),
    calls: fake.calls,
  };
}

function account(overrides: Record<string, unknown>) {
  const base = (fixture("account.json") as { account: Record<string, unknown> }).account;
  return { body: { account: { ...base, ...overrides } } };
}

describe("digitaloceanConnector credentials", () => {
  it("satisfies VpsConnector and describes the least-privilege token", () => {
    expectTypeOf(typeCheck).toExtend<VpsConnector>();
    expectTypeOf(typeCheck.servers).toEqualTypeOf<ServerSnapshotApi | undefined>();
    expectTypeOf(typeCheck.client).toEqualTypeOf<DigitalOceanClient | undefined>();
    const { connector: c } = connector({});
    expect(c.id).toBe("digitalocean");
    expect(c.displayName).toBe("DigitalOcean");
    expect(c.credentials).toBe(DIGITALOCEAN_CREDENTIALS);
    expect(DIGITALOCEAN_CREDENTIALS).toMatchObject({
      envVars: ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"],
      createUrl: "https://cloud.digitalocean.com/account/api/tokens",
      scopes: [
        "account:read",
        "regions:read",
        "sizes:read",
        "actions:read",
        "droplet:create",
        "droplet:read",
        "droplet:update",
        "droplet:delete",
        "ssh_key:create",
        "ssh_key:read",
        "ssh_key:delete",
        "firewall:create",
        "firewall:read",
        "firewall:update",
        "firewall:delete",
        "tag:create",
        "tag:read",
        "tag:delete",
        "image:create",
        "image:read",
        "snapshot:read",
      ],
    });
  });

  it("prefers DIGITALOCEAN_TOKEN over DIGITALOCEAN_ACCESS_TOKEN", async () => {
    const { connector: c, calls } = connector(
      { "/v2/account": { body: fixture("account.json") } },
      { DIGITALOCEAN_TOKEN: token, DIGITALOCEAN_ACCESS_TOKEN: otherToken },
    );
    await c.verifyCredentials();
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("falls back to DIGITALOCEAN_ACCESS_TOKEN and ignores blank values", async () => {
    const redactor = new Redactor();
    const { connector: c, calls } = connector(
      { "/v2/account": { body: fixture("account.json") } },
      { DIGITALOCEAN_TOKEN: "  ", DIGITALOCEAN_ACCESS_TOKEN: otherToken },
      { redactor },
    );
    expect(c.configured).toBe(true);
    await c.verifyCredentials();
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${otherToken}`);
    expect(redactor.redact(`x ${otherToken} y`)).toContain("DIGITALOCEAN_ACCESS_TOKEN");
  });

  it("registers the token with the shared redactor", () => {
    const redactor = new Redactor();
    connector({}, { DIGITALOCEAN_TOKEN: token }, { redactor });
    expect(redactor.redact(`token=${token}`)).not.toContain(token);
  });

  it("without a token: not configured, no client or servers, static catalogue, clear message", async () => {
    const { connector: c, calls } = connector({}, {});
    expect(c.configured).toBe(false);
    expect(c.client).toBeUndefined();
    expect(c.servers).toBeUndefined();
    expect(c.catalog()).toBeInstanceOf(StaticDigitalOceanCatalog);
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("DIGITALOCEAN_TOKEN is not set");
    expect(check.message).toContain("https://cloud.digitalocean.com/account/api/tokens");
    expect(check.message).toContain("image:create");
    expect(calls).toHaveLength(0);
  });

  it("with a token: configured, a client, servers and the live catalogue (cached)", () => {
    const { connector: c } = connector({});
    expect(c.configured).toBe(true);
    expect(c.client).toBeInstanceOf(DigitalOceanClient);
    expect(c.servers).toBeDefined();
    expect(c.catalog()).toBeInstanceOf(DigitalOceanCatalog);
    expect(c.catalog()).toBe(c.catalog());
  });
});

describe("digitaloceanConnector.verifyCredentials", () => {
  it("accepts an active account and names the team, never the email", async () => {
    const { connector: c, calls } = connector({ "/v2/account": { body: fixture("account.json") } });
    const check = await c.verifyCredentials();
    expect(check).toMatchObject({ ok: true, identity: "Shop Team" });
    expect(JSON.stringify(check)).not.toContain("sammy@example.com");
    expect(calls[0]?.url.pathname).toBe("/v2/account");
  });

  it("calls an account without a team a personal account", async () => {
    const { connector: c } = connector({ "/v2/account": account({ team: null }) });
    expect(await c.verifyCredentials()).toMatchObject({ ok: true, identity: "personal account" });
  });

  it("never uses a team name that is an email address as the identity", async () => {
    const { connector: c } = connector({
      "/v2/account": account({ team: { uuid: "t", name: "sammy@example.com" } }),
    });
    const check = await c.verifyCredentials();
    expect(check.identity).toBe("team account");
    expect(JSON.stringify(check)).not.toContain("sammy@example.com");
  });

  it("accepts a warning account and passes the status message on", async () => {
    const { connector: c } = connector({
      "/v2/account": account({
        status: "warning",
        status_message: "Payment overdue; contact sammy@example.com",
      }),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(true);
    expect(check.message).toContain("Payment overdue");
    expect(check.message).not.toContain("sammy@example.com");
  });

  it("rejects a locked account with the fix", async () => {
    const { connector: c } = connector({
      "/v2/account": account({ status: "locked", status_message: "Account suspended." }),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("locked");
    expect(check.message).toContain("Account suspended.");
    expect(check.message).toContain("https://cloud.digitalocean.com/account");
  });

  it("rejects an unverified email address without printing it", async () => {
    const { connector: c } = connector({ "/v2/account": account({ email_verified: false }) });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("email address is not verified");
    expect(JSON.stringify(check)).not.toContain("sammy@example.com");
  });

  it("reports an invalid token without leaking it", async () => {
    const { connector: c } = connector({
      "/v2/account": {
        status: 401,
        body: { id: "unauthorized", message: `token ${token} is invalid` },
      },
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("DigitalOcean rejected the API token");
    expect(check.message).not.toContain(token);
  });

  it("reports a token without the account scope with the scope list", async () => {
    const { connector: c } = connector({
      "/v2/account": { status: 403, body: { id: "forbidden", message: "not authorized" } },
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("account:read");
    expect(check.message).toContain("snapshot:read");
    expect(check.message).not.toContain(token);
  });
});

describe("digitaloceanConnector.servers", () => {
  it("finds Droplets tagged for the app that also carry managed-by:opscrew", async () => {
    const { connector: c, calls } = connector({
      "/v2/droplets": { body: fixture("droplets.json") },
    });
    const servers = await c.servers?.findAppServers("shop");
    expect(servers).toEqual([{ id: "3164444", name: "shop-web", status: "active" }]);
    expect(calls[0]?.url.searchParams.get("tag_name")).toBe("opscrew-app:shop");
  });

  it("snapshots a Droplet: action, wait, then the newest snapshot with that name", async () => {
    const clock = fakeClock();
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/3164444/actions": { status: 201, body: action(555, "in-progress") },
        "/v2/actions/555": [
          { body: action(555, "in-progress") },
          { body: action(555, "completed") },
        ],
        "/v2/droplets/3164444/snapshots": { body: fixture("snapshots.json") },
      },
      undefined,
      { clock },
    );
    const result = await c.servers?.snapshotServer("3164444", {
      name: SNAPSHOT_NAME,
      description: "Before destroy",
      labels: { "managed-by": "opscrew" },
    });
    expect(result).toEqual({ snapshotId: "6372399" });
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /v2/droplets/3164444/actions",
      "GET /v2/actions/555",
      "GET /v2/actions/555",
      "GET /v2/droplets/3164444/snapshots",
    ]);
    expect(calls[0]?.body).toEqual({ type: "snapshot", name: SNAPSHOT_NAME });
    expect(clock.waits).toEqual([5000]);
  });

  it("stops with a PROVIDER_ERROR when the snapshot action errors", async () => {
    const { connector: c, calls } = connector({
      "POST /v2/droplets/7/actions": { status: 201, body: action(1, "in-progress") },
      "/v2/actions/1": { body: action(1, "errored") },
    });
    const error = (await c.servers
      ?.snapshotServer("7", { name: "snap", description: "d", labels: {} })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("failed");
    expect(calls.some((call) => call.url.pathname.endsWith("/snapshots"))).toBe(false);
  });

  it("honours the request timeout", async () => {
    const clock = fakeClock();
    const { connector: c } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(1, "in-progress") },
        "/v2/actions/1": { body: action(1, "in-progress") },
      },
      undefined,
      { clock },
    );
    const error = (await c.servers
      ?.snapshotServer("7", { name: "snap", description: "d", labels: {}, timeoutMs: 60_000 })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not finish within 1 minute");
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it("waits 15 minutes by default", async () => {
    const clock = fakeClock();
    const { connector: c } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(1, "in-progress") },
        "/v2/actions/1": { body: action(1, "in-progress") },
      },
      undefined,
      { clock },
    );
    const error = (await c.servers
      ?.snapshotServer("7", { name: "snap", description: "d", labels: {} })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.message).toContain("15 minutes");
  });

  it("re-reads the snapshot list when the new snapshot is not listed yet", async () => {
    const clock = fakeClock();
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(1, "completed") },
        "/v2/actions/1": { body: action(1, "completed") },
        "/v2/droplets/7/snapshots": [
          { body: { snapshots: [] } },
          { body: { snapshots: [{ id: 99, name: "snap", created_at: "2026-10-12T10:10:00Z" }] } },
        ],
      },
      undefined,
      { clock },
    );
    const result = await c.servers?.snapshotServer("7", {
      name: "snap",
      description: "d",
      labels: {},
    });
    expect(result).toEqual({ snapshotId: "99" });
    expect(calls.filter((call) => call.url.pathname.endsWith("/snapshots"))).toHaveLength(2);
    expect(clock.waits).toEqual([5000]);
  });

  it("ignores a same-named snapshot created before the action started", async () => {
    const clock = fakeClock();
    const older = { id: 50, name: "snap", created_at: "2026-10-12T09:00:00Z" };
    const { connector: c } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(1, "completed") },
        "/v2/actions/1": { body: action(1, "completed") },
        "/v2/droplets/7/snapshots": [
          { body: { snapshots: [older] } },
          {
            body: {
              snapshots: [older, { id: 51, name: "snap", created_at: "2026-10-12T10:15:00Z" }],
            },
          },
        ],
      },
      undefined,
      { clock },
    );
    const result = await c.servers?.snapshotServer("7", {
      name: "snap",
      description: "d",
      labels: {},
    });
    expect(result).toEqual({ snapshotId: "51" });
  });

  it("says the snapshot was most likely created when it never shows up", async () => {
    const clock = fakeClock();
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(1, "completed") },
        "/v2/actions/1": { body: action(1, "completed") },
        "/v2/droplets/7/snapshots": { body: { snapshots: [{ id: 1, name: "other" }] } },
      },
      undefined,
      { clock },
    );
    const error = (await c.servers
      ?.snapshotServer("7", { name: "snap", description: "d", labels: {} })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain('could not find a snapshot named "snap"');
    expect(error.message).toContain("most likely created");
    expect(error.hint).toContain("Snapshots tab");
    expect(error.hint).toContain("before taking another snapshot");
    expect(`${error.message} ${error.hint}`).not.toMatch(/try again/i);
    expect(calls.filter((call) => call.url.pathname.endsWith("/snapshots"))).toHaveLength(4);
    expect(clock.waits).toEqual([5000, 5000, 5000]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("rejects a non-numeric server id without calling the API", async () => {
    const { connector: c, calls } = connector({});
    const error = (await c.servers
      ?.snapshotServer("../account", { name: "snap", description: "d", labels: {} })
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("digitaloceanConnector.tools", () => {
  it("exposes two read-only tools that return redacted live data", async () => {
    const { connector: c } = connector({
      "/v2/sizes?page=1": { body: fixture("sizes-page1.json") },
      "/v2/sizes?page=2": { body: fixture("sizes-page2.json") },
      "/v2/regions": {
        body: {
          regions: [
            { slug: "fra1", name: `leaked ${token}`, available: true, sizes: ["s-1vcpu-1gb"] },
            { slug: "zzz9", name: `leaked ${token}`, available: true, sizes: ["s-1vcpu-1gb"] },
          ],
        },
      },
    });
    const tools = c.tools();
    expect(tools.map((t) => t.name)).toEqual([
      "digitalocean_list_locations",
      "digitalocean_list_offers",
    ]);
    expect(tools.every((t) => t.mutates === false)).toBe(true);
    const [listLocations, listOffers] = tools;

    const locations = await listLocations?.handler(listLocations.inputSchema.parse({}), ctx);
    expect(locations?.text).toContain("fra1");
    expect(locations?.text).not.toContain(token);

    const offers = await listOffers?.handler(
      listOffers.inputSchema.parse({ location: "lon1" }),
      ctx,
    );
    expect(offers?.text).toContain("Live data from the DigitalOcean API");
    expect(offers?.text).toContain('"s-2vcpu-4gb"');
    expect(offers?.text).not.toContain('"c-2"');
  });

  it("uses the dated static table without a token", async () => {
    const { connector: c, calls } = connector({}, {});
    const tool = c.tools().find((t) => t.name === "digitalocean_list_offers");
    const result = await tool?.handler({ location: "fra1" }, ctx);
    expect(result?.isError).toBeUndefined();
    expect(result?.text).toContain("2026-10-12");
    expect(result?.text).toContain("DIGITALOCEAN_TOKEN not set");
    expect(result?.text).toContain('"s-1vcpu-1gb"');
    expect(calls).toHaveLength(0);
  });

  it("returns redacted tool errors", async () => {
    const { connector: c } = connector({
      "/v2/regions": { status: 403, body: { id: "forbidden", message: `no ${token}` } },
    });
    const result = await c.tools()[0]?.handler({}, ctx);
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("HTTP 403");
    expect(result?.text).toContain("regions:read");
    expect(result?.text).not.toContain(token);
  });
});
