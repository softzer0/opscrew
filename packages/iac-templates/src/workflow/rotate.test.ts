// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withServices } from "../catalog/__fixtures__/plans";
import { splitPlan, withMonitoring, withProcesses, withSqlite } from "./__fixtures__/plans";
import { fakeBin, runSh, shWorks, write } from "./__fixtures__/sh";
import {
  ROTATE_APPROVAL_FILE,
  ROTATE_LOG,
  type RotateAction,
  type RotateStep,
  renderRotateScript,
  rotateApprovalLine,
  rotateEnvFiles,
  rotateInput,
} from "./rotate";
import { RESTORE_APPROVAL_FILE, restoreApprovalLine, snapshotScript } from "./snapshot-script";
import { rollbackCommands, switchCommands } from "./switch";

/**
 * `shop` with a worker and five services: PostgreSQL `db` (a swap), Valkey `cache` and `jobs` (two
 * passwords at once), Meilisearch `search` (a restart) and Redpanda `stream` (a swap whose service
 * restarts with its new env).
 */
const PLAN = withProcesses(
  withServices([
    { kind: "postgres", name: "db" },
    { kind: "valkey", name: "cache" },
    { kind: "valkey", name: "jobs", options: { mode: "queue" } },
    { kind: "meilisearch", name: "search" },
    { kind: "redpanda", name: "stream" },
  ]),
  { workers: [{ name: "worker", command: "node worker.js" }] },
);

/** A command the fake docker plays in the service's container: `change`, `add`, `drop`, `own`. */
const play = (action: string) => ["sh", "-c", action];

const STEPS: RotateStep[] = [
  {
    service: "db",
    envFile: "db.env",
    mode: "swap",
    begin: [play("change")],
    finish: [],
    recreate: false,
  },
  {
    service: "cache",
    envFile: "cache.env",
    mode: "dual",
    begin: [play("add")],
    finish: [play("drop")],
    recreate: false,
  },
  {
    service: "jobs",
    envFile: "jobs.env",
    mode: "dual",
    begin: [play("add")],
    finish: [play("drop")],
    recreate: false,
  },
  {
    service: "search",
    envFile: "search.env",
    mode: "restart",
    begin: [],
    finish: [],
    recreate: true,
  },
  {
    service: "stream",
    envFile: "stream.env",
    mode: "swap",
    begin: [play("change")],
    finish: [],
    recreate: true,
  },
];
const SERVICES = STEPS.map((step) => step.service);

/** The split plan's services on its server `data`: PostgreSQL `db` (a swap), MongoDB `docs` (dual). */
const SPLIT = splitPlan();
const EXTRA: RotateStep[] = [
  STEPS[0] as RotateStep,
  {
    service: "docs",
    envFile: "docs.env",
    mode: "dual",
    begin: [play("add")],
    finish: [play("drop")],
    recreate: false,
  },
];

/** The hash of the approved rotation plan, and of another one. */
const HASH = sha256Hex("the rotation plan of the tests");
const OTHER = sha256Hex("another rotation plan");

/** The running version's image. */
const IMAGE = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;

/**
 * The fake `docker`: logs every call (its arguments only) to $WORK/docker.log.
 * - `exec -e OPSCREW_OLD -e OPSCREW_NEW c-<service> sh -c <action>` plays the service's values in
 *   $WORK/values/<service> (one valid value per line), logging `<service> <action>` to
 *   $WORK/exec.log and printing both values on both streams, as a tool's output can: `change` logs
 *   in with OPSCREW_OLD and makes OPSCREW_NEW the only value, `add` logs in with OPSCREW_OLD and adds
 *   OPSCREW_NEW, `drop` logs in with OPSCREW_NEW and removes OPSCREW_OLD, `own` only logs. A login
 *   with a value the service doesn't have fails, and so does the action EXEC_FAIL names (any other
 *   action succeeds); the one HOLD_DURING names leaves a restore's hold, as if one began meanwhile.
 * - `compose ps -q <service>` prints `c-<service>` while $WORK/running/<service> exists; `ps -aq app`
 *   the app's containers ($WORK/apps/list); `ps -aq <worker>` `p-<worker>` for those in PROCESSES.
 * - `compose up` of services or workers creates again each whose env file (the app's for those in
 *   PROCESSES) differs from the one it was created with ($WORK/created/<service>), or every one with
 *   `--force-recreate`, logging it to $WORK/recreated.log; it fails for the service UP_FAIL names.
 *   `--scale app=<n>` starts app containers `a<k>` up to n, each keeping the `app.env` it started
 *   with ($WORK/apps/a<k>.env); `up … app` alone replaces them with one.
 * - kamal-proxy's `deploy` in the edge's project routes the app to its `--target`
 *   ($WORK/route), or fails with HEALTH_FAIL; `pause` and `resume` are logged to $WORK/kamal.log.
 * - `stop` and `rm` remove an app container; `inspect --format` names it `/shop-app-<k>`, and gives
 *   a worker's status `running` and its restart count ($WORK/restarts/p-<worker>, 0 by default).
 */
const FAKE_DOCKER = [
  // Bash's own commands only: a new process costs a lot under Git Bash.
  "#!/bin/bash",
  'echo "docker $*" >> "$WORK/docker.log"',
  'project="${PWD##*/}"',
  'if [[ "$1" == compose ]]; then',
  "  shift",
  '  while [[ "$1" == -p || "$1" == -f ]]; do',
  '    if [[ "$1" == -p ]]; then project="$2"; fi',
  "    shift 2",
  "  done",
  '  set -- compose "$@"',
  "fi",
  'last="${*: -1}"',
  'apps="$WORK/apps"',
  // A file's whole text in $text.
  'slurp() { text=""; IFS= read -r -d "" text < "$1" || true; }',
  "start_app() {",
  '  local n; read -r n < "$WORK/next"',
  '  echo $(( n + 1 )) > "$WORK/next"',
  '  echo "a$n" >> "$apps/list"',
  '  slurp app.env; printf "%s" "$text" > "$apps/a$n.env"',
  "}",
  'case "$1 $2" in',
  '  "exec -e")',
  '    svc="${6#c-}"; action="$last"',
  '    echo "$svc $action" >> "$WORK/exec.log"',
  '    echo "$action $svc: ${OPSCREW_OLD:-} to ${OPSCREW_NEW:-}"',
  '    echo "$action $svc: ${OPSCREW_OLD:-} to ${OPSCREW_NEW:-}" >&2',
  '    [[ "${EXEC_FAIL:-}" != "$svc $action" ]] || exit 1',
  '    [[ "${HOLD_DURING:-}" != "$svc $action" ]] || : > .snapshots/.held',
  '    v="$WORK/values/$svc"',
  '    mapfile -t have < "$v"',
  '    has() { local x; for x in "${have[@]}"; do [[ "$x" == "$1" ]] && return 0; done; return 1; }',
  '    case "$action" in',
  '      change) has "$OPSCREW_OLD" || exit 2; printf "%s\\n" "$OPSCREW_NEW" > "$v" ;;',
  '      add) has "$OPSCREW_OLD" || exit 2; has "$OPSCREW_NEW" || printf "%s\\n" "$OPSCREW_NEW" >> "$v" ;;',
  "      drop)",
  '        has "$OPSCREW_NEW" || exit 2',
  '        : > "$v"; for x in "${have[@]}"; do [[ "$x" == "$OPSCREW_OLD" ]] || printf "%s\\n" "$x" >> "$v"; done ;;',
  "    esac ;;",
  '  "compose ps")',
  '    if [[ "$last" == app ]]; then',
  '      mapfile -t ids < "$apps/list"; for id in "${ids[@]}"; do echo "$id"; done',
  '    elif [[ " ${PROCESSES:-} " == *" $last "* ]]; then echo "p-$last"',
  '    elif [[ -f "$WORK/running/$last" ]]; then echo "c-$last"; fi ;;',
  '  "compose up")',
  '    [[ "$project" != opscrew-edge ]] || exit 0',
  '    scale=" --scale app=([0-9]+) "',
  '    if [[ " $* " =~ $scale ]]; then',
  '      mapfile -t ids < "$apps/list"',
  "      for (( k = ${#ids[@]}; k < BASH_REMATCH[1]; k++ )); do start_app; done",
  '    elif [[ "$last" == app ]]; then',
  '      : > "$apps/list"; start_app',
  "    else",
  '      for arg in "${@:3}"; do',
  '        [[ "$arg" != -* ]] || continue',
  '        if [[ "${UP_FAIL:-}" == "$arg" ]]; then echo "container $arg is unhealthy" >&2; exit 1; fi',
  '        env="$arg.env"; [[ " ${PROCESSES:-} " != *" $arg "* ]] || env=app.env',
  '        slurp "$env"; now="$text"; slurp "$WORK/created/$arg"',
  '        if [[ " $* " == *" --force-recreate "* || "$now" != "$text" ]]; then',
  '          printf "%s" "$now" > "$WORK/created/$arg"; echo "$arg" >> "$WORK/recreated.log"',
  "        fi",
  "      done",
  "    fi ;;",
  '  "compose exec")',
  '    [[ "$project" == opscrew-edge ]] || exit 1',
  '    if [[ "$6" == deploy ]]; then',
  '      if [[ -n "${HEALTH_FAIL:-}" ]]; then echo "Error: target failed to become healthy within configured timeout (60s)" >&2; exit 1; fi',
  '      target=""; prev=""; for arg in "$@"; do [[ "$prev" == --target ]] && target="$arg"; prev="$arg"; done',
  '      echo "${target%%:*}" > "$WORK/route"',
  '    else echo "$6" >> "$WORK/kamal.log"; fi ;;',
  '  "inspect --format")',
  '    restarts=0; [[ ! -f "$WORK/restarts/$last" ]] || read -r restarts < "$WORK/restarts/$last"',
  '    case "$3" in',
  '      "{{.Name}}") echo "/$project-app-${last#a}" ;;',
  '      "{{.RestartCount}}") echo "$restarts" ;;',
  '      *) echo "running:$restarts" ;;',
  "    esac ;;",
  '  "stop "* | "rm "*)',
  '    mapfile -t ids < "$apps/list"; : > "$apps/list"',
  '    for id in "${ids[@]}"; do [[ "$id" == "$last" ]] || echo "$id" >> "$apps/list"; done ;;',
  "esac",
].join("\n");

/** The fake `flock`: logged; with FLOCK_BUSY, `-n` finds the lock held, as while a deploy runs. */
const FAKE_FLOCK = [
  "#!/bin/sh",
  'echo "flock $*" >> "$WORK/docker.log"',
  'if [ "$1" = -n ] && [ -n "${FLOCK_BUSY:-}" ]; then exit 1; fi',
].join("\n");

/** The fake `sleep`: logged, returns at once; meanwhile the worker CRASH names restarts once. */
const FAKE_SLEEP = [
  "#!/bin/bash",
  'echo "sleep $*" >> "$WORK/docker.log"',
  'if [[ -n "${CRASH:-}" ]]; then mkdir -p "$WORK/restarts"; echo 1 > "$WORK/restarts/p-$CRASH"; fi',
].join("\n");

/** This system's `cp`, which the fake one runs for every copy but one to a `.previous` file. */
const REAL_CP = spawnSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).stdout?.trim();
const FAKE_CP = [
  "#!/bin/sh",
  'case "$*" in *.previous) echo "cp: No space left on device" >&2; exit 1 ;; esac',
  `exec ${REAL_CP} "$@"`,
].join("\n");

let work = "";
const appDir = () => `${work}/srv/apps/shop`;
const at = (name: string) => `${appDir()}/${name}`;
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
const lines = (path: string) => (read(path) ?? "").split("\n").filter(Boolean);
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const windows = process.platform === "win32";

/**
 * The services with values: those of {@link STEPS} on the app's server, and MongoDB `docs`, which
 * the split plan keeps on the server `data` beside `db` ({@link EXTRA}).
 */
const NAMES = [...SERVICES, "docs"];

/** Each service's old and new value, made for each test. */
let values: { old: string; new: string }[] = [];
const value = (service: string) => values[NAMES.indexOf(service)] ?? { old: "", new: "" };

/** The env files with the old or the new values: the app's, and `<service>.env` of each. */
function envFiles(which: "old" | "new"): Record<string, string> {
  const pick = (service: string) => value(service)[which];
  return {
    "app.env": `${NAMES.map((service) => `${service.toUpperCase()}_SECRET=${pick(service)}`).join("\n")}\nPORT=3000\n`,
    ...Object.fromEntries(NAMES.map((service) => [`${service}.env`, `SECRET=${pick(service)}\n`])),
  };
}

/**
 * A server before the rotation: `.env` naming the image that runs, every env file with the old
 * values, every service running with them, the web as `a0` (kamal-proxy's route) and the worker
 * created from the old `app.env`.
 */
function server(): void {
  write(at(".env"), `APP_IMAGE=${IMAGE}\n`);
  const old = envFiles("old");
  for (const [file, content] of Object.entries(old)) write(at(file), content);
  for (const service of NAMES) {
    write(`${work}/running/${service}`, "");
    write(`${work}/values/${service}`, `${value(service).old}\n`);
    write(`${work}/created/${service}`, old[`${service}.env`] ?? "");
  }
  write(`${work}/created/worker`, old["app.env"] ?? "");
  write(`${work}/apps/list`, "a0\n");
  write(`${work}/apps/a0.env`, old["app.env"] ?? "");
  write(`${work}/route`, "shop-app-0\n");
  write(`${work}/next`, "1\n");
}

/** The one-time approval of `action` for `hash`, valid for `seconds` more. */
function approve(action: RotateAction = "rotate", hash = HASH, seconds = 1800): void {
  const line = rotateApprovalLine(hash, action, Math.floor(Date.now() / 1000) + seconds);
  write(at(ROTATE_APPROVAL_FILE), `${line}\n`);
}

/** Every output of the runs of a test, which must never hold a value. */
let outputs: string[] = [];

/**
 * `sh rotate.sh <args>` as opscrew rotate runs it, the fakes first on PATH, with `input` (the new
 * env files and the values by default) on stdin.
 */
function run(
  args: readonly string[] = [HASH],
  env: Record<string, string> = {},
  o: {
    steps?: readonly RotateStep[];
    plan?: DeployPlan;
    server?: string;
    input?: string;
  } = {},
) {
  const steps = o.steps ?? STEPS;
  const script = `${work}/rotate.sh`;
  write(script, `${renderRotateScript(o.plan ?? PLAN, steps, o.server).join("\n")}\n`);
  const input =
    o.input ??
    rotateInput(
      steps,
      { envFiles: envFiles("new"), values: steps.map((s) => value(s.service)) },
      o.server,
    );
  const result = spawnSync(
    "sh",
    [
      "-c",
      'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh "$0" "$@"',
      script,
      ...args,
    ],
    {
      input,
      env: {
        ...process.env,
        WORK: work,
        OPSCREW_APPS_DIR: `${work}/srv/apps`,
        OPSCREW_EDGE_DIR: `${work}/srv/edge`,
        PROCESSES: "worker",
        ...env,
      },
      encoding: "utf8",
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  outputs.push(output);
  return { status: result.status, output, stdout: result.stdout, stderr: result.stderr };
}

/** The valid values of each service now. */
const valid = (service: string) => lines(`${work}/values/${service}`);
/** How often each service's action ran, failed tries included (`<service> <action>`). */
const ran = (call: string) => lines(`${work}/exec.log`).filter((line) => line === call).length;
const recreatedList = () => lines(`${work}/recreated.log`);
/** The `app.env` of the app's copy kamal-proxy routes to. */
const routedEnv = () => {
  const name = (read(`${work}/route`) ?? "").trim();
  return read(`${work}/apps/a${name.replace(/^shop-app-/, "")}.env`);
};
const held = () => existsSync(at(".snapshots/.held"));

/** The server holds the new values everywhere and the old ones nowhere: the rotation is done. */
function expectRotated(): void {
  const fresh = envFiles("new");
  for (const file of rotateEnvFiles(STEPS)) expect(read(at(file)), file).toBe(fresh[file]);
  expect(valid("db")).toEqual([value("db").new]);
  expect(valid("cache")).toEqual([value("cache").new]);
  expect(valid("jobs")).toEqual([value("jobs").new]);
  expect(valid("stream")).toEqual([value("stream").new]);
  expect(read(`${work}/created/search`)).toBe(fresh["search.env"]);
  expect(read(`${work}/created/stream`)).toBe(fresh["stream.env"]);
  expect(read(`${work}/created/worker`)).toBe(fresh["app.env"]);
  expect(routedEnv()).toBe(fresh["app.env"]);
  expect(lines(`${work}/apps/list`)).toHaveLength(1);
  expect(held()).toBe(false);
  for (const file of rotateEnvFiles(STEPS)) {
    expect(existsSync(at(`.rotate/${file}.previous`)), file).toBe(false);
  }
  expect(existsSync(at(".rotate/state"))).toBe(false);
}

/** The server holds the old values everywhere and the new ones nowhere: as before the rotation. */
function expectUndone(): void {
  const old = envFiles("old");
  for (const [file, content] of Object.entries(old)) expect(read(at(file)), file).toBe(content);
  for (const service of ["db", "cache", "jobs", "stream"]) {
    expect(valid(service), service).toEqual([value(service).old]);
  }
  expect(held()).toBe(false);
  expect(existsSync(at(".rotate/state"))).toBe(false);
  for (const file of rotateEnvFiles(STEPS)) {
    expect(existsSync(at(`.rotate/${file}.previous`)), file).toBe(false);
  }
}

/** Nothing on the server changed (the refusals). */
function expectUnchanged(): void {
  const old = envFiles("old");
  for (const [file, content] of Object.entries(old)) expect(read(at(file)), file).toBe(content);
  for (const step of STEPS) expect(valid(step.service)).toEqual([value(step.service).old]);
  expect(read(`${work}/exec.log`)).toBeUndefined();
  expect(read(`${work}/recreated.log`)).toBeUndefined();
  expect(held()).toBe(false);
  expect(existsSync(at(".rotate/state"))).toBe(false);
}

describe("rotateInput and rotateEnvFiles", () => {
  it("lists the app's env file first, then each step's once", () => {
    const [db, cache] = STEPS as [RotateStep, RotateStep];
    expect(rotateEnvFiles([cache, cache, db])).toEqual(["app.env", "cache.env", "db.env"]);
  });

  it("puts each env file in base64 on a line, then each step's two values", () => {
    const steps = [STEPS[0] as RotateStep];
    const input = rotateInput(steps, {
      envFiles: { "app.env": "A=1\n", "db.env": "B=two words\n" },
      values: [{ old: "first", new: "second" }],
    });
    const decoded = input.split("\n");
    expect(Buffer.from(decoded[0] ?? "", "base64").toString()).toBe("A=1\n");
    expect(Buffer.from(decoded[1] ?? "", "base64").toString()).toBe("B=two words\n");
    expect(decoded.slice(2)).toEqual(["first", "second", ""]);
  });

  it("refuses an input without an env file, a value per step, or with a line break in a value", () => {
    const steps = [STEPS[0] as RotateStep];
    const pair = { old: "first", new: "second" };
    expect(() => rotateInput(steps, { envFiles: { "app.env": "" }, values: [pair] })).toThrow(
      "no new db.env",
    );
    expect(() =>
      rotateInput(steps, { envFiles: { "app.env": "", "db.env": "" }, values: [] }),
    ).toThrow("each step");
    expect(() =>
      rotateInput(steps, {
        envFiles: { "app.env": "", "db.env": "" },
        values: [{ old: "a\nb", new: "c" }],
      }),
    ).toThrow("line break");
  });
});

describe("renderRotateScript", () => {
  const script = renderRotateScript(PLAN, STEPS).join("\n");

  it("gives a service's command the values only in docker's environment", () => {
    expect(script).toContain(
      `OPSCREW_OLD="$rot_old_1" OPSCREW_NEW="$rot_new_1" docker exec -e OPSCREW_OLD -e OPSCREW_NEW "$rot_c" 'sh' '-c' 'change' < /dev/null >> ${ROTATE_LOG} 2>&1`,
    );
  });

  it("moves only the app and the services whose step recreates them, and pulls nothing", () => {
    expect(script).not.toContain("pull");
    expect(script).not.toMatch(/compose (exec|run)/);
    const ups = script.split("\n").filter((line) => line.includes("docker compose up"));
    for (const line of ups) expect(line).not.toMatch(/ (db|cache|jobs)( |$)/);
    expect(ups.some((line) => line.includes("--scale"))).toBe(true);
    expect(
      ups.some((line) => line.trim().startsWith("docker compose up -d --no-deps worker")),
    ).toBe(true);
  });
});

describe.skipIf(!shWorks())("rotate.sh", { timeout: 180_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-rotate-")).replaceAll("\\", "/");
    fakeBin(work, { docker: FAKE_DOCKER, flock: FAKE_FLOCK, sleep: FAKE_SLEEP });
    values = NAMES.map(() => ({
      old: randomBytes(16).toString("hex"),
      new: randomBytes(16).toString("hex"),
    }));
    outputs = [];
    server();
  });
  afterEach(() => {
    // Nothing a run printed, and no command line docker got, holds an old or a new value.
    const calls = read(`${work}/docker.log`) ?? "";
    for (const pair of values) {
      for (const secret of [pair.old, pair.new]) {
        for (const output of outputs) expect(output).not.toContain(secret);
        expect(calls).not.toContain(secret);
      }
    }
    rmSync(work, { recursive: true, force: true });
  });

  it("rotates every step in order, the app switching with the image that runs, and holds the deploys meanwhile", () => {
    approve();
    const result = run();
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toContain("OpsCrew rotated the credentials on the app's server");
    expectRotated();
    // Each step's change ran once, in order; only Redpanda and Meilisearch were created again
    // (Meilisearch first, in step 3), then the worker with the app.
    for (const call of ["db change", "cache add", "jobs add", "stream change", "cache drop"]) {
      expect(ran(call), call).toBe(1);
    }
    expect(lines(`${work}/exec.log`)).toEqual([
      "db change",
      "cache add",
      "jobs add",
      "stream change",
      "cache drop",
      "jobs drop",
    ]);
    expect(recreatedList()).toEqual(["search", "stream", "worker"]);
    const calls = lines(`${work}/docker.log`);
    const callAt = (text: string) => calls.findIndex((call) => call.includes(text));
    expect(calls[0]).toBe("flock -n 7");
    expect(callAt("--scale app=2 app")).toBeGreaterThan(callAt("--wait stream"));
    expect(callAt("kamal-proxy deploy shop --target shop-app-1:3000")).toBeGreaterThan(
      callAt("--scale app=2 app"),
    );
    expect(callAt("c-cache sh -c drop")).toBeGreaterThan(callAt("kamal-proxy deploy shop"));
    expect(calls.some((call) => call.includes("pull"))).toBe(false);
    // The image is the one .env names, written back unchanged.
    expect(read(at(".env"))).toBe(`APP_IMAGE=${IMAGE}\n`);
    // The approval is used, and the commands' output stays on the server only.
    expect(existsSync(at(ROTATE_APPROVAL_FILE))).toBe(false);
    expect(read(at(ROTATE_LOG))).toContain(value("db").new);
    if (!windows) {
      for (const file of [...rotateEnvFiles(STEPS), ROTATE_LOG]) expect(mode(at(file))).toBe("600");
    }
    // The approval was used: a run needs a new one.
    const again = run();
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("A rotation needs its one-time approval");
    expect(ran("db change")).toBe(1);
  });

  describe("refuses before any change", () => {
    it.each([
      {
        case: "without its approval",
        prepare: () => undefined,
        message: "A rotation needs its one-time approval on the app's server (.rotate/approval",
      },
      {
        case: "with an approval of another rotation",
        prepare: () => approve("rotate", OTHER),
        message: "is for another rotation, so OpsCrew removed it and changed nothing",
      },
      {
        case: "with an approval of an undo",
        prepare: () => approve("undo"),
        message: "is for another rotation, so OpsCrew removed it and changed nothing",
      },
      {
        case: "with an expired approval",
        prepare: () => approve("rotate", HASH, -5),
        message: "expired before it started, so nothing was changed",
      },
    ])("$case", ({ prepare, message }) => {
      prepare();
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("Run opscrew rotate again.");
      expect(existsSync(at(ROTATE_APPROVAL_FILE))).toBe(false);
      expectUnchanged();
    });

    it("at once while a deploy holds the app's start lock, saying what runs", () => {
      approve();
      const result = run([HASH], { FLOCK_BUSY: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "A deploy, a rollback or a restore of the app is running on the app's server, which holds the app's start lock, so the rotation changed nothing. Run opscrew rotate again once it has finished.",
      );
      expectUnchanged();
    });

    it("while a snapshot is being taken", () => {
      approve();
      write(at(".snapshots/20261108T060000Z.taking/db.dump"), "");
      const result = run([HASH], { FLOCK_BUSY: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "OpsCrew is taking a snapshot of the app's data on the app's server, which holds the app's start lock",
      );
    });

    it("while a restore holds the app", () => {
      approve();
      write(at(".snapshots/.held"), "");
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The rotation changed nothing: a restore holds the app (.snapshots/.held in its folder)",
      );
      expect(read(`${work}/exec.log`)).toBeUndefined();
    });

    it("while the app has no image recorded, or misses an env file", () => {
      approve();
      write(at(".env"), "");
      expect(run().stderr).toContain("The app's .env on the app's server names no image");
      write(at(".env"), `APP_IMAGE=${IMAGE}\n`);
      rmSync(at("jobs.env"));
      approve();
      expect(run().stderr).toContain("The app's server has no jobs.env in the app's folder");
      expect(read(`${work}/exec.log`)).toBeUndefined();
      expect(held()).toBe(false);
    });

    it("with an incomplete or unreadable input", () => {
      approve();
      const input = rotateInput(STEPS, {
        envFiles: envFiles("new"),
        values: STEPS.map((s) => value(s.service)),
      });
      const short = run([HASH], {}, { input: input.split("\n").slice(0, 7).join("\n") });
      expect(short.status).toBe(1);
      expect(short.stderr).toContain(
        "The rotation's input (the new env files and values on stdin) is incomplete or unreadable, so nothing was changed.",
      );
      approve();
      expect(run([HASH], {}, { input: `!!!\n${input}` }).status).toBe(1);
      expectUnchanged();
    });

    it("without a hash", () => {
      approve();
      const result = run([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: sh rotate.sh <hash> | --undo <hash>");
      expect(existsSync(at(ROTATE_APPROVAL_FILE))).toBe(true);
    });

    it("while another rotation is unfinished", () => {
      approve();
      expect(run([HASH], { EXEC_FAIL: "jobs add" }).status).toBe(1);
      approve("rotate", OTHER);
      const other = run([OTHER]);
      expect(other.status).toBe(1);
      expect(other.stderr).toContain(
        "An earlier rotation stopped on the app's server before it finished, so this one changed nothing.",
      );
      approve("undo", OTHER);
      expect(run(["--undo", OTHER]).stderr).toContain("is another one than this");
      expect(ran("db change")).toBe(1);
    });
  });

  describe("stops at a failure, says the step, and goes on after it when run again", () => {
    interface Failure {
      at: string;
      step: string;
      env: Record<string, string>;
      /** Before the run that fails, and after it. */
      prepare?: () => void;
      repair?: () => void;
      /** Whether the message offers the undo. */
      undo: boolean;
      /** Whether the env files' `.previous` copies are made by then. */
      kept: boolean;
    }
    const failures: Failure[] = [
      {
        at: "the hold",
        step: "step 1 of 6 (holding the app's deploys), and nothing was changed",
        env: {},
        prepare: () => write(at(".snapshots"), "a file where the folder goes"),
        repair: () => rmSync(at(".snapshots")),
        undo: false,
        kept: false,
      },
      {
        at: "the copies of the env files",
        step: "step 2 of 6 (keeping the current env files)",
        env: {},
        prepare: () => fakeBin(work, { cp: FAKE_CP }),
        repair: () => rmSync(`${work}/bin/cp`),
        undo: true,
        kept: false,
      },
      {
        at: "a service's change",
        step: "step 3 of 6 (changing cache to its new value)",
        env: { EXEC_FAIL: "cache add" },
        undo: true,
        kept: true,
      },
      {
        at: "a restart with the new value",
        step: "step 3 of 6 (restarting search with its new value)",
        env: { UP_FAIL: "search" },
        undo: true,
        kept: true,
      },
      {
        at: "the env files and the restarts",
        step: "step 4 of 6 (writing the new env files and restarting search, stream with them)",
        env: { UP_FAIL: "stream" },
        undo: true,
        kept: true,
      },
      {
        at: "the app's switch",
        step: "step 5 of 6 (switching the app to the new values)",
        env: { HEALTH_FAIL: "1" },
        undo: true,
        kept: true,
      },
      {
        at: "the first drop of an old value",
        step: "step 6 of 6 (dropping the old value of cache)",
        env: { EXEC_FAIL: "cache drop" },
        undo: false,
        kept: true,
      },
    ];
    it.each(failures)("at $at", ({ step, env, prepare, repair, undo, kept }) => {
      prepare?.();
      approve();
      const failed = run([HASH], env);
      expect(failed.status, failed.output).not.toBe(0);
      expect(failed.stderr).toContain(`The rotation stopped at ${step}`);
      if (kept) {
        expect(read(at(".rotate/app.env.previous"))).toBe(envFiles("old")["app.env"]);
      }
      if (undo) {
        expect(failed.stderr).toContain("so deploys stay held.");
        expect(failed.stderr).toContain(
          "/.rotate/rotate.log (it can quote a value, so it is not printed here). Fix the cause, then run opscrew rotate again to go on from this step, or opscrew rotate --undo to put the old values back.",
        );
        expect(held()).toBe(true);
      } else if (step.startsWith("step 6")) {
        // Step 6 began: only going on is offered.
        expect(failed.stderr).toContain("so it can no longer be undone.");
        expect(failed.stderr).not.toContain("--undo");
      }
      repair?.();
      approve();
      const resumed = run();
      expect(resumed.status, resumed.output).toBe(0);
      expectRotated();
      // No step that finished ran again; the one that failed ran once more.
      const tries = (call: string) => (env.EXEC_FAIL === call ? 2 : 1);
      for (const call of ["db change", "cache add", "jobs add", "stream change", "cache drop"]) {
        expect(ran(call), call).toBe(tries(call));
      }
    });
  });

  describe("--undo", () => {
    it("puts the old values back after a failed switch: env files, services, the app and its worker", () => {
      approve();
      expect(run([HASH], { HEALTH_FAIL: "1" }).status).toBe(1);
      // The new copy got no traffic: the app keeps serving with the old values.
      expect(routedEnv()).toBe(envFiles("old")["app.env"]);
      approve("undo");
      const undone = run(["--undo", HASH]);
      expect(undone.status, undone.output).toBe(0);
      expect(undone.stdout).toContain("OpsCrew put the old values back on the app's server");
      expectUndone();
      const old = envFiles("old");
      expect(read(`${work}/created/search`)).toBe(old["search.env"]);
      expect(read(`${work}/created/stream`)).toBe(old["stream.env"]);
      expect(read(`${work}/created/worker`)).toBe(old["app.env"]);
      expect(routedEnv()).toBe(old["app.env"]);
      // The steps in reverse, each change with the values swapped, the new values dropped after
      // the app's switch back.
      expect(lines(`${work}/exec.log`).slice(4)).toEqual([
        "stream change",
        "jobs add",
        "cache add",
        "db change",
        "jobs drop",
        "cache drop",
      ]);
      // A rotation after the undo starts afresh.
      approve();
      expect(run().status).toBe(0);
      expectRotated();
    });

    it("undoes only what began: a failed change and the steps after it stay as they were", () => {
      approve();
      expect(run([HASH], { EXEC_FAIL: "jobs add" }).status).toBe(1);
      approve("undo");
      expect(run(["--undo", HASH]).status).toBe(0);
      expectUndone();
      expect(lines(`${work}/exec.log`)).toEqual([
        "db change",
        "cache add",
        "jobs add",
        "cache add",
        "db change",
        "cache drop",
      ]);
      // Nothing was created again, and the app never switched.
      expect(recreatedList()).toEqual([]);
      expect(lines(`${work}/apps/list`)).toEqual(["a0"]);
    });

    it("goes on after the last unit it finished, and the rotation waits for it", () => {
      approve();
      expect(run([HASH], { HEALTH_FAIL: "1" }).status).toBe(1);
      approve("undo");
      const failed = run(["--undo", HASH], { EXEC_FAIL: "db change" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "Undoing the rotation stopped while changing db back to its old value, so deploys stay held.",
      );
      expect(failed.stderr).toContain("then run opscrew rotate --undo again to finish the undo.");
      approve();
      expect(run().stderr).toContain("Undoing this rotation stopped before it finished");
      approve("undo");
      expect(run(["--undo", HASH]).status).toBe(0);
      expectUndone();
      expect(ran("stream change")).toBe(2);
      expect(ran("cache add")).toBe(2);
    });

    it("is refused once step 6 began, even when its first drop failed, and after the rotation finished", () => {
      approve();
      const failed = run([HASH], { EXEC_FAIL: "cache drop" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "The rotation stopped at step 6 of 6 (dropping the old value of cache), so deploys stay held.",
      );
      expect(failed.stderr).toContain(
        "then run opscrew rotate again to finish it: it has begun to drop the old values, so it can no longer be undone.",
      );
      approve("undo");
      const late = run(["--undo", HASH]);
      expect(late.status).toBe(1);
      expect(late.stderr).toContain(
        "This rotation has begun to drop the old values (step 6), so it can't be undone, and nothing was changed. Run opscrew rotate again to finish it.",
      );
      approve();
      expect(run().status).toBe(0);
      approve("undo");
      const finished = run(["--undo", HASH]);
      expect(finished.status).toBe(1);
      expect(finished.stderr).toContain(
        "This rotation finished, and its old values no longer work",
      );
      expectRotated();
      // Run again, the finished rotation changes nothing.
      approve();
      const again = run();
      expect(again.status).toBe(0);
      expect(again.stderr).toContain(
        "This rotation finished on the app's server already, so nothing was changed.",
      );
      expect(ran("db change")).toBe(1);
    });

    it("removes the hold a finished rotation left, and only its own", () => {
      approve();
      expect(run().status).toBe(0);
      // Its release stopped after the record and before the hold went.
      write(at(".snapshots/.held"), `rotation ${HASH}\n`);
      approve();
      const left = run();
      expect(left.status, left.output).toBe(0);
      expect(left.stderr).toContain(
        "This rotation finished on the app's server already; OpsCrew removed the hold of the app's deploys it had left there.",
      );
      expect(held()).toBe(false);
      expect(ran("db change")).toBe(1);
      // Another rotation's hold stays.
      write(at(".snapshots/.held"), `rotation ${OTHER}\n`);
      approve();
      expect(run().status).toBe(0);
      expect(read(at(".snapshots/.held"))).toBe(`rotation ${OTHER}\n`);
    });

    it("has nothing to undo where no rotation of the plan began", () => {
      approve("undo");
      const result = run(["--undo", HASH]);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("there is nothing to undo");
      expectUnchanged();
    });

    it("runs a step's own undo instead of its begin and finish swapped, after the app's switch back", () => {
      const steps: RotateStep[] = [
        STEPS[0] as RotateStep,
        {
          service: "stream",
          envFile: "stream.env",
          mode: "dual",
          begin: [play("own")],
          finish: [play("own")],
          recreate: true,
          undo: [play("own"), play("own")],
        },
      ];
      approve();
      expect(run([HASH], { HEALTH_FAIL: "1" }, { steps }).status).toBe(1);
      approve("undo");
      expect(run(["--undo", HASH], {}, { steps }).status).toBe(0);
      expect(lines(`${work}/exec.log`)).toEqual([
        "db change",
        "stream own",
        "db change",
        "stream own",
        "stream own",
      ]);
      expect(valid("db")).toEqual([value("db").old]);
      // The own undo comes after the switch back, the last kamal-proxy deploy.
      const calls = lines(`${work}/docker.log`);
      const back = calls.findLastIndex((call) => call.includes("kamal-proxy deploy shop"));
      const owns = calls.flatMap((call, i) => (call.includes("c-stream sh -c own") ? [i] : []));
      expect(owns).toHaveLength(3);
      expect(back).toBeGreaterThan(owns[0] ?? -1);
      expect(owns[1] ?? -1).toBeGreaterThan(back);
    });
  });

  it("holds the app's requests around a recreate switch, and resumes them when it fails", () => {
    const plan = withSqlite(PLAN);
    approve();
    const failed = run([HASH], { HEALTH_FAIL: "1" }, { plan });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      "The app's new copy did not pass its health check with the new values (kamal-proxy's reason is above), so OpsCrew removed it, and the app is not serving now.",
    );
    expect(failed.stderr).toContain(
      "The rotation stopped at step 5 of 6 (switching the app to the new values)",
    );
    expect(lines(`${work}/kamal.log`)).toEqual(["pause", "resume"]);
    approve();
    expect(run([HASH], {}, { plan }).status).toBe(0);
    expect(routedEnv()).toBe(envFiles("new")["app.env"]);
  });

  it("checks that the workers keep running with the new values, as the deploy does", () => {
    approve();
    const failed = run([HASH], { CRASH: "worker" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      "The worker container did not keep running after it started with the new values.",
    );
    expect(failed.stderr).toContain(
      "The rotation stopped at step 5 of 6 (switching the app to the new values)",
    );
    expect(lines(`${work}/docker.log`)).toContain("sleep 30");
    rmSync(`${work}/restarts`, { recursive: true });
    approve();
    expect(run().status).toBe(0);
    expectRotated();
  });

  describe("holds the app under its own name", () => {
    /** The start or rollback script of `plan` on this server, `IMAGE` its `$1`. */
    const script = (lines: readonly string[]) =>
      runSh(lines, [IMAGE], {
        WORK: work,
        OPSCREW_APPS_DIR: `${work}/srv/apps`,
        OPSCREW_EDGE_DIR: `${work}/srv/edge`,
      });
    const message = `a credential rotation holds the app (the rotation of the plan ${HASH}), so its services may have new values the app does not use yet: finish the rotation with opscrew rotate, or put the old values back with opscrew rotate --undo, then try again.`;

    it("which the deploy's start script and the rollback script read, with or without data", () => {
      approve();
      expect(run([HASH], { EXEC_FAIL: "cache add" }).status).toBe(1);
      expect(read(at(".snapshots/.held"))).toBe(`rotation ${HASH}\n`);
      for (const plan of [PLAN, withProcesses(withServices([]), {})]) {
        const start = script(switchCommands(plan, []));
        expect(start.status).toBe(1);
        expect(start.output).toContain(
          `::error::OpsCrew changed nothing on the server: ${message}`,
        );
        const rollback = script(rollbackCommands(plan));
        expect(rollback.status).toBe(0);
        expect(rollback.stdout).toBe(`held rotation ${HASH}`);
      }
      // A restore's hold is an empty file, read as before.
      write(at(".snapshots/.held"), "");
      expect(script(switchCommands(PLAN, [])).output).toContain(
        "::error::OpsCrew changed nothing on the server: a restore holds the app (.snapshots/.held in its folder)",
      );
    });

    it("and another rotation refuses while it holds the app", () => {
      write(at(".snapshots/.held"), `rotation ${OTHER}\n`);
      approve();
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `The rotation changed nothing: a credential rotation holds the app (the rotation of the plan ${OTHER})`,
      );
      expect(read(`${work}/exec.log`)).toBeUndefined();
    });
  });

  it("rewrites Grafana Alloy's masking file from the new app.env, and from the old one on an undo", () => {
    const plan = withMonitoring(PLAN);
    const mask = () => read(at("mask.re")) ?? "";
    approve();
    expect(run([HASH], { HEALTH_FAIL: "1" }, { plan }).status).toBe(1);
    for (const service of SERVICES) {
      expect(mask(), service).toContain(value(service).new);
      expect(mask(), service).not.toContain(value(service).old);
    }
    if (!windows) expect(mode(at("mask.re"))).toBe("600");
    approve("undo");
    expect(run(["--undo", HASH], {}, { plan }).status).toBe(0);
    for (const service of SERVICES) {
      expect(mask(), service).toContain(value(service).old);
      expect(mask(), service).not.toContain(value(service).new);
    }
  });

  it("keeps each begin command a step of its own: an undo reverses only those that ran", () => {
    const steps: RotateStep[] = [
      STEPS[0] as RotateStep,
      {
        service: "cache",
        envFile: "cache.env",
        mode: "dual",
        begin: [play("add"), play("grant")],
        finish: [play("drop")],
        recreate: false,
      },
    ];
    approve();
    const failed = run([HASH], { EXEC_FAIL: "cache grant" }, { steps });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      "The rotation stopped at step 3 of 6 (changing cache to its new value)",
    );
    approve("undo");
    expect(run(["--undo", HASH], {}, { steps }).status).toBe(0);
    // Its `add` ran and is reversed; its `grant` failed and isn't; its finish drops the new value.
    expect(lines(`${work}/exec.log`)).toEqual([
      "db change",
      "cache add",
      "cache grant",
      "cache add",
      "db change",
      "cache drop",
    ]);
    expect(valid("cache")).toEqual([value("cache").old]);
    expect(valid("db")).toEqual([value("db").old]);
  });

  it("runs a conditional command only when each of its checks succeeds", () => {
    const conditional: RotateStep[] = [
      {
        service: "cache",
        envFile: "cache.env",
        mode: "dual",
        begin: [play("add")],
        finish: [{ when: [play("check"), play("look")], run: play("drop") }],
        recreate: false,
      },
    ];
    approve();
    expect(run([HASH], {}, { steps: conditional }).status).toBe(0);
    expect(valid("cache")).toEqual([value("cache").new]);
    expect(lines(`${work}/exec.log`)).toEqual([
      "cache add",
      "cache check",
      "cache look",
      "cache drop",
    ]);
    // A check that fails skips the command, and is no failure.
    rmSync(`${work}/exec.log`);
    write(`${work}/values/cache`, `${value("cache").old}\n`);
    rmSync(at(".rotate/finished"));
    approve();
    expect(run([HASH], { EXEC_FAIL: "cache check" }, { steps: conditional }).status).toBe(0);
    expect(lines(`${work}/exec.log`)).toEqual(["cache add", "cache check"]);
    expect(valid("cache")).toEqual([value("cache").old, value("cache").new]);
  });

  it("passes values with blanks, quotes, $(…), backslashes and base64-looking text exactly", () => {
    const tricky = [
      { old: "two words", new: `it's "quoted"` },
      { old: '$(echo ran > "$WORK/ran")', new: "back\\slash\\n `echo ran`" },
      { old: "  padded both ends  ", new: "QUJD==" },
      { old: "\tleading tab", new: "trailing blank " },
      { old: "; rm -rf / #", new: "'single' & | > <" },
      { old: "=equals=at=ends=", new: "%s %d %%" },
    ];
    values = NAMES.map((_name, i) => tricky[i] ?? { old: `old ${i}`, new: `new ${i}` });
    server();
    approve();
    expect(run([HASH], { HEALTH_FAIL: "1" }).status).toBe(1);
    approve("undo");
    expect(run(["--undo", HASH]).status).toBe(0);
    expectUndone();
    approve();
    const result = run();
    expect(result.status, result.output).toBe(0);
    expectRotated();
    expect(existsSync(`${work}/ran`)).toBe(false);
  });

  describe("goes on only under its own hold", () => {
    it("refuses to go on once the hold is gone, and undoes", () => {
      approve();
      expect(run([HASH], { EXEC_FAIL: "cache add" }).status).toBe(1);
      rmSync(at(".snapshots/.held"));
      approve();
      const gone = run();
      expect(gone.status).toBe(1);
      expect(gone.stderr).toContain(
        "This rotation's hold on the app's server (.snapshots/.held in the app's folder) is gone, so a deploy may have changed the app since the rotation stopped, and nothing was changed. Put the old values back with opscrew rotate --undo, then rotate again.",
      );
      expect(ran("cache add")).toBe(1);
      approve("undo");
      expect(run(["--undo", HASH]).status).toBe(0);
      expectUndone();
    });

    it("refuses to go on or undo under a restore's hold, and keeps it", () => {
      approve();
      expect(run([HASH], { EXEC_FAIL: "cache add" }).status).toBe(1);
      write(at(".snapshots/.held"), "");
      for (const [action, args] of [
        ["rotate", [HASH]],
        ["undo", ["--undo", HASH]],
      ] as const) {
        approve(action);
        const refused = run(args);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(
          "The rotation changed nothing: a restore holds the app (.snapshots/.held in its folder)",
        );
      }
      expect(read(at(".snapshots/.held"))).toBe("");
      expect(ran("cache add")).toBe(1);
    });

    it("releases the hold only when it is its own", () => {
      approve();
      expect(run([HASH], { HOLD_DURING: "cache drop" }).status).toBe(0);
      expect(read(at(".snapshots/.held"))).toBe("");
    });

    it("and snapshot.sh hold, resume and restore refuse while a rotation holds the app", () => {
      write(at("snapshot.sh"), `${snapshotScript(PLAN).join("\n")}\n`);
      write(at(".snapshots/.held"), `rotation ${HASH}\n`);
      const snap = (args: string[]) =>
        spawnSync(
          "sh",
          [
            "-c",
            'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh "$0" "$@"',
            at("snapshot.sh"),
            ...args,
          ],
          {
            env: { ...process.env, WORK: work, OPSCREW_APPS_DIR: `${work}/srv/apps` },
            encoding: "utf8",
          },
        );
      const id = "20261108T060000Z";
      write(
        at(RESTORE_APPROVAL_FILE),
        `${restoreApprovalLine(id, undefined, Math.floor(Date.now() / 1000) + 600)}\n`,
      );
      for (const args of [["hold"], ["resume"], ["restore", id]]) {
        const refused = snap(args);
        expect(refused.status, args.join(" ")).toBe(1);
        expect(refused.stderr).toContain(
          `OpsCrew changed nothing: a credential rotation holds the app (the rotation of the plan ${HASH}), so its services may have new values the app does not use yet: finish the rotation with opscrew rotate, or put the old values back with opscrew rotate --undo, then try again.`,
        );
      }
      expect(read(at(".snapshots/.held"))).toBe(`rotation ${HASH}\n`);
      expect(lines(`${work}/docker.log`).filter((call) => call.startsWith("docker"))).toEqual([]);
    });
  });

  describe("on an extra server", () => {
    /** `sh rotate.sh <args>` on the split plan's server `data`, for its services. */
    const onData = (args: readonly string[], env: Record<string, string> = {}, plan = SPLIT) =>
      run(args, env, { plan, steps: EXTRA, server: "data" });
    const files = rotateEnvFiles(EXTRA, "data");

    it("reads only its services' env files", () => {
      expect(files).toEqual(["db.env", "docs.env"]);
      const script = renderRotateScript(SPLIT, EXTRA, "data").join("\n");
      expect(script).not.toContain("kamal-proxy");
      expect(script).not.toContain("APP_IMAGE");
    });

    it("gives the services their new values with begin, and drops the old ones with finish", () => {
      approve("begin");
      const begun = onData(["begin", HASH]);
      expect(begun.status, begun.output).toBe(0);
      expect(begun.stdout).toContain(
        "OpsCrew gave the services on the server data their new values; once the app runs on them, opscrew rotate drops the old ones there.",
      );
      const fresh = envFiles("new");
      for (const file of files) expect(read(at(file)), file).toBe(fresh[file]);
      expect(valid("db")).toEqual([value("db").new]);
      expect(valid("docs")).toEqual([value("docs").old, value("docs").new]);
      expect(held()).toBe(true);
      expect(read(at(".rotate/db.env.previous"))).toBe(envFiles("old")["db.env"]);
      // Its begin is done: run again, it changes nothing; the app's server never moves here.
      approve("begin");
      expect(onData(["begin", HASH]).stderr).toContain(
        "This rotation's services have their new values on the server data already",
      );
      expect(read(`${work}/route`)).toBe("shop-app-0\n");
      approve("finish");
      const finished = onData(["finish", HASH]);
      expect(finished.status, finished.output).toBe(0);
      expect(finished.stdout).toContain(
        "OpsCrew rotated the credentials on the server data: the old values no longer work, and deploys are no longer held.",
      );
      expect(valid("docs")).toEqual([value("docs").new]);
      expect(held()).toBe(false);
      expect(existsSync(at(".rotate/db.env.previous"))).toBe(false);
      expect(lines(`${work}/exec.log`)).toEqual(["db change", "docs add", "docs drop"]);
      approve("finish");
      expect(onData(["finish", HASH]).stderr).toContain(
        "This rotation finished on the server data already",
      );
    });

    it("refuses finish before begin, and an approval of another run", () => {
      approve("finish");
      const early = onData(["finish", HASH]);
      expect(early.status).toBe(1);
      expect(early.stderr).toContain(
        "This rotation's services don't have their new values on the server data yet, so nothing was changed.",
      );
      approve("begin");
      expect(onData(["finish", HASH]).stderr).toContain("is for another rotation");
      approve("rotate");
      expect(onData([HASH]).stderr).toContain(
        "Usage: sh rotate.sh begin <hash> | finish <hash> | --undo <hash>",
      );
      expect(read(`${work}/exec.log`)).toBeUndefined();
    });

    it("goes on after a failure, and undoes its begin", () => {
      approve("begin");
      const failed = onData(["begin", HASH], { EXEC_FAIL: "docs add" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "The rotation stopped at step 3 of 6 (changing docs to its new value), so deploys stay held.",
      );
      approve("begin");
      expect(onData(["begin", HASH]).status).toBe(0);
      approve("undo");
      const undone = onData(["--undo", HASH]);
      expect(undone.status, undone.output).toBe(0);
      expect(undone.stdout).toContain(
        "OpsCrew put the old values back on the server data: deploys are no longer held.",
      );
      const old = envFiles("old");
      for (const file of files) expect(read(at(file)), file).toBe(old[file]);
      expect(valid("db")).toEqual([value("db").old]);
      expect(valid("docs")).toEqual([value("docs").old]);
      expect(held()).toBe(false);
      expect(lines(`${work}/exec.log`).slice(3)).toEqual(["docs add", "db change", "docs drop"]);
    });

    it("refuses the undo once finish dropped an old value", () => {
      const twoDrops = [
        {
          ...(EXTRA[0] as RotateStep),
          mode: "dual" as const,
          begin: [play("add")],
          finish: [play("drop")],
        },
        EXTRA[1] as RotateStep,
      ];
      const steps = (args: readonly string[], env: Record<string, string> = {}) =>
        run(args, env, { plan: SPLIT, steps: twoDrops, server: "data" });
      approve("begin");
      expect(steps(["begin", HASH]).status).toBe(0);
      approve("finish");
      expect(steps(["finish", HASH], { EXEC_FAIL: "docs drop" }).status).toBe(1);
      approve("undo");
      expect(steps(["--undo", HASH]).stderr).toContain("so it can't be undone");
      approve("finish");
      expect(steps(["finish", HASH]).status).toBe(0);
    });

    it("rewrites the masking file from its services' env files where Alloy runs", () => {
      const plan = withMonitoring(SPLIT);
      approve("begin");
      expect(onData(["begin", HASH], {}, plan).status).toBe(0);
      const mask = read(at("mask.re")) ?? "";
      for (const service of ["db", "docs"]) {
        expect(mask, service).toContain(value(service).new);
        expect(mask, service).not.toContain(value(service).old);
      }
    });
  });
});
