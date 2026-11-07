import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDocker } from "@opscrew/connector-docker/testing";
import { generateAgeIdentity, OpsCrewError } from "@opscrew/core";
import { IMAGES, RESTORE_APPROVAL_FILE, snapshotScript } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder, localRoots } from "../localhost/services";
import { SERVER_IPV4 } from "../testing";
import { FakeBucket, OFFSITE_ENV, OFFSITE_KEY } from "./__fixtures__/bucket";
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
import { restoreSnapshot } from "./restore";

const ID = "20261106T190000Z";
const OTHER = "b".repeat(64);
const SAVED = "20261107T120000Z";

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

/** `shop` in staging on a Hetzner server with PostgreSQL `db` and the stop-only Kafka. */
function plan(): DeployPlan {
  return stagingPlan([
    { kind: "postgres", name: "db" },
    { kind: "kafka", name: "kafka" },
  ]);
}

/** A record of `id` (default {@link ID}) holding `services`, taken while `version` ran. */
function about(services: object[], o: { id?: string; version?: string; kind?: string } = {}) {
  return {
    id: o.id ?? ID,
    kind: o.kind ?? "manual",
    taken: "2026-11-06T19:00:00Z",
    version: o.version ?? `sha256:${RUNNING}`,
    services,
  };
}

const DB = { name: "db", kind: "postgres", file: "db.dump", size: 100, image: IMAGES.postgres.ref };
const KAFKA = {
  name: "kafka",
  kind: "kafka",
  file: "kafka.tar",
  size: 200,
  image: IMAGES.kafka.ref,
};

/** Stores `record` as its snapshot's `about.json` on `server` of `world`. */
async function store(world: SnapshotWorld, server: string, record: { id: string }): Promise<void> {
  await world.servers[server]?.write(
    `.snapshots/${record.id}/about.json`,
    `${JSON.stringify(record)}\n`,
  );
}

/** The `snapshot.sh` calls every fake machine got, in order, as `<server>: <arguments>`. */
function journal(world: SnapshotWorld): string[] {
  const seen: string[] = [];
  const counts: Record<string, number> = {};
  const remote = world.services.remote;
  world.services.remote = (host) => {
    const shell = remote?.(host);
    if (shell === undefined) throw new Error(`no fake server at ${host}`);
    const name = host === DATA_IPV4 ? "data" : "app";
    return {
      host,
      run: async (command, options) => {
        const result = await shell.run(command, options);
        const calls = (await world.servers[name]?.calls()) ?? [];
        for (const call of calls.slice(counts[name] ?? 0)) seen.push(`${name}: ${call}`);
        counts[name] = calls.length;
        return result;
      },
    };
  };
  return seen;
}

describe.skipIf(!SH_AVAILABLE)("opscrew restore on servers", () => {
  it("restores every part after a destroy-grade approval bound to the snapshot, with its one-time approval", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB, KAFKA]));
    const restored = await restoreSnapshot(world.deps, ID, { services: world.services });

    expect(restored).toEqual({
      id: ID,
      where: "on the app's server",
      services: [
        { name: "db", server: "app" },
        { name: "kafka", server: "app" },
      ],
      saved: { app: SAVED },
    });
    const [request] = world.handler.requests;
    expect(request).toMatchObject({
      kind: "remote-exec",
      title: `Restore the snapshot ${ID} of staging on the app's server`,
      allowDestroy: true,
      confirmPhrase: world.plan.app.name,
    });
    expect(request?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.details).toContain(
      "What is lost: everything written to db and kafka since 2026-11-06 19:00 UTC.",
    );
    expect(request?.details).toContain(`Restore hash: ${request?.planHash}`);
    expect(await world.servers.app?.calls()).toEqual(["list", `restore ${ID}`]);
    // The one-time approval, for exactly this restore and every service, valid 30 minutes.
    const expiry = Math.floor(world.deps.clock.now().getTime() / 1000) + 1800;
    expect((await world.servers.app?.read(`approval.${ID}`))?.trim()).toBe(`${ID} - ${expiry}`);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "restore a snapshot",
        target: "server app",
        decision: "approved",
        detail: `${ID}: db, kafka: restored`,
      }),
    );
    expect(everythingShown(world)).not.toContain(SERVER_IPV4);
  });

  it("restores only the service --only names, its hash another than every part's", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB, KAFKA]));
    await restoreSnapshot(world.deps, ID, { services: world.services });
    await restoreSnapshot(world.deps, ID, { services: world.services, only: "db" });

    expect((await world.servers.app?.calls())?.at(-1)).toBe(`restore ${ID} --only db`);
    expect((await world.servers.app?.read(`approval.${ID}`))?.trim()).toMatch(
      new RegExp(`^${ID} db \\d+$`),
    );
    const [all, one] = world.handler.requests;
    expect(one?.details).toContain("It puts back exactly as they were then: db (PostgreSQL).");
    expect(one?.planHash).not.toBe(all?.planHash);
    const wrong = await failure(
      restoreSnapshot(world.deps, ID, { services: world.services, only: "nope" }),
    );
    expect(wrong.code).toBe("INVALID_INPUT");
  });

  it("refuses a snapshot of another version, naming the rollback, and restores its data alone when allowed", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB], { version: `sha256:${OTHER}` }));
    const refused = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toContain("was taken while another version ran (sha256:bbbbbbbbbbbb)");
    expect(refused.hint).toContain("opscrew rollback --to sha256:bbbbbbbbbbbb");
    expect(refused.hint).toContain("--database snapshot");
    expect(refused.hint).toContain("--allow-other-version");
    expect(world.handler.requests).toEqual([]);
    expect(await world.servers.app?.calls()).toEqual(["list"]);

    await restoreSnapshot(world.deps, ID, { services: world.services, allowOtherVersion: true });
    expect((await world.servers.app?.calls())?.at(-1)).toBe(`restore ${ID}`);
    expect(world.handler.requests[0]?.details).toContain(
      "Only the data goes back (--allow-other-version): the version that runs now stays.",
    );
  });

  it("treats a snapshot that records no version as unknown: refused unless allowed", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB], { version: "" }));
    const refused = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(refused.message).toContain(`The snapshot ${ID} records no version`);
    expect(world.handler.requests).toEqual([]);
    await restoreSnapshot(world.deps, ID, { services: world.services, allowOtherVersion: true });
    expect((await world.servers.app?.calls())?.at(-1)).toBe(`restore ${ID}`);
  });

  it("refuses a stop-only service whose image changed since its copy, naming both, and one with no image unless allowed", async () => {
    const world = await snapshotWorld(plan());
    const old = "apache/kafka:3.9.0@sha256:".padEnd(90, "c");
    await store(world, "app", about([DB, { ...KAFKA, image: old }]));
    // The running container's image, not the plan's pin, is what receives the data.
    await world.servers.app?.write("images/kafka", `${IMAGES.kafka.ref}\n`);
    const changed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(changed.code).toBe("PHASE_PRECONDITION");
    expect(changed.message).toContain(
      `kafka (Apache Kafka) ran ${old} when the snapshot ${ID} was copied, and runs ${IMAGES.kafka.ref} now`,
    );
    expect(changed.message).toContain("Meilisearch's need the very same one");
    const allowed = await failure(
      restoreSnapshot(world.deps, ID, { services: world.services, allowOtherVersion: true }),
    );
    expect(allowed.message).toContain(`ran ${old} when`);
    // Restoring the database alone is fine.
    await restoreSnapshot(world.deps, ID, { services: world.services, only: "db" });

    const { image: _image, ...unknown } = KAFKA;
    await store(world, "app", about([DB, unknown]));
    const missing = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(missing.message).toContain("does not record the image kafka (Apache Kafka) ran");
    await restoreSnapshot(world.deps, ID, { services: world.services, allowOtherVersion: true });
    expect((await world.servers.app?.calls())?.at(-1)).toBe(`restore ${ID}`);
  });

  it("says the copy was put back when the restore fails, and changes nothing more", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB]));
    await world.servers.app?.write("restore.exit", "1\n");
    await world.servers.app?.write(
      "restore.stderr",
      `Restoring the snapshot ${ID} failed, so OpsCrew put the data back as it was before the restore (the snapshot ${SAVED}): nothing changed. ${SERVER_IPV4}\n`,
    );
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(failed.code).toBe("COMMAND_FAILED");
    expect(failed.message).toContain("OpsCrew put the data back as it was before the restore");
    expect(failed.message).not.toContain(SERVER_IPV4);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "restore a snapshot", detail: `${ID}: db: failed` }),
    );
  });

  it("restores nothing when the app's name is not typed", async () => {
    const world = await snapshotWorld(plan(), {
      answer: () => ({ approved: true, confirmation: "yes" }),
    });
    await store(world, "app", about([DB]));
    const refused = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.hint).toContain(`--confirm ${world.plan.app.name} --approve `);
    expect(await world.servers.app?.calls()).toEqual(["list"]);
  });

  it("refuses an id it doesn't have, and a deploy that runs", async () => {
    const world = await snapshotWorld(plan(), {
      runs: [{ status: "in_progress", htmlUrl: "https://github.com/acme/shop/actions/runs/1" }],
    });
    const deploying = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(deploying.message).toContain("deploy workflow is queued or in progress");

    const quiet = await snapshotWorld(plan());
    const none = await failure(restoreSnapshot(quiet.deps, ID, { services: quiet.services }));
    expect(none.message).toBe(`staging has no snapshot ${ID}. Nothing was changed.`);
    expect((await failure(restoreSnapshot(quiet.deps, "../x", {}))).code).toBe("INVALID_INPUT");
  });
});

describe.skipIf(!SH_AVAILABLE)("opscrew restore across the app's servers (D8, D18)", () => {
  it("holds the app, restores each server's part, the extra ones first, then resumes it", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    await store(
      world,
      "app",
      about([{ name: "cache", kind: "valkey", file: "cache.rdb", size: 9 }]),
    );
    await store(world, "data", about([{ ...DB }]));
    const order = journal(world);
    const restored = await restoreSnapshot(world.deps, ID, { services: world.services });

    expect(restored.where).toBe("on the app's server and server data");
    expect(order).toEqual([
      "app: list",
      "data: list",
      "app: hold",
      `data: restore ${ID}`,
      `app: restore ${ID}`,
      "app: resume",
    ]);
    expect(world.handler.requests[0]?.details).toContain(
      "It puts back exactly as they were then: cache (Valkey) on the app's server and db (PostgreSQL) on server data.",
    );
    const shown = everythingShown(world);
    expect(shown).not.toContain(SERVER_IPV4);
    expect(shown).not.toContain(DATA_IPV4);
  });

  it("resumes the app when a server's restore fails, and says what the others did", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    await store(
      world,
      "app",
      about([{ name: "cache", kind: "valkey", file: "cache.rdb", size: 9 }]),
    );
    await store(world, "data", about([{ ...DB }]));
    await world.servers.data?.write("restore.exit", "1\n");
    await world.servers.data?.write(
      "restore.stderr",
      `Restoring the snapshot ${ID} failed, so OpsCrew put the data back as it was before the restore (the snapshot ${SAVED}): nothing changed.\n`,
    );
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(failed.message).toContain("put the data back as it was before the restore");
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", "resume"]);
    expect(await world.servers.data?.calls()).toEqual(["list", `restore ${ID}`]);

    // A resume that fails too says how to start the app.
    await world.servers.app?.write("resume.exit", "1\n");
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(stuck.message).toContain("OpsCrew could not start the app again");
    expect(stuck.hint).toContain("sh snapshot.sh resume");
  });

  it("restores a pre-release snapshot by its digest on an extra server alone, the app held around it (D18)", async () => {
    const world = await snapshotWorld(splitStagingPlan());
    await store(world, "data", about([{ ...DB }], { id: RUNNING, kind: "release" }));
    await store(
      world,
      "app",
      about([{ name: "cache", kind: "valkey", file: "cache.rdb", size: 9 }], {
        id: RUNNING,
        kind: "release",
      }),
    );
    const restored = await restoreSnapshot(world.deps, RUNNING, {
      services: world.services,
      only: "db",
    });

    expect(restored.where).toBe("on server data");
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", "resume"]);
    expect(await world.servers.data?.calls()).toEqual(["list", `restore ${RUNNING} --only db`]);
    expect((await world.servers.data?.read(`approval.${RUNNING}`))?.trim()).toMatch(
      new RegExp(`^${RUNNING} db \\d+$`),
    );
    expect(world.handler.requests[0]?.details).toContain(
      `The snapshot ${RUNNING} taken before a release`,
    );
  });
});

/** `plan` with the off-server copy at Hetzner. */
function withOffsite(base: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    snapshots: { offsite: { provider: "hetzner", bucket: "shop-backups", region: "fsn1" } },
  });
}

describe.skipIf(!SH_AVAILABLE)("opscrew restore --from offsite", () => {
  /** The copy {@link ID} of `plan`'s app's server in a fake bucket, encrypted to a new key. */
  async function offsiteWorld() {
    const world = await snapshotWorld(withOffsite(plan()));
    const key = generateAgeIdentity();
    const bucket = new FakeBucket("shop-backups");
    const dump = Buffer.from(`pg_dump of rows ${"x".repeat(70_000)}`);
    const record = about([{ ...DB, size: dump.length }]);
    bucket.put(`${ID}/db.dump.age`, dump, key.recipient);
    bucket.put(`${ID}/about.json.age`, JSON.stringify(record), key.recipient);
    world.deps.env = { ...world.deps.env, ...OFFSITE_ENV };
    world.deps.runner = bucket.runner(world.deps.runner);
    world.deps.streams = bucket.streams();
    const docker = new FakeDocker();
    docker.images.add(IMAGES.busybox.ref);
    const folder = `/srv/apps/${world.plan.app.name}/.snapshots`;
    docker.addFolder(folder);
    // The one-off's rename, on the folder and on the fake server's own copy.
    docker.onStart = (container) => {
      const [, from = "", to = ""] = container.cmd;
      const files = docker.folders.get(folder)?.files;
      const name = (path: string) => path.slice(path.lastIndexOf("/snapshots/") + 11);
      for (const [path, file] of [...(files?.entries() ?? [])]) {
        if (path !== name(from) && !path.startsWith(`${name(from)}/`)) continue;
        files?.delete(path);
        files?.set(`${name(to)}${path.slice(name(from).length)}`, file);
      }
      return { exitCode: 0 };
    };
    const services = { ...world.services, docker: () => docker };
    return { world, key, bucket, dump, record, docker, folder, services };
  }

  it("downloads and decrypts the copy here, streams it to the server, then restores it there", async () => {
    const { world, key, bucket, dump, docker, folder, services } = await offsiteWorld();
    const restored = await restoreSnapshot(world.deps, ID, {
      services,
      from: "offsite",
      identity: `# public key: ${key.recipient}\n${key.identity}\n`,
    });

    expect(restored.saved).toEqual({ app: SAVED });
    const files = docker.folders.get(folder)?.files;
    expect(files?.get(`${ID}/db.dump`)?.data?.equals(dump)).toBe(true);
    expect(files?.get(`${ID}/db.dump`)?.mode).toBe(0o600);
    expect(files?.get(`${ID}/offsite.done`)).toBeDefined();
    expect(JSON.parse(files?.get(`${ID}/about.json`)?.data?.toString() ?? "")).toMatchObject({
      id: ID,
    });
    expect([...(files?.keys() ?? [])].some((path) => path.includes(".taking"))).toBe(false);
    expect((await world.servers.app?.calls())?.at(-1)).toBe(`restore ${ID}`);
    expect(world.handler.requests[0]?.details).toContain(
      "This computer downloads the copy and decrypts it with your key",
    );
    // rclone ran as the pinned image, the bucket's key only in its environment.
    for (const call of bucket.calls) {
      expect(call.line.join(" ")).not.toContain(OFFSITE_KEY.secretAccessKey);
      expect(call.env.RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY).toBe(OFFSITE_KEY.secretAccessKey);
      expect(call.env.RCLONE_CONFIG_OFFSITE_ENDPOINT).toBe("https://fsn1.your-objectstorage.com");
    }
    const shown = everythingShown(world);
    for (const secret of [OFFSITE_KEY.secretAccessKey, OFFSITE_KEY.accessKeyId, key.identity]) {
      expect(shown).not.toContain(secret);
    }
    expect(shown).not.toContain(SERVER_IPV4);
  });

  it("refuses another key before any change, and a copy the server holds already", async () => {
    const { world, services } = await offsiteWorld();
    const wrong = await failure(
      restoreSnapshot(world.deps, ID, {
        services,
        from: "offsite",
        identity: generateAgeIdentity().identity,
      }),
    );
    expect(wrong.code).toBe("SECRETS_KEY_REJECTED");
    expect(world.handler.requests).toEqual([]);

    const none = await failure(restoreSnapshot(world.deps, ID, { services, from: "offsite" }));
    expect(none.code).toBe("INVALID_INPUT");
    await store(world, "app", about([DB]));
    const present = await failure(
      restoreSnapshot(world.deps, ID, {
        services,
        from: "offsite",
        identity: generateAgeIdentity().identity,
      }),
    );
    expect(present.message).toContain("is on the app's server already");
  });

  it("leaves no part of a copy whose download is damaged", async () => {
    const { world, key, bucket, docker, folder, services } = await offsiteWorld();
    const damaged = Buffer.from(bucket.objects.get(`${ID}/db.dump.age`) ?? Buffer.alloc(0));
    damaged[damaged.length - 20] = (damaged[damaged.length - 20] as number) ^ 1;
    bucket.objects.set(`${ID}/db.dump.age`, damaged);
    const failed = await failure(
      restoreSnapshot(world.deps, ID, { services, from: "offsite", identity: key.identity }),
    );

    expect(failed.code).toBe("ARTIFACT_INVALID");
    expect(docker.folders.get(folder)?.files.has(`${ID}/about.json`)).toBe(false);
    expect(await world.servers.app?.calls()).toEqual(["list"]);
  });

  it("refuses without the off-server copy in the plan", async () => {
    const world = await snapshotWorld(plan());
    const refused = await failure(
      restoreSnapshot(world.deps, ID, {
        services: world.services,
        from: "offsite",
        identity: generateAgeIdentity().identity,
      }),
    );
    expect(refused.message).toContain("staging has no off-server copy");
  });
});

describe.skipIf(!SH_AVAILABLE)("opscrew restore on this computer", () => {
  it("restores in the app's folder here after its one-time approval, holding nothing else", async () => {
    const computer = new FakeComputer();
    const local = localPlan();
    const { deps } = await localProject(local, computer);
    const folder = appFolder(deps.paths, local);
    mkdirSync(join(folder, ".snapshots", ID), { recursive: true });
    writeFileSync(join(folder, "snapshot.sh"), `${snapshotScript(local).join("\n")}\n`);
    // A local build has no digest: its snapshots record no version.
    writeFileSync(
      join(folder, ".snapshots", ID, "about.json"),
      `${JSON.stringify(about([DB], { version: "" }))}\n`,
    );
    const apps = localRoots(deps.paths).apps.replaceAll("\\", "/");
    const approvals: string[] = [];
    computer.script = (text) => {
      if (text.includes("'restore'")) {
        approvals.push(readFileSync(join(folder, RESTORE_APPROVAL_FILE), "utf8").trim());
        return {
          exitCode: 0,
          stdout: "",
          stderr: `OpsCrew restored the snapshot ${ID}. The data from just before the restore is the snapshot ${SAVED}.\n`,
        };
      }
      // Docker answers no container here: the images are the plan's.
      const run = spawnSync("sh", ["-c", `docker() { :; }\n${text}`], {
        encoding: "utf8",
        env: { ...process.env, OPSCREW_APPS_DIR: apps },
      });
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
    };
    const services = { localhost: computer.services() };
    const unknown = await failure(restoreSnapshot(deps, ID, { services }));
    expect(unknown.message).toContain("records no version");

    const restored = await restoreSnapshot(deps, ID, { services, allowOtherVersion: true });
    expect(restored).toEqual({
      id: ID,
      where: "on this computer",
      services: [{ name: "db" }],
      saved: { app: SAVED },
    });
    expect(approvals).toEqual([expect.stringMatching(new RegExp(`^${ID} - \\d+$`))]);
    expect(computer.scripts.some((run) => run.script.includes("'hold'"))).toBe(false);
  });
});
