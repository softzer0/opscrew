// Feature 025 (T2507): services' secrets rotated in the user's Portainer, through Docker's exec on
// its proxy and the app's stack plan, which the rotation's one approval covers.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { portainerClient } from "@opscrew/connector-portainer";
import { exists, findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE, portainerStackName, serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type PlanService,
  readArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../provision/portainer";
import { portainerStacksFor } from "../provision/portainer-flow";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { generatedValuesFile } from "../shared/app-secrets";
import { recordPortainerConnection } from "../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  type FakePortainerOptions,
  fakeCertificate,
  fakePortainer,
  fakeSharedCloudflare,
  ownCloudflare,
  PORTAINER_URL,
  portainerPlan,
  portainerPlanJson,
  projectRunner,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
} from "../testing";
import { rotatePortainerServices } from "./portainer";
import { credentialsRecordFile } from "./record";
import { pendingRotationFile } from "./values-pending";

const PORTAINER_TOKEN = fakeSecret("generic-password", "rotation portainer token");
const REPO_TOKEN = fakeSecret("github-pat", "rotation repository read token");
const GHCR_TOKEN = fakeSecret("github-token", "rotation ghcr read token");
const STRIPE = fakeSecret("stripe-live-key", "rotation");
const CERT = fakeCertificate("rotation portainer");
const UUIDS = ["6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e"];

function service(name: string, kind: PlanService["kind"]) {
  const spec = serviceSpec(kind);
  return {
    name,
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    enabled: true,
    options: kind === "valkey" ? { mode: "cache" } : {},
    reason: "The app uses it.",
    licence: spec.licence.id,
  };
}

/**
 * The app in Portainer behind the user's own proxy, with PostgreSQL (a swap), Valkey (seamless)
 * and Meilisearch (a restart).
 */
function plan(): DeployPlan {
  const base = portainerPlan({ web: { mode: "proxy", port: 8080 } });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      env: [
        ...base.app.env,
        // The user's own values a dotenv line does not carry as they are.
        { name: "GREETING", secret: false, source: "user" },
        { name: "NOTE", secret: false, source: "user", optional: true },
      ],
    },
    services: [...base.services, service("cache", "valkey"), service("search", "meilisearch")],
  });
}

/** The user's own values, as `production.env` holds them and the app must get them. */
const GREETING = "it's $5 and `$HOME`";
const NOTE = "two lines\nwith $PATH in them";
const PRODUCTION_ENV = [
  `STRIPE_SECRET_KEY=${STRIPE}`,
  `GREETING="it's $5 and \`$HOME\`"`,
  'NOTE="two lines\\nwith $PATH in them"',
].join("\n");

/** Docker on the environment through Portainer's proxy: the app's containers and its exec. */
class FakeDocker {
  readonly execs: { service: string; command: readonly string[]; env: Record<string, string> }[] =
    [];
  readonly running = new Set(["app", "db", "cache", "search"]);
  /** Services still on a start command from before 025. */
  readonly stale = new Set<string>();
  /** The deploy pause when each exec ran. */
  readonly pauses: (string | undefined)[] = [];
  /** The exit code of a command (default 0). */
  answer: (service: string, command: readonly string[]) => number = () => 0;

  constructor(
    private readonly plan: DeployPlan,
    private readonly github: FakeGitHub,
  ) {}

  async listContainers() {
    return [...this.running].map((name) => ({
      id: `c${name}`,
      project: portainerStackName(this.plan),
      service: name,
      running: true,
      publishedPorts: [],
    }));
  }

  async containerInspect(_environment: number, id: string) {
    const s = this.plan.services.find((each) => each.name === id.slice(1));
    const spec = s === undefined ? undefined : serviceSpec(s.kind);
    const ctx = { plan: this.plan, service: s as PlanService, secretRef: () => "" };
    const command = this.stale.has(id.slice(1)) ? ["old-start"] : spec?.command?.(ctx);
    const entrypoint = spec?.entrypoint?.(ctx);
    return {
      restartCount: 0,
      startedAt: "2026-11-08T09:00:00Z",
      ...(command === undefined ? {} : { command }),
      ...(entrypoint === undefined ? {} : { entrypoint }),
    };
  }

  async containerExec(
    _environment: number,
    id: string,
    input: { command: readonly string[]; env: Readonly<Record<string, string>> },
  ) {
    const service = id.slice(1);
    this.execs.push({ service, command: input.command, env: { ...input.env } });
    this.pauses.push(this.github.variables.get(DEPLOY_PAUSED_VARIABLE));
    return this.answer(service, input.command);
  }
}

/** A GitHub fake that also creates the deploy branch where pushes go. */
class PortainerGitHub extends FakeGitHub {
  constructor(private readonly createRef: (branch: string) => Promise<void>) {
    super();
  }
  override async createOrphanBranch(input: { branch: string; path: string; content: string }) {
    const created = await super.createOrphanBranch(input);
    await this.createRef(input.branch);
    return created;
  }
}

interface World {
  deps: TestPhaseDeps;
  handler: ScriptedApprovalHandler;
  plan: DeployPlan;
  portainer: ReturnType<typeof fakePortainer>;
  /** The fake's options: a test adds failures to it. */
  portainerOptions: FakePortainerOptions;
  docker: FakeDocker;
  github: FakeGitHub;
  /** The approvals provision asked before the rotation. */
  provisioned: number;
  services: ProvisionServices;
  /** The project, with its `production.env`. */
  root: string;
  /** The values each service had before, by `<service>/<secret>`. */
  old: Map<string, string>;
  rotate(
    names: readonly string[],
    options?: { undo?: boolean },
  ): ReturnType<typeof rotatePortainerServices>;
}

/** The app set up in Portainer by provision, then rotations through the same services. */
async function world(
  answer?: (request: { kind: string; planHash?: string }) => boolean,
): Promise<World> {
  const p = plan();
  const project = await createProject(p);
  await writeFile(join(project.root, "production.env"), `${PRODUCTION_ENV}\n`);
  const portainerOptions: FakePortainerOptions = { token: PORTAINER_TOKEN, failures: {} };
  const portainer = fakePortainer(portainerOptions);
  const github = new PortainerGitHub(async (branch) => {
    const head = await project.git(project.root, "rev-parse", "HEAD");
    await project.git(project.root, "push", "-q", "origin", `${head}:refs/heads/${branch}`);
  });
  const handler = new ScriptedApprovalHandler(answer ?? (() => true));
  const inherited = { ...process.env };
  for (const name of ["PORTAINER_API_KEY", REPOSITORY_TOKEN_VAR, REGISTRY_TOKEN_VAR]) {
    delete inherited[name];
  }
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...inherited,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      OPSCREW_APP_ENV_FILE: "production.env",
      PORTAINER_API_KEY: PORTAINER_TOKEN,
      [REPOSITORY_TOKEN_VAR]: REPO_TOKEN,
      [REGISTRY_TOKEN_VAR]: GHCR_TOKEN,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  await recordPortainerConnection(deps.paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "proxy", port: 8080 },
  });
  const engine = new FakeEngine({ changes: [], planJson: portainerPlanJson(), outputs: {} });
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: { ...ownCloudflare(), listAccounts: async () => [{ id: "acc-1", name: "acc" }] },
    sleep: async () => undefined,
    // Provision here asks nothing (it is not interactive), and a rotation never asks.
    askEnv: async () => {
      throw new Error("The rotation asked for an app value.");
    },
    now: () => 0,
    portainer: {
      client: (endpoint, token, clientDeps) =>
        portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
      inspectCertificate: async () => CERT,
      randomUUID: () => UUIDS[0] as string,
      wait: { now: () => 0, sleep: async () => undefined },
    },
    sharedCloudflare: fakeSharedCloudflare(),
  };
  const set = await runProvision(deps, { services });
  expect(set.stackApplied).toBe(true);
  const kept = JSON.parse(await readFile(generatedValuesFile(deps), "utf8")) as Generated;
  const old = valuesOf(p, kept);
  const docker = new FakeDocker(p, github);
  return {
    deps,
    root: project.root,
    handler,
    plan: p,
    portainer,
    portainerOptions,
    docker,
    github,
    provisioned: handler.requests.length,
    services,
    old,
    rotate: (names, options = {}) =>
      rotatePortainerServices(deps, p, names, {
        ...options,
        services: { provision: services, docker },
      }),
  };
}

interface Generated {
  dbPassword: string;
  services: Record<string, Record<string, string>>;
}

/** The services' kept values, by `<service>/<secret>`. */
function valuesOf(p: DeployPlan, kept: Generated): Map<string, string> {
  const values = new Map<string, string>();
  for (const s of p.services) {
    for (const secret of serviceSpec(s.kind).secrets) {
      values.set(
        `${s.name}/${secret.name}`,
        s.kind === "postgres" ? kept.dbPassword : (kept.services[s.name]?.[secret.name] as string),
      );
    }
  }
  return values;
}

/** The new values of the unfinished rotation, by `<service>/<secret>`. */
async function pendingNew(w: World): Promise<Map<string, string>> {
  const pending = JSON.parse(await readFile(pendingRotationFile(w.deps), "utf8")) as {
    services: Record<string, Record<string, { new: string }>>;
  };
  return new Map(
    Object.entries(pending.services).flatMap(([service, secrets]) =>
      Object.entries(secrets).map(([secret, pair]) => [`${service}/${secret}`, pair.new]),
    ),
  );
}

async function current(w: World): Promise<Map<string, string>> {
  return valuesOf(w.plan, JSON.parse(await readFile(generatedValuesFile(w.deps), "utf8")));
}

/** Every value the app's stack holds in Portainer. */
function stackValues(w: World): string {
  return JSON.stringify(w.portainer.stacks.map((stack) => stack.Env));
}

/** The value the app's stack holds for `name`. */
function stackValue(w: World, name: string): string | undefined {
  const app = w.portainer.stacks.find((stack) => stack.Name === portainerStackName(w.plan));
  return app?.Env.find((pair) => pair.name === name)?.value;
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The approvals the rotations asked (after provision's). */
const rotationRequests = (w: World) => w.handler.requests.slice(w.provisioned);

/** No value, old or new, in any output, audit entry, approval or command line. */
function expectNoValue(w: World, values: Iterable<string>, ...texts: string[]) {
  const seen = [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(w.handler.requests),
    JSON.stringify(w.docker.execs.map((e) => e.command)),
    ...texts,
  ].join("\n");
  for (const value of values) expect(seen).not.toContain(value);
}

/** The catalog's commands of `name`'s rotation in `p`: its begins, or its finishes. */
function commandsOf(p: DeployPlan, name: string, which: "begin" | "finish"): number {
  const s = p.services.find((each) => each.name === name) as PlanService;
  const ctx = { plan: p, service: s, secretRef: () => "" };
  return serviceSpec(s.kind).rotation.secrets.flatMap((r) =>
    r.mode === "restart" ? [] : r[which](ctx),
  ).length;
}

describe.skipIf(!findExecutable("git"))("rotatePortainerServices", () => {
  it("one approval covers the begins, the stack plan with the new values and the finishes", async () => {
    const w = await world();
    const result = await w.rotate(["db", "cache", "search"]);
    expect(result).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // One approval: the rotation's, its text with the stack plan's hash, which is bound into it.
    const requests = rotationRequests(w);
    expect(requests.map((r) => r.kind)).toEqual(["remote-exec"]);
    const [request] = requests;
    expect(request?.planHash).toBe(result.hash);
    const stackHash = /Its stack plan's hash: ([0-9a-f]{64})/.exec(request?.details ?? "")?.[1];
    expect(stackHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stackHash).not.toBe(result.hash);
    // The stack's apply creates every running service again: none is said to be seamless, and
    // each one's open connections close.
    const recreated = "created again with its new value when the stack plan applies, about";
    const lines = (request?.details ?? "").split("\n");
    for (const name of ["db (PostgreSQL", "cache (Valkey", "search (Meilisearch"]) {
      const line = lines.find((each) => each.includes(name)) ?? "";
      expect(line).toContain(recreated);
      expect(line).toContain("its open connections close");
    }
    expect(request?.details).toContain("db (PostgreSQL, password): a short swap");
    expect(request?.details).toContain(
      "cache (Valkey, password): it accepts the old and the new value until then",
    );
    expect(request?.details).not.toContain("seamless");
    expect(request?.details).not.toContain("open connections stay");
    expect(request?.details).toContain(`Rotation hash: ${result.hash}`);
    // The stack plan was shown before the approval, by the same hash.
    expect(w.deps.reporter.text()).toContain(stackHash);

    // The begins first (none for Meilisearch's restart), then Valkey's finish.
    const beginCount = commandsOf(w.plan, "db", "begin") + commandsOf(w.plan, "cache", "begin");
    const services = w.docker.execs.map((e) => e.service);
    expect(services.slice(0, beginCount)).toEqual([
      ...Array(commandsOf(w.plan, "db", "begin")).fill("db"),
      ...Array(commandsOf(w.plan, "cache", "begin")).fill("cache"),
    ]);
    expect(services.slice(beginCount)).toEqual(
      Array(commandsOf(w.plan, "cache", "finish")).fill("cache"),
    );

    // Portainer's stack holds the new values, none of the old.
    const now = await current(w);
    for (const [key, value] of now) expect(value).not.toBe(w.old.get(key));
    const held = stackValues(w);
    for (const value of now.values()) expect(held).toContain(value);
    for (const value of w.old.values()) expect(held).not.toContain(value);
    // The user's own values come through byte for byte: quotes, `$`, a real newline.
    expect(stackValue(w, "GREETING")).toBe(GREETING);
    expect(stackValue(w, "NOTE")).toBe(NOTE);
    expect(stackValue(w, "STRIPE_SECRET_KEY")).toBe(STRIPE);
    const db = w.docker.execs.find((e) => e.service === "db");
    expect(db?.env).toEqual({
      OPSCREW_OLD: w.old.get("db/password"),
      OPSCREW_NEW: now.get("db/password"),
    });

    // Deploys paused while every command ran, resumed after.
    expect(w.docker.pauses.length).toBeGreaterThan(0);
    for (const pause of w.docker.pauses) expect(pause).toContain("prod");
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBeUndefined();

    const record = await readArtifact("credentials", credentialsRecordFile(w.deps.paths));
    expect(Object.keys(record.environments.prod ?? {}).sort()).toEqual(["cache", "db", "search"]);
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    expectNoValue(w, [...w.old.values(), ...now.values()]);
  });

  it("stops at a failed command with both ways on, and goes on with the same values and hash", async () => {
    const w = await world();
    w.docker.answer = (service) => (service === "cache" ? 1 : 0);
    const error = await failure(w.rotate(["db", "cache"]));
    expect(error.message).toContain("exited with code 1 in its container in your Portainer");
    expect(error.message).toContain("The rotation stopped while changing cache to its new value");
    expect(error.hint).toContain("`opscrew rotate db cache` again to go on from this step");
    expect(error.hint).toContain("`opscrew rotate db cache --undo` to put the old values back");
    expect(await current(w)).toEqual(w.old);
    expect(stackValues(w)).toContain(w.old.get("db/password"));
    // The deploys stay paused, by the rotation, until it or its undo is run to its end.
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toContain("rotation");

    w.docker.answer = () => 0;
    const dbBegins = w.docker.execs.filter((e) => e.service === "db").length;
    const result = await w.rotate(["db", "cache"]);
    expect(w.docker.execs.filter((e) => e.service === "db")).toHaveLength(dbBegins);
    expect(rotationRequests(w).map((r) => r.planHash)).toEqual([result.hash, result.hash]);
    expect(rotationRequests(w)[1]?.details).toContain("this rotation began earlier");
    const now = await current(w);
    expect(stackValues(w)).toContain(now.get("db/password"));
    expectNoValue(w, [...w.old.values(), ...now.values()], error.message, error.hint ?? "");
  });

  it("refuses an undo once it began to drop the old values, and finishes when run again", async () => {
    const w = await world();
    let execs = 0;
    const beginCount = commandsOf(w.plan, "cache", "begin");
    w.docker.answer = () => (++execs === beginCount + 1 ? 7 : 0);
    const error = await failure(w.rotate(["cache"]));
    expect(error.message).toContain("while dropping the old value of cache");
    expect(error.hint).toContain("it can no longer be undone");
    const undo = await failure(w.rotate(["cache"], { undo: true }));
    expect(undo.message).toContain("can no longer be undone");
    const result = await w.rotate(["cache"]);
    // The switch was done: the same hash, the stack plan not planned again.
    expect(rotationRequests(w).map((r) => r.planHash)).toEqual([result.hash, result.hash]);
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
  });

  it("undoes a rotation whose stack apply failed: the stack plan with the old values, by its own approval", async () => {
    const w = await world();
    w.portainerOptions.failures = { "PUT /api/stacks/": "the stack could not be redeployed" };
    const error = await failure(w.rotate(["db", "cache"]));
    expect(error.message).toContain("while switching the app to the new values");
    // The values this computer keeps stay the old ones until the rotation is done.
    expect(await current(w)).toEqual(w.old);
    const next = await pendingNew(w);
    expect(next.get("db/password")).not.toBe(w.old.get("db/password"));
    w.portainerOptions.failures = {};
    w.docker.execs.length = 0;

    const undone = await w.rotate(["db", "cache"], { undo: true });
    expect(undone).toMatchObject({ undone: true });
    expect(await current(w)).toEqual(w.old);
    expect(rotationRequests(w).map((r) => r.kind)).toEqual([
      "remote-exec",
      "remote-exec",
      "stack-apply",
    ]);
    expect(rotationRequests(w)[1]?.title).toBe("Put back the old values of db and cache in prod");
    const db = w.docker.execs.find((e) => e.service === "db");
    expect(db?.env).toEqual({
      OPSCREW_OLD: next.get("db/password"),
      OPSCREW_NEW: w.old.get("db/password"),
    });
    expect(stackValues(w)).toContain(w.old.get("db/password"));
    expect(stackValues(w)).not.toContain(next.get("db/password"));
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    expect(await exists(credentialsRecordFile(w.deps.paths))).toBe(false);
    expectNoValue(w, [...w.old.values(), ...next.values()], error.message);
  });

  it("goes on with a rotation that began although a service stopped since: its switch starts it again", async () => {
    const w = await world();
    // The rotation stops at cache's change, after db's.
    w.docker.answer = (service) => (service === "cache" ? 1 : 0);
    const error = await failure(w.rotate(["db", "cache"]));
    expect(error.message).toContain("while changing cache to its new value");
    w.docker.answer = () => 0;
    w.docker.running.delete("db");
    // The stack plan's apply creates the app's containers again, db among them.
    const before = w.portainer.calls.length;
    const list = w.docker.listContainers.bind(w.docker);
    w.docker.listContainers = async () => {
      const calls = w.portainer.calls.slice(before);
      if (calls.some((call) => call.startsWith("PUT /api/stacks/"))) w.docker.running.add("db");
      return list();
    };
    const result = await w.rotate(["db", "cache"]);
    expect(result).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    expect(w.docker.running.has("db")).toBe(true);
  });

  it("never applies a stack plan with changes without an approval its caller holds", async () => {
    const w = await world();
    const old = w.old.get("db/password") as string;
    const setup = await portainerStacksFor(w.deps, w.plan, w.services, {
      phase: "provision",
      command: "opscrew rotate db",
      rewrite: (environment) => ({
        ...environment,
        values: {
          ...environment.values,
          app: Object.fromEntries(
            Object.entries(environment.values.app).map(([k, v]) => [k, v.replaceAll(old, "x")]),
          ),
        },
      }),
    });
    const planned = await setup.stacks.plan(setup.outputs);
    expect(planned.changes).toBeGreaterThan(0);
    const mutations = w.portainer.mutations().length;
    const error = await failure(setup.stacks.apply(planned));
    expect(error.code).toBe("INTERNAL");
    expect(w.portainer.mutations()).toHaveLength(mutations);
  });

  it("refuses a stack with changes besides the rotation's, and never asks for a value", async () => {
    const without = (name: string) =>
      PRODUCTION_ENV.split("\n")
        .filter((line) => !line.startsWith(`${name}=`))
        .join("\n");
    for (const [env, said] of [
      // A value edited on this computer, an optional one missing from the env file: changes.
      [
        PRODUCTION_ENV.replace(STRIPE, "sk_edited_on_this_computer"),
        "have changes besides the rotation's",
      ],
      [without("NOTE"), "have changes besides the rotation's"],
      // A required one missing: provision's own stop, as the rotation asks for none.
      [without("GREETING"), "Production values are missing for: GREETING"],
    ] as const) {
      const w = await world();
      w.deps.interactive = true;
      await writeFile(join(w.root, "production.env"), `${env}\n`);
      const mutations = w.portainer.mutations().length;
      const error = await failure(w.rotate(["db"]));
      expect(error.message).toContain(said);
      expect(rotationRequests(w)).toEqual([]);
      expect(w.docker.execs).toEqual([]);
      expect(w.portainer.mutations()).toHaveLength(mutations);
      expect(await exists(pendingRotationFile(w.deps))).toBe(false);
    }
  });

  it("plans the stack again after a failed apply: a new hash, which the old one does not approve", async () => {
    const gate: { only?: string } = {};
    const w = await world((request) => gate.only === undefined || request.planHash === gate.only);
    w.portainerOptions.failures = { "PUT /api/stacks/": "the stack could not be redeployed" };
    const error = await failure(w.rotate(["db"]));
    expect(error.message).toContain("while switching the app to the new values");
    const first = rotationRequests(w)[0]?.planHash as string;
    w.portainerOptions.failures = {};
    // Someone changes the app's stack in Portainer meanwhile.
    const app = w.portainer.stacks.find((stack) => stack.Name === portainerStackName(w.plan));
    const stripe = app?.Env.find((pair) => pair.name === "STRIPE_SECRET_KEY");
    if (stripe !== undefined) stripe.value = "edited in Portainer";

    // A script approving the old hash: the new plan is not approved, and nothing goes on.
    gate.only = first;
    const refused = await failure(w.rotate(["db"]));
    expect(refused.code).toBe("APPROVAL_REFUSED");
    const second = rotationRequests(w)[1]?.planHash as string;
    expect(second).not.toBe(first);
    const kept = JSON.parse(await readFile(pendingRotationFile(w.deps), "utf8"));
    // The file keeps the hash it began with: the deploy pause and it agree.
    expect(kept.hash).toBe(first);
    expect(w.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toContain(first);

    gate.only = second;
    const result = await w.rotate(["db"]);
    expect(result.hash).toBe(second);
    expect(stackValue(w, "STRIPE_SECRET_KEY")).toBe(STRIPE);
  });

  it("applies the stack plan only under the approval bound to its hash", async () => {
    const w = await world();
    const request = w.deps.approvals.request.bind(w.deps.approvals);
    // An approval record that names another hash than the one the rotation bound.
    w.deps.approvals.request = async (input) => {
      const record = await request(input);
      return input.kind === "remote-exec" ? { ...record, planHash: "0".repeat(64) } : record;
    };
    const mutations = w.portainer.mutations().length;
    const error = await failure(w.rotate(["db"]));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("only under the approval bound to its hash");
    expect(w.portainer.mutations()).toHaveLength(mutations);
  });

  it("applies the stack plan only when the approval store records the bound approval", async () => {
    const w = await world();
    const request = w.deps.approvals.request.bind(w.deps.approvals);
    // An approval of the bound hash that the approval store never recorded.
    w.deps.approvals.request = async (input) =>
      input.kind === "remote-exec"
        ? {
            id: "unrecorded",
            kind: input.kind,
            title: input.title,
            planHash: input.planHash as string,
            approved: true,
            approver: "test-user",
            decidedAt: "2026-11-08T10:00:00.000Z",
          }
        : request(input);
    const mutations = w.portainer.mutations().length;
    const error = await failure(w.rotate(["db"]));
    expect(error.code).toBe("PLAN_NOT_APPROVED");
    expect(error.message).toContain("This change has not been approved");
    expect(w.portainer.mutations()).toHaveLength(mutations);
  });

  it("refuses before anything changes: a refused approval, a start command from before 025, other names", async () => {
    const refused = await world((request) => request.kind !== "remote-exec");
    const mutations = refused.portainer.mutations().length;
    const error = await failure(refused.rotate(["db"]));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(refused.docker.execs).toEqual([]);
    expect(refused.portainer.mutations()).toHaveLength(mutations);
    // Kept as planned (a run approved by the hash shown reuses its values); an undo forgets it.
    const planned = JSON.parse(await readFile(pendingRotationFile(refused.deps), "utf8"));
    expect(planned).toMatchObject({ step: "planned", target: "portainer", names: ["db"] });
    expect(await refused.rotate(["db"], { undo: true })).toMatchObject({ undone: true });
    expect(await exists(pendingRotationFile(refused.deps))).toBe(false);
    expect(refused.docker.execs).toEqual([]);

    const stale = await world();
    stale.docker.stale.add("cache");
    const old = await failure(stale.rotate(["db", "cache"]));
    expect(old.message).toContain(
      "cache in your Portainer still runs on a start command from before this version of OpsCrew",
    );
    expect(old.hint).toContain("Run `opscrew provision` first");
    expect(rotationRequests(stale)).toEqual([]);
    expect(stale.docker.execs).toEqual([]);

    // A service that does not run is refused before the approval, not at its first exec.
    stale.docker.stale.clear();
    stale.docker.running.delete("cache");
    const stopped = await failure(stale.rotate(["db", "cache"]));
    expect(stopped.code).toBe("PHASE_PRECONDITION");
    expect(stopped.message).toBe(
      "cache (Valkey) is not running in your Portainer, so OpsCrew can't change its value. Nothing was changed.",
    );
    expect(stopped.hint).toContain("`opscrew provision`");
    expect(rotationRequests(stale)).toEqual([]);
    expect(stale.docker.execs).toEqual([]);
    stale.docker.running.add("cache");

    stale.docker.answer = () => 1;
    await failure(stale.rotate(["db"]));
    const other = await failure(stale.rotate(["cache"]));
    expect(other.message).toContain("The rotation of db in prod is unfinished");
    expect(other.hint).toContain("`opscrew rotate db --undo`");
  });
});
