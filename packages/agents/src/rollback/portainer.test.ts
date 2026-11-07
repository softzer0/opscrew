import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FakeContainer, FakeFile } from "@opscrew/connector-docker/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { DEPLOY_PAUSED_VARIABLE, IMAGES, portainerStackTemplatePath } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { blobOf, cleanDrift, DEPLOY_RUN_URL } from "../promote/__fixtures__/world";
import {
  DB_SECRET,
  PORTAINER_TOKEN,
  type PortainerWorld,
  portainerWorld,
  SH,
} from "../snapshot/__fixtures__/portainer";
import { stagingPlan } from "../snapshot/__fixtures__/world";
import { restoreSnapshot } from "../snapshot/restore";
import { PORTAINER_HOST, portainerPlan, type ScriptedApprovalHandler } from "../testing";
import { type Built, failure, versionsWorld } from "./__fixtures__/versions";
import { hexOf } from "./database";
import { type RollbackOptions, type RollbackServices, rollback } from "./index";
import {
  type DatabaseBinding,
  imageRollbackHash,
  PENDING_ROLLBACK_FILE,
  readPendingRollback,
  readRollback,
  rollbackFile,
} from "./record";
import { shortImage } from "./versions";

const STAGING = "opscrew rollback --env staging";
const WORKFLOW = ".github/workflows/opscrew-deploy-staging.yml";
/** Staging's deploy branch, which Portainer deploys. */
const DEPLOY_BRANCH = "opscrew-deploy-staging";
/** When b's snapshot was taken. */
const TAKEN = "2026-10-11T11:30:00Z";
/** The copy taken just before the restore: the test clock's time. */
const SAVED = "20261011T120000Z";
const KEEP_LINE =
  "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.";

/** `shop` in staging in the user's Portainer: PostgreSQL `db`, the stop-only Kafka and SQLite. */
function stagingPortainer(): DeployPlan {
  return stagingPlan(
    [
      { kind: "postgres", name: "db" },
      { kind: "kafka", name: "kafka" },
    ],
    { sqlite: true, base: portainerPlan({ deployed: true }) },
  );
}

/** The image reference of `built`, as GHCR names it and the stack runs it. */
const imageOf = (built: Built) => `ghcr.io/acme/shop@${built.digest}`;

/** A file in a fake volume, root's, mode 600. */
const file = (text: string): FakeFile => ({
  type: "file",
  mode: 0o600,
  uid: 0,
  gid: 0,
  data: Buffer.from(text),
});

/**
 * Staging in the user's Portainer, deployed three times with c running and b's snapshot before a
 * release in the snapshots volume (unless `snapshot` is false), the stack template merged on main.
 * Each dispatch plays Portainer's redeploy as `play.redeploy` says: `none` (the run deploys
 * nothing), `target` (the deploy branch names the dispatched version, which starts), or `revert`
 * (it starts, fails its health check, and the workflow's revert writes c back to the branch, whose
 * snapshot step the stack's guard refuses while the data is marked for another). `events` records,
 * in order, each restore's source, the mark's writes and each stack container that starts.
 */
async function world(
  o: {
    plan?: DeployPlan;
    snapshot?: boolean;
    approve?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  } = {},
) {
  const plan = o.plan ?? stagingPortainer();
  const portainer = await portainerWorld(
    plan,
    o.approve === undefined ? {} : { answer: o.approve },
  );
  const { deps, docker } = portainer;
  const base = await versionsWorld({ environment: "staging" });
  const github = Object.assign(base.github, {
    async setRepoVariable(_owner: string, _repo: string, name: string, value: string) {
      base.github.variables.set(name, value);
    },
    async deleteRepoVariable(_owner: string, _repo: string, name: string) {
      base.github.variables.delete(name);
    },
  });
  const merged = async (path: string, text: string) => {
    const file = join(deps.paths.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    github.onMain.set(path, blobOf(text));
  };
  await merged(WORKFLOW, "name: OpsCrew deploy (staging)\n");
  await merged(portainerStackTemplatePath(plan), "services: {}\n");
  const on = { environment: "staging" };
  base.deploy("a", 1, on);
  const b = base.deploy("b", 2, on);
  const c = base.deploy("c", 3, on);
  base.label("staging", c);
  base.label("staging", b, true);
  const hexB = hexOf(b.digest) as string;
  const app = appContainer(portainer);
  app.image = imageOf(c);
  portainer.probe.version = hexOf(c.digest);
  portainer.volume().set(".running", file(`${imageOf(c)}\n`));
  if (o.snapshot !== false) portainer.store(hexB, about(hexB, b));
  /** The deploy branch's compose.yaml names `built`. */
  const branch = (built: Built) =>
    github.files.set(`${DEPLOY_BRANCH}:compose.yaml`, `image: ${imageOf(built)}\n`);
  branch(c);

  const events: string[] = [];
  const volume = () => portainer.volume();
  const name = (image: string) => (hexOf(image) === hexOf(c.digest) ? "c" : "b");
  const inner = docker.onStart;
  docker.onStart = (container) => {
    const script = container.cmd[2] ?? "";
    const service = container.labels["com.docker.compose.service"];
    if (service !== undefined) events.push(`start ${service} ${name(container.image)}`);
    const mark =
      /^umask 077 && printf '%s\\n%s\\n' '([^']+)' '([^']+)' > \/snapshots\/\.restored\.tmp/.exec(
        script,
      );
    if (mark !== null) {
      volume().set(".restored", file(`${mark[1]}\n${mark[2]}\n`));
      events.push(`mark ${name(mark[1] ?? "")}`);
      return { exitCode: 0 };
    }
    if (script.startsWith("if [ -f /snapshots/.restored ]; then echo mark;")) {
      const text = volume().get(".restored")?.data?.toString();
      return { exitCode: 0, stdout: text === undefined ? "" : `mark\n${text}` };
    }
    const reset = /^printf '%s\\n' '([^']+)' > \/snapshots\/\.running\.tmp/.exec(script)?.[1];
    if (reset !== undefined) {
      volume().set(".running", file(`${reset}\n`));
      events.push(`running ${name(reset)}`);
      return { exitCode: 0 };
    }
    if (script === "rm -f /snapshots/.restored") {
      volume().delete(".restored");
      events.push("unmark");
      return { exitCode: 0 };
    }
    // The restore's removal of a stuck rollback's mark, when its way out names that restore.
    const restoring = /grep -Eq '\^opscrew restore ([0-9A-Za-z]+)\( \|\$\)'/.exec(script)?.[1];
    if (restoring !== undefined) {
      const way = volume().get(".restored")?.data?.toString().split("\n")[1] ?? "";
      if (!new RegExp(`^opscrew restore ${restoring}( |$)`).test(way)) return { exitCode: 0 };
      volume().delete(".restored");
      events.push("unmark");
      return { exitCode: 0, stdout: "removed\n" };
    }
    const from = /(?:--single-transaction|-xpf) \/snapshots\/([0-9A-Za-z]+)\//.exec(script)?.[1];
    if (from !== undefined) events.push(`restore ${from === hexB ? "b" : from}`);
    return inner?.(container);
  };

  const play: { redeploy: "none" | "target" | "revert" } = { redeploy: "target" };
  /** Portainer's redeploy of `built`: refused by the guard while the data is marked for another. */
  const redeploy = (built: Built) => {
    // The guard reads the first line: the image the data was restored for.
    const marked = volume().get(".restored")?.data?.toString().split("\n")[0];
    const blocked = marked !== undefined && hexOf(marked) !== hexOf(built.digest);
    const old = appContainer(portainer);
    docker.containers.delete(old.id);
    const id = `${old.id.slice(0, 60)}${built === b ? "000b" : "000c"}`;
    docker.containers.set(id, { ...old, id, image: imageOf(built), state: "created" });
    const word = built === b ? "b" : "c";
    if (blocked) {
      events.push(`refused ${word}`);
      return;
    }
    const started = docker.containers.get(id) as FakeContainer;
    started.state = "running";
    events.push(`ran ${word}`);
    volume().set(".running", file(`${imageOf(built)}\n`));
  };
  const atDispatch: { app?: string; marked?: string; saved?: boolean }[] = [];
  const dispatch = github.dispatchWorkflow.bind(github);
  github.dispatchWorkflow = async (...args: Parameters<typeof dispatch>) => {
    atDispatch.push({
      app: appContainer(portainer).state,
      marked: volume().get(".restored")?.data?.toString(),
      saved: volume().has(`${SAVED}/about.json`),
    });
    const accepted = await dispatch(...args);
    const target = args[4]?.digest === b.digest ? b : c;
    if (play.redeploy !== "none") {
      branch(target);
      redeploy(target);
    }
    if (play.redeploy === "revert") {
      branch(c);
      redeploy(c);
    }
    return accepted;
  };

  const services: RollbackServices = {
    github,
    drift: async () => cleanDrift(),
    sleep: async () => {},
    now: (() => {
      let clock = 0;
      return () => (clock += 10_000);
    })(),
    ...(portainer.services.portainer !== undefined
      ? { portainer: portainer.services.portainer }
      : {}),
  };
  const run = (options: Omit<RollbackOptions, "services"> = {}) =>
    rollback(deps, { ...options, services });
  /** `opscrew restore <id>` in this Portainer. */
  const restore = (id: string) =>
    restoreSnapshot(deps, id, {
      services: {
        github,
        ...(portainer.services.portainer ? { portainer: portainer.services.portainer } : {}),
      },
    });
  return {
    ...portainer,
    github,
    b,
    c,
    hexB,
    events,
    play,
    atDispatch,
    branch,
    redeploy,
    run,
    restore,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** b's snapshot before a release: the database and SQLite, as the stack's finalizer writes it. */
function about(hex: string, b: Built, services?: object[]) {
  return {
    id: hex,
    kind: "release",
    taken: TAKEN,
    version: b.digest,
    services: services ?? [
      { name: "db", kind: "postgres", file: "db.dump", size: 4, image: IMAGES.postgres.ref },
      { name: "sqlite", kind: "sqlite", file: "sqlite.tar", size: 4 },
    ],
  };
}

/** The stack's app container. */
function appContainer(world: Pick<PortainerWorld, "docker">): FakeContainer {
  const found = [...world.docker.containers.values()].find(
    (each) => each.labels["com.docker.compose.service"] === "app",
  );
  if (found === undefined) throw new Error("The stack has no app container.");
  return found;
}

/** The rollback's hash from c to b with the database step's binding. */
function hashOf(world: World, binding: DatabaseBinding): string {
  return imageRollbackHash({
    environment: "shop/staging",
    current: world.c.digest,
    target: world.b.digest,
    targetPlanHash: sha256Hex(canonicalJson(world.plan)),
    database: binding,
  });
}

/** The pause variable as JSON, `undefined` when GitHub has none. */
function paused(world: World): Record<string, unknown> | undefined {
  const text = world.github.variables.get(DEPLOY_PAUSED_VARIABLE);
  return text === undefined ? undefined : JSON.parse(text);
}

/** Everything a run showed, wrote or recorded: none may hold a secret or Portainer's address. */
async function everythingShown(world: World, error?: unknown): Promise<string> {
  const files = await Promise.all(
    [rollbackFile(world.deps.paths), join(world.deps.paths.stateDir, PENDING_ROLLBACK_FILE)].map(
      (path) => readFile(path, "utf8").catch(() => ""),
    ),
  );
  return [
    world.deps.reporter.text(),
    JSON.stringify(world.deps.audit.entries),
    JSON.stringify(world.handler.requests),
    JSON.stringify([...world.github.variables]),
    JSON.stringify(world.github.dispatches),
    error instanceof Error ? `${error.message} ${(error as { hint?: string }).hint ?? ""}` : "",
    ...files,
  ].join("\n");
}

/** No secret and not Portainer's address in what `world` showed. */
async function nothingLeaked(world: World, error?: unknown) {
  const shown = await everythingShown(world, error);
  expect(shown).not.toContain(DB_SECRET);
  expect(shown).not.toContain(PORTAINER_TOKEN);
  expect(shown).not.toContain(PORTAINER_HOST);
}

const words = (world: World) => `${world.b.commit.slice(0, 7)} "b"`;

/** The way out of a stuck rollback, which the mark, the guard and the messages name. */
const WAY_OUT = `opscrew restore ${SAVED} --env staging`;

/** The mark on the data restored for b: its image, then the way out. */
const MARK = (world: World) => `${imageOf(world.b)}\n${WAY_OUT}\n`;

/** The mark the undo leaves when the deploy branch still names b: for c, its way out the rollback. */
const BACK = (world: World) =>
  `${imageOf(world.c)}\n${STAGING} --to ${world.c.digest} --database keep\n`;

/** Makes the next scripts that hold `text` fail with exit 1, `times` times (default always). */
function failWith(world: World, text: string, times = Number.POSITIVE_INFINITY) {
  const start = world.docker.onStart;
  let left = times;
  world.docker.onStart = (each) => {
    if (left > 0 && (each.cmd[2] ?? "").includes(text)) {
      left--;
      return { exitCode: 1 };
    }
    return start?.(each);
  };
}

describe.skipIf(!SH)(
  "opscrew rollback --database snapshot in the user's Portainer (D14, D19)",
  () => {
    it("restores the target's snapshot before the dispatch, approved like a destroy, and unmarks the data once the run succeeded", async () => {
      const w = await world();

      const result = await w.run({ database: "snapshot" });

      expect(result).toMatchObject({
        kind: "rolled-back",
        status: "deployed",
        database: { choice: "snapshot", taken: TAKEN },
      });
      const request = w.handler.requests[0] as ApprovalRequest;
      expect(request).toMatchObject({
        kind: "promote",
        planHash: hashOf(w, {
          choice: "snapshot",
          taken: TAKEN,
          currentRecord: null,
          targetRecord: null,
        }),
        allowDestroy: true,
        confirmPhrase: "shop-staging",
      });
      expect(request.details).toContain(
        `Database: Restore the snapshot taken 2026-10-11 11:30 UTC, when ${words(w)} stopped running. Everything written since is lost.`,
      );
      expect(request.details).toContain(
        "Kept as they are, since the snapshot holds no copy of them: kafka (it must stop for its copy, which the snapshot before a release in your Portainer never does).",
      );
      expect(request.details).toContain(
        `Typing shop-staging approves it. OpsCrew then stops the app in your Portainer, copies its data as it is now, restores the snapshot and starts the rollback's run, which starts ${words(w)}: until the rollback ends, no other version starts on that data.`,
      );
      expect(request.details).not.toContain(KEEP_LINE);
      // Before the dispatch: the app stopped, the copy taken, the data marked, then restored.
      expect(w.atDispatch).toEqual([{ app: "exited", marked: MARK(w), saved: true }]);
      expect(w.events).toEqual(["mark b", "restore b", "restore b", "ran b", "unmark"]);
      expect(w.volume().has(".restored")).toBe(false);
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.b), state: "running" });
      expect((await readRollback(w.deps.paths))?.database).toEqual({
        choice: "snapshot",
        taken: TAKEN,
      });
      expect(w.deps.reporter.text()).toContain(
        "The database was restored from the snapshot taken 2026-10-11 11:30 UTC.",
      );
      expect(w.deps.audit.entries).toContainEqual(
        expect.objectContaining({
          action: "restore a snapshot for a rollback",
          target: "portainer",
          detail: `${w.hexB}: db, sqlite: restored for the rollback to ${imageOf(w.b)}`,
        }),
      );
      await nothingLeaked(w);
    });

    it("keeps the data by default and with --database keep, touching nothing in Portainer", async () => {
      const w = await world();
      const questions: unknown[] = [];
      const result = await w.run({
        chooseDatabase: async (question) => {
          questions.push(question);
          return question.default;
        },
      });
      expect(questions).toEqual([
        {
          offers: [
            expect.objectContaining({ choice: "snapshot" }),
            expect.objectContaining({ choice: "keep" }),
          ],
          default: "keep",
        },
      ]);
      expect(result).toMatchObject({ database: { choice: "keep" } });
      const request = w.handler.requests[0] as ApprovalRequest;
      expect(request.allowDestroy).toBeUndefined();
      expect(request.details).toContain(KEEP_LINE);
      expect(request.planHash).toBe(
        hashOf(w, { choice: "keep", taken: TAKEN, currentRecord: null, targetRecord: null }),
      );
      expect(w.events).toEqual(["ran b"]);
      expect(w.volume().has(`${SAVED}/about.json`)).toBe(false);
      expect(w.volume().has(".restored")).toBe(false);
    });

    it("refuses the snapshot until the stack template on the dispatch branch is the committed one", async () => {
      const w = await world();
      w.github.onMain.set(portainerStackTemplatePath(w.plan), blobOf("services: {old: {}}\n"));
      const error = await failure(w.run({ database: "snapshot" }));
      expect(error.message).toBe(
        `The stack template on the branch the rollback's run deploys from (${portainerStackTemplatePath(w.plan)}) is not the one committed here, so the stack may not keep other versions off the restored data. Merge the deploy-setup pull request \`opscrew provision --env staging\` opened (or run it, if none is open) first. Nothing was changed.`,
      );
      expect(w.handler.requests).toEqual([]);
      expect(w.events).toEqual([]);
    });

    it("puts the copy back, then unmarks the data and starts the app, when the restore fails before any dispatch", async () => {
      const w = await world();
      failWith(w, `/snapshots/${w.hexB}/db.dump`);

      const error = await failure(w.run({ database: "snapshot" }));

      expect(error.message).toBe(
        `Restoring the snapshot of ${words(w)} failed (OpsCrew could not restore db (its output can quote data, so it is not shown) in your Portainer (exit code 1)), so OpsCrew put the data back as it was (the snapshot ${SAVED}), and the app runs again. The rollback did not start, and OpsCrew put staging's deploy pause back as it was. Nothing was changed.`,
      );
      expect(w.events).toEqual([
        "mark b",
        `restore ${SAVED}`,
        `restore ${SAVED}`,
        "unmark",
        "start app c",
      ]);
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.c), state: "running" });
      expect(w.github.dispatches).toEqual([]);
      expect(paused(w)).toBeUndefined();
      expect(w.volume().has(".restored")).toBe(false);
      await nothingLeaked(w, error);
    });

    it("keeps the mark, naming the way out, when putting the copy back fails too", async () => {
      const w = await world();
      failWith(w, "pg_restore");

      const error = await failure(w.run({ database: "snapshot" }));

      expect(error.code).toBe("COMMAND_FAILED");
      expect(error.message).toContain(
        `and putting back the data as it was before the rollback failed too, so it may be partly changed. The app stays stopped in your Portainer and staging's deploys stay paused, so no version runs on it. The copy from just before the rollback is the snapshot ${SAVED} in your Portainer.`,
      );
      expect(error.message).not.toContain("Nothing was changed");
      expect(error.hint).toBe(
        `Once the cause is fixed, run \`${WAY_OUT}\`: it puts that copy back and removes /snapshots/.restored. Then run \`${STAGING} --resume\` and redeploy the stack in Portainer.`,
      );
      expect(w.volume().get(".restored")?.data?.toString()).toBe(MARK(w));
      expect(appContainer(w).state).toBe("exited");
      expect(paused(w)).toEqual({
        "shop/staging": expect.objectContaining({ reason: "rollback" }),
      });
      expect(w.github.dispatches).toEqual([]);
    });

    it("gets out of a stuck mark with the restore it names, which another restore leaves alone, after which the next deploy starts", async () => {
      const w = await world();
      w.play.redeploy = "revert";
      w.github.conclusion = "failure";
      failWith(w, `/snapshots/${SAVED}/db.dump`, 1);

      const stuck = await failure(w.run({ database: "snapshot" }));

      expect(stuck.message).toContain(
        `The copy from just before the rollback is the snapshot ${SAVED}`,
      );
      expect(stuck.hint).toContain(`run \`${WAY_OUT}\`: it puts that copy back`);
      // The mark names the way out on its second line, which the stack's guard prints.
      expect(w.volume().get(".restored")?.data?.toString()).toBe(MARK(w));
      expect(w.volume().get(".running")?.data?.toString()).toBe(`${imageOf(w.c)}\n`);
      w.redeploy(w.c);
      expect(w.events.at(-1)).toBe("refused c");

      // Any rollback refuses, naming the way out.
      const refused = await failure(w.run({ database: "keep" }));
      expect(refused.message).toBe(
        `staging's data in your Portainer is marked for ${shortImage(imageOf(w.b))} by a rollback that did not end (/snapshots/.restored), so OpsCrew starts no other rollback on it. Nothing was changed.`,
      );
      expect(refused.hint).toBe(`Run \`${WAY_OUT}\`.`);

      // Another snapshot of the running version leaves the mark alone.
      const other = "20261011T100000Z";
      w.store(other, { ...about(other, w.c), kind: "manual", version: w.c.digest });
      expect(await w.restore(other)).toMatchObject({ id: other });
      expect(w.volume().get(".restored")?.data?.toString()).toBe(MARK(w));

      await w.restore(SAVED);
      expect(w.volume().has(".restored")).toBe(false);
      expect(w.deps.reporter.text()).toContain(
        "OpsCrew removed /snapshots/.restored, which a rollback left to keep other versions off the data it restored: the stack's next deploy starts the app again (redeploy it in Portainer).",
      );
      w.redeploy(w.c);
      expect(w.events.at(-1)).toBe("ran c");
      await nothingLeaked(w, stuck);
    });

    it("says nothing was changed once when the disk is too full for the copy", async () => {
      const w = await world();
      w.probe.freeKb = 1;
      const error = await failure(w.run({ database: "snapshot" }));
      expect(error.message.match(/Nothing was changed\./g)).toHaveLength(1);
      expect(error.message).toMatch(
        /^The disk that holds the snapshots in your Portainer has .* The rollback did not start, and OpsCrew put staging's deploy pause back as it was\. Nothing was changed\.$/,
      );
      expect(appContainer(w).state).toBe("running");
      expect(w.github.dispatches).toEqual([]);
      expect(paused(w)).toBeUndefined();
    });

    it("refuses a snapshot that is missing or incomplete, naming why, before any change", async () => {
      const missing = await world({ snapshot: false });
      const none = await failure(missing.run({ database: "snapshot" }));
      expect(none.message).toBe(
        `Your Portainer keeps no complete snapshot of ${words(missing)}: a deploy takes one when it replaces a version, and keeps those of the last 3. Nothing was changed.`,
      );
      expect(none.hint).toBe(`Run \`${STAGING}\` with --database keep.`);

      const partial = await world();
      partial.store(
        partial.hexB,
        about(partial.hexB, partial.b, [
          { name: "db", kind: "postgres", failed: true },
          { name: "sqlite", kind: "sqlite", file: "sqlite.tar", size: 4 },
        ]),
      );
      const failed = await failure(partial.run({ database: "snapshot" }));
      expect(failed.message).toBe(
        `The snapshot of ${words(partial)} in your Portainer is incomplete: the copy of db failed. Nothing was changed.`,
      );
      for (const each of [missing, partial]) {
        expect(each.handler.requests).toEqual([]);
        expect(each.github.dispatches).toEqual([]);
        expect(paused(each)).toBeUndefined();
        expect(appContainer(each).state).toBe("running");
        expect(each.events).toEqual([]);
      }
    });

    it("never starts the version that ran on the restored data when the target fails: the guard holds until the copy is back", async () => {
      const w = await world();
      w.play.redeploy = "revert";
      w.github.conclusion = "failure";

      const error = await failure(w.run({ database: "snapshot" }));

      expect(error.message).toContain(
        `OpsCrew put the data back as it was before the rollback (the snapshot ${SAVED}) and started the version that ran again. OpsCrew put staging's deploy pause back as it was.`,
      );
      // b ran on its data; c's revert was refused while the data was marked for b, and c started only
      // once the copy was back and the mark gone.
      expect(w.events).toEqual([
        "mark b",
        "restore b",
        "restore b",
        "ran b",
        "refused c",
        "running c",
        `restore ${SAVED}`,
        `restore ${SAVED}`,
        "unmark",
        "start app c",
      ]);
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.c), state: "running" });
      expect(w.volume().has(".restored")).toBe(false);
      expect(paused(w)).toBeUndefined();
      expect(await readRollback(w.deps.paths)).toBeUndefined();
      await nothingLeaked(w, error);
    });

    it.each([
      ["the run is cancelled", "cancelled"],
      ["the revert could not push", "failure"],
    ] as const)(
      "marks the data for the version that ran when %s and the branch still names the target",
      async (_what, conclusion) => {
        const w = await world();
        // b ran and failed; the revert never wrote c back to the branch.
        w.github.conclusion = conclusion;

        const error = await failure(w.run({ database: "snapshot" }));

        expect(error.message).toContain(
          `OpsCrew put the data back as it was before the rollback (the snapshot ${SAVED}), but your Portainer has no container of the version that ran left, so the app stays stopped. The deploy branch ${DEPLOY_BRANCH} still names the version the rollback went to (the workflow's revert was cancelled or could not push), so OpsCrew marked the data for the version that ran: no other version starts on it. To write that version back to the branch, run \`${STAGING} --to ${w.c.digest} --database keep\`, or write the compose.yaml of the commit before the newest one back to ${DEPLOY_BRANCH} by hand.`,
        );
        expect(w.volume().get(".restored")?.data?.toString()).toBe(BACK(w));
        // Portainer's next redeploy of the branch, b, is refused on c's data.
        w.redeploy(w.b);
        expect(w.events.at(-1)).toBe("refused b");
      },
    );

    it("allows only the mark's way out, the keep rollback to the version it names, which clears the mark", async () => {
      const w = await world();
      w.github.conclusion = "failure";
      await failure(w.run({ database: "snapshot" }));
      expect(w.volume().get(".restored")?.data?.toString()).toBe(BACK(w));
      w.github.conclusion = "success";
      const asked = w.handler.requests.length;

      const way = `${STAGING} --to ${w.c.digest} --database keep`;
      for (const options of [
        { database: "snapshot" },
        { database: "keep" },
        { to: w.c.digest, database: "snapshot" },
        { to: w.b.digest, database: "keep" },
      ] as const) {
        const refused = await failure(w.run(options));
        expect(refused.message).toContain(
          `staging's data in your Portainer is marked for ${shortImage(imageOf(w.c))} by a rollback that did not end`,
        );
        expect(refused.hint).toBe(`Run \`${way}\`.`);
      }
      expect(w.handler.requests).toHaveLength(asked);

      const result = await w.run({ to: w.c.digest, database: "keep" });
      expect(result).toMatchObject({ status: "deployed", database: { choice: "keep" } });
      expect(w.github.dispatches.at(-1)?.inputs.digest).toBe(w.c.digest);
      expect(w.events.slice(-2)).toEqual(["ran c", "unmark"]);
      expect(w.volume().has(".restored")).toBe(false);
      expect(await readRollback(w.deps.paths)).toMatchObject({ digest: w.c.digest });
    });

    it("puts the copy back and starts the app again when GitHub refuses the dispatch", async () => {
      const w = await world();
      w.github.dispatchError = new OpsCrewError(
        "PHASE_PRECONDITION",
        "GitHub cannot start the workflow opscrew-deploy-staging.yml on main: Not Found.",
      );
      const error = await failure(w.run({ database: "snapshot" }));
      expect(error.message).toBe(
        `staging's deploy workflow did not start: GitHub cannot start the workflow opscrew-deploy-staging.yml on main: Not Found. Nothing was deployed. OpsCrew put the data back as it was before the rollback (the snapshot ${SAVED}) and started the version that ran again. OpsCrew put staging's deploy pause back as it was.`,
      );
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.c), state: "running" });
      expect(w.volume().has(".restored")).toBe(false);
      expect(paused(w)).toBeUndefined();
    });

    it("follows a run it lost track of on the next rollback, and puts the copy back once it failed", async () => {
      let approves = true;
      const w = await world({ approve: () => approves });
      w.play.redeploy = "none";
      w.github.waitError = new Error("socket hang up");

      const lost = await failure(w.run({ database: "snapshot" }));

      expect(lost.message).toContain(
        `The snapshot of ${words(w)} stays restored in your Portainer, marked so that no other version starts on it, with the app stopped until the run starts ${words(w)}; the copy from just before is the snapshot ${SAVED}. staging's deploys stay paused.`,
      );
      expect(lost.hint).toBe(
        `Once the run ended, run \`${STAGING}\`: it records the rollback, or puts that copy back if the run failed.`,
      );
      expect(await readPendingRollback(w.deps.paths)).toMatchObject({
        runId: 777,
        saved: SAVED,
        unmark: true,
      });
      expect(w.volume().get(".restored")?.data?.toString()).toBe(MARK(w));

      w.github.waitError = undefined;
      w.github.conclusion = "failure";
      approves = false;
      expect((await failure(w.run({ database: "snapshot" }))).code).toBe("APPROVAL_REFUSED");
      expect(w.deps.reporter.text()).toContain(
        `OpsCrew put the data back as it was before the rollback (the snapshot ${SAVED}) and started the version that ran again.`,
      );
      expect(await readPendingRollback(w.deps.paths)).toBeUndefined();
      expect(w.volume().has(".restored")).toBe(false);
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.c), state: "running" });
    });

    it("refuses the snapshot with a required reviewer, naming keep and then opscrew restore, before any change", async () => {
      const reviewed = stagingPortainer();
      const plan = DeployPlanSchema.parse({
        ...reviewed,
        environment: { ...reviewed.environment, secrets: "environment" },
      });
      const w = await world({ plan });
      w.github.environments.set("staging", {
        name: "staging",
        reviewers: [{ type: "User", id: 1001 }],
        waitTimer: 0,
        preventSelfReview: false,
        branchPolicy: null,
        canAdminsBypass: true,
      });
      const error = await failure(w.run({ database: "snapshot" }));
      expect(error.message).toBe(
        `GitHub asks a required reviewer of the GitHub environment staging before staging's rollback run deploys, and in your Portainer OpsCrew restores the snapshot before that run starts, so the app would stay stopped until someone approved it. Roll back with --database keep, then, once the rollback is done, run \`opscrew restore ${w.hexB} --env staging\` to put the snapshot of ${words(w)} back. Nothing was changed.`,
      );
      expect(error.hint).toBe(`Run \`${STAGING}\` with --database keep.`);
      expect(w.handler.requests).toEqual([]);
      expect(w.events).toEqual([]);
      expect(w.github.dispatches).toEqual([]);
    });

    it("keeps the copy's id while the run waits, and puts it back once that run failed", async () => {
      let approves = true;
      const w = await world({ approve: () => approves });
      w.play.redeploy = "none";
      w.github.reviewer = "pending";
      await w.run({ database: "snapshot" });
      expect(await readPendingRollback(w.deps.paths)).toMatchObject({
        digest: w.b.digest,
        database: { choice: "snapshot", taken: TAKEN },
        saved: SAVED,
      });
      expect(w.volume().get(".restored")?.data?.toString()).toBe(MARK(w));
      expect(appContainer(w).state).toBe("exited");

      w.github.reviewer = "none";
      w.github.conclusion = "failure";
      // The next run puts the copy back; the new rollback it goes on with is not approved.
      approves = false;
      expect((await failure(w.run({ database: "snapshot" }))).code).toBe("APPROVAL_REFUSED");
      expect(w.deps.reporter.text()).toContain(
        `did not succeed (failure): ${DEPLOY_RUN_URL}. OpsCrew put the data back as it was before the rollback (the snapshot ${SAVED}) and started the version that ran again. OpsCrew put staging's deploy pause back as it was, and goes on with a new rollback.`,
      );
      expect(await readPendingRollback(w.deps.paths)).toBeUndefined();
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.c), state: "running" });
      expect(w.volume().has(".restored")).toBe(false);
      expect(paused(w)).toBeUndefined();
      await nothingLeaked(w);
    });

    it("keeps the pending record when the put-back fails before any change, and tries again next time", async () => {
      let approves = true;
      const w = await world({ approve: () => approves });
      w.play.redeploy = "none";
      w.github.reviewer = "pending";
      await w.run({ database: "snapshot" });
      w.github.reviewer = "none";
      w.github.conclusion = "failure";
      // The copy's record can't be read: nothing changes.
      failWith(w, `/snapshots/${SAVED}/about.json`, 1);

      const error = await failure(w.run({ database: "snapshot" }));

      expect(error.message).toMatch(
        new RegExp(
          `So OpsCrew did not put back the data from before the rollback yet \\(the snapshot ${SAVED}\\), and the app stays stopped\\. Nothing was changed\\.$`,
        ),
      );
      expect(error.message.match(/Nothing was changed\./g)).toHaveLength(1);
      expect(error.hint).toBe(
        `Once the cause is fixed, run \`${STAGING}\` again: it puts that data back.`,
      );
      expect(await readPendingRollback(w.deps.paths)).toMatchObject({ saved: SAVED });
      expect(w.volume().get(".restored")?.data?.toString()).toBe(MARK(w));

      // The next run puts the copy back; the new rollback it goes on with is not approved.
      approves = false;
      expect((await failure(w.run({ database: "keep" }))).code).toBe("APPROVAL_REFUSED");
      expect(await readPendingRollback(w.deps.paths)).toBeUndefined();
      expect(w.volume().has(".restored")).toBe(false);
      expect(appContainer(w)).toMatchObject({ image: imageOf(w.c), state: "running" });
    });

    it("removes the mark before recording, and keeps the pending record when that fails", async () => {
      const w = await world();
      failWith(w, "rm -f /snapshots/.restored", 1);

      const error = await failure(w.run({ database: "snapshot" }));

      expect(error.message).toContain("OpsCrew could not remove /snapshots/.restored");
      expect(error.hint).toContain(
        `run \`${STAGING}\` again: it removes the file and records the rollback.`,
      );
      expect(await readRollback(w.deps.paths)).toBeUndefined();
      expect(await readPendingRollback(w.deps.paths)).toMatchObject({ saved: SAVED, unmark: true });

      const result = await w.run();
      expect(result).toMatchObject({ status: "deployed", database: { choice: "snapshot" } });
      expect(w.volume().has(".restored")).toBe(false);
      expect(await readRollback(w.deps.paths)).toMatchObject({ digest: w.b.digest });
      expect(await readPendingRollback(w.deps.paths)).toBeUndefined();
    });

    it("unmarks the data once a run that waited succeeded", async () => {
      const w = await world();
      w.play.redeploy = "none";
      w.github.reviewer = "pending";
      await w.run({ database: "snapshot" });
      w.github.reviewer = "none";
      const result = await w.run();
      expect(result).toMatchObject({ status: "deployed", database: { choice: "snapshot" } });
      expect(w.volume().has(".restored")).toBe(false);
      expect(await readPendingRollback(w.deps.paths)).toBeUndefined();
    });
  },
);
