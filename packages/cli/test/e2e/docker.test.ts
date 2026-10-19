/**
 * Local Docker pass over every app in `examples/` (T823, FR-811, T1208): each example with an
 * `expected.json` is materialised into a temp git repository and driven through the real CLI
 * in-process, offline and without a model (`analyze --no-ai` → `interview --answers` → `design` →
 * `adapt --no-ai --no-push`, like `examples.test.ts`). Then the image is built with the plan's
 * builder the way the deploy workflow builds it (`workflowBuild`):
 * - a Dockerfile (generated or the app's own) through buildx;
 * - Buildpacks through pack, after removing the secret files from the build context
 *   (`removeSecretFiles`, as the workflow does), with the workflow's builder, run image and version
 *   setting, then the seal;
 * - Railpack: the build plan from the Railpack CLI with the workflow's runtime version setting,
 *   buildx with the pinned frontend and that setting as a secret, then the seal (`USER` and the
 *   `chown` of the folders the framework writes to).
 *
 * pack and Railpack are the release archives pinned in `pins.ts` (checksums checked), run in a
 * pinned glibc image with CA certificates. The container is started the way the production Compose
 * file starts it (the plan's port, placeholder values, all capabilities dropped) and the plan's
 * health path (static apps: also `/`) must answer HTTP 200 within two minutes. When the plan
 * leaves the health route to the Code-change agent (a pending `health-endpoint` change, which
 * `--no-ai` does not write), any HTTP answer on that path passes with a note. A plan with a release
 * command (`app.releaseCommand`, database migrations) is started like the deploy workflow starts it
 * instead: OpsCrew's Compose file, the backing services, the `release` service run once, then the
 * app, which must also answer 200 on a route that writes to the database (`DATABASE_ROUTES`).
 * Before the build the pass writes a local `.env` with a fake secret into the build context, and
 * checks that it stays out: the `.dockerignore` OpsCrew wrote lists `.env` (Dockerfile and Railpack
 * builds), or the removal before pack took it away (Buildpacks). The image's files (`docker
 * export` of a container never started), history (`docker history --no-trunc`) and configuration
 * (`docker image inspect`), and those of the image Buildpacks or Railpack built before the seal,
 * must hold none of the secret values the pass knows: the ones the example plants (`{{FAKE:…}}`),
 * the one in that `.env`, and the ones it generated for the app; a failure names their labels
 * only.
 * Then, inside the running container:
 * - the app does not run as root;
 * - the Compose health check OpsCrew renders for the image passes (`docker exec`), so every probe
 *   (Node, Python, Ruby, PHP, wget, bash through the Buildpacks launcher) runs in a real image;
 * - a Node.js image holds no development dependency, except the release command's tools and what
 *   they need, and what npm keeps because a production package lists it as a peer (`npm explain`);
 * - `nextjs-postgres-prisma` (nextjs-postgres with Prisma migrations): `npx --no-install prisma
 *   --version` runs and the engine files it names exist. Prisma's install scripts fetch them, and
 *   a future npm may block install scripts that are not allow-listed (npm 11.19 warns), so this
 *   catches it when the Node pin moves.
 *
 * It pulls base images and packages, so it runs only on request: OPSCREW_DOCKER_TESTS=1 with a
 * running Docker daemon (skipped otherwise). OPSCREW_DOCKER_EXAMPLES=a,b limits the run to those
 * examples. Containers, images and pack's cache volumes are always removed; every container this
 * file starts carries the label `opscrew.test=docker-pass`.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleAppEnv, fixedProductionValue } from "@opscrew/agents";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { FakeAgentRuntime, fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { IMAGES, type PinArch, renderCompose } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
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
import { removeSecretFiles, toolArchive, type WorkflowBuild, workflowBuild } from "./builders";
import {
  BASE_ANSWERS,
  exampleNames,
  plantedSecrets,
  readExpected,
  readPlan,
  ScriptedApprovals,
} from "./support";

const DOCKER = findExecutable("docker");
const TWENTY_MINUTES = 1_200_000;
const TEN_MINUTES = 600_000;
const TWO_MINUTES = 120_000;
const STEP_TIMEOUT = 180_000;

/** On every container this file starts. */
const LABEL = "opscrew.test=docker-pass";

/**
 * Where pack and Railpack run: a pinned glibc image with CA certificates (Railpack plans Python
 * apps only on glibc; node:slim has no CA certificates).
 */
const TOOL_IMAGE = IMAGES.python.ref;

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

/** One app the pass builds: an example, or an example with extra files and devDependencies. */
interface Case {
  name: string;
  example: string;
  /** A folder under `__fixtures__/` copied over the example. */
  overlay?: string;
  devDependencies?: Record<string, string>;
}

/** nextjs-postgres with Prisma migrations, which the release command applies. */
const PRISMA: Case = {
  name: "nextjs-postgres-prisma",
  example: "nextjs-postgres",
  overlay: "prisma",
  devDependencies: { prisma: "^7.10.1" },
};

/** Every example with an `expected.json`, plus the variants. */
const ALL_CASES: Case[] = [...exampleNames().map((name) => ({ name, example: name })), PRISMA];
const ALL_NAMES = ALL_CASES.map((c) => c.name);

/** OPSCREW_DOCKER_EXAMPLES=a,b, or undefined for every example. */
const REQUESTED = process.env.OPSCREW_DOCKER_EXAMPLES?.split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const CASES =
  REQUESTED === undefined || REQUESTED.length === 0
    ? ALL_CASES
    : ALL_CASES.filter((c) => REQUESTED.includes(c.name));

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
/** Image tags pack built, whose cache volumes are removed. */
const packTags = new Set<string>();

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

/** pack's build and launch cache volumes for `tag` (`pack-cache-<repo>_<tag>-<key>.<kind>`). */
async function removePackVolumes(tag: string): Promise<void> {
  const prefix = `pack-cache-${tag.replace(/[/:]/g, "_")}-`;
  const listed = await docker(["volume", "ls", "-q", "--filter", `name=${prefix}`]);
  const volumes = listed.stdout.split(/\s+/).filter((name) => name.startsWith(prefix));
  if (volumes.length > 0) await docker(["volume", "rm", "-f", ...volumes]);
  packTags.delete(tag);
}

/** The last `lines` lines of a log (build output, container output). */
function tail(text: string, lines = 60): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/** A `--mount` for a file or folder of this computer. */
function bind(source: string, target: string, readonly = false): string {
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

/** The engine's CPU, which picks the pack and Railpack archives. */
let engineArch: Promise<PinArch> | undefined;
function arch(): Promise<PinArch> {
  engineArch ??= docker(["info", "--format", "{{.Architecture}}"]).then((info) => {
    const name = info.stdout.trim();
    if (name === "x86_64") return "amd64";
    if (name === "aarch64") return "arm64";
    throw new Error(
      `The Docker engine runs on ${name}; OpsCrew pins pack and Railpack for x86_64 and aarch64 only.`,
    );
  });
  return engineArch;
}

/** Downloaded pack and Railpack archives, one download per tool and run. */
let toolsDir: Promise<string> | undefined;
const archives = new Map<"pack" | "railpack", Promise<string>>();
function archive(tool: "pack" | "railpack"): Promise<string> {
  let found = archives.get(tool);
  if (found === undefined) {
    toolsDir ??= mkdtemp(path.join(tmpdir(), "opscrew-tools-"));
    found = Promise.all([arch(), toolsDir]).then(([cpu, dir]) => toolArchive(tool, cpu, dir));
    archives.set(tool, found);
  }
  return found;
}

/**
 * Runs `script` (with `args` as `$@`) in a tool container named `name`; fails with its output
 * when it exits non-zero or runs longer than twenty minutes.
 */
async function toolRun(
  name: string,
  what: string,
  options: string[],
  script: string,
  args: string[],
): Promise<string> {
  containers.add(name);
  const started = Date.now();
  const result = await docker(
    [
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      LABEL,
      ...options,
      TOOL_IMAGE,
      "sh",
      "-c",
      script,
    ].concat(["sh", ...args]),
    TWENTY_MINUTES,
  );
  await removeContainer(name);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 || result.timedOut) {
    const failure = result.timedOut
      ? "did not finish within twenty minutes"
      : `failed (exit ${result.exitCode})`;
    throw new Error(`${what} ${failure}. The end of its output:\n${tail(output)}`);
  }
  console.info(`${what} took ${Math.round((Date.now() - started) / 1000)} s`);
  return output;
}

/** `docker buildx build --load` (the engine's builder); fails with the end of the build log. */
async function buildx(what: string, args: string[]): Promise<void> {
  const started = Date.now();
  const build = await docker(
    ["buildx", "build", "--load", "--progress=plain", ...args],
    TWENTY_MINUTES,
  );
  if (build.exitCode !== 0 || build.timedOut) {
    const failure = build.timedOut
      ? "did not finish within twenty minutes"
      : `failed (exit ${build.exitCode})`;
    throw new Error(
      `${what} ${failure}. The end of the build log:\n${tail(build.stderr + build.stdout)}`,
    );
  }
  console.info(`${what} took ${Math.round((Date.now() - started) / 1000)} s`);
}

/**
 * A placeholder value for an environment variable the plan names: connection URLs point at a
 * port nothing listens on, so an app that connects at start fails fast instead of hanging; host
 * lists name this computer, as provision fills them with the deployment's host; every other value
 * is the one the app's own `.env.example` gives, else a plain word. Never a secret-shaped literal.
 */
function placeholder(name: string, example?: string): string {
  if (/(?:^|_)ALLOWED_HOSTS$/.test(name)) return "localhost,127.0.0.1";
  if (/(?:^|_)CSRF_TRUSTED_ORIGINS$/.test(name)) return "http://localhost,http://127.0.0.1";
  if (name === "DATABASE_URL") return "postgres://u:p@127.0.0.1:5/none";
  if (name === "REDIS_URL") return "redis://127.0.0.1:5";
  if (/_(?:URL|URI)$/.test(name)) return "http://127.0.0.1:5/";
  return example ?? "opscrew-placeholder";
}

/** The non-empty values of `<root>/.env.example` (Laravel's lists its defaults there). */
async function envExampleValues(root: string): Promise<Map<string, string>> {
  const file = path.join(root, ".env.example");
  const values = new Map<string, string>();
  if (!existsSync(file)) return values;
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    const value = match?.[2]?.replace(/^"(.*)"$/, "$1");
    if (match?.[1] && value) values.set(match[1], value);
  }
  return values;
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
 * The TypeScript runners a Node.js image keeps with any release tool (the generated Dockerfile's
 * release-tools helper), since migrations and configs load through them.
 */
const TYPESCRIPT_RUNNERS = ["ts-node", "tsx", "typescript"];

/**
 * `node -e TOOL_TREE <dir> <package...>`: prints the real path of the `package.json` of every
 * package below `<dir>` that the named packages need (dependencies, optional and peer
 * dependencies, resolved like Node.js does), the named packages included.
 */
const TOOL_TREE = `
const fs = require("fs"), path = require("path");
const [dir, ...roots] = process.argv.slice(1);
const seen = new Set();
function visit(name, from) {
  for (let at = from; ; at = path.dirname(at)) {
    const file = path.join(at, "node_modules", name, "package.json");
    if (fs.existsSync(file)) {
      const real = fs.realpathSync(file);
      if (seen.has(real)) return;
      seen.add(real);
      const pkg = JSON.parse(fs.readFileSync(real, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
      for (const dep of Object.keys(deps)) visit(dep, path.dirname(real));
      return;
    }
    if (at === dir || at === path.dirname(at)) return;
  }
}
for (const root of roots) visit(root, dir);
console.log([...seen].join("\\n"));
`;

/** The package of a `.../node_modules/<name>/package.json` path (`@scope/name` too). */
function packageName(file: string): string {
  return /node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(file)?.[1] ?? file;
}

/** An edge `npm explain --json` lists for a package: who depends on it, and how. */
interface Dependent {
  type: string;
  from?: { dev?: boolean };
}

/**
 * The packages among `names` that npm keeps under `--omit=dev` although they are development
 * dependencies, because a production package lists them as a peer (`@react-router/node` lists
 * `typescript` as an optional one): npm's behaviour, not a leak. Read with `npm explain` in the
 * container's working directory.
 */
async function keptAsPeers(container: string, dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const explained = await docker([
    "exec",
    "-w",
    dir,
    container,
    "npm",
    "explain",
    "--json",
    ...names,
  ]);
  if (explained.exitCode !== 0) {
    throw new Error(`npm explain failed in the container:\n${tail(explained.stderr)}`);
  }
  const nodes = JSON.parse(explained.stdout) as { name: string; dependents?: Dependent[] }[];
  const fromProduction = (edge: Dependent) =>
    (edge.type === "peer" || edge.type === "peerOptional") && edge.from?.dev !== true;
  return new Set(nodes.filter((node) => node.dependents?.some(fromProduction)).map((n) => n.name));
}

/**
 * The Compose file OpsCrew deploys (`renderCompose`), adapted to this computer: the data
 * directories under /srv become named volumes, the app's port is published on 127.0.0.1 and
 * Caddy and kamal-proxy are left out (TLS and the switch are not under test). The `release`
 * service is unchanged.
 */
function localCompose(plan: DeployPlan): string {
  const rendered = renderCompose(plan);
  const doc = parse(rendered.content) as {
    services: Record<string, { volumes?: string[]; ports?: string[] }>;
    volumes: Record<string, unknown>;
  };
  delete doc.services.caddy;
  delete doc.services.proxy;
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

/**
 * The app's Compose health check command (`renderCompose`), as `docker exec` arguments: without
 * `CMD` and with Compose's `$$` back to `$`. Undefined when the plan has none (own Dockerfiles).
 */
function healthCommand(plan: DeployPlan): string[] | undefined {
  const doc = parse(renderCompose(plan).content) as {
    services: { app: { healthcheck?: { test: string[] } } };
  };
  const test = doc.services.app.healthcheck?.test;
  return test?.slice(1).map((arg) => arg.replaceAll("$$", "$"));
}

/** What the repository looks like after `adapt`: enough to build and start the app. */
interface Prepared {
  plan: DeployPlan;
  /** Variables Docker gets as build arguments (client-exposed, baked into the bundle). */
  buildEnv: string[];
  appKind: string;
  /** The app's folder in the repository (`.` unless a monorepo). */
  appDir: string;
  /** Values from the app's `.env.example`, used for the placeholders. */
  exampleValues: Map<string, string>;
}

/** The running app, after the health test started it. */
interface Running {
  container: string;
  /** The health path answered 200 from outside, so the route exists. */
  healthRoute: boolean;
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
      for (const tag of [...packTags]) await removePackVolumes(tag);
      if (toolsDir !== undefined) await rm(await toolsDir, { recursive: true, force: true });
    }, TWO_MINUTES);

    it("OPSCREW_DOCKER_EXAMPLES names only examples that exist", () => {
      const unknown = (REQUESTED ?? []).filter((name) => !ALL_NAMES.includes(name));
      expect(unknown, `known examples: ${ALL_NAMES.join(", ")}`).toEqual([]);
      expect(CASES.length, "examples to run").toBeGreaterThan(0);
    });

    describe.each(CASES.map((c) => [c.name, c] as const))("example %s", (example, testCase) => {
      const stamp = `${Date.now()}-${process.pid}`;
      const tag = `opscrew-test/${example}:${stamp}`;
      /** What Buildpacks and Railpack build before the seal (`build-<commit>` in CI). */
      const buildTag = `${tag}-build`;
      const container = `opscrew-test-${example}-${stamp}`;
      const runtime = new FakeAgentRuntime();
      const approvals = new ScriptedApprovals();
      let project: TempProject | undefined;
      let prepared: Prepared | undefined;
      let built = false;
      let running: Running | undefined;
      /** The secret values the pass knows for the app, with the labels a failure shows. */
      const known: { label: string; value: string }[] = [];

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

      /** The running app, or an error pointing at the health test. */
      function app(): Running {
        if (running === undefined) {
          throw new Error(`${example}: the app is not running (see the tests above).`);
        }
        return running;
      }

      /** Buildpacks: pack builds `buildTag` into the engine with the workflow's options. */
      async function packBuild(project: TempProject, options: string[], buildEnv: string[]) {
        const context = prepared?.plan.app.buildContext || ".";
        packTags.add(buildTag);
        await toolRun(
          `${container}-pack`,
          `${example}: pack build`,
          [
            ...["-v", "/var/run/docker.sock:/var/run/docker.sock"],
            ...["--mount", bind(await archive("pack"), "/opt/pack.tgz", true)],
            ...["--mount", bind(project.root, "/workspace", true)],
          ],
          'tar -xzf /opt/pack.tgz -C /usr/local/bin && exec pack build "$@"',
          [
            buildTag,
            ...["--path", path.posix.join("/workspace", context)],
            ...options,
            ...buildEnv.flatMap((name) => ["--env", `${name}=${placeholder(name)}`]),
          ],
        );
        await removePackVolumes(buildTag);
      }

      /**
       * Railpack: the CLI writes the build plan (with the runtime version and the build values),
       * and buildx builds `buildTag` from it with the pinned frontend, reading the values and the
       * version as BuildKit secrets, as the workflow does.
       */
      async function railpackBuild(
        project: TempProject,
        steps: Extract<WorkflowBuild, { builder: "railpack" }>,
        buildEnv: string[],
      ) {
        const context = prepared?.plan.app.buildContext || ".";
        const out = path.join(project.dir, "railpack");
        await mkdir(out, { recursive: true });
        await toolRun(
          `${container}-railpack`,
          `${example}: railpack prepare`,
          [
            ...["--mount", bind(await archive("railpack"), "/opt/railpack.tgz", true)],
            ...["--mount", bind(project.root, "/workspace", true)],
            ...["--mount", bind(out, "/out")],
          ],
          'mkdir /tmp/railpack && tar -xzf /opt/railpack.tgz -C /tmp/railpack && exec "$(find /tmp/railpack -type f -name railpack | head -n 1)" prepare "$@"',
          [
            path.posix.join("/workspace", context),
            ...["--plan-out", "/out/railpack-plan.json", "--info-out", "/out/railpack-info.json"],
            ...steps.prepareEnv.flatMap((setting) => ["--env", setting]),
            ...buildEnv.flatMap((name) => ["--env", `${name}=${placeholder(name)}`]),
          ],
        );
        const info = JSON.parse(await readFile(path.join(out, "railpack-info.json"), "utf8")) as {
          resolvedPackages?: Record<string, { resolvedVersion?: string }>;
        };
        const versions = Object.entries(info.resolvedPackages ?? {}).map(
          ([name, resolved]) => `${name} ${resolved.resolvedVersion ?? "?"}`,
        );
        console.info(`${example}: Railpack resolved ${versions.join(", ") || "nothing"}`);
        const secrets: string[] = [];
        const values = [
          ...steps.secrets.map(
            (setting) =>
              [
                setting.slice(0, setting.indexOf("=")),
                setting.slice(setting.indexOf("=") + 1),
              ] as const,
          ),
          ...buildEnv.map((name) => [name, placeholder(name)] as const),
        ];
        for (const [name, value] of values) {
          const file = path.join(out, `secret-${name}`);
          await writeFile(file, value);
          secrets.push("--secret", `id=${name},src=${file}`);
        }
        await buildx(`${example}: the Railpack build`, [
          ...["-f", path.join(out, "railpack-plan.json")],
          ...["--build-arg", `BUILDKIT_SYNTAX=${steps.frontend}`],
          ...secrets,
          ...["-t", buildTag, path.join(project.root, context)],
        ]);
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
          known.push({ label: "the database password", value: password });
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
        const planted = await plantedSecrets(path.join(EXAMPLES_DIR, testCase.example));
        for (const [i, value] of planted.entries()) {
          known.push({ label: `planted secret #${i + 1}`, value });
        }
        project = await tempProject(testCase.example);
        const { env, root, dir } = project;
        if (testCase.overlay !== undefined) {
          await materializeFixture(path.join(FIXTURES, testCase.overlay), root);
        }
        if (testCase.devDependencies !== undefined) {
          const file = path.join(root, "package.json");
          const pkg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
          pkg.devDependencies = {
            ...(pkg.devDependencies as Record<string, string>),
            ...testCase.devDependencies,
          };
          await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
        }
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
        await removeImage(buildTag);
        await project?.cleanup();
      }, TWO_MINUTES);

      it(
        "analyze, interview, design and adapt prepare the repository",
        async () => {
          if (project === undefined) throw new Error("no project");
          const { root, dir } = project;
          const expected = await readExpected(path.join(EXAMPLES_DIR, testCase.example));
          const answersFile = path.join(dir, "answers.yaml");
          // One small production setup for every example; a monorepo picks the app its
          // `expected.json` names.
          const answers = {
            ...(expected.chosenApp !== undefined ? { appDir: expected.chosenApp.appDir } : {}),
            ...BASE_ANSWERS,
          };
          await writeFile(answersFile, `${JSON.stringify(answers, null, 2)}\n`);
          const exampleValues = await envExampleValues(root);

          await opscrew("analyze", "--no-ai");
          await opscrew("interview", "--answers", answersFile);
          await opscrew("design");
          const adapted = await opscrew("adapt", "--no-ai", "--no-push");

          const plan = await readPlan(root);
          const architecture = await readArtifact(
            "architecture",
            path.join(root, "opscrew", "architecture.json"),
          );
          const clientExposed = new Set(
            architecture.facts.envVars.filter((v) => v.clientExposed).map((v) => v.name),
          );
          const builder = plan.app.build?.builder;
          console.info(`${example}: builder ${builder}; ${plan.app.build?.reason ?? ""}`);
          // A Dockerfile plan without the file means adapt did not write it.
          const dockerfileBuild = builder !== "buildpacks" && builder !== "railpack";
          if (dockerfileBuild && !existsSync(path.join(root, plan.app.dockerfile))) {
            const change = plan.codeChanges.find((c) => c.kind === "dockerfile");
            throw new Error(
              `${example}: adapt did not write ${plan.app.dockerfile} (dockerfile change: ${change?.status ?? "not in the plan"}). The end of adapt's output:\n${tail(adapted)}`,
            );
          }
          prepared = {
            plan,
            appKind: architecture.facts.appKind,
            appDir: architecture.facts.appDir ?? ".",
            buildEnv: plan.app.env.map((v) => v.name).filter((name) => clientExposed.has(name)),
            exampleValues,
          };
        },
        STEP_TIMEOUT,
      );

      it(
        "the image builds with the plan's builder, as the deploy workflow builds it",
        async () => {
          if (project === undefined || prepared === undefined) {
            throw new Error(`${example}: the repository was not prepared (see the test above).`);
          }
          const { plan, buildEnv } = prepared;
          const builder = plan.app.build?.builder;
          // A developer's local `.env` next to the app, with a value the image must never hold:
          // `.dockerignore` keeps it out of a Dockerfile or Railpack build, and the workflow
          // removes it before a Buildpacks build, since pack does not read `.dockerignore`.
          const context = path.join(project.root, plan.app.buildContext);
          const local = fakeSecret("generic-password", `docker-pass-${example}`);
          await appendFile(path.join(context, ".env"), `\nOPSCREW_TEST_LOCAL_SECRET=${local}\n`);
          known.push({ label: "the value in the local .env", value: local });
          if (builder === "buildpacks") {
            const removed = await removeSecretFiles(context);
            console.info(`${example}: removed before pack: ${removed.join(", ")}`);
            expect(removed, `${example}: the files removed before pack`).toContain(".env");
          } else {
            const ignored = (await readFile(path.join(context, ".dockerignore"), "utf8"))
              .split(/\r?\n/)
              .map((line) => line.trim());
            expect(ignored, `${example}: the .dockerignore in the build context`).toContain(".env");
          }
          images.add(tag);
          if (builder === "buildpacks" || builder === "railpack") {
            const steps = workflowBuild(plan);
            images.add(buildTag);
            if (steps.builder === "buildpacks") {
              await packBuild(project, steps.packOptions, buildEnv);
            } else {
              console.info(`${example}: Railpack settings ${steps.prepareEnv.join(", ")}`);
              await railpackBuild(project, steps, buildEnv);
            }
            // The seal, from the checkout like CI (it copies nothing from it).
            const seal = path.join(project.dir, "seal", "Dockerfile");
            await mkdir(path.dirname(seal), { recursive: true });
            await writeFile(seal, [`FROM ${buildTag}`, ...steps.sealLines, ""].join("\n"));
            await buildx(`${example}: the seal`, ["-f", seal, "-t", tag, project.root]);
          } else {
            await buildx(`${example}: docker buildx build`, [
              ...buildEnv.flatMap((name) => ["--build-arg", `${name}=${placeholder(name)}`]),
              ...["-f", path.join(project.root, plan.app.dockerfile)],
              ...["-t", tag, path.join(project.root, plan.app.buildContext)],
            ]);
          }
          built = true;
        },
        2 * TWENTY_MINUTES,
      );

      it(
        "the container answers HTTP 200 on the health path within two minutes",
        async () => {
          if (prepared === undefined || !built) {
            throw new Error(`${example}: there is no image to start (see the tests above).`);
          }
          const { plan, appKind, exampleValues } = prepared;
          const port = plan.app.port;
          // Like opscrew/runtime/compose.yaml: PORT, the derived connection URLs, the user's
          // variables, all capabilities dropped and no privilege escalation. The generated keys
          // and fixed production settings (RAILS_ENV, APP_KEY) are the ones provision assembles.
          const assembled = await assembleAppEnv({ plan, ask: async () => ({ skip: true }) });
          for (const [name, value] of Object.entries(assembled.generated.env ?? {})) {
            known.push({ label: `the generated ${name}`, value });
          }
          const env = new Map<string, string>([["PORT", String(port)]]);
          for (const variable of plan.app.env) {
            if (variable.name === "PORT" || prepared.buildEnv.includes(variable.name)) continue;
            const fromOpsCrew =
              variable.source === "generated" || fixedProductionValue(variable.name) !== undefined;
            env.set(
              variable.name,
              (fromOpsCrew ? assembled.values.app[variable.name] : undefined) ??
                placeholder(variable.name, exampleValues.get(variable.name)),
            );
          }
          if (plan.services.postgres) env.set("DATABASE_URL", placeholder("DATABASE_URL"));
          if (plan.services.redis) env.set("REDIS_URL", placeholder("REDIS_URL"));
          const release = plan.app.releaseCommand !== undefined;
          const name = release ? await deployWithRelease(plan, env) : container;
          if (!release) {
            containers.add(container);
            const started = await docker([
              "run",
              "-d",
              "--name",
              container,
              "--label",
              LABEL,
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges:true",
              "-p",
              `127.0.0.1::${port}`,
              ...[...env].flatMap(([key, value]) => ["-e", `${key}=${value}`]),
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
          const result = await waitForHealth(name, port, paths, {
            anyStatus: leftToModel ? plan.app.healthPath : undefined,
          });
          if (result.failure !== undefined) {
            const logs = await docker(["logs", "--tail", "80", name]);
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
          running = { container: name, healthRoute: !result.notes.has(plan.app.healthPath) };
        },
        TWO_MINUTES + 60_000,
      );

      it("the app does not run as root", async () => {
        const { container: name } = app();
        const status = await docker(["exec", name, "cat", "/proc/1/status"]);
        const uid = /^Uid:\s+(\d+)/m.exec(status.stdout)?.[1];
        expect(uid, `${example}: the user of the container's first process`).toBeDefined();
        console.info(`${example}: the app runs as uid ${uid}`);
        expect(uid, `${example} runs as root`).not.toBe("0");
      });

      it(
        "the image's files, history and configuration hold none of the known secret values",
        async () => {
          if (!built) {
            throw new Error(`${example}: there is no image to search (see the tests above).`);
          }
          const builder = prepared?.plan.app.build?.builder;
          const searched =
            builder === "buildpacks" || builder === "railpack" ? [tag, buildTag] : [tag];
          let text = "";
          const inFiles = new Set<string>();
          for (const image of searched) {
            for (const args of [
              ["history", "--no-trunc", image],
              ["image", "inspect", image],
            ]) {
              const result = await docker(args);
              if (result.exitCode !== 0) {
                throw new Error(
                  `${example}: docker ${args.join(" ")} failed:\n${tail(result.stderr)}`,
                );
              }
              text += `${result.stdout}\n`;
            }
            for (const label of await imageFileLeaks(image, known)) inFiles.add(label);
          }
          const images = searched.join(" and ");
          const inConfig = known.filter(({ value }) => text.includes(value)).map((k) => k.label);
          expect(
            inConfig,
            `${example}: secret values in the history or configuration of ${images}`,
          ).toEqual([]);
          expect([...inFiles], `${example}: secret values in the files of ${images}`).toEqual([]);
          console.info(
            `${example}: none of the ${known.length} known secret values is in the files, history or configuration of ${images}`,
          );
        },
        TEN_MINUTES,
      );

      it(
        "the Compose health check OpsCrew renders passes inside the container",
        async (ctx) => {
          const { container: name, healthRoute } = app();
          const plan = prepared?.plan as DeployPlan;
          const command = healthCommand(plan);
          if (command === undefined) {
            console.info(`${example}: no Compose health check (the image's own HEALTHCHECK)`);
            return ctx.skip();
          }
          if (!healthRoute) {
            console.warn(
              `${example}: no health route yet (adapt --no-ai), so the probe would fail`,
            );
            return ctx.skip();
          }
          let last = "";
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const probe = await docker(["exec", name, ...command], 15_000);
            if (probe.exitCode === 0) {
              console.info(`${example}: the ${plan.app.build?.probe ?? "default"} probe passed`);
              return;
            }
            last = `exit ${probe.exitCode}: ${tail(`${probe.stdout}\n${probe.stderr}`, 10)}`;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          throw new Error(`${example}: \`${command.join(" ")}\` kept failing (last: ${last})`);
        },
        TWO_MINUTES,
      );

      it("a Node.js image holds no development dependency", async (ctx) => {
        if (prepared?.plan.app.build?.runtime.language !== "node") return ctx.skip();
        const { container: name } = app();
        const { plan, appDir } = prepared;
        if (project === undefined) throw new Error("no project");
        const folders = [...new Set([".", appDir])];
        const dev = new Set<string>();
        for (const folder of folders) {
          const file = path.join(project.root, folder, "package.json");
          if (!existsSync(file)) continue;
          const pkg = JSON.parse(await readFile(file, "utf8")) as {
            devDependencies?: Record<string, string>;
          };
          for (const dep of Object.keys(pkg.devDependencies ?? {})) dev.add(dep);
        }
        const workdir = (await docker(["inspect", "-f", "{{.Config.WorkingDir}}", name])).stdout;
        const dir = workdir.trim() || "/";
        const lines = (result: { stdout: string }) =>
          result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
        const found = await docker([
          "exec",
          name,
          "sh",
          "-c",
          'for dep in "$@"; do find "$0" -path "*/node_modules/$dep/package.json" 2>/dev/null; done',
          dir,
          ...dev,
        ]);
        expect(found.exitCode, found.stderr).toBe(0);
        // The release command's tools stay in the image with the TypeScript runners they load,
        // and so do the packages they depend on (Prisma brings @types/react as a peer).
        const release = plan.app.releaseCommand;
        const roots = release === undefined ? [] : [...release.split(/\s+/), ...TYPESCRIPT_RUNNERS];
        const tools =
          roots.length === 0
            ? []
            : lines(await docker(["exec", name, "node", "-e", TOOL_TREE, dir, ...roots]));
        const shipped = lines(found).filter((file) => !tools.includes(file));
        const peers = await keptAsPeers(name, dir, [...new Set(shipped.map(packageName))]);
        for (const dep of peers) {
          console.info(`${example}: npm keeps ${dep}, a peer of a production dependency`);
        }
        const leaked = shipped.filter((file) => !peers.has(packageName(file)));
        expect(leaked, `${example}: development dependencies in the image`).toEqual([]);
      });

      it.runIf(testCase === PRISMA)(
        "Prisma's CLI runs and its engine files are in the image",
        async () => {
          const { container: name } = app();
          const version = await docker([
            "exec",
            name,
            "npx",
            "--no-install",
            "prisma",
            "--version",
          ]);
          const output = `${version.stdout}\n${version.stderr}`;
          expect(version.exitCode, tail(output)).toBe(0);
          // `Schema Engine : schema-engine-cli <hash> (at node_modules/@prisma/engines/...)`
          const engines = [...output.matchAll(/\(at ([^)]+)\)/g)].map((match) => match[1] ?? "");
          expect(engines, `engine paths in:\n${tail(output)}`).not.toEqual([]);
          for (const file of engines) {
            expect((await docker(["exec", name, "test", "-f", file])).exitCode, file).toBe(0);
          }
          console.info(`${example}: prisma --version:\n${tail(output, 12)}`);
        },
        TWO_MINUTES,
      );
    });
  },
);

/**
 * The labels of the `known` values found in the files of `image`: a container of the image, never
 * started, is exported as a tar stream and searched as it arrives, keeping the end of each chunk
 * so a value split between two chunks is still found. The container is removed afterwards.
 */
async function imageFileLeaks(
  image: string,
  known: readonly { label: string; value: string }[],
): Promise<string[]> {
  const created = await docker(["create", "--label", LABEL, image, "true"]);
  if (created.exitCode !== 0) {
    throw new Error(`docker create ${image} failed:\n${tail(created.stderr)}`);
  }
  const id = created.stdout.trim();
  containers.add(id);
  try {
    const needles = known.map(({ label, value }) => ({ label, bytes: Buffer.from(value) }));
    const overlap = Math.max(0, ...needles.map((needle) => needle.bytes.length - 1));
    const found = new Set<string>();
    const child = spawn(DOCKER ?? "docker", ["export", id], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    let carry = Buffer.alloc(0);
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      const window = Buffer.concat([carry, chunk]);
      for (const needle of needles) {
        if (window.indexOf(needle.bytes) !== -1) found.add(needle.label);
      }
      carry = window.subarray(Math.max(0, window.length - overlap));
    }
    const code = await closed;
    if (code !== 0)
      throw new Error(`docker export of ${image} failed (exit ${code}):\n${tail(stderr)}`);
    return [...found];
  } finally {
    // With the anonymous volumes an image's VOLUME lines gave the container.
    await docker(["rm", "-f", "-v", id]);
    containers.delete(id);
  }
}

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
