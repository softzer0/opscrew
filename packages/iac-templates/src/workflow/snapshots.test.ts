// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { serviceSpec } from "../catalog";
import { withServices } from "../catalog/__fixtures__/plans";
import { localhostPlan } from "../edge/__fixtures__/localhost";
import { renderCompose, renderEdgeSite, renderRuntimeFiles } from "../runtime";
import { runtimeDir } from "../runtime-dir";
import {
  inEnvironment,
  NIGHTLY,
  splitPlan,
  withBuild,
  withPlan,
  withProcesses,
  withSqlite,
} from "./__fixtures__/plans";
import { COMPOSE_PROLOGUE, fakeBin, runSh, shWorks, write } from "./__fixtures__/sh";
import { renderWorkflow } from "./index";
import { snapshotScript } from "./snapshot-script";
import {
  ROLLBACK_APPROVAL_FILE,
  RUNNING_FILE,
  rollbackApprovalLine,
  snapshotFunctions,
} from "./snapshots";
import { rollbackCommands, switchCommands } from "./switch";

/** The digests of the earlier and the later version, and of another one. */
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const image = (hex: string) => `ghcr.io/acme/shop@sha256:${hex}`;

/** `shop` in staging (snapshots on by default) with PostgreSQL `db`, a worker and a cron job. */
const staging = withProcesses(inEnvironment(testPlan(), { name: "staging" }), {
  workers: [{ name: "worker", command: "node worker.js" }],
  cron: [NIGHTLY],
});
const APP = staging.app.name;

/** `plan` with Knex's down migrations (`app.migrations`) and its release command. */
const withMigrations = (plan: DeployPlan) =>
  DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      releaseCommand: "npx knex migrate:latest",
      migrations: {
        tool: "knex",
        status: "npx knex migrate:list",
        down: "npx knex migrate:down",
      },
    },
  });

/** The same app in staging with each of the four databases on its server. */
const fourDatabases = inEnvironment(
  withServices([
    { kind: "postgres", name: "db" },
    { kind: "mysql", name: "orders" },
    { kind: "mariadb", name: "shopdb" },
    { kind: "mongodb", name: "docs" },
  ]),
  { name: "staging" },
);

/**
 * The fake `docker`: logs every call to $WORK/docker.log. The app's containers live in
 * $WORK/containers-<project>, and its workers, cron and services always run (`p-<service>`, which
 * stop cleanly). A one-off container of a service (`--entrypoint sh <service> -c <script>`, the
 * snapshot's folder at `-v <folder>:/snapshot`) plays its data, the file $WORK/db-<service>: a
 * restore (the script names `pg_restore`, `mongorestore` or `DROP DATABASE`) copies the script's
 * `/snapshot/<file>` there, unless RESTORE_FAIL names the folder (it then leaves the database
 * `partial`); a copy writes it to `<folder>/<file>`, unless DUMP_FAIL names the service, and with
 * FILL_DISK fills the disk ($WORK/disk-full). A busybox one-off with a service's volumes, or the
 * SQLite volume's Python one-off, reads or writes the data on stdin and stdout. Failures print SECRET_ROW, as a
 * database's error can quote a row. kamal-proxy's `deploy` routes to a copy ($WORK/routes/<app>)
 * unless the copy's image is in UNHEALTHY; its `pause` and `resume` mark $WORK/paused. With
 * KILL_AT_STOP, `compose stop` kills the script that runs it, as a cancelled run would end. A
 * service NO_CONTAINER names has no container yet, and `compose port` answers PRIVATE_ADDRESS.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'echo "docker $*" >> "$WORK/docker.log"',
  ...COMPOSE_PROLOGUE,
  'case "$1 $2" in',
  '  "network inspect") test -f "$WORK/network-$3" ;;',
  '  "network create") touch "$WORK/network-$3" ;;',
  '  "compose ps")',
  '    case " ${NO_CONTAINER:-} " in *" $last "*) exit 0 ;; esac',
  '    if [ "$last" = app ]; then cut -d " " -f 1 "$state"; else echo "p-$last"; fi ;;',
  '  "compose port") echo "${PRIVATE_ADDRESS:-}:$last" ;;',
  '  "compose up")',
  '    if [ "$project" = opscrew-edge ] || [ "$last" != app ]; then exit 0; fi',
  '    n=$(( $(cat "$WORK/next" 2> /dev/null || echo 0) + 1 ))',
  '    echo "$n" > "$WORK/next"',
  '    case " $* " in *" --scale "*) ;; *) : > "$state" ;; esac',
  '    echo "c$n $project-app-$n $APP_IMAGE" >> "$state" ;;',
  '  "compose stop") if [ -n "${KILL_AT_STOP:-}" ]; then kill -9 "$PPID"; fi ;;',
  '  "compose run")',
  '    if [ "$last" = release ]; then exit 0; fi',
  '    host=""; service=""; script=""; p1=""; p2=""',
  '    for arg in "$@"; do',
  '      if [ "$p1" = -v ]; then host="${arg%%:/snapshot*}"; fi',
  '      if [ "$p2" = --entrypoint ] && [ "$p1" = sh ]; then service="$arg"; fi',
  '      if [ "$p1" = -c ]; then script="$arg"; fi',
  '      p2="$p1"; p1="$arg"',
  "    done",
  '    folder="$(basename "$host")"',
  "    file=\"$host/$(printf '%s' \"$script\" | grep -o '/snapshot/[^ ]*' | head -n 1 | cut -d / -f 3)\"",
  '    case "$script" in',
  '      *pg_restore* | *mongorestore* | *"DROP DATABASE"*)',
  '        case " ${RESTORE_FAIL:-} " in *" $folder "*) echo "restore failed at $SECRET_ROW"; echo partial > "$WORK/db-$service"; exit 1 ;; esac',
  '        cp "$file" "$WORK/db-$service" ;;',
  "      *)",
  '        case " ${DUMP_FAIL:-} " in *" $service "*) echo "dump failed at $SECRET_ROW"; exit 1 ;; esac',
  '        cp "$WORK/db-$service" "$file"',
  '        if [ -n "${FILL_DISK:-}" ]; then touch "$WORK/disk-full"; fi ;;',
  "    esac ;;",
  '  "run --rm")',
  '    service=""; script=""; p1=""',
  '    for arg in "$@"; do',
  '      if [ "$p1" = --volumes-from ]; then service="${arg%%:*}"; service="${service#p-}"; fi',
  '      if [ "$p1" = -v ]; then service=sqlite; fi',
  '      if [ "$p1" = -c ]; then script="$arg"; fi',
  '      p1="$arg"',
  "    done",
  '    case "$script" in',
  '      *"sys.stdout"* | *"-cf -"*) cat "$WORK/db-$service" ;;',
  '      *"sys.stdin"* | *"-xpf -"* | *"> /data/dump.rdb"* | *appendonlydir*) cat > "$WORK/db-$service" ;;',
  "    esac ;;",
  '  "compose exec")',
  '    if [ "$5 $6" = "kamal-proxy pause" ]; then touch "$WORK/paused"; fi',
  '    if [ "$5 $6" = "kamal-proxy resume" ]; then rm -f "$WORK/paused"; fi',
  '    if [ "$5 $6" = "kamal-proxy deploy" ]; then',
  '      target=""; prev=""',
  '      for arg in "$@"; do if [ "$prev" = --target ]; then target="$arg"; fi; prev="$arg"; done',
  `      image="$(cat "$WORK"/containers-* | awk -v n="\${target%:*}" '$2 == n { print $3 }')"`,
  '      case " ${UNHEALTHY:-} " in *" $image "*) exit 1 ;; esac',
  '      mkdir -p "$WORK/routes"; echo "$target" > "$WORK/routes/$7"',
  "    fi ;;",
  '  "inspect --format")',
  '    case "$3:$last" in',
  '      "{{.State.Status}} {{.State.ExitCode}}":*) echo "exited 0" ;;',
  "    esac",
  '    case "$last" in',
  '      p-*) if [ "$3" = "{{.RestartCount}}" ]; then echo 0; elif [ "$3" = "{{.State.Status}}:{{.RestartCount}}" ]; then echo running:0; fi ;;',
  `      *) cat "$WORK"/containers-* | awk -v id="$last" '$1 == id { print "/" $2 }' ;;`,
  "    esac ;;",
  '  "logs --timestamps") echo "copy-line of $last" ;;',
  '  "rm "*) for f in "$WORK"/containers-*; do grep -v "^$last " "$f" > "$f.tmp" || true; mv "$f.tmp" "$f"; done ;;',
  "esac",
].join("\n");

/**
 * The fake `flock`: logs its call among docker's ($WORK/docker.log); with FLOCK_BUSY, a bounded
 * wait (`-w`) runs out, as when another script holds the lock all that time.
 */
const FAKE_FLOCK = [
  "#!/bin/sh",
  'echo "flock $*" >> "$WORK/docker.log"',
  'if [ "$1" = -w ] && [ -n "${FLOCK_BUSY:-}" ]; then exit 1; fi',
].join("\n");

/**
 * The fake `df -Pk`: DISK_TOTAL_KB (default about 1 TB) with DISK_FREE_KB free (default half),
 * or almost nothing once $WORK/disk-full exists.
 */
const FAKE_DF = [
  "#!/bin/sh",
  'total="${DISK_TOTAL_KB:-1000000000}"',
  'free="${DISK_FREE_KB:-500000000}"',
  'if [ -f "$WORK/disk-full" ]; then free=1000; fi',
  'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
  'echo "/dev/sda1 $total 0 $free 50% /"',
].join("\n");

let work = "";
const appsDir = () => `${work}/srv/apps`;
const appDir = () => `${appsDir()}/${APP}`;
const at = (name: string) => `${appDir()}/${name}`;
const read = (name: string) => (existsSync(at(name)) ? readFileSync(at(name), "utf8") : undefined);
const db = (service = "db") => readFileSync(`${work}/db-${service}`, "utf8");
const setDb = (content: string, service = "db") => writeFileSync(`${work}/db-${service}`, content);
const calls = () =>
  existsSync(`${work}/docker.log`) ? readFileSync(`${work}/docker.log`, "utf8").split("\n") : [];
const paused = () => existsSync(`${work}/paused`);
const windows = process.platform === "win32";

/**
 * The app's runtime files in its folder, as the upload leaves them, with its snapshot script, and
 * its services' env files.
 */
function upload(plan: DeployPlan, secrets: Record<string, Record<string, string>> = {}): void {
  const dir = runtimeDir(plan);
  const files = [
    renderCompose(plan),
    ...renderRuntimeFiles(plan),
    ...renderEdgeSite(plan, testContext()),
  ];
  const folder = `${appsDir()}/${plan.app.name}`;
  for (const file of files) write(`${folder}/${file.path.slice(dir.length + 1)}`, file.content);
  const script = snapshotScript(plan);
  if (script.length > 0) write(`${folder}/snapshot.sh`, `${script.join("\n")}\n`);
  for (const service of plan.services) {
    const values = secrets[service.name] ?? {};
    const env = serviceSpec(service.kind).environment({
      plan,
      service,
      secretRef: (name) => values[name] ?? "unset",
    });
    write(
      `${folder}/${service.name}.env`,
      Object.entries(env)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  }
}

/**
 * A complete release snapshot of version `hex` taken at `taken`, holding `content` for each of
 * its PostgreSQL services, with its `about.json`.
 */
function snapshot(hex: string, taken: string, content: Record<string, string> = {}): void {
  write(at(`.snapshots/${hex}/taken`), `${taken}\n`);
  const services = Object.entries(content).map(([service, dump]) => {
    write(at(`.snapshots/${hex}/${service}.dump`), dump);
    return { name: service, kind: "postgres", file: `${service}.dump`, size: dump.length };
  });
  const about = { id: hex, kind: "release", taken, version: `sha256:${hex}`, services };
  write(at(`.snapshots/${hex}/about.json`), `${JSON.stringify(about)}\n`);
}

/** The one-time approval for `hex`, valid for `seconds` more (negative: expired). */
function approve(hex: string, choice: string, seconds = 1800): void {
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  // `choice` may be one the script refuses: the line is the exported format all the same.
  const line = rollbackApprovalLine(hex, choice as "snapshot" | "migrations", expiresAt);
  write(
    at(ROLLBACK_APPROVAL_FILE),
    `${line}
`,
  );
}

/**
 * Runs `script` as the workflow does: piped to `sh -s` with the image as `$1` and the mode as
 * `$2`, the roots under the test's folder, and the fakes first on PATH.
 */
function run(
  script: readonly string[],
  hex: string,
  mode?: "deploy" | "rollback",
  env: Record<string, string> = {},
) {
  return runSh(script, [image(hex), ...(mode === undefined ? [] : [mode])], {
    WORK: work,
    OPSCREW_APPS_DIR: appsDir(),
    OPSCREW_EDGE_DIR: `${work}/srv/edge`,
    SECRET_ROW: "row-value-from-the-database",
    ...env,
  });
}

/** The index of the first call that contains `text`, or -1. */
const callAt = (text: string) => calls().findIndex((call) => call.includes(text));
/** The one-off containers of the databases: `<service> <folder> <rw|ro>` each. */
const oneOffs = () =>
  calls()
    .filter((call) => call.includes(" --entrypoint sh "))
    .map((call) => {
      const mount = /\.snapshots\/(\S+):\/snapshot:(rw|ro) --entrypoint sh (\S+) /.exec(call);
      return `${mount?.[3]} ${mount?.[1]} ${mount?.[2]}`;
    });
/** The snapshots' folders that exist, sorted. */
const snapshots = () =>
  existsSync(at(".snapshots"))
    ? readdirSync(at(".snapshots"))
        .filter((name) => name !== "snapshot.log")
        .sort()
    : [];
const mode = (name: string) => (statSync(at(name)).mode & 0o777).toString(8);

const TAKEN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/;

describe.skipIf(!shWorks())(
  "the snapshot and the rollback's database step",
  { timeout: 120_000 },
  () => {
    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "opscrew-snapshots-")).replaceAll("\\", "/");
      fakeBin(work, { docker: FAKE_DOCKER, df: FAKE_DF, flock: FAKE_FLOCK, sleep: "#!/bin/sh" });
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    describe("at a deploy", () => {
      const release = withPlan(staging, { releaseCommand: "npm run migrate" });
      const deploy = (plan: DeployPlan, env: Record<string, string> = {}) =>
        run(switchCommands(plan, []), B, "deploy", env);
      /** The running version A, with the database's rows. */
      const runningA = (plan: DeployPlan = release) => {
        upload(plan);
        write(at(".env"), `APP_IMAGE=${image(A)}\n`);
        setDb("rows while A ran\n");
      };

      it("dumps the database under the running version before the release command", () => {
        runningA();
        const result = deploy(release);
        expect(result.status, result.output).toBe(0);
        expect(read(`.snapshots/${A}/db.dump`)).toBe("rows while A ran\n");
        expect(read(`.snapshots/${A}/taken`)).toMatch(TAKEN);
        expect(snapshots()).toEqual([A]);
        expect(oneOffs()).toEqual([`db ${A}.partial rw`]);
        expect(callAt(" --entrypoint sh db ")).toBeGreaterThan(callAt("--wait db"));
        expect(callAt(" --entrypoint sh db ")).toBeLessThan(
          callAt("run --rm --no-deps -T release"),
        );
        // The one-off runs as the deploy user, in the service's own image and env file.
        expect(calls().find((call) => call.includes(" --entrypoint sh db "))).toMatch(
          /^docker compose run --rm --no-deps -T --user \d+:\d+ -v \S+\/srv\/apps\/shop-staging\/\.snapshots\/a{64}\.partial:\/snapshot:rw --entrypoint sh db -c /,
        );
        expect(result.output).toContain("OpsCrew took a snapshot of the data before this release");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        if (!windows) {
          expect(mode(".snapshots")).toBe("700");
          expect(mode(`.snapshots/${A}`)).toBe("700");
          expect(mode(`.snapshots/${A}/taken`)).toBe("600");
          expect(mode(`.snapshots/${A}/db.dump`)).toBe("600");
          expect(mode(".snapshots/snapshot.log")).toBe("600");
        }
      });

      it("takes one without a release command too", () => {
        runningA(staging);
        expect(deploy(staging).status).toBe(0);
        expect(read(`.snapshots/${A}/db.dump`)).toBe("rows while A ran\n");
      });

      it("has nothing to take on the first deploy, nor when the image runs already", () => {
        upload(release);
        setDb("rows\n");
        const first = deploy(release);
        expect(first.status, first.output).toBe(0);
        write(at(".env"), `APP_IMAGE=${image(B)}\n`);
        const same = deploy(release);
        expect(same.status, same.output).toBe(0);
        expect(oneOffs()).toEqual([]);
        expect(existsSync(at(".snapshots"))).toBe(false);
      });

      it("warns and deploys without one when the disk has less than 1 GiB or 10% free", () => {
        for (const disk of [
          { DISK_TOTAL_KB: "5000000", DISK_FREE_KB: "900000" },
          { DISK_TOTAL_KB: "100000000", DISK_FREE_KB: "9000000" },
        ]) {
          rmSync(at(".snapshots"), { recursive: true, force: true });
          runningA();
          const result = deploy(release, disk);
          expect(result.status, result.output).toBe(0);
          expect(result.output).toContain(
            `::warning::The disk that holds ${appDir()} has less than 1 GiB or 10% free, so OpsCrew takes no snapshot of the data this time`,
          );
          expect(result.output).toContain(
            "deploy.keepSnapshots in opscrew/environments/staging/plan.yaml",
          );
          expect(snapshots()).toEqual([]);
          expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        }
        expect(oneOffs()).toEqual([]);
      });

      it("removes the partial snapshot when a dump leaves the disk too full, and deploys", () => {
        runningA();
        const result = deploy(release, { FILL_DISK: "1" });
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain("::warning::The disk that holds");
        expect(oneOffs()).toEqual([`db ${A}.partial rw`]);
        expect(snapshots()).toEqual([]);
        expect(callAt("run --rm --no-deps -T release")).toBeGreaterThan(-1);
      });

      it("stops the deploy when a dump fails, naming the log and deploy.snapshots, printing none of it", () => {
        runningA();
        const result = deploy(release, { DUMP_FAIL: "db" });
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          `::error::The snapshot of the data before this release failed, so the new version was not started and the previous version keeps serving. The copies' output stays on the server in ${appDir()}/.snapshots/snapshot.log (it can quote data from the database, so it is not printed here; opscrew/environments/staging/RUNBOOK.md has the SSH command). Fix its cause and push again, or set deploy.snapshots: false in opscrew/environments/staging/plan.yaml to deploy without snapshots.`,
        );
        expect(result.output).not.toContain("row-value-from-the-database");
        expect(read(".snapshots/snapshot.log")).toContain("row-value-from-the-database");
        expect(snapshots()).toEqual([]);
        expect(callAt("run --rm --no-deps -T release")).toBe(-1);
        expect(callAt("kamal-proxy deploy")).toBe(-1);
        expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
      });

      it("keeps the newest deploy.keepSnapshots snapshots, removing older ones and stale partials", () => {
        runningA();
        snapshot("1".repeat(64), "2026-11-01T10:00:00Z", { db: "1" });
        snapshot("2".repeat(64), "2026-11-02T10:00:00Z", { db: "2" });
        snapshot("3".repeat(64), "2026-11-03T10:00:00Z", { db: "3" });
        write(at(`.snapshots/${"4".repeat(64)}.partial/db.dump`), "half");
        expect(deploy(release).status).toBe(0);
        expect(snapshots()).toEqual(["2".repeat(64), "3".repeat(64), A].sort());

        // Each deploy uploads the snapshot script of its plan.
        write(at(".env"), `APP_IMAGE=${image(A)}\n`);
        const keepOne = withPlan(release, { deploy: { keepSnapshots: 1 } });
        upload(keepOne);
        expect(deploy(keepOne).status).toBe(0);
        expect(snapshots()).toEqual([A]);
      });

      it("replaces an earlier snapshot of the same version", () => {
        runningA();
        snapshot(A, "2026-11-01T10:00:00Z", { db: "older rows" });
        expect(deploy(release).status).toBe(0);
        expect(read(`.snapshots/${A}/db.dump`)).toBe("rows while A ran\n");
        expect(read(`.snapshots/${A}/taken`)).not.toContain("2026-11-01");
      });

      it("dumps and restores each of the four databases, every password staying in its container", () => {
        const secrets = Object.fromEntries(
          fourDatabases.services.map((service) => [
            service.name,
            {
              password: randomBytes(16).toString("hex"),
              "root-password": randomBytes(16).toString("hex"),
            },
          ]),
        );
        upload(fourDatabases, secrets);
        write(at(".env"), `APP_IMAGE=${image(A)}\n`);
        for (const service of ["db", "orders", "shopdb", "docs"])
          setDb(`${service} rows\n`, service);
        const result = run(switchCommands(fourDatabases, []), B, "deploy");
        expect(result.status, result.output).toBe(0);
        expect(oneOffs()).toEqual(
          ["db", "orders", "shopdb", "docs"].map((service) => `${service} ${A}.partial rw`),
        );
        for (const service of ["db", "orders", "shopdb", "docs"]) {
          expect(read(`.snapshots/${A}/${service}.dump`)).toBe(`${service} rows\n`);
        }
        const deployLog = read(".snapshots/snapshot.log") ?? "";

        // The rollback to A saves B's databases, then restores A's snapshot of each.
        for (const service of ["db", "orders", "shopdb", "docs"])
          setDb(`${service} newer\n`, service);
        approve(A, "snapshot");
        const back = run(switchCommands(fourDatabases, []), A, "rollback");
        expect(back.status, back.output).toBe(0);
        for (const service of ["db", "orders", "shopdb", "docs"]) {
          expect(db(service)).toBe(`${service} rows\n`);
          expect(read(`.snapshots/${B}/${service}.dump`)).toBe(`${service} newer\n`);
        }
        const passwords = Object.values(secrets).flatMap((values) => Object.values(values));
        const seen = [
          result.output,
          back.output,
          calls().join("\n"),
          deployLog,
          read(".snapshots/snapshot.log") ?? "",
        ];
        for (const password of passwords)
          for (const text of seen) expect(text).not.toContain(password);
      });
    });

    describe("in a rollback", () => {
      const rollback = (plan: DeployPlan = staging, env: Record<string, string> = {}) =>
        run(switchCommands(plan, []), A, "rollback", env);
      /** B runs on the database's newest rows; A's snapshot holds older ones. */
      const runningB = (plan: DeployPlan = staging) => {
        upload(plan);
        write(at(".env"), `APP_IMAGE=${image(B)}\n`);
        write(`${work}/containers-${APP}`, `c90 ${APP}-app-90 ${image(B)}\n`);
        mkdirSync(`${work}/routes`, { recursive: true });
        writeFileSync(`${work}/routes/${APP}`, `${APP}-app-90:3000\n`);
        setDb("rows of B\n");
        snapshot(A, "2026-11-05T09:30:00Z", { db: "rows of A\n" });
      };
      const STOP = `docker compose stop app worker cron`;
      const START = "docker compose start app worker cron";

      it("restores the snapshot with the approval: hold, stop, save, restore, recreate, resume", () => {
        runningB();
        approve(A, "snapshot");
        const result = rollback();
        expect(result.status, result.output).toBe(0);
        expect(existsSync(at(".rollback-database"))).toBe(false);
        expect(db()).toBe("rows of A\n");
        // The current database is saved under the running version first.
        expect(read(`.snapshots/${B}/db.dump`)).toBe("rows of B\n");
        expect(read(`.snapshots/${B}/taken`)).toMatch(TAKEN);
        expect(oneOffs()).toEqual([`db ${B}.partial rw`, `db ${A} ro`]);
        const order = [
          "kamal-proxy pause shop-staging --drain-timeout 30s --max-pause 90s",
          STOP,
          `${B}.partial:/snapshot:rw`,
          `${A}:/snapshot:ro`,
          "compose up -d --no-deps --remove-orphans app",
          "kamal-proxy deploy shop-staging",
          "kamal-proxy resume shop-staging",
        ].map(callAt);
        expect(order).toEqual([...order].sort((x, y) => x - y));
        expect(order[0]).toBeGreaterThan(-1);
        // The recreate switch, whatever deploy.strategy says, and no release command.
        expect(calls().join("\n")).not.toContain("--scale");
        expect(callAt("-T release")).toBe(-1);
        expect(paused()).toBe(false);
        expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
        expect(result.output).toContain(
          "OpsCrew restored the database from the snapshot taken 2026-11-05T09:30:00Z.",
        );
        // The marker that this run changed the database, for the workflow's rollback script.
        expect(read(".database.changed")).toBe(
          `target=${A}\nAPP_IMAGE=${image(B)}\nsaved=${B}\nchanged=1\n`,
        );
        if (!windows) expect(mode(".database.changed")).toBe("600");
        expect(result.output).not.toContain("row-value-from-the-database");
      });

      it("uses the approval once: the next rollback keeps the data", () => {
        runningB();
        approve(A, "snapshot");
        expect(rollback().status).toBe(0);
        write(at(".env"), `APP_IMAGE=${image(B)}\n`);
        setDb("rows of B again\n");
        rmSync(`${work}/docker.log`);
        const again = rollback();
        expect(again.status, again.output).toBe(0);
        expect(db()).toBe("rows of B again\n");
        expect(oneOffs()).toEqual([]);
      });

      it("keeps the data without an approval, as before", () => {
        runningB();
        const result = rollback();
        expect(result.status, result.output).toBe(0);
        expect(oneOffs()).toEqual([]);
        expect(callAt("kamal-proxy pause")).toBe(-1);
        expect(callAt("compose stop")).toBe(-1);
        expect(calls().join("\n")).toContain("--scale app=2 app");
        expect(db()).toBe("rows of B\n");
        expect(snapshots()).toEqual([A]);
        expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
        expect(result.output).not.toContain("::warning::");
      });

      it("removes an approval for another version with a note, and keeps the data", () => {
        runningB();
        approve(B, "snapshot");
        const result = rollback();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          "::warning::The approval to change the database on a rollback (.rollback-database on the server) is for another version, so OpsCrew removed it: this rollback keeps the database as it is.",
        );
        expect(existsSync(at(".rollback-database"))).toBe(false);
        expect(oneOffs()).toEqual([]);
        expect(db()).toBe("rows of B\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
      });

      it("changes nothing, not even the image, with an approval for this version past its time or with another choice", () => {
        const expired =
          "::error::The one-time approval to restore or migrate the database on this rollback expired before the run started, so nothing was changed. Run opscrew rollback again.";
        const unusable =
          "::error::The one-time approval to change the database on this rollback (.rollback-database on the server) names a choice this server can't carry out, so nothing was changed. Run opscrew rollback again.";
        for (const [choice, seconds, said] of [
          ["snapshot", -1, expired],
          // An expiry of more than ten digits is none.
          ["snapshot", 100_000_000_000, expired],
          ["keep", 1800, unusable],
          // Down migrations only with app.migrations.
          ["migrations", 1800, unusable],
        ] as const) {
          rmSync(`${work}/docker.log`, { force: true });
          runningB();
          approve(A, choice, seconds);
          const result = rollback();
          expect(result.status).toBe(1);
          expect(result.output).toContain(said);
          expect(existsSync(at(".rollback-database"))).toBe(false);
          expect(
            calls().filter((call) => call.startsWith("docker compose") && !call.includes("logout")),
          ).toEqual([]);
          expect(db()).toBe("rows of B\n");
          expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
          expect(run(rollbackCommands(staging), A).stdout).toBe("unchanged");
        }
      });

      it("puts the current database back and starts the running version again when the restore fails", () => {
        runningB();
        approve(A, "snapshot");
        const result = rollback(staging, { RESTORE_FAIL: A });
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          `::error::Restoring the snapshot of the database failed, so OpsCrew put the database back as it was before the rollback, and the running version starts again: the rollback changed nothing. The output of the dumps and restores stays on the server in ${appDir()}/.snapshots/snapshot.log (it can quote data from the database, so it is not printed here; opscrew/environments/staging/RUNBOOK.md has the SSH command).`,
        );
        expect(result.output).not.toContain("row-value-from-the-database");
        // The failed restore's lines survive the put-back's.
        expect(read(".snapshots/snapshot.log")).toContain(
          "restore failed at row-value-from-the-database",
        );
        expect(oneOffs()).toEqual([`db ${B}.partial rw`, `db ${A} ro`, `db ${B} ro`]);
        expect(db()).toBe("rows of B\n");
        expect(callAt(START)).toBeGreaterThan(callAt(`${B}:/snapshot:ro`));
        expect(callAt("compose up -d --no-deps --remove-orphans app")).toBe(-1);
        expect(paused()).toBe(false);
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(existsSync(at(".database.changed"))).toBe(false);
        // The workflow's rollback step then finds .env unchanged.
        const back = run(rollbackCommands(staging), A);
        expect(back.stdout).toBe("unchanged");
      });

      it("starts no version on a database it could not put back, and the rollback step tries once more", () => {
        runningB();
        approve(A, "snapshot");
        const result = rollback(staging, { RESTORE_FAIL: `${A} ${B}` });
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          `::error::Restoring the snapshot of the database failed, and putting the database back as it was before the rollback failed too, so it may be partly changed, and no version of the app starts on it. Its copy from before the rollback stays in ${appDir()}/.snapshots/${B}: the rollback step tries once more to restore it.`,
        );
        expect(callAt("compose start")).toBe(-1);
        expect(read(`.snapshots/${B}/db.dump`)).toBe("rows of B\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(read(".database.changed")).toContain("changed=1\n");
        // The trap still lets requests through.
        expect(paused()).toBe(false);

        // The rollback step's put-back fails too: it stops, starting nothing.
        write(at(".env.previous"), `APP_IMAGE=${image(B)}\n`);
        rmSync(`${work}/docker.log`);
        const again = run(rollbackCommands(staging), A, undefined, { RESTORE_FAIL: B });
        expect(again.status).toBe(1);
        expect(again.stdout).toBe("");
        expect(again.output).toContain(
          `::error::The earlier version failed after the rollback changed the database, and putting the database back as it was before the rollback failed, so it may be partly changed, and no version of the app starts on it. Its copy from before the rollback stays in ${appDir()}/.snapshots/${B}: restore it, then start the app.`,
        );
        expect(callAt("compose up")).toBe(-1);
        expect(paused()).toBe(false);

        // Once it can, the rollback step puts it back and starts the version that ran.
        const last = run(rollbackCommands(staging), A);
        expect(last.stdout).toBe("unchanged");
        expect(db()).toBe("rows of B\n");
        expect(existsSync(at(".database.changed"))).toBe(false);
      });

      it("changes nothing when saving the current database fails", () => {
        runningB();
        approve(A, "snapshot");
        const result = rollback(staging, { DUMP_FAIL: "db" });
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          "::error::OpsCrew could not save the current database before changing it, so the rollback changed nothing and the running version starts again.",
        );
        expect(result.output).not.toContain("row-value-from-the-database");
        expect(oneOffs()).toEqual([`db ${B}.partial rw`]);
        expect(callAt(START)).toBeGreaterThan(callAt(STOP));
        expect(db()).toBe("rows of B\n");
        expect(snapshots()).toEqual([A]);
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(existsSync(at(".database.changed"))).toBe(false);
        expect(paused()).toBe(false);
      });

      it("changes nothing when the disk is too full to save the current database first", () => {
        runningB();
        approve(A, "snapshot");
        const result = rollback(staging, { DISK_TOTAL_KB: "5000000", DISK_FREE_KB: "900000" });
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          "::error::The server has too little free disk to save the current database before changing it, so the rollback changed nothing and the running version starts again. Free some space and run opscrew rollback again.",
        );
        expect(oneOffs()).toEqual([]);
        expect(callAt(START)).toBeGreaterThan(callAt(STOP));
        expect(db()).toBe("rows of B\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(existsSync(at(".database.changed"))).toBe(false);
        expect(run(rollbackCommands(staging), A).stdout).toBe("unchanged");
      });

      it("refuses before any change when the snapshot is not complete or .env names no other digest", () => {
        runningB();
        rmSync(at(`.snapshots/${A}/db.dump`));
        approve(A, "snapshot");
        const missing = rollback();
        expect(missing.status).toBe(1);
        expect(missing.output).toContain(
          "::error::The snapshot this rollback was approved to restore is no longer complete on the server (in .snapshots), so the rollback changed nothing.",
        );
        for (const env of [`APP_IMAGE=opscrew-local/shop:latest\n`, `APP_IMAGE=${image(A)}\n`]) {
          runningB();
          write(at(".env"), env);
          approve(A, "snapshot");
          const result = rollback();
          expect(result.status).toBe(1);
          expect(result.output).toContain(
            "::error::The server's .env names no other version by its image digest",
          );
        }
        expect(callAt("kamal-proxy pause")).toBe(-1);
        expect(callAt("compose stop")).toBe(-1);
        expect(oneOffs()).toEqual([]);
        expect(db()).toBe("rows of B\n");
      });

      it("runs the down migrations and puts the database back when they fail", () => {
        const knex = withMigrations(staging);
        runningB(knex);
        approve(A, "migrations");
        const result = rollback(knex);
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          "::error::Migrating the database down failed, so OpsCrew put the database back as it was before the rollback",
        );
        expect(oneOffs()).toEqual([`db ${B}.partial rw`, `db ${B} ro`]);
        expect(db()).toBe("rows of B\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      });

      it("saves the current database first with snapshots off too, and puts it back when the step fails", () => {
        const off = withMigrations(withPlan(staging, { deploy: { snapshots: false } }));
        runningB(off);
        approve(A, "migrations");
        const result = rollback(off);
        expect(result.status).toBe(1);
        expect(oneOffs()).toEqual([`db ${B}.partial rw`, `db ${B} ro`]);
        expect(result.output).toContain(
          "::error::Migrating the database down failed, so OpsCrew put the database back as it was before the rollback",
        );
        expect(db()).toBe("rows of B\n");
      });

      it("says no copy was saved when the app has no database the step can dump", () => {
        const knex = withMigrations(
          inEnvironment(testPlan({ postgres: false }), { name: "staging" }),
        );
        upload(knex);
        write(at(".env"), `APP_IMAGE=${image(B)}\n`);
        write(`${work}/containers-${APP}`, `c90 ${APP}-app-90 ${image(B)}\n`);
        approve(A, "migrations");
        const result = rollback(knex);
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          "::error::Migrating the database down failed, and no copy of the database from before the rollback was saved (OpsCrew saves only the PostgreSQL, MySQL, MariaDB, MongoDB and SQLite databases on the app's server), so the database may be partly changed; the running version starts again.",
        );
        expect(oneOffs()).toEqual([]);
        expect(callAt("docker compose start app")).toBeGreaterThan(-1);
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(existsSync(at(".database.changed"))).toBe(false);
        // Restoring a snapshot is no choice there.
        approve(A, "snapshot");
        expect(rollback(knex).output).toContain("names a choice this server can't carry out");
      });
    });

    describe("when the earlier version fails after the database step", () => {
      const rollback = (env: Record<string, string> = {}) =>
        run(switchCommands(staging, []), A, "rollback", env);
      const back = () => run(rollbackCommands(staging), A);
      /** B runs; A's snapshot holds older rows; the rollback to A is approved. */
      const approved = () => {
        upload(staging);
        write(at(".env"), `APP_IMAGE=${image(B)}\n`);
        write(at(".env.previous"), `APP_IMAGE=${image(B)}\n`);
        write(`${work}/containers-${APP}`, `c90 ${APP}-app-90 ${image(B)}\n`);
        mkdirSync(`${work}/routes`, { recursive: true });
        writeFileSync(`${work}/routes/${APP}`, `${APP}-app-90:3000\n`);
        setDb("rows of B\n");
        snapshot(A, "2026-11-05T09:30:00Z", { db: "rows of A\n" });
        approve(A, "snapshot");
      };
      /** The marker of a database step that saved B's database, as the start script leaves it. */
      const MARKER = `target=${A}\nAPP_IMAGE=${image(B)}\nsaved=${B}\nchanged=1\n`;
      const routedImage = () => {
        const name = readFileSync(`${work}/routes/${APP}`, "utf8").trim().split(":")[0];
        return readFileSync(`${work}/containers-${APP}`, "utf8")
          .split("\n")
          .find((line) => line.split(" ")[1] === name)
          ?.split(" ")[2];
      };

      it("puts the database back before the version that ran starts again, when its health check fails", () => {
        approved();
        const start = rollback({ UNHEALTHY: image(A) });
        expect(start.status).toBe(1);
        expect(db()).toBe("rows of A\n");
        expect(read(".database.changed")).toBe(MARKER);
        rmSync(`${work}/docker.log`);
        const result = back();
        expect(result.status, result.output).toBe(0);
        expect(result.stdout).toBe("restored");
        expect(result.output).toContain(
          "The earlier version failed after the rollback changed the database, so OpsCrew put the database back as it was before the rollback.",
        );
        expect(db()).toBe("rows of B\n");
        const order = [
          "kamal-proxy pause",
          "compose stop app worker cron",
          `${B}:/snapshot:ro`,
          "compose up -d --no-deps --remove-orphans app",
          "kamal-proxy deploy",
          "kamal-proxy resume",
        ].map(callAt);
        expect(order).toEqual([...order].sort((x, y) => x - y));
        expect(order[0]).toBeGreaterThan(-1);
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(routedImage()).toBe(image(B));
        expect(existsSync(at(".database.changed"))).toBe(false);
        expect(paused()).toBe(false);
      });

      it("puts it back when the check from outside fails after the start script finished", () => {
        approved();
        expect(rollback().status).toBe(0);
        expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
        const result = back();
        expect(result.stdout).toBe("restored");
        expect(db()).toBe("rows of B\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      });

      it("starts the version .env names again when the start script stopped before the switch", () => {
        approved();
        write(at(".database.changed"), MARKER);
        setDb("half restored\n");
        snapshot(B, "2026-11-06T10:00:00Z", { db: "rows of B\n" });
        const result = back();
        expect(result.status, result.output).toBe(0);
        expect(result.stdout).toBe("unchanged");
        expect(db()).toBe("rows of B\n");
        expect(callAt("compose up -d --no-deps --remove-orphans app")).toBeGreaterThan(
          callAt(`${B}:/snapshot:ro`),
        );
        expect(routedImage()).toBe(image(B));
        expect(existsSync(at(".database.changed"))).toBe(false);
      });

      it("starts the version that ran again, restoring nothing, when the run stopped before step 4", () => {
        approved();
        const killed = rollback({ KILL_AT_STOP: "1" });
        expect(killed.status).not.toBe(0);
        expect(read(".database.changed")).toBe(
          `target=${A}\nAPP_IMAGE=${image(B)}\nsaved=\nchanged=0\n`,
        );
        expect(paused()).toBe(true);
        rmSync(`${work}/docker.log`);
        const result = back();
        expect(result.status, result.output).toBe(0);
        expect(result.stdout).toBe("unchanged");
        expect(oneOffs()).toEqual([]);
        expect(db()).toBe("rows of B\n");
        expect(callAt("compose up -d --no-deps --remove-orphans app")).toBeGreaterThan(
          callAt("compose stop app worker cron"),
        );
        expect(routedImage()).toBe(image(B));
        expect(existsSync(at(".database.changed"))).toBe(false);
        expect(paused()).toBe(false);
      });

      it("ignores an earlier run's marker: for another version, or not this run's .env.previous", () => {
        approved();
        expect(rollback().status).toBe(0);
        expect(db()).toBe("rows of A\n");
        // A later run of another image that never reached its start script.
        rmSync(`${work}/docker.log`);
        const other = run(rollbackCommands(staging), C);
        expect(other.stdout).toBe("unchanged");
        expect(oneOffs()).toEqual([]);
        expect(db()).toBe("rows of A\n");
        expect(existsSync(at(".database.changed"))).toBe(false);
        // The same target, but .env.previous names a version the marker didn't record.
        write(at(".database.changed"), MARKER);
        write(at(".env.previous"), `APP_IMAGE=${image(C)}\n`);
        const stale = back();
        expect(stale.stdout).toBe("restored");
        expect(oneOffs()).toEqual([]);
        expect(db()).toBe("rows of A\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(C)}\n`);
      });

      it("says the database stays as the step left it when no copy was saved", () => {
        approved();
        write(at(".env"), `APP_IMAGE=${image(A)}\n`);
        write(at(".database.changed"), `target=${A}\nAPP_IMAGE=${image(B)}\nsaved=\nchanged=1\n`);
        setDb("rows of A\n");
        const result = back();
        expect(result.stdout).toBe("restored");
        expect(result.output).toContain(
          "::warning::The earlier version failed after the rollback changed the database, and no copy of the database from before the rollback was saved, so it stays as the rollback left it while the version that ran before starts again. The next deploy's release command migrates it up again.",
        );
        expect(oneOffs()).toEqual([]);
        expect(db()).toBe("rows of A\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      });

      it("removes an earlier run's marker at every start, so a later failure restores nothing", () => {
        approved();
        rmSync(at(".rollback-database"));
        write(at(".database.changed"), MARKER);
        const push = run(switchCommands(staging, []), A, "deploy", { UNHEALTHY: image(A) });
        expect(push.status).toBe(1);
        expect(existsSync(at(".database.changed"))).toBe(false);
        rmSync(`${work}/docker.log`);
        back();
        expect(oneOffs()).toEqual([]);
      });

      it("serialises the two scripts: the start script holds the app's lock from its first lines, the rollback script takes it before reading anything", () => {
        const start = switchCommands(staging, []);
        const cd = start.indexOf('cd "$APPS_DIR"/shop-staging');
        expect(start.slice(cd + 1, cd + 3)).toEqual(["exec 7> .start.lock", "flock 7"]);
        const script = rollbackCommands(staging);
        const lock = script.indexOf("exec 7> .start.lock");
        expect(script[lock - 1]).toBe('cd "$APPS_DIR"/shop-staging');
        expect(script[lock + 1]).toMatch(/^flock -w 900 7 \|\| \{ echo '::error::/);
        const reads = script.findIndex((line) => /\.database\.changed|\.env\b/.test(line));
        expect(reads).toBeGreaterThan(lock + 1);

        approved();
        expect(rollback().status).toBe(0);
        expect(calls()[0]).toBe("flock 7");
        rmSync(`${work}/docker.log`);
        back();
        expect(calls()[0]).toBe("flock -w 900 7");
      });

      it("changes nothing when the start script still holds the lock after 15 minutes", () => {
        approved();
        write(at(".database.changed"), MARKER);
        const result = run(rollbackCommands(staging), A, undefined, { FLOCK_BUSY: "1" });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.output).toContain(
          "::error::The start script of this run is still running on the server after 15 minutes, so the rollback step changed nothing. Check the app on the server (opscrew/environments/staging/RUNBOOK.md has the SSH command), then run the deploy or opscrew rollback again.",
        );
        expect(calls()).toEqual(["flock -w 900 7", ""]);
        expect(read(".database.changed")).toBe(MARKER);
        expect(db()).toBe("rows of B\n");
      });
    });

    describe("with every kind of data (US7)", () => {
      /**
       * `shop` in staging on SQLite with PostgreSQL `db`, a Valkey queue and the stop-only Kafka,
       * which the release snapshot copies (`deploy.snapshotStop`), and RabbitMQ (`mq`), which it
       * leaves out.
       */
      const base = withSqlite(
        withBuild(
          inEnvironment(
            withServices([
              { kind: "postgres", name: "db" },
              { kind: "valkey", name: "queue", options: { mode: "queue" } },
              { kind: "kafka", name: "kafka" },
              { kind: "rabbitmq", name: "mq" },
            ]),
            { name: "staging" },
          ),
          "generated-dockerfile",
        ),
      );
      const every = DeployPlanSchema.parse({
        ...base,
        deploy: { ...base.deploy, snapshotStop: ["kafka"] },
      });
      const PARTS = ["db", "queue", "kafka", "mq", "sqlite"];
      const FILES = ["db.dump", "queue.rdb", "kafka.tar", "sqlite.tar"];
      const each = (content: string) => {
        for (const part of PARTS) setDb(`${part} ${content}\n`, part);
      };
      /** A's release snapshot, taken by the deploy of B, then B's newer data. */
      const deployedB = () => {
        upload(every);
        write(at(".env"), `APP_IMAGE=${image(A)}\n`);
        each("rows of A");
        const deployed = run(switchCommands(every, []), B, "deploy");
        expect(deployed.status, deployed.output).toBe(0);
        each("rows of B");
        rmSync(`${work}/docker.log`);
        return deployed;
      };

      it("copies every kind before a release, stop-only ones only in deploy.snapshotStop", () => {
        const deployed = deployedB();
        for (const file of FILES) {
          expect(read(`.snapshots/${A}/${file}`)).toBe(`${file.split(".")[0]} rows of A\n`);
        }
        expect(existsSync(at(`.snapshots/${A}/mq.tar`))).toBe(false);
        const about = JSON.parse(read(`.snapshots/${A}/about.json`) ?? "");
        expect(about).toMatchObject({ id: A, kind: "release", version: `sha256:${A}` });
        expect(about.services.map((s: { name: string; skipped?: true }) => s)).toContainEqual({
          name: "mq",
          kind: "rabbitmq",
          skipped: true,
        });
        expect(deployed.output).toContain(
          "mq was left out of the snapshot before this release: it must stop for its copy.",
        );
        expect(deployed.output).toContain(
          "OpsCrew took a snapshot of the data before this release",
        );
      });

      it("restores every kind on a rollback, after copying each under the running version", () => {
        deployedB();
        approve(A, "snapshot");
        const result = run(switchCommands(every, []), A, "rollback");
        expect(result.status, result.output).toBe(0);
        for (const part of ["db", "queue", "kafka", "sqlite"]) {
          expect(db(part)).toBe(`${part} rows of A\n`);
        }
        expect(db("mq")).toBe("mq rows of B\n");
        for (const file of FILES) {
          expect(read(`.snapshots/${B}/${file}`)).toBe(`${file.split(".")[0]} rows of B\n`);
        }
        const order = [
          "compose stop app",
          `${B}.partial:/snapshot:rw --entrypoint sh db `,
          "docker compose stop -t 120 kafka",
          `${A}:/snapshot:ro --entrypoint sh db `,
          "appendonly.aof.1.base.rdb",
          "kamal-proxy deploy shop-staging",
        ].map(callAt);
        expect(order).toEqual([...order].sort((x, y) => x - y));
        expect(order.every((index) => index > -1)).toBe(true);
      });

      it("puts every kind back when the restore fails", () => {
        deployedB();
        approve(A, "snapshot");
        const result = run(switchCommands(every, []), A, "rollback", { RESTORE_FAIL: A });
        expect(result.status).toBe(1);
        for (const part of PARTS) expect(db(part)).toBe(`${part} rows of B\n`);
        expect(result.output).toContain(
          "failed, so OpsCrew put the database back as it was before the rollback",
        );
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      });
    });

    describe("with snapshots off and no approval", () => {
      const prod = withProcesses(withPlan(testPlan(), { releaseCommand: "npm run migrate" }), {
        workers: [{ name: "worker", command: "node worker.js" }],
      });
      const off = withPlan(inEnvironment(prod, { name: "staging" }), {
        deploy: { snapshots: false },
      });

      it("deploys and rolls back as before: no one-off but the release, no hold of a rolling app", () => {
        for (const plan of [prod, off]) {
          /** A server where version A runs, as the fakes have it before any call. */
          const fresh = () => {
            for (const name of readdirSync(work)) {
              if (name !== "bin") rmSync(join(work, name), { recursive: true, force: true });
            }
            upload(plan);
            write(`${appsDir()}/${plan.app.name}/.env`, `APP_IMAGE=${image(A)}\n`);
          };
          fresh();
          const deployed = run(switchCommands(plan, []), B, "deploy");
          expect(deployed.status, deployed.output).toBe(0);
          const deployCalls = calls();
          fresh();
          const rolledBack = run(switchCommands(plan, []), B, "rollback");
          expect(rolledBack.status, rolledBack.output).toBe(0);
          // A rollback makes a deploy's calls without the release command.
          expect(calls()).toEqual(deployCalls.filter((call) => !call.endsWith("-T release")));
          for (const call of deployCalls) {
            expect(call).not.toMatch(
              / --entrypoint sh | compose stop | compose start |kamal-proxy pause/,
            );
          }
          expect(existsSync(`${appsDir()}/${plan.app.name}/.snapshots`)).toBe(false);
        }
      });
    });

    describe("with only one kind of data (US7)", () => {
      const sqliteOnly = withSqlite(
        withBuild(inEnvironment(withServices([]), { name: "staging" }), "generated-dockerfile"),
      );
      const valkeyOnly = inEnvironment(
        withServices([{ kind: "valkey", name: "queue", options: { mode: "queue" } }]),
        { name: "staging" },
      );
      for (const [label, plan, part, file] of [
        ["SQLite", sqliteOnly, "sqlite", "sqlite.tar"],
        ["Valkey", valkeyOnly, "queue", "queue.rdb"],
      ] as const) {
        it(`snapshots an app with only ${label} before its release, and a rollback restores it`, () => {
          upload(plan);
          write(at(".env"), `APP_IMAGE=${image(A)}\n`);
          setDb(`${part} rows of A\n`, part);
          const deployed = run(switchCommands(plan, []), B, "deploy");
          expect(deployed.status, deployed.output).toBe(0);
          expect(deployed.output).toContain(
            "OpsCrew took a snapshot of the data before this release",
          );
          expect(read(`.snapshots/${A}/${file}`)).toBe(`${part} rows of A\n`);
          expect(JSON.parse(read(`.snapshots/${A}/about.json`) ?? "")).toMatchObject({
            id: A,
            kind: "release",
            version: `sha256:${A}`,
            services: [{ name: part, kind: part === "sqlite" ? "sqlite" : "valkey", file }],
          });

          setDb(`${part} rows of B\n`, part);
          approve(A, "snapshot");
          const back = run(switchCommands(plan, []), A, "rollback");
          expect(back.status, back.output).toBe(0);
          expect(db(part)).toBe(`${part} rows of A\n`);
          // The copy just before the restore, under the version that ran.
          expect(read(`.snapshots/${B}/${file}`)).toBe(`${part} rows of B\n`);
          expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
          expect(paused()).toBe(false);
        });
      }
    });
  },
);

/** Whether bash runs here, as on GitHub's machines, for the steps of the workflow itself. */
const BASH_WORKS = (() => {
  try {
    return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
})();

/*
 * The workflow's own steps for a database on an extra server (US7, plan.md D7), in bash against
 * two fake servers: `ssh` runs what it is given with `sh` locally, the app's server's folders
 * under $WORK and the server data's under $WORK/data-host (/srv mapped there), and `scp` only logs.
 * Both servers share the fake `docker`, whose data are the files $WORK/db-<service>.
 */
describe.skipIf(!shWorks() || !BASH_WORKS)(
  "the release snapshot with a database on an extra server",
  { timeout: 120_000 },
  () => {
    const APP_HOST = "203.0.113.10";
    const DATA_HOST = "203.0.113.20";
    const base = splitPlan();
    const network = base.network as NonNullable<DeployPlan["network"]>;
    /** `shop` in staging with PostgreSQL `db` on the server `data` and nothing on its own server. */
    const plan = inEnvironment(
      DeployPlanSchema.parse({
        ...base,
        services: base.services.filter((service) => service.name === "db"),
        servers: (base.servers ?? []).filter((server) => server.name === "data"),
        network: {
          ...network,
          members: network.members.filter((member) => member.name !== "box-2"),
          devices: [],
          grants: [],
        },
      }),
      { name: "staging" },
    );
    const dataDir = () => `${work}/data-host/srv/apps/${APP}`;
    const onData = (name: string) => `${dataDir()}/${name}`;
    const readData = (name: string) =>
      existsSync(onData(name)) ? readFileSync(onData(name), "utf8") : undefined;

    type Step = { id?: string; name?: string; run?: string };
    const steps: Step[] = parse(renderWorkflow(plan, testContext()).content).jobs.deploy.steps;
    const script = (find: (step: Step) => boolean) => {
      const found = steps.find(find)?.run;
      if (found === undefined) throw new Error("The workflow has no such step.");
      return found;
    };
    const STEPS = {
      outgoing: script((step) => step.id === "outgoing"),
      data: script((step) => step.name === "Update the services on the server data"),
      others: script((step) => step.id === "others"),
      start: script((step) => step.id === "start"),
      rollback: script((step) => step.name?.startsWith("Roll back") === true),
      running: script(
        (step) => step.name === "Record the running version on the app's other servers",
      ),
    };

    const PRELUDE = [
      'export PATH="$(cd "$WORK/bin" && pwd):$PATH"',
      "ssh() {",
      '  while [[ "$1" != deploy@* ]]; do shift; done',
      '  local host="${1#deploy@}" root="$WORK"',
      "  shift",
      '  if [[ "$host" == "$DATA_HOST" ]]; then root="$WORK/data-host"; fi',
      '  echo "ssh $host $*" >> "$WORK/ssh.log"',
      '  if [[ "$1" == sh && "$2" == -s ]]; then',
      "    shift 2",
      '    if [[ "${1:-}" == -- ]]; then shift; fi',
      '    OPSCREW_APPS_DIR="$root/srv/apps" OPSCREW_EDGE_DIR="$root/srv/edge" sh -s -- "$@"',
      "  else",
      '    OPSCREW_APPS_DIR="$root/srv/apps" OPSCREW_EDGE_DIR="$root/srv/edge" sh -c "${*//\\/srv\\//$root/srv/}"',
      "  fi",
      "}",
      'scp() { echo "scp $*" >> "$WORK/scp.log"; }',
    ].join("\n");

    /** Runs a step's script in bash from a file, as GitHub Actions does; its outputs, by name. */
    function step(text: string, env: Record<string, string>) {
      const file = join(work, "step.sh");
      const outputs = join(work, "outputs");
      writeFileSync(file, `${PRELUDE}\n${text}`);
      rmSync(outputs, { force: true });
      mkdirSync(join(work, "repo"), { recursive: true });
      mkdirSync(join(work, "tmp"), { recursive: true });
      const result = spawnSync("bash", [file], {
        cwd: join(work, "repo"),
        env: {
          ...process.env,
          WORK: work,
          HOST: APP_HOST,
          DATA_HOST,
          SERVER_HOST_DATA: DATA_HOST,
          PRIVATE_ADDRESS: "10.200.4.2",
          GITHUB_ACTOR: "octocat",
          GITHUB_OUTPUT: outputs,
          RUNNER_TEMP: join(work, "tmp"),
          REGISTRY_TOKEN: "registry-token-placeholder",
          SECRET_ROW: "row-value-from-the-database",
          ...env,
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      const said = existsSync(outputs) ? readFileSync(outputs, "utf8") : "";
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        outputs: Object.fromEntries(
          said
            .split("\n")
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
        ),
      };
    }

    /** The one-time approval of restoring `hex`'s snapshot on the app's server and the server data. */
    const approveBoth = (hex: string, seconds = 1800) => {
      const line = `${rollbackApprovalLine(hex, "snapshot", Math.floor(Date.now() / 1000) + seconds)}\n`;
      write(at(ROLLBACK_APPROVAL_FILE), line);
      write(onData(ROLLBACK_APPROVAL_FILE), line);
    };

    /**
     * A deploy of `to` from the version that runs (`.env` on the app's server): the steps before the
     * upload, then the start step and the last one, each with the step's own variables.
     */
    function deploy(to: string, mode: "deploy" | "rollback", env: Record<string, string> = {}) {
      const outgoing = step(STEPS.outgoing, {});
      expect(outgoing.status, outgoing.output).toBe(0);
      const running = outgoing.outputs.image ?? "";
      const common = { IMAGE: image(to), RUNNING: running, MODE: mode, ...env };
      const data = step(STEPS.data, { ...common, HOST: DATA_HOST, OPSCREW_SERVICE_DB_ENV: "" });
      return { running, common, data };
    }

    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), "opscrew-extra-snapshots-")).replaceAll("\\", "/");
      fakeBin(work, { docker: FAKE_DOCKER, df: FAKE_DF, flock: FAKE_FLOCK, sleep: "#!/bin/sh" });
      upload(plan);
      write(at(".env"), `APP_IMAGE=${image(A)}\n`);
      // The server data's own snapshot script, as an earlier deploy uploaded it.
      write(onData("snapshot.sh"), `${snapshotScript(plan, "data").join("\n")}\n`);
      setDb("rows while A ran\n");
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    it("snapshots the server data under the running version before its services change, and records the new one there", () => {
      const { running, common, data } = deploy(B, "deploy");
      expect(running).toBe(image(A));
      expect(data.status, data.output).toBe(0);
      expect(data.output).toContain(
        "OpsCrew took a snapshot of the data on the server data before this release",
      );
      expect(readData(`.snapshots/${A}/db.dump`)).toBe("rows while A ran\n");
      expect(JSON.parse(readData(`.snapshots/${A}/about.json`) ?? "")).toMatchObject({
        id: A,
        kind: "release",
        version: `sha256:${A}`,
        services: [{ name: "db", kind: "postgres", file: "db.dump" }],
      });
      // The copy comes after the pull, and before the services start.
      expect(callAt(`${A}.partial:/snapshot:rw --entrypoint sh db `)).toBeGreaterThan(
        callAt("docker compose pull"),
      );
      expect(callAt(`${A}.partial:/snapshot:rw --entrypoint sh db `)).toBeLessThan(
        callAt("docker compose up -d --wait --remove-orphans"),
      );

      const start = step(STEPS.start, { ...common, RESTORED: "" });
      expect(start.status, start.output).toBe(0);
      expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      const recorded = step(STEPS.running, {});
      expect(recorded.status, recorded.output).toBe(0);
      expect(readData(RUNNING_FILE)).toBe(`${image(B)}\n`);
    });

    it("takes no snapshot on a first deploy, of the same version, or of a service with no container yet", () => {
      rmSync(at(".env"));
      expect(deploy(B, "deploy").data.status).toBe(0);
      write(at(".env"), `APP_IMAGE=${image(B)}\n`);
      expect(deploy(B, "deploy").data.status).toBe(0);
      expect(existsSync(onData(".snapshots"))).toBe(false);
      // A database new on the server has nothing to copy yet.
      const { data } = deploy(C, "deploy", { NO_CONTAINER: "db" });
      expect(data.status, data.output).toBe(0);
      expect(JSON.parse(readData(`.snapshots/${B}/about.json`) ?? "").services).toEqual([
        { name: "db", kind: "postgres", skipped: true },
      ]);
    });

    it("stops the deploy before anything changes when the copy fails, printing none of it", () => {
      const { data } = deploy(B, "deploy", { DUMP_FAIL: "db" });
      expect(data.status).toBe(1);
      expect(data.output).toContain(
        "::error::The snapshot of the data on the server data before this release failed, so the new version was not started and the previous version keeps serving.",
      );
      expect(data.output).not.toContain("row-value-from-the-database");
      expect(callAt("docker compose up -d --wait --remove-orphans")).toBe(-1);
    });

    it("refuses arguments it can't use before any change", () => {
      for (const env of [
        { IMAGE: "ghcr.io/acme/shop:latest" },
        { RUNNING: "x; rm -rf /" },
        { MODE: "other" },
      ]) {
        const result = step(STEPS.data, {
          IMAGE: image(B),
          RUNNING: image(A),
          MODE: "deploy",
          HOST: DATA_HOST,
          ...env,
        });
        expect(result.status).toBe(1);
        expect(result.output).toContain(
          "::error::The deploy step of the server data was given no image digests or mode it can use",
        );
      }
      expect(calls().join("\n")).not.toContain("compose pull");
    });

    describe("on a rollback with the snapshot", () => {
      /** B runs, with its rows, after a deploy that snapshotted A's on the server data. */
      const runningB = () => {
        const { common, data } = deploy(B, "deploy");
        expect(data.status, data.output).toBe(0);
        const start = step(STEPS.start, { ...common, RESTORED: "" });
        expect(start.status, start.output).toBe(0);
        setDb("rows of B\n");
        rmSync(`${work}/docker.log`);
      };

      it("holds the app, copies the server data's data under the running version, restores it, then switches", () => {
        runningB();
        approveBoth(A);
        const { common, data } = deploy(A, "rollback");
        expect(data.status, data.output).toBe(0);
        const others = step(STEPS.others, common);
        expect(others.status, others.output).toBe(0);
        expect(others.outputs.restored).toBe("data");
        expect(db()).toBe("rows while A ran\n");
        expect(readData(`.snapshots/${B}/db.dump`)).toBe("rows of B\n");
        // Both one-time approvals are used once: the server data's by its check, the app's next.
        expect(existsSync(onData(ROLLBACK_APPROVAL_FILE))).toBe(false);
        expect(callAt("compose stop app")).toBeLessThan(callAt(`${B}.partial:/snapshot:rw`));

        const start = step(STEPS.start, { ...common, RESTORED: others.outputs.restored ?? "" });
        expect(start.status, start.output).toBe(0);
        expect(read(".env")).toBe(`APP_IMAGE=${image(A)}\n`);
        expect(existsSync(at(ROLLBACK_APPROVAL_FILE))).toBe(false);
        expect(paused()).toBe(false);
        expect(step(STEPS.running, {}).status).toBe(0);
        expect(readData(RUNNING_FILE)).toBe(`${image(A)}\n`);
      });

      it("puts the data back and starts the app again when the restore there fails", () => {
        runningB();
        approveBoth(A);
        const { common } = deploy(A, "rollback");
        const others = step(STEPS.others, { ...common, RESTORE_FAIL: A });
        expect(others.status).toBe(1);
        expect(others.output).toContain(
          "::error::Restoring the snapshot on the server data failed, so OpsCrew put its data back as it was before the rollback.",
        );
        expect(others.output).not.toContain("row-value-from-the-database");
        expect(db()).toBe("rows of B\n");
        expect(callAt("compose start app")).toBeGreaterThan(callAt("compose stop app"));
        expect(paused()).toBe(false);
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      });

      it("puts the server data's data back when the earlier version fails, before the app's own rollback", () => {
        runningB();
        approveBoth(A);
        const { common } = deploy(A, "rollback");
        const others = step(STEPS.others, common);
        expect(others.status, others.output).toBe(0);
        const restored = others.outputs.restored ?? "";
        const start = step(STEPS.start, { ...common, RESTORED: restored });
        expect(start.status, start.output).toBe(0);
        // The check from outside failed: the rollback step takes over.
        const back = step(STEPS.rollback, { ...common, RESTORED: restored });
        expect(back.status, back.output).toBe(1);
        expect(back.output).toContain(
          "OpsCrew put the data on the server data back as it was before the rollback.",
        );
        expect(db()).toBe("rows of B\n");
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
        expect(paused()).toBe(false);
        expect(step(STEPS.running, {}).status).toBe(0);
        expect(readData(RUNNING_FILE)).toBe(`${image(B)}\n`);
      });

      it("changes nothing without the server data's approval, or with an expired one", () => {
        runningB();
        const { common } = deploy(A, "rollback");
        const none = step(STEPS.others, common);
        expect(none.status, none.output).toBe(0);
        expect(none.outputs.restored).toBeUndefined();
        expect(callAt("compose stop app")).toBe(-1);

        approveBoth(A, -60);
        const expired = step(STEPS.others, common);
        expect(expired.status).toBe(1);
        expect(expired.output).toContain(
          "::error::The one-time approval to restore the data on the server data on this rollback expired before the run started, so nothing was changed.",
        );
        expect(callAt("compose stop app")).toBe(-1);
        expect(db()).toBe("rows of B\n");
      });

      it("refuses the start step's database step without the app's server's own approval", () => {
        runningB();
        approveBoth(A);
        const { common } = deploy(A, "rollback");
        const others = step(STEPS.others, common);
        expect(others.status, others.output).toBe(0);
        rmSync(at(ROLLBACK_APPROVAL_FILE));
        const start = step(STEPS.start, { ...common, RESTORED: others.outputs.restored ?? "" });
        expect(start.status).toBe(1);
        expect(start.output).toContain(
          "but this server has no one-time approval to restore its own (.rollback-database), so nothing was changed here",
        );
        expect(read(".env")).toBe(`APP_IMAGE=${image(B)}\n`);
      });
    });
  },
);

describe("the scripts' database commands", () => {
  const four = snapshotFunctions(fourDatabases, "app", '"$APPS_DIR"/shop-staging');
  const line = (service: string, access: "rw" | "ro") =>
    four.find((l) => l.includes(` ${access} ${service} '`)) ?? "";

  it("dump each database with R9's commands, the password set inside the container", () => {
    expect(line("db", "rw")).toContain(
      `'umask 077 && export PGPASSWORD="$POSTGRES_PASSWORD" && pg_dump -h db -U app -Fc -f /snapshot/db.dump app'`,
    );
    expect(line("orders", "rw")).toContain(
      `'umask 077 && export MYSQL_PWD="$MYSQL_ROOT_PASSWORD" && mysqldump -h orders -u root --single-transaction --routines --events --triggers --no-tablespaces app > /snapshot/orders.dump'`,
    );
    expect(line("shopdb", "rw")).toContain(
      `'umask 077 && export MYSQL_PWD="$MARIADB_ROOT_PASSWORD" && mariadb-dump -h shopdb -u root --single-transaction --routines --events --triggers --no-tablespaces app > /snapshot/shopdb.dump'`,
    );
    expect(line("docs", "rw")).toContain(
      `mongodump --host docs --username app --authenticationDatabase admin --config /tmp/opscrew-mongo.yaml --db app --archive=/snapshot/docs.dump --gzip`,
    );
    expect(line("docs", "rw")).toContain(
      `printf "password: '\\''%s'\\''\\n" "$MONGO_INITDB_ROOT_PASSWORD" > /tmp/opscrew-mongo.yaml`,
    );
  });

  it("restore each exactly: the database made anew, then loaded", () => {
    expect(line("db", "ro")).toContain(
      `-d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS app WITH (FORCE)" -c "CREATE DATABASE app OWNER app" && pg_restore -h db -U app -d app --no-owner --single-transaction /snapshot/db.dump`,
    );
    expect(line("orders", "ro")).toContain(
      `mysql -h orders -u root -e "DROP DATABASE IF EXISTS app; CREATE DATABASE app" && mysql -h orders -u root app < /snapshot/orders.dump`,
    );
    expect(line("shopdb", "ro")).toContain(
      `mariadb -h shopdb -u root -e "DROP DATABASE IF EXISTS app; CREATE DATABASE app" && mariadb -h shopdb -u root app < /snapshot/shopdb.dump`,
    );
    expect(line("docs", "ro")).toContain(`c.getSiblingDB("app").dropDatabase()`);
    expect(line("docs", "ro")).toContain(
      `mongorestore --host docs --username app --authenticationDatabase admin --config /tmp/opscrew-mongo.yaml --nsInclude="app.*" --archive=/snapshot/docs.dump --gzip`,
    );
  });

  it("never put a password in an argument", () => {
    for (const l of four.filter((x) => x.includes("snapshot_run "))) {
      expect(l).not.toMatch(/\s(-p|--password)[\s=]|PASSWORD=[^"]/);
    }
  });

  it("are not in a plan without a database on the app's server", () => {
    expect(snapshotFunctions(testPlan({ postgres: false }), "app", '"$APPS_DIR"/shop')).toEqual([]);
  });
});

describe("the start script's database lines", () => {
  const script = (plan: DeployPlan) => switchCommands(plan, []).join("\n");

  it("take no snapshot and read no approval without data or down migrations", () => {
    const plain = testPlan({ postgres: false });
    for (const plan of [plain, inEnvironment(plain, { name: "staging" })]) {
      for (const text of [script(plan), rollbackCommands(plan).join("\n")]) {
        // Only an earlier schedule's crontab line goes.
        const lines = text.split("\n").filter((line) => !line.startsWith("if crontab -l "));
        expect(lines.join("\n")).not.toMatch(
          /snapshot|rollback-database|database\.changed|database=/,
        );
      }
    }
  });

  it("take the app's lock on this computer only where flock exists", () => {
    const site = { hostname: "shop.localhost" };
    const local = localhostPlan();
    expect(
      switchCommands(local, [], { originTls: false, additions: false, localhost: site }),
    ).toContain("if command -v flock > /dev/null 2>&1; then flock 7; fi");
    expect(rollbackCommands(local, site).join("\n")).toContain(
      "if command -v flock > /dev/null 2>&1; then flock -w 900 7 || { echo '::error::",
    );
  });

  it("switch once in a recreate app's database step, and twice otherwise", () => {
    const deploys = (plan: DeployPlan) =>
      switchCommands(plan, []).filter((l) => l.includes("kamal-proxy deploy")).length;
    expect(deploys(withPlan(staging, { deploy: { strategy: "recreate" } }))).toBe(1);
    expect(deploys(staging)).toBe(2);
  });

  it("keep the release command's line in a rollback that keeps the data", () => {
    const text = script(withPlan(staging, { releaseCommand: "npm run migrate" }));
    expect(text).toContain(
      `if [ "$database" = keep ]; then echo 'A rollback runs no release command: the data and the schema stay as they are.'; else echo 'A rollback runs no release command.'; fi`,
    );
  });

  it("read the approval on prod too, where snapshots are off unless deploy.snapshots is true", () => {
    const prod = DeployPlanSchema.parse({
      ...staging,
      environment: undefined,
      app: { ...staging.app, name: "shop" },
    });
    const deployStep = 'if [ "$MODE" = deploy ] && [ -n "$running" ]';
    expect(script(prod)).toContain(".rollback-database");
    expect(script(prod)).not.toContain(deployStep);
    expect(script(staging)).toContain(deployStep);
    expect(script(withPlan(prod, { deploy: { snapshots: true } }))).toContain(deployStep);
  });
});
