// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgeIdentity } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testContext } from "../__fixtures__/plans";
import { serviceSpec } from "../catalog";
import { withServices } from "../catalog/__fixtures__/plans";
import { localhostPlan } from "../edge/__fixtures__/localhost";
import { ageFunctions } from "../offsite";
import { IMAGES, TOOLS, toolDownloadUrl } from "../pins";
import { inEnvironment, ofApp, splitPlan, withProcesses, withSqlite } from "./__fixtures__/plans";
import { COMPOSE_PROLOGUE, fakeBin, runSh, shWorks, write } from "./__fixtures__/sh";
import { deploySecretNamesFor, renderWorkflow } from "./index";
import {
  OFFSITE_ENV_FILE,
  OFFSITE_ENV_SECRET,
  RESTORE_APPROVAL_FILE,
  RESTORE_STUCK,
  restoreApprovalLine,
  snapshotScript,
} from "./snapshot-script";
import { SNAPSHOT_FUNCTIONS, snapshotParts, snapshotScheduleLines } from "./snapshots";
import {
  appHoldCommands,
  HELD_ROLLBACK,
  rollbackCommands,
  serverCommands,
  switchCommands,
} from "./switch";

/** The running version's digest. */
const A = "a".repeat(64);
const image = (hex: string) => `ghcr.io/acme/shop@sha256:${hex}`;

/**
 * `shop` in staging on SQLite with a worker and one service of each way a snapshot copies:
 * PostgreSQL `db`, Valkey as a cache and a queue, Dragonfly as a queue (`dfq`) and a cache
 * (`dfc`), and the stop-only Kafka and RabbitMQ (`mq`).
 */
const BASE = withProcesses(
  withSqlite(
    inEnvironment(
      withServices([
        { kind: "postgres", name: "db" },
        { kind: "valkey", name: "cache" },
        { kind: "valkey", name: "queue", options: { mode: "queue" } },
        { kind: "dragonfly", name: "dfq", options: { mode: "queue" } },
        { kind: "dragonfly", name: "dfc" },
        { kind: "kafka", name: "kafka" },
        { kind: "rabbitmq", name: "mq" },
      ]),
      { name: "staging" },
    ),
  ),
  { workers: [{ name: "worker", command: "node worker.js" }] },
);
const APP = BASE.app.name;
const PARTS = ["db", "cache", "queue", "dfq", "dfc", "kafka", "mq", "sqlite"];
const ONLINE = ["db", "cache", "queue", "dfq", "dfc", "sqlite"];

/** `plan` with `deploy.snapshotStop` and `snapshots` set. */
function withSnapshots(
  plan: DeployPlan,
  o: { snapshotStop?: string[]; keepSnapshots?: number; snapshots?: DeployPlan["snapshots"] },
): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    deploy: {
      ...plan.deploy,
      ...(o.snapshotStop === undefined ? {} : { snapshotStop: o.snapshotStop }),
      ...(o.keepSnapshots === undefined ? {} : { keepSnapshots: o.keepSnapshots }),
    },
    ...(o.snapshots === undefined ? {} : { snapshots: o.snapshots }),
  });
}

/** A failed upload's error line in rclone's log, and its summary, as rclone 1.75 prints them. */
const RCLONE_ERROR =
  "2026/11/07 16:19:13 ERROR : about.json.age: Post request rcat error: operation error S3: PutObject, https response error StatusCode: 403, api error AccessDenied: Access Denied";
const RCLONE_FAILED =
  "2026/11/07 16:19:13 NOTICE: Failed to rcat with 2 errors: last error was: operation error S3: PutObject, https response error StatusCode: 403, api error AccessDenied: Access Denied";

/**
 * The fake `docker`: logs every call to $WORK/docker.log. Each part's data is the file
 * $WORK/data/<part>; a service runs while $WORK/running/<service> exists, and its container is
 * `c-<service>` (none when NO_CONTAINER names it). `compose stop` stops the named services (with
 * exit code 137 for those UNCLEAN names), `compose start` and `up` start them (`up` fails for
 * START_FAIL). One-offs play the copies and restores:
 * - `compose run … -v <folder>:/snapshot … <service> -c <script>`: a dump or `--rdb` copies the
 *   data to `<folder>/<file>` (failing for DUMP_FAIL), a restore copies the file back, Dragonfly's
 *   `SAVE RDB` keeps the data as `<service>.saved`, its `DFLY LOAD` loads `<service>.placed`;
 * - busybox with `--volumes-from c-<service>`: a tar or `cat` of the saved file to stdout, and
 *   every write from stdin into the data (`<service>.placed` for Dragonfly's cache), and with
 *   `-v <volume>:/data` the SQLite volume's restore;
 * - python with `-v <volume>:/data`: the SQLite volume's copy to stdout, or exit 3 when its data
 *   is empty.
 * A restore of content that matches the pattern RESTORE_FAIL fails and leaves `partial`. Failures
 * print SECRET_ROW, as a database's error can quote a row. kamal-proxy's `pause` and `resume` mark
 * $WORK/paused.
 *
 * The off-server copy's one-off (`run --rm --env-file <file> … -v <folder>:/snapshot:ro … -c
 * <script> sh <to> <file>...`) keeps its script in $WORK/upload.sh and "uploads" each file it is
 * given, then `about.json`, as `$WORK/bucket/<to>/<file>.age` (`age:` and the file), each logged in
 * $WORK/uploads.log, and notes in $WORK/upload-lock.log whether it holds the start lock (fd 7). A
 * script that deletes the id's about.json.age first has it removed. Without its env file it fails
 * as Docker does (125); with UPLOAD_FAIL it fails (after that deletion) printing the env file (the
 * bucket's key), then rclone's error and its summary as rclone prints them, and with DELETE_FAIL
 * it exits 4 after the upload.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'echo "docker $*" >> "$WORK/docker.log"',
  'case " $* " in *" --env-file "*)',
  '  envfile=""; snap=""; script=""; to=""; files=""; p1=""; n=0',
  '  for arg in "$@"; do',
  '    if [ "$n" -eq 2 ]; then to="$arg"; fi',
  '    if [ "$n" -gt 2 ]; then files="$files $arg"; fi',
  '    if [ "$n" -gt 0 ]; then n=$((n + 1)); fi',
  '    case "$p1" in',
  '      --env-file) envfile="$arg" ;;',
  '      -v) case "$arg" in *:/snapshot:ro) snap="${arg%:/snapshot:ro}" ;; esac ;;',
  '      -c) script="$arg"; n=1 ;;',
  "    esac",
  '    p1="$arg"',
  "  done",
  '  [ -f "$envfile" ] || { echo "docker: open $envfile: no such file or directory" >&2; exit 125; }',
  '  printf \'%s\\n\' "$script" > "$WORK/upload.sh"',
  '  if { true >&7; } 2> /dev/null; then echo held >> "$WORK/upload-lock.log"; else echo free >> "$WORK/upload-lock.log"; fi',
  '  case "$script" in *"rclone deletefile"*) rm -f "$WORK/bucket/$to/about.json.age" ;; esac',
  '  if [ -n "${UPLOAD_FAIL:-}" ]; then',
  '    echo "upload failed with $(cat "$envfile")" >&2',
  `    echo "${RCLONE_ERROR}" >&2`,
  `    echo "${RCLONE_FAILED}" >&2`,
  "    exit 1",
  "  fi",
  '  mkdir -p "$WORK/bucket/$to"',
  "  for f in $files about.json; do",
  '    { echo age:; cat "$snap/$f"; } > "$WORK/bucket/$to/$f.age"',
  '    echo "$to/$f.age" >> "$WORK/uploads.log"',
  "  done",
  '  if [ -n "${DELETE_FAIL:-}" ]; then exit 4; fi',
  "  exit 0 ;;",
  "esac",
  ...COMPOSE_PROLOGUE,
  'd="$WORK/data"',
  'mkdir -p "$d" "$WORK/running"',
  'dump_fail() { case " ${DUMP_FAIL:-} " in *" $1 "*) echo "copy failed at $SECRET_ROW" >&2; exit 1 ;; esac; }',
  'restore_fail() { if [ -n "${RESTORE_FAIL:-}" ] && grep -qE "$RESTORE_FAIL" "$1"; then echo partial > "$2"; echo "restore failed at $SECRET_ROW" >&2; exit 1; fi; }',
  'from_stdin() { cat > "$1.in"; restore_fail "$1.in" "$1"; mv "$1.in" "$1"; }',
  'case "$1 $2" in',
  '  "compose ps")',
  '    if [ "$3" = -aq ]; then',
  '      case " ${NO_CONTAINER:-} " in *" $last "*) ;; *) echo "c-$last" ;; esac',
  '    elif [ -f "$WORK/running/$last" ]; then echo "c-$last"; fi ;;',
  '  "compose stop")',
  '    for s in "$@"; do',
  '      case "$s" in compose | stop | -t | 120) continue ;; esac',
  '      if [ -f "$WORK/running/$s" ]; then',
  '        rm -f "$WORK/running/$s"',
  '        case " ${UNCLEAN:-} " in *" $s "*) echo 137 > "$WORK/exit-$s" ;; *) echo 0 > "$WORK/exit-$s" ;; esac',
  "      fi",
  "    done ;;",
  '  "compose start") for s in "$@"; do case "$s" in compose | start) ;; *) touch "$WORK/running/$s" ;; esac; done ;;',
  '  "compose up")',
  '    case " ${START_FAIL:-} " in *" $last "*) exit 1 ;; esac',
  '    touch "$WORK/running/$last" ;;',
  '  "inspect --format")',
  '    s="${last#c-}"',
  '    if [ -f "$WORK/running/$s" ]; then echo "running 0"; else echo "exited $(cat "$WORK/exit-$s" 2> /dev/null || echo 0)"; fi ;;',
  '  "volume inspect") [ -z "${NO_VOLUME:-}" ] ;;',
  '  "image inspect") if [ -n "${LOCAL_IMAGE_ID:-}" ]; then echo "sha256:$LOCAL_IMAGE_ID"; else exit 1; fi ;;',
  '  "compose run")',
  '    host=""; service=""; script=""; p1=""; p2=""',
  '    for arg in "$@"; do',
  '      if [ "$p1" = -v ]; then host="${arg%%:/snapshot*}"; fi',
  '      if [ "$p2" = --entrypoint ] && [ "$p1" = sh ]; then service="$arg"; fi',
  '      if [ "$p1" = -c ]; then script="$arg"; fi',
  '      p2="$p1"; p1="$arg"',
  "    done",
  "    file=\"$(printf '%s' \"$script\" | grep -o '/snapshot/[^ ]*' | head -n 1)\"",
  '    file="$host/${file#/snapshot/}"',
  '    case "$script" in',
  '      *"DFLY LOAD"*) restore_fail "$d/$service.placed" "$d/$service"; cp "$d/$service.placed" "$d/$service" ;;',
  '      *"SAVE RDB"*) dump_fail "$service"; cp "$d/$service" "$d/$service.saved" ;;',
  '      *pg_restore* | *mongorestore* | *"DROP DATABASE"*) restore_fail "$file" "$d/$service"; cp "$file" "$d/$service" ;;',
  '      *) dump_fail "$service"; cp "$d/$service" "$file" ;;',
  "    esac ;;",
  '  "run --rm")',
  '    service=""; script=""; p1=""',
  '    for arg in "$@"; do',
  '      if [ "$p1" = --volumes-from ]; then service="${arg%%:*}"; service="${service#c-}"; fi',
  '      if [ "$p1" = -v ]; then service=sqlite; fi',
  '      if [ "$p1" = -c ]; then script="$arg"; fi',
  '      p1="$arg"',
  "    done",
  '    case "$script" in',
  '      *"sys.stdout"*) dump_fail sqlite; if [ -s "$d/sqlite" ]; then cat "$d/sqlite"; else exit 3; fi ;;',
  '      *"-cf -"*) dump_fail "$service"; cat "$d/$service" ;;',
  '      *"cat > /data/opscrew-snapshot.rdb"*) cat > "$d/$service.placed" ;;',
  '      *"cat /data/opscrew-snapshot.rdb"*) cat "$d/$service.saved" ;;',
  '      *"rm -f /data/opscrew-snapshot.rdb"*) rm -f "$d/$service.saved" "$d/$service.placed" ;;',
  '      *"-xpf -"* | *"> /data/dump.rdb"* | *appendonlydir*) from_stdin "$d/$service" ;;',
  "    esac ;;",
  '  "compose exec")',
  '    if [ "$5 $6" = "kamal-proxy pause" ]; then touch "$WORK/paused"; fi',
  '    if [ "$5 $6" = "kamal-proxy resume" ]; then rm -f "$WORK/paused"; fi ;;',
  "esac",
].join("\n");

/** The fake `flock`: logs its call among docker's. */
const FAKE_FLOCK = ["#!/bin/sh", 'echo "flock $*" >> "$WORK/docker.log"'].join("\n");

/** The fake `df -Pk`: DISK_TOTAL_KB (default about 1 TB) with DISK_FREE_KB free (default half). */
const FAKE_DF = [
  "#!/bin/sh",
  'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
  'echo "/dev/sda1 ${DISK_TOTAL_KB:-1000000000} 0 ${DISK_FREE_KB:-500000000} 50% /"',
].join("\n");

/**
 * The fake `crontab`: the deploy user's table in $WORK/crontab; `-` replaces it once its input
 * ends, as cron's own does (logged).
 */
const FAKE_CRONTAB = [
  "#!/bin/sh",
  'if [ "$1" = -l ]; then',
  '  if [ -f "$WORK/crontab" ]; then cat "$WORK/crontab"; else echo "no crontab for deploy" >&2; exit 1; fi',
  "else",
  '  echo "crontab $*" >> "$WORK/docker.log"',
  '  cat > "$WORK/crontab.new" && mv "$WORK/crontab.new" "$WORK/crontab"',
  "fi",
].join("\n");

/** This system's `date`, which the fake one runs for everything but `+%s` with FAKE_NOW. */
const REAL_DATE = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout?.trim();
const FAKE_DATE = [
  "#!/bin/sh",
  'if [ "$1" = +%s ] && [ -n "${FAKE_NOW:-}" ]; then echo "$FAKE_NOW"; exit 0; fi',
  `exec ${REAL_DATE} "$@"`,
].join("\n");

let work = "";
const appsDir = () => `${work}/srv/apps`;
const appDir = (plan: DeployPlan = BASE) => `${appsDir()}/${plan.app.name}`;
const at = (name: string) => `${appDir()}/${name}`;
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
const data = (part: string) => read(`${work}/data/${part}`);
const calls = () => (read(`${work}/docker.log`) ?? "").split("\n").filter(Boolean);
const callAt = (text: string) => calls().findIndex((call) => call.includes(text));
const running = (service: string) => existsSync(`${work}/running/${service}`);
const snapshots = () =>
  existsSync(at(".snapshots"))
    ? readdirSync(at(".snapshots"))
        .filter((name) => !name.endsWith(".log"))
        .sort()
    : [];
const about = (id: string) => JSON.parse(read(at(`.snapshots/${id}/about.json`)) ?? "null");
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const windows = process.platform === "win32";

const ID = /^\d{8}T\d{6}Z$/;
const TAKEN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/**
 * The app's folder with `plan`'s snapshot script, `.env` naming A; every part holds `<part>
 * <content>`, and every service, the web and the worker run.
 */
function server(plan: DeployPlan = BASE, content = "rows of before"): void {
  write(`${appDir(plan)}/snapshot.sh`, `${snapshotScript(plan).join("\n")}\n`);
  write(`${appDir(plan)}/.env`, `APP_IMAGE=${image(A)}\n`);
  setData(content, plan);
  for (const service of [...PARTS, "app", "worker"]) write(`${work}/running/${service}`, "");
}

/** Every part's data: `<part> <content>`. */
function setData(content: string, plan: DeployPlan = BASE): void {
  for (const part of snapshotParts(plan))
    write(`${work}/data/${part.name}`, `${part.name} ${content}`);
}

/** `sh snapshot.sh <args>` in `plan`'s app folder on this computer, the fakes first on PATH. */
function snap(args: string[], env: Record<string, string> = {}, plan: DeployPlan = BASE) {
  const result = spawnSync(
    "sh",
    [
      "-c",
      'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh "$0" "$@"',
      `${appDir(plan)}/snapshot.sh`,
      ...args,
    ],
    {
      env: {
        ...process.env,
        WORK: work,
        OPSCREW_APPS_DIR: appsDir(),
        OPSCREW_EDGE_DIR: `${work}/srv/edge`,
        SECRET_ROW: "row-value-from-the-database",
        ...env,
      },
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

/** The one-time approval of restoring `id` (`only` one service), valid for `seconds` more. */
function approve(id: string, only?: string, seconds = 1800): void {
  const line = restoreApprovalLine(id, only, Math.floor(Date.now() / 1000) + seconds);
  write(at(RESTORE_APPROVAL_FILE), `${line}\n`);
}

describe.skipIf(!shWorks())("snapshot.sh", { timeout: 120_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-snapshot-script-")).replaceAll("\\", "/");
    fakeBin(work, {
      docker: FAKE_DOCKER,
      df: FAKE_DF,
      flock: FAKE_FLOCK,
      crontab: FAKE_CRONTAB,
      date: FAKE_DATE,
    });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  describe("take", () => {
    it("copies every part that runs, by hand, leaving the stop-only ones out, and prints its id", () => {
      server();
      const result = snap(["take", "manual"]);
      expect(result.status, result.output).toBe(0);
      const id = result.stdout;
      expect(id).toMatch(ID);
      expect(snapshots()).toEqual([id]);
      for (const part of ONLINE) {
        const file = snapshotParts(BASE).find((p) => p.name === part)?.file ?? "";
        expect(read(at(`.snapshots/${id}/${file}`))).toBe(`${part} rows of before`);
      }
      expect(existsSync(at(`.snapshots/${id}/kafka.tar`))).toBe(false);
      const json = about(id);
      expect(Object.keys(json)).toEqual(["id", "kind", "taken", "version", "services"]);
      expect(json).toMatchObject({ id, kind: "manual", version: `sha256:${A}` });
      expect(json.taken).toMatch(TAKEN);
      expect(read(at(`.snapshots/${id}/taken`))).toBe(`${json.taken}\n`);
      expect(json.services).toEqual(
        snapshotParts(BASE).map((part) =>
          part.online
            ? {
                name: part.name,
                kind: part.kind,
                file: part.file,
                size: `${part.name} rows of before`.length,
                // The image the service runs, as its Compose service pins it; none for SQLite.
                ...(part.image === undefined ? {} : { image: part.image }),
              }
            : { name: part.name, kind: part.kind, skipped: true },
        ),
      );
      expect(read(at(`.snapshots/${id}/about.json`))?.split("\n")).toHaveLength(2);
      expect(result.stderr).toContain(
        "kafka was left out: it must stop for its copy. Name it with --stop kafka to stop it for its copy.",
      );
      expect(result.stderr).toContain("mq was left out");
      // Nothing stops; a manual snapshot is taken in `<id>.taking`.
      expect(calls().filter((call) => call.includes("compose stop"))).toEqual([]);
      expect(callAt(`.snapshots/${id}.taking:/snapshot:rw --entrypoint sh db `)).toBeGreaterThan(
        -1,
      );
      expect(calls()[0]).toBe("flock 7");
      // Dragonfly's own saved file goes once copied.
      expect(existsSync(`${work}/data/dfq.saved`)).toBe(false);
      if (!windows) {
        expect(mode(at(".snapshots"))).toBe("700");
        expect(mode(at(`.snapshots/${id}`))).toBe("700");
        for (const name of readdirSync(at(`.snapshots/${id}`))) {
          expect(mode(at(`.snapshots/${id}/${name}`))).toBe("600");
        }
      }
    });

    it("stops a stop-only service named with --stop alone and cleanly for its copy, and --skip leaves one out", () => {
      server();
      const result = snap(["take", "manual", "--stop", "kafka", "--skip", "cache"]);
      expect(result.status, result.output).toBe(0);
      const id = result.stdout;
      expect(read(at(`.snapshots/${id}/kafka.tar`))).toBe("kafka rows of before");
      expect(existsSync(at(`.snapshots/${id}/cache.rdb`))).toBe(false);
      const entry = (name: string) =>
        about(id).services.find((s: { name: string }) => s.name === name);
      expect(entry("kafka")).toEqual({
        name: "kafka",
        kind: "kafka",
        file: "kafka.tar",
        size: 20,
        image: IMAGES.kafka.ref,
      });
      expect(entry("cache")).toEqual({ name: "cache", kind: "valkey", skipped: true });
      expect(entry("mq")).toEqual({ name: "mq", kind: "rabbitmq", skipped: true });
      const order = [
        "docker compose stop -t 120 kafka",
        "docker inspect --format {{.State.Status}} {{.State.ExitCode}} c-kafka",
        "--volumes-from c-kafka:ro",
        "docker compose up -d --no-deps --no-recreate --wait kafka",
      ].map(callAt);
      expect(order).toEqual([...order].sort((x, y) => x - y));
      expect(order[0]).toBeGreaterThan(-1);
      expect(calls().find((call) => call.includes("c-kafka:ro"))).toContain(
        "tar -C / -cf - var/lib/kafka/data etc/kafka/secrets mnt/shared/config",
      );
      expect(calls().filter((call) => call.includes("compose stop"))).toEqual([
        "docker compose stop -t 120 kafka",
      ]);
      expect(running("kafka")).toBe(true);
    });

    it("lists an empty SQLite volume as skipped", () => {
      server();
      write(`${work}/data/sqlite`, "");
      const result = snap(["take", "manual"]);
      expect(result.status, result.output).toBe(0);
      const id = result.stdout;
      expect(existsSync(at(`.snapshots/${id}/sqlite.tar`))).toBe(false);
      expect(about(id).services).toContainEqual({ name: "sqlite", kind: "sqlite", skipped: true });
    });

    it("takes one id across servers with --id, and the version from .running on an extra server or --version", () => {
      const plan = splitPlan();
      const data = (name: string) => `${appDir(plan)}/${name}`;
      write(data("snapshot.sh"), `${snapshotScript(plan, "data").join("\n")}\n`);
      for (const part of ["db", "docs"]) write(`${work}/data/${part}`, `${part} rows`);
      const B = "b".repeat(64);
      write(data(".running"), `ghcr.io/acme/shop@sha256:${B}\n`);
      const extra = (args: string[]) => snap(args, {}, plan);
      const ID = "20261106T120000Z";
      const manual = extra(["take", "manual", "--id", ID]);
      expect(manual.status, manual.output).toBe(0);
      expect(manual.stdout).toBe(ID);
      const json = JSON.parse(read(data(`.snapshots/${ID}/about.json`)) ?? "");
      expect(json).toMatchObject({ id: ID, kind: "manual", version: `sha256:${B}` });
      expect(extra(["take", "manual", "--id", ID]).stderr).toContain(
        `There is already a snapshot ${ID} on the server data.`,
      );
      // The version the CLI names wins, and a release snapshot is named by it.
      const release = extra(["take", "release", "--version", `sha256:${A}`]);
      expect(release.status, release.output).toBe(0);
      expect(release.stdout).toBe(A);
      expect(JSON.parse(read(data(`.snapshots/${A}/about.json`)) ?? "").version).toBe(
        `sha256:${A}`,
      );
      for (const [args, said] of [
        [["--version", A], "--version needs an image digest"],
        [["--version", `sha256:${A.slice(1)}X`], "--version needs an image digest"],
        [["--id", "../x"], "A snapshot's id has only letters and digits."],
      ] as const) {
        const refused = extra(["take", "manual", ...args]);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(said);
      }
      rmSync(data(".running"));
      expect(extra(["take", "release"]).stderr).toContain("no --version names one");
    });

    it("says how to start a stop-only service that did not start again after its copy", () => {
      server();
      const result = snap(["take", "manual", "--stop", "kafka"], { START_FAIL: "kafka" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `kafka did not start again after its copy. Its output is in ${appDir()}/.snapshots/snapshot.log; start it with docker compose up -d kafka in ${appDir()}.`,
      );
      expect(snapshots()).toEqual([]);
    });

    it("records a local build's image ID as the version, and none without one", () => {
      const local = "e".repeat(64);
      server();
      write(at(".env"), "APP_IMAGE=opscrew-local/shop:0123456789ab\n");
      const recorded = snap(["take", "manual"], { LOCAL_IMAGE_ID: local });
      expect(recorded.status, recorded.output).toBe(0);
      expect(about(recorded.stdout).version).toBe(`sha256:${local}`);
      const unknown = snap(["take", "manual"]);
      expect(unknown.status, unknown.output).toBe(0);
      expect(about(unknown.stdout).version).toBe("");
    });

    it("never replaces a snapshot taken by hand in the same second", () => {
      server();
      const first = snap(["take", "manual"]);
      const second = snap(["take", "manual"]);
      expect(second.status, second.output).toBe(0);
      expect(second.stdout).not.toBe(first.stdout);
      expect(snapshots()).toEqual([first.stdout, second.stdout].sort());
    });

    it("refuses --stop of a service copied while it runs, a service it doesn't have, and other arguments", () => {
      server();
      for (const [args, said] of [
        [["--stop", "db"], "db is copied while it runs, so it never stops: leave out --stop db."],
        [["--skip", "nope"], "nope is no service with data on the app's server."],
        [["--stop"], "Usage: sh snapshot.sh take"],
        [["--all"], "Usage: sh snapshot.sh take"],
      ] as const) {
        const result = snap(["take", "manual", ...args]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(said);
      }
      expect(snap(["take", "weekly"]).stderr).toContain("Usage:");
      expect(snapshots()).toEqual([]);
    });

    it("copies nothing of a stop-only service that did not stop cleanly, and starts it again", () => {
      server();
      const result = snap(["take", "manual", "--stop", "kafka"], { UNCLEAN: "kafka" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "kafka did not stop cleanly within 120 seconds (Docker killed it when the time ran out, or it ran out of memory), so OpsCrew did not copy its files.",
      );
      expect(result.stderr).toContain("The copy of kafka failed.");
      expect(result.stderr).toContain(
        `OpsCrew took no snapshot. The output of the copies stays on the server in ${appDir()}/.snapshots/snapshot.log`,
      );
      expect(callAt("c-kafka:ro")).toBe(-1);
      expect(running("kafka")).toBe(true);
      expect(snapshots()).toEqual([]);
    });

    it("leaves no snapshot when a copy fails, printing none of its output", () => {
      server();
      for (const part of ["db", "queue", "dfq", "sqlite", "kafka"]) {
        rmSync(at(".snapshots"), { recursive: true, force: true });
        const result = snap(["take", "manual", "--stop", "kafka"], { DUMP_FAIL: part });
        expect(result.status, part).toBe(1);
        expect(result.stderr).toContain(`The copy of ${part} failed.`);
        expect(result.output).not.toContain("row-value-from-the-database");
        expect(read(at(".snapshots/snapshot.log"))).toContain("row-value-from-the-database");
        expect(snapshots()).toEqual([]);
        expect(running("kafka")).toBe(true);
      }
    });

    it("takes nothing when the disk has less than 1 GiB or 10% free", () => {
      server();
      const result = snap(["take", "manual"], { DISK_TOTAL_KB: "5000000", DISK_FREE_KB: "900000" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        `The disk that holds ${appDir()} has less than 1 GiB or 10% free, so OpsCrew took no snapshot.`,
      );
      expect(snapshots()).toEqual([]);
    });

    it("takes a release snapshot under the running digest with deploy.snapshotStop's services, keeping deploy.keepSnapshots", () => {
      const plan = withSnapshots(BASE, { snapshotStop: ["kafka"], keepSnapshots: 2 });
      server(plan);
      for (const [hex, taken] of [
        ["1".repeat(64), "2020-11-01T10:00:00Z"],
        ["2".repeat(64), "2020-11-02T10:00:00Z"],
      ] as const) {
        write(at(`.snapshots/${hex}/taken`), `${taken}\n`);
      }
      write(at(".snapshots/20201101T100000Z/taken"), "2020-10-01T10:00:00Z\n");
      const result = snap(["take", "release"], {}, plan);
      expect(result.status, result.output).toBe(0);
      expect(result.stdout).toBe(A);
      expect(about(A)).toMatchObject({ id: A, kind: "release", version: `sha256:${A}` });
      expect(read(at(`.snapshots/${A}/kafka.tar`))).toBe("kafka rows of before");
      expect(result.stderr).toContain(
        "mq was left out of the snapshot before this release: it must stop for its copy. Name it in deploy.snapshotStop in opscrew/environments/staging/plan.yaml to copy it before each release.",
      );
      expect(callAt(`.snapshots/${A}.partial:/snapshot:rw`)).toBeGreaterThan(-1);
      // The newest two release snapshots stay; a snapshot by hand is never pruned.
      expect(snapshots()).toEqual(["2".repeat(64), "20201101T100000Z", A].sort());
    });

    it("refuses a release snapshot without a running digest", () => {
      server();
      write(at(".env"), "APP_IMAGE=opscrew-local/shop:latest\n");
      const result = snap(["take", "release"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "No version runs here by its image digest (the app's .env, or .running on an extra server), and no --version names one",
      );
    });

    it("takes a scheduled snapshot only in its hours, under the slot's id, with snapshots.schedule.stop, keeping snapshots.schedule.keep", () => {
      const plan = withSnapshots(BASE, {
        snapshots: { schedule: { every: "6h", keep: 2, stop: ["mq"] } },
      });
      server(plan);
      // 2026-11-06T18:00:00Z is a slot of every 6 hours (from the epoch, UTC); 19:00 isn't.
      const slot = Date.UTC(2026, 10, 6, 18) / 1000;
      const outside = snap(["take", "scheduled"], { FAKE_NOW: String(slot + 3600) }, plan);
      expect(outside.status, outside.output).toBe(0);
      expect(outside.output).toBe("");
      expect(snapshots()).toEqual([]);

      for (const [id, kind] of [
        ["20261105T000000Z", "scheduled"],
        ["20261105T060000Z", "scheduled"],
        ["20261104T000000Z", "manual"],
      ] as const) {
        write(at(`.snapshots/${id}/about.json`), `{"id":"${id}","kind":"${kind}"}\n`);
      }
      const result = snap(["take", "scheduled"], { FAKE_NOW: String(slot + 120) }, plan);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toBe("");
      const id = "20261106T180000Z";
      expect(read(at(".snapshots/scheduled.log"))).toContain(`${id}\n`);
      expect(read(at(".snapshots/scheduled.log"))).toContain(
        "kafka was left out of the scheduled snapshot",
      );
      expect(about(id)).toMatchObject({ id, kind: "scheduled" });
      expect(read(at(`.snapshots/${id}/mq.tar`))).toBe("mq rows of before");
      expect(callAt(`.snapshots/${id}.partial:/snapshot:rw`)).toBeGreaterThan(-1);
      expect(snapshots()).toEqual(["20261104T000000Z", "20261105T060000Z", id]);

      // The same slot again, as after a deploy held the lock past its tick: nothing more.
      rmSync(`${work}/docker.log`);
      const again = snap(["take", "scheduled"], { FAKE_NOW: String(slot + 900) }, plan);
      expect(again.status, again.output).toBe(0);
      expect(calls().filter((call) => !call.startsWith("flock"))).toEqual([]);
    });

    it("says scheduled snapshots are off without snapshots.schedule", () => {
      server();
      const result = snap(["take", "scheduled"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Scheduled snapshots are off");
    });
  });

  describe("restore", () => {
    /** A snapshot by hand of every part (Kafka and RabbitMQ stopped for it), then newer data. */
    const taken = () => {
      server();
      const result = snap(["take", "manual", "--stop", "kafka", "--stop", "mq"]);
      expect(result.status, result.output).toBe(0);
      setData("rows of now");
      rmSync(`${work}/docker.log`);
      return result.stdout;
    };

    it("refuses without its one-time approval, with one for another restore, or past its time", () => {
      const id = taken();
      const cases: [() => void, string][] = [
        [() => {}, "A restore needs its one-time approval on this server (.restore-snapshot)"],
        [() => approve("20250101T000000Z"), "is for another restore, so OpsCrew removed it"],
        [() => approve(id, "db"), "is for another restore"],
        [() => approve(id, undefined, -1), "expired before it started, so nothing was changed"],
        [() => approve(id, undefined, 100_000_000_000), "expired before it started"],
      ];
      for (const [arrange, said] of cases) {
        arrange();
        const result = snap(["restore", id]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(said);
        expect(existsSync(at(RESTORE_APPROVAL_FILE))).toBe(false);
      }
      expect(calls().filter((call) => !call.startsWith("flock"))).toEqual([]);
      for (const part of PARTS) expect(data(part)).toBe(`${part} rows of now`);
    });

    it("refuses a snapshot that is not complete, or without the service --only names", () => {
      const id = taken();
      approve(id, "nope");
      expect(snap(["restore", id, "--only", "nope"]).stderr).toContain("nope is no service");
      rmSync(at(`.snapshots/${id}/db.dump`));
      approve(id);
      const missing = snap(["restore", id]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`The snapshot ${id} is not complete on this server`);
      const other = snap(["take", "manual"]);
      approve(other.stdout, "kafka");
      const without = snap(["restore", other.stdout, "--only", "kafka"]);
      expect(without.status).toBe(1);
      expect(without.stderr).toContain(`The snapshot ${other.stdout} holds no copy of kafka`);
      expect(callAt("compose stop app")).toBe(-1);
    });

    it("restores every part exactly: requests held, the app stopped, the data copied first", () => {
      const id = taken();
      approve(id);
      const result = snap(["restore", id]);
      expect(result.status, result.output).toBe(0);
      for (const part of PARTS) expect(data(part)).toBe(`${part} rows of before`);
      expect(existsSync(at(RESTORE_APPROVAL_FILE))).toBe(false);
      const saved = snapshots().find((name) => name !== id) ?? "";
      expect(saved).toMatch(ID);
      expect(about(saved)).toMatchObject({ kind: "manual" });
      for (const part of snapshotParts(BASE)) {
        expect(read(at(`.snapshots/${saved}/${part.file}`))).toBe(`${part.name} rows of now`);
      }
      expect(result.stderr).toContain(
        `OpsCrew restored the snapshot ${id}. The data from just before the restore is the snapshot ${saved}.`,
      );
      // The copy from just before, named on stdout for opscrew restore.
      expect(result.stdout).toBe(`saved ${saved}`);
      const order = [
        "flock 7",
        "kamal-proxy pause shop-staging --drain-timeout 30s --max-pause 90s",
        "docker compose stop app worker",
        `.snapshots/${saved}.taking:/snapshot:rw --entrypoint sh db `,
        `.snapshots/${id}:/snapshot:ro --entrypoint sh db `,
        "docker compose start app",
        "kamal-proxy resume shop-staging",
      ].map(callAt);
      expect(order).toEqual([...order].sort((x, y) => x - y));
      expect(order.every((index) => index > -1)).toBe(true);
      // Each kind's restore: Valkey's cache placed and its file removed once loaded, the queue
      // as its append-only base, Dragonfly's queue as its only dump, its cache loaded running.
      expect(
        calls().find((call) => call.includes("c-cache:rw") && call.includes("dump.rdb")),
      ).toContain("cat > /data/dump.rdb");
      expect(callAt("rm -f /data/dump.rdb")).toBeGreaterThan(
        callAt("docker compose up -d --no-deps --no-recreate --wait cache"),
      );
      expect(callAt("appendonly.aof.1.base.rdb seq 1 type b")).toBeGreaterThan(
        callAt("docker compose stop -t 120 queue"),
      );
      expect(callAt("rm -f /data/dump* && cat > /data/dump.rdb")).toBeGreaterThan(
        callAt("docker compose stop -t 120 dfq"),
      );
      expect(callAt("DFLY LOAD opscrew-snapshot.rdb")).toBeGreaterThan(-1);
      expect(callAt("docker compose stop -t 120 dfc")).toBe(-1);
      expect(running("app")).toBe(true);
      expect(running("worker")).toBe(true);
      expect(existsSync(`${work}/paused`)).toBe(false);
      expect(result.output).not.toContain("row-value-from-the-database");
    });

    it("restores only the service --only names, copying only it first", () => {
      const id = taken();
      approve(id, "db");
      const result = snap(["restore", id, "--only", "db"]);
      expect(result.status, result.output).toBe(0);
      expect(data("db")).toBe("db rows of before");
      expect(data("cache")).toBe("cache rows of now");
      const saved = snapshots().find((name) => name !== id) ?? "";
      expect(readdirSync(at(`.snapshots/${saved}`)).sort()).toEqual([
        "about.json",
        "db.dump",
        "taken",
      ]);
    });

    it("puts the copy taken just before back when a restore fails, and starts the app", () => {
      const id = taken();
      approve(id);
      const result = snap(["restore", id], { RESTORE_FAIL: "kafka rows of before" });
      expect(result.status).toBe(1);
      for (const part of PARTS) expect(data(part)).toBe(`${part} rows of now`);
      const saved = snapshots().find((name) => name !== id) ?? "";
      expect(result.stderr).toContain(
        `Restoring the snapshot ${id} failed, so OpsCrew put the data back as it was before the restore (the snapshot ${saved}), and the app starts again: nothing changed. The output of the copies and restores stays on the server in ${appDir()}/.snapshots/snapshot.log`,
      );
      expect(result.output).not.toContain("row-value-from-the-database");
      expect(read(at(".snapshots/snapshot.log"))).toContain("row-value-from-the-database");
      expect(running("app")).toBe(true);
      expect(existsSync(`${work}/paused`)).toBe(false);
    });

    it("starts no app on data it could not put back", () => {
      const id = taken();
      approve(id);
      const result = snap(["restore", id], { RESTORE_FAIL: "db rows" });
      expect(result.status).toBe(RESTORE_STUCK);
      const saved = snapshots().find((name) => name !== id) ?? "";
      expect(result.stderr).toContain(
        `Restoring the snapshot ${id} failed, and putting the data back as it was before the restore failed too, so it may be partly changed, and the app was not started. The copy from just before the restore stays in ${appDir()}/.snapshots/${saved}: restore it with opscrew restore ${saved} once the cause is fixed.`,
      );
      expect(callAt("docker compose start app")).toBe(-1);
      expect(running("app")).toBe(false);
      expect(existsSync(`${work}/paused`)).toBe(false);
    });

    it("holds the app and resumes it, with no approval, and a restore while held never starts it", () => {
      const id = taken();
      const held = snap(["hold"]);
      expect(held.status, held.output).toBe(0);
      expect(existsSync(`${work}/paused`)).toBe(true);
      expect(existsSync(at(".snapshots/.held"))).toBe(true);
      expect(running("app")).toBe(false);
      expect(running("worker")).toBe(false);
      expect(calls()).toContain("docker compose stop app worker");

      approve(id);
      const restored = snap(["restore", id]);
      expect(restored.status, restored.output).toBe(0);
      // Held: the requests wait and the app stays stopped until resume.
      expect(callAt("docker compose start")).toBe(-1);
      expect(callAt("kamal-proxy resume")).toBe(-1);
      expect(existsSync(`${work}/paused`)).toBe(true);
      expect(running("app")).toBe(false);

      const resumed = snap(["resume"]);
      expect(resumed.status, resumed.output).toBe(0);
      // The workers that ran before the hold start again with the web.
      expect(calls()).toContain("docker compose start app worker");
      expect(running("app")).toBe(true);
      expect(running("worker")).toBe(true);
      expect(existsSync(`${work}/paused`)).toBe(false);
      expect(existsSync(at(".snapshots/.held"))).toBe(false);
      expect(snap(["hold", "now"]).stderr).toContain("Usage:");
    });

    it("refuses a deploy, a rollback dispatch and the rollback step while a restore holds the app, and runs them once resumed", () => {
      server();
      expect(snap(["hold"]).status).toBe(0);
      rmSync(`${work}/docker.log`);
      const env = {
        WORK: work,
        OPSCREW_APPS_DIR: appsDir(),
        OPSCREW_EDGE_DIR: `${work}/srv/edge`,
      };
      const next = image("b".repeat(64));
      const start = switchCommands(BASE, []);
      for (const mode of ["deploy", "rollback"]) {
        const refused = runSh(start, [next, mode], env);
        expect(refused.status).toBe(1);
        expect(refused.output).toContain(
          "OpsCrew changed nothing on the server: a restore holds the app (.snapshots/.held in its folder)",
        );
      }
      const back = runSh(rollbackCommands(BASE), [next], env);
      expect(back.status, back.output).toBe(0);
      expect(back.stdout).toBe("held");
      // The workflow's own hold of the app, for its other servers' data, neither.
      for (const step of [["hold", "1.1"], ["stop"], ["resume"]]) {
        const others = runSh(appHoldCommands(BASE), step, env);
        expect(others.status).toBe(1);
        expect(others.output).toContain("a restore holds the app");
      }
      expect(runSh(appHoldCommands(BASE), ["held", "1.1"], env).stdout).toBe("none");
      // Nothing ran but the locks and the start script's registry logout.
      expect(calls().filter((call) => !/^flock |^docker logout /.test(call))).toEqual([]);
      expect(read(at(".env"))).toBe(`APP_IMAGE=${image(A)}\n`);

      expect(snap(["resume"]).status).toBe(0);
      const resumed = runSh(start, [next, "deploy"], env);
      expect(resumed.output).not.toContain("a restore holds the app");
      expect(callAt("docker compose pull")).toBeGreaterThan(-1);
      expect(runSh(rollbackCommands(BASE), [next], env).stdout).not.toBe("held");
    });

    it("lets no request through and starts no app while held, when a restore fails and its data goes back", () => {
      const id = taken();
      expect(snap(["hold"]).status).toBe(0);
      approve(id);
      const result = snap(["restore", id], { RESTORE_FAIL: "kafka rows of before" });
      expect(result.status).toBe(1);
      for (const part of PARTS) expect(data(part)).toBe(`${part} rows of now`);
      expect(result.stderr).toContain(
        ", and the app stays stopped while opscrew restore holds it: nothing changed.",
      );
      expect(callAt("docker compose start")).toBe(-1);
      expect(callAt("kamal-proxy resume")).toBe(-1);
      expect(existsSync(`${work}/paused`)).toBe(true);
      expect(running("app")).toBe(false);
    });

    it("holds and resumes the app on its server when only extra servers hold data (D13)", () => {
      const plan = extraOnly();
      write(`${appDir(plan)}/snapshot.sh`, `${snapshotScript(plan).join("\n")}\n`);
      for (const service of ["app"]) write(`${work}/running/${service}`, "");
      const held = snap(["hold"], {}, plan);
      expect(held.status, held.output).toBe(0);
      expect(existsSync(`${work}/paused`)).toBe(true);
      expect(running("app")).toBe(false);
      expect(calls()[0]).toBe("flock 7");
      const resumed = snap(["resume"], {}, plan);
      expect(resumed.status, resumed.output).toBe(0);
      expect(running("app")).toBe(true);
      expect(existsSync(`${work}/paused`)).toBe(false);
      for (const other of [["take", "manual"], ["list"], ["hold", "now"]]) {
        const refused = snap(other, {}, plan);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("Usage: sh snapshot.sh hold | resume");
      }
    });

    it("changes nothing when the data can't be copied first", () => {
      const id = taken();
      approve(id);
      const result = snap(["restore", id], { DUMP_FAIL: "queue" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "OpsCrew could not copy the current data before the restore, so nothing was changed.",
      );
      for (const part of PARTS) expect(data(part)).toBe(`${part} rows of now`);
      expect(callAt(`.snapshots/${id}:/snapshot:ro`)).toBe(-1);
      expect(running("app")).toBe(true);
    });
  });

  describe("list, delete and offsite", () => {
    it("lists each snapshot's about.json, deletes one by id, and refuses anything else", () => {
      server();
      const first = snap(["take", "manual"]).stdout;
      write(at(".snapshots/20251231T000000Z/about.json"), '{"id":"20251231T000000Z"}\n');
      // Snapshots being taken are not listed.
      write(at(".snapshots/20251230T000000Z.partial/about.json"), '{"id":"partial"}\n');
      write(at(".snapshots/20251230T000000Z.taking/about.json"), '{"id":"taking"}\n');
      rmSync(`${work}/docker.log`);
      const list = snap(["list"]);
      expect(list.status).toBe(0);
      expect(list.stdout.split("\n").map((line) => JSON.parse(line).id)).toEqual([
        "20251231T000000Z",
        first,
      ]);
      expect(calls()).toEqual([]);

      expect(snap(["delete", "20251231T000000Z"]).status).toBe(0);
      rmSync(at(".snapshots/20251230T000000Z.partial"), { recursive: true });
      rmSync(at(".snapshots/20251230T000000Z.taking"), { recursive: true });
      expect(snapshots()).toEqual([first]);
      const missing = snap(["delete", "20251231T000000Z"]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(
        "There is no snapshot 20251231T000000Z on the app's server.",
      );
      for (const id of ["..", "../shop", ""]) {
        const result = snap(["delete", id]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("A snapshot's id has only letters and digits.");
      }
      expect(snapshots()).toEqual([first]);
      // Without the off-server copy there is nothing to copy.
      rmSync(`${work}/docker.log`, { force: true });
      expect(snap(["offsite", first]).status).toBe(0);
      expect(calls()).toEqual([]);
      expect(snap(["nothing"]).stderr).toContain("Usage: sh snapshot.sh take");
    });
  });

  describe("offsite", () => {
    const r2 = withSnapshots(BASE, {
      snapshots: { offsite: { provider: "r2", bucket: "shop-staging-backups" } },
    });
    const spaces = withSnapshots(BASE, {
      snapshots: {
        offsite: { provider: "digitalocean", bucket: "shop-staging-backups", region: "fra1" },
      },
    });
    const hetzner = withSnapshots(BASE, {
      snapshots: {
        offsite: { provider: "hetzner", bucket: "shop-staging-backups", region: "fsn1", days: 30 },
      },
    });
    /** The bucket's made-up key and recipient, which only the env file holds. */
    let secrets: string[] = [];

    /** `plan`'s server with {@link OFFSITE_ENV_FILE} (mode 600) holding a made-up key. */
    function offsiteServer(plan: DeployPlan): void {
      server(plan);
      secrets = [
        fakeSecret("aws-access-key-id", "offsite"),
        fakeSecret("aws-secret-access-key", "offsite"),
      ];
      const lines = [
        `OPSCREW_OFFSITE_ENDPOINT=https://${randomBytes(16).toString("hex")}.r2.cloudflarestorage.com`,
        `OPSCREW_OFFSITE_ACCESS_KEY_ID=${secrets[0]}`,
        `OPSCREW_OFFSITE_SECRET_ACCESS_KEY=${secrets[1]}`,
        `OPSCREW_OFFSITE_RECIPIENT=${generateAgeIdentity().recipient}`,
      ];
      write(at(OFFSITE_ENV_FILE), `${lines.join("\n")}\n`);
      if (!windows) chmodSync(at(OFFSITE_ENV_FILE), 0o600);
    }
    const uploads = () => (read(`${work}/uploads.log`) ?? "").split("\n").filter(Boolean);
    const uploaded = (path: string) => read(`${work}/bucket/${path}`);
    const script = () => read(`${work}/upload.sh`) ?? "";
    /** Whether fd 7, the start lock, was open in each upload's one-off. */
    const lockDuringUploads = () =>
      (read(`${work}/upload-lock.log`) ?? "").split("\n").filter(Boolean);
    const uploadCalls = () => calls().filter((call) => call.includes("--env-file"));
    const files = (id: string) =>
      (about(id).services as { file?: string }[]).flatMap((s) => (s.file ? [s.file] : []));
    const expectNoSecret = (...texts: string[]) => {
      for (const text of [...texts, calls().join("\n")]) {
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    };
    /** A complete snapshot `id` of `kind`, taken at `taken`, holding the database's dump. */
    const stored = (id: string, kind: string, taken: string) => {
      write(at(`.snapshots/${id}/db.dump`), `db of ${id}`);
      write(at(`.snapshots/${id}/taken`), `${taken}\n`);
      const services = [{ name: "db", kind: "postgres", file: "db.dump", size: 1 }];
      write(
        at(`.snapshots/${id}/about.json`),
        `${JSON.stringify({ id, kind, taken, version: `sha256:${A}`, services })}\n`,
      );
    };
    /** A complete snapshot `id` whose every part was left out. */
    const emptySnapshot = (id: string) => {
      write(at(`.snapshots/${id}/taken`), `${iso(new Date())}\n`);
      const services = [{ name: "db", kind: "postgres", skipped: true }];
      write(
        at(`.snapshots/${id}/about.json`),
        `${JSON.stringify({ id, kind: "manual", services })}\n`,
      );
    };
    const iso = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

    it("streams each file through the checked age into rclone, about.json last, then marks it", () => {
      offsiteServer(r2);
      const id = "20261106T120000Z";
      stored(id, "manual", iso(new Date()));
      const result = snap(["offsite", id]);
      expect(result.status, result.output).toBe(0);
      expect(uploads()).toEqual([...files(id), "about.json"].map((file) => `${id}/${file}.age`));
      for (const file of [...files(id), "about.json"]) {
        expect(uploaded(`${id}/${file}.age`)).toBe(`age:\n${read(at(`.snapshots/${id}/${file}`))}`);
      }
      expect(existsSync(at(`.snapshots/${id}/offsite.done`))).toBe(true);
      if (!windows) expect(mode(at(`.snapshots/${id}/offsite.done`))).toBe("600");
      // The key reaches the one-off only through its env file, the snapshot read-only, and the
      // region is the plan's.
      const [call] = calls();
      expect(call).toContain(`docker run --rm --env-file ${OFFSITE_ENV_FILE} `);
      expect(call).toContain("-e RCLONE_CONFIG_OFFSITE_PROVIDER=Cloudflare");
      expect(call).toContain("-e RCLONE_CONFIG_OFFSITE_REGION=auto");
      expect(call).toContain(`${appDir()}/.snapshots/${id}:/snapshot:ro`);
      expect(call).toContain(`${appDir()}/.offsite:/tools`);
      expect(call).toContain(IMAGES.rclone.ref);
      expect(calls()).toHaveLength(1);
      expectNoSecret(result.output);
      // The pinned age, fetched through rclone and checked before it is kept and before each use.
      const text = script();
      for (const line of ageFunctions("amd64")) expect(text).toContain(line);
      expect(text).toContain(`rclone copyurl '${toolDownloadUrl("age", "amd64")}'`);
      expect(text).toContain(`echo '${TOOLS.age.sha256.amd64}  /tmp/age/age.tar.gz'`);
      expect(text).toContain("age_ok || age_fetch || {");
      // The id's about.json goes before any file: a copy that fails part-way never looks complete.
      const removed = text.indexOf(
        `rclone deletefile 'offsite:shop-staging-backups/backups/'"$to/about.json.age" || [ "$?" -eq 4 ] || exit 1`,
      );
      const loop = text.indexOf(
        `/tools/age -r "$OPSCREW_OFFSITE_RECIPIENT" < /snapshot/"$f" | rclone rcat 'offsite:shop-staging-backups/backups/'"$to/$f.age" || exit 1`,
      );
      expect(removed).toBeGreaterThan(-1);
      expect(removed).toBeLessThan(loop);
      expect(text).toContain("set -o pipefail");
      // R2 expires the copies itself.
      expect(text).not.toContain("rclone delete ");
    });

    it("leaves no about.json.age when a copy of an id copied before fails part-way", () => {
      offsiteServer(r2);
      const id = "20261106T120000Z";
      stored(id, "manual", iso(new Date()));
      expect(snap(["offsite", id]).status).toBe(0);
      expect(uploaded(`${id}/about.json.age`)).toBeDefined();
      const failed = snap(["offsite", id], { UPLOAD_FAIL: "1" });
      expect(failed.status).toBe(1);
      expect(uploaded(`${id}/about.json.age`)).toBeUndefined();
      expect(existsSync(at(`.snapshots/${id}/offsite.done`))).toBe(false);
    });

    it("copies a snapshot by hand off the server once the start lock is free, and a failed copy only warns", () => {
      offsiteServer(r2);
      const taken = snap(["take", "manual"]);
      expect(taken.status, taken.output).toBe(0);
      expect(taken.stdout).toMatch(ID);
      expect(uploads().at(-1)).toBe(`${taken.stdout}/about.json.age`);
      expect(existsSync(at(`.snapshots/${taken.stdout}/offsite.done`))).toBe(true);
      // The upload's one-off ran after the take, without the start lock.
      expect(lockDuringUploads()).toEqual(["free"]);
      expect(calls().indexOf(uploadCalls()[0] ?? "")).toBeGreaterThan(callAt("flock 7"));

      const failed = snap(["take", "manual"], { UPLOAD_FAIL: "1" });
      expect(failed.status, failed.output).toBe(0);
      expect(failed.stdout).toMatch(ID);
      expect(failed.stderr).toContain(
        `Copying the snapshot ${failed.stdout} off the server failed, so the bucket has no complete copy of it yet; the snapshot itself stays on the app's server, and the next snapshot tries again. The upload's output is in ${appDir()}/.snapshots/offsite.log; its last error: ${RCLONE_FAILED}`,
      );
      expect(existsSync(at(`.snapshots/${failed.stdout}/offsite.done`))).toBe(false);
      // The rest of the output went to the log alone.
      expect(failed.stderr).not.toContain("upload failed with");
      expect(read(at(".snapshots/offsite.log"))).toContain("upload failed with");
      expect(read(at(".snapshots/offsite.log"))).toContain(RCLONE_ERROR);
      expectNoSecret(taken.output, failed.output);
    });

    it("tries the copies not made yet again at each snapshot, newest first, within the retention", () => {
      offsiteServer(hetzner);
      const now = Date.now();
      // Not copied yet: one by hand and one scheduled, within the 30 days.
      stored("20261101T000000Z", "manual", iso(new Date(now - 5 * 86_400_000)));
      stored("20261102T000000Z", "scheduled", iso(new Date(now - 4 * 86_400_000)));
      // Copied already, older than the retention, before a release, or holding no file.
      stored("20261103T000000Z", "manual", iso(new Date(now - 3 * 86_400_000)));
      write(at(".snapshots/20261103T000000Z/offsite.done"), "");
      stored("20250101T000000Z", "manual", iso(new Date(now - 60 * 86_400_000)));
      stored(A, "release", iso(new Date(now - 86_400_000)));
      emptySnapshot("20261104T000000Z");
      const taken = snap(["take", "manual"]);
      expect(taken.status, taken.output).toBe(0);
      expect(
        uploads()
          .filter((path) => path.endsWith("/about.json.age"))
          .map((path) => path.split("/")[0]),
      ).toEqual([taken.stdout, "20261102T000000Z", "20261101T000000Z"]);
      for (const id of [taken.stdout, "20261101T000000Z", "20261102T000000Z"]) {
        expect(existsSync(at(`.snapshots/${id}/offsite.done`))).toBe(true);
      }
      for (const id of ["20250101T000000Z", A, "20261104T000000Z"]) {
        expect(existsSync(at(`.snapshots/${id}/offsite.done`))).toBe(false);
      }
      expect(lockDuringUploads().every((state) => state === "free")).toBe(true);
    });

    it("never copies a snapshot before a release, neither in the deploy nor by take release", () => {
      offsiteServer(r2);
      stored("20261101T000000Z", "manual", iso(new Date()));
      const release = snap(["take", "release"]);
      expect(release.status, release.output).toBe(0);
      expect(release.stdout).toBe(A);
      expect(uploadCalls()).toEqual([]);
      const deploy = runSh(
        [`cd "$OPSCREW_APPS_DIR"/${APP}`, SNAPSHOT_FUNCTIONS, "snapshot_cmd_take release"],
        [],
        { WORK: work, OPSCREW_APPS_DIR: appsDir() },
      );
      expect(deploy.status, deploy.output).toBe(0);
      expect(uploadCalls()).toEqual([]);
    });

    it("copies nothing without the env file, a complete snapshot, or a file in it", () => {
      offsiteServer(r2);
      const id = "20261106T120000Z";
      stored(id, "manual", iso(new Date()));
      rmSync(at(OFFSITE_ENV_FILE));
      const missing = snap(["offsite", id]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(
        `The off-server copy is on, but the app's server has no offsite.env with its bucket's key yet, so the snapshot ${id} was not copied off the server. Run opscrew provision, then deploy again.`,
      );
      offsiteServer(r2);
      const incomplete = snap(["offsite", "20251231T000000Z"]);
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr).toContain(
        "The snapshot 20251231T000000Z is not complete on the app's server, so it was not copied off the server.",
      );
      emptySnapshot("20261104T000000Z");
      const empty = snap(["offsite", "20261104T000000Z"]);
      expect(empty.status, empty.output).toBe(0);
      expect(empty.stderr).toContain(
        "The snapshot 20261104T000000Z holds no copy of any service on the app's server, so there is nothing to copy off the server.",
      );
      expect(uploadCalls()).toEqual([]);
      expect(snap(["offsite", "../x"]).stderr).toContain(
        "A snapshot's id has only letters and digits.",
      );
    });

    it("deletes the copies older than the retention itself on Spaces, whose bucket expires none", () => {
      offsiteServer(spaces);
      const result = snap(["take", "manual"]);
      expect(result.status, result.output).toBe(0);
      expect(script()).toContain(
        "rclone delete --min-age 90d 'offsite:shop-staging-backups/backups' || exit 4",
      );
      expect(uploadCalls()[0]).toContain("-e RCLONE_CONFIG_OFFSITE_PROVIDER=DigitalOcean");
      expect(uploadCalls()[0]).toContain("-e RCLONE_CONFIG_OFFSITE_REGION=fra1");
      const kept = snap(["offsite", result.stdout], { DELETE_FAIL: "1" });
      expect(kept.status, kept.output).toBe(0);
      expect(kept.stderr).toContain(
        `OpsCrew copied the snapshot ${result.stdout} off the server, but could not delete the copies there older than 90 days. The upload's output is in ${appDir()}/.snapshots/offsite.log.`,
      );
      expect(existsSync(at(`.snapshots/${result.stdout}/offsite.done`))).toBe(true);
    });

    it("gives Hetzner the plan's region, and an extra server's parts a folder of their own", () => {
      offsiteServer(hetzner);
      expect(snap(["take", "manual"]).status).toBe(0);
      expect(uploadCalls()[0]).toContain("-e RCLONE_CONFIG_OFFSITE_PROVIDER=Hetzner");
      expect(uploadCalls()[0]).toContain("-e RCLONE_CONFIG_OFFSITE_REGION=fsn1");
      expect(script()).not.toContain("rclone delete ");
      const split = withSnapshots(splitPlan(), {
        snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
      });
      const text = snapshotScript(split, "data").join("\n");
      expect(text).toContain(`sh "$1"/data $_offsite_files`);
      expect(snapshotScript(split).join("\n")).toContain(`sh "$1" $_offsite_files`);
    });
  });

  it("gives the start and rollback scripts its functions alone, running nothing", () => {
    server();
    const result = runSh(
      [
        `cd "$OPSCREW_APPS_DIR"/${APP}`,
        SNAPSHOT_FUNCTIONS,
        "for f in snapshot_take snapshot_restore snapshot_cmd_take; do command -v $f > /dev/null; done",
        "echo defined",
      ],
      ["take", "manual"],
      { WORK: work, OPSCREW_APPS_DIR: appsDir() },
    );
    expect(result.status, result.output).toBe(0);
    expect(result.stdout).toBe("defined");
    expect(calls()).toEqual([]);
  });

  describe("the schedule's crontab line", () => {
    const scheduled = withSnapshots(BASE, { snapshots: { schedule: { every: "daily" } } });
    const lines = (plan: DeployPlan, server = "app") => [
      `APPS_DIR=${appsDir()}`,
      ...snapshotScheduleLines(plan, server),
    ];
    const line = () =>
      `0 * * * * sh ${appsDir()}/${APP}/snapshot.sh take scheduled > /dev/null 2>&1 # opscrew-snapshots ${APP}`;
    const env = () => ({ WORK: work });

    it("writes the deploy user's line once, keeping the others, and removes it when the schedule is off", () => {
      write(`${work}/crontab`, "15 3 * * * /home/deploy/own-job\n");
      for (let i = 0; i < 2; i++) {
        const result = runSh(lines(scheduled), [], env());
        expect(result.status, result.output).toBe(0);
      }
      expect(read(`${work}/crontab`)).toBe(`15 3 * * * /home/deploy/own-job\n${line()}\n`);
      const off = runSh(lines(BASE), [], env());
      expect(off.status, off.output).toBe(0);
      expect(read(`${work}/crontab`)).toBe("15 3 * * * /home/deploy/own-job\n");
      // Without the app's line nothing is written.
      rmSync(`${work}/docker.log`, { force: true });
      expect(runSh(lines(BASE), [], env()).status).toBe(0);
      expect(calls()).toEqual([]);
    });

    it("never touches the line of another app whose name starts with this one's", () => {
      const daily = { snapshots: { schedule: { every: "daily" as const } } };
      const shop = withSnapshots(withServices([{ kind: "postgres", name: "db" }]), daily);
      const admin = ofApp(shop, "shop-admin");
      const lineOf = (app: string) =>
        `0 * * * * sh ${appsDir()}/${app}/snapshot.sh take scheduled > /dev/null 2>&1 # opscrew-snapshots ${app}`;
      const deploy = (plan: DeployPlan) => {
        const result = runSh(lines(plan), [], env());
        expect(result.status, result.output).toBe(0);
      };
      deploy(shop);
      deploy(admin);
      expect(read(`${work}/crontab`)).toBe(`${lineOf("shop")}\n${lineOf("shop-admin")}\n`);
      deploy(shop);
      expect(read(`${work}/crontab`)).toBe(`${lineOf("shop-admin")}\n${lineOf("shop")}\n`);
      // Off for shop: only its own line goes, and then shop's deploy writes nothing.
      const off = withServices([{ kind: "postgres", name: "db" }]);
      deploy(off);
      expect(read(`${work}/crontab`)).toBe(`${lineOf("shop-admin")}\n`);
      rmSync(`${work}/docker.log`, { force: true });
      deploy(off);
      expect(calls()).toEqual([]);
      deploy(ofApp(off, "shop-admin"));
      expect(read(`${work}/crontab`)).toBe("");
    });

    it("stops the deploy on a server without crontab while a schedule is on", () => {
      rmSync(`${work}/bin/crontab`);
      // Only the fakes, without crontab, on PATH.
      const script = ['PATH="$(cd "$WORK/bin" && pwd)"', ...lines(scheduled)];
      const result = runSh(script, [], env());
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        "::error::This server has no crontab, which runs the scheduled snapshots (snapshots.schedule in opscrew/environments/staging/plan.yaml).",
      );
    });
  });
});

describe("the script's text", () => {
  /** Whether `sh -n` reads `lines` without a syntax error. */
  const parses = (lines: readonly string[]) =>
    spawnSync("sh", ["-n"], { input: `${lines.join("\n")}\n`, encoding: "utf8" }).status === 0;

  it.skipIf(!shWorks())("is POSIX sh for every target and server", () => {
    const sqliteOnly = withSqlite(inEnvironment(withServices([]), { name: "staging" }));
    for (const script of [
      snapshotScript(BASE),
      snapshotScript(splitPlan(), "data"),
      snapshotScript(splitPlan(), "box-2"),
      snapshotScript(localhostPlan()),
      snapshotScript(sqliteOnly),
      snapshotScript(
        withSnapshots(BASE, {
          snapshots: { offsite: { provider: "hetzner", bucket: "shop-backups", region: "fsn1" } },
        }),
      ),
    ]) {
      expect(script.length).toBeGreaterThan(0);
      expect(parses(script)).toBe(true);
    }
  });

  it("has one line per element, as the deploy's YAML embeds it", () => {
    for (const line of snapshotScript(BASE)) expect(line).not.toContain("\n");
    const offsite = withSnapshots(BASE, {
      snapshots: { offsite: { provider: "digitalocean", bucket: "shop-backups", region: "fra1" } },
    });
    for (const line of snapshotScript(offsite)) expect(line).not.toContain("\n");
  });

  it("copies nothing off the server and runs no rclone without the off-server copy", () => {
    const script = snapshotScript(BASE).join("\n");
    expect(script).not.toMatch(/snapshot_offsite|rclone|offsite\.env|\/\.offsite/);
  });

  it("is none on a server without data", () => {
    const plain = inEnvironment(withServices([]), { name: "staging" });
    expect(snapshotScript(plain)).toEqual([]);
    expect(snapshotScript(splitPlan(), "missing")).toEqual([]);
  });

  it("has only hold and resume on the app's server when only extra servers hold data (D13)", () => {
    const script = snapshotScript(extraOnly());
    const text = script.join("\n");
    expect(text).toContain("snapshot_cmd_hold() {");
    expect(text).toContain("snapshot_cmd_resume() {");
    expect(text).toContain("kamal-proxy pause shop");
    expect(text).not.toMatch(/SNAPSHOT_PARTS|snapshot_cmd_take|snapshot_cmd_restore/);
    for (const line of script) expect(line).not.toContain("\n");
    if (shWorks()) expect(parses(script)).toBe(true);
    // The extra server keeps its own full script.
    expect(snapshotScript(extraOnly(), "data").join("\n")).toContain("SNAPSHOT_PARTS='db docs'");
  });

  it("has each extra server's own services, and no hold or stop of the app there", () => {
    const script = snapshotScript(splitPlan(), "data").join("\n");
    expect(script).toContain("SNAPSHOT_PARTS='db docs'");
    expect(script).not.toMatch(/kamal-proxy|docker compose stop app|edge\(\)|snapshot_cmd_hold/);
    expect(script).toContain("is no service with data on the server data.");
    const app = snapshotScript(splitPlan()).join("\n");
    expect(app).toContain("SNAPSHOT_PARTS='cache'");
  });

  it("untars a stop-only service's copy only into its own folders", () => {
    expect(snapshotScript(BASE).join("\n")).toContain(
      `snapshot_untar kafka "$2" 'find /var/lib/kafka/data /etc/kafka/secrets /mnt/shared/config -mindepth 1 -delete && tar -C / -xpf - var/lib/kafka/data etc/kafka/secrets mnt/shared/config'`,
    );
  });

  it("logs each one-off in with the password from the service's env file, never in an argument", () => {
    const secrets = Object.fromEntries(
      BASE.services.map((service) => [
        service.name,
        Object.fromEntries(
          serviceSpec(service.kind).secrets.map((secret) => [
            secret.name,
            randomBytes(16).toString("hex"),
          ]),
        ),
      ]),
    );
    const script = snapshotScript(BASE).join("\n");
    for (const values of Object.values(secrets)) {
      for (const value of Object.values(values)) expect(script).not.toContain(value);
    }
    expect(script).toContain(
      `snapshot_run "$2" rw cache 'umask 077 && export REDISCLI_AUTH="$VALKEY_PASSWORD" && valkey-cli -h cache --rdb /snapshot/cache.rdb'`,
    );
    expect(script).toContain(`[ "$(redis-cli -h dfq SAVE RDB opscrew-snapshot)" = OK ]`);
    expect(script).toContain('export REDISCLI_AUTH="$DFLY_requirepass"');
    for (const line of script.split("\n").filter((l) => l.includes('snapshot_run "$2"'))) {
      expect(line).not.toMatch(/\s(-a|--pass|--password|-p)[\s=]|PASSWORD=[^"]/);
    }
  });

  it("has its crontab line in the start script of every server with data", () => {
    const plan = withSnapshots(splitPlan(), { snapshots: { schedule: { every: "weekly" } } });
    expect(serverCommands(plan, "data", []).join("\n")).toContain(
      "take scheduled > /dev/null 2>&1 %s",
    );
    expect(switchCommands(plan, []).join("\n")).toContain("take scheduled > /dev/null 2>&1 %s");
    // On this computer, never.
    expect(snapshotScheduleLines(localhostPlan(), "app")).toEqual([]);
  });
});

describe("the deploy's upload of snapshot.sh", () => {
  /** The lines of the workflow's step `name`, up to the next step. */
  const step = (content: string, name: string) => {
    const lines = content.split("\n");
    const start = lines.findIndex((line) => line.endsWith(`- name: ${name}`));
    const end = lines.findIndex((line, i) => i > start && /^ {6}- (name|id|uses):/.test(line));
    return lines.slice(start, end).join("\n");
  };
  const UPLOAD = "Upload runtime files and environment";

  it("writes each server's script beside its runtime files, renamed in place, over SSH or on the runner's machine", () => {
    const plan = splitPlan();
    const content = renderWorkflow(plan, testContext()).content;
    const upload = step(content, UPLOAD);
    expect(upload).toContain(
      `ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/apps/shop/snapshot.sh.new && mv -f /srv/apps/shop/snapshot.sh.new /srv/apps/shop/snapshot.sh' <<'SNAPSHOT'`,
    );
    expect(upload).toContain("          SNAPSHOT_PARTS='cache'");
    expect(upload).toMatch(/\n {10}SNAPSHOT$/);
    expect(step(content, "Update the services on the server data")).toContain(
      "          SNAPSHOT_PARTS='db docs'",
    );
    const own = renderWorkflow(
      inEnvironment(serverPlanWithRunner(), { name: "staging", runner: "server" }),
      testContext(),
    ).content;
    expect(own).toContain(
      `(umask 077 && cat > "$dir"/snapshot.sh.new && mv -f "$dir"/snapshot.sh.new "$dir"/snapshot.sh) <<'SNAPSHOT'`,
    );
  });

  it("writes the app's server's hold and resume when only extra servers hold data (D13)", () => {
    const upload = step(renderWorkflow(extraOnly(), testContext()).content, UPLOAD);
    expect(upload).toContain("/srv/apps/shop/snapshot.sh.new");
    expect(upload).toContain("          snapshot_cmd_hold() {");
  });

  it("stops the job at its first contact with the app's server while a restore holds the app", () => {
    // One server: the upload checks first, before it makes the app's folder.
    const one = renderWorkflow(serverPlanWithRunner(), testContext()).content;
    const upload = step(one, UPLOAD);
    const check = upload.indexOf(
      `hold="$(ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'if [ -e /srv/apps/shop/.snapshots/.held ]; then echo held; fi')"`,
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(upload.indexOf('if [[ "$hold" == held ]]; then'));
    expect(upload.indexOf('if [[ "$hold" == held ]]; then')).toBeLessThan(
      upload.indexOf("mkdir -p /srv/apps/shop"),
    );
    expect(one.split("hold=")).toHaveLength(2);
    expect(one).not.toContain("- name: Check that no restore holds the app");
    // With extra servers, before theirs (with a rollback that changes their data, the step that
    // reads the app's version first does it instead: snapshots.test.ts).
    const split = renderWorkflow(splitPlan(), testContext()).content;
    const first = split.indexOf("- name: Check that no restore holds the app");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(split.indexOf("- name: Update the services on the server data"));
    const staging = renderWorkflow(
      inEnvironment(splitPlan(), { name: "staging" }),
      testContext(),
    ).content;
    const outgoing = staging.indexOf("- id: outgoing");
    expect(outgoing).toBeGreaterThan(-1);
    expect(staging.indexOf(".snapshots/.held")).toBeGreaterThan(outgoing);
    expect(staging.indexOf(".snapshots/.held")).toBeLessThan(
      staging.indexOf("- name: Update the services on the server data"),
    );
    expect(staging).not.toContain("- name: Check that no restore holds the app");
    // No data: no check.
    const plain = renderWorkflow(
      inEnvironment(withServices([]), { name: "staging" }),
      testContext(),
    );
    expect(plain.content).not.toContain(".snapshots/.held");
  });

  it("checks for a restore's hold first in the start step, and the rollback step says so plainly", () => {
    const content = renderWorkflow(splitPlan(), testContext()).content;
    expect(content).toContain(
      "if [ -f .snapshots/.held ]; then echo '::error::OpsCrew changed nothing on the server: a restore holds the app",
    );
    expect(content).toContain("if [ -f .snapshots/.held ]; then echo held; exit 0; fi");
    expect(content).toContain(`*:held) echo "${HELD_ROLLBACK}" ;;`);
  });

  it("writes none for an app without data", () => {
    const content = renderWorkflow(
      inEnvironment(withServices([]), { name: "staging" }),
      testContext(),
    ).content;
    expect(content).not.toContain("snapshot.sh");
  });

  it("writes offsite.env from its secret on each server with data, on stdin, only with the off-server copy", () => {
    const offsite = withSnapshots(splitPlan(), {
      snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
    });
    const content = renderWorkflow(offsite, testContext()).content;
    const write = (dir: string) =>
      `printf '%s\\n' "\${OPSCREW_OFFSITE_ENV:-}" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > ${dir}/offsite.env'`;
    const servers = ["data", "box-2"].map((name) => `Update the services on the server ${name}`);
    for (const name of [UPLOAD, ...servers]) {
      const lines = step(content, name);
      expect(lines).toContain("OPSCREW_OFFSITE_ENV: ${{ secrets.OPSCREW_OFFSITE_ENV }}");
      expect(lines).toContain(write("/srv/apps/shop"));
    }
    // The file only ever goes from the secret's reference to stdin, never into an argument.
    for (const line of content.split("\n").filter((l) => /OPSCREW_OFFSITE_ENV\b/.test(l))) {
      expect(line.trim()).toMatch(
        /^(OPSCREW_OFFSITE_ENV: \$\{\{ secrets\.OPSCREW_OFFSITE_ENV \}\}|printf '%s\\n' "\$\{OPSCREW_OFFSITE_ENV:-\}" \| ssh .*'umask 077 && cat > \/srv\/apps\/shop\/offsite\.env')$/,
      );
    }
    expect(deploySecretNamesFor(offsite)).toContain(OFFSITE_ENV_SECRET);

    // On the server's own runner, written in place.
    const own = renderWorkflow(
      withSnapshots(inEnvironment(serverPlanWithRunner(), { name: "staging", runner: "server" }), {
        snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
      }),
      testContext(),
    ).content;
    expect(own).toContain(
      `printf '%s\\n' "\${OPSCREW_OFFSITE_ENV:-}" | (umask 077 && cat > "$dir"/offsite.env)`,
    );

    // Without it: no file, no secret.
    const plain = renderWorkflow(splitPlan(), testContext()).content;
    expect(plain).not.toContain("OFFSITE");
    expect(deploySecretNamesFor(splitPlan())).not.toContain(OFFSITE_ENV_SECRET);
  });
});

/** {@link splitPlan} with data only on its extra servers: no service on the app's server. */
function extraOnly(): DeployPlan {
  const plan = splitPlan();
  return DeployPlanSchema.parse({
    ...plan,
    services: plan.services.filter((service) => service.server !== undefined),
    network: { ...plan.network, grants: [] },
  });
}

/** The shared Hetzner test plan, which the server's runner can deploy. */
function serverPlanWithRunner(): DeployPlan {
  return withServices([{ kind: "postgres", name: "db" }]);
}
