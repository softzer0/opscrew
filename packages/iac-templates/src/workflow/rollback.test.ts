// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { RenderContext } from "../types";
import { renderWorkflow } from "./index";

/*
 * Runs the generated "Start the new version" and "Roll back" scripts in bash against a fake server:
 * `ssh` runs the remote command locally with /srv/app mapped to a temp dir, and `docker` only logs.
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
const deploySteps: Step[] = parse(renderWorkflow(plan, ctx).content).jobs.deploy.steps;
const startScript = deploySteps.find((s) => s.id === "start")?.run ?? "";
const rollbackScript = deploySteps.find((s) => s.name?.startsWith("Roll back"))?.run ?? "";
const releasePlan = DeployPlanSchema.parse({
  ...plan,
  app: { ...plan.app, releaseCommand: "python manage.py migrate --noinput" },
});
const releaseStartScript =
  (parse(renderWorkflow(releasePlan, ctx).content).jobs.deploy.steps as Step[]).find(
    (s) => s.id === "start",
  )?.run ?? "";

const NEW = `ghcr.io/acme/shop@sha256:${"b".repeat(64)}`;
const OLD = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;
const OLDER = `ghcr.io/acme/shop@sha256:${"9".repeat(64)}`;

const PRELUDE = [
  "ssh() {",
  '  local cmd="${!#}" n',
  '  n=$(( $(cat "$WORK/ssh-count" 2>/dev/null || echo 0) + 1 ))',
  '  echo "$n" > "$WORK/ssh-count"',
  '  if [[ "$n" == "${SSH_FAIL_AT:-0}" ]]; then echo "ssh: connect to host failed" >&2; return 255; fi',
  '  bash -c "${cmd//\\/srv\\/app/$WORK/app}"',
  "}",
  "docker() {",
  '  echo "docker $*" >> "$WORK/docker.log"',
  '  case "$1 $2" in',
  '    "login ghcr.io") cat > /dev/null; [[ -z "${DOCKER_LOGIN_FAIL:-}" ]] ;;',
  '    "compose up") [[ -z "${COMPOSE_UP_FAIL:-}" ]] || return 1 ;;',
  '    "compose run") echo "run image=${APP_IMAGE:-}" >> "$WORK/docker.log"',
  '      if [[ -n "${RELEASE_FAIL:-}" ]]; then echo "django.db.utils.OperationalError: no such table"; return 3; fi ;;',
  "    *) return 0 ;;",
  "  esac",
  "}",
  "export -f docker",
].join("\n");

let work = "";

function bashWorks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "opscrew-bash-")).replaceAll("\\", "/");
  try {
    const probe = spawnSync("bash", ["-c", 'cd "$WORK" && echo ok'], {
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
    env: {
      ...process.env,
      WORK: work,
      HOST: "203.0.113.10",
      IMAGE: NEW,
      GITHUB_ACTOR: "octocat",
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
const server = (files: Record<string, string>) => {
  for (const [name, image] of Object.entries(files)) {
    writeFileSync(appFile(name), `APP_IMAGE=${image}\n`);
  }
};
const resetCalls = () => {
  rmSync(join(work, "ssh-count"), { force: true });
  rmSync(join(work, "docker.log"), { force: true });
};
const dockerCalls = () =>
  existsSync(join(work, "docker.log")) ? readFileSync(join(work, "docker.log"), "utf8") : "";

// Each test runs bash several times; on Windows (Git Bash) under a parallel `pnpm check` that
// can take longer than the default 5 seconds.
describe.skipIf(!hasBash)("deploy start and rollback scripts", { timeout: 30_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-rollback-")).replaceAll("\\", "/");
    mkdirSync(join(work, "app"));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("restores the version that was running when the new one fails its health check", () => {
    server({ ".env": OLD, ".env.previous": OLDER });
    expect(run(startScript).status).toBe(0);
    expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
    expect(read(".env.previous")).toBe(`APP_IMAGE=${OLD}`);

    resetCalls();
    const rollback = run(rollbackScript);
    expect(rollback.status).toBe(1);
    expect(rollback.output).toContain("restored the previous version");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).toContain("docker compose up -d --remove-orphans");
  });

  it("leaves the running version alone when the server was never reached", () => {
    server({ ".env": OLD, ".env.previous": OLDER });
    expect(run(startScript, { SSH_FAIL_AT: "1" }).status).not.toBe(0);

    resetCalls();
    const rollback = run(rollbackScript);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(rollback.output).toContain("still runs the version it had");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).toBe("");
  });

  it("leaves the running version alone when the registry login fails", () => {
    server({ ".env": OLD, ".env.previous": OLDER });
    expect(run(startScript, { DOCKER_LOGIN_FAIL: "1" }).status).not.toBe(0);
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);

    resetCalls();
    const rollback = run(rollbackScript);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).toBe("");
  });

  it("restores the previous version when Compose fails to start the new one", () => {
    server({ ".env": OLD });
    expect(run(startScript, { COMPOSE_UP_FAIL: "1" }).status).not.toBe(0);
    expect(dockerCalls()).toContain("docker logout ghcr.io");

    resetCalls();
    const rollback = run(rollbackScript);
    expect(rollback.output).toContain("restored the previous version");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
  });

  it("says there is nothing to restore when the first deploy fails", () => {
    expect(run(startScript).status).toBe(0);
    expect(read(".env.previous")).toBeUndefined();

    resetCalls();
    const rollback = run(rollbackScript);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(rollback.output).toContain("no earlier version");
    expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
  });

  it("drops a stale saved version when there was nothing running", () => {
    server({ ".env.previous": OLDER });
    expect(run(startScript).status).toBe(0);
    expect(read(".env.previous")).toBeUndefined();
  });

  it("reports when the server cannot be reached for the rollback", () => {
    server({ ".env": NEW, ".env.previous": OLD });
    const rollback = run(rollbackScript, { SSH_FAIL_AT: "1" });
    expect(rollback.status).toBe(1);
    expect(rollback.output).toContain("could not restore");
    expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
  });

  it("runs the release command in the new image before switching to it", () => {
    server({ ".env": OLD });
    const start = run(releaseStartScript);
    expect(start.status).toBe(0);
    expect(read(".env")).toBe(`APP_IMAGE=${NEW}`);
    expect(read(".env.previous")).toBe(`APP_IMAGE=${OLD}`);
    const calls = dockerCalls().split("\n");
    const at = (prefix: string) => calls.findIndex((line) => line.startsWith(prefix));
    expect(at("docker compose pull")).toBeGreaterThan(-1);
    expect(at("docker compose pull")).toBeLessThan(at("docker compose up -d --wait db"));
    expect(at("docker compose up -d --wait db")).toBeLessThan(at("docker compose run"));
    expect(at("docker compose run")).toBeLessThan(at("docker compose up -d --remove-orphans"));
    expect(calls).toContain("docker compose run --rm --no-deps -T release");
    expect(calls).toContain(`run image=${NEW}`);
  });

  it("stops before the switch when the release command fails, keeping the running version", () => {
    server({ ".env": OLD, ".env.previous": OLDER });
    const start = run(releaseStartScript, { RELEASE_FAIL: "1" });
    expect(start.status).not.toBe(0);
    // The release output can quote rows, so it stays on the server, never in the workflow log.
    expect(start.output).not.toContain("no such table");
    expect(read("release.log")).toContain("no such table");
    expect(start.output).toContain("::error::The release command");
    expect(start.output).not.toContain("203.0.113.10");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).not.toContain("--remove-orphans");
    expect(dockerCalls()).toContain("docker logout ghcr.io");

    resetCalls();
    const rollback = run(rollbackScript);
    expect(rollback.status).toBe(1);
    expect(rollback.output).not.toContain("restored");
    expect(rollback.output).toContain("still runs the version it had");
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
    expect(dockerCalls()).toBe("");
  });

  it("refuses an image that is not pinned by digest before touching the server", () => {
    server({ ".env": OLD });
    const start = run(startScript, { IMAGE: "ghcr.io/acme/shop:latest" });
    expect(start.status).not.toBe(0);
    expect(start.output).toContain("digest");
    const rollback = run(rollbackScript, { IMAGE: "x' ; touch pwned ; '" });
    expect(rollback.status).toBe(1);
    expect(rollback.output).toContain("still runs the version it had");
    expect(existsSync(join(work, "ssh-count"))).toBe(false);
    expect(read(".env")).toBe(`APP_IMAGE=${OLD}`);
  });
});
