import { errorText, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS,
  CLOUDFLARE_HOSTING_PERMISSIONS,
  CloudflareClient,
  CloudflareError,
} from "./client";
import { cloudflareConnector } from "./connector";
import { FAKE_ACCOUNT_ID as ACCOUNT_ID, FakeZone, FAKE_ZONE_ID as ZONE_ID } from "./testing";

const TOKEN = fakeSecret("cloudflare-token");
const WORKER = "example-app";
const SCRIPT = `/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER}`;
const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const SHA_OLD = "a".repeat(64);
const SHA_NEW = "b".repeat(64);

/** A fake account whose Worker has two versions with OpsCrew's messages, the newer one active. */
function setup() {
  const zone = new FakeZone();
  zone.workers.set(WORKER, {
    versions: [
      {
        id: NEW,
        created_on: "2026-10-23T10:00:00.000000Z",
        message: `opscrew run-2 ${SHA_NEW}`,
      },
      {
        id: OLD,
        created_on: "2026-10-22T10:00:00.000000Z",
        message: `opscrew run-1 ${SHA_OLD}`,
        source: "terraform",
      },
    ],
    deployments: [
      {
        id: "d2",
        created_on: "2026-10-23T10:00:05.000000Z",
        source: "wrangler",
        strategy: "percentage",
        versions: [{ version_id: NEW, percentage: 100 }],
      },
      {
        id: "d1",
        created_on: "2026-10-22T10:00:05.000000Z",
        source: "wrangler",
        strategy: "percentage",
        versions: [{ version_id: OLD, percentage: 100 }],
      },
    ],
  });
  zone.workerDomains.push(
    {
      id: "dom-1",
      hostname: "example.com",
      service: WORKER,
      zone_id: ZONE_ID,
      zone_name: "example.com",
    },
    {
      id: "dom-2",
      hostname: "docs.example.com",
      service: "other-app",
      zone_id: ZONE_ID,
      zone_name: "example.com",
    },
  );
  const client = new CloudflareClient({ token: TOKEN, fetch: zone.fetch, sleep: async () => {} });
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

describe("CloudflareClient Workers calls", () => {
  it("lists the Worker's versions latest first, each with its message", async () => {
    const { zone, client } = setup();
    expect(await client.listWorkerVersions(ACCOUNT_ID, WORKER)).toEqual([
      {
        id: NEW,
        createdOn: "2026-10-23T10:00:00.000000Z",
        message: `opscrew run-2 ${SHA_NEW}`,
        source: "wrangler",
      },
      {
        id: OLD,
        createdOn: "2026-10-22T10:00:00.000000Z",
        message: `opscrew run-1 ${SHA_OLD}`,
        source: "terraform",
      },
    ]);
    expect(zone.calls.at(-1)).toMatchObject({
      method: "GET",
      path: `${SCRIPT}/versions?per_page=100`,
    });
  });

  it("leaves the message out of a version uploaded without one", async () => {
    const { zone, client } = setup();
    zone.workers.get(WORKER)?.versions.unshift({ id: "v3", created_on: "2026-10-23T11:00:00Z" });
    const [latest] = (await client.listWorkerVersions(ACCOUNT_ID, WORKER)) ?? [];
    expect(latest).toEqual({ id: "v3", createdOn: "2026-10-23T11:00:00Z", source: "wrangler" });
  });

  it("lists the Worker's deployments, the one serving traffic first", async () => {
    const { client } = setup();
    expect(await client.listWorkerDeployments(ACCOUNT_ID, WORKER)).toEqual([
      {
        id: "d2",
        createdOn: "2026-10-23T10:00:05.000000Z",
        versions: [{ id: NEW, percentage: 100 }],
      },
      {
        id: "d1",
        createdOn: "2026-10-22T10:00:05.000000Z",
        versions: [{ id: OLD, percentage: 100 }],
      },
    ]);
  });

  it("rolls back by deploying one version at 100% with OpsCrew's message, sent once", async () => {
    const { zone, client } = setup();
    const message = `opscrew run-3 ${SHA_OLD}`;
    await client.deployWorkerVersion(ACCOUNT_ID, WORKER, OLD, message);
    expect(zone.writes()).toEqual([
      {
        method: "POST",
        path: `${SCRIPT}/deployments`,
        body: {
          strategy: "percentage",
          versions: [{ version_id: OLD, percentage: 100 }],
          annotations: { "workers/message": message },
        },
      },
    ]);
    const [serving] = (await client.listWorkerDeployments(ACCOUNT_ID, WORKER)) ?? [];
    expect(serving?.versions).toEqual([{ id: OLD, percentage: 100 }]);
  });

  it("never sends a rollback again after an unclear answer", async () => {
    const { zone, client } = setup();
    zone.faults.push({
      match: `POST ${SCRIPT}/deployments`,
      reply: { status: 502 },
      applied: true,
    });
    const error = await rejection(client.deployWorkerVersion(ACCOUNT_ID, WORKER, OLD, "m"));
    expect(error.message).toContain("may still have reached Cloudflare");
    expect(zone.writes()).toHaveLength(1);
  });

  it("answers undefined for a Worker the account does not have (404)", async () => {
    const { client } = setup();
    expect(await client.listWorkerVersions(ACCOUNT_ID, "gone-app")).toBeUndefined();
    expect(await client.listWorkerDeployments(ACCOUNT_ID, "gone-app")).toBeUndefined();
    const error = await rejection(client.deployWorkerVersion(ACCOUNT_ID, "gone-app", OLD, "m"));
    expect(error.message).toContain("This Worker does not exist on your account");
  });

  it("throws on any other 404, such as a wrong account", async () => {
    const { client } = setup();
    for (const call of [
      client.listWorkerVersions("0".repeat(32), WORKER),
      client.listWorkerDeployments("0".repeat(32), WORKER),
    ]) {
      const error = await rejection(call);
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("Could not route");
    }
  });

  it("lists only the Worker's own custom domains", async () => {
    const { zone, client } = setup();
    expect(await client.listWorkerCustomDomains(ACCOUNT_ID, WORKER)).toEqual([
      { hostname: "example.com", zoneId: ZONE_ID },
    ]);
    expect(zone.calls.at(-1)?.path).toBe(
      `/accounts/${ACCOUNT_ID}/workers/domains?service=${WORKER}`,
    );
    expect(await client.listWorkerCustomDomains(ACCOUNT_ID, "new-app")).toEqual([]);
  });

  it("names the missing Workers permission on a 403, and never the token", async () => {
    const { zone, client } = setup();
    expect(await client.workersPermissions(ACCOUNT_ID)).toEqual({ missing: [] });
    zone.denied.add("workers");
    expect(await client.workersPermissions(ACCOUNT_ID)).toEqual({
      missing: ["Account → Workers Scripts → Edit"],
    });
    for (const call of [
      client.listWorkerVersions(ACCOUNT_ID, WORKER),
      client.listWorkerDeployments(ACCOUNT_ID, WORKER),
      client.deployWorkerVersion(ACCOUNT_ID, WORKER, OLD, "m"),
      client.listWorkerCustomDomains(ACCOUNT_ID, WORKER),
    ]) {
      const error = await rejection(call);
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain('"Account → Workers Scripts → Edit"');
      expect(`${errorText(error)} ${error.hint}`).not.toContain(TOKEN);
    }
  });

  it("stops on a 401 instead of reporting a missing permission", async () => {
    const { zone, client } = setup();
    zone.faults.push({
      match: `GET /accounts/${ACCOUNT_ID}/workers/scripts`,
      reply: {
        status: 401,
        body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
      },
    });
    expect((await rejection(client.workersPermissions(ACCOUNT_ID))).code).toBe(
      "CREDENTIALS_INVALID",
    );
  });

  it("refuses an answer of an unexpected shape, naming the call", async () => {
    const { zone, client } = setup();
    zone.faults.push({
      match: `GET ${SCRIPT}/versions`,
      reply: { body: { success: true, errors: [], result: { items: [{ id: NEW }] } } },
    });
    const error = await rejection(client.listWorkerVersions(ACCOUNT_ID, WORKER));
    expect(error.message).toContain(`list the versions of the Worker ${WORKER}`);
  });
});

describe("Cloudflare hosting permissions", () => {
  it("adds the Workers and redirect permissions for Cloudflare hosting only, and the deploy token needs only Workers", () => {
    expect(CLOUDFLARE_HOSTING_PERMISSIONS).toEqual([
      "Account → Workers Scripts → Edit (only for Cloudflare hosting)",
      "Zone → Single Redirect → Edit (only for Cloudflare hosting with www)",
    ]);
    expect(CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS).toEqual(["Account → Workers Scripts → Edit"]);
    const { credentials } = cloudflareConnector({ env: {}, fetch: new FakeZone().fetch });
    expect(credentials.scopes).toEqual(expect.arrayContaining([...CLOUDFLARE_HOSTING_PERMISSIONS]));
  });
});
