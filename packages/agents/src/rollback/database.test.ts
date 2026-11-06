import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROLLBACK_APPROVAL_FILE, shellQuote } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { localPlan } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { splitPlan } from "../network/__fixtures__/plans";
import { digestOf, inEnvironment } from "../promote/__fixtures__/world";
import { recordOwnServer, recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  OWN_IPV4,
  ownPlan,
  SERVER_IPV4,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { FakeAppFolder, SH_AVAILABLE } from "./__fixtures__/folder";
import { failure } from "./__fixtures__/versions";
import {
  type DatabaseQuestion,
  databaseOutcome,
  databaseStep,
  hexOf,
  readScript,
  readSections,
  removeScript,
  writeScript,
} from "./database";
import type { RollbackOptions } from "./index";
import { rollbackRun } from "./run";

/** The version running now and the one a rollback goes back to. */
const CURRENT = digestOf("c");
const TARGET = digestOf("b");
const hex = (digest: string) => hexOf(digest) as string;
const WORDS = '1a2b3c4 "b"';
/** The test deps' clock, and when a one-time approval left then expires. */
const NOW = "2026-10-11T12:00:00.000Z";
const EXPIRY = Date.parse(NOW) / 1000 + 30 * 60;
const TAKEN = "2026-10-11T11:30:00Z";

/** A deployed plan of `shop`, as prod (or with `environment`, that environment's). */
function serverPlan(o: { environment?: string; extra?: Record<string, unknown> } = {}): DeployPlan {
  const prod = testPlan({ deployed: true });
  const base = o.environment === undefined ? prod : inEnvironment(prod, o.environment);
  return DeployPlanSchema.parse({ ...base, ...o.extra });
}

/** Knex's down migrations, run like the release command. */
const KNEX = {
  releaseCommand: "npx knex migrate:latest",
  migrations: {
    tool: "knex",
    status: "npx knex migrate:list",
    down: "npx knex migrate:down",
  },
} as const;

/**
 * The environment of `plan` with its app's folder on a fake server (or this computer), and the
 * database step of a rollback from {@link CURRENT} to {@link TARGET} with `options`.
 */
async function world(plan: DeployPlan) {
  const environment = plan.environment?.name;
  const deps: TestPhaseDeps = await createTestPhaseDeps(
    environment === undefined ? {} : { environment },
  );
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  const folder = await FakeAppFolder.create(`/srv/apps/${plan.app.name}`);
  const step = async (options: Omit<RollbackOptions, "services"> = {}) =>
    databaseStep(
      await rollbackRun(deps, { ...options, services: { remote: (host) => folder.remote(host) } }),
      { current: CURRENT, target: TARGET, words: WORDS },
    );
  return { deps, folder, step };
}

describe.skipIf(!SH_AVAILABLE)("the app folder's scripts, under sh", () => {
  it("reads only the files there are, and parses each one's text", async () => {
    const folder = await FakeAppFolder.create("/srv/apps/shop");
    await folder.write(`.snapshots/${hex(TARGET)}/taken`, `${TAKEN}\n`);
    await folder.write(`.schema/${hex(CURRENT)}`, "count=3");
    const paths = [
      `.snapshots/${hex(TARGET)}/taken`,
      `.schema/${hex(TARGET)}`,
      `.schema/${hex(CURRENT)}`,
    ];
    const result = folder.sh(readScript("/srv/apps/shop", paths));
    expect(result.exitCode).toBe(0);
    expect(readSections(result.stdout, paths)).toEqual(
      new Map([
        [`.snapshots/${hex(TARGET)}/taken`, TAKEN],
        [`.schema/${hex(CURRENT)}`, "count=3"],
      ]),
    );
  });

  it("writes the one-time approval, mode 600, over an earlier one, and removes it", async () => {
    const folder = await FakeAppFolder.create("/srv/apps/shop");
    await folder.write(ROLLBACK_APPROVAL_FILE, "earlier\n");
    const line = `${hex(TARGET)} snapshot ${EXPIRY}`;
    expect(folder.sh(writeScript("/srv/apps/shop", line)).exitCode).toBe(0);
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBe(`${line}\n`);
    if (process.platform !== "win32") {
      expect((await stat(join(folder.dir, ROLLBACK_APPROVAL_FILE))).mode & 0o777).toBe(0o600);
    }
    expect(folder.sh(removeScript("/srv/apps/shop")).exitCode).toBe(0);
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBeUndefined();
    expect(folder.sh(removeScript("/srv/apps/shop")).exitCode).toBe(0);
  });

  it("hands the file to the folder's owner when it runs as root, and every script is valid sh", () => {
    const write = writeScript("/srv/apps/shop", `${hex(TARGET)} snapshot ${EXPIRY}`);
    expect(write).toContain(
      `if [ "$(id -u)" = 0 ]; then chown --reference=. ${ROLLBACK_APPROVAL_FILE}; fi`,
    );
    for (const script of [
      write,
      removeScript("/srv/apps/shop"),
      readScript("/srv/apps/shop", []),
    ]) {
      expect(spawnSync("sh", ["-n", "-c", script]).status).toBe(0);
    }
  });
});

describe.skipIf(!SH_AVAILABLE)("the database step on a server", () => {
  it("offers staging's snapshot first and restores it by default, approved with the app's name", async () => {
    const { folder, step } = await world(serverPlan({ environment: "staging" }));
    await folder.write(`.snapshots/${hex(TARGET)}/taken`, TAKEN);

    const chosen = await step();

    expect(chosen.choice).toBe("snapshot");
    expect(chosen.lines[0]).toBe(
      `Database: Restore the snapshot taken 2026-10-11 11:30 UTC, when ${WORDS} stopped running. Everything written since is lost.`,
    );
    expect(chosen.confirmPhrase).toBe("shop-staging");
    expect(chosen.flags).toBe(" --database snapshot --confirm shop-staging");
    expect(chosen.binding).toEqual({
      choice: "snapshot",
      taken: TAKEN,
      currentRecord: null,
      targetRecord: null,
    });
    expect(chosen.record).toEqual({ choice: "snapshot", taken: TAKEN });
    expect(chosen.outcome).toBe(
      "The database was restored from the snapshot taken 2026-10-11 11:30 UTC.",
    );
    // One fixed read-only script, of the target's snapshot and both records.
    expect(folder.commands).toEqual([
      readScript("/srv/apps/shop-staging", [
        `.snapshots/${hex(TARGET)}/taken`,
        `.schema/${hex(TARGET)}`,
        `.schema/${hex(CURRENT)}`,
      ]),
    ]);

    // The one-time approval: the target's hex, the choice and an expiry 30 minutes on.
    expect(await chosen.leave()).toBe(new Date(EXPIRY * 1000).toISOString());
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBe(`${hex(TARGET)} snapshot ${EXPIRY}\n`);
    await chosen.clear();
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBeUndefined();
  });

  it("asks a terminal which, with the snapshot first and staging's default", async () => {
    const { folder, step } = await world(serverPlan({ environment: "staging" }));
    await folder.write(`.snapshots/${hex(TARGET)}/taken`, TAKEN);
    const asked: DatabaseQuestion[] = [];
    const chosen = await step({
      chooseDatabase: async (question) => {
        asked.push(question);
        return "keep";
      },
    });
    expect(asked).toEqual([
      {
        offers: [
          {
            choice: "snapshot",
            text: `Restore the snapshot taken 2026-10-11 11:30 UTC, when ${WORDS} stopped running. Everything written since is lost.`,
          },
          { choice: "keep", text: `Keep it as it is: ${WORDS} runs against today's schema.` },
        ],
        default: "snapshot",
      },
    ]);
    expect(chosen.choice).toBe("keep");
    expect(chosen.confirmPhrase).toBeUndefined();
    expect(chosen.flags).toBe(" --database keep");
    // Keep removes a one-time approval an earlier run left.
    await folder.write(ROLLBACK_APPROVAL_FILE, `${hex(TARGET)} snapshot ${EXPIRY}\n`);
    expect(await chosen.leave()).toBeUndefined();
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBeUndefined();
  });

  it("offers only keep without a complete snapshot, and refuses --database snapshot", async () => {
    const { folder, step } = await world(serverPlan({ environment: "staging" }));
    // A partial snapshot has no `taken`.
    await folder.write(`.snapshots/${hex(TARGET)}.partial/db.dump`, "partial");
    let asked = false;
    const chosen = await step({
      chooseDatabase: async () => {
        asked = true;
        return "snapshot";
      },
    });
    expect(asked).toBe(false);
    expect(chosen.choice).toBe("keep");
    expect(chosen.lines[0]).toBe(
      "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.",
    );

    const error = await failure(step({ database: "snapshot" }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The server keeps no complete snapshot of ${WORDS}: a deploy takes one when it replaces a version, and the server keeps those of the last 3. Nothing was changed.`,
    );
    expect(error.hint).toBe("Run `opscrew rollback --env staging` with --database keep.");
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBeUndefined();
  });

  it("reads nothing on prod without snapshots or down migrations, and says why each is refused", async () => {
    const { folder, step } = await world(serverPlan());
    const chosen = await step();
    expect(chosen).toMatchObject({ choice: "keep", flags: "", record: { choice: "keep" } });
    expect(chosen.binding).toBeUndefined();
    expect(folder.commands).toEqual([]);

    const snapshot = await failure(step({ database: "snapshot" }));
    expect(snapshot.message).toBe(
      "prod takes no snapshots before its releases: deploy.snapshots is off in its plan (prod takes them only with deploy.snapshots: true). Nothing was changed.",
    );
    const migrations = await failure(step({ database: "migrations" }));
    expect(migrations.message).toBe(
      "prod's plan has no app.migrations, so OpsCrew knows no down migrations for its app. It sets them for Rails, Django, Alembic, Flask-Migrate, Knex, Sequelize, TypeORM and Laravel. Nothing was changed.",
    );
    expect(folder.commands).toEqual([]);

    // Keep still removes a one-time approval an earlier run left, expired or not.
    await folder.write(ROLLBACK_APPROVAL_FILE, `${hex(TARGET)} snapshot ${EXPIRY - 3600}\n`);
    expect(await chosen.leave()).toBeUndefined();
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBeUndefined();
    expect(folder.commands).toEqual([removeScript("/srv/apps/shop")]);
  });

  it("on the user's own server, reads and writes as root through sudo when the login needs it", async () => {
    const plan = DeployPlanSchema.parse({
      ...ownPlan({ deployed: true }),
      deploy: { snapshots: true },
    });
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, plan);
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "alice",
      agent: true,
      reachable: true,
    });
    // The host adapter's probe: this login reaches Docker only through passwordless sudo.
    const folder = await FakeAppFolder.create("/srv/apps/shop", (command) =>
      command.includes("echo sudo") ? { exitCode: 0, stdout: "sudo\n", stderr: "" } : undefined,
    );
    await folder.write(`.snapshots/${hex(TARGET)}/taken`, TAKEN);
    const run = await rollbackRun(deps, {
      database: "snapshot",
      services: { remote: (host) => folder.remote(host) },
    });
    const chosen = await databaseStep(run, { current: CURRENT, target: TARGET, words: WORDS });
    expect(chosen.choice).toBe("snapshot");
    await chosen.leave();
    const read = readScript("/srv/apps/shop", [
      `.snapshots/${hex(TARGET)}/taken`,
      `.schema/${hex(TARGET)}`,
      `.schema/${hex(CURRENT)}`,
    ]);
    const write = writeScript("/srv/apps/shop", `${hex(TARGET)} snapshot ${EXPIRY}`);
    expect(folder.commands.slice(1)).toEqual([
      `sudo -n sh -c ${shellQuote(read)}`,
      `sudo -n sh -c ${shellQuote(write)}`,
    ]);
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBe(`${hex(TARGET)} snapshot ${EXPIRY}\n`);
  });

  it("offers down migrations when both records are there and the count went down", async () => {
    const plan = serverPlan({
      environment: "staging",
      extra: { app: { ...serverPlan().app, name: "shop-staging", ...KNEX } },
    });
    const { folder, step } = await world(plan);
    await folder.write(`.schema/${hex(CURRENT)}`, "count=3\n");
    await folder.write(`.schema/${hex(TARGET)}`, "count=2\n");

    const chosen = await step({ database: "migrations" });
    expect(chosen.lines[0]).toBe(
      `Database: Migrate it down with knex to ${WORDS}'s migrations. The tables and columns added since are dropped, with their data.`,
    );
    expect(chosen.binding).toEqual({
      choice: "migrations",
      taken: null,
      currentRecord: "count=3",
      targetRecord: "count=2",
    });
    expect(chosen.record).toEqual({ choice: "migrations" });
    expect(chosen.confirmPhrase).toBe("shop-staging");
    await chosen.leave();
    expect(await folder.read(ROLLBACK_APPROVAL_FILE)).toBe(`${hex(TARGET)} migrations ${EXPIRY}\n`);
    // Without a snapshot, staging keeps its data unless asked.
    expect((await step()).choice).toBe("keep");

    // A count that grew going back is no straight line.
    await folder.write(`.schema/${hex(TARGET)}`, "count=4\n");
    const grew = await failure(step({ database: "migrations" }));
    expect(grew.message).toBe(
      `${WORDS} has more migrations applied than the version running now, or a record of them is unreadable, so migrating down would not reach its schema. Nothing was changed.`,
    );
  });

  it("refuses down migrations without the records of both versions", async () => {
    const plan = serverPlan({
      environment: "staging",
      extra: { app: { ...serverPlan().app, name: "shop-staging", ...KNEX } },
    });
    const { folder, step } = await world(plan);
    await folder.write(`.schema/${hex(CURRENT)}`, "count=3\n");
    const error = await failure(step({ database: "migrations" }));
    expect(error.message).toBe(
      `The server holds no record of the migrations of ${WORDS}: each deploy records them after its release command. Nothing was changed.`,
    );
  });

  it("offers a version tool's down migrations whatever its versions", async () => {
    const alembic = {
      releaseCommand: "alembic upgrade head",
      migrations: {
        tool: "alembic",
        status: "alembic current",
        down: "alembic downgrade {version}",
      },
    } as const;
    const plan = serverPlan({ extra: { app: { ...serverPlan().app, ...alembic } } });
    const { folder, step } = await world(plan);
    await folder.write(`.schema/${hex(CURRENT)}`, "version=0002\n");
    await folder.write(`.schema/${hex(TARGET)}`, "version=0001\n");
    const chosen = await step({ database: "migrations" });
    expect(chosen.choice).toBe("migrations");
  });

  it("stops on a read the server answered with a failure, before any change", async () => {
    const { folder, step } = await world(serverPlan({ environment: "staging" }));
    folder.failWith = 4;
    const error = await failure(step());
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "OpsCrew could not read the database's snapshots and migration records on the app's server (exit code 4). Nothing was changed.",
    );
  });

  it("shows no record line or address, and the hash binds what it read", async () => {
    const record = "version=20261011120000_secret_marker";
    const alembic = {
      releaseCommand: "alembic upgrade head",
      migrations: {
        tool: "alembic",
        status: "alembic current",
        down: "alembic downgrade {version}",
      },
    } as const;
    const plan = serverPlan({
      environment: "staging",
      extra: { app: { ...serverPlan().app, name: "shop-staging", ...alembic } },
    });
    const { deps, folder, step } = await world(plan);
    await folder.write(`.schema/${hex(CURRENT)}`, `${record}\n`);
    await folder.write(`.schema/${hex(TARGET)}`, "version=20261010120000_earlier\n");
    await folder.write(`.snapshots/${hex(TARGET)}/taken`, TAKEN);
    const chosen = await step({ database: "migrations" });
    expect(chosen.binding?.currentRecord).toBe(record);
    const shown = [
      ...chosen.lines,
      chosen.outcome,
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
    ].join("\n");
    expect(shown).not.toContain("secret_marker");
    expect(shown).not.toContain("earlier");
    expect(shown).not.toContain(SERVER_IPV4);
  });
});

describe("databaseOutcome", () => {
  it("says what the rollback did with the database, for each choice", () => {
    const plan = serverPlan({ extra: { app: { ...serverPlan().app, ...KNEX } } });
    expect(databaseOutcome({ choice: "snapshot", taken: TAKEN }, plan, WORDS)).toBe(
      "The database was restored from the snapshot taken 2026-10-11 11:30 UTC.",
    );
    expect(databaseOutcome({ choice: "migrations" }, plan, WORDS)).toBe(
      `The database was migrated down with knex to ${WORDS}'s migrations.`,
    );
    expect(databaseOutcome({ choice: "keep" }, plan, WORDS)).toBe("The database stayed as it was.");
  });
});

describe("the database step elsewhere", () => {
  it("names a database on another server and the app's own files as kept", async () => {
    const plan = {
      ...splitPlan(),
      environment: { name: "staging" },
      storage: { sqlite: { dir: "data" } },
    } as DeployPlan;
    const deps = await createTestPhaseDeps({ environment: "staging" });
    await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
    const folder = await FakeAppFolder.create("/srv/apps/shop");
    const chosen = await databaseStep(
      {
        deps,
        options: {},
        services: { remote: (host) => folder.remote(host) },
        plan,
        environment: "staging",
        flags: " --env staging",
        command: "opscrew rollback --env staging",
      },
      { current: CURRENT, target: TARGET, words: WORDS },
    );
    expect(chosen.choice).toBe("keep");
    expect(chosen.lines).toContain(
      "Kept as they are: db on server data and the app's own files. Snapshots of them come in a later release.",
    );
  });

  it("on this computer reads and writes the app's folder", async () => {
    const plan = DeployPlanSchema.parse({
      ...localPlan({ image: "registry" }),
      deploy: { snapshots: true },
      deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" },
    });
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, plan);
    const folder = appFolder(deps.paths, plan);
    await mkdir(join(folder, `.snapshots/${hex(TARGET)}`), { recursive: true });
    await writeFile(join(folder, `.snapshots/${hex(TARGET)}/taken`), TAKEN);
    const run = await rollbackRun(deps, { database: "snapshot" });
    const chosen = await databaseStep(run, {
      current: `ghcr.io/acme/shop@${CURRENT}`,
      target: `ghcr.io/acme/shop@${TARGET}`,
      words: "sha256:aaaaaaaaaaaa",
    });
    expect(chosen.choice).toBe("snapshot");
    await chosen.leave();
    const file = join(folder, ROLLBACK_APPROVAL_FILE);
    expect(await readFile(file, "utf8")).toBe(`${hex(TARGET)} snapshot ${EXPIRY}\n`);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    await chosen.clear();
    expect(existsSync(file)).toBe(false);
  });
});
