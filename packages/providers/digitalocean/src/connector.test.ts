import type { ServerSnapshotApi, VpsConnector } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  action,
  digitaloceanFetch,
  fakeClock,
  fakeSleep,
  fixture,
  param,
} from "./__fixtures__/fixtures";
import { DigitalOceanCatalog, StaticDigitalOceanCatalog } from "./catalog";
import { DigitalOceanClient } from "./client";
import { DIGITALOCEAN_CREDENTIALS, digitaloceanConnector } from "./connector";

const token = fakeSecret("digitalocean-token");
const otherToken = fakeSecret("digitalocean-token", "access");
const SNAPSHOT_NAME = "opscrew-shop-before-destroy-20261012T100000Z";

// Type-level check: the connector satisfies the provider-neutral contract.
const typeCheck = digitaloceanConnector({ env: {} }) satisfies VpsConnector;

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string | undefined> = { DIGITALOCEAN_TOKEN: token },
  extra: { redactor?: Redactor; clock?: ReturnType<typeof fakeClock> } = {},
) {
  const fake = digitaloceanFetch(routes);
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
    expect(calls[0]?.path).toBe("/v2/account");
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
    expect(param(calls[0], "tag_name")).toBe("opscrew-app:shop");
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
    expect(calls.map((call) => `${call.method} ${call.path.split("?")[0]}`)).toEqual([
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
    expect(calls.some((call) => call.path.startsWith("/v2/droplets/7/snapshots"))).toBe(false);
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
    expect(calls.filter((call) => call.path.startsWith("/v2/droplets/7/snapshots"))).toHaveLength(
      2,
    );
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
    expect(calls.filter((call) => call.path.startsWith("/v2/droplets/7/snapshots"))).toHaveLength(
      4,
    );
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

function errorOf(promise: Promise<unknown> | undefined): Promise<OpsCrewError> {
  return (promise ?? Promise.resolve()).then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as OpsCrewError,
  );
}

function textOf(error: OpsCrewError): string {
  return `${error.message} ${error.hint ?? ""}`;
}

describe("digitaloceanConnector.servers snapshots and rebuilds", () => {
  it("lists OpsCrew's snapshots of a Droplet oldest first, with sizes where known", async () => {
    const { connector: c, calls } = connector({
      "/v2/droplets/3164444/snapshots": {
        body: {
          snapshots: [
            { id: 3, name: "opscrew-shop-c", created_at: "2026-10-12T11:00:00Z" },
            {
              id: 1,
              name: "opscrew-shop-a",
              created_at: "2026-10-12T10:05:00Z",
              size_gigabytes: 2.34,
            },
            { id: 4, name: "my-own-snapshot", created_at: "2026-10-12T10:00:00Z" },
            {
              id: 2,
              name: "opscrew-shop-b",
              created_at: "2026-10-12T10:20:00Z",
              size_gigabytes: "1.5",
            },
          ],
        },
      },
    });
    expect(await c.servers?.listSnapshots("3164444")).toEqual([
      { id: "1", createdAt: "2026-10-12T10:05:00Z", sizeGb: 2.34 },
      { id: "2", createdAt: "2026-10-12T10:20:00Z", sizeGb: 1.5 },
      { id: "3", createdAt: "2026-10-12T11:00:00Z" },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("deletes a snapshot and resolves on DigitalOcean's 204", async () => {
    const { connector: c, calls } = connector({ "DELETE /v2/snapshots/6372399": { status: 204 } });
    await expect(c.servers?.deleteSnapshot("6372399")).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /v2/snapshots/6372399",
    ]);
  });

  it("names the snapshot scopes after a 403 on a deletion or a rebuild", async () => {
    const forbidden = {
      status: 403,
      body: { id: "forbidden", message: "You are not authorized to perform this operation" },
    };
    const { connector: c } = connector({
      "DELETE /v2/snapshots/6372399": forbidden,
      "POST /v2/droplets/7/actions": forbidden,
    });
    for (const attempt of [
      c.servers?.deleteSnapshot("6372399"),
      c.servers?.rebuild("7", "6372399"),
    ]) {
      const error = await errorOf(attempt);
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain(
        "This needs a token with the scopes snapshot:delete, droplet:admin",
      );
      expect(error.hint).toContain("DigitalOcean's API settings");
      expect(textOf(error)).not.toContain(token);
    }
  });

  it("sends a deletion and a rebuild once after a 5xx and says they may already be done", async () => {
    const failing = { status: 503, body: { id: "service_unavailable", message: "try later" } };
    const { connector: c, calls } = connector({
      "DELETE /v2/snapshots/6372399": failing,
      "POST /v2/droplets/7/actions": failing,
    });
    for (const attempt of [
      c.servers?.deleteSnapshot("6372399"),
      c.servers?.rebuild("7", "6372399"),
    ]) {
      const error = await errorOf(attempt);
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.hint).toContain("The change may still have been made");
    }
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /v2/snapshots/6372399",
      "POST /v2/droplets/7/actions",
    ]);
  });

  it("says a snapshot it cannot find may have been deleted, without the token", async () => {
    const { connector: c, calls } = connector({
      "DELETE /v2/snapshots/6372399": {
        status: 404,
        body: { id: "not_found", message: "The resource you requested could not be found." },
      },
    });
    const error = await errorOf(c.servers?.deleteSnapshot("6372399"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("HTTP 404");
    expect(error.hint).toContain("may have been deleted");
    expect(textOf(error)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  it("rebuilds a Droplet from the snapshot and waits for the action", async () => {
    const clock = fakeClock();
    const rebuilding = (status: string) => ({ body: action(556, status, { type: "rebuild" }) });
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/3164444/actions": { status: 201, ...rebuilding("in-progress") },
        "/v2/actions/556": [rebuilding("in-progress"), rebuilding("completed")],
      },
      undefined,
      { clock },
    );
    expect(await c.servers?.rebuild("3164444", "6372399")).toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v2/droplets/3164444/actions",
      "GET /v2/actions/556",
      "GET /v2/actions/556",
    ]);
    expect(calls[0]?.body).toEqual({ type: "rebuild", image: 6372399 });
    expect(clock.waits).toEqual([5000]);
  });

  it("stops with a PROVIDER_ERROR when the rebuild action errors", async () => {
    const { connector: c } = connector({
      "POST /v2/droplets/7/actions": { status: 201, body: action(2, "in-progress") },
      "/v2/actions/2": { body: action(2, "errored", { type: "rebuild" }) },
    });
    const error = await errorOf(c.servers?.rebuild("7", "6372399"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("(rebuild) failed");
    expect(error.hint).toContain("DigitalOcean control panel");
  });

  it("gives up on a rebuild after 15 minutes", async () => {
    const clock = fakeClock();
    const { connector: c } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(2, "in-progress") },
        "/v2/actions/2": { body: action(2, "in-progress", { type: "rebuild" }) },
      },
      undefined,
      { clock },
    );
    const error = await errorOf(c.servers?.rebuild("7", "6372399"));
    expect(error.message).toContain("did not finish within 15 minutes");
    expect(error.hint).toContain("may still be running");
  });

  it("says plainly that a refused backup must be converted to a snapshot first", async () => {
    const { connector: c, calls } = connector({
      "POST /v2/droplets/7/actions": {
        status: 422,
        body: {
          id: "unprocessable_entity",
          message: "You specified an invalid image for Droplet creation.",
        },
      },
    });
    const error = await errorOf(c.servers?.rebuild("7", "900"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("invalid image");
    expect(error.hint).toMatch(
      /^Fix the value DigitalOcean named above and try again\. If image 900 is one of the Droplet's backups/,
    );
    expect(error.hint).toContain("convert it to a snapshot first");
    expect(textOf(error)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  it("says a Droplet it cannot find may have been deleted", async () => {
    const { connector: c } = connector({
      "POST /v2/droplets/7/actions": {
        status: 404,
        body: { id: "not_found", message: "The resource you requested could not be found." },
      },
    });
    const error = await errorOf(c.servers?.rebuild("7", "6372399"));
    expect(error.hint).toContain("may have been deleted");
  });

  it("rejects non-numeric ids without calling the API", async () => {
    const { connector: c, calls } = connector({});
    expect((await errorOf(c.servers?.listSnapshots("x"))).code).toBe("INVALID_INPUT");
    expect((await errorOf(c.servers?.deleteSnapshot("../account"))).code).toBe("INVALID_INPUT");
    expect((await errorOf(c.servers?.rebuild("7", "ubuntu-24-04-x64"))).code).toBe("INVALID_INPUT");
    expect((await errorOf(c.servers?.powerOff("7/x"))).code).toBe("INVALID_INPUT");
    expect((await errorOf(c.servers?.powerOn("7/x"))).code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("digitaloceanConnector.servers power", () => {
  const droplet = (status: string) => ({ body: { droplet: { id: 7, name: "shop", status } } });

  it("shuts down gracefully, then waits until the Droplet is off", async () => {
    const clock = fakeClock();
    const shutdown = (status: string) => ({ body: action(60, status, { type: "shutdown" }) });
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, ...shutdown("in-progress") },
        "/v2/actions/60": shutdown("completed"),
        "/v2/droplets/7": [droplet("active"), droplet("off")],
      },
      undefined,
      { clock },
    );
    await expect(c.servers?.powerOff("7")).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v2/droplets/7/actions",
      "GET /v2/actions/60",
      "GET /v2/droplets/7",
      "GET /v2/droplets/7",
    ]);
    expect(calls[0]?.body).toEqual({ type: "shutdown" });
  });

  it("stops waiting after 5 minutes, naming the state, and never forces the power off", async () => {
    const clock = fakeClock();
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, body: action(60, "in-progress") },
        "/v2/actions/60": { body: action(60, "completed", { type: "shutdown" }) },
        "/v2/droplets/7": droplet("active"),
      },
      undefined,
      { clock },
    );
    const error = await errorOf(c.servers?.powerOff("7"));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("was not off within 5 minutes: it is active");
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.body)).toEqual([{ type: "shutdown" }]);
    expect(textOf(error)).not.toContain(token);
  });

  it("shares one 5-minute deadline between the shutdown's action and the status", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const shutdown = (status: string) => ({ body: action(60, status, { type: "shutdown" }) });
    // The action takes 4 minutes (48 polls 5 seconds apart), then the Droplet stays active.
    const { connector: c } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, ...shutdown("in-progress") },
        "/v2/actions/60": [
          ...Array.from({ length: 48 }, () => shutdown("in-progress")),
          shutdown("completed"),
        ],
        "/v2/droplets/7": droplet("active"),
      },
      undefined,
      { clock },
    );
    const error = await errorOf(c.servers?.powerOff("7"));
    expect(error.message).toContain("was not off within 5 minutes: it is active");
    expect(clock.now() - start).toBe(5 * 60_000);
  });

  it("powers on and waits for the action", async () => {
    const clock = fakeClock();
    const on = (status: string) => ({ body: action(61, status, { type: "power_on" }) });
    const { connector: c, calls } = connector(
      {
        "POST /v2/droplets/7/actions": { status: 201, ...on("in-progress") },
        "/v2/actions/61": [on("in-progress"), on("completed")],
      },
      undefined,
      { clock },
    );
    await expect(c.servers?.powerOn("7")).resolves.toBeUndefined();
    expect(calls[0]?.body).toEqual({ type: "power_on" });
    expect(calls).toHaveLength(3);
  });
});

describe("digitaloceanConnector.catalog", () => {
  it("uses the dated static table without a token", async () => {
    const { connector: c, calls } = connector({}, {});
    const offers = await c.catalog().listOffers("fra1");
    expect(offers.map((o) => o.id)).toContain("s-1vcpu-1gb");
    expect(offers.every((o) => o.source === "static")).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
