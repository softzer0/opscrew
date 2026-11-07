import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Rails' migration status as detection writes it: each database.yml entry and its version. */
export const RAILS_STATUS = `bin/rails runner "ActiveRecord::Base.configurations.configs_for(env_name: Rails.env).each { |c| ActiveRecord::Base.establish_connection(c); puts 'database: ' + c.name, 'Current version: ' + ActiveRecord::Base.connection_pool.with_connection { |x| x.schema_version }.to_s }"`;

/** Whether `sh` runs here (Git Bash on Windows); the shell tests skip without it. */
export function shWorks(): boolean {
  try {
    return spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

/** Writes `content` to `file`, creating its folders. */
export function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Writes each fake program as an executable `<dir>/bin/<name>`. */
export function fakeBin(dir: string, fakes: Record<string, string>): void {
  for (const [name, script] of Object.entries(fakes)) {
    const file = `${dir}/bin/${name}`;
    write(file, `${script}\n`);
    chmodSync(file, 0o755);
  }
}

/**
 * Runs `script` as the workflow does: piped to `sh -s` with `args` as `$1`…, `$WORK/bin`'s fakes
 * first on PATH. `env` adds to this process's and must set WORK.
 */
export function runSh(
  script: readonly string[],
  args: readonly string[],
  env: Record<string, string>,
) {
  const result = spawnSync(
    "sh",
    [
      "-c",
      'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh -s -- "$@"',
      "sh",
      ...args,
    ],
    { input: `${script.join("\n")}\n`, env: { ...process.env, ...env }, encoding: "utf8" },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    /** What the script printed on stdout alone, trimmed. */
    stdout: result.stdout.trim(),
  };
}

/**
 * The fake `docker`'s prologue: strips `compose`'s `-p <project>` and `-f <file>` (the project
 * defaults to the folder's name), sets `$last` to the last argument and `$state` to the project's
 * containers file ($WORK/containers-<project>), which it creates.
 */
export const COMPOSE_PROLOGUE: readonly string[] = [
  'project="$(basename "$PWD")"',
  'if [ "$1" = compose ]; then',
  "  shift",
  '  while [ "$1" = -p ] || [ "$1" = -f ]; do',
  '    if [ "$1" = -p ]; then project="$2"; fi',
  "    shift 2",
  "  done",
  '  set -- compose "$@"',
  "fi",
  'for last in "$@"; do :; done',
  'state="$WORK/containers-$project"',
  'touch "$state"',
];

/**
 * The fake `flock`: logs its call among docker's ($WORK/docker.log); with FLOCK_BUSY, a bounded
 * wait (`-w`) runs out, as when another script holds the lock all that time.
 */
export const FAKE_FLOCK = [
  "#!/bin/sh",
  'echo "flock $*" >> "$WORK/docker.log"',
  'if [ "$1" = -w ] && [ -n "${FLOCK_BUSY:-}" ]; then exit 1; fi',
].join("\n");

/**
 * The fake `df -Pk`: DISK_TOTAL_KB (default about 1 TB) with DISK_FREE_KB free (default half),
 * or almost nothing once $WORK/disk-full exists.
 */
export const FAKE_DF = [
  "#!/bin/sh",
  'total="${DISK_TOTAL_KB:-1000000000}"',
  'free="${DISK_FREE_KB:-500000000}"',
  'if [ -f "$WORK/disk-full" ]; then free=1000; fi',
  'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
  'echo "/dev/sda1 $total 0 $free 50% /"',
].join("\n");

/**
 * Why the tests on Docker skip here, or `undefined` when they run: they need
 * OPSCREW_DOCKER_TESTS=1, an engine for Linux containers and `docker compose`.
 */
export function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (info.status !== 0 || info.stdout.trim() !== "linux") {
    return "no Docker engine for Linux containers is running";
  }
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return compose.status === 0 ? undefined : "docker compose is not available";
}
