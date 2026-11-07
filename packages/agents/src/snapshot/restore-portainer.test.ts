import { generateAgeIdentity, OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { PORTAINER_HOST, portainerPlan } from "../testing";
import { FakeBucket, OFFSITE_ENV, OFFSITE_KEY } from "./__fixtures__/bucket";
import { DB_SECRET, type PortainerWorld, portainerWorld, SH } from "./__fixtures__/portainer";
import { everythingShown, RUNNING, stagingPlan } from "./__fixtures__/world";
import { restoreSnapshot } from "./restore";

const ID = "20261106T190000Z";
const STACK = "opscrew-shop-staging";
/** The copy taken just before the restore: the test clock's time. */
const SAVED = "20261011T120000Z";

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

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

/** The record of {@link ID}: the database, Kafka (as the stack's container runs it) and SQLite. */
function record(o: { version?: string; kafka?: string } = {}) {
  return {
    id: ID,
    kind: "manual",
    taken: "2026-11-06T19:00:00Z",
    version: o.version ?? `sha256:${RUNNING}`,
    services: [
      { name: "db", kind: "postgres", file: "db.dump", size: 4, image: IMAGES.postgres.ref },
      {
        name: "kafka",
        kind: "kafka",
        file: "kafka.tar",
        size: 4,
        image: o.kafka ?? "apache/kafka",
      },
      { name: "sqlite", kind: "sqlite", file: "sqlite.tar", size: 4 },
    ],
  };
}

/** The started containers whose script holds `text`. */
function ranWith(world: PortainerWorld, text: string) {
  return world.ran.filter((container) => (container.cmd[2] ?? "").includes(text));
}

/** The stack's container of `service`. */
function container(world: PortainerWorld, service: string) {
  return [...world.docker.containers.values()].find(
    (each) => each.labels["com.docker.compose.service"] === service,
  );
}

describe.skipIf(!SH)("opscrew restore in the user's Portainer", () => {
  it("stops the app, copies the data first, puts each part back exactly, and starts the app", async () => {
    const world = await portainerWorld(plan());
    world.probe.version = RUNNING;
    world.store(ID, record());
    const restored = await restoreSnapshot(world.deps, ID, { services: world.services });

    expect(restored).toEqual({
      id: ID,
      where: "in your Portainer",
      services: [{ name: "db" }, { name: "kafka" }, { name: "sqlite" }],
      saved: { app: SAVED },
    });
    const [request] = world.handler.requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: `Restore the snapshot ${ID} of staging in your Portainer`,
      allowDestroy: true,
      confirmPhrase: world.plan.app.name,
    });
    expect(request?.details).toContain("What is lost: everything written to db, kafka and sqlite");
    // The copy just before, a snapshot by hand of the same parts.
    expect(world.volume().has(`${SAVED}/about.json`)).toBe(true);
    // The database loaded by a one-off of its own image, its secrets only in its file.
    const [db] = ranWith(world, "pg_restore");
    expect(db?.image).toBe(IMAGES.postgres.ref);
    expect(db?.network).toBe(`${STACK}_internal`);
    expect(db?.cmd[2]).toContain(
      `pg_restore -h db -U app -d app --no-owner --single-transaction /snapshots/${ID}/db.dump`,
    );
    expect(db?.cmd[2]).toMatch(
      /^\. \/tmp\/opscrew-snapshot\.env && rm -f \/tmp\/opscrew-snapshot\.env\n/,
    );
    expect(db?.mounts).toContainEqual({
      type: "volume",
      source: `${STACK}_snapshots`,
      target: "/snapshots",
      readOnly: true,
    });
    // Kafka's folders and the SQLite volume emptied and untarred by busybox.
    const [kafka] = ranWith(world, `/snapshots/${ID}/kafka.tar`);
    expect(kafka?.image).toBe(IMAGES.busybox.ref);
    expect(kafka?.cmd[2]).toBe(
      `find /var/lib/kafka/data /etc/kafka/secrets /mnt/shared/config -mindepth 1 -delete && tar -C / -xpf /snapshots/${ID}/kafka.tar var/lib/kafka/data etc/kafka/secrets mnt/shared/config`,
    );
    expect(kafka?.mounts).toContainEqual({
      type: "volume",
      source: `${STACK}_kafka_data`,
      target: "/var/lib/kafka/data",
      readOnly: false,
    });
    const [sqlite] = ranWith(world, `/snapshots/${ID}/sqlite.tar`);
    expect(sqlite?.mounts).toContainEqual({
      type: "volume",
      source: `${STACK}_sqlite`,
      target: "/data",
      readOnly: false,
    });
    // Everything that ran runs again.
    expect(container(world, "app")?.state).toBe("running");
    expect(container(world, "kafka")?.state).toBe("running");
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "restore a snapshot",
        target: "portainer",
        detail: `${ID}: db, kafka, sqlite: restored`,
      }),
    );
    const shown = everythingShown(world);
    expect(shown).not.toContain(DB_SECRET);
    expect(shown).not.toContain(PORTAINER_HOST);
  });

  it("puts the copy taken just before back when a part fails, and starts the app again", async () => {
    const world = await portainerWorld(plan());
    world.probe.version = RUNNING;
    world.store(ID, record());
    const start = world.docker.onStart;
    world.docker.onStart = (each) =>
      (each.cmd[2] ?? "").includes(`/snapshots/${ID}/db.dump`)
        ? { exitCode: 1, stderr: "a row of data" }
        : start?.(each);
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(failed.message).toContain(
      `so OpsCrew put the data back as it was before the restore (the snapshot ${SAVED}), and the app runs again: nothing changed.`,
    );
    expect(failed.message).not.toContain("a row of data");
    expect(ranWith(world, `/snapshots/${SAVED}/db.dump`)).toHaveLength(1);
    expect(container(world, "app")?.state).toBe("running");
  });

  it("refuses another version, and a stop-only service whose image changed, before any change", async () => {
    const world = await portainerWorld(plan());
    world.probe.version = "b".repeat(64);
    world.store(ID, record());
    const version = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(version.hint).toContain("opscrew rollback --to sha256:");

    world.probe.version = RUNNING;
    world.store(ID, record({ kafka: IMAGES.kafka.ref }));
    const image = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(image.message).toContain(
      `ran ${IMAGES.kafka.ref} when the snapshot ${ID} was copied, and runs apache/kafka now`,
    );
    expect(world.handler.requests).toEqual([]);
    expect(container(world, "app")?.state).toBe("running");
  });

  it("restores a copy from the off-server bucket, decrypted here, into the snapshots volume", async () => {
    const world = await portainerWorld(
      DeployPlanSchema.parse({
        ...plan(),
        snapshots: { offsite: { provider: "hetzner", bucket: "shop-backups", region: "fsn1" } },
      }),
    );
    world.probe.version = RUNNING;
    const key = generateAgeIdentity();
    const bucket = new FakeBucket("shop-backups");
    const about = record();
    for (const file of ["db.dump", "kafka.tar", "sqlite.tar"]) {
      bucket.put(`${ID}/${file}.age`, `${file.slice(0, 4)}`, key.recipient);
    }
    bucket.put(`${ID}/about.json.age`, JSON.stringify(about), key.recipient);
    world.deps.env = { ...world.deps.env, ...OFFSITE_ENV };
    world.deps.runner = bucket.runner(world.deps.runner);
    world.deps.streams = bucket.streams();
    // The one-off that renames the copy once it is all there.
    const start = world.docker.onStart;
    world.docker.onStart = (each) => {
      if (each.cmd[0] !== "mv") return start?.(each);
      const files = world.volume();
      for (const [path, file] of [...files]) {
        if (path !== `${ID}.taking` && !path.startsWith(`${ID}.taking/`)) continue;
        files.delete(path);
        files.set(path.replace(`${ID}.taking`, ID), file);
      }
      return { exitCode: 0 };
    };
    await restoreSnapshot(world.deps, ID, {
      services: world.services,
      from: "offsite",
      identity: key.identity,
    });

    expect(world.volume().get(`${ID}/db.dump`)?.data?.toString()).toBe("db.d");
    expect(world.volume().get(`${ID}/db.dump`)?.uid).toBe(0);
    expect(world.volume().has(`${ID}/offsite.done`)).toBe(true);
    expect(ranWith(world, `/snapshots/${ID}/db.dump`)).toHaveLength(1);
    const shown = everythingShown(world);
    for (const secret of [OFFSITE_KEY.secretAccessKey, key.identity, DB_SECRET]) {
      expect(shown).not.toContain(secret);
    }
  });
});
