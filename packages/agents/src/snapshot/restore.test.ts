import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDocker } from "@opscrew/connector-docker/testing";
import { generateAgeIdentity, OpsCrewError } from "@opscrew/core";
import {
  IMAGES,
  RESTORE_APPROVAL_FILE,
  RESTORE_STUCK,
  snapshotScript,
} from "@opscrew/iac-templates";
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

/** The `snapshot.sh restore` calls `server` (the app's by default) got, in order. */
async function restores(world: SnapshotWorld, server = "app"): Promise<string[]> {
  const calls = (await world.servers[server]?.calls()) ?? [];
  return calls.filter((call) => call.startsWith("restore "));
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
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", `restore ${ID}`, "resume"]);
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

    expect((await restores(world)).at(-1)).toBe(`restore ${ID} --only db`);
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

  it("restores the app's kept folder, alone with --only files", async () => {
    const world = await snapshotWorld(
      stagingPlan([{ kind: "postgres", name: "db" }], { files: true }),
    );
    const FILES = { name: "files", kind: "files", file: "files.tar", size: 300 };
    await store(world, "app", about([DB, FILES]));
    await restoreSnapshot(world.deps, ID, { services: world.services });
    await restoreSnapshot(world.deps, ID, { services: world.services, only: "files" });

    expect(await restores(world)).toEqual([`restore ${ID}`, `restore ${ID} --only files`]);
    const [all, one] = world.handler.requests;
    expect(all?.details).toContain(
      "It puts back exactly as they were then: db (PostgreSQL) and files (the app's kept folder).",
    );
    expect(one?.details).toContain(
      "It puts back exactly as they were then: files (the app's kept folder).",
    );
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
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
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
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
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
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);

    // Only the digests count: the same image named another way is the same image.
    const digest = IMAGES.kafka.ref.slice(IMAGES.kafka.ref.indexOf("@"));
    await world.servers.app?.write("images/kafka", `apache/kafka${digest}\n`);
    await store(world, "app", about([DB, KAFKA]));
    await restoreSnapshot(world.deps, ID, { services: world.services });
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
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
      expect.objectContaining({ action: "restore a snapshot", detail: `${ID}: db: back` }),
    );
  });

  it("names the copy to restore when putting the data back failed too", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB]));
    await world.servers.app?.write("restore.exit", `${RESTORE_STUCK}\n`);
    await world.servers.app?.write("restore.stderr", "the put-back failed\n");
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(stuck.message).toContain("the app stays stopped");
    expect(stuck.hint).toContain(`on the app's server, \`opscrew restore ${SAVED}`);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "restore a snapshot", detail: `${ID}: db: stuck` }),
    );
  });

  it("removes the one-time approval when the restore did not run", async () => {
    const world = await snapshotWorld(plan());
    await store(world, "app", about([DB]));
    const app = world.servers.app as NonNullable<typeof world.servers.app>;
    app.answer = (command) =>
      command.includes("'restore'") ? { exitCode: 4, stdout: "", stderr: "" } : undefined;
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(failed.message).toContain("has no snapshot.sh");
    expect(await app.read(RESTORE_APPROVAL_FILE)).toBeUndefined();
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

  /** The split plan's snapshot {@link ID}: Valkey on the app's server, PostgreSQL on `data`. */
  async function split() {
    const world = await snapshotWorld(splitStagingPlan());
    await store(
      world,
      "app",
      about([{ name: "cache", kind: "valkey", file: "cache.rdb", size: 9 }]),
    );
    await store(world, "data", about([{ ...DB }]));
    return world;
  }

  /** Makes `server`'s restore of `id` end with `exit`, saying `stderr`. */
  async function failing(world: SnapshotWorld, server: string, id: string, exit: number) {
    await world.servers[server]?.write(`restore-${id}.exit`, `${exit}\n`);
    await world.servers[server]?.write(`restore-${id}.stderr`, `the restore of ${id} failed\n`);
  }

  it("resumes the app when the first server's restore fails, its data put back by its script", async () => {
    const world = await split();
    await failing(world, "data", ID, 1);
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(failed.message).toContain(`the restore of ${ID} failed`);
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", "resume"]);
    expect(await world.servers.data?.calls()).toEqual(["list", `restore ${ID}`]);

    // A resume that fails too says how to start the app.
    await world.servers.app?.write("resume.exit", "1\n");
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(stuck.message).toContain("OpsCrew could not start the app again");
    expect(stuck.hint).toContain("sh snapshot.sh resume");
  });

  it("puts back what an earlier server restored when a later one fails, in the same hold", async () => {
    const world = await split();
    await failing(world, "app", ID, 1);
    const order = journal(world);
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(failed.message).toContain(
      "OpsCrew put the data back as it was before the restore on server data too, which it had restored: nothing changed.",
    );
    // Held, the app's server's failed restore starts nothing: no request reaches the app before
    // the data goes back, and the app starts only with resume.
    expect(order).toEqual([
      "app: list",
      "data: list",
      "app: hold",
      `data: restore ${ID}`,
      `app: restore ${ID}`,
      `data: restore ${SAVED}`,
      "app: resume",
    ]);
    // The put-back's own one-time approval, under the restore's approval.
    expect((await world.servers.data?.read(`approval.${SAVED}`))?.trim()).toMatch(
      new RegExp(`^${SAVED} - \\d+$`),
    );
    expect(world.handler.requests).toHaveLength(1);
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "put back a restore",
        target: "server data",
        detail: `${SAVED}: db: restored`,
      }),
    );
    expect(world.handler.requests[0]?.details).toContain(
      "If the restore fails on one machine, OpsCrew puts back what it restored on the others too",
    );
  });

  it("keeps the app stopped when a put-back fails, naming the copy to restore", async () => {
    const world = await split();
    await failing(world, "app", ID, 1);
    await failing(world, "data", SAVED, 1);
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(stuck.message).toContain(
      "OpsCrew could not put the data back as it was before the restore on server data, which it had restored.",
    );
    expect(stuck.message).toContain("the app stays stopped");
    expect(stuck.hint).toContain(`on server data, \`opscrew restore ${SAVED}`);
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", `restore ${ID}`]);
  });

  it("puts back the servers restored before one whose own put-back failed, the app kept stopped", async () => {
    const world = await split();
    await failing(world, "app", ID, RESTORE_STUCK);
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(await world.servers.data?.calls()).toEqual([
      "list",
      `restore ${ID}`,
      `restore ${SAVED}`,
    ]);
    expect(stuck.message).toContain("the app stays stopped");
    expect(stuck.hint).toContain(`on the app's server, \`opscrew restore ${SAVED}`);
    expect(stuck.hint).not.toContain("on server data");
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
  });

  it("keeps the app stopped when a server's own put-back fails, and when its copy is unknown", async () => {
    const world = await split();
    await failing(world, "data", ID, RESTORE_STUCK);
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(stuck.hint).toContain(`on server data, \`opscrew restore ${SAVED}`);
    expect(await world.servers.app?.calls()).toEqual(["list", "hold"]);

    const unknown = await split();
    await failing(unknown, "app", ID, 1);
    await unknown.servers.data?.write("restore.nosaved", "");
    const lost = await failure(restoreSnapshot(unknown.deps, ID, { services: unknown.services }));
    expect(lost.hint).toContain("on server data, the newest snapshot by hand there");
    expect(await unknown.servers.app?.calls()).toEqual(["list", "hold", `restore ${ID}`]);
  });

  it("resumes the app when the hold fails, and only warns when the audit log can't be written", async () => {
    const world = await split();
    await world.servers.app?.write("hold.exit", "1\n");
    const held = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));
    expect(held.message).toContain("could not hold the app's requests before the restore");
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", "resume"]);

    const other = await split();
    const append = other.deps.audit.append.bind(other.deps.audit);
    other.deps.audit.append = async (entry) => {
      if (entry.action === "restore a snapshot") throw new Error("the audit log is full");
      return append(entry);
    };
    await restoreSnapshot(other.deps, ID, { services: other.services });
    expect((await other.servers.app?.calls())?.at(-1)).toBe("resume");
    expect(other.deps.reporter.text()).toContain(
      'OpsCrew could not write "restore a snapshot" on server data in its audit log: the audit log is full',
    );
  });

  it("keeps the app stopped after any other error once a machine began its restore", async () => {
    const world = await split();
    const app = world.servers.app as NonNullable<typeof world.servers.app>;
    app.answer = (command) => {
      if (command.includes("'restore'")) throw new Error("the connection was reset");
      return undefined;
    };
    const stuck = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(stuck.message).toContain(
      "OpsCrew stopped during the restore: the connection was reset.",
    );
    expect(stuck.message).toContain("the app stays stopped");
    expect(stuck.hint).toContain(`on server data, \`opscrew restore ${SAVED}`);
    expect(stuck.hint).toContain("on the app's server, the newest snapshot by hand there");
    expect(await app.calls()).toEqual(["list", "hold"]);
    // Its one-time approval does not stay.
    expect(await app.read(RESTORE_APPROVAL_FILE)).toBeUndefined();
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
    // The one-off that replaces a folder without about.json, and renames the copy in its place.
    docker.onStart = (container) => {
      const [, from = "", to = ""] = /mv (\S+) (\S+)$/.exec(container.cmd[2] ?? "") ?? [];
      const files = docker.folders.get(folder)?.files;
      const name = (path: string) => path.slice(path.lastIndexOf("/snapshots/") + 11);
      const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
      if (files?.has(`${name(to)}/about.json`)) return { exitCode: 6 };
      for (const path of [...(files?.keys() ?? [])])
        if (within(path, name(to))) files?.delete(path);
      for (const [path, file] of [...(files?.entries() ?? [])]) {
        if (!within(path, name(from))) continue;
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
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
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

  it("refuses another key before any change, and uses the copy a server still holds", async () => {
    const { world, bucket, services } = await offsiteWorld();
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
    // A retry once the first copy got there: the server's own is used, nothing is downloaded.
    await store(world, "app", about([DB]));
    const reads = bucket.calls.filter((call) => call.args[0] === "cat").length;
    await restoreSnapshot(world.deps, ID, {
      services,
      from: "offsite",
      identity: generateAgeIdentity().identity,
    });
    expect(bucket.calls.filter((call) => call.args[0] === "cat")).toHaveLength(reads);
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
  });

  /** {@link offsiteWorld}'s dump changed in its first chunk, its download never ending by itself. */
  async function stalled() {
    const offsite = await offsiteWorld();
    const { bucket } = offsite;
    const damaged = Buffer.from(bucket.objects.get(`${ID}/db.dump.age`) ?? Buffer.alloc(0));
    const payload = damaged.indexOf("\n", damaged.indexOf("\n--- ") + 1) + 1 + 16;
    damaged[payload + 10] = (damaged[payload + 10] as number) ^ 1;
    bucket.objects.set(`${ID}/db.dump.age`, damaged);
    return offsite;
  }

  it("replaces a folder an earlier copy left without about.json", async () => {
    const { world, key, docker, folder, services, dump } = await offsiteWorld();
    // What a copy that never completed left, on the server and as the Docker API sees it.
    await world.servers.app?.write(`.snapshots/${ID}/db.dump`, "half a dump");
    docker.folders.get(folder)?.files.set(`${ID}/db.dump`, {
      type: "file",
      mode: 0o600,
      uid: 1000,
      gid: 1000,
      data: Buffer.from("half a dump"),
    });
    await restoreSnapshot(world.deps, ID, { services, from: "offsite", identity: key.identity });

    expect(docker.folders.get(folder)?.files.get(`${ID}/db.dump`)?.data?.equals(dump)).toBe(true);
    expect((await restores(world)).at(-1)).toBe(`restore ${ID}`);
  });

  it("names a folder whose about.json can't be read, and leaves it as it is", async () => {
    const { world, key, services } = await offsiteWorld();
    await world.servers.app?.write(`.snapshots/${ID}/about.json`, "{broken\n");
    const unreadable = await failure(
      restoreSnapshot(world.deps, ID, { services, from: "offsite", identity: key.identity }),
    );

    expect(unreadable.message).toContain(
      `The folder .snapshots/${ID} in the app's folder on the app's server has an about.json that OpsCrew can't read`,
    );
    expect(unreadable.message).not.toContain("Restore it from there");
    expect(unreadable.hint).toContain("Fix that about.json, or remove the folder by hand");
    expect(await world.servers.app?.read(`.snapshots/${ID}/about.json`)).toBe("{broken\n");
    expect(await restores(world)).toEqual([]);
  });

  it("ends a damaged download at once, its rclone killed, leaving no part of the copy", async () => {
    const { world, key, bucket, docker, folder, services } = await stalled();
    // The record downloads whole; the dump's stream would stay open.
    const open = bucket.streams().open;
    world.deps.streams = {
      open: (command, args, options) => {
        bucket.endless = args.some((arg) => arg.endsWith("db.dump.age"));
        return open(command, args, options);
      },
    };
    const failed = await failure(
      restoreSnapshot(world.deps, ID, { services, from: "offsite", identity: key.identity }),
    );

    expect(failed.code).toBe("ARTIFACT_INVALID");
    expect(bucket.killed).toBe(1);
    expect(docker.folders.get(folder)?.files.has(`${ID}/about.json`)).toBe(false);
    expect(await world.servers.app?.calls()).toEqual(["list"]);
  });

  it("ends a copy longer than its record says, its rclone killed", async () => {
    const { world, key, bucket, services } = await offsiteWorld();
    const short = about([{ ...DB, size: 10 }]);
    bucket.put(`${ID}/about.json.age`, JSON.stringify(short), key.recipient);
    const open = bucket.streams().open;
    world.deps.streams = {
      open: (command, args, options) => {
        bucket.endless = args.some((arg) => arg.endsWith("db.dump.age"));
        return open(command, args, options);
      },
    };
    const failed = await failure(
      restoreSnapshot(world.deps, ID, { services, from: "offsite", identity: key.identity }),
    );

    expect(failed.code).toBe("ARTIFACT_INVALID");
    expect(bucket.killed).toBe(1);
  });

  it("copies from the bucket only to the servers that lack the snapshot", async () => {
    const world = await snapshotWorld(withOffsite(splitStagingPlan()));
    const key = generateAgeIdentity();
    const bucket = new FakeBucket("shop-backups");
    const cache = {
      name: "cache",
      kind: "valkey",
      file: "cache.rdb",
      size: 4,
      image: IMAGES.valkey.ref,
    };
    await store(world, "app", about([cache]));
    bucket.put(`${ID}/cache.rdb.age`, "rdb.", key.recipient);
    bucket.put(`${ID}/about.json.age`, JSON.stringify(about([cache])), key.recipient);
    bucket.put(`${ID}/data/db.dump.age`, "dump", key.recipient);
    bucket.put(
      `${ID}/data/about.json.age`,
      JSON.stringify(about([{ ...DB, size: 4 }])),
      key.recipient,
    );
    world.deps.env = { ...world.deps.env, ...OFFSITE_ENV };
    world.deps.runner = bucket.runner(world.deps.runner);
    world.deps.streams = bucket.streams();
    const docker = new FakeDocker();
    docker.images.add(IMAGES.busybox.ref);
    const folder = `/srv/apps/${world.plan.app.name}/.snapshots`;
    docker.addFolder(folder);
    docker.onStart = () => ({ exitCode: 0 });
    const reached: string[] = [];
    const services = {
      ...world.services,
      docker: (server: string) => {
        reached.push(server);
        return docker;
      },
    };
    await restoreSnapshot(world.deps, ID, { services, from: "offsite", identity: key.identity });

    expect(reached).toEqual(["data"]);
    expect(docker.folders.get(folder)?.files.get(`${ID}.taking/db.dump`)?.data?.toString()).toBe(
      "dump",
    );
    const downloaded = bucket.calls
      .filter((call) => call.args[0] === "cat")
      .map((call) => call.args[1]);
    expect(downloaded).toEqual([
      "offsite:shop-backups/backups/20261106T190000Z/data/about.json.age",
      "offsite:shop-backups/backups/20261106T190000Z/data/db.dump.age",
    ]);
    expect(await world.servers.data?.calls()).toEqual(["list", `restore ${ID}`]);
    expect(await world.servers.app?.calls()).toEqual(["list", "hold", `restore ${ID}`, "resume"]);
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
  it("restores in the app's folder here after its one-time approval, the app held around it", async () => {
    const computer = new FakeComputer();
    const local = localPlan();
    const { deps } = await localProject(local, computer);
    const folder = appFolder(deps.paths, local);
    mkdirSync(join(folder, ".snapshots", ID), { recursive: true });
    writeFileSync(join(folder, "snapshot.sh"), `${snapshotScript(local).join("\n")}\n`);
    // A local build has no digest: its snapshots record its image's ID, as the version here does.
    const image = "f".repeat(64);
    writeFileSync(join(folder, ".env"), "APP_IMAGE=opscrew-local/shop:0123456789ab\n");
    writeFileSync(
      join(folder, ".snapshots", ID, "about.json"),
      `${JSON.stringify(about([DB], { version: "" }))}\n`,
    );
    const apps = localRoots(deps.paths).apps.replaceAll("\\", "/");
    const docker = `docker() { if [ "$1 $2" = "image inspect" ]; then echo "sha256:${image}"; fi; }`;
    const approvals: string[] = [];
    const held: string[] = [];
    computer.script = (text) => {
      // The hold and resume need Docker here: what they ran is recorded.
      const step = /'(hold|resume)'/.exec(text)?.[1];
      if (step !== undefined) {
        held.push(step);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (text.includes("'restore'")) {
        approvals.push(readFileSync(join(folder, RESTORE_APPROVAL_FILE), "utf8").trim());
        return {
          exitCode: 0,
          stdout: `saved ${SAVED}\n`,
          stderr: `OpsCrew restored the snapshot ${ID}. The data from just before the restore is the snapshot ${SAVED}.\n`,
        };
      }
      // Docker knows the local image, and runs no service container: the images are the plan's.
      const run = spawnSync("sh", ["-c", `${docker}\n${text}`], {
        encoding: "utf8",
        env: { ...process.env, OPSCREW_APPS_DIR: apps },
      });
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
    };
    const services = { localhost: computer.services() };
    const unknown = await failure(restoreSnapshot(deps, ID, { services }));
    expect(unknown.message).toContain("records no version");
    await restoreSnapshot(deps, ID, { services, allowOtherVersion: true });

    // Another build: a rebuild of the same code has a new image ID, so no rollback is named.
    writeFileSync(
      join(folder, ".snapshots", ID, "about.json"),
      `${JSON.stringify(about([DB], { version: `sha256:${OTHER}` }))}
`,
    );
    const rebuilt = await failure(restoreSnapshot(deps, ID, { services }));
    expect(rebuilt.message).toContain(
      "A local build gets a new image ID each time it is rebuilt, even from the same code",
    );
    expect(rebuilt.hint).toContain("--allow-other-version");
    expect(rebuilt.hint).not.toContain("rollback");

    writeFileSync(
      join(folder, ".snapshots", ID, "about.json"),
      `${JSON.stringify(about([DB], { version: `sha256:${image}` }))}\n`,
    );
    const restored = await restoreSnapshot(deps, ID, { services });
    expect(restored).toEqual({
      id: ID,
      where: "on this computer",
      services: [{ name: "db" }],
      saved: { app: SAVED },
    });
    expect(approvals).toEqual([
      expect.stringMatching(new RegExp(`^${ID} - \\d+$`)),
      expect.stringMatching(new RegExp(`^${ID} - \\d+$`)),
    ]);
    // The app is held around the restore, as on servers: the restore here never starts it.
    expect(held).toEqual(["hold", "resume", "hold", "resume"]);
  });
});
