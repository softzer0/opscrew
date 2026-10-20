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
 * command (`app.releaseCommand`, database migrations) or components (below) is started like the
 * deploy workflow starts it instead, as OpsCrew's Compose project; with a release command the app
 * must also answer 200 on a route that writes to the database (`DATABASE_ROUTES`).
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
 * The components (013): a plan with services, workers, cron jobs or storage, and every example
 * whose `expected.json` names its components, starts as OpsCrew's Compose project in the deploy's
 * order (`switchCommands`), without the edge and the switch: the services up and healthy (with the
 * one-shot `sysctl` container first on a cloud server), their one-time setup (`initStepsFor`, each
 * step only when its check fails), the release command, the app, then the workers and cron, from
 * the Compose file adapted to this computer (`localServerCompose`). The app's environment and each
 * service's env file hold what provision assembles (`assembleAppEnv`, `serviceEnvSecrets`), with
 * placeholders for the user's own values. For an example whose `expected.json` names its
 * components, the pass then checks:
 * - every container has its memory limit (and no swap beyond it), and no service publishes a port;
 * - a job queued through the app is consumed within 30 seconds, and every worker and cron
 *   container keeps running;
 * - a cron job runs within one minute of its schedule (the first run supercronic logs as
 *   succeeded), and the app counts the run;
 * - a value written through the app is read back after `docker compose restart` and after a
 *   redeploy, which here recreates every container (`docker compose rm --stop --volumes`, which
 *   keeps the named volumes, then the deploy's steps again, so the one-time setup runs a second
 *   time).
 * `s3-uploads` is designed for a server the user owns (a fake one), where its bucket is Garage.
 * celery-worker's plan gets the cron job a user adds (`python heartbeat.py`: design finds no
 * command cron job in code). `node-mongo-portainer` and `s3-uploads-portainer` are designed for a
 * Portainer (a fake one answers the interview) and run their rendered stack with `docker compose`
 * and the stack's variables, as Portainer does: MongoDB as a replica set (the plan's option a user
 * sets, which Prisma would need) with its one-shot `-init`, and Garage with `--default-bucket`; a
 * second `up`, and an `up` after the containers were removed, must keep both working.
 *
 * It pulls base images and packages, so it runs only on request: OPSCREW_DOCKER_TESTS=1 with a
 * running Docker daemon (skipped otherwise). OPSCREW_DOCKER_EXAMPLES=a,b limits the run to those
 * examples. Containers, Compose projects with their volumes, images and pack's cache volumes are
 * always removed; every container this file starts outside Compose carries the label
 * `opscrew.test=docker-pass`. The images pulled for the services stay, as base images do.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AppEnvironment,
  assembleAppEnv,
  dotenvLine,
  fixedProductionValue,
  type PortainerAccess,
  serviceEnvSecrets,
} from "@opscrew/agents";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  OWN_IPV4,
  PORTAINER_URL,
} from "@opscrew/agents/testing";
import { FakeAgentRuntime, fakeSecret, materializeFixture } from "@opscrew/core/testing";
import {
  hostSettingsServices,
  IMAGES,
  initStepsFor,
  type PinArch,
  PORTAINER_IMAGE_PLACEHOLDER,
  PORTAINER_STACK_VARIABLES,
  PORTAINER_VERSION_PLACEHOLDER,
  portainerSecretVariables,
  portainerStackEnvKeys,
  type RenderContext,
  renderCompose,
  renderPortainerStack,
  serviceEnvSecret,
} from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
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
import { fakeHome, OwnRunner, ownServices } from "../../src/ui/__fixtures__/own";
import { removeSecretFiles, toolArchive, type WorkflowBuild, workflowBuild } from "./builders";
import {
  type ComposeProject,
  type ComposeService,
  compose,
  composeOk,
  DOCKER,
  docker,
  dockerSkipReason,
  LABEL,
  limitProblems,
  localServerCompose,
  projectContainers,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
} from "./docker-support";
import {
  BASE_ANSWERS,
  type Expected,
  exampleNames,
  plannedComponents,
  plantedSecrets,
  readExpected,
  readPlan,
  ScriptedApprovals,
} from "./support";

const TWENTY_MINUTES = 1_200_000;
const STEP_TIMEOUT = 180_000;

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
  /** Where the interview puts the app: Hetzner (the default), a server the user owns, a Portainer. */
  target?: "own" | "portainer";
  /** A change the user makes in opscrew/plan.yaml after design, before adapt. */
  planEdit?: (plan: DeployPlan) => DeployPlan;
}

/** nextjs-postgres with Prisma migrations, which the release command applies. */
const PRISMA: Case = {
  name: "nextjs-postgres-prisma",
  example: "nextjs-postgres",
  overlay: "prisma",
  devDependencies: { prisma: "^7.10.1" },
};

/** The cron job a user adds to celery-worker's plan: a command, which design never finds in code. */
function withHeartbeat(plan: DeployPlan): DeployPlan {
  const job = { name: "heartbeat", schedule: "* * * * *", command: "python heartbeat.py" };
  const cron = [...plan.processes.cron, { ...job, enabled: true }];
  return { ...plan, processes: { ...plan.processes, cron } };
}

/** MongoDB as a one-node replica set, the plan's option for clients that need one (Prisma). */
function withReplicaSet(plan: DeployPlan): DeployPlan {
  const services = plan.services.map((service) =>
    service.kind === "mongodb" ? { ...service, options: { replicaSet: true } } : service,
  );
  return { ...plan, services };
}

/** How the pass designs some examples. */
const DESIGNED: Readonly<Record<string, Partial<Case>>> = {
  "celery-worker": { planEdit: withHeartbeat },
  // Locally the bucket is Garage, which design plans on a server the user owns.
  "s3-uploads": { target: "own" },
};

/** Every example with an `expected.json`, plus the variants. */
const ALL_CASES: Case[] = [
  ...exampleNames().map((name) => ({ name, example: name, ...DESIGNED[name] })),
  PRISMA,
  {
    name: "node-mongo-portainer",
    example: "node-mongo",
    target: "portainer",
    planEdit: withReplicaSet,
  },
  { name: "s3-uploads-portainer", example: "s3-uploads", target: "portainer" },
];
const ALL_NAMES = ALL_CASES.map((c) => c.name);

/** OPSCREW_DOCKER_EXAMPLES=a,b, or undefined for every example. */
const REQUESTED = process.env.OPSCREW_DOCKER_EXAMPLES?.split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const CASES =
  REQUESTED === undefined || REQUESTED.length === 0
    ? ALL_CASES
    : ALL_CASES.filter((c) => REQUESTED.includes(c.name));

const SKIP = dockerSkipReason() ?? (GIT === undefined ? "git is not installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping the local Docker pass over examples/: ${SKIP}.`);

/** Everything this file started or built, removed in afterAll even when a test failed. */
const containers = new Set<string>();
const images = new Set<string>();
/** Compose projects started by this file, by name. */
const composeProjects = new Map<string, ComposeProject>();
/** Image tags pack built, whose cache volumes are removed. */
const packTags = new Set<string>();

/** Stops a Compose project and removes its containers, network and volumes. */
async function composeDown(name: string): Promise<void> {
  const project = composeProjects.get(name);
  if (project === undefined) return;
  const down = await compose(project, ["down", "-v", "--remove-orphans"]);
  if (down.exitCode !== 0 || down.timedOut) {
    // Kept in the list, so the file's afterAll tries again.
    console.warn(
      `docker compose down of ${name} failed (${down.timedOut ? "timed out" : `exit ${down.exitCode}`}):\n${tail(down.stderr, 10)}`,
    );
    return;
  }
  composeProjects.delete(name);
}

/** The interview's answers about a server the user owns (a fake one: nothing reaches it). */
const OWN_ANSWERS = {
  provider: "own",
  "server.host": OWN_IPV4,
  "server.port": 22,
  "server.user": "root",
  "server.key": "agent",
  "server.reachable": true,
};

/** The interview's answers about a Portainer (a fake one lists its environment). */
const PORTAINER_ANSWERS = {
  provider: "portainer",
  "portainer.url": PORTAINER_URL,
  "portainer.environment": "local",
  "portainer.redeploy": "updater",
  "portainer.web": "proxy",
  "portainer.port": 8080,
};

/** Portainer's certificate, as the fake one shows it (`--portainer-cert`). */
const PORTAINER_CERT = `SHA256:${"AB:".repeat(31)}AB`;

/** A Portainer with one Docker environment, which never sees a request beyond these two. */
const PORTAINER_ACCESS: PortainerAccess = {
  fetchCertificateFingerprint: async () => PORTAINER_CERT,
  listEnvironments: async () => [{ id: 1, name: "local", kind: "docker", up: true, arch: "amd64" }],
};

/** What rendering the Portainer stack needs here; none of it reaches the file. */
const STACK_CONTEXT: RenderContext = {
  opscrewVersion: "test",
  github: { owner: "acme", repo: "app" },
  deploySshPublicKey: "",
};

/** Where and how the app runs: OpsCrew's server Compose project, or its Portainer stack. */
interface Deployment {
  kind: "server" | "stack";
  project: ComposeProject;
}

/** A step of a service's one-time setup (`initStepsFor`). */
type InitStep = ReturnType<typeof initStepsFor>[number];

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
 * The app's Portainer stack (`renderPortainerStack`'s content) as `docker compose` runs it here:
 * with `image`, the one built above (the deploy workflow writes the digest it pushed), without
 * Caddy and the tunnel's connector (TLS and the way in are not under test), and with the app's
 * port published on 127.0.0.1 for the checks.
 */
function localStack(content: string, image: string, port: number): string {
  const doc = parse(
    content
      .replaceAll(PORTAINER_IMAGE_PLACEHOLDER, image)
      .replaceAll(PORTAINER_VERSION_PLACEHOLDER, "local"),
  ) as { services: Record<string, ComposeService>; configs: Record<string, unknown> };
  delete doc.services.caddy;
  delete doc.services.cloudflared;
  delete doc.configs.caddyfile;
  const app = doc.services.app;
  if (app !== undefined) app.ports = [`127.0.0.1::${port}`];
  return stringify(doc, { lineWidth: 0 });
}

/** The services of the Compose file OpsCrew renders for the plan's target. */
function renderedServices(plan: DeployPlan): Record<string, ComposeService> {
  const rendered =
    plan.target.provider === "portainer"
      ? renderPortainerStack(plan, STACK_CONTEXT)
      : renderCompose(plan);
  return (parse(rendered.content) as { services: Record<string, ComposeService> }).services;
}

/**
 * The app's Compose health check command (`renderCompose`), as `docker exec` arguments: without
 * `CMD` and with Compose's `$$` back to `$`. Undefined when the plan has none (own Dockerfiles),
 * and in a Portainer stack, whose app has none.
 */
function healthCommand(plan: DeployPlan): string[] | undefined {
  if (plan.target.provider === "portainer") return undefined;
  const doc = parse(renderCompose(plan).content) as {
    services: { app: { healthcheck?: { test: string[] } } };
  };
  const test = doc.services.app.healthcheck?.test;
  return test?.slice(1).map((arg) => arg.replaceAll("$$", "$"));
}

/** True when the plan runs more than the web process: services, workers, cron or storage. */
function hasComponents(plan: DeployPlan): boolean {
  return (
    plan.services.some((service) => service.enabled) ||
    plan.processes.workers.some((worker) => worker.enabled) ||
    plan.processes.cron.some((job) => job.enabled) ||
    plan.storage !== undefined
  );
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
  /** The example names its components, and answers on the routes the component checks call. */
  components: Expected["components"];
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
      let deployment: Deployment | undefined;
      /** The secret values the pass knows for the app, with the labels a failure shows. */
      const known: { label: string; value: string }[] = [];
      /** The fake server the user owns, which design inspects (`target: own`). */
      const host = new FakeHostServer();
      let home = "";

      /**
       * Runs `opscrew <args>` in the project and returns what it printed; fails with that output
       * on a non-zero exit.
       */
      async function opscrew(...args: string[]): Promise<string> {
        if (project === undefined) throw new Error("no project");
        const ctx = projectContext(project, {
          services: {
            runtime,
            approvalHandler: approvals,
            ...(testCase.target === "own"
              ? { runner: new OwnRunner(), provision: { own: ownServices(host, home) } }
              : {}),
            ...(testCase.target === "portainer" ? { portainerAccess: PORTAINER_ACCESS } : {}),
          },
        });
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

      /** The current deployment, or an error pointing at the health test. */
      function deployed(): Deployment {
        if (deployment === undefined) {
          throw new Error(`${example}: the app was not deployed (see the tests above).`);
        }
        return deployment;
      }

      /**
       * Writes OpsCrew's server Compose project for the plan as a deploy leaves it in the app's
       * folder (the Compose file adapted to this computer, `.env` naming the image, `app.env` and
       * each service's env file with the values provision assembles), then deploys it
       * ({@link serverDeploy}). Returns the app container's name.
       */
      async function deployServer(plan: DeployPlan, env: Map<string, string>, all: AppEnvironment) {
        if (project === undefined) throw new Error("no project");
        const dir = path.join(project.dir, "server");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, "compose.yaml");
        await writeFile(file, localServerCompose(plan, plan.app.port));
        await writeFile(path.join(dir, ".env"), `APP_IMAGE=${tag}\n`);
        const appEnv = new Map(env);
        appEnv.delete("PORT");
        await writeFile(path.join(dir, "app.env"), envFileText(appEnv));
        const secrets = serviceEnvSecrets(plan, all);
        for (const service of plan.services.filter((s) => s.enabled)) {
          const text = secrets[serviceEnvSecret(service.name)];
          if (text !== undefined) await writeFile(path.join(dir, `${service.name}.env`), text);
        }
        deployment = { kind: "server", project: { name: container, file } };
        composeProjects.set(container, deployment.project);
        await serverDeploy(plan, deployment);
        return `${container}-app-1`;
      }

      /**
       * The deploy's steps on a server (`switchCommands`) without the edge and the switch: the
       * services up and healthy (the one-shot `sysctl` container first, named, as `--no-deps`
       * starts no dependency), their one-time setup, the release command in a one-off container
       * (a failure fails the test with its output), the app, then the workers and cron.
       */
      async function serverDeploy(plan: DeployPlan, at: Deployment): Promise<void> {
        const services = plan.services.filter((s) => s.enabled).map((s) => s.name);
        const steady = [...hostSettingsServices(plan), ...services];
        if (steady.length > 0) {
          const up = await compose(
            at.project,
            ["up", "-d", "--no-deps", "--wait", ...steady],
            TEN_MINUTES,
          );
          if (up.exitCode !== 0) {
            const logs = await compose(at.project, ["logs", "--tail", "40", ...steady]);
            throw new Error(
              `${example}: the services did not start (exit ${up.exitCode}):\n${tail(up.stderr, 20)}\nTheir logs:\n${tail(logs.stdout, 80)}`,
            );
          }
        }
        for (const step of initStepsFor(plan)) await initStep(at, step);
        if (plan.app.releaseCommand !== undefined) {
          const ran = await compose(
            at.project,
            ["run", "--rm", "--no-deps", "-T", "release"],
            TEN_MINUTES,
          );
          if (ran.exitCode !== 0) {
            throw new Error(
              `${example}: the release command \`${plan.app.releaseCommand}\` failed (exit ${ran.exitCode}):\n${tail(`${ran.stdout}\n${ran.stderr}`)}`,
            );
          }
          console.info(`${example}: release command output:\n${tail(ran.stdout, 20)}`);
        }
        await composeOk(at.project, `${example}: docker compose up app`, [
          "up",
          "-d",
          "--no-deps",
          "app",
        ]);
        const processes = [
          ...plan.processes.workers.filter((worker) => worker.enabled).map((worker) => worker.name),
          ...(plan.processes.cron.some((job) => job.enabled) ? ["cron"] : []),
        ];
        if (processes.length > 0) {
          await composeOk(at.project, `${example}: the workers and cron`, [
            "up",
            "-d",
            "--no-deps",
            ...processes,
          ]);
        }
      }

      /**
       * One step of a service's one-time setup, as the deploy runs it: `run` in the service's
       * container only when `check` fails there.
       */
      async function initStep(at: Deployment, step: InitStep): Promise<void> {
        const exec = (words: readonly string[]) =>
          compose(at.project, ["exec", "-T", step.service, ...words]);
        if ((await exec(step.check)).exitCode === 0) return;
        const ran = await exec(step.run);
        if (ran.exitCode !== 0) {
          throw new Error(
            `${example}: the one-time setup of ${step.service} failed (exit ${ran.exitCode}) at \`${step.run.join(" ")}\`:\n${tail(`${ran.stdout}\n${ran.stderr}`, 20)}`,
          );
        }
      }

      /**
       * Runs the app's Portainer stack with `docker compose up -d`, as Portainer deploys it: the
       * stack's variables (`portainerStackEnvKeys`) in an env file, with the app's values and the
       * services' secrets as provision fills them in. Returns the app container's name.
       */
      async function deployStack(plan: DeployPlan, env: Map<string, string>, all: AppEnvironment) {
        if (project === undefined) throw new Error("no project");
        const dir = path.join(project.dir, "stack");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, "compose.yaml");
        const stack = renderPortainerStack(plan, STACK_CONTEXT).content;
        await writeFile(file, localStack(stack, tag, plan.app.port));
        const keys = portainerStackEnvKeys(plan);
        const opscrewValues: Record<string, string | undefined> = {
          [PORTAINER_STACK_VARIABLES.dbUser]: all.values.db?.user,
          [PORTAINER_STACK_VARIABLES.dbName]: all.values.db?.name,
        };
        for (const { service, secret, variable } of portainerSecretVariables(plan)) {
          opscrewValues[variable] = all.values.services[service]?.[secret];
        }
        // A stack cannot leave a variable unset: an unknown value is sent empty.
        const values = new Map([
          ...keys.app.map((key) => [key, env.get(key) ?? ""] as const),
          ...keys.opscrew.map((key) => [key, opscrewValues[key] ?? ""] as const),
        ]);
        const envFile = path.join(dir, "stack.env");
        await writeFile(envFile, envFileText(values));
        deployment = { kind: "stack", project: { name: container, file, envFile } };
        composeProjects.set(container, deployment.project);
        await composeOk(deployment.project, `${example}: the stack`, ["up", "-d"], TEN_MINUTES);
        return `${container}-app-1`;
      }

      /**
       * A stack's one-time setup: every `-init` container exited 0 (so the app started), and
       * MongoDB in a replica set has a primary that accepts writes.
       */
      async function checkStackSetup(plan: DeployPlan, when: string): Promise<void> {
        if (deployment?.kind !== "stack") return;
        const inits = (await projectContainers(container)).filter((c) =>
          c.service.endsWith("-init"),
        );
        for (const init of inits) {
          expect(
            { running: init.running, exitCode: init.exitCode },
            `${init.name} ${when}`,
          ).toEqual({
            running: false,
            exitCode: 0,
          });
        }
        for (const service of plan.services) {
          if (service.kind !== "mongodb" || !service.enabled || !service.options.replicaSet) {
            continue;
          }
          const status = await compose(deployment.project, [
            "exec",
            "-T",
            service.name,
            "bash",
            "-c",
            'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval \'JSON.stringify({ set: rs.status().set, primary: db.hello().isWritablePrimary })\'',
          ]);
          expect(
            status.stdout.trim(),
            `MongoDB's replica set ${when}: ${tail(status.stderr, 5)}`,
          ).toBe(JSON.stringify({ set: "rs0", primary: true }));
          console.info(`${example}: MongoDB's replica set rs0 has a writable primary ${when}`);
        }
        console.info(
          `${example}: the stack's one-time setup ${when}: ${inits.map((c) => c.service).join(", ") || "none"} exited 0`,
        );
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
        if (testCase.target === "own") home = await fakeHome(project);
        // The interview needs a token to list the fake Portainer's environments.
        if (testCase.target === "portainer") {
          env.PORTAINER_API_KEY = fakeSecret("generic-password", "docker-pass-portainer");
        }
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
          // `expected.json` names, and an app with object storage lets OpsCrew create its bucket
          // (Garage, next to the app).
          const answers = {
            ...(expected.chosenApp !== undefined ? { appDir: expected.chosenApp.appDir } : {}),
            ...(expected.components?.objectStorage === true
              ? { keepExternalServices: { s3: false } }
              : {}),
            ...BASE_ANSWERS,
            ...(testCase.target === "own" ? OWN_ANSWERS : {}),
            ...(testCase.target === "portainer" ? PORTAINER_ANSWERS : {}),
          };
          await writeFile(answersFile, `${JSON.stringify(answers, null, 2)}\n`);
          const exampleValues = await envExampleValues(root);

          await opscrew("analyze", "--no-ai");
          await opscrew(
            "interview",
            "--answers",
            answersFile,
            ...(testCase.target === "portainer" ? ["--portainer-cert", PORTAINER_CERT] : []),
          );
          await opscrew(
            "design",
            ...(testCase.target === "own" ? ["--host-key", ED25519_FINGERPRINT] : []),
          );
          if (testCase.planEdit !== undefined) {
            const file = path.join(root, "opscrew", "plan.yaml");
            await writeArtifact("plan", file, testCase.planEdit(await readPlan(root)));
          }
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
          console.info(
            `${example}: target ${plan.target.provider}; components ${JSON.stringify(plannedComponents(plan))}`,
          );
          prepared = {
            plan,
            appKind: architecture.facts.appKind,
            appDir: architecture.facts.appDir ?? ".",
            buildEnv: plan.app.env.map((v) => v.name).filter((name) => clientExposed.has(name)),
            exampleValues,
            components: expected.components,
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
          // and fixed production settings (RAILS_ENV, APP_KEY) are the ones provision assembles,
          // and so are the services' addresses and secrets when the app runs with its services.
          const assembled = await assembleAppEnv({ plan, ask: async () => ({ skip: true }) });
          for (const [name, value] of Object.entries(assembled.generated.env ?? {})) {
            known.push({ label: `the generated ${name}`, value });
          }
          for (const [service, secrets] of Object.entries(assembled.values.services)) {
            for (const [secret, value] of Object.entries(secrets)) {
              known.push({ label: `the ${service} service's ${secret}`, value });
            }
          }
          const release = plan.app.releaseCommand !== undefined;
          // An example that names its components always runs as a Compose project, as deployed.
          const withServices = release || hasComponents(plan) || prepared.components !== undefined;
          const fromOpsCrew = (variable: DeployPlan["app"]["env"][number]) =>
            withServices ||
            variable.source === "generated" ||
            fixedProductionValue(variable.name) !== undefined;
          const env = new Map<string, string>([["PORT", String(port)]]);
          for (const variable of plan.app.env) {
            if (variable.name === "PORT" || prepared.buildEnv.includes(variable.name)) continue;
            env.set(
              variable.name,
              (fromOpsCrew(variable) ? assembled.values.app[variable.name] : undefined) ??
                placeholder(variable.name, exampleValues.get(variable.name)),
            );
          }
          if (withServices) {
            for (const [name, value] of Object.entries(assembled.values.app)) {
              if (!env.has(name) && !prepared.buildEnv.includes(name)) env.set(name, value);
            }
          }
          const name =
            plan.target.provider === "portainer"
              ? await deployStack(plan, env, assembled)
              : withServices
                ? await deployServer(plan, env, assembled)
                : container;
          if (!withServices) {
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
          // Every path must answer 200 within two minutes; the health path left to the model any
          // status below 500, so the server routes requests.
          const deadline = Date.now() + TWO_MINUTES;
          let healthRoute = true;
          for (const urlPath of paths) {
            const anyStatus = leftToModel && urlPath === plan.app.healthPath;
            try {
              const answer = await untilAnswer(
                name,
                port,
                { path: urlPath },
                Math.max(0, deadline - Date.now()),
                (a) => a.status === 200 || (anyStatus && a.status < 500),
              );
              if (answer.status !== 200) {
                healthRoute = false;
                console.warn(
                  `${example}: the health route is left to the Code-change agent (adapt --no-ai); the server answers HTTP ${answer.status} on ${urlPath}`,
                );
              }
            } catch (error) {
              const pending = leftToModel
                ? " The plan's health-endpoint change is still pending (left to the Code-change agent by adapt --no-ai)."
                : "";
              throw new Error(
                `${example}: ${error instanceof Error ? error.message : String(error)}${pending}`,
              );
            }
          }
          running = { container: name, healthRoute };
        },
        TWENTY_MINUTES,
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

      // The components (013), for the examples whose `expected.json` names them: each answers
      // `PUT` and `GET /data`, and with workers `POST` and `GET /jobs/<id>`, with cron `GET /cron`.

      it("every container has its memory limit, and no service publishes a port", async (ctx) => {
        if (prepared?.components === undefined) return ctx.skip();
        app();
        const services = renderedServices(prepared.plan);
        const found = await projectContainers(container);
        console.info(
          `${example}: memory limits ${found.map((c) => `${c.service} ${c.memory / 1048576} MB`).join(", ")}`,
        );
        expect(found.length, `${example}: the project's containers`).toBeGreaterThan(0);
        // Every service of the rendered file has its limit, Portainer's Caddy (left out here)
        // too, and only that Caddy publishes a port: it serves the site. Here the app alone
        // publishes its port, on 127.0.0.1, for these checks.
        const problems = [
          ...Object.entries(services)
            .filter(([, service]) => service.mem_limit === undefined)
            .map(([name]) => `the rendered ${name} has no mem_limit`),
          ...Object.entries(services)
            .filter(([name, service]) => service.ports !== undefined && name !== "caddy")
            .map(([name, service]) => `the rendered ${name} publishes ${service.ports?.join(" ")}`),
          ...limitProblems(found, services),
          ...found
            .filter((c) => c.ports.length > 0 && c.service !== "app")
            .map((c) => `${c.name} publishes ${c.ports.join(" ")}`),
        ];
        expect(problems, `${example}: memory limits and published ports`).toEqual([]);
      });

      it(
        "a job queued through the app is consumed within 30 seconds, and the workers keep running",
        async (ctx) => {
          const workers = prepared?.plan.processes.workers.filter((worker) => worker.enabled);
          if (prepared?.components === undefined || !workers?.length) return ctx.skip();
          const { container: name } = app();
          const port = prepared.plan.app.port;
          const processes = new Set([...workers.map((worker) => worker.name), "cron"]);
          const processStates = async () =>
            (await projectContainers(container))
              .filter((c) => processes.has(c.service))
              .map((c) => ({
                name: c.name,
                running: c.running,
                restarts: c.restarts,
                oomKilled: c.oomKilled,
                seconds: Math.round((Date.now() - Date.parse(c.startedAt)) / 1000),
              }));
          const id = `job-${randomBytes(4).toString("hex")}`;
          await untilAnswer(
            name,
            port,
            { method: "POST", path: `/jobs/${id}` },
            30_000,
            (a) => a.status < 300,
          );
          const queued = Date.now();
          try {
            await untilAnswer(name, port, { path: `/jobs/${id}` }, 30_000, (a) => a.status === 200);
          } catch (error) {
            const names = workers.map((worker) => worker.name);
            const logs = await compose(deployed().project, ["logs", "--tail", "30", ...names]);
            const states = (await processStates()).map((state) => JSON.stringify(state));
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\nThe workers: ${states.join(", ")}. Their logs:\n${tail(logs.stdout, 60)}`,
            );
          }
          const consumed = Date.now() - queued;
          console.info(
            `${example}: the job was consumed ${(consumed / 1000).toFixed(1)} s after it was queued`,
          );
          expect(consumed, "milliseconds until the job was consumed").toBeLessThanOrEqual(30_000);
          // The deploy's own check: every worker and cron container stays up for 30 seconds,
          // without restarts.
          const youngest = Math.min(...(await processStates()).map(({ seconds }) => seconds));
          if (youngest < 30)
            await new Promise((resolve) => setTimeout(resolve, (30 - youngest) * 1000));
          const states = await processStates();
          expect(states, `${example}: the workers and cron`).toEqual(
            states.map(({ name, seconds }) => ({
              name,
              running: true,
              restarts: 0,
              oomKilled: false,
              seconds,
            })),
          );
          for (const { name, seconds } of states) {
            console.info(`${example}: ${name} has been running for ${seconds} s`);
          }
        },
        TWO_MINUTES,
      );

      it(
        "a cron job runs within one minute of its schedule",
        async (ctx) => {
          const jobs = prepared?.plan.processes.cron.filter((job) => job.enabled);
          if (prepared?.components === undefined || !jobs?.length) return ctx.skip();
          const { container: name } = app();
          // Every example's job runs each minute: the first run is due at the first full minute
          // after cron started.
          expect(jobs.map((job) => job.schedule)).toEqual(jobs.map(() => "* * * * *"));
          const cron = (await projectContainers(container)).find((c) => c.service === "cron");
          if (cron === undefined) throw new Error(`${example}: no cron container is running.`);
          const due = Math.ceil(Date.parse(cron.startedAt) / 60_000) * 60_000;
          // supercronic logs each run that succeeded with its time (the engine's clock, as the
          // container's start): the first one must be within a minute of the first due time.
          let first: number | undefined;
          while (first === undefined && Date.now() <= due + 70_000) {
            const logs = await docker(["logs", cron.name]);
            const succeeded = `${logs.stdout}\n${logs.stderr}`
              .split(/\r?\n/)
              .find((line) => line.includes('msg="job succeeded"'));
            const time = /time="([^"]+)"/.exec(succeeded ?? "")?.[1];
            if (time !== undefined) first = Date.parse(time);
            else await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          if (first === undefined) {
            const logs = await docker(["logs", "--tail", "20", cron.name]);
            throw new Error(
              `${example}: no cron job succeeded within a minute of ${new Date(due).toISOString()}. supercronic's log:\n${tail(`${logs.stdout}\n${logs.stderr}`, 20)}`,
            );
          }
          console.info(
            `${example}: the first cron run succeeded at ${new Date(first).toISOString()}, ${((first - due) / 1000).toFixed(1)} s after it was due at ${new Date(due).toISOString()}`,
          );
          expect(first, "the first run, within a minute of its due time").toBeLessThanOrEqual(
            due + 60_000,
          );
          // And the job did its work: the app counted the run.
          const answer = await untilAnswer(
            name,
            prepared.plan.app.port,
            { path: "/cron" },
            10_000,
            (a) => a.status === 200,
          );
          console.info(`${example}: GET /cron: ${answer.text}`);
        },
        3 * 60_000,
      );

      it(
        "a value written through the app is read back after docker compose restart and after a redeploy",
        async (ctx) => {
          if (prepared?.components === undefined) return ctx.skip();
          const { container: name } = app();
          const { plan } = prepared;
          const port = plan.app.port;
          const at = deployed();
          const write = async (value: string) => {
            await untilAnswer(
              name,
              port,
              { method: "PUT", path: "/data", body: value },
              60_000,
              (a) => a.status < 300,
            );
          };
          const readBack = async (value: string, when: string) => {
            await untilAnswer(
              name,
              port,
              { path: "/data" },
              TWO_MINUTES,
              (a) => a.status === 200 && a.text === value,
            );
            console.info(`${example}: read the value back ${when}`);
          };
          await checkStackSetup(plan, "after the first up");
          const value = `value-${randomBytes(6).toString("hex")}`;
          await write(value);
          await readBack(value, "after writing it");
          await composeOk(
            at.project,
            `${example}: docker compose restart`,
            ["restart"],
            TEN_MINUTES,
          );
          await readBack(value, "after docker compose restart");
          if (at.kind === "stack") {
            // Portainer's redeploy of an unchanged stack.
            await composeOk(at.project, `${example}: the second up`, ["up", "-d"], TEN_MINUTES);
            await checkStackSetup(plan, "after the second up");
            await readBack(value, "after the second up");
          }
          // Every container goes, with the anonymous volumes of images' own VOLUME lines; the
          // named volumes stay.
          const remove = ["rm", "--stop", "--force", "--volumes"];
          await composeOk(at.project, `${example}: docker compose rm`, remove, TEN_MINUTES);
          if (at.kind === "server") await serverDeploy(plan, at);
          else await composeOk(at.project, `${example}: up after rm`, ["up", "-d"], TEN_MINUTES);
          await checkStackSetup(plan, "after the containers were removed and up");
          await readBack(value, "after a redeploy");
          // And the setup still lets the app write.
          const next = `value-${randomBytes(6).toString("hex")}`;
          await write(next);
          await readBack(next, "after writing a new value");
        },
        3 * TEN_MINUTES,
      );
    });
  },
);

/** An env file's text: one `NAME=value` line each, quoted as Compose reads it literally. */
function envFileText(values: ReadonlyMap<string, string>): string {
  return [...values].map(([name, value]) => `${dotenvLine(name, value)}\n`).join("");
}

/** One answer of the app: its status and body. */
interface Answer {
  status: number;
  text: string;
}

/**
 * Asks the app `request` on its published port (looked up each time: a restarted container may
 * get another) every two seconds until `done` accepts the answer or `ms` passed, and returns that
 * answer; fails with the last answer or error seen. A connection error counts as no answer yet, and
 * a redirect is an answer of its own, not followed.
 */
async function untilAnswer(
  container: string,
  port: number,
  request: { method?: string; path: string; body?: string },
  ms: number,
  done: (answer: Answer) => boolean,
): Promise<Answer> {
  const what = `${request.method ?? "GET"} ${request.path}`;
  const deadline = Date.now() + ms;
  let last = "no answer yet";
  for (;;) {
    const published = await docker(["port", container, `${port}/tcp`]);
    const address = /127\.0\.0\.1:(\d+)/.exec(published.stdout)?.[0];
    if (address !== undefined) {
      try {
        const response = await fetch(`http://${address}${request.path}`, {
          method: request.method ?? "GET",
          ...(request.body === undefined
            ? {}
            : { body: request.body, headers: { "content-type": "text/plain" } }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        const answer = { status: response.status, text: await response.text() };
        if (done(answer)) return answer;
        last = `HTTP ${answer.status} ${answer.text.slice(0, 200)}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    } else {
      last = "the app's port is not published (the container is not running)";
    }
    if (Date.now() >= deadline) {
      const logs = await docker(["logs", "--tail", "30", container]);
      throw new Error(
        `${container}: ${what} did not answer as expected within ${Math.round(ms / 1000)} s (last: ${last}). The end of its log:\n${tail(`${logs.stdout}\n${logs.stderr}`, 30)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

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
