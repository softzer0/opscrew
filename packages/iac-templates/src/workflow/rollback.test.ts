// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testServices } from "../__fixtures__/plans";
import { withServices } from "../catalog/__fixtures__/plans";
import type { RenderContext } from "../types";
import { jobYaml, NIGHTLY, withBuild, withPlan, withProcesses } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";
import { type ServiceInitStep, switchCommands } from "./switch";

/*
 * Runs the generated "Start the new version" and "Roll back" scripts in bash against a fake server:
 * `ssh` runs the server script with `sh` locally, /srv/app mapped to a temp dir, `scp` only logs
 * its arguments, and `docker` is a
 * fake that keeps the app's containers in a file and plays kamal-proxy, which routes to a container
 * unless its image is in UNHEALTHY.
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
  '    printf "%s\\n" "${script//\\/srv\\/app/$WORK/app}" | sh -s -- "$@"',
  "  else",
  '    sh -c "${*//\\/srv\\/app/$WORK/app}"',
  "  fi",
  "}",
  'scp() { echo "scp $*" >> "$WORK/scp.log"; }',
].join("\n");

/**
 * The fake `docker`: logs every call; `compose` and kamal-proxy act on $WORK/containers. The
 * workers and cron named in PROCESSES live in $WORK/processes, one container each unless REPLICAS
 * says otherwise (`worker=2`), as `p<n> <service> <image> <status> <restarts>`; they are recreated
 * only when their image changed, as Compose does, and `compose stop` exits them. Any other
 * `compose exec` is a setup step: it fails when its words are a line of $WORK/failing.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  'echo "docker $*" >> "$WORK/docker.log"',
  'state="$WORK/containers"',
  'processes="$WORK/processes"',
  'touch "$state" "$processes" "$WORK/failing"',
  'image_now() { echo "${APP_IMAGE:-$(sed -n "s/^APP_IMAGE=//p" .env)}"; }',
  'next_id() { local n; n="$(cat "$WORK/next" 2>/dev/null || echo 1)"; echo $(( n + 1 )) > "$WORK/next"; echo "$n"; }',
  "start_one() {",
  '  local n; n="$(next_id)"',
  '  local image; image="$(image_now)"',
  '  local status=running; [[ " ${EXITED:-} " == *" $image "* ]] && status=exited',
  '  echo "c$n shop-app-$n $image $status" >> "$state"',
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
  '  "compose up")',
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
  '    if [[ "$4" != proxy ]]; then',
  '      if grep -qxF "${*:5}" "$WORK/failing"; then echo "setup output for ${*:5}"; exit 1; fi',
  "      exit 0",
  "    fi",
  '    target=""; prev=""; for arg in "$@"; do [[ "$prev" == --target ]] && target="$arg"; prev="$arg"; done',
  '    image="$(awk -v n="${target%:*}" \'$2 == n { print $3 }\' "$state")"',
  '    status="$(awk -v n="${target%:*}" \'$2 == n { print $4 }\' "$state")"',
  '    if [[ "$status" != running || " ${UNHEALTHY:-} " == *" $image "* ]]; then',
  '      echo "Error: target failed to become healthy within configured timeout (60s)" >&2; exit 1',
  "    fi",
  '    echo "$target" > "$WORK/routed" ;;',
  '  "inspect --format")',
  '    if [[ "${@: -1}" == p* ]]; then',
  '      awk -v id="${@: -1}" -v f="$3" \'$1 == id { print (f == "{{.RestartCount}}" ? $5 : $4 ":" $5) }\' "$processes"',
  '    else awk -v id="${@: -1}" \'$1 == id { print "/" $2 }\' "$state" | grep .; fi ;;',
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
  'touch "$WORK/processes"',
  'awk -v crash=" ${CRASH:-} " -v stop=" ${STOP:-} " \'{',
  "  k[$2]++",
  '  if (index(crash, " " $2 " ") || index(crash, " " $2 "/" k[$2] " ")) $5 = $5 + 1',
  '  if (index(stop, " " $2 " ")) $4 = "exited"',
  "  print",
  '}\' "$WORK/processes" > "$WORK/processes.tmp" && mv "$WORK/processes.tmp" "$WORK/processes"',
].join("\n");

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

function run(script: string, env: Record<string, string> = {}) {
  const result = spawnSync("bash", ["-c", `${PRELUDE}\n${script}`], {
    cwd: join(work, "app"),
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

const appFile = (name: string) => join(work, "app", name);
const read = (name: string) =>
  existsSync(appFile(name)) ? readFileSync(appFile(name), "utf8").trim() : undefined;
const file = (name: string) =>
  existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8").trim() : "";
/** `.env` files with the given images, and the app containers running `running`. */
const server = (files: Record<string, string>, running: readonly string[] = []) => {
  for (const [name, image] of Object.entries(files)) {
    writeFileSync(appFile(name), `APP_IMAGE=${image}\n`);
  }
  writeFileSync(
    join(work, "containers"),
    running.map((image, i) => `c${90 + i} shop-app-${90 + i} ${image} running\n`).join(""),
  );
};
/** The images of the app containers that exist. */
const containers = () =>
  file("containers")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[2]);
/** The image of the container kamal-proxy sends traffic to. */
const routed = () => {
  const name = file("routed").split(":")[0];
  return file("containers")
    .split("\n")
    .find((line) => line.split(" ")[1] === name)
    ?.split(" ")[2];
};
const resetCalls = () => {
  rmSync(join(work, "ssh-count"), { force: true });
  rmSync(join(work, "docker.log"), { force: true });
};
const dockerCalls = () => file("docker.log");
/** The image each worker and cron container runs, by service. */
const processImages = () =>
  Object.fromEntries(
    file("processes")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ").slice(1, 3)),
  );
/** The status of each worker and cron container, by service. */
const processStatus = () =>
  Object.fromEntries(
    file("processes")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.split(" ")[1], line.split(" ")[3]]),
  );
/** The workers and cron of an earlier deploy (`services`, default all three), running `image`. */
const runningProcesses = (image: string, services = ["worker", "beat", "cron"]) =>
  writeFileSync(
    join(work, "processes"),
    services.map((s, i) => `p${80 + i} ${s} ${image} running 0\n`).join(""),
  );

// Each test runs bash several times; on Windows (Git Bash) under a parallel `pnpm check` that
// can take longer than the default 5 seconds.
describe.skipIf(!hasBash)("deploy start and rollback scripts", { timeout: 30_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-rollback-")).replaceAll("\\", "/");
    mkdirSync(join(work, "app"));
    mkdirSync(join(work, "tmp"));
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "docker"), `${FAKE_DOCKER}\n`, { mode: 0o755 });
    writeFileSync(join(work, "bin", "sleep"), `${FAKE_SLEEP}\n`, { mode: 0o755 });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  describe("rolling", () => {
    it("starts a second copy, routes to it once healthy, then removes the old one", () => {
      server({ ".env": OLD, ".env.previous": OLDER }, [OLD]);
      const start = run(rolling.start);
      expect(start.status, start.output).toBe(0);
      expect(containers()).toEqual([NEW]);
      expect(routed()).toBe(NEW);
      expect(file("routed")).toBe("shop-app-1:3000");
      expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
      expect(read(".env.previous")).toBe(`APP_IMAGE=${OLD}`);
      expect(file("output")).toBe(`previous=${OLD}`);
      const calls = dockerCalls();
      expect(calls).toContain("docker compose up -d --no-deps --no-recreate --scale app=2 app");
      expect(calls).toContain(
        "docker compose exec -T proxy kamal-proxy deploy app --target shop-app-1:3000 --health-check-path /api/health --deploy-timeout 60s --drain-timeout 30s --target-timeout 300s",
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
      writeFileSync(join(work, "routed"), "shop-app-90:3000\n");
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
        "docker compose up -d --no-deps --wait --remove-orphans db proxy caddy",
        "docker compose up -d --no-deps --no-recreate --scale app=2 app",
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
      expect(dockerCalls()).toContain("docker compose up -d --no-deps app");
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
        const i = calls.findIndex((line) => line.startsWith(prefix));
        expect(i, prefix).toBeGreaterThan(-1);
        return i;
      };
      const order = [
        at("docker compose pull"),
        at("docker compose up -d --no-deps --wait --remove-orphans db cache proxy caddy"),
        at("docker compose run --rm --no-deps -T release"),
        at("docker compose up -d --no-deps --no-recreate --scale app=2 app"),
        at("docker compose exec -T proxy kamal-proxy deploy app"),
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
      // The fake ssh maps /srv/app to the test's folder.
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
      const workers = file("processes")
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
        "docker compose up -d --no-deps --wait --remove-orphans db cache proxy caddy",
        "docker compose up -d --no-deps --no-recreate --scale app=2 app",
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
        file("processes")
          .split("\n")
          .map((line) => line.split(" ")[0]),
      ).toEqual(["p80", "p81", "p82"]);
    });

    it("starts no worker check without workers or cron", () => {
      expect(rolling.start).not.toContain("sleep 30");
      expect(rolling.rollback).not.toContain("--no-deps worker");
    });

    it("replaces a SQLite app's web container instead of running two", () => {
      const sqlite = scripts(
        DeployPlanSchema.parse({
          ...plan,
          deploy: { strategy: "recreate" },
          storage: { sqlite: { dir: "storage" } },
        }),
      );
      expect(sqlite.start).toContain("docker compose up -d --no-deps app\n");
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
      expect(at("--remove-orphans db proxy caddy")).toBeLessThan(at("/garage layout show"));
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
      // The fake ssh maps /srv/app to the test's folder.
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
        `  if ! (umask 077; (set -a; . ./garage.env; set +a; docker compose exec -T garage '/garage' 'key' 'import' '--yes' "\${GARAGE_KEY_ID}" "\${GARAGE_KEY_SECRET}" < /dev/null) > /srv/app/init.log 2>&1); then`,
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

    it("copies the services' settings files and the crontab next to compose.yaml", () => {
      expect(run(scripts(services).upload).status).toBe(0);
      expect(file("scp.log")).toMatch(
        / opscrew\/runtime\/compose\.yaml opscrew\/runtime\/Caddyfile opscrew\/runtime\/services opscrew\/runtime\/crontab deploy@203\.0\.113\.10:\/srv\/app\/$/,
      );
      expect(file("scp.log")).toMatch(/^scp -r /);
    });

    it("copies only compose.yaml and the Caddyfile when the plan has nothing else", () => {
      expect(run(rolling.upload).status).toBe(0);
      expect(file("scp.log")).toMatch(
        / opscrew\/runtime\/compose\.yaml opscrew\/runtime\/Caddyfile deploy@203\.0\.113\.10:\/srv\/app\/$/,
      );
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
