import { FAKE_ACCOUNT_ID } from "@opscrew/connector-cloudflare/testing";
import { generateAgeIdentity, OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { fakeCloudflare, ScriptedRunner, SERVER_IPV4, testPlan } from "../testing";
import { FakeBucket, OFFSITE_ENV, OFFSITE_KEY } from "./__fixtures__/bucket";
import { SH_AVAILABLE } from "./__fixtures__/server";
import {
  everythingShown,
  RUNNING,
  type SnapshotWorld,
  snapshotWorld,
  stagingPlan,
} from "./__fixtures__/world";
import { deleteSnapshot } from "./delete";
import { listSnapshots } from "./list";
import { offsiteBucket } from "./restore-offsite";
import { snapshotRun } from "./run";

const ON_SERVER = "20261106T190000Z";
const ONLY_IN_BUCKET = "20261101T080000Z";

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

/** `shop` in staging with PostgreSQL and the off-server copy at `provider`. */
function plan(provider: "hetzner" | "r2" = "hetzner"): DeployPlan {
  const base = stagingPlan([{ kind: "postgres", name: "db" }], {
    base: testPlan({ deployed: true, domain: "shop.example.com" }),
  });
  return DeployPlanSchema.parse({
    ...base,
    snapshots: {
      offsite: {
        provider,
        bucket: "shop-backups",
        region: provider === "r2" ? "auto" : "fsn1",
      },
    },
  });
}

/** The record of the snapshot `id` holding the database. */
function about(id: string) {
  return {
    id,
    kind: "scheduled",
    taken: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T08:00:00Z`,
    version: `sha256:${RUNNING}`,
    services: [
      { name: "db", kind: "postgres", file: "db.dump", size: 7, image: IMAGES.postgres.ref },
    ],
  };
}

/**
 * `world` with the snapshot {@link ON_SERVER} on its server, copied off it, and the bucket's copy
 * {@link ONLY_IN_BUCKET} whose server no longer holds it, encrypted to a new key.
 */
async function bucketWorld(world: SnapshotWorld) {
  const key = generateAgeIdentity();
  const bucket = new FakeBucket("shop-backups");
  await world.servers.app?.write(
    `.snapshots/${ON_SERVER}/about.json`,
    `${JSON.stringify(about(ON_SERVER))}\n`,
  );
  for (const id of [ON_SERVER, ONLY_IN_BUCKET]) {
    bucket.put(`${id}/db.dump.age`, "rows\n..", key.recipient);
    bucket.put(`${id}/about.json.age`, JSON.stringify(about(id)), key.recipient);
  }
  world.deps.env = { ...world.deps.env, ...OFFSITE_ENV };
  world.deps.runner = bucket.runner(world.deps.runner);
  world.deps.streams = bucket.streams();
  return { key, bucket };
}

describe("rclone on this computer", () => {
  it("runs the pinned image in local Docker, else this computer's rclone, else says what to install", async () => {
    const world = await snapshotWorld(plan());
    world.deps.env = { ...world.deps.env, ...OFFSITE_ENV, RCLONE_CONFIG_OFFSITE_TYPE: "local" };
    const answering = (tools: string[]) =>
      new ScriptedRunner((command) => ({
        exitCode: tools.includes(command) ? 0 : 1,
        stdout: "",
        stderr: "",
      }));
    const bucket = async (tools: string[]) => {
      world.deps.runner = answering(tools);
      return offsiteBucket(await snapshotRun(world.deps), {}, "opscrew snapshot list");
    };

    const docker = await bucket(["docker", "rclone"]);
    expect(docker?.command).toBe("docker");
    expect(docker?.prefix).toEqual([
      "run",
      "--rm",
      "-i",
      ...Object.keys(docker?.env ?? {})
        .filter((name) => name.startsWith("RCLONE_"))
        .flatMap((name) => ["-e", name]),
      IMAGES.rclone.ref,
    ]);
    // The user's own rclone settings never reach it; the key only in its environment.
    expect(docker?.env.RCLONE_CONFIG_OFFSITE_TYPE).toBe("s3");
    expect(docker?.prefix.join(" ")).not.toContain(OFFSITE_KEY.secretAccessKey);
    expect(docker?.root).toBe("offsite:shop-backups/backups");
    const local = await bucket(["rclone"]);
    expect([local?.command, local?.prefix]).toEqual(["rclone", []]);
    const neither = await failure(bucket([]));
    expect(neither.hint).toContain("install rclone");
  });
});

describe.skipIf(!SH_AVAILABLE)("the off-server bucket from this computer", () => {
  it("lists the copies only the bucket holds, read with the key, or names them without it", async () => {
    const world = await snapshotWorld(plan());
    const { key } = await bucketWorld(world);
    const entries = await listSnapshots(world.deps, {
      services: world.services,
      identity: key.identity,
    });

    expect(entries.map((entry) => [entry.id, entry.where, entry.offsite])).toEqual([
      [ON_SERVER, "on the app's server", false],
      [ONLY_IN_BUCKET, "only in the off-server bucket shop-backups", true],
    ]);
    expect(entries[1]).toMatchObject({
      kind: "scheduled",
      version: `sha256:${RUNNING}`,
      services: [{ name: "db", kind: "postgres", state: "copied", size: 7 }],
    });

    const names = await snapshotWorld(plan());
    await bucketWorld(names);
    const listed = await listSnapshots(names.deps, { services: names.services });
    expect(listed.map((entry) => entry.id)).toEqual([ON_SERVER]);
    // A warning, so `snapshot list --json` keeps it on stderr.
    expect(names.deps.reporter.lines).toContainEqual({
      level: "warn",
      message: `The off-server bucket shop-backups also holds the copy ${ONLY_IN_BUCKET}, which no server holds any more. Their records are encrypted: give the recovery copy's age key file to list what they hold.`,
    });
    const shown = everythingShown(world);
    for (const secret of [OFFSITE_KEY.accessKeyId, OFFSITE_KEY.secretAccessKey, key.identity]) {
      expect(shown).not.toContain(secret);
    }
    expect(shown).not.toContain(SERVER_IPV4);
  });

  it("lists the machines with a warning when this computer has no key for the bucket", async () => {
    const world = await snapshotWorld(plan());
    await bucketWorld(world);
    world.deps.env = {
      ...world.deps.env,
      OPSCREW_OFFSITE_ACCESS_KEY_ID: "",
      OPSCREW_OFFSITE_SECRET_ACCESS_KEY: "",
    };
    const entries = await listSnapshots(world.deps, { services: world.services });

    expect(entries.map((entry) => entry.id)).toEqual([ON_SERVER]);
    expect(world.deps.reporter.text()).toContain("The off-server bucket is not read:");
  });

  it("reaches an R2 bucket at the zone's account, read through provision's Cloudflare lookup", async () => {
    const world = await snapshotWorld(plan("r2"));
    const { bucket } = await bucketWorld(world);
    await listSnapshots(world.deps, {
      services: { ...world.services, cloudflare: fakeCloudflare() },
    });

    expect(bucket.calls[0]?.env).toMatchObject({
      RCLONE_CONFIG_OFFSITE_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_OFFSITE_ENDPOINT: `https://${FAKE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    });
  });

  it("deletes a snapshot's off-server copy with it, and a copy only the bucket holds", async () => {
    const world = await snapshotWorld(plan());
    const { bucket } = await bucketWorld(world);
    const deleted = await deleteSnapshot(world.deps, ON_SERVER, { services: world.services });

    expect(deleted.outcome).toBe("deleted");
    expect(world.handler.requests[0]?.details).toContain(
      "Its copy off the server, in the bucket shop-backups, is deleted too.",
    );
    expect(await world.servers.app?.calls()).toEqual(["list", `delete ${ON_SERVER}`]);
    expect([...bucket.objects.keys()].some((path) => path.startsWith(ON_SERVER))).toBe(false);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "delete a snapshot's off-server copy",
        target: "bucket shop-backups",
        detail: `${ON_SERVER}: deleted`,
      }),
    );

    const only = await deleteSnapshot(world.deps, ONLY_IN_BUCKET, { services: world.services });
    expect(only.where).toBe("only in the off-server bucket shop-backups");
    expect(world.handler.requests[1]?.details).toContain(
      "It is deleted for good: `opscrew restore --from offsite` can no longer put it back.",
    );
    expect(world.handler.requests[1]?.confirmPhrase).toBe(ONLY_IN_BUCKET);
    expect(bucket.objects.size).toBe(0);
  });

  it("deletes nothing without the bucket's key", async () => {
    const world = await snapshotWorld(plan());
    await bucketWorld(world);
    world.deps.env = {
      ...world.deps.env,
      OPSCREW_OFFSITE_ACCESS_KEY_ID: "",
      OPSCREW_OFFSITE_SECRET_ACCESS_KEY: "",
    };
    const refused = await failure(
      deleteSnapshot(world.deps, ON_SERVER, { services: world.services }),
    );

    expect(refused.code).toBe("CREDENTIALS_MISSING");
    expect(world.handler.requests).toEqual([]);
    expect(await world.servers.app?.calls()).toEqual(["list"]);
  });

  it("deletes a snapshot before a release without the bucket, which never holds one", async () => {
    const world = await snapshotWorld(plan());
    await world.servers.app?.write(
      `.snapshots/${RUNNING}/about.json`,
      `${JSON.stringify({ ...about(ON_SERVER), id: RUNNING, kind: "release" })}\n`,
    );
    const deleted = await deleteSnapshot(world.deps, RUNNING, { services: world.services });

    expect(deleted.outcome).toBe("deleted");
    expect(world.handler.requests[0]?.details).not.toContain("off the server");
  });
});
