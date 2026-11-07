import { writeFile } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import { IMAGES, portainerSnapshotsVolume } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
import { PORTAINER_HOST, portainerPlan } from "../testing";
import {
  CACHE_SECRET,
  DB_SECRET,
  PORTAINER_TOKEN,
  type PortainerWorld,
  portainerWorld,
} from "./__fixtures__/portainer";
import { SH_AVAILABLE } from "./__fixtures__/server";
import { everythingShown, RUNNING, stagingPlan } from "./__fixtures__/world";
import { deleteSnapshot } from "./delete";
import { listSnapshots } from "./list";
import { AboutSchema } from "./store";
import { takeSnapshot } from "./take";

const ID = "20261106T190000Z";
const STACK = "opscrew-shop-staging";

/** `shop` in staging in the user's Portainer: PostgreSQL `db`, the stop-only Kafka and SQLite. */
function plan(): DeployPlan {
  return stagingPlan(
    [
      { kind: "postgres", name: "db" },
      { kind: "kafka", name: "kafka" },
    ],
    { sqlite: true, base: portainerPlan({ deployed: true }) },
  );
}

/** The id of a snapshot by hand: the test clock's time. */
const TAKEN_ID = "20261011T120000Z";

/** `opscrew snapshot` in `world`'s Portainer, the stop approved, with {@link RUNNING} running. */
function take(world: PortainerWorld) {
  world.probe.version = RUNNING;
  return takeSnapshot(world.deps, { services: world.services });
}

/** The started container whose script holds `text`. */
function ranWith(world: PortainerWorld, text: string) {
  return world.ran.find((container) => (container.cmd[2] ?? "").includes(text));
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

describe.skipIf(!SH_AVAILABLE)("a snapshot by hand in the user's Portainer", () => {
  it("copies the online parts by one-offs and the stop-only one stopped alone, then writes about.json", async () => {
    const world = await portainerWorld(plan());
    world.copies.set("sqlite.tar", 3);
    const taken = await take(world);

    expect(taken.id).toBe(TAKEN_ID);
    expect(taken.where).toBe("in your Portainer");
    // As the new about.json records them.
    expect(taken.services).toEqual([
      { name: "db", kind: "postgres", state: "copied", size: 15 },
      { name: "kafka", kind: "kafka", state: "copied", size: 17 },
      { name: "sqlite", kind: "sqlite", state: "skipped" },
    ]);
    // The summary names Kafka's data and its size, from Docker's disk usage.
    expect(world.deps.reporter.text()).toContain(
      "- kafka (Apache Kafka) in your Portainer: it stops alone for its copy, up to 120 seconds to stop cleanly; its data, 10 bytes, is copied while it is stopped, and it starts again",
    );
    const about = AboutSchema.parse(
      JSON.parse(world.volume().get(`${TAKEN_ID}/about.json`)?.data?.toString() ?? ""),
    );
    expect(about).toMatchObject({ id: TAKEN_ID, kind: "manual", version: `sha256:${RUNNING}` });
    // Each service's copy with the image the stack pins it to.
    expect(about.services).toEqual([
      { name: "db", kind: "postgres", file: "db.dump", size: 15, image: IMAGES.postgres.ref },
      { name: "kafka", kind: "kafka", file: "kafka.tar", size: 17, image: IMAGES.kafka.ref },
      { name: "sqlite", kind: "sqlite", skipped: true },
    ]);
    expect([...world.volume().keys()].some((path) => path.includes(".taking"))).toBe(false);

    // The database's one-off: its own image, on the stack's network, its data read-only, and the
    // secrets only in the file put through the archive API.
    const db = ranWith(world, "pg_dump");
    expect(db?.image).toBe(IMAGES.postgres.ref);
    expect(db?.network).toBe(`${STACK}_internal`);
    expect(db?.mounts).toEqual([
      {
        type: "volume",
        source: `${STACK}_db_data`,
        target: "/var/lib/postgresql/data",
        readOnly: true,
      },
      {
        type: "volume",
        source: portainerSnapshotsVolume(world.plan),
        target: "/snapshots",
        readOnly: false,
      },
    ]);
    expect(db?.env).toEqual([]);
    expect(db?.cmd.join(" ")).not.toContain(DB_SECRET);
    const [secrets] = world.puts;
    expect(secrets?.map((entry) => [entry.name, entry.mode])).toEqual([
      ["tmp/opscrew-snapshot.env", 0o600],
    ]);
    expect(secrets?.[0]?.data?.toString()).toBe(
      `POSTGRES_USER='app'\nPOSTGRES_DB='app'\nPOSTGRES_PASSWORD='${DB_SECRET}'\n`,
    );
    // SQLite: python with the app's volume, no network.
    const sqlite = ranWith(world, "python");
    expect(sqlite?.network).toBe("none");
    expect(sqlite?.mounts[0]).toEqual({
      type: "volume",
      source: `${STACK}_sqlite`,
      target: "/sqlite",
      readOnly: false,
    });
    // Kafka: stopped with 120 seconds to stop cleanly, tarred read-only, started again.
    const kafka = `${STACK}-kafka`.padEnd(64, "0");
    const stop = world.docker.calls.indexOf(`POST /containers/${kafka}/stop?t=120`);
    const start = world.docker.calls.indexOf(`POST /containers/${kafka}/start`);
    expect(stop).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(stop);
    expect(ranWith(world, "tar -C / -cf")?.mounts).toContainEqual({
      type: "volume",
      source: `${STACK}_kafka_data`,
      target: "/var/lib/kafka/data",
      readOnly: true,
    });
    expect(world.handler.requests.map((request) => request.title)).toEqual([
      "Maintenance window: stop kafka of staging, one at a time, for its copy in a snapshot",
    ]);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "take a snapshot", target: "portainer" }),
    );
    expect(everythingShown(world)).not.toContain(DB_SECRET);
  });

  it("copies nothing of a service Docker had to kill, starts it again and leaves no partial folder", async () => {
    const world = await portainerWorld(plan());
    const kafka = world.docker.containers.get(`${STACK}-kafka`.padEnd(64, "0"));
    if (kafka !== undefined) kafka.exitCode = 137;
    const error = await failure(take(world));

    expect(error.message).toBe(
      "kafka did not stop cleanly within 120 seconds (Docker killed it when the time ran out, or it ran out of memory), so OpsCrew did not copy its files.",
    );
    expect(world.docker.calls).toContain(`POST /containers/${kafka?.id}/start`);
    expect(ranWith(world, "tar -C / -cf")).toBeUndefined();
    expect([...world.volume().keys()].filter((path) => path !== "")).toEqual([]);
  });

  it("waits for a stop-only service to answer its health check again before going on", async () => {
    const world = await portainerWorld(plan());
    const kafka = world.docker.containers.get(`${STACK}-kafka`.padEnd(64, "0"));
    if (kafka === undefined) throw new Error("no kafka");
    kafka.health = "starting";
    let waits = 0;
    world.services.portainer = {
      ...world.services.portainer,
      wait: {
        now: () => waits * 5_000,
        sleep: async () => {
          waits++;
          kafka.health = "healthy";
        },
      },
    };
    const taken = await take(world);
    expect(waits).toBe(1);
    expect(taken.services.find((service) => service.name === "kafka")?.state).toBe("copied");
  });

  it("stops when a stop-only service does not come back healthy, starting nothing else", async () => {
    const world = await portainerWorld(plan());
    const kafka = world.docker.containers.get(`${STACK}-kafka`.padEnd(64, "0"));
    if (kafka === undefined) throw new Error("no kafka");
    kafka.health = "unhealthy";
    let clock = 0;
    world.services.portainer = {
      ...world.services.portainer,
      wait: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    };
    const error = await failure(take(world));
    expect(error.message).toBe(
      "kafka did not run again and answer its health check within 5 minutes of its copy in your Portainer, so OpsCrew stopped no other service.",
    );
    expect(world.volume().has(TAKEN_ID)).toBe(false);
  });

  it("asks for a provision first when the stack's record lacks the snapshots volume", async () => {
    const world = await portainerWorld(plan(), { recorded: false });
    const error = await failure(take(world));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The app's stack in your Portainer has no snapshots volume yet: it was set up before snapshots by hand. No snapshot was taken.",
    );
    expect(error.hint).toContain("Run `opscrew provision` first");
    expect(world.ran).toEqual([]);
  });

  it("shows no output of a failed copy, and leaves no partial folder", async () => {
    const world = await portainerWorld(plan());
    world.copies.set("db.dump", 1);
    const failed = await failure(take(world));
    expect(failed.message).toBe(
      "OpsCrew could not copy db (its output can quote data, so it is not shown) in your Portainer (exit code 1).",
    );
    expect(ranWith(world, "tar -C / -cf")).toBeUndefined();
    expect([...world.volume().keys()].filter((path) => path !== "")).toEqual([]);
  });

  it("changes nothing when this computer lacks a service's secret", async () => {
    const world = await portainerWorld(plan());
    await writeFile(generatedValuesFile(world.deps), JSON.stringify({ services: {} }));
    const error = await failure(take(world));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "OpsCrew does not have the secrets of db on this computer, so it can't copy it. Nothing was changed.",
    );
    expect(ranWith(world, "mkdir")).toBeUndefined();
    expect(world.docker.calls.some((call) => call.includes("/stop"))).toBe(false);
  });
});

describe("snapshot list and delete in the user's Portainer", () => {
  const stored = (id: string, services: object[]) => ({
    id,
    kind: "scheduled",
    taken: "2026-11-06T19:00:00Z",
    version: `sha256:${RUNNING}`,
    services,
  });

  it("lists the volume's snapshots and their off-server copies", async () => {
    const world = await portainerWorld(plan());
    world.store(
      ID,
      stored(ID, [{ name: "db", kind: "postgres", file: "db.dump", size: 10 }]),
      true,
    );
    world.store("20261105T190000Z", {
      ...stored("20261105T190000Z", [{ name: "db", kind: "postgres", failed: true }]),
      taken: "2026-11-05T19:00:00Z",
    });
    const listed = await listSnapshots(world.deps, { services: world.services });

    expect(listed.map((entry) => [entry.id, entry.where, entry.offsite])).toEqual([
      [ID, "in your Portainer", true],
      ["20261105T190000Z", "in your Portainer", false],
    ]);
    expect(listed[1]?.services).toEqual([{ name: "db", kind: "postgres", state: "failed" }]);
    expect(ranWith(world, "about.json")?.mounts[0]).toMatchObject({ readOnly: true });
  });

  it("creates nothing to list when the volume is not there", async () => {
    const world = await portainerWorld(plan(), { volume: false });
    expect(await listSnapshots(world.deps, { services: world.services })).toEqual([]);
    expect(world.ran).toEqual([]);
    expect(world.docker.volumes.has(portainerSnapshotsVolume(world.plan))).toBe(false);
  });

  it("deletes a snapshot after its id is typed, showing no address or secret", async () => {
    const world = await portainerWorld(plan());
    world.store(ID, stored(ID, []));
    const deleted = await deleteSnapshot(world.deps, ID, { services: world.services });

    expect(deleted).toEqual({ id: ID, where: "in your Portainer", outcome: "deleted" });
    expect(world.volume().has(ID)).toBe(false);
    expect(world.handler.requests[0]).toMatchObject({ allowDestroy: true, confirmPhrase: ID });
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "delete a snapshot", target: "portainer" }),
    );
    const shown = everythingShown(world);
    for (const secret of [PORTAINER_HOST, PORTAINER_TOKEN, DB_SECRET, CACHE_SECRET]) {
      expect(shown).not.toContain(secret);
    }
  });
});
