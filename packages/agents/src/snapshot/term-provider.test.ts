/**
 * Whole-server snapshots at a cloud provider that includes them in the price up to a count, as
 * Contabo does (T2611): the limit, the restore that deletes newer snapshots, and snapshot ids with
 * a colon (`<instance>:<snapshot>`). DigitalOcean's definition stands in for it
 * (`withTermProvider`).
 */
import type { ComputeCatalog, ServerSnapshot, ServerSnapshotApi } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it, vi } from "vitest";
import { testPlan } from "../testing";
import { type SnapshotWorld, snapshotWorld, stagingPlan } from "./__fixtures__/world";
import { deleteSnapshot } from "./delete";
import { restoreSnapshot } from "./restore";
import { restoreServerSnapshot, type ServerSnapshotServices, takeServerSnapshot } from "./server";

vi.mock("@opscrew/providers", async (importOriginal) => {
  const { withTermProvider } = await import("../design/__fixtures__/term-provider");
  return withTermProvider(await importOriginal());
});

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

const OLDER: ServerSnapshot = { id: "42:snapA", createdAt: "2026-11-05T08:00:00Z" };
const NEWER: ServerSnapshot = { id: "42:snapB", createdAt: "2026-11-06T08:00:00Z" };

/** The app's server `shop-staging` (id 42) with `snapshots`, every call recorded in `events`. */
function fakeServerApi(snapshots: ServerSnapshot[]) {
  const events: string[] = [];
  const held = [...snapshots];
  const api: ServerSnapshotApi = {
    findAppServers: async (app) => [{ id: "42", name: app, status: "running" }],
    snapshotServer: async (serverId) => {
      events.push(`snapshot ${serverId}`);
      held.push({ id: "42:snapC", createdAt: "2026-11-07T12:00:00Z" });
      return { snapshotId: "42:snapC" };
    },
    listSnapshots: async (serverId) => (serverId === "42" ? [...held] : []),
    deleteSnapshot: async (id) => {
      events.push(`delete ${id}`);
    },
    rebuild: async (serverId, id) => {
      events.push(`rebuild ${serverId} ${id}`);
    },
    powerOff: async (serverId) => {
      events.push(`powerOff ${serverId}`);
    },
    powerOn: async (serverId) => {
      events.push(`powerOn ${serverId}`);
    },
  };
  return { api, events };
}

/** The plan's Droplet type with 2 snapshots in its price. */
const catalog = (): ComputeCatalog => ({
  provider: "digitalocean",
  listOffers: async (location) => [
    {
      provider: "digitalocean",
      id: "s-1vcpu-2gb",
      vcpus: 1,
      memoryGb: 2,
      diskGb: 50,
      cpuType: "shared",
      architecture: "x86",
      location: location ?? "fra1",
      monthly: { amount: 12, currency: "USD" },
      pricesIncludeVat: false,
      deprecated: false,
      available: true,
      source: "static",
      asOf: "2026-11-11T00:00:00Z",
      includedSnapshots: 2,
    },
  ],
  extras: async () => ({
    snapshotsIncluded: true,
    pricesIncludeVat: false,
    source: "static",
    asOf: "2026-11-11T00:00:00Z",
  }),
});

async function dropletWorld(): Promise<SnapshotWorld> {
  return snapshotWorld(
    stagingPlan([], { base: testPlan({ deployed: true, provider: "digitalocean" }) }),
  );
}

function services(world: SnapshotWorld, api: ServerSnapshotApi): ServerSnapshotServices {
  return {
    ...world.services,
    github: world.services.github as ServerSnapshotServices["github"],
    serverSnapshots: () => api,
    catalog,
    sleep: async () => {},
  };
}

describe("opscrew snapshot --server with snapshots included up to a count", () => {
  it("says the snapshot is included in the price", async () => {
    const world = await dropletWorld();
    const provider = fakeServerApi([OLDER]);
    const taken = await takeServerSnapshot(world.deps, {
      services: services(world, provider.api),
    });
    expect(taken.id).toBe("42:snapC");
    expect(taken.monthly).toBeUndefined();
    const text = world.deps.reporter.text();
    expect(text).toContain("It is included in the Droplet's price, up to 2 snapshots.");
    expect(text).toContain("(included in the Droplet's price)");
    expect(text).not.toContain("per GB");
  });

  it("refuses at the count, naming the oldest to delete, and takes nothing", async () => {
    const world = await dropletWorld();
    const provider = fakeServerApi([NEWER, OLDER]);
    const error = await failure(
      takeServerSnapshot(world.deps, { services: services(world, provider.api) }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "The Droplet shop-staging already has 2 snapshots at DigitalOcean, as many as its price includes (2).",
    );
    expect(error.hint).toContain(
      "Delete the oldest, 42:snapA taken 2026-11-05 08:00 UTC, with `opscrew snapshot delete 42:snapA",
    );
    expect(error.hint).toContain("Snapshots taken by hand in");
    expect(provider.events).toEqual([]);
  });
});

describe("opscrew restore --server with snapshots included up to a count", () => {
  it("says first that a rebuild from an older snapshot deletes the newer ones", async () => {
    const world = await dropletWorld();
    world.deps.fetch = async () => new Response("ok", { status: 200 });
    const provider = fakeServerApi([OLDER, NEWER]);
    await restoreServerSnapshot(world.deps, OLDER.id, {
      services: services(world, provider.api),
    });
    expect(provider.events).toEqual(["rebuild 42 42:snapA"]);
    const lines = world.handler.requests[0]?.details.split("\n") ?? [];
    expect(lines[1]).toBe(
      "It is not the newest: DigitalOcean deletes the Droplet's snapshots taken after it when it rebuilds from it, 42:snapB and any taken by hand.",
    );
  });

  it("says nothing of newer snapshots for the newest one", async () => {
    const world = await dropletWorld();
    world.deps.fetch = async () => new Response("ok", { status: 200 });
    const provider = fakeServerApi([OLDER, NEWER]);
    await restoreServerSnapshot(world.deps, NEWER.id, {
      services: services(world, provider.api),
    });
    expect(world.handler.requests[0]?.details).not.toContain("not the newest");
  });

  it("refuses an id that is neither a number nor two parts around one colon", async () => {
    const world = await dropletWorld();
    const provider = fakeServerApi([OLDER]);
    for (const id of ["42:a:b", "42:", "../x"]) {
      const error = await failure(
        restoreServerSnapshot(world.deps, id, { services: services(world, provider.api) }),
      );
      expect(error.code).toBe("INVALID_INPUT");
    }
    expect(provider.events).toEqual([]);
  });
});

describe("snapshot ids with a colon", () => {
  it("are deleted at the provider", async () => {
    const world = await dropletWorld();
    const provider = fakeServerApi([OLDER]);
    const deleted = await deleteSnapshot(world.deps, OLDER.id, {
      services: services(world, provider.api),
    });
    expect(deleted.outcome).toBe("deleted");
    expect(provider.events).toEqual([`delete ${OLDER.id}`]);
    expect(world.handler.requests[0]?.confirmPhrase).toBe(OLDER.id);
  });

  it("are looked for only at the provider: no bucket key, no listing on the servers", async () => {
    const world = await snapshotWorld(
      stagingPlan([{ kind: "postgres", name: "db" }], {
        base: testPlan({ deployed: true, provider: "digitalocean" }),
        fields: {
          snapshots: { offsite: { provider: "hetzner", bucket: "shop-backups", region: "fsn1" } },
        },
      }),
    );
    const provider = fakeServerApi([OLDER]);
    const unknown = await failure(
      deleteSnapshot(world.deps, "42:missing", { services: services(world, provider.api) }),
    );
    expect(unknown.code).toBe("PHASE_PRECONDITION");
    expect(unknown.message).toBe("staging has no snapshot 42:missing. Nothing was changed.");
    expect(world.servers.app?.commands).toEqual([]);
    expect(world.handler.requests).toEqual([]);
    expect(provider.events).toEqual([]);
  });

  it("are no data snapshot's, and more than one colon is no id", async () => {
    const world = await dropletWorld();
    const provider = fakeServerApi([OLDER]);
    const data = await failure(
      restoreSnapshot(world.deps, OLDER.id, { services: services(world, provider.api) }),
    );
    expect(data.code).toBe("INVALID_INPUT");
    const two = await failure(
      deleteSnapshot(world.deps, "42:a:b", { services: services(world, provider.api) }),
    );
    expect(two.code).toBe("INVALID_INPUT");
    expect(provider.events).toEqual([]);
  });
});
