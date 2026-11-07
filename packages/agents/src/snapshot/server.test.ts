import type {
  AppServer,
  ComputeCatalog,
  FetchLike,
  ServerSnapshot,
  ServerSnapshotApi,
  SnapshotRequest,
} from "@opscrew/contracts";
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type CloudProvider, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { networked, splitPlan } from "../network/__fixtures__/plans";
import { inEnvironment } from "../promote/__fixtures__/world";
import { ownPlan, portainerPlan, SERVER_IPV4, testPlan } from "../testing";
import {
  DATA_IPV4,
  everythingShown,
  type SnapshotWorld,
  snapshotWorld,
  splitStagingPlan,
  stagingPlan,
} from "./__fixtures__/world";
import { restoreServerSnapshot, type ServerSnapshotServices, takeServerSnapshot } from "./server";

const TOKEN = fakeSecret("hcloud-token");

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

/** OpsCrew's snapshot of the app's server, taken before. */
const EARLIER: ServerSnapshot = {
  id: "770011",
  name: "OpsCrew snapshot of shop-staging (staging)",
  createdAt: "2026-11-05T08:00:00Z",
  sizeGb: 2,
  labels: { "created-by": "opscrew" },
};

/**
 * The provider of the app's servers `shop-staging` (id 42) and `shop-staging-data` (id 43), as the
 * connectors' fakes answer: every call is recorded in `events`; `fail` makes one throw.
 */
function fakeServerApi(
  o: {
    snapshots?: ServerSnapshot[];
    fail?: Partial<Record<string, Error>>;
    /** The app's server's id (default 42). */
    appId?: string;
    /** The billed size of the snapshot it takes (default 2.5 GB). */
    takenGb?: number;
  } = {},
) {
  const events: string[] = [];
  const requests: SnapshotRequest[] = [];
  const snapshots = [...(o.snapshots ?? [EARLIER])];
  const appId = o.appId ?? "42";
  const servers: AppServer[] = [
    { id: appId, name: "shop-staging", status: "running" },
    { id: "43", name: "shop-staging-data", status: "running" },
  ];
  const step = async (name: string) => {
    events.push(name);
    const error = o.fail?.[name.split(" ")[0] ?? ""];
    if (error !== undefined) throw error;
  };
  const api: ServerSnapshotApi = {
    findAppServers: async () => servers,
    snapshotServer: async (serverId, request) => {
      requests.push(request);
      await step(`snapshot ${serverId}`);
      snapshots.push({
        id: "880022",
        name: request.description,
        createdAt: "2026-11-07T12:00:00Z",
        sizeGb: o.takenGb ?? 2.5,
        labels: request.labels,
      });
      return { snapshotId: "880022" };
    },
    listSnapshots: async (serverId) => (serverId === appId ? snapshots : []),
    deleteSnapshot: async () => {
      throw new Error("not in these tests");
    },
    rebuild: async (serverId, snapshotId) => step(`rebuild ${serverId} ${snapshotId}`),
    powerOff: async (serverId) => step(`powerOff ${serverId}`),
    powerOn: async (serverId) => step(`powerOn ${serverId}`),
  };
  return { api, events, requests };
}

/** A price catalogue with the plan's server types and the providers' snapshot rates. */
function fakeCatalog(provider: CloudProvider): ComputeCatalog {
  const currency = provider === "hetzner" ? "EUR" : "USD";
  return {
    provider,
    listOffers: async (location) => [
      {
        provider,
        id: provider === "hetzner" ? "cx23" : "s-1vcpu-2gb",
        vcpus: 2,
        memoryGb: 4,
        diskGb: 40,
        cpuType: "shared",
        architecture: "x86",
        location: location ?? "nbg1",
        monthly: { amount: 4, currency },
        pricesIncludeVat: false,
        deprecated: false,
        available: true,
        source: "live",
        asOf: "2026-11-07T00:00:00Z",
      },
    ],
    extras: async () => ({
      snapshotPerGbMonth: { amount: provider === "hetzner" ? 0.011 : 0.06, currency },
      ...(provider === "digitalocean" ? { snapshotRateAsOf: "2026-11-06T00:00:00.000Z" } : {}),
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-11-07T00:00:00Z",
    }),
  };
}

/** The world's services with `api` as every provider's server API and the fake catalogue. */
function services(
  world: SnapshotWorld,
  api: ServerSnapshotApi | undefined,
  extra: Partial<ServerSnapshotServices> = {},
): ServerSnapshotServices {
  return {
    ...world.services,
    serverSnapshots: () => api,
    catalog: fakeCatalog,
    sleep: async () => {},
    ...extra,
  };
}

/** A fetch answering the app's health endpoint with `statuses` in turn (the last one repeated). */
function health(statuses: number[]): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      const status = statuses.length > 1 ? (statuses.shift() as number) : (statuses[0] ?? 200);
      return new Response(status === 200 ? "ok" : "starting", { status });
    },
  };
}

describe("opscrew snapshot --server", () => {
  it("takes the app's server's snapshot while it runs, with the warning, price and volumes", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi();
    const taken = await takeServerSnapshot(world.deps, {
      services: services(world, provider.api),
    });

    expect(taken).toEqual({
      id: "880022",
      where: "at Hetzner Cloud (server shop-staging)",
      server: { provider: "hetzner", id: "42", name: "shop-staging" },
      sizeGb: 2.5,
      monthly: { amount: 2.5 * 0.011, currency: "EUR" },
    });
    expect(provider.events).toEqual(["snapshot 42"]);
    expect(world.handler.requests).toEqual([]);
    expect(provider.requests[0]?.labels).toMatchObject({
      "created-by": "opscrew",
      app: "shop-staging",
      env: "staging",
    });
    expect(provider.requests[0]?.name).toMatch(/^opscrew-shop-staging-\d{8}T\d{6}Z$/);
    const text = world.deps.reporter.text();
    expect(text).toContain("A live snapshot may not be consistent");
    expect(text).toContain(
      "It costs up to €0.44 a month: the server's 40 GB disk at €0.011 per GB per month, excl. VAT.",
    );
    expect(text).toContain("volumes attached to it at Hetzner Cloud are not included");
    expect(text).toContain("(2.5 GB, €0.03 a month excl. VAT)");
    expect(world.deps.audit.entries.map((entry) => entry.action)).toEqual([
      "create snapshot",
      "snapshot ready",
    ]);
  });

  it("with --stop, approves the downtime first, then shuts down, snapshots and starts again", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi();
    world.handler.requests.length = 0;
    await takeServerSnapshot(world.deps, { stop: true, services: services(world, provider.api) });

    expect(world.handler.requests).toHaveLength(1);
    expect(world.handler.requests[0]?.title).toBe(
      "Maintenance window: shut down the server shop-staging of staging for a snapshot",
    );
    expect(world.handler.requests[0]?.details).toContain("the app is offline meanwhile");
    expect(provider.events).toEqual(["powerOff 42", "snapshot 42", "powerOn 42"]);
  });

  it("with --stop not approved, stops and takes nothing", async () => {
    const world = await snapshotWorld(stagingPlan([]), { answer: () => false });
    const provider = fakeServerApi();
    const error = await failure(
      takeServerSnapshot(world.deps, { stop: true, services: services(world, provider.api) }),
    );
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe("Nothing was stopped. No snapshot was taken.");
    expect(provider.events).toEqual([]);
  });

  it("with --stop, starts the server again when the snapshot fails, and says so", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi({ fail: { snapshot: new Error("image quota reached") } });
    const error = await failure(
      takeServerSnapshot(world.deps, { stop: true, services: services(world, provider.api) }),
    );
    expect(provider.events).toEqual(["powerOff 42", "snapshot 42", "powerOn 42"]);
    expect(error.message).toContain("image quota reached");
    expect(error.message).toContain("The server was started again.");
  });

  it("with --stop, tries to start the server when its shutdown did not finish", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi({
      fail: {
        powerOff: new Error("Hetzner server 42 was not off within 5 minutes: it is running."),
      },
    });
    const error = await failure(
      takeServerSnapshot(world.deps, { stop: true, services: services(world, provider.api) }),
    );
    expect(provider.events).toEqual(["powerOff 42", "powerOn 42"]);
    expect(error.message).toContain("was not off within 5 minutes: it is running");
    expect(error.message).toContain("OpsCrew asked the server to start again");
    expect(error.message).not.toContain("was started again");
  });

  it.each([
    ["the snapshot", { snapshot: new Error("image quota reached") }],
    ["the shutdown", { powerOff: new Error("server is locked") }],
  ])("says the server may be off when %s and the start both fail", async (_what, fail) => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi({ fail: { ...fail, powerOn: new Error("API unavailable") } });
    const error = await failure(
      takeServerSnapshot(world.deps, { stop: true, services: services(world, provider.api) }),
    );
    expect(provider.events.at(-1)).toBe("powerOn 42");
    expect(error.message).toContain("Starting the server again failed too (API unavailable)");
    expect(error.message).toContain(
      "it may be off and the app offline: check it in the Hetzner Cloud Console and start it there",
    );
  });

  it("says the server is off when it cannot be started again", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi({ fail: { powerOn: new Error("server is locked") } });
    const error = await failure(
      takeServerSnapshot(world.deps, { stop: true, services: services(world, provider.api) }),
    );
    expect(error.message).toContain("took the snapshot 880022");
    expect(error.message).toContain("It is off, so the app is offline.");
    expect(error.hint).toContain("Start the server in the Hetzner Cloud Console");
  });

  it("takes an extra server's snapshot with --server-name, and refuses an unknown one", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    const provider = fakeServerApi();
    const taken = await takeServerSnapshot(world.deps, {
      serverName: "data",
      services: services(world, provider.api),
    });
    expect(taken.server).toEqual({ provider: "hetzner", id: "43", name: "shop-staging-data" });
    expect(provider.events).toEqual(["snapshot 43"]);

    const error = await failure(
      takeServerSnapshot(world.deps, {
        serverName: "cache",
        services: services(world, provider.api),
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toContain("Name one of data with --server-name");
  });

  it("shows DigitalOcean's published rate in dollars", async () => {
    const world = await snapshotWorld(
      stagingPlan([], { base: testPlan({ deployed: true, provider: "digitalocean" }) }),
    );
    const provider = fakeServerApi();
    await takeServerSnapshot(world.deps, { services: services(world, provider.api) });
    const text = world.deps.reporter.text();
    expect(text).toContain(
      "the Droplet's 40 GB disk at $0.06 per GB per month, excl. tax (the published rate of 2026-11-06)",
    );
    expect(text).toContain("volumes attached to it at DigitalOcean are not included");
  });

  it("says under €0.01 for a price two decimals would show as nothing", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const taken = await takeServerSnapshot(world.deps, {
      services: services(world, fakeServerApi({ takenGb: 0.2 }).api),
    });
    expect(taken.monthly?.amount).toBeCloseTo(0.0022);
    expect(world.deps.reporter.text()).toContain("(0.2 GB, under €0.01 a month excl. VAT)");
  });

  it("needs the provider's token", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const error = await failure(
      takeServerSnapshot(world.deps, { services: services(world, undefined) }),
    );
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("HCLOUD_TOKEN");
  });

  it("refuses while a deploy runs, before anything is taken", async () => {
    const world = await snapshotWorld(stagingPlan([]), {
      runs: [{ status: "in_progress", htmlUrl: "https://github.com/acme/shop/actions/runs/7" }],
    });
    const provider = fakeServerApi();
    const error = await failure(
      takeServerSnapshot(world.deps, { services: services(world, provider.api) }),
    );
    expect(error.message).toContain("deploy workflow is queued or in progress");
    expect(provider.events).toEqual([]);
  });
});

describe("--server refused where OpsCrew created no server", () => {
  const plans = {
    "your own server": () =>
      stagingPlan([], { base: { ...ownPlan({ deployed: true }), services: [] } }),
    "your Portainer": () => stagingPlan([], { base: portainerPlan({ deployed: true }) }),
    "this computer": () => stagingPlan([], { base: { ...localPlan(), services: [] } }),
  };

  it.each(Object.entries(plans))("on %s, naming the data snapshot", async (_where, plan) => {
    const world = await snapshotWorld(plan());
    const provider = fakeServerApi();
    for (const run of [
      () => takeServerSnapshot(world.deps, { services: services(world, provider.api) }),
      () =>
        restoreServerSnapshot(world.deps, "770011", { services: services(world, provider.api) }),
    ]) {
      const error = await failure(run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("only works on a server OpsCrew created");
      expect(error.hint).toContain("`opscrew snapshot` takes a snapshot of the app's data");
    }
    expect(provider.events).toEqual([]);
  });

  it("on an extra server the user owns", async () => {
    const { plan } = networked(splitPlan({ data: "own" }), {
      data: { udpPortsInUse: [], wireguardInterfaces: [] },
    });
    const world = await snapshotWorld(inEnvironment(DeployPlanSchema.parse(plan), "staging"));
    const error = await failure(
      takeServerSnapshot(world.deps, {
        serverName: "data",
        services: services(world, fakeServerApi().api),
      }),
    );
    expect(error.message).toContain("Server data of staging is your own server");
  });

  it.each([
    ["in your Portainer", plans["your Portainer"]],
    ["on this computer", plans["this computer"]],
  ])("with --server-name, says the environment runs %s", async (where, plan) => {
    const world = await snapshotWorld(plan());
    const error = await failure(
      takeServerSnapshot(world.deps, {
        serverName: "data",
        services: services(world, fakeServerApi().api),
      }),
    );
    expect(error.message).toContain(`staging runs ${where}`);
  });
});

describe("opscrew restore --server", () => {
  it("rebuilds the server after the destroy-grade approval, then checks the app answers", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi();
    const app = health([503, 503, 200]);
    world.deps.fetch = app.fetch;
    const restored = await restoreServerSnapshot(world.deps, "770011", {
      services: services(world, provider.api),
    });

    expect(restored).toEqual({
      id: "770011",
      where: "at Hetzner Cloud (server shop-staging)",
      server: { provider: "hetzner", id: "42", name: "shop-staging" },
      checked: true,
    });
    expect(provider.events).toEqual(["rebuild 42 770011"]);
    const [request] = world.handler.requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: "Rebuild the server shop-staging of staging from the snapshot 770011",
      allowDestroy: true,
      confirmPhrase: "shop-staging",
    });
    expect(request?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.details).toContain(`Restore hash: ${request?.planHash}`);
    expect(request?.details).toContain("is lost for good. Its addresses and firewall stay.");
    expect(request?.details).toContain(
      "delete and rebuild protection is lifted for the rebuild and set again right after it",
    );
    expect(request?.details).toContain("Volumes attached to the server are not in the snapshot");
    expect(app.urls).toEqual([
      `http://${SERVER_IPV4}/api/health`,
      `http://${SERVER_IPV4}/api/health`,
      `http://${SERVER_IPV4}/api/health`,
    ]);
    expect(world.deps.audit.entries.map((entry) => entry.action)).toContain("server rebuilt");
    const shown = everythingShown(world);
    expect(shown).toContain("the app answers");
    expect(shown).not.toContain(SERVER_IPV4);
    expect(shown).not.toContain(DATA_IPV4);
    expect(shown).not.toContain(TOKEN);
  });

  it("binds its hash to the snapshot and the server", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const second = { ...EARLIER, id: "770012", createdAt: "2026-11-06T08:00:00Z" };
    const provider = fakeServerApi({ snapshots: [EARLIER, second] });
    world.deps.fetch = health([200]).fetch;
    for (const id of ["770011", "770012"]) {
      await restoreServerSnapshot(world.deps, id, { services: services(world, provider.api) });
    }
    // The same snapshot id on another server, and at another provider.
    await restoreServerSnapshot(world.deps, "770011", {
      services: services(world, fakeServerApi({ appId: "44" }).api),
    });
    const droplet = await snapshotWorld(
      stagingPlan([], { base: testPlan({ deployed: true, provider: "digitalocean" }) }),
    );
    droplet.deps.fetch = health([200]).fetch;
    await restoreServerSnapshot(droplet.deps, "770011", {
      services: services(droplet, fakeServerApi().api),
    });
    const hashes = [...world.handler.requests, ...droplet.handler.requests].map(
      (request) => request.planHash,
    );
    expect(hashes).toHaveLength(4);
    expect(new Set(hashes).size).toBe(4);
    expect(hashes).not.toContain(sha256Hex(""));
  });

  it("needs the provider's token, as taking one does", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const error = await failure(
      restoreServerSnapshot(world.deps, "770011", { services: services(world, undefined) }),
    );
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("HCLOUD_TOKEN");
    expect(world.handler.requests).toEqual([]);
  });

  it("rebuilds nothing unless the server's name is typed", async () => {
    const world = await snapshotWorld(stagingPlan([]), {
      answer: () => ({ approved: true, confirmation: "shop" }),
    });
    const provider = fakeServerApi();
    const error = await failure(
      restoreServerSnapshot(world.deps, "770011", { services: services(world, provider.api) }),
    );
    expect(error.code).toBe("APPROVAL_REFUSED");
    const hash = world.handler.requests[0]?.planHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(error.hint).toContain(
      `type shop-staging (in a script: --confirm shop-staging --approve ${hash}).`,
    );
    expect(provider.events).toEqual([]);
  });

  it("refuses an unknown id and one that is no provider's", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi();
    const unknown = await failure(
      restoreServerSnapshot(world.deps, "999", { services: services(world, provider.api) }),
    );
    expect(unknown.code).toBe("PHASE_PRECONDITION");
    expect(unknown.message).toContain("has no whole-server snapshot 999");
    const data = await failure(
      restoreServerSnapshot(world.deps, "20261106T190000Z", {
        services: services(world, provider.api),
      }),
    );
    expect(data.code).toBe("INVALID_INPUT");
    expect(provider.events).toEqual([]);
  });

  it("passes on a failed rebuild, audited", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    const provider = fakeServerApi({
      fail: { rebuild: new OpsCrewError("PROVIDER_ERROR", "Hetzner action 77 failed") },
    });
    const error = await failure(
      restoreServerSnapshot(world.deps, "770011", { services: services(world, provider.api) }),
    );
    expect(error.message).toBe("Hetzner action 77 failed");
    expect(world.deps.audit.entries.map((entry) => entry.action)).toContain("rebuild failed");
  });

  it("fails plainly when the app does not answer within 5 minutes", async () => {
    const world = await snapshotWorld(stagingPlan([]));
    world.deps.fetch = health([502]).fetch;
    let now = 0;
    const error = await failure(
      restoreServerSnapshot(world.deps, "770011", {
        services: services(world, fakeServerApi().api, {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        }),
      }),
    );
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("but the app did not answer within 5 minutes");
    expect(error.message).toContain("answered with HTTP 502");
    expect(error.hint).toContain("`opscrew logs`");
    expect(`${error.message} ${error.hint}`).not.toContain(SERVER_IPV4);
  });

  it("names no protection on DigitalOcean, which has none", async () => {
    const world = await snapshotWorld(
      stagingPlan([], { base: testPlan({ deployed: true, provider: "digitalocean" }) }),
    );
    world.deps.fetch = health([200]).fetch;
    await restoreServerSnapshot(world.deps, "770011", {
      services: services(world, fakeServerApi().api),
    });
    expect(world.handler.requests[0]?.details).not.toContain("protection");
    expect(world.handler.requests[0]?.title).toContain("Droplet shop-staging");
  });
});
