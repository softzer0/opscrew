// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { RenderContext } from "../types";
import { jobYaml, withBuild, withPlan } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";

/*
 * Runs the generated "Start the new version" and "Roll back" scripts in bash against a fake server:
 * `ssh` runs the server script with `sh` locally, /srv/app mapped to a temp dir, and `docker` is a
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
  services: { postgres: true, redis: false },
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
    start: steps.find((s) => s.id === "start")?.run ?? "",
    rollback: steps.find((s) => s.name?.startsWith("Roll back"))?.run ?? "",
  };
}
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
].join("\n");

/** The fake `docker`: logs every call; `compose` and kamal-proxy act on $WORK/containers. */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  'echo "docker $*" >> "$WORK/docker.log"',
  'state="$WORK/containers"',
  'touch "$state"',
  "start_one() {",
  '  local n; n="$(cat "$WORK/next" 2>/dev/null || echo 1)"; echo $(( n + 1 )) > "$WORK/next"',
  '  local image="${APP_IMAGE:-$(sed -n "s/^APP_IMAGE=//p" .env)}"',
  '  local status=running; [[ " ${EXITED:-} " == *" $image "* ]] && status=exited',
  '  echo "c$n shop-app-$n $image $status" >> "$state"',
  "}",
  'case "$1 $2" in',
  '  "login ghcr.io") cat > /dev/null; [[ -z "${DOCKER_LOGIN_FAIL:-}" ]] ;;',
  '  "compose up")',
  '    [[ -z "${COMPOSE_UP_FAIL:-}" ]] || exit 1',
  '    [[ "${@: -1}" == app ]] || exit 0',
  '    if [[ " $* " == *" --scale "* ]]; then',
  '      want="$(echo " $* " | sed -n "s/.* --scale app=\\([0-9]*\\) .*/\\1/p")"',
  '      while (( $(wc -l < "$state") < want )); do start_one; done',
  "    else",
  '      : > "$state"; start_one',
  "    fi ;;",
  '  "compose ps")',
  '    if [[ " $* " == *" -aq "* ]]; then cut -d " " -f 1 "$state"',
  '    else awk \'$4 == "running" { print $1 }\' "$state"; fi ;;',
  '  "compose run") cat > /dev/null; echo "run image=${APP_IMAGE:-}" >> "$WORK/docker.log"',
  '    if [[ -n "${RELEASE_FAIL:-}" ]]; then echo "django.db.utils.OperationalError: no such table"; exit 3; fi ;;',
  '  "compose exec")',
  "    cat > /dev/null",
  '    target=""; prev=""; for arg in "$@"; do [[ "$prev" == --target ]] && target="$arg"; prev="$arg"; done',
  '    image="$(awk -v n="${target%:*}" \'$2 == n { print $3 }\' "$state")"',
  '    status="$(awk -v n="${target%:*}" \'$2 == n { print $4 }\' "$state")"',
  '    if [[ "$status" != running || " ${UNHEALTHY:-} " == *" $image "* ]]; then',
  '      echo "Error: target failed to become healthy within configured timeout (60s)" >&2; exit 1',
  "    fi",
  '    echo "$target" > "$WORK/routed" ;;',
  '  "inspect --format") awk -v id="${@: -1}" \'$1 == id { print "/" $2 }\' "$state" | grep . ;;',
  "  *)",
  '    if [[ "$1" == rm ]]; then grep -v "^${@: -1} " "$state" > "$state.tmp" || true; mv "$state.tmp" "$state"; fi ;;',
  "esac",
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

// Each test runs bash several times; on Windows (Git Bash) under a parallel `pnpm check` that
// can take longer than the default 5 seconds.
describe.skipIf(!hasBash)("deploy start and rollback scripts", { timeout: 30_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-rollback-")).replaceAll("\\", "/");
    mkdirSync(join(work, "app"));
    mkdirSync(join(work, "tmp"));
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "docker"), `${FAKE_DOCKER}\n`, { mode: 0o755 });
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

  it("names the builder an automatic choice would pick and the one setting that switches to it", () => {
    const user = withBuild(plan, "railpack", { chosen: "user", automatic: "buildpacks" });
    expect(hint(user)).toBe(
      `It was built with Railpack (app.build.builder: railpack in opscrew/plan.yaml). OpsCrew would choose Buildpacks: set app.build.builder: buildpacks in opscrew/plan.yaml, ${RERUN}`,
    );
    const own = withBuild(plan, "own-dockerfile", { automatic: "buildpacks" });
    expect(hint(own)).toBe(
      `It was built with your own Dockerfile (app.build.builder: own-dockerfile in opscrew/plan.yaml). OpsCrew would choose Buildpacks: set app.build.builder: buildpacks in opscrew/plan.yaml, ${RERUN}`,
    );
    // Neither app.build.chosen nor the other builders.
    for (const p of [user, own]) {
      expect(hint(p)).not.toContain("chosen");
      expect(hint(p)).not.toContain("generated-dockerfile");
    }
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
