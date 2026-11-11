import { describe, expect, it } from "vitest";
import { SERVER_IPV4, testPlan } from "../testing";
import { fakeProvider, WHOLE_SERVER } from "./__fixtures__/provider";
import { SH_AVAILABLE } from "./__fixtures__/server";
import {
  DATA_IPV4,
  everythingShown,
  RUNNING,
  type SnapshotWorld,
  snapshotWorld,
  splitStagingPlan,
  stagingPlan,
} from "./__fixtures__/world";
import { listSnapshots, mergeListings, snapshotListLines } from "./list";
import { readListing } from "./store";

const ID = "20261106T190000Z";

/** `about.json` as `snapshot.sh` writes it. */
function about(o: {
  id: string;
  kind?: string;
  taken?: string;
  version?: string;
  services: object[];
}): string {
  return `${JSON.stringify({
    id: o.id,
    kind: o.kind ?? "manual",
    taken: o.taken ?? "2026-11-06T19:00:00Z",
    version: o.version ?? `sha256:${RUNNING}`,
    services: o.services,
  })}\n`;
}

/**
 * A snapshot by hand split over the app's server (Valkey) and `data` (PostgreSQL), both copied off
 * the server, and the app's server's snapshot before a release, not copied.
 */
async function storedSnapshots(world: SnapshotWorld): Promise<void> {
  const { app, data } = world.servers;
  await app?.write(
    `.snapshots/${ID}/about.json`,
    about({ id: ID, services: [{ name: "cache", kind: "valkey", file: "cache.rdb", size: 100 }] }),
  );
  await app?.write(`.snapshots/${ID}/offsite.done`, "");
  await data?.write(
    `.snapshots/${ID}/about.json`,
    about({ id: ID, services: [{ name: "db", kind: "postgres", file: "db.dump", size: 1000 }] }),
  );
  await data?.write(`.snapshots/${ID}/offsite.done`, "");
  const release = "b".repeat(64);
  await app?.write(
    `.snapshots/${release}/about.json`,
    about({
      id: release,
      kind: "release",
      taken: "2026-11-06T10:00:00Z",
      version: `sha256:${"c".repeat(64)}`,
      services: [{ name: "cache", kind: "valkey", skipped: true }],
    }),
  );
  // A snapshot being taken is never listed.
  await app?.write(
    `.snapshots/20261106T200000Z.taking/about.json`,
    about({ id: "x", services: [] }),
  );
}

describe.skipIf(!SH_AVAILABLE)("opscrew snapshot list on servers", () => {
  it("merges each id's parts across the servers, with the provider's whole-server snapshots", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    await storedSnapshots(world);
    const provider = fakeProvider([WHOLE_SERVER]);
    const listed = await listSnapshots(world.deps, {
      services: { ...world.services, serverSnapshots: () => provider.api },
    });

    expect(listed).toEqual([
      {
        id: ID,
        kind: "manual",
        taken: "2026-11-06T19:00:00Z",
        version: `sha256:${RUNNING}`,
        size: 1100,
        services: [
          { name: "cache", kind: "valkey", server: "app", state: "copied", size: 100 },
          { name: "db", kind: "postgres", server: "data", state: "copied", size: 1000 },
        ],
        where: "on the app's server and server data",
        offsite: true,
      },
      {
        id: "b".repeat(64),
        kind: "release",
        taken: "2026-11-06T10:00:00Z",
        version: `sha256:${"c".repeat(64)}`,
        size: 0,
        services: [{ name: "cache", kind: "valkey", server: "app", state: "skipped" }],
        where: "on the app's server",
        offsite: false,
      },
      {
        id: "770011",
        kind: "server",
        taken: "2026-11-05T08:00:00Z",
        version: "",
        size: 2 * 1024 ** 3,
        services: [],
        where: "at Hetzner Cloud (server shop-staging)",
        offsite: false,
        server: { provider: "hetzner", id: "42", name: "shop-staging" },
      },
    ]);
    const shown = `${everythingShown(world)}\n${snapshotListLines(listed).join("\n")}`;
    expect(shown).not.toContain(SERVER_IPV4);
    expect(shown).not.toContain(DATA_IPV4);
  });

  it("says when a provider's token is missing, and lists the data snapshots", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    await world.servers.app?.write(
      `.snapshots/${ID}/about.json`,
      about({ id: ID, services: [{ name: "db", kind: "postgres", file: "db.dump", size: 10 }] }),
    );
    const listed = await listSnapshots(world.deps, {
      services: { ...world.services, serverSnapshots: () => undefined },
    });
    expect(listed.map((entry) => entry.id)).toEqual([ID]);
    expect(world.deps.reporter.text()).toContain(
      "warn: The whole-server snapshots at Hetzner Cloud are not listed: set HCLOUD_TOKEN to list them.",
    );
  });

  it("names the unset variables of a provider's set of credentials", async () => {
    const plan = stagingPlan([{ kind: "postgres", name: "db" }], {
      base: testPlan({ deployed: true, provider: "contabo" }),
    });
    const world = await snapshotWorld(plan);
    const env = { ...world.deps.env, CNTB_OAUTH2_CLIENT_ID: "opscrew", CNTB_OAUTH2_USER: "me" };
    await listSnapshots(
      { ...world.deps, env },
      { services: { ...world.services, serverSnapshots: () => undefined } },
    );
    expect(world.deps.reporter.text()).toContain(
      "warn: The whole-server snapshots at Contabo are not listed: set all of CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS to list them (CNTB_OAUTH2_CLIENT_SECRET and CNTB_OAUTH2_PASS are not set).",
    );
  });

  it("leaves out a record that does not read as the store's, with a warning", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    await world.servers.app?.write(`.snapshots/${ID}/about.json`, '{"id":"bad"}\n');
    const listed = await listSnapshots(world.deps, {
      services: { ...world.services, serverSnapshots: () => undefined },
    });
    expect(listed).toEqual([]);
    expect(world.deps.reporter.text()).toContain(
      "warn: 1 snapshot record on the app's server could not be read, so it is not listed.",
    );
  });
});

describe("the listing", () => {
  it("reads about.json lines and offsite markers, ignoring anything else", () => {
    const listing = readListing(
      [
        about({ id: ID, services: [] }).trim(),
        "offsite 20261106T190000Z",
        "Some line the shell printed",
        "{not json",
        '{"id":"x","kind":"weekly","taken":"2026-11-06T19:00:00Z","version":"","services":[]}',
      ].join("\n"),
    );
    expect(listing.abouts.map((entry) => entry.id)).toEqual([ID]);
    expect([...listing.offsite]).toEqual([ID]);
    expect(listing.unreadable).toBe(2);
  });

  it("has an off-server copy only when every part has one", () => {
    const part = (offsite: boolean) => ({
      abouts: readListing(about({ id: ID, services: [] })).abouts,
      offsite: new Set(offsite ? [ID] : []),
      unreadable: 0,
    });
    const [entry] = mergeListings([
      { name: "the app's server", server: "app", listing: part(true) },
      { name: "server data", server: "data", listing: part(false) },
    ]);
    expect(entry?.offsite).toBe(false);
  });

  it("prints one line per snapshot", () => {
    expect(snapshotListLines([])).toEqual(["No snapshots yet: `opscrew snapshot` takes one."]);
    expect(
      snapshotListLines([
        {
          id: ID,
          kind: "manual",
          taken: "2026-11-06T19:00:00Z",
          version: `sha256:${RUNNING}`,
          size: 2048,
          services: [
            { name: "db", kind: "postgres", state: "copied", size: 2048 },
            { name: "kafka", kind: "kafka", state: "skipped" },
          ],
          where: "in your Portainer",
          offsite: true,
        },
      ]),
    ).toEqual([
      `${ID}: by hand, 2026-11-06 19:00 UTC, version sha256:aaaaaaaaaaaa, 2.0 KB, db, left out: kafka (skipped), in your Portainer, copied off the server`,
    ]);
  });
});
