// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan, testServices } from "../__fixtures__/plans";
import { withServices } from "../catalog/__fixtures__/plans";
import { EDGE_VERSION, EDGE_VERSION_KEY, renderEdgeCompose } from "../edge";
import { renderCaddyfile, renderCompose, renderRuntimeFiles } from "../runtime";
import type { RenderContext } from "../types";
import {
  jobYaml,
  NIGHTLY,
  withBuild,
  withPlan,
  withProcesses,
  withSqlite,
} from "./__fixtures__/plans";
import { renderWorkflow } from "./index";
import { type ServiceInitStep, switchCommands } from "./switch";

/*
 * Runs the generated "Start the new version" and "Roll back" scripts in bash against a fake server:
 * `ssh` runs the server script with `sh` locally, /srv mapped to $WORK/srv, `scp` logs its
 * arguments and copies the repository's files that exist, `flock` only logs, and `docker` is a fake
 * that keeps each Compose project's containers in a file and plays the shared edge's kamal-proxy,
 * which routes to a container unless its image is in UNHEALTHY.
 */

const plan: DeployPlan = DeployPlanSchema.parse({
  schemaVersion: 1,
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:00:00.000Z",
  app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
  target: {
    provider: "hetzner",
    mode: "vps-compose",
    location: "nbg1",
    serverType: "cx23",
    backups: true,
  },
  services: testServices({ postgres: true }),
  externalServices: [],
  cost: {
    monthly: { amount: 7.09, currency: "EUR" },
    breakdown: [{ item: "server", monthly: { amount: 7.09, currency: "EUR" } }],
    pricesIncludeVat: false,
    source: "static",
    asOf: "2026-06-15T00:00:00.000Z",
  },
  codeChanges: [],
  infra: {},
  dns: { provider: "none", proxied: false },
  cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
  security: {},
});

const ctx: RenderContext = {
  opscrewVersion: "0.1.0",
  github: { owner: "acme", repo: "shop" },
  deploySshPublicKey: "ssh-ed25519 AAAA opscrew-deploy",
};

type Step = { id?: string; name?: string; run?: string };
function scripts(p: DeployPlan) {
  const steps: Step[] = parse(renderWorkflow(p, ctx).content).jobs.deploy.steps;
  return {
    upload: steps.find((s) => s.name?.startsWith("Upload"))?.run ?? "",
    start: steps.find((s) => s.id === "start")?.run ?? "",
    rollback: steps.find((s) => s.name?.startsWith("Roll back"))?.run ?? "",
  };
}
/**
 * An app with Postgres, a Valkey cache, two workers (and a third turned off), cron jobs and a
 * release command.
 */
const components = withProcesses(
  withPlan(
    DeployPlanSchema.parse({ ...plan, services: testServices({ postgres: true, redis: true }) }),
    {
      releaseCommand: "npm run migrate",
    },
  ),
  {
    workers: [
      { name: "worker", command: "node worker.js", count: 2 },
      { name: "beat", command: "node beat.js" },
      { name: "mailer", command: "node mailer.js", enabled: false },
    ],
    cron: [NIGHTLY],
  },
);
const withWorkers = scripts(components);
const rolling = scripts(withBuild(plan, "buildpacks", { language: "go" }));
const recreate = scripts(
  withPlan(withBuild(plan, "railpack", { language: "rust" }), { deploy: { strategy: "recreate" } }),
);
const release = scripts(withPlan(plan, { releaseCommand: "python manage.py migrate --noinput" }));

const NEW = `ghcr.io/acme/shop@sha256:${"b".repeat(64)}`;
const OLD = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;
const OLDER = `ghcr.io/acme/shop@sha256:${"9".repeat(64)}`;

const PRELUDE = [
  'export PATH="$(cd "$WORK/bin" && pwd):$PATH"',
  "ssh() {",
  "  local n",
  '  n=$(( $(cat "$WORK/ssh-count" 2>/dev/null || echo 0) + 1 ))',
  '  echo "$n" > "$WORK/ssh-count"',
  '  if [[ "$n" == "${SSH_FAIL_AT:-0}" ]]; then echo "ssh: connect to host failed" >&2; return 255; fi',
  '  while [[ "$1" != deploy@* ]]; do shift; done',
  "  shift",
  '  if [[ "$1" == sh && "$2" == -s ]]; then',
  "    shift 3",
  // The script reaches sh on its stdin, as over ssh: a command that reads stdin would eat it.
  '    local script; script="$(cat)"',
  '    printf "%s\\n" "${script//\\/srv\\//$WORK/srv/}" | sh -s -- "$@"',
  "  else",
  '    sh -c "${*//\\/srv\\//$WORK/srv/}"',
  "  fi",
  "}",
  "scp() {",
  '  echo "scp $*" >> "$WORK/scp.log"',
  '  local dest="${*: -1}"; dest="$WORK${dest#*:}"',
  '  local arg; for arg in "$@"; do if [[ "$arg" == opscrew/* && -e "$arg" ]]; then cp -r "$arg" "$dest"; fi; done',
  "}",
].join("\n");

/**
 * The fake `docker`: logs every call, and each Compose call as `<project> <arguments>` in
 * $WORK/projects.log (the project is the folder's name unless `-p` names one). An app project's
 * `compose` calls act on $WORK/containers-<project>; the workers and cron named in PROCESSES live
 * in $WORK/processes-<project>, one container each unless REPLICAS says otherwise (`worker=2`), as
 * `p<n> <service> <image> <status> <restarts>`; they are recreated only when their image changed,
 * as Compose does, and `compose stop` exits them. Any other `compose exec` in an app project is a
 * setup step: it fails when its words are a line of $WORK/failing. In the edge's project, `up`
 * fails with EDGE_UP_FAIL, Caddy's reload with CADDY_RELOAD_FAIL, and kamal-proxy's `deploy
 * <service>` writes the target it routes to in $WORK/routes/<service>.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  'echo "docker $*" >> "$WORK/docker.log"',
  'project="$(basename "$PWD")"',
  'if [[ "$1" == compose ]]; then',
  "  shift",
  '  while [[ "$1" == -p || "$1" == -f ]]; do',
  '    if [[ "$1" == -p ]]; then project="$2"; fi',
  "    shift 2",
  "  done",
  '  echo "$project $*" >> "$WORK/projects.log"',
  '  set -- compose "$@"',
  "fi",
  'state="$WORK/containers-$project"',
  'processes="$WORK/processes-$project"',
  'touch "$state" "$processes" "$WORK/failing"',
  'image_now() { echo "${APP_IMAGE:-$(sed -n "s/^APP_IMAGE=//p" .env)}"; }',
  'next_id() { local n; n="$(cat "$WORK/next" 2>/dev/null || echo 1)"; echo $(( n + 1 )) > "$WORK/next"; echo "$n"; }',
  "start_one() {",
  '  local n; n="$(next_id)"',
  '  local image; image="$(image_now)"',
  '  local status=running; [[ " ${EXITED:-} " == *" $image "* ]] && status=exited',
  '  echo "c$n $project-app-$n $image $status" >> "$state"',
  "}",
  "up_process() {",
  '  local image; image="$(image_now)"',
  '  awk -v s="$1" -v i="$image" \'$2 == s && $3 == i { found = 1 } END { exit !found }\' "$processes" && return 0',
  '  local count; count="$(echo " ${REPLICAS:-} " | sed -n "s/.* $1=\\([0-9]*\\) .*/\\1/p")"',
  '  { grep -v "^p[0-9]* $1 " "$processes" || true',
  '    for _ in $(seq "${count:-1}"); do echo "p$(next_id) $1 $image running 0"; done; } > "$processes.tmp"',
  '  mv "$processes.tmp" "$processes"',
  "}",
  'case "$1 $2" in',
  '  "login ghcr.io") cat > /dev/null; [[ -z "${DOCKER_LOGIN_FAIL:-}" ]] ;;',
  '  "network inspect") [[ -f "$WORK/network-$3" ]] ;;',
  '  "network create") touch "$WORK/network-$3" ;;',
  '  "compose up")',
  '    if [[ "$project" == opscrew-edge ]]; then [[ -z "${EDGE_UP_FAIL:-}" ]]; exit; fi',
  '    [[ -z "${COMPOSE_UP_FAIL:-}" ]] || exit 1',
  '    if [[ "${@: -1}" != app ]]; then',
  '      for arg in "${@:3}"; do [[ " ${PROCESSES:-} " != *" $arg "* ]] || up_process "$arg"; done',
  "      exit 0",
  "    fi",
  '    if [[ " $* " == *" --scale "* ]]; then',
  '      want="$(echo " $* " | sed -n "s/.* --scale app=\\([0-9]*\\) .*/\\1/p")"',
  '      while (( $(wc -l < "$state") < want )); do start_one; done',
  "    else",
  '      : > "$state"; start_one',
  "    fi ;;",
  '  "compose ps")',
  '    if [[ " ${PROCESSES:-} " == *" ${@: -1} "* ]]; then',
  '      if [[ " $* " == *" -aq "* ]]; then awk -v s="${@: -1}" \'$2 == s { print $1 }\' "$processes"',
  '      else awk -v s="${@: -1}" \'$2 == s && $4 == "running" { print $1 }\' "$processes"; fi',
  '    elif [[ " $* " == *" -aq "* ]]; then cut -d " " -f 1 "$state"',
  '    else awk \'$4 == "running" { print $1 }\' "$state"; fi ;;',
  '  "compose stop")',
  '    for arg in "${@:3}"; do',
  '      awk -v s="$arg" \'{ if ($2 == s) $4 = "exited"; print }\' "$processes" > "$processes.tmp"',
  '      mv "$processes.tmp" "$processes"',
  "    done ;;",
  '  "compose run") cat > /dev/null; echo "run image=${APP_IMAGE:-}" >> "$WORK/docker.log"',
  '    if [[ -n "${RELEASE_FAIL:-}" ]]; then echo "django.db.utils.OperationalError: no such table"; exit 3; fi ;;',
  '  "compose exec")',
  "    cat > /dev/null",
  '    if [[ "$project" != opscrew-edge ]]; then',
  '      if grep -qxF "${*:5}" "$WORK/failing"; then echo "setup output for ${*:5}"; exit 1; fi',
  "      exit 0",
  "    fi",
  '    if [[ "$4" == caddy ]]; then',
  '      if [[ -n "${CADDY_RELOAD_FAIL:-}" ]]; then echo "Error: ambiguous site definition: :80" >&2; exit 1; fi',
  "      exit 0",
  "    fi",
  '    target=""; prev=""; for arg in "$@"; do [[ "$prev" == --target ]] && target="$arg"; prev="$arg"; done',
  '    image="$(cat "$WORK"/containers-* | awk -v n="${target%:*}" \'$2 == n { print $3 }\')"',
  '    status="$(cat "$WORK"/containers-* | awk -v n="${target%:*}" \'$2 == n { print $4 }\')"',
  '    if [[ "$status" != running || " ${UNHEALTHY:-} " == *" $image "* ]]; then',
  '      echo "Error: target failed to become healthy within configured timeout (60s)" >&2; exit 1',
  "    fi",
  '    mkdir -p "$WORK/routes"; echo "$target" > "$WORK/routes/$7" ;;',
  '  "inspect --format")',
  '    if [[ "${@: -1}" == p* ]]; then',
  '      cat "$WORK"/processes-* | awk -v id="${@: -1}" -v f="$3" \'$1 == id { print (f == "{{.RestartCount}}" ? $5 : $4 ":" $5) }\'',
  '    else cat "$WORK"/containers-* | awk -v id="${@: -1}" \'$1 == id { print "/" $2 }\' | grep .; fi ;;',
  "  *)",
  '    if [[ "$1" == rm ]]; then grep -v "^${@: -1} " "$state" > "$state.tmp" || true; mv "$state.tmp" "$state"; fi ;;',
  "esac",
].join("\n");

/**
 * The fake `sleep`: returns at once; meanwhile the services in CRASH restart (`worker/2`: only the
 * second container of `worker`), and those in STOP exit.
 */
const FAKE_SLEEP = [
  "#!/usr/bin/env bash",
  'echo "sleep $*" >> "$WORK/docker.log"',
  'processes="$WORK/processes-$(basename "$PWD")"',
  'touch "$processes"',
  'awk -v crash=" ${CRASH:-} " -v stop=" ${STOP:-} " \'{',
  "  k[$2]++",
  '  if (index(crash, " " $2 " ") || index(crash, " " $2 "/" k[$2] " ")) $5 = $5 + 1',
  '  if (index(stop, " " $2 " ")) $4 = "exited"',
  "  print",
  '}\' "$processes" > "$processes.tmp" && mv "$processes.tmp" "$processes"',
].join("\n");

/** The fake `flock`: the server's lock around the shared edge, logged. */
const FAKE_FLOCK = ["#!/usr/bin/env bash", 'echo "flock $*" >> "$WORK/flock.log"'].join("\n");

let work = "";

function bashWorks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "opscrew-bash-")).replaceAll("\\", "/");
  try {
    const probe = spawnSync("bash", ["-c", 'cd "$WORK" && sh -c "echo ok"'], {
      env: { ...process.env, WORK: dir },
      encoding: "utf8",
    });
    return probe.status === 0 && probe.stdout.trim() === "ok";
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasBash = bashWorks();

/** Runs a step's script on the runner, in the app's repository (`repos/<app>`, default `shop`). */
function run(script: string, env: Record<string, string> = {}, app = "shop") {
  const result = spawnSync("bash", ["-c", `${PRELUDE}\n${script}`], {
    cwd: join(work, "repos", app),
    env: {
      ...process.env,
      WORK: work,
      HOST: "203.0.113.10",
      IMAGE: NEW,
      GITHUB_ACTOR: "octocat",
      GITHUB_OUTPUT: `${work}/output`,
      RUNNER_TEMP: `${work}/tmp`,
      REGISTRY_TOKEN: "registry-token-placeholder",
      PROCESSES: "worker beat cron",
      ...env,
    },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** `p`'s files in opscrew/runtime as provision renders them, the edge's stamped `version`. */
function runtimeFiles(p: DeployPlan, version = EDGE_VERSION): Record<string, string> {
  const stamp = (text: string) =>
    text.replace(`\n${EDGE_VERSION_KEY}: ${EDGE_VERSION}\n`, `\n${EDGE_VERSION_KEY}: ${version}\n`);
  return Object.fromEntries(
    [renderCompose(p), ...renderRuntimeFiles(p), renderCaddyfile(p, ctx)].map((f) => [
      f.path.replace(/^opscrew\/runtime\//, ""),
      stamp(f.content),
    ]),
  );
}
function writeAll(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
/** The app's repository with `p`'s runtime files, which the upload copies. */
const repo = (p: DeployPlan, version = EDGE_VERSION) =>
  writeAll(join(work, "repos", p.app.name, "opscrew", "runtime"), runtimeFiles(p, version));
/** `p`'s runtime files in its folder on the server, as the upload leaves them. */
const uploaded = (p: DeployPlan, version = EDGE_VERSION) =>
  writeAll(join(work, "srv", "apps", p.app.name), runtimeFiles(p, version));

const appFile = (name: string, app = "shop") => join(work, "srv", "apps", app, name);
const read = (name: string, app = "shop") =>
  existsSync(appFile(name, app)) ? readFileSync(appFile(name, app), "utf8").trim() : undefined;
const file = (name: string) =>
  existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8").trim() : "";
/** `.env` files with the given images, and the app containers running `running`. */
const server = (files: Record<string, string>, running: readonly string[] = []) => {
  for (const [name, image] of Object.entries(files)) {
    writeFileSync(appFile(name), `APP_IMAGE=${image}\n`);
  }
  writeFileSync(
    join(work, "containers-shop"),
    running.map((image, i) => `c${90 + i} shop-app-${90 + i} ${image} running\n`).join(""),
  );
};
/** The images of the app's containers that exist. */
const containers = (app = "shop") =>
  file(`containers-${app}`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[2]);
/** The image of the container kamal-proxy sends the app's traffic to. */
const routed = (app = "shop") => {
  const name = file(`routes/${app}`).split(":")[0];
  return file(`containers-${app}`)
    .split("\n")
    .find((line) => line.split(" ")[1] === name)
    ?.split(" ")[2];
};
const resetCalls = () => {
  for (const log of ["ssh-count", "docker.log", "projects.log"]) {
    rmSync(join(work, log), { force: true });
  }
};
const dockerCalls = () => file("docker.log");
/** The image each worker and cron container runs, by service. */
const processImages = () =>
  Object.fromEntries(
    file("processes-shop")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ").slice(1, 3)),
  );
/** The status of each worker and cron container, by service. */
const processStatus = () =>
  Object.fromEntries(
    file("processes-shop")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.split(" ")[1], line.split(" ")[3]]),
  );
/** The workers and cron of an earlier deploy (`services`, default all three), running `image`. */
const runningProcesses = (image: string, services = ["worker", "beat", "cron"]) =>
  writeFileSync(
    join(work, "processes-shop"),
    services.map((s, i) => `p${80 + i} ${s} ${image} running 0\n`).join(""),
  );

// Each test runs bash several times; on Windows (Git Bash) under a parallel `pnpm check` that
// can take longer than the default 5 seconds.
describe.skipIf(!hasBash)("deploy start and rollback scripts", { timeout: 30_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-rollback-")).replaceAll("\\", "/");
    for (const dir of ["repos/shop", "srv/edge", "tmp", "bin"]) {
      mkdirSync(join(work, dir), { recursive: true });
    }
    writeFileSync(join(work, "bin", "docker"), `${FAKE_DOCKER}\n`, { mode: 0o755 });
    writeFileSync(join(work, "bin", "sleep"), `${FAKE_SLEEP}\n`, { mode: 0o755 });
    writeFileSync(join(work, "bin", "flock"), `${FAKE_FLOCK}\n`, { mode: 0o755 });
    // The server after an upload: the app's folder with its runtime files and the edge's.
    uploaded(plan);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  describe("rolling", () => {
    it("starts a second copy, routes to it once healthy, then removes the old one", () => {
      server({ ".env": OLD, ".env.previous": OLDER }, [OLD]);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(containers()).toEqual([NEW]);
      expect(routed()).toBe(NEW);
      expect(file("routes/shop")).toBe("shop-app-1:3000");
      expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
      expect(read(".env.previous")).toBe(`APP_IMAGE=${OLD}`);
      expect(file("output")).toBe(`previous=${OLD}`);
      const calls = dockerCalls();
      expect(calls).toContain(
        "docker compose up -d --no-deps --no-recreate --remove-orphans --scale app=2 app",
      );
      // The app is the edge's kamal-proxy service named after it (no hostname before a domain).
      expect(file("projects.log")).toContain(
        "opscrew-edge exec -T kamal-proxy kamal-proxy deploy shop --target shop-app-1:3000 --health-check-path /api/health --deploy-timeout 60s --drain-timeout 30s --target-timeout 300s",
      );
      // The old copy goes only after the switch, with a graceful stop.
      expect(calls.indexOf("kamal-proxy deploy")).toBeLessThan(calls.indexOf("docker stop c90"));
      expect(calls).toContain("docker rm c90");
      expect(calls).toContain("docker logout ghcr.io");
    });

    it("removes every old copy, also one a broken run left behind", () => {
      server({ ".env": OLD }, [OLDER, OLD]);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(dockerCalls()).toContain("--scale app=3 app");
      expect(containers()).toEqual([NEW]);
      expect(routed()).toBe(NEW);
      expect(dockerCalls()).toContain("docker stop c90");
      expect(dockerCalls()).toContain("docker stop c91");
    });

    it("removes a new copy that never becomes healthy; the old one keeps serving", () => {
      server({ ".env": OLD }, [OLD]);
      mkdirSync(join(work, "routes"));
      writeFileSync(join(work, "routes", "shop"), "shop-app-90:3000\n");
      const start = run(rolling.start, { UNHEALTHY: NEW });
      expect(start.status).toBe(1);
      expect(containers()).toEqual([OLD]);
      expect(routed()).toBe(OLD);
      expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
      expect(start.output).toContain(
        "::error::The new version did not pass its health check (GET /api/health on port 3000) within 60 seconds, so OpsCrew removed it. It received no traffic: the previous version keeps serving.",
      );
      expect(start.output).toContain(
        "It was built with Buildpacks (app.build.builder: buildpacks in opscrew/plan.yaml)",
      );
      expect(start.output).not.toContain("203.0.113.10");
      expect(dockerCalls()).toContain("docker rm -f c1");

      resetCalls();
      const rollback = run(rolling.rollback);
      expect(rollback.status).toBe(1);
      expect(rollback.output).toContain("before the new version took traffic");
      expect(dockerCalls()).toBe("");
    });

    it("switches back to the previous version when the new one fails the health check after the switch", () => {
      server({ ".env": OLD, ".env.previous": OLDER }, [OLD]);
      expect(run(rolling.start).status).toBe(0);

      resetCalls();
      const rollback = run(rolling.rollback);
      expect(rollback.status).toBe(1);
      expect(rollback.output).toContain("restored the previous version");
      expect(containers()).toEqual([OLD]);
      expect(routed()).toBe(OLD);
      expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
      expect(read(".env.previous")).toBeUndefined();
      expect(dockerCalls()).not.toContain("compose pull");
    });

    it("reports when the previous version does not come back either", () => {
      server({ ".env": OLD }, [OLD]);
      expect(run(rolling.start).status).toBe(0);
      resetCalls();
      const rollback = run(rolling.rollback, { UNHEALTHY: OLD });
      expect(rollback.status).toBe(1);
      expect(rollback.output).toContain(
        "The previous version did not pass its health check either",
      );
      expect(rollback.output).toContain("could not restore the previous version");
      expect(containers()).toEqual([NEW]);
      expect(routed()).toBe(NEW);
    });

    it("registers the first copy on the first deploy", () => {
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(containers()).toEqual([NEW]);
      expect(routed()).toBe(NEW);
      expect(dockerCalls()).toContain("--scale app=1 app");
      expect(file("output")).toBe("previous=");
      resetCalls();
      const rollback = run(rolling.rollback);
      expect(rollback.output).toContain("no earlier version");
      expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
    });

    it("starts the steady services only before the switch, never restarting them after it", () => {
      server({ ".env": OLD }, [OLD]);
      expect(run(rolling.start).status).toBe(0);
      const calls = dockerCalls().split("\n");
      const ups = calls.filter((c) => c.startsWith("docker compose up"));
      expect(ups).toEqual([
        "docker compose up -d --no-deps --wait db",
        "docker compose up -d --no-deps --no-recreate --remove-orphans --scale app=2 app",
      ]);
    });
  });

  describe("recreate", () => {
    it("replaces the container, then routes to it", () => {
      server({ ".env": OLD }, [OLD]);
      const start = run(recreate.start);
      expect(start.status, start.output).toBe(0);
      expect(containers()).toEqual([NEW]);
      expect(routed()).toBe(NEW);
      expect(dockerCalls()).toContain("docker compose up -d --no-deps --remove-orphans app");
      expect(dockerCalls()).not.toContain("--scale");
      expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
    });

    it("gives the health message and the builder hint when the new copy exits at once", () => {
      server({ ".env": OLD }, [OLD]);
      const start = run(recreate.start, { EXITED: NEW });
      expect(start.status).toBe(1);
      expect(start.output).toContain("::error::The new version did not pass its health check");
      expect(start.output).toContain("It was built with Railpack (app.build.builder: railpack");
      expect(containers()).toEqual([]);
    });

    it("restores the previous version when the new one never becomes healthy", () => {
      server({ ".env": OLD }, [OLD]);
      const start = run(recreate.start, { UNHEALTHY: NEW });
      expect(start.status).toBe(1);
      expect(start.output).toContain("within 60 seconds, so OpsCrew removed it. Check that");
      expect(start.output).toContain("It was built with Railpack (app.build.builder: railpack");
      expect(containers()).toEqual([]);

      resetCalls();
      const rollback = run(recreate.rollback);
      expect(rollback.output).toContain("restored the previous version");
      expect(containers()).toEqual([OLD]);
      expect(routed()).toBe(OLD);
      expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    });
  });

  it("leaves the running version alone when the server was never reached", () => {
    server({ ".env": OLD, ".env.previous": OLDER }, [OLD]);
    expect(run(rolling.start, { SSH_FAIL_AT: "1" }).status).not.toBe(0);

    resetCalls();
    const rollback = run(rolling.rollback);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(rollback.output).toContain("still runs the version it had");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).toBe("");
  });

  it("leaves the running version alone when the registry login fails", () => {
    server({ ".env": OLD, ".env.previous": OLDER }, [OLD]);
    expect(run(rolling.start, { DOCKER_LOGIN_FAIL: "1" }).status).not.toBe(0);
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(containers()).toEqual([OLD]);

    resetCalls();
    const rollback = run(rolling.rollback);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(dockerCalls()).toBe("");
  });

  it("leaves the running version alone when Compose fails to start the new one", () => {
    server({ ".env": OLD }, [OLD]);
    expect(run(rolling.start, { COMPOSE_UP_FAIL: "1" }).status).not.toBe(0);
    expect(dockerCalls()).toContain("docker logout ghcr.io");
    expect(containers()).toEqual([OLD]);

    resetCalls();
    const rollback = run(rolling.rollback);
    expect(rollback.output).toContain("still runs the version it had");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
  });

  it("drops a stale saved version when there was nothing running", () => {
    server({ ".env.previous": OLDER });
    expect(run(rolling.start).status).toBe(0);
    expect(read(".env.previous")).toBeUndefined();
  });

  it("reports a running version that is not a digest as unknown", () => {
    writeFileSync(appFile(".env"), "APP_IMAGE=ghcr.io/acme/shop:latest\n");
    expect(run(rolling.start).status).toBe(0);
    expect(file("output")).toBe("previous=unknown");
  });

  it("reports when the server cannot be reached for the rollback", () => {
    server({ ".env": NEW, ".env.previous": OLD }, [NEW]);
    const rollback = run(rolling.rollback, { SSH_FAIL_AT: "1" });
    expect(rollback.status).toBe(1);
    expect(rollback.output).toContain("could not restore");
    expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
  });

  it("runs the release command in the new image before switching to it", () => {
    server({ ".env": OLD }, [OLD]);
    const start = run(release.start);
    expect(start.status, start.output).toBe(0);
    expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
    expect(read(".env.previous")).toBe(`APP_IMAGE=${OLD}`);
    const calls = dockerCalls().split("\n");
    const at = (prefix: string) => calls.findIndex((line) => line.startsWith(prefix));
    expect(at("docker compose pull")).toBeGreaterThan(-1);
    expect(at("docker compose pull")).toBeLessThan(at("docker compose up -d --no-deps --wait"));
    expect(at("docker compose up -d --no-deps --wait")).toBeLessThan(at("docker compose run"));
    expect(at("docker compose run")).toBeLessThan(
      at("docker compose up -d --no-deps --no-recreate"),
    );
    expect(calls).toContain("docker compose run --rm --no-deps -T release");
    expect(calls).toContain(`run image=${NEW}`);
  });

  it("stops before the switch when the release command fails, keeping the running version", () => {
    server({ ".env": OLD, ".env.previous": OLDER }, [OLD]);
    const start = run(release.start, { RELEASE_FAIL: "1" });
    expect(start.status).not.toBe(0);
    // The release output can quote rows, so it stays on the server, never in the workflow log.
    expect(start.output).not.toContain("no such table");
    expect(read("release.log")).toContain("no such table");
    expect(start.output).toContain("::error::The release command");
    expect(start.output).not.toContain("203.0.113.10");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).not.toContain("--scale");
    expect(dockerCalls()).toContain("docker logout ghcr.io");

    resetCalls();
    const rollback = run(release.rollback);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(rollback.output).toContain("still runs the version it had");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).toBe("");
  });

  describe("workers and cron", () => {
    it("deploys in order: services, release, web switch, workers and cron, then the worker check", () => {
      server({ ".env": OLD }, [OLD]);
      runningProcesses(OLD);
      const start = run(withWorkers.start);
      expect(start.status, start.output).toBe(0);
      const calls = dockerCalls().split("\n");
      const at = (prefix: string) => {
        const i = calls.findIndex((line) => line.includes(prefix));
        expect(i, prefix).toBeGreaterThan(-1);
        return i;
      };
      const order = [
        at("docker compose pull"),
        at("docker compose up -d --no-deps --wait db cache"),
        at("docker compose run --rm --no-deps -T release"),
        at("docker compose up -d --no-deps --no-recreate --remove-orphans --scale app=2 app"),
        at("exec -T kamal-proxy kamal-proxy deploy shop "),
        at("docker stop c90"),
        at("docker compose up -d --no-deps worker beat cron"),
        at("docker inspect --format {{.RestartCount}}"),
        at("sleep 30"),
        at("docker inspect --format {{.State.Status}}:{{.RestartCount}}"),
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The worker that is turned off is never started.
      expect(dockerCalls()).not.toContain("mailer");
      expect(processImages()).toEqual({ worker: NEW, beat: NEW, cron: NEW });
      expect(routed()).toBe(NEW);
    });

    it("puts the web and the workers back on the previous image when a worker keeps restarting", () => {
      server({ ".env": OLD }, [OLD]);
      runningProcesses(OLD);
      const start = run(withWorkers.start, { CRASH: "worker" });
      expect(start.status).toBe(1);
      // The fake ssh maps /srv to the test's folder.
      expect(start.output).toContain(
        "::error::The worker container did not keep running for 30 seconds after it started with the new version, so the deploy failed and OpsCrew puts the web and the workers back on the previous version, if there is one. Read its log on the server with `docker compose logs worker` in ",
      );
      expect(start.output).toContain(
        "(opscrew/RUNBOOK.md has the SSH command), fix its command (processes in opscrew/plan.yaml) or the app, and push again.\n",
      );
      expect(start.output).not.toContain("203.0.113.10");
      expect(processImages()).toEqual({ worker: NEW, beat: NEW, cron: NEW });

      resetCalls();
      const rollback = run(withWorkers.rollback);
      expect(rollback.status).toBe(1);
      expect(rollback.output).toContain("restored the previous version");
      expect(routed()).toBe(OLD);
      expect(containers()).toEqual([OLD]);
      expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
      expect(processImages()).toEqual({ worker: OLD, beat: OLD, cron: OLD });
      expect(dockerCalls()).toContain("docker compose up -d --no-deps worker beat cron");
      expect(dockerCalls()).not.toContain("compose stop");
    });

    it("stops the cron the previous version did not run when a deploy that adds it fails", () => {
      server({ ".env": OLD }, [OLD]);
      runningProcesses(OLD, ["worker", "beat"]);
      const start = run(withWorkers.start, { CRASH: "worker" });
      expect(start.status).toBe(1);
      // Recorded before the switch, from the containers that were running.
      expect(read(".processes.previous")).toBe("worker\nbeat");
      expect(processImages()).toEqual({ worker: NEW, beat: NEW, cron: NEW });

      resetCalls();
      const rollback = run(withWorkers.rollback);
      expect(rollback.status).toBe(1);
      expect(rollback.output).toContain("restored the previous version");
      expect(routed()).toBe(OLD);
      expect(processImages()).toEqual({ worker: OLD, beat: OLD, cron: NEW });
      // Nothing is left crash-looping: cron is stopped, never started on the old image.
      expect(processStatus()).toEqual({ worker: "running", beat: "running", cron: "exited" });
      expect(dockerCalls().split("\n")).toContain("docker compose up -d --no-deps worker beat");
      expect(dockerCalls().split("\n")).toContain("docker compose stop cron");
      expect(read(".processes.previous")).toBeUndefined();
    });

    it("says on a first deploy that a failed worker goes back only if there is a previous version", () => {
      const start = run(withWorkers.start, { CRASH: "beat" });
      expect(start.status).toBe(1);
      expect(start.output).toContain(
        "so the deploy failed and OpsCrew puts the web and the workers back on the previous version, if there is one. Read its log on the server with `docker compose logs beat`",
      );

      resetCalls();
      const rollback = run(withWorkers.rollback);
      expect(rollback.status).toBe(1);
      expect(rollback.output).toContain("there is no earlier version to restore");
      expect(dockerCalls()).toBe("");
    });

    it("checks every container of a worker that runs two copies", () => {
      server({ ".env": OLD }, [OLD]);
      const start = run(withWorkers.start, { REPLICAS: "worker=2", CRASH: "worker/2" });
      expect(start.status).toBe(1);
      expect(start.output).toContain("::error::The worker container did not keep running");
      const workers = file("processes-shop")
        .split("\n")
        .filter((line) => line.split(" ")[1] === "worker")
        .map((line) => line.split(" ")[0]);
      expect(workers).toHaveLength(2);
      for (const id of workers) {
        expect(dockerCalls()).toContain(`docker inspect --format {{.RestartCount}} ${id}`);
        expect(dockerCalls()).toContain(
          `docker inspect --format {{.State.Status}}:{{.RestartCount}} ${id}`,
        );
      }
    });

    it("names a worker that exits", () => {
      server({ ".env": OLD }, [OLD]);
      const start = run(withWorkers.start, { STOP: "beat" });
      expect(start.status).toBe(1);
      expect(start.output).toContain("::error::The beat container did not keep running");
      expect(start.output).toContain("`docker compose logs beat`");
    });

    it("never restarts the steady services, and never forces Compose to recreate anything", () => {
      server({ ".env": OLD }, [OLD]);
      runningProcesses(OLD);
      expect(run(withWorkers.start).status).toBe(0);
      const ups = dockerCalls()
        .split("\n")
        .filter((call) => call.startsWith("docker compose up"));
      expect(ups).toEqual([
        "docker compose up -d --no-deps --wait db cache",
        "docker compose up -d --no-deps --no-recreate --remove-orphans --scale app=2 app",
        "docker compose up -d --no-deps worker beat cron",
      ]);
      const job = renderWorkflow(components, ctx).content;
      for (const forced of ["--force-recreate", "--always-recreate-deps", "docker restart"]) {
        expect(job).not.toContain(forced);
      }
      expect(dockerCalls()).not.toMatch(/docker (stop|rm) p/);
    });

    it("keeps the workers that already run the image, as Compose does", () => {
      server({ ".env": NEW }, [NEW]);
      runningProcesses(NEW);
      expect(run(withWorkers.start).status).toBe(0);
      expect(
        file("processes-shop")
          .split("\n")
          .map((line) => line.split(" ")[0]),
      ).toEqual(["p80", "p81", "p82"]);
    });

    it("starts no worker check without workers or cron", () => {
      expect(rolling.start).not.toContain("sleep 30");
      expect(rolling.rollback).not.toContain("--no-deps worker");
    });

    it("replaces a SQLite app's web container instead of running two", () => {
      const sqlite = scripts(withSqlite(withBuild(plan, "generated-dockerfile")));
      expect(sqlite.start).toContain("docker compose up -d --no-deps --remove-orphans app\n");
      expect(sqlite.start).not.toContain("--scale");
    });
  });

  describe("the services' one-time setup", () => {
    const STEPS: ServiceInitStep[] = [
      {
        service: "garage",
        check: ["/garage", "layout", "show"],
        run: ["/garage", "layout", "apply", "--version", "1"],
      },
      {
        service: "garage",
        check: ["/garage", "bucket", "info", "uploads"],
        run: ["/garage", "bucket", "create", "uploads"],
      },
    ];
    const LAYOUT = "/garage layout apply --version 1";
    const BUCKET = "/garage bucket create uploads";
    const start = [
      'ssh "deploy@${HOST}" sh -s -- "$IMAGE" <<\'REMOTE\'',
      ...switchCommands(withPlan(plan, { releaseCommand: "npm run migrate" }), STEPS),
      "REMOTE",
    ].join("\n");
    const failing = (...commands: string[]) =>
      writeFileSync(join(work, "failing"), commands.map((c) => `${c}\n`).join(""));

    it("runs each step after the services start and before the release command, when its check fails", () => {
      server({ ".env": OLD }, [OLD]);
      failing("/garage layout show", "/garage bucket info uploads");
      const result = run(start);
      expect(result.status, result.output).toBe(0);
      const calls = dockerCalls().split("\n");
      const at = (text: string) => calls.findIndex((line) => line.endsWith(text));
      expect(at("docker compose up -d --no-deps --wait db")).toBeLessThan(
        at("/garage layout show"),
      );
      expect(at("/garage layout show")).toBeLessThan(at(LAYOUT));
      expect(at(LAYOUT)).toBeLessThan(at("/garage bucket info uploads"));
      expect(at("/garage bucket info uploads")).toBeLessThan(at(BUCKET));
      expect(at(BUCKET)).toBeLessThan(at("compose run --rm --no-deps -T release"));
      expect(calls).toContain(`docker compose exec -T garage ${LAYOUT}`);
    });

    it("skips the steps whose checks pass", () => {
      server({ ".env": OLD }, [OLD]);
      failing();
      const result = run(start);
      expect(result.status, result.output).toBe(0);
      expect(dockerCalls()).toContain("docker compose exec -T garage /garage layout show");
      expect(dockerCalls()).toContain("docker compose exec -T garage /garage bucket info uploads");
      expect(dockerCalls()).not.toContain(LAYOUT);
      expect(dockerCalls()).not.toContain(BUCKET);
    });

    it("stops before the release command when a step fails, keeping its output on the server", () => {
      server({ ".env": OLD }, [OLD]);
      failing("/garage layout show", LAYOUT);
      const result = run(start);
      expect(result.status).toBe(1);
      // The fake ssh maps /srv to the test's folder.
      expect(result.output).toContain(
        "::error::The one-time setup of the garage service failed, so the new version was not started and the previous version keeps serving. The step's output stays on the server in ",
      );
      expect(result.output).toContain(
        "/init.log (it can quote a key, so it is not printed here; opscrew/RUNBOOK.md has the SSH command): fix the cause and push again. The steps already done are skipped.",
      );
      // A step can print a key, so its output stays on the server.
      expect(result.output).not.toContain("setup output");
      expect(read("init.log")).toBe(`setup output for ${LAYOUT}`);
      expect(dockerCalls()).not.toContain("bucket");
      expect(dockerCalls()).not.toContain("compose run");
      expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    });

    it("fills a step's ${NAME} words from its env file, printing none of its values", () => {
      const secret = fakeSecret("aws-secret-access-key");
      server({ ".env": OLD }, [OLD]);
      writeFileSync(appFile("garage.env"), `GARAGE_KEY_ID=GKabc123\nGARAGE_KEY_SECRET=${secret}\n`);
      failing("/garage key info GKabc123");
      const steps: ServiceInitStep[] = [
        {
          service: "garage",
          envFile: "garage.env",
          check: ["/garage", "key", "info", "${GARAGE_KEY_ID}"],
          run: ["/garage", "key", "import", "--yes", "${GARAGE_KEY_ID}", "${GARAGE_KEY_SECRET}"],
        },
        // No check: harmless to repeat, so it runs on every deploy.
        { service: "garage", run: ["/garage", "bucket", "allow", "--key", "${GARAGE_KEY_ID}"] },
      ];
      const lines = switchCommands(plan, steps);
      expect(lines).toContain(
        `  if ! (umask 077; (set -a; . ./garage.env; set +a; docker compose exec -T garage '/garage' 'key' 'import' '--yes' "\${GARAGE_KEY_ID}" "\${GARAGE_KEY_SECRET}" < /dev/null) > /srv/apps/shop/init.log 2>&1); then`,
      );
      const result = run(
        ['ssh "deploy@${HOST}" sh -s -- "$IMAGE" <<\'REMOTE\'', ...lines, "REMOTE"].join("\n"),
      );
      expect(result.status, result.output).toBe(0);
      const calls = dockerCalls();
      expect(calls).toContain("docker compose exec -T garage /garage key info GKabc123");
      expect(calls).toContain(
        `docker compose exec -T garage /garage key import --yes GKabc123 ${secret}`,
      );
      // Without an env file the word stays as written: only a step's own file fills it in.
      expect(calls).toContain(
        "docker compose exec -T garage /garage bucket allow --key ${GARAGE_KEY_ID}",
      );
      expect(result.output).not.toContain(secret);
    });
  });

  describe("the upload", () => {
    const services = withProcesses(
      withServices([{ kind: "mysql", name: "main-db" }, { kind: "rabbitmq" }]),
      { cron: [NIGHTLY] },
    );

    it("copies the services' settings files, the crontab and the edge's files to the app's folder", () => {
      expect(run(scripts(services).upload).status).toBe(0);
      expect(file("scp.log")).toMatch(
        / opscrew\/runtime\/compose\.yaml opscrew\/runtime\/services opscrew\/runtime\/crontab opscrew\/runtime\/edge deploy@203\.0\.113\.10:\/srv\/apps\/shop\/$/,
      );
      expect(file("scp.log")).toMatch(/^scp -r /);
    });

    it("copies only compose.yaml and the edge's files when the plan has nothing else", () => {
      expect(run(rolling.upload).status).toBe(0);
      expect(file("scp.log")).toMatch(
        / opscrew\/runtime\/compose\.yaml opscrew\/runtime\/edge deploy@203\.0\.113\.10:\/srv\/apps\/shop\/$/,
      );
    });

    it("creates the app's folder on a server that has only /srv/apps, then fills it", () => {
      rmSync(join(work, "srv", "apps", "shop"), { recursive: true });
      repo(plan);
      const result = run(rolling.upload, { OPSCREW_APP_ENV: "LOG_LEVEL=info" });
      expect(result.status, result.output).toBe(0);
      expect(read("compose.yaml")).toBe(renderCompose(plan).content.trim());
      expect(read("edge/compose.yaml")).toBe(renderEdgeCompose(plan).content.trim());
      expect(read("edge/sites/shop.caddy")).toBe(renderCaddyfile(plan, ctx).content.trim());
      expect(read("app.env")).toBe("LOG_LEVEL=info");
      // Nothing reaches the edge's folder before the start step's lock.
      expect(readdirSync(join(work, "srv", "edge"))).toEqual([]);
    });

    it("writes each service's env file from its own secret, printing none of its values", () => {
      const mysql = `MYSQL_PASSWORD=${fakeSecret("aws-secret-access-key", "mysql")}`;
      const rabbitmq = `RABBITMQ_DEFAULT_PASS=${fakeSecret("aws-secret-access-key", "rabbitmq")}`;
      const result = run(scripts(services).upload, {
        OPSCREW_APP_ENV: "LOG_LEVEL=info",
        OPSCREW_SERVICE_MAIN_DB_ENV: mysql,
        OPSCREW_SERVICE_RABBITMQ_ENV: rabbitmq,
      });
      expect(result.status, result.output).toBe(0);
      expect(read("main-db.env")).toBe(mysql);
      expect(read("rabbitmq.env")).toBe(rabbitmq);
      expect(read("app.env")).toBe("LOG_LEVEL=info");
      expect(result.output).toBe("");
    });
  });

  describe("the shared edge", () => {
    const edgeFile = (name: string) => join(work, "srv", "edge", name);
    const serverEdge = () => readFileSync(edgeFile("compose.yaml"), "utf8");
    /** The server's edge Compose file from another app's deploy, stamped `version`. */
    const otherEdge = (version: number) => {
      const content = `name: opscrew-edge\n${EDGE_VERSION_KEY}: ${version}\n# another app's edge\n`;
      writeFileSync(edgeFile("compose.yaml"), content);
      return content;
    };
    const edgeCalls = () =>
      file("projects.log")
        .split("\n")
        .filter((line) => line.startsWith("opscrew-edge "));

    it("keeps the server's edge when the uploaded one is older, and still adds the app's site", () => {
      const theirs = otherEdge(EDGE_VERSION + 1);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(serverEdge()).toBe(theirs);
      expect(start.output).toContain(
        `The server's shared edge (version ${EDGE_VERSION + 1}) is newer than this app's (${EDGE_VERSION}), so it stays.`,
      );
      expect(readFileSync(edgeFile("sites/shop.caddy"), "utf8")).toBe(
        renderCaddyfile(plan, ctx).content,
      );
      expect(edgeCalls().slice(0, 2)).toEqual([
        "opscrew-edge up -d --wait",
        "opscrew-edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
      ]);
    });

    it("keeps the server's edge when the uploaded one is the same file", () => {
      const same = renderEdgeCompose(plan).content;
      writeFileSync(edgeFile("compose.yaml"), same);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(serverEdge()).toBe(same);
      expect(start.output).not.toContain("shared edge");
    });

    it("replaces the server's edge of the same version when its content differs", () => {
      otherEdge(EDGE_VERSION);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(serverEdge()).toBe(renderEdgeCompose(plan).content);
      expect(start.output).toContain(
        "OpsCrew's shared edge on this server now publishes the ports for how this app is served.",
      );
    });

    it("an app moved from the tunnel to serving directly gets the public ports on its server", () => {
      const tunnelled = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
      const direct = testPlan({ provider: "own" });
      // The server's edge from the app's last deploy, in tunnel mode: loopback only.
      writeFileSync(edgeFile("compose.yaml"), renderEdgeCompose(tunnelled).content);
      expect(serverEdge()).toContain("127.0.0.1:18080:80");
      uploaded(direct);
      const start = run(scripts(direct).start);
      expect(start.status, start.output).toBe(0);
      expect(serverEdge()).toBe(renderEdgeCompose(direct).content);
      expect(parse(serverEdge()).services.caddy.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    });

    it("replaces the server's edge with a newer upload", () => {
      otherEdge(EDGE_VERSION - 1);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(serverEdge()).toBe(renderEdgeCompose(plan).content);
      expect(start.output).toContain(
        `OpsCrew's shared edge on this server is now version ${EDGE_VERSION}.`,
      );
    });

    it("sets the edge up on the first deploy: its network, its file, then Caddy and kamal-proxy", () => {
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(serverEdge()).toBe(renderEdgeCompose(plan).content);
      expect(existsSync(join(work, "network-opscrew-edge"))).toBe(true);
      const calls = dockerCalls().split("\n");
      const at = (text: string) => calls.findIndex((line) => line.includes(text));
      // Under the lock, the network comes before the edge, the edge before the app's switch.
      expect(file("flock.log")).toBe("flock 9");
      expect(at("docker network create opscrew-edge")).toBeGreaterThan(at("docker compose pull"));
      expect(at("docker network create opscrew-edge")).toBeLessThan(at(" up -d --wait"));
      expect(at(" up -d --wait")).toBeLessThan(at("caddy reload"));
      expect(at("caddy reload")).toBeLessThan(at("--scale app=1 app"));
      expect(routed()).toBe(NEW);
    });

    it("puts the app's previous site back when Caddy refuses the new one, and stops before the switch", () => {
      server({ ".env": OLD }, [OLD]);
      mkdirSync(edgeFile("sites"));
      writeFileSync(edgeFile("sites/shop.caddy"), "# the site Caddy serves now\n");
      const start = run(rolling.start, { CADDY_RELOAD_FAIL: "1" });
      expect(start.status).toBe(1);
      expect(start.output).toContain("Error: ambiguous site definition: :80");
      expect(start.output).toContain(
        "::error::OpsCrew's shared edge on the server (Caddy and kamal-proxy, in ",
      );
      expect(start.output).toContain(
        "did not accept this app's site (opscrew/runtime/edge/sites/shop.caddy), so the new version was not started, the previous version keeps serving and Caddy keeps the site it had.",
      );
      expect(readFileSync(edgeFile("sites/shop.caddy"), "utf8")).toBe(
        "# the site Caddy serves now\n",
      );
      expect(containers()).toEqual([OLD]);
      expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
      expect(dockerCalls()).not.toContain("--scale");

      resetCalls();
      expect(run(rolling.rollback).output).toContain("still runs the version it had");
    });

    it("removes a first site Caddy refuses, or that the edge could not start with", () => {
      for (const failure of ["CADDY_RELOAD_FAIL", "EDGE_UP_FAIL"]) {
        const start = run(rolling.start, { [failure]: "1" });
        expect(start.status, failure).toBe(1);
        expect(existsSync(edgeFile("sites/shop.caddy")), failure).toBe(false);
        expect(containers(), failure).toEqual([]);
      }
    });

    describe("with two apps on one server", () => {
      const cloudflare = (domain: string, www: boolean) => ({
        provider: "cloudflare",
        domain,
        zone: "example.com",
        proxied: true,
        www,
      });
      const shop = DeployPlanSchema.parse({ ...plan, dns: cloudflare("example.com", true) });
      const blog = withProcesses(
        DeployPlanSchema.parse({
          ...plan,
          app: { ...plan.app, name: "blog" },
          dns: cloudflare("blog.example.com", false),
        }),
        { workers: [{ name: "worker", command: "node worker.js" }] },
      );
      /** Every file of the app's folder on the server, by path. */
      const folder = (app: string) => {
        const root = join(work, "srv", "apps", app);
        const files: Record<string, string> = {};
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else
              files[path.slice(root.length + 1).replaceAll("\\", "/")] = readFileSync(path, "utf8");
          }
        };
        walk(root);
        return files;
      };
      const deploy = (p: DeployPlan) => {
        repo(p);
        const steps = scripts(p);
        const upload = run(steps.upload, { OPSCREW_APP_ENV: `APP=${p.app.name}` }, p.app.name);
        expect(upload.status, upload.output).toBe(0);
        const start = run(steps.start, {}, p.app.name);
        expect(start.status, start.output).toBe(0);
        return steps;
      };

      it("deploys each in its own folder and project, the edge serving both", () => {
        rmSync(join(work, "srv", "apps", "shop"), { recursive: true });
        deploy(shop);
        const shopFolder = folder("shop");
        const shopContainers = file("containers-shop");
        const shopRoute = file("routes/shop");
        const edgeAfterShop = serverEdge();
        resetCalls();

        const blogSteps = deploy(blog);
        // Not a word of blog's scripts names shop's folder or project.
        for (const script of Object.values(blogSteps)) {
          expect(script).not.toMatch(/\/srv\/apps\/shop|\bshop\b/);
        }
        // Every Compose call of blog's deploy is in blog's project or the edge's.
        const projects = file("projects.log")
          .split("\n")
          .map((line) => line.split(" ")[0]);
        expect(new Set(projects)).toEqual(new Set(["blog", "opscrew-edge"]));
        expect(dockerCalls()).not.toContain("shop");

        // shop is untouched: its files, its containers and its route.
        expect(folder("shop")).toEqual(shopFolder);
        expect(file("containers-shop")).toBe(shopContainers);
        expect(file("routes/shop")).toBe(shopRoute);
        // blog runs in its own project, with its own route and hostname on the same edge.
        expect(containers("blog")).toEqual([NEW]);
        expect(routed("blog")).toBe(NEW);
        expect(file("routes/blog")).toMatch(/^blog-app-\d+:3000$/);
        expect(processImages()).toEqual({});
        expect(file("processes-blog")).toMatch(/^p\d+ worker /);
        expect(read("app.env", "blog")).toBe("APP=blog");
        expect(read("app.env")).toBe("APP=shop");
        expect(serverEdge()).toBe(edgeAfterShop);
        expect(readdirSync(join(work, "srv", "edge", "sites")).sort()).toEqual([
          "blog.caddy",
          "shop.caddy",
        ]);
        expect(file("projects.log")).toContain(
          "opscrew-edge exec -T kamal-proxy kamal-proxy deploy blog --target blog-app-",
        );
        expect(file("projects.log")).toMatch(
          /deploy blog --target blog-app-\d+:3000 --host blog\.example\.com --health-check-path/,
        );
      });

      it("gives kamal-proxy the domain and www, redirecting www to the domain", () => {
        expect(scripts(shop).start).toContain(
          " kamal-proxy deploy shop --target \"${name#/}:3000\" --host example.com,www.example.com --canonical-host example.com --health-check-path '/api/health' ",
        );
        expect(scripts(shop).rollback).toContain(
          " --host example.com,www.example.com --canonical-host example.com ",
        );
      });

      it("rolls one app back without touching the other", () => {
        server({ ".env": OLD }, [OLD]);
        deploy(shop);
        const shopFolder = folder("shop");
        const shopContainers = file("containers-shop");
        const steps = scripts(blog);
        repo(blog);
        expect(run(steps.upload, {}, "blog").status).toBe(0);
        writeFileSync(appFile(".env", "blog"), `APP_IMAGE=${OLD}\n`);
        expect(run(steps.start, { CRASH: "worker" }, "blog").status).toBe(1);
        resetCalls();
        const rollback = run(steps.rollback, {}, "blog");
        expect(rollback.output).toContain("restored the previous version");
        expect(routed("blog")).toBe(OLD);
        expect(
          new Set(
            file("projects.log")
              .split("\n")
              .map((l) => l.split(" ")[0]),
          ),
        ).toEqual(new Set(["blog", "opscrew-edge"]));
        expect(folder("shop")).toEqual(shopFolder);
        expect(file("containers-shop")).toBe(shopContainers);
        expect(routed()).toBe(NEW);
      });
    });
  });

  it("refuses an image that is not pinned by digest before touching the server", () => {
    server({ ".env": OLD }, [OLD]);
    const start = run(rolling.start, { IMAGE: "ghcr.io/acme/shop:latest" });
    expect(start.status).not.toBe(0);
    expect(start.output).toContain("digest");
    const rollback = run(rolling.rollback, { IMAGE: "x' ; touch pwned ; '" });
    expect(rollback.status).toBe(1);
    expect(rollback.output).toContain("still runs the version it had");
    expect(existsSync(join(work, "ssh-count"))).toBe(false);
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
  });
});

describe("the deploy job per strategy", () => {
  const deploy = (p: DeployPlan) => jobYaml(renderWorkflow(p, ctx).content, "deploy");

  it("matches the snapshot for rolling", () => {
    expect(deploy(withBuild(plan, "buildpacks"))).toMatchSnapshot();
  });

  it("matches the snapshot for recreate", () => {
    const p = withPlan(withBuild(plan, "buildpacks"), { deploy: { strategy: "recreate" } });
    expect(deploy(p)).toMatchSnapshot();
  });

  it("matches the snapshot with services, workers and cron", () => {
    expect(deploy(components)).toMatchSnapshot();
  });

  it("drains the old copy for drainSeconds", () => {
    const p = withPlan(plan, { deploy: { drainSeconds: 90 } });
    expect(deploy(p)).toContain("--drain-timeout 90s");
  });

  it("lets every request run for 300 seconds, in the deploy and in the rollback", () => {
    for (const strategy of ["rolling", "recreate"] as const) {
      const job = deploy(withPlan(plan, { deploy: { strategy } }));
      const calls = job.split("\n").filter((line) => line.includes("kamal-proxy deploy"));
      expect(calls, strategy).toHaveLength(2);
      // kamal-proxy reads no stdin: the server script itself arrives on it.
      for (const call of calls) expect(call).toContain(" --target-timeout 300s < /dev/null; then");
    }
  });

  /** The builder hint: what follows the port sentence of the failed health check. */
  const hint = (p: DeployPlan) =>
    /answers \/api\/health\. ([^']*)'/.exec(deploy(p))?.[1] ?? "no hint found";
  const RERUN = "then run opscrew design, opscrew adapt and opscrew provision.";

  it("names the builder an automatic choice would pick and the settings that switch to it", () => {
    // Design keeps a builder only with app.build.chosen: user, so the hint names both settings.
    const SWITCH =
      "OpsCrew would choose Buildpacks: set app.build.builder: buildpacks and app.build.chosen: user in opscrew/plan.yaml,";
    const user = withBuild(plan, "railpack", { chosen: "user", automatic: "buildpacks" });
    expect(hint(user)).toBe(
      `It was built with Railpack (app.build.builder: railpack in opscrew/plan.yaml). ${SWITCH} ${RERUN}`,
    );
    // An own Dockerfile is chosen automatically: without chosen: user, design would keep it.
    const own = withBuild(plan, "own-dockerfile", { automatic: "buildpacks" });
    expect(own.app.build?.chosen).toBe("auto");
    expect(hint(own)).toBe(
      `It was built with your own Dockerfile (app.build.builder: own-dockerfile in opscrew/plan.yaml). ${SWITCH} ${RERUN}`,
    );
    for (const p of [user, own]) expect(hint(p)).not.toContain("generated-dockerfile");
  });

  it("names only the builder when it is the one OpsCrew chooses", () => {
    const same = withBuild(plan, "buildpacks", { automatic: "buildpacks" });
    expect(hint(same)).toBe(
      "It was built with Buildpacks, the builder OpsCrew chooses for this app (app.build.builder: buildpacks in opscrew/plan.yaml).",
    );
    const unknown = withBuild(plan, "railpack", { chosen: "user" });
    expect(hint(unknown)).toBe(
      "It was built with Railpack (app.build.builder: railpack in opscrew/plan.yaml).",
    );
    expect(hint(plan)).toBe(
      `It was built from Dockerfile; to let OpsCrew choose a builder, ${RERUN.replace("then ", "")}`,
    );
  });

  it("names app.port in opscrew/plan.yaml for the port the health check uses", () => {
    expect(deploy(plan)).toContain(
      "within 60 seconds, so OpsCrew removed it. It received no traffic: the previous version keeps serving. Check that the app listens on port 3000 (app.port in opscrew/plan.yaml, passed to the app as PORT) and answers /api/health.",
    );
  });
});
