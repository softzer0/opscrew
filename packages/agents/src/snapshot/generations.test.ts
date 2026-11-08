import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, type ImagePinKey, serviceSpec, snapshotScript } from "@opscrew/iac-templates";
import { DeployPlanSchema, type SelfHostedServiceKind, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder, localRoots } from "../localhost/services";
import { serviceSteps } from "../rotate/plan";
import { credentialsRecordFile } from "../rotate/record";
import { generatedValuesFile } from "../shared/app-secrets";
import { fakeProvider } from "./__fixtures__/provider";
import { SH_AVAILABLE } from "./__fixtures__/server";
import {
  everythingShown,
  RUNNING,
  type SnapshotWorld,
  snapshotWorld,
  stagingPlan,
} from "./__fixtures__/world";
import { reloginCommand } from "./generations";
import { listSnapshots } from "./list";
import { restoreSnapshot } from "./restore";

const ID = "20261106T190000Z";
const SAVED = "20261107T120000Z";

/** The values each service's password has now and had at generation 1, made at runtime. */
const NOW = {
  mq: fakeSecret("generic-password", "mq-now"),
  es: fakeSecret("generic-password", "es-now"),
  db: fakeSecret("generic-password", "db-now"),
};
const THEN = {
  mq: fakeSecret("generic-password", "mq-then"),
  es: fakeSecret("generic-password", "es-then"),
  db: fakeSecret("generic-password", "db-then"),
};
const VALUES = [...Object.values(NOW), ...Object.values(THEN)];

/** The pinned image of `kind`, as its container and its copy name it. */
const image = (kind: SelfHostedServiceKind) => IMAGES[serviceSpec(kind).image as ImagePinKey].ref;

/** A copy of `name` in `about.json`: `.tar` of a stop-only kind's volumes, `.dump` of a database. */
function copy(name: string, kind: SelfHostedServiceKind, generation?: number) {
  const file = kind === "postgres" ? `${name}.dump` : `${name}.tar`;
  return {
    name,
    kind,
    file,
    size: 100,
    image: image(kind),
    ...(generation === undefined ? {} : { generation }),
  };
}

const MQ = copy("mq", "rabbitmq");
const ES = copy("es", "elasticsearch");
const DB = copy("db", "postgres");

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

async function writeGenerated(world: Pick<SnapshotWorld, "deps">, values: object): Promise<void> {
  const file = generatedValuesFile(world.deps);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(values)}\n`);
}

async function generated(world: Pick<SnapshotWorld, "deps">): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(generatedValuesFile(world.deps), "utf8"));
}

/**
 * Staging with RabbitMQ `mq` and Elasticsearch `es` (snapshotted by stopping them: their volume
 * copies hold their logins) and PostgreSQL `db` (dumped), each rotated once: generation 2 in the
 * record and on this computer, generation 1's values kept; the snapshot {@link ID} holds `services`.
 */
async function rotatedWorld(
  services: object[] = [MQ, ES],
  o: { kept?: number; history?: object } = {},
): Promise<SnapshotWorld> {
  const world = await snapshotWorld(
    stagingPlan([
      { kind: "rabbitmq", name: "mq" },
      { kind: "elasticsearch", name: "es" },
      { kind: "postgres", name: "db" },
    ]),
  );
  const about = {
    id: ID,
    kind: "manual",
    taken: "2026-11-06T19:00:00Z",
    version: `sha256:${RUNNING}`,
    services,
  };
  await world.servers.app?.write(`.snapshots/${ID}/about.json`, `${JSON.stringify(about)}\n`);
  for (const [name, kind] of [
    ["mq", "rabbitmq"],
    ["es", "elasticsearch"],
    ["db", "postgres"],
  ] as const) {
    await world.servers.app?.write(`images/${name}`, image(kind));
  }
  const rotated = { rotatedAt: "2026-11-07T10:00:00.000Z", generation: 2 };
  await writeArtifact("credentials", credentialsRecordFile(world.deps.paths), {
    schemaVersion: 1,
    environments: { staging: { mq: rotated, es: rotated, db: rotated } },
  });
  await writeGenerated(world, {
    dbPassword: NOW.db,
    services: { mq: { password: NOW.mq }, es: { password: NOW.es } },
    generations: { mq: o.kept ?? 2, es: o.kept ?? 2, db: o.kept ?? 2 },
    history: o.history ?? {
      mq: { "1": { password: THEN.mq } },
      es: { "1": { password: THEN.es } },
      db: { "1": { password: THEN.db } },
    },
  });
  return world;
}

/** Each `docker exec` on the app's server: the values it got and its arguments. */
async function execs(world: SnapshotWorld) {
  const text = (await world.servers.app?.read("exec.log")) ?? "";
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [old, now, ...args] = line.split("|");
      return { old, new: now, args: args.join("|") };
    });
}

describe.skipIf(!SH_AVAILABLE)("opscrew restore after a rotation", () => {
  it("starts each restored volume copy without its health check, sets its current value with the old as the login, then waits", async () => {
    const world = await rotatedWorld();
    await restoreSnapshot(world.deps, ID, { services: world.services });

    const [request] = world.handler.requests;
    expect(request?.details).toContain(
      "mq and es were rotated after the snapshot was taken: once they are back, OpsCrew sets their current passwords again, logging in with those of then, which this computer keeps.",
    );
    // The restore starts them without waiting: Elasticsearch's health check logs in.
    const calls = (await world.servers.app?.calls()) ?? [];
    expect(calls).toContain(`restore ${ID} --no-wait mq --no-wait es`);
    const run = await execs(world);
    expect(run.map(({ old, new: now }) => [old, now])).toEqual([
      [THEN.mq, NOW.mq],
      [THEN.es, NOW.es],
    ]);
    expect(run[0]?.args).toMatch(/^-e OPSCREW_OLD -e OPSCREW_NEW c-mq sh -c .*change_password app/);
    expect(run[1]?.args).toMatch(/^-e OPSCREW_OLD -e OPSCREW_NEW c-es /);
    // Then each waits for its health check, with its current value set.
    const docker = ((await world.servers.app?.read("docker.log")) ?? "").split("\n");
    expect(docker.filter((line) => line.startsWith("compose up"))).toEqual([
      "compose up -d --no-deps --wait mq",
      "compose up -d --no-deps --wait es",
    ]);
    expect(docker.findIndex((line) => line.includes("c-es"))).toBeLessThan(
      docker.indexOf("compose up -d --no-deps --wait es"),
    );
    // After the restore and before the app is let go.
    const commands = world.servers.app?.commands ?? [];
    const at = (text: string) => commands.findIndex((command) => command.includes(text));
    expect(at("docker exec")).toBeGreaterThan(at(`'restore' '${ID}'`));
    expect(at("docker exec")).toBeLessThan(at("'resume'"));
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "remote-exec",
        action: "set the current passwords of restored services",
        target: "server app",
        decision: "approved",
        detail: `${ID}: mq from generation 1 to 2, es from generation 1 to 2: done`,
      }),
    );
    for (const value of VALUES) {
      expect(commands.join("\n")).not.toContain(value);
      expect(everythingShown(world)).not.toContain(value);
    }
  });

  it("needs no old value for a database's dump, which holds no login, and waits for it as before", async () => {
    // Rotated since, and this computer no longer keeps its earlier values: nothing is refused.
    const world = await rotatedWorld([DB], { history: {} });
    await restoreSnapshot(world.deps, ID, { services: world.services });

    expect(await execs(world)).toEqual([]);
    expect(world.handler.requests[0]?.details).not.toContain("rotated");
    expect((await world.servers.app?.calls()) ?? []).toContain(`restore ${ID}`);
  });

  it("binds the generations into the restore's hash, and sets nothing for a copy at today's", async () => {
    const before = await rotatedWorld([MQ]);
    await restoreSnapshot(before.deps, ID, { services: before.services });
    const current = await rotatedWorld([copy("mq", "rabbitmq", 2)]);
    await restoreSnapshot(current.deps, ID, { services: current.services });

    expect(await execs(current)).toEqual([]);
    expect(current.handler.requests[0]?.details).not.toContain("rotated");
    expect(current.handler.requests[0]?.planHash).not.toBe(before.handler.requests[0]?.planHash);
    expect(current.deps.audit.entries.map((entry) => entry.action)).not.toContain(
      "set the current passwords of restored services",
    );
  });

  it("refuses before any change when a copy is of a later generation than the record", async () => {
    const world = await rotatedWorld([copy("mq", "rabbitmq", 3)]);
    const refused = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toBe(
      `The snapshot ${ID} holds mq at a later generation of its values (3) than this computer's rotation record (2): another computer rotated it since, so OpsCrew can't tell which values its data logs in with. Nothing was changed.`,
    );
    expect(world.handler.requests).toEqual([]);
  });

  it("refuses before any change when this computer no longer keeps the values of then", async () => {
    const world = await rotatedWorld([MQ], { history: {} });
    const refused = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toBe(
      `mq was rotated after the snapshot ${ID} was taken, and this computer no longer keeps the values it had then, which its restored data logs in with: the app could not reach it. Nothing was changed.`,
    );
    expect(refused.hint).toContain("`opscrew secrets restore`");
    expect(world.handler.requests).toEqual([]);
  });

  it("refuses before any change when another computer rotated since this one's values", async () => {
    const world = await rotatedWorld([MQ], { kept: 1 });
    const refused = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toContain("another computer rotated them");
    expect(world.handler.requests).toEqual([]);
  });

  it("tries a command again every 2 seconds while the service boots, until it passes", async () => {
    const world = await rotatedWorld([MQ]);
    await world.servers.app?.write("clock", "1000");
    // rabbitmqctl fails three times, as while RabbitMQ boots, then passes.
    await world.servers.app?.write("exec.fails", "3");
    await restoreSnapshot(world.deps, ID, { services: world.services });

    const run = await execs(world);
    expect(run).toHaveLength(4);
    for (const each of run) expect([each.old, each.new]).toEqual([THEN.mq, NOW.mq]);
    expect((await world.servers.app?.read("clock"))?.trim()).toBe("1006");
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ detail: `${ID}: mq from generation 1 to 2: done` }),
    );
  });

  it("puts the data back like a failed restore once the service's boot time runs out", async () => {
    const world = await rotatedWorld([MQ]);
    await world.servers.app?.write("clock", "1000");
    await world.servers.app?.write("exec.exit", "1");
    const failed = await failure(restoreSnapshot(world.deps, ID, { services: world.services }));

    // RabbitMQ's health check starts after 30 seconds, then tries 6 times 10 seconds apart; a
    // margin of 30 seconds.
    expect(failed.message).toBe(
      "OpsCrew could not give mq its current passwords again on the app's server (exit code 1): OpsCrew could not give mq its current passwords again within 120 seconds of its start; its commands' output is in .rotate/rotate.log in the app's folder there. OpsCrew put the data back as it was before the restore on the app's server too, which it had restored: nothing changed.",
    );
    expect(Number((await world.servers.app?.read("clock"))?.trim())).toBeGreaterThanOrEqual(1120);
    const calls = (await world.servers.app?.calls()) ?? [];
    // The copy from just before holds the current logins: its restore waits as usual.
    expect(calls.filter((call) => call.startsWith("restore "))).toEqual([
      `restore ${ID} --no-wait mq`,
      `restore ${SAVED}`,
    ]);
    expect(calls.at(-1)).toBe("resume");
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ detail: `${ID}: mq from generation 1 to 2: failed` }),
    );
  });
});

describe.skipIf(!SH_AVAILABLE)("opscrew restore after a rotation on this computer", () => {
  it("gives the restored volume copy its current value through the local docker exec, the values on stdin", async () => {
    const computer = new FakeComputer();
    const base = localPlan();
    const spec = serviceSpec("rabbitmq");
    const local = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        {
          name: "mq",
          kind: "rabbitmq",
          version: spec.defaultVersion,
          memoryMb: spec.memory.defaultMb,
          enabled: true,
          options: {},
          reason: "Events.",
          licence: spec.licence.id,
        },
      ],
    });
    const { deps } = await localProject(local, computer);
    const folder = appFolder(deps.paths, local);
    const version = "f".repeat(64);
    mkdirSync(join(folder, ".snapshots", ID), { recursive: true });
    writeFileSync(join(folder, "snapshot.sh"), `${snapshotScript(local).join("\n")}\n`);
    writeFileSync(join(folder, ".env"), "APP_IMAGE=opscrew-local/shop:0123456789ab\n");
    const about = {
      id: ID,
      kind: "manual",
      taken: "2026-11-06T19:00:00Z",
      version: `sha256:${version}`,
      services: [MQ],
    };
    writeFileSync(join(folder, ".snapshots", ID, "about.json"), `${JSON.stringify(about)}\n`);
    await writeArtifact("credentials", credentialsRecordFile(deps.paths), {
      schemaVersion: 1,
      environments: { prod: { mq: { rotatedAt: "2026-11-07T10:00:00.000Z", generation: 2 } } },
    });
    const dbPassword = fakeSecret("generic-password", "local db");
    await writeGenerated(
      { deps },
      {
        dbPassword,
        services: { mq: { password: NOW.mq } },
        generations: { mq: 2 },
        history: { mq: { "1": { password: THEN.mq } } },
      },
    );
    const apps = localRoots(deps.paths).apps.replaceAll("\\", "/");
    // Docker knows the local image, and the RabbitMQ container runs its pinned image.
    const docker = [
      "docker() {",
      `  if [ "$1 $2" = "image inspect" ]; then echo "sha256:${version}"; fi`,
      '  if [ "$1 $2" = "compose ps" ]; then echo c-mq; fi',
      `  if [ "$1" = inspect ]; then echo ${image("rabbitmq")}; fi`,
      "}",
    ].join("\n");
    computer.script = (text) => {
      if (/'(hold|resume)'/.test(text)) return { exitCode: 0, stdout: "", stderr: "" };
      if (text.includes("'restore'")) {
        return { exitCode: 0, stdout: `saved ${SAVED}\n`, stderr: "" };
      }
      if (text.includes("docker exec")) return { exitCode: 0, stdout: "", stderr: "" };
      const run = spawnSync("sh", ["-c", `${docker}\n${text}`], {
        encoding: "utf8",
        env: { ...process.env, OPSCREW_APPS_DIR: apps },
      });
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
    };
    await restoreSnapshot(deps, ID, { services: { localhost: computer.services() } });

    const restore = computer.scripts.find(({ script }) => script.includes("'restore'"));
    expect(restore?.script).toContain(`'restore' '${ID}' '--no-wait' 'mq'`);
    const relogin = computer.scripts.find(({ script }) => script.includes("docker exec"));
    expect(relogin?.script).toContain(
      'retry \'OPSCREW_OLD="$rot_old_1" OPSCREW_NEW="$rot_new_1" docker exec -e OPSCREW_OLD -e OPSCREW_NEW "$rot_c" ',
    );
    expect(relogin?.script).toContain('docker compose up -d --no-deps --wait "$s"');
    expect(relogin?.input).toBe(`${THEN.mq}\n${NOW.mq}\n`);
    for (const value of [THEN.mq, NOW.mq]) expect(relogin?.script).not.toContain(value);
    const order = computer.scripts.map(({ script }) =>
      script.includes("docker exec")
        ? "relogin"
        : (/'(hold|restore|resume)'/.exec(script)?.[1] ?? ""),
    );
    expect(order.filter((step) => step !== "")).toEqual(["hold", "restore", "relogin", "resume"]);
  });
});

describe("reloginCommand", () => {
  it("runs a conditional step on its checks, and creates Garage again from its env between begin and finish", () => {
    const plan = stagingPlan([{ kind: "garage", name: "s3" }], {
      fields: {
        storage: {
          objectStorage: {
            provider: "garage",
            bucket: "shop-uploads",
            region: "garage",
            expected: { storageGb: 10, egressGbPerMonth: 50 },
            price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
          },
        },
      },
    });
    const service = plan.services[0] as (typeof plan.services)[number];
    // Its RPC secret restarts: the restore's start already read it from the env.
    const steps = serviceSteps(plan, [service]).filter((step) => step.rotation.mode !== "restart");
    const { command, input } = reloginCommand([
      {
        server: "app",
        service: "s3",
        from: 1,
        to: 2,
        steps: steps.map((step) => ({ step, values: { old: "", new: "" } })),
        seconds: 90,
      },
    ]);
    const lines = command.split("\n");
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    // Each command tried again while the service boots, for its seconds.
    expect(lines).toContain("t=90");
    const rename = lines[at("'rename'")] ?? "";
    expect(rename).toMatch(
      /^retry 'if ! OPSCREW_OLD="\$rot_old_1" OPSCREW_NEW="\$rot_new_1" docker exec -e OPSCREW_OLD -e OPSCREW_NEW "\$rot_c" /,
    );
    expect(rename).toContain("opscrew-previous");
    expect(rename.endsWith("fi' || late")).toBe(true);
    expect(at("'rename'")).toBeLessThan(at("--force-recreate"));
    expect(lines[at("--force-recreate")]).toBe(
      'docker compose up -d --no-deps --force-recreate "$s" >> .rotate/rotate.log 2>&1 || failed',
    );
    expect(at("--force-recreate")).toBeLessThan(at("'delete'"));
    expect(lines.at(-1)).toBe(
      'docker compose up -d --no-deps --wait "$s" >> .rotate/rotate.log 2>&1 || failed',
    );
    expect(input).toBe("\n\n");
  });
});

describe.skipIf(!SH_AVAILABLE)("the earlier generations' values", () => {
  const earlier = {
    mq: { "1": { password: THEN.mq }, "2": { password: NOW.es } },
    db: { "1": { password: THEN.db } },
  };
  /** The CLI's listing, every provider's whole-server snapshots read (`whole`). */
  const listed = (world: SnapshotWorld, whole: Parameters<typeof fakeProvider>[0] = []) =>
    listSnapshots(world.deps, {
      services: { ...world.services, serverSnapshots: () => fakeProvider(whole).api },
      forgetUnneeded: true,
    });

  it("are kept while a volume copy needs them, and forgotten by the CLI's listing once none does", async () => {
    const world = await rotatedWorld([MQ, DB], { history: earlier });
    // Without the CLI's option (the MCP tool's listing), nothing changes.
    await listSnapshots(world.deps, { services: world.services });
    expect((await generated(world)).history).toEqual(earlier);
    await listed(world);
    // The copy holds mq at generation 1; nothing holds mq at 2, and a dump holds no login.
    expect((await generated(world)).history).toEqual({ mq: { "1": { password: THEN.mq } } });
    expect((await generated(world)).dbPassword).toBe(NOW.db);

    await world.servers.app?.write(`.snapshots/${ID}/about.json`, "");
    await listed(world);
    expect(Object.keys(await generated(world))).not.toContain("history");
  });

  it("are all kept while a whole-server snapshot from before a rotation needs them", async () => {
    const world = await rotatedWorld([], { history: earlier });
    await world.servers.app?.write(`.snapshots/${ID}/about.json`, "");
    await listed(world, [{ id: "770011", createdAt: "2026-11-05T08:00:00Z", sizeGb: 2 }]);
    expect((await generated(world)).history).toEqual(earlier);
    // One taken after the rotation needs none of them.
    await listed(world, [{ id: "770012", createdAt: "2026-11-08T08:00:00Z", sizeGb: 2 }]);
    expect(Object.keys(await generated(world))).not.toContain("history");
  });

  it("are all kept while a record can't be read, or a provider's snapshots aren't listed", async () => {
    const world = await rotatedWorld([MQ], { history: earlier });
    await listSnapshots(world.deps, { services: world.services, forgetUnneeded: true });
    expect((await generated(world)).history).toEqual(earlier);
    await world.servers.app?.write(".snapshots/20261105T000000Z/about.json", '{"id":"broken"}\n');
    await listed(world);
    expect((await generated(world)).history).toEqual(earlier);
  });
});
