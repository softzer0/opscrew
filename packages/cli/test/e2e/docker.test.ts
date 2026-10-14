/**
 * Local Docker pass over every app in `examples/` (T823, FR-811): each example with an
 * `expected.json` is materialised into a temp git repository and driven through the real CLI
 * in-process, offline and without a model (`analyze --no-ai` → `interview --answers` → `design` →
 * `adapt --no-ai --no-push`, like `examples.test.ts`). Then the image is built from the Dockerfile
 * now in the repository, the container is started the way the production Compose file starts it
 * (the plan's port, placeholder connection URLs, all capabilities dropped) and the plan's health
 * path (static apps: also `/`) must answer HTTP 200 within two minutes. When the plan leaves the
 * health route to the Code-change agent (a pending `health-endpoint` change, which `--no-ai`
 * does not write), any HTTP answer on that path passes with a note. A plan with a release command
 * (`app.releaseCommand`, database migrations) is started like the deploy workflow starts it
 * instead: OpsCrew's Compose file, the backing services, the `release` service run once, then the
 * app, which must also answer 200 on a route that writes to the database (`DATABASE_ROUTES`).
 *
 * It pulls base images and packages, so it runs only on request: OPSCREW_DOCKER_TESTS=1 with a
 * running Docker daemon (skipped otherwise). OPSCREW_DOCKER_EXAMPLES=a,b limits the run to those
 * examples. Containers and images are always removed.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { FakeAgentRuntime } from "@opscrew/core/testing";
import { renderCompose } from "@opscrew/iac-templates";
import { ArchitectureSchema, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  EXAMPLES_DIR,
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import { type Expected, readExpected, ScriptedApprovals } from "./support";

const DOCKER = findExecutable("docker");
const TEN_MINUTES = 600_000;
const TWO_MINUTES = 120_000;
const STEP_TIMEOUT = 180_000;

/** Every example with an `expected.json`. */
const ALL_EXAMPLES = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(path.join(EXAMPLES_DIR, name, "expected.json")))
  .sort();

/** OPSCREW_DOCKER_EXAMPLES=a,b, or undefined for every example. */
const REQUESTED = process.env.OPSCREW_DOCKER_EXAMPLES?.split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const EXAMPLES =
  REQUESTED === undefined || REQUESTED.length === 0
    ? ALL_EXAMPLES
    : ALL_EXAMPLES.filter((name) => REQUESTED.includes(name));

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  if (GIT === undefined) return "git is not installed";
  if (DOCKER === undefined) return "docker is not installed";
  const info = spawnSync(DOCKER, ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 30_000,
    stdio: "ignore",
  });
  return info.status === 0 ? undefined : "the Docker daemon is not running (`docker info` failed)";
}

const SKIP = skipReason();
if (SKIP !== undefined) console.warn(`Skipping the local Docker pass over examples/: ${SKIP}.`);

const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
/** Everything this file started or built, removed in afterAll even when a test failed. */
const containers = new Set<string>();
const images = new Set<string>();
/** Compose projects (name → compose file) started by this file. */
const composeProjects = new Map<string, string>();

async function docker(args: string[], timeoutMs = 60_000) {
  return runner.run(DOCKER ?? "docker", args, { timeoutMs });
}

async function compose(name: string, file: string, args: string[], timeoutMs = TWO_MINUTES) {
  return docker(["compose", "-p", name, "-f", file, ...args], timeoutMs);
}

/** Stops a Compose project and removes its containers, network and volumes. */
async function composeDown(name: string): Promise<void> {
  const file = composeProjects.get(name);
  if (file === undefined) return;
  await compose(name, file, ["down", "-v", "--remove-orphans"]);
  composeProjects.delete(name);
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name]);
  containers.delete(name);
}

async function removeImage(tag: string): Promise<void> {
  await docker(["rmi", "-f", tag]);
  images.delete(tag);
}

/** The last `lines` lines of a log (build output, container output). */
function tail(text: string, lines = 60): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/**
 * Interview answers: one small production setup for every example; a monorepo picks the app its
 * `expected.json` names. Everything else (kept external services, domain) uses the defaults.
 */
function answersFor(expected: Expected): Record<string, unknown> {
  return {
    ...(expected.chosenApp !== undefined ? { appDir: expected.chosenApp.appDir } : {}),
    expectedMonthlyUsers: "<1k",
    budgetMonthly: "20 EUR",
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
  };
}

/**
 * A placeholder value for an environment variable the plan names: connection URLs point at a
 * port nothing listens on, so an app that connects at start fails fast instead of hanging; host
 * lists name this computer, as provision fills them with the deployment's host; every other value
 * is a plain word. Never a secret-shaped literal.
 */
function placeholder(name: string): string {
  if (/(?:^|_)ALLOWED_HOSTS$/.test(name)) return "localhost,127.0.0.1";
  if (/(?:^|_)CSRF_TRUSTED_ORIGINS$/.test(name)) return "http://localhost,http://127.0.0.1";
  if (name === "DATABASE_URL") return "postgres://u:p@127.0.0.1:5/none";
  if (name === "REDIS_URL") return "redis://127.0.0.1:5";
  if (/_(?:URL|URI)$/.test(name)) return "http://127.0.0.1:5/";
  return "opscrew-placeholder";
}

/**
 * Paths that write to the database, so they answer HTTP 200 only once the release command has
 * created the tables (checked in addition to the health path).
 */
const DATABASE_ROUTES: Readonly<Record<string, string>> = {
  "django-postgres": "/",
  "express-drizzle": "/",
  "fastapi-sqlmodel": "/",
  "koa-knex": "/",
  "nestjs-typeorm": "/",
};

/**
 * The Compose file OpsCrew deploys (`renderCompose`), adapted to this computer: the data
 * directories under /srv become named volumes, the app's port is published on 127.0.0.1 and
 * Caddy is left out (TLS and the proxy are not under test). The `release` service is unchanged.
 */
function localCompose(plan: DeployPlan): string {
  const rendered = renderCompose(plan, {
    opscrewVersion: "0.0.0-test",
    github: { owner: "opscrew-test", repo: "app" },
    deploySshPublicKey: "ssh-ed25519 AAAA opscrew-test",
  });
  const doc = parse(rendered.content) as {
    services: Record<string, { volumes?: string[]; ports?: string[] }>;
    volumes: Record<string, unknown>;
  };
  delete doc.services.caddy;
  doc.volumes = {};
  for (const service of Object.values(doc.services)) {
    service.volumes = service.volumes?.map((volume) => {
      const match = /^\/srv\/data\/([\w-]+):(.+)$/.exec(volume);
      if (!match?.[1]) return volume;
      doc.volumes[match[1]] = {};
      return `${match[1]}:${match[2]}`;
    });
    if (service.volumes === undefined) delete service.volumes;
  }
  const app = doc.services.app;
  if (app) app.ports = [`127.0.0.1::${plan.app.port}`];
  return stringify(doc, { lineWidth: 0 });
}

/** What the repository looks like after `adapt`: enough to build and start the app. */
interface Prepared {
  plan: DeployPlan;
  /** Variables Docker gets as build arguments (client-exposed, baked into the bundle). */
  buildEnv: string[];
  appKind: string;
}

describe.skipIf(SKIP !== undefined)(
  SKIP === undefined
    ? "local Docker pass over examples/"
    : `local Docker pass over examples/ (skipped: ${SKIP})`,
  () => {
    afterAll(async () => {
      for (const name of [...composeProjects.keys()]) await composeDown(name);
      for (const name of [...containers]) await removeContainer(name);
      for (const tag of [...images]) await removeImage(tag);
    }, TWO_MINUTES);

    it("OPSCREW_DOCKER_EXAMPLES names only examples that exist", () => {
      const unknown = (REQUESTED ?? []).filter((name) => !ALL_EXAMPLES.includes(name));
      expect(unknown, `known examples: ${ALL_EXAMPLES.join(", ")}`).toEqual([]);
      expect(EXAMPLES.length, "examples to run").toBeGreaterThan(0);
    });

    describe.each(EXAMPLES)("example %s", (example) => {
      const stamp = `${Date.now()}-${process.pid}`;
      const tag = `opscrew-test/${example}:${stamp}`;
      const container = `opscrew-test-${example}-${stamp}`;
      const runtime = new FakeAgentRuntime();
      const approvals = new ScriptedApprovals();
      let project: TempProject | undefined;
      let prepared: Prepared | undefined;
      let built = false;

      /**
       * Runs `opscrew <args>` in the project and returns what it printed; fails with that output
       * on a non-zero exit.
       */
      async function opscrew(...args: string[]): Promise<string> {
        if (project === undefined) throw new Error("no project");
        const ctx = projectContext(project, { services: { runtime, approvalHandler: approvals } });
        const code = await run(ctx, ...args);
        const output = ctx.output + ctx.errors;
        if (code !== 0) {
          throw new Error(
            `${example}: \`opscrew ${args.join(" ")}\` exited with ${code}:\n${tail(output)}`,
          );
        }
        return output;
      }

      /**
       * Starts the app the way the deploy workflow does when the plan has a release command:
       * OpsCrew's Compose file with `.env` naming the image, the backing services up and healthy,
       * the `release` service run once in a one-off container (a failure fails the test with its
       * output), then the app. Values are placeholders except the database connection, which uses
       * a password generated for this run. Returns the app container's name.
       */
      async function deployWithRelease(plan: DeployPlan, env: Map<string, string>) {
        if (project === undefined) throw new Error("no project");
        const server = path.join(project.dir, "server");
        await mkdir(server, { recursive: true });
        const file = path.join(server, "compose.yaml");
        await writeFile(file, localCompose(plan));
        await writeFile(path.join(server, ".env"), `APP_IMAGE=${tag}\n`);
        const appEnv = new Map(env);
        appEnv.delete("PORT");
        if (plan.services.postgres) {
          const password = randomBytes(16).toString("hex");
          await writeFile(
            path.join(server, "db.env"),
            `POSTGRES_USER=app\nPOSTGRES_DB=app\nPOSTGRES_PASSWORD=${password}\n`,
          );
          appEnv.set("DATABASE_URL", `postgresql://app:${password}@db:5432/app`);
        }
        if (plan.services.redis) appEnv.set("REDIS_URL", "redis://cache:6379");
        await writeFile(
          path.join(server, "app.env"),
          [...appEnv].map(([name, value]) => `${name}=${value}\n`).join(""),
        );
        composeProjects.set(container, file);

        const backing = [
          ...(plan.services.postgres ? ["db"] : []),
          ...(plan.services.redis ? ["cache"] : []),
        ];
        if (backing.length > 0) {
          const up = await compose(container, file, ["up", "-d", "--wait", ...backing]);
          if (up.exitCode !== 0) {
            throw new Error(`${example}: the backing services did not start:\n${tail(up.stderr)}`);
          }
        }
        const ran = await compose(
          container,
          file,
          ["run", "--rm", "--no-deps", "-T", "release"],
          TEN_MINUTES,
        );
        if (ran.exitCode !== 0) {
          throw new Error(
            `${example}: the release command \`${plan.app.releaseCommand}\` failed (exit ${ran.exitCode}):\n${tail(`${ran.stdout}\n${ran.stderr}`)}`,
          );
        }
        console.info(`${example}: release command output:\n${tail(ran.stdout, 20)}`);
        const started = await compose(container, file, ["up", "-d", "app"]);
        if (started.exitCode !== 0) {
          throw new Error(`${example}: docker compose up app failed:\n${tail(started.stderr)}`);
        }
        return `${container}-app-1`;
      }

      beforeAll(async () => {
        project = await tempProject(example);
        const { env, root, dir } = project;
        // A repository with one commit and a bare `origin` (adapt commits but never pushes).
        await git(env, root, "init", "-q", "-b", "main");
        await git(env, root, "add", "-A");
        await git(env, root, "commit", "-q", "-m", "initial import");
        const bare = path.join(dir, "origin.git");
        await git(env, dir, "init", "-q", "--bare", bare);
        await git(env, root, "remote", "add", "origin", bare);
      }, STEP_TIMEOUT);

      afterAll(async () => {
        await composeDown(container);
        await removeContainer(container);
        await removeImage(tag);
        await project?.cleanup();
      }, TWO_MINUTES);

      it(
        "analyze, interview, design and adapt prepare the repository",
        async () => {
          if (project === undefined) throw new Error("no project");
          const { root, dir } = project;
          const expected = await readExpected(path.join(EXAMPLES_DIR, example));
          const answersFile = path.join(dir, "answers.yaml");
          await writeFile(answersFile, `${JSON.stringify(answersFor(expected), null, 2)}\n`);

          await opscrew("analyze", "--no-ai");
          await opscrew("interview", "--answers", answersFile);
          await opscrew("design");
          const adapted = await opscrew("adapt", "--no-ai", "--no-push");

          const plan = DeployPlanSchema.parse(
            parse(await readFile(path.join(root, "opscrew", "plan.yaml"), "utf8")),
          );
          const architecture = ArchitectureSchema.parse(
            JSON.parse(await readFile(path.join(root, "opscrew", "architecture.json"), "utf8")),
          );
          const clientExposed = new Set(
            architecture.facts.envVars.filter((v) => v.clientExposed).map((v) => v.name),
          );
          // Every plan names a Dockerfile, so a missing one means adapt did not write it.
          if (!existsSync(path.join(root, plan.app.dockerfile))) {
            const change = plan.codeChanges.find((c) => c.kind === "dockerfile");
            throw new Error(
              `${example}: adapt did not write ${plan.app.dockerfile} (dockerfile change: ${change?.status ?? "not in the plan"}). The end of adapt's output:\n${tail(adapted)}`,
            );
          }
          prepared = {
            plan,
            appKind: architecture.facts.appKind,
            buildEnv: plan.app.env.map((v) => v.name).filter((name) => clientExposed.has(name)),
          };
        },
        STEP_TIMEOUT,
      );

      it(
        "the image builds from the Dockerfile in the repository",
        async () => {
          if (project === undefined || prepared === undefined) {
            throw new Error(`${example}: the repository was not prepared (see the test above).`);
          }
          const { plan, buildEnv } = prepared;
          images.add(tag);
          const build = await docker(
            [
              "build",
              "--progress=plain",
              ...buildEnv.flatMap((name) => ["--build-arg", `${name}=${placeholder(name)}`]),
              "-f",
              path.join(project.root, plan.app.dockerfile),
              "-t",
              tag,
              path.join(project.root, plan.app.buildContext),
            ],
            TEN_MINUTES,
          );
          if (build.exitCode !== 0 || build.timedOut) {
            const what = build.timedOut
              ? "docker build did not finish within ten minutes"
              : `docker build failed (exit ${build.exitCode})`;
            throw new Error(
              `${example}: ${what}. The end of the build log:\n${tail(build.stderr + build.stdout)}`,
            );
          }
          built = true;
        },
        TEN_MINUTES + 30_000,
      );

      it(
        "the container answers HTTP 200 on the health path within two minutes",
        async () => {
          if (prepared === undefined || !built) {
            throw new Error(`${example}: there is no image to start (see the tests above).`);
          }
          const { plan, appKind } = prepared;
          const port = plan.app.port;
          // Like opscrew/runtime/compose.yaml: PORT, the derived connection URLs, the user's
          // variables, all capabilities dropped and no privilege escalation.
          const env = new Map<string, string>([["PORT", String(port)]]);
          for (const variable of plan.app.env) {
            if (variable.name !== "PORT" && !prepared.buildEnv.includes(variable.name)) {
              env.set(variable.name, placeholder(variable.name));
            }
          }
          if (plan.services.postgres) env.set("DATABASE_URL", placeholder("DATABASE_URL"));
          if (plan.services.redis) env.set("REDIS_URL", placeholder("REDIS_URL"));
          const release = plan.app.releaseCommand !== undefined;
          const app = release ? await deployWithRelease(plan, env) : container;
          if (!release) {
            containers.add(container);
            const started = await docker([
              "run",
              "-d",
              "--name",
              container,
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges:true",
              "-p",
              `127.0.0.1::${port}`,
              ...[...env].flatMap(([name, value]) => ["-e", `${name}=${value}`]),
              tag,
            ]);
            if (started.exitCode !== 0) {
              throw new Error(`${example}: docker run failed:\n${tail(started.stderr)}`);
            }
          }

          // Without a model OpsCrew adds the health route itself for the frameworks it knows
          // (FR-816; the plan read above already has any path adapt moved under a prefix). A
          // health-endpoint change still pending is the Code-change agent's (documented --no-ai
          // behaviour, the live pass with a model covers it): then any answer on the path will do.
          const healthChange = plan.codeChanges.find((c) => c.kind === "health-endpoint");
          const leftToModel = healthChange?.status === "pending";
          const databaseRoute = release ? DATABASE_ROUTES[example] : undefined;
          const paths = [
            ...new Set([
              plan.app.healthPath,
              ...(appKind === "static-spa" ? ["/"] : []),
              ...(databaseRoute !== undefined ? [databaseRoute] : []),
            ]),
          ];
          const result = await waitForHealth(app, port, paths, {
            anyStatus: leftToModel ? plan.app.healthPath : undefined,
          });
          if (result.failure !== undefined) {
            const logs = await docker(["logs", "--tail", "80", app]);
            const pending = leftToModel
              ? " The plan's health-endpoint change is still pending (left to the Code-change agent by adapt --no-ai)."
              : "";
            throw new Error(
              `${example}: ${result.failure}.${pending} The end of the container log:\n${tail(`${logs.stdout}\n${logs.stderr}`, 80)}`,
            );
          }
          for (const [urlPath, status] of result.notes) {
            console.warn(
              `${example}: the health route is left to the Code-change agent (adapt --no-ai); the server answers HTTP ${status} on ${urlPath}`,
            );
          }
        },
        TWO_MINUTES + 60_000,
      );
    });
  },
);

/** What polling the container found. */
interface HealthResult {
  /** What went wrong, or undefined when every path answered as required. */
  failure?: string;
  /** Paths accepted with an answer other than 200 (`anyStatus`), with the status seen. */
  notes: Map<string, number>;
}

/**
 * Polls every path on the container's published port until each answers 200 (the `anyStatus`
 * path: any status below 500, so the server routes requests), for at most two minutes. Fails
 * when the time runs out or the container stops, with the last answer seen.
 */
async function waitForHealth(
  container: string,
  port: number,
  paths: readonly string[],
  options: { anyStatus?: string | undefined } = {},
): Promise<HealthResult> {
  const deadline = Date.now() + TWO_MINUTES;
  const pending = new Set(paths);
  const notes = new Map<string, number>();
  let last = "no answer yet";
  let address: string | undefined;
  while (Date.now() < deadline) {
    const state = await docker(["inspect", "--format", "{{.State.Running}}", container]);
    if (state.stdout.trim() !== "true") {
      const waiting = [...pending].join(", ");
      return { failure: `the container stopped before ${waiting} answered (last: ${last})`, notes };
    }
    if (address === undefined) {
      const published = await docker(["port", container, `${port}/tcp`]);
      address = /127\.0\.0\.1:(\d+)/.exec(published.stdout)?.[0];
    }
    if (address !== undefined) {
      for (const urlPath of [...pending]) {
        try {
          const response = await fetch(`http://${address}${urlPath}`, {
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
          });
          await response.body?.cancel();
          if (response.status === 200) {
            pending.delete(urlPath);
          } else if (urlPath === options.anyStatus && response.status < 500) {
            pending.delete(urlPath);
            notes.set(urlPath, response.status);
          } else {
            last = `${urlPath} answered HTTP ${response.status}`;
          }
        } catch (error) {
          last = `${urlPath}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (pending.size === 0) return { notes };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const waiting = [...pending].join(", ");
  return {
    failure: `no HTTP 200 from ${waiting} on port ${port} within two minutes (last: ${last})`,
    notes,
  };
}
