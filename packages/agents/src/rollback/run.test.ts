import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowRunSource } from "@opscrew/connector-github";
import type { ApprovalRequest } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, serializeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { selfHostedServices } from "../design/sizing";
import { localPlan } from "../localhost/__fixtures__/computer";
import { moveWorld } from "../move/__fixtures__/world";
import {
  blobOf,
  cleanDrift,
  commitOf,
  DEPLOY_RUN_URL,
  inEnvironment,
  WORKFLOWS,
} from "../promote/__fixtures__/world";
import { promotionFile, readPromotion, writePromotion } from "../promote/record";
import {
  createTestPhaseDeps,
  movingPlan,
  portainerPlan,
  ScriptedApprovalHandler,
  ScriptedRunner,
  testPlan,
} from "../testing";
import { at, type Built, versionsWorld } from "./__fixtures__/versions";
import { type RollbackOptions, type RollbackServices, rollback } from "./index";
import {
  imageRollbackHash,
  PENDING_ROLLBACK_FILE,
  readPendingRollback,
  readRollback,
  rollbackFile,
} from "./record";

const PROD_WORKFLOW = ".github/workflows/opscrew-deploy.yml";
const COMMAND = "opscrew rollback --env prod";
/** The test deps' clock. */
const NOW = "2026-10-11T12:00:00.000Z";

/** The kinds `--yes` grants in the CLI: none of them is bound to a hash. */
const YES_KINDS: readonly ApprovalRequest["kind"][] = [
  "repo-write",
  "github-secrets",
  "github-settings",
  "git-push",
  "pull-request",
];

/** The hash of a plan as the rollback binds it: SHA-256 of its canonical JSON. */
const planHash = (plan: unknown) => sha256Hex(canonicalJson(plan));
const short = (built: Built) => `${built.commit.slice(0, 7)}`;
const shortDigest = (built: Built) => built.digest.slice(0, 19);

/** Prod, deployed from main on each push. */
const prodPlan = (): DeployPlan => testPlan({ domain: "shop.example.com", deployed: true });

/** A runner whose git knows the GitHub remote `acme/shop`. */
const gitRemote = () =>
  new ScriptedRunner((_command, args) =>
    args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "not scripted" },
  );

interface WorldOptions {
  /** The environment rolled back (default prod). */
  environment?: string;
  /** Its plan (default: prod deployed from main). */
  plan?: DeployPlan;
  approve?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
  env?: Record<string, string>;
}

/**
 * An app whose prod deploys each push to main, deployed three times (a, b, c at minutes 1–3):
 * GHCR labels c `opscrew-prod` and b `opscrew-prod-previous`. The deploy workflow is in the working
 * tree and merged on main. `events` records, in order, each write of the pause variable, each
 * sleep and each dispatch.
 */
async function rollbackWorld(o: WorldOptions = {}) {
  const base = await versionsWorld();
  const handler = new ScriptedApprovalHandler(o.approve ?? (() => true));
  const deps = await createTestPhaseDeps({
    root: base.deps.paths.root,
    env: { ...base.deps.env, ...o.env },
    runner: gitRemote(),
    approvalHandler: handler,
    ...(o.environment !== undefined ? { environment: o.environment } : {}),
  });
  const events: string[] = [];
  const hooks: { onPause?: () => void } = {};
  const github = Object.assign(base.github, {
    async setRepoVariable(_owner: string, _repo: string, name: string, value: string) {
      events.push("pause");
      base.github.variables.set(name, value);
      hooks.onPause?.();
    },
    async deleteRepoVariable(_owner: string, _repo: string, name: string) {
      events.push("pause");
      base.github.variables.delete(name);
    },
  });
  const dispatch = github.dispatchWorkflow.bind(github);
  github.dispatchWorkflow = (...args: Parameters<typeof dispatch>) => {
    events.push("dispatch");
    return dispatch(...args);
  };
  const writeRepoFile = async (path: string, text: string) => {
    const file = join(deps.paths.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await writeRepoFile(PROD_WORKFLOW, WORKFLOWS[PROD_WORKFLOW] as string);
  const plan = o.plan ?? prodPlan();
  await base.writePlan(o.environment ?? "prod", plan);
  const drift = { report: cleanDrift() };
  const services: RollbackServices = {
    github,
    drift: async () => drift.report,
    sleep: async () => {
      events.push("sleep");
    },
    now: (() => {
      let clock = 0;
      return () => (clock += 10_000);
    })(),
  };
  const run = (options: Omit<RollbackOptions, "services"> = {}) =>
    rollback(deps, { ...options, services });
  return {
    ...base,
    deps,
    github,
    handler,
    services,
    drift,
    events,
    hooks,
    plan,
    run,
    writeRepoFile,
  };
}

type World = Awaited<ReturnType<typeof rollbackWorld>>;

/** Prod's three deploys, c running and b before it. */
async function prodWorld(o: WorldOptions = {}) {
  const world = await rollbackWorld(o);
  const a = world.deploy("a", 1);
  const b = world.deploy("b", 2);
  const c = world.deploy("c", 3);
  world.label("prod", c);
  world.label("prod", b, true);
  return { world, a, b, c };
}

/** The rollback's hash of `environment` (default prod) from `current` to `target`, with its plan. */
const hashOf = (world: World, current: Built, target: Built, environment = "shop/prod") =>
  imageRollbackHash({
    environment,
    current: current.digest,
    target: target.digest,
    targetPlanHash: planHash(world.plan),
  });

/** The pause variable as JSON, `undefined` when GitHub has none. */
function paused(world: World): Record<string, unknown> | undefined {
  const text = world.github.variables.get(DEPLOY_PAUSED_VARIABLE);
  return text === undefined ? undefined : JSON.parse(text);
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/**
 * Nothing was changed, in a rollback's words (never promote's): no approval asked, no pause
 * written, no dispatch, nothing recorded.
 */
async function nothingChanged(world: World, error: OpsCrewError) {
  expect(error.message).toMatch(/Nothing was changed\.$/);
  expect(`${error.message} ${error.hint}`).not.toMatch(/promotes|promotion|Promote forward/);
  expect(world.handler.requests).toEqual([]);
  expect(world.events).toEqual([]);
  expect(world.github.dispatches).toEqual([]);
  expect(await readRollback(world.deps.paths)).toBeUndefined();
}

/** A run of prod's deploy workflow GitHub shows queued or in progress. */
function runningRun(commit: string): WorkflowRunSource {
  return {
    repository: "acme/shop",
    headRepository: "acme/shop",
    event: "push",
    headBranch: "main",
    headSha: commit,
    path: PROD_WORKFLOW,
    createdAt: at(9),
    status: "in_progress",
    conclusion: null,
  };
}

/** Everything a run showed, wrote or recorded: none may hold a secret. */
async function everythingShown(world: World): Promise<string> {
  const files = await Promise.all(
    [rollbackFile(world.deps.paths), join(world.deps.paths.stateDir, PENDING_ROLLBACK_FILE)].map(
      (file) => readFile(file, "utf8").catch(() => ""),
    ),
  );
  return [
    world.deps.reporter.text(),
    JSON.stringify(world.deps.audit.entries),
    JSON.stringify(world.handler.requests),
    JSON.stringify([...world.github.variables]),
    JSON.stringify(world.github.dispatches),
    ...files,
  ].join("\n");
}

describe("opscrew rollback on a server", () => {
  it("rolls prod back to the deployment before, by its digest, after a hash-bound approval", async () => {
    const { world, b, c } = await prodWorld();

    const result = await world.run();

    const hash = hashOf(world, c, b);
    expect(result).toMatchObject({
      kind: "rolled-back",
      status: "deployed",
      target: { digest: b.digest, commit: b.commit, message: "b", builtAt: at(2) },
      from: { digest: c.digest, commit: c.commit },
      runUrl: DEPLOY_RUN_URL,
      paused: true,
      how: "image",
    });
    // One `promote` approval, bound to the hash of the environment, both digests and the plan.
    expect(world.handler.requests).toHaveLength(1);
    const request = world.handler.requests[0] as ApprovalRequest;
    expect(request).toMatchObject({ kind: "promote", planHash: hash });
    expect(request.title).toBe(`Roll prod back to ${short(b)} (${shortDigest(b)})`);
    const details = request.details;
    expect(details).toContain(`Now: ${short(c)} "c", built ${at(3)} (${shortDigest(c)})`);
    expect(details).toContain(`Back to: ${short(b)} "b", built ${at(2)} (${shortDigest(b)})`);
    expect(details).toContain(`ghcr.io/acme/shop@${b.digest}`);
    expect(details).toContain(
      "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.",
    );
    expect(details).toContain(
      `Deploy: opscrew-deploy.yml on main, given the digest; nothing is rebuilt. Afterwards prod's deploys pause until \`${COMMAND} --resume\`.`,
    );
    expect(details).toContain(planHash(world.plan));
    expect(details).toContain(`Rollback hash: ${hash}`);
    // The order: the pause, the wait for deploys created just before it, then the dispatch.
    expect(world.events).toEqual(["pause", "sleep", "dispatch"]);
    // The dispatch: prod's workflow on its branch with the digest, the commit tag and `rollback`.
    expect(world.github.dispatches).toEqual([
      {
        workflowFile: "opscrew-deploy.yml",
        ref: "main",
        inputs: { digest: b.digest, tag: b.commit, rollback: "true" },
      },
    ]);
    // Prod's deploys stay paused, pinned to b.
    expect(paused(world)).toEqual({
      "shop/prod": {
        reason: "rollback",
        since: NOW,
        image: b.digest,
        commit: b.commit,
        from: c.commit,
      },
    });
    // The rollback is recorded on this computer; prod is not promoted, so no promotion.json.
    expect(await readRollback(world.deps.paths)).toEqual({
      digest: b.digest,
      commit: b.commit,
      from: { digest: c.digest, commit: c.commit },
      runUrl: DEPLOY_RUN_URL,
      at: NOW,
      hash,
    });
    expect(await readPromotion(world.deps.paths)).toBeUndefined();
    // The output says the deploys are paused, and how to resume them.
    const text = world.deps.reporter.text();
    expect(text).toContain(`prod runs ${short(b)} "b" again`);
    expect(text).toContain("prod's deploys are paused: a push to main builds but doesn't deploy.");
    expect(text).toContain(`\`${COMMAND} --resume\``);
    expect(text).toContain("add --deploy to deploy main's latest commit now");
    // Audited: the approval, the pause, the dispatch and the run's outcome.
    const actions = world.deps.audit.entries.map((entry) => `${entry.kind}:${entry.action}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "approval:promote",
        "provider-call:pause the deploys of shop/prod",
        "provider-call:dispatch workflow",
        "provider-call:deploy workflow",
      ]),
    );
  });

  it("goes to the version --to names, by a commit's or a digest's prefix", async () => {
    const { world, a, c } = await prodWorld();
    const result = await world.run({ to: a.commit.slice(0, 7) });
    expect(result).toMatchObject({ kind: "rolled-back", target: { digest: a.digest } });
    expect(world.github.dispatches[0]?.inputs).toEqual({
      digest: a.digest,
      tag: a.commit,
      rollback: "true",
    });
    expect(world.handler.requests[0]?.planHash).toBe(hashOf(world, c, a));

    const again = await prodWorld();
    await again.world.run({ to: again.a.digest.slice(0, 19) });
    expect(again.world.github.dispatches[0]?.inputs.digest).toBe(again.a.digest);
  });

  it("waits for a deploy created just before the pause, then dispatches", async () => {
    const { world, b } = await prodWorld();
    const late = commitOf("late");
    world.hooks.onPause = () => world.github.runs.set(900, runningRun(late));
    let sleeps = 0;
    world.services.sleep = async () => {
      world.events.push("sleep");
      sleeps++;
      if (sleeps === 2) world.github.runs.set(900, { ...runningRun(late), status: "completed" });
    };
    await world.run();
    expect(world.events).toEqual(["pause", "sleep", "sleep", "dispatch"]);
    expect(world.github.dispatches[0]?.inputs.digest).toBe(b.digest);
  });

  it("puts the pause back and says so when that deploy still runs after 30 minutes", async () => {
    const { world } = await prodWorld();
    world.hooks.onPause = () => world.github.runs.set(900, runningRun(commitOf("slow")));
    const error = await failure(world.run());
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "A deploy of shop (opscrew-deploy.yml) still runs after 30 minutes, so the rollback did not start, and OpsCrew put prod's deploy pause back as it was. Nothing was changed.",
    );
    expect(error.hint).toBe(
      `Let it end (https://github.com/acme/shop/actions), then run \`${COMMAND}\` again.`,
    );
    expect(paused(world)).toBeUndefined();
    expect(world.github.dispatches).toEqual([]);
  });

  it("says no secret: commit messages are redacted, and the GHCR token never shows", async () => {
    const token = fakeSecret("github-token", "ghcr-read");
    const secret = fakeSecret("github-token", "in-a-commit-message");
    const world = await rollbackWorld({ env: { OPSCREW_GHCR_READ_TOKEN: token } });
    world.deploy("a", 1);
    const b = world.deploy("b", 2, {
      run: { headCommit: { message: `fix: rotate ${secret}\n\nbody`, timestamp: at(2) } },
    });
    const c = world.deploy("c", 3);
    world.label("prod", c);
    world.label("prod", b, true);
    await world.run();
    expect(world.handler.requests[0]?.details).toContain(`Back to: ${short(b)} "fix: rotate `);
    const shown = await everythingShown(world);
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain(token);
  });

  describe("refuses before any change", () => {
    it("when the environment is not provisioned", async () => {
      const { deployment: _deployment, ...plan } = prodPlan();
      const { world } = await prodWorld({ plan: DeployPlanSchema.parse(plan) });
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("The prod environment is not provisioned");
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain("opscrew provision");
      await nothingChanged(world, error);
    });

    it("when a provision is pending", async () => {
      const { world } = await prodWorld();
      world.drift.report = cleanDrift({
        clean: false,
        pending: [
          {
            address: "module.server.hcloud_server.app",
            type: "hcloud_server",
            name: "app",
            provider: "registry.opentofu.org/hetznercloud/hcloud",
            action: "update",
          },
        ],
      });
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(
        "module.server.hcloud_server.app (update). OpsCrew rolls back only an environment whose plan is applied, so the approval names what will run. Nothing was changed.",
      );
      expect(error.hint).toBe(
        `Run \`opscrew provision --env prod\` first, then \`${COMMAND}\` again.`,
      );
      await nothingChanged(world, error);
    });

    it("when the workflow on the branch is not the one the plan generates (one from before 019)", async () => {
      const { world } = await prodWorld();
      world.github.onMain.set(PROD_WORKFLOW, blobOf("name: OpsCrew deploy\n# before 019\n"));
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        `The deploy workflow on the default branch main (${PROD_WORKFLOW}) is not the one prod's plan generates, so its run would not do what this rollback shows. Nothing was changed.`,
      );
      expect(error.hint).toContain("opscrew provision --env prod");
      await nothingChanged(world, error);
    });

    it("while a deploy of the environment runs, naming its run", async () => {
      const { world } = await prodWorld();
      world.github.runs.set(900, runningRun(commitOf("d")));
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("https://github.com/acme/shop/actions/runs/900");
      expect(error.message).toMatch(/Nothing was changed\.$/);
      await nothingChanged(world, error);
    });

    it("while a service moves between the app's servers (plan.move)", async () => {
      const moving = await moveWorld();
      const handler = moving.deps.approvalHandler as ScriptedApprovalHandler;
      const error = await failure(rollback(moving.deps, { services: { github: null } }));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("moves between the app's servers");
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain("opscrew provision");
      expect(handler.requests).toEqual([]);
    });

    it("while a move's window pauses the deploys (the variable)", async () => {
      const { world } = await prodWorld();
      const entry = { reason: "move", since: "2026-10-11T11:30:00.000Z" };
      world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/prod": entry }));
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("move");
      expect(error.hint).toContain("opscrew provision");
      await nothingChanged(world, error);
      expect(paused(world)).toEqual({ "shop/prod": entry });
    });

    it("when a move's window started after the check: its entry goes back, and nothing deploys", async () => {
      const entry = { reason: "move", since: "2026-10-11T11:59:00.000Z" };
      let world: World | undefined;
      const started = await prodWorld({
        approve: () => {
          // A move's window starts while the user reads the approval.
          world?.github.variables.set(
            DEPLOY_PAUSED_VARIABLE,
            JSON.stringify({ "shop/prod": entry }),
          );
          return true;
        },
      });
      world = started.world;
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(`paused since ${entry.since} while a service moves`);
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain("opscrew provision --env prod");
      // The rollback's entry was written over the move's, then the move's put back.
      expect(world.events).toEqual(["pause", "pause"]);
      expect(paused(world)).toEqual({ "shop/prod": entry });
      expect(world.github.dispatches).toEqual([]);
      expect(await readRollback(world.deps.paths)).toBeUndefined();
    });

    it("while the app moves to another provider (retarget)", async () => {
      const { world } = await prodWorld({ plan: movingPlan() });
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("A move to DigitalOcean is in progress");
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain("opscrew retarget");
      await nothingChanged(world, error);
    });

    it("when only one version ever ran", async () => {
      const world = await rollbackWorld();
      const only = world.deploy("only", 1);
      world.label("prod", only);
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("it has run only one version");
      await nothingChanged(world, error);
    });

    it("when a service the earlier version ran with is gone from the plan", async () => {
      const { world, b } = await prodWorld();
      const old = { ...world.plan, services: selfHostedServices({ postgres: true, redis: true }) };
      world.github.files.set(`${b.commit}:opscrew/plan.yaml`, serializeArtifact("plan", old));
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("ran with the service cache");
      await nothingChanged(world, error);
    });

    it("--allow-old-secrets anywhere but Cloudflare's hosting", async () => {
      const { world } = await prodWorld();
      const error = await failure(world.run({ allowOldSecrets: ["API_KEY"] }));
      expect(error.code).toBe("INVALID_INPUT");
      await nothingChanged(world, error);
    });
  });

  it("lists in the approval what was added since the earlier version", async () => {
    const { world, b } = await prodWorld();
    const { STRIPE_SECRET_KEY: _gone, ...rest } = Object.fromEntries(
      world.plan.app.env.map((variable) => [variable.name, variable]),
    );
    const old = DeployPlanSchema.parse({
      ...world.plan,
      app: { ...world.plan.app, env: Object.values(rest) },
    });
    world.github.files.set(`${b.commit}:opscrew/plan.yaml`, serializeArtifact("plan", old));
    await world.run();
    expect(world.handler.requests[0]?.details).toContain(
      `Variables added since ${short(b)}, which the earlier image gets too: STRIPE_SECRET_KEY.`,
    );
  });

  it("says in the approval when it could not read the plan of the earlier version", async () => {
    const { world, b } = await prodWorld();
    await world.run();
    expect(world.handler.requests[0]?.details).toContain(
      `OpsCrew could not read prod's plan at ${short(b)}`,
    );
  });

  describe("the approval", () => {
    it("is never granted by --yes, and says the command that applies it", async () => {
      const { world, b, c } = await prodWorld({
        approve: (request) => YES_KINDS.includes(request.kind),
      });
      const error = await failure(world.run());
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("Nothing was changed.");
      expect(error.hint).toContain(`${COMMAND} --to ${b.digest} --approve ${hashOf(world, c, b)}`);
      expect(world.handler.requests.map((request) => request.kind)).toEqual(["promote"]);
      expect(world.events).toEqual([]);
      expect(paused(world)).toBeUndefined();
    });

    it("refuses an --approve hash of another rollback: PLAN_NOT_APPROVED", async () => {
      const { world, a, b, c } = await prodWorld();
      const reviewed = hashOf(world, c, a);
      const error = await failure(world.run({ approveHash: reviewed }));
      expect(error.code).toBe("PLAN_NOT_APPROVED");
      expect(error.message).toContain(reviewed);
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain(`--approve ${hashOf(world, c, b)}`);
      expect(world.handler.requests).toEqual([]);
      expect(world.events).toEqual([]);
    });

    it("goes ahead with --approve naming this rollback's hash", async () => {
      const { world, b, c } = await prodWorld();
      const hash = hashOf(world, c, b);
      await world.run({ approveHash: hash.toUpperCase() });
      expect(world.handler.requests[0]?.planHash).toBe(hash);
      expect(world.github.dispatches).toHaveLength(1);
    });
  });

  describe("when the run does not succeed", () => {
    it.each(["failure", "cancelled"])(
      "puts the pause back as it was when the run ends with %s",
      async (conclusion) => {
        const { world, c } = await prodWorld();
        world.github.conclusion = conclusion;
        const error = await failure(world.run());
        expect(error.code).toBe("COMMAND_FAILED");
        expect(error.message).toContain(DEPLOY_RUN_URL);
        expect(error.message).toContain(
          `the automatic switch back returns prod to the version it ran, ${short(c)}`,
        );
        expect(error.hint).toContain("opscrew logs --failed --env prod");
        // No pause before: the variable is gone again.
        expect(paused(world)).toBeUndefined();
        expect(world.events).toEqual(["pause", "sleep", "dispatch", "pause"]);
        expect(await readRollback(world.deps.paths)).toBeUndefined();
      },
    );

    it("puts the pause back when GitHub refused the dispatch", async () => {
      const { world } = await prodWorld();
      world.github.dispatchError = new OpsCrewError(
        "PHASE_PRECONDITION",
        "GitHub cannot start the workflow opscrew-deploy.yml on main: Not Found.",
      );
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("Nothing was deployed.");
      expect(paused(world)).toBeUndefined();
    });

    it("keeps the pause, and says so, when the run may have started", async () => {
      const { world, b } = await prodWorld();
      world.github.afterAcceptedError = new OpsCrewError(
        "PROVIDER_ERROR",
        "GitHub started opscrew-deploy.yml on main but did not say which run it is.",
      );
      const error = await failure(world.run());
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("The run may have started");
      expect(error.message).toContain(
        `prod's deploys stay paused, pinned to ${short(b)} "b": \`${COMMAND} --resume\` ends the pause.`,
      );
      expect(paused(world)).toMatchObject({ "shop/prod": { image: b.digest } });
      expect(await readRollback(world.deps.paths)).toBeUndefined();
    });

    it("puts back the pause entry it replaced, never removing another environment's", async () => {
      const { world, c } = await prodWorld();
      const staging = {
        reason: "rollback",
        since: "2026-10-10T09:00:00.000Z",
        image: c.digest,
        commit: c.commit,
      };
      const before = {
        reason: "rollback",
        since: "2026-10-10T10:00:00.000Z",
        image: c.digest,
        commit: c.commit,
      };
      world.github.variables.set(
        DEPLOY_PAUSED_VARIABLE,
        JSON.stringify({ "shop/staging": staging, "shop/prod": before }),
      );
      world.github.conclusion = "failure";
      await failure(world.run());
      expect(paused(world)).toEqual({ "shop/staging": staging, "shop/prod": before });
    });
  });

  describe("a run held for a required reviewer", () => {
    it("is recorded as pending, with the pause entry it replaced", async () => {
      const { world, b, c } = await prodWorld();
      world.github.reviewer = "pending";
      const result = await world.run();
      expect(result).toMatchObject({
        kind: "rolled-back",
        status: "waiting",
        target: { digest: b.digest },
        runUrl: DEPLOY_RUN_URL,
        paused: true,
      });
      expect(await readPendingRollback(world.deps.paths)).toEqual({
        digest: b.digest,
        commit: b.commit,
        from: { digest: c.digest, commit: c.commit },
        runId: 777,
        at: NOW,
        hash: hashOf(world, c, b),
        pauseBefore: null,
      });
      expect(paused(world)).toMatchObject({ "shop/prod": { image: b.digest } });
      expect(await readRollback(world.deps.paths)).toBeUndefined();
      expect(world.deps.reporter.text()).toContain("waits in GitHub for a required reviewer");
    });

    it("is recorded by the next run once it succeeded, with no new dispatch", async () => {
      const { world, b } = await prodWorld();
      world.github.reviewer = "pending";
      await world.run();
      world.github.reviewer = "none";
      const result = await world.run();
      expect(result).toMatchObject({
        kind: "rolled-back",
        status: "deployed",
        target: { digest: b.digest },
      });
      expect(world.github.dispatches).toHaveLength(1);
      expect(world.handler.requests).toHaveLength(1);
      expect(await readRollback(world.deps.paths)).toMatchObject({
        digest: b.digest,
        runUrl: DEPLOY_RUN_URL,
      });
      expect(await readPendingRollback(world.deps.paths)).toBeUndefined();
      expect(paused(world)).toMatchObject({ "shop/prod": { image: b.digest } });
    });

    it("is kept when its pause can't be put back after it failed", async () => {
      const { world } = await prodWorld();
      world.github.reviewer = "pending";
      await world.run();
      world.github.reviewer = "none";
      world.github.reread = { status: "completed", conclusion: "failure" };
      world.github.deleteRepoVariable = async () => {
        throw new OpsCrewError("PROVIDER_ERROR", "GitHub answered 502.");
      };
      const error = await failure(world.run());
      expect(error.code).toBe("PROVIDER_ERROR");
      // The next run finds it again, and puts the pause back then.
      expect(await readPendingRollback(world.deps.paths)).toMatchObject({ pauseBefore: null });
      expect(world.github.dispatches).toHaveLength(1);
    });

    it("is reported again while it still waits", async () => {
      const { world } = await prodWorld();
      world.github.reviewer = "pending";
      await world.run();
      const result = await world.run();
      expect(result).toMatchObject({ kind: "rolled-back", status: "waiting" });
      expect(world.github.dispatches).toHaveLength(1);
      expect(await readPendingRollback(world.deps.paths)).toBeDefined();
    });

    it("puts the pause back once it failed, and the next run goes on with a new rollback", async () => {
      const { world, b } = await prodWorld();
      world.github.reviewer = "pending";
      await world.run();
      world.github.reviewer = "none";
      world.github.reread = { status: "completed", conclusion: "failure" };
      const result = await world.run();
      expect(result).toMatchObject({
        kind: "rolled-back",
        status: "deployed",
        target: { digest: b.digest },
      });
      // The pending run's pause was removed, then the new rollback's set.
      const writes = world.deps.audit.entries
        .map((entry) => entry.action)
        .filter((action) => action.endsWith("the deploys of shop/prod"));
      expect(writes).toEqual([
        "pause the deploys of shop/prod",
        "resume the deploys of shop/prod",
        "pause the deploys of shop/prod",
      ]);
      expect(world.github.dispatches).toHaveLength(2);
      expect(await readPendingRollback(world.deps.paths)).toBeUndefined();
    });
  });

  it("rolls back a rollback to the version before, replacing its pause entry", async () => {
    const { world, a, b, c } = await prodWorld();
    await world.run();
    // The run's label job: b runs now, c ran before it.
    world.label("prod", b);
    world.label("prod", c, true);
    const first = await readRollback(world.deps.paths);

    const result = await world.run();

    expect(result).toMatchObject({ target: { digest: a.digest }, from: { digest: b.digest } });
    expect(world.github.dispatches[1]?.inputs.digest).toBe(a.digest);
    expect(paused(world)).toEqual({
      "shop/prod": {
        reason: "rollback",
        since: NOW,
        image: a.digest,
        commit: a.commit,
        from: b.commit,
      },
    });
    expect(await readRollback(world.deps.paths)).toMatchObject({
      digest: a.digest,
      previous: first,
    });
  });

  it("changes only the rolled-back environment's key in the variable", async () => {
    const { world, b } = await prodWorld();
    const staging = { reason: "move", since: "2026-10-10T09:00:00.000Z" };
    world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/staging": staging }));
    await world.run();
    expect(paused(world)).toEqual({
      "shop/staging": staging,
      "shop/prod": expect.objectContaining({ reason: "rollback", image: b.digest }),
    });
  });

  it("rolls back an environment that follows another branch, on that branch", async () => {
    const staging = inEnvironment(prodPlan(), "staging");
    const plan = DeployPlanSchema.parse({
      ...staging,
      cicd: { ...staging.cicd, branch: "develop" },
    });
    const world = await rollbackWorld({ environment: "staging", plan });
    const workflow = "name: OpsCrew deploy (staging)\n";
    const path = ".github/workflows/opscrew-deploy-staging.yml";
    await world.writeRepoFile(path, workflow);
    world.github.fileSha = async (_owner, _repo, file, ref) =>
      file === path && ref === "develop" ? blobOf(workflow) : undefined;
    const develop = { environment: "staging", run: { headBranch: "develop" } };
    world.deploy("a", 1, develop);
    const b = world.deploy("b", 2, develop);
    const c = world.deploy("c", 3, develop);
    world.label("staging", c);
    world.label("staging", b, true);

    await world.run();

    expect(world.github.dispatches).toEqual([
      {
        workflowFile: "opscrew-deploy-staging.yml",
        ref: "develop",
        inputs: { digest: b.digest, tag: `${b.commit}-staging`, rollback: "true" },
      },
    ]);
    expect(world.handler.requests[0]?.planHash).toBe(hashOf(world, c, b, "shop/staging"));
    expect(paused(world)).toEqual({
      "shop/staging": expect.objectContaining({ reason: "rollback", image: b.digest }),
    });
    expect(world.deps.reporter.text()).toContain(
      "staging's deploys are paused: a push to develop builds but doesn't deploy.",
    );
  });

  it("rolls back on the user's Portainer through the same dispatch", async () => {
    const plan = portainerPlan({ deployed: true });
    const { world, b } = await prodWorld({ plan });
    const result = await world.run();
    expect(result).toMatchObject({ kind: "rolled-back", status: "deployed", how: "image" });
    expect(world.github.dispatches).toEqual([
      {
        workflowFile: "opscrew-deploy.yml",
        ref: "main",
        inputs: { digest: b.digest, tag: b.commit, rollback: "true" },
      },
    ]);
  });

  describe("a promoted environment", () => {
    /** Prod promoted from staging (deployed from main), with staging's builds a, b, c. */
    async function promotedWorld() {
      const plan = DeployPlanSchema.parse({
        ...prodPlan(),
        environment: { deploySource: { from: "promote", source: "staging" } },
      });
      const world = await rollbackWorld({ plan });
      await world.writePlan("staging", inEnvironment(prodPlan(), "staging"));
      const a = world.deploy("a", 1, { environment: "staging" });
      const b = world.deploy("b", 2, { environment: "staging" });
      const c = world.deploy("c", 3, { environment: "staging" });
      world.label("prod", c);
      world.label("prod", b, true);
      return { world, a, b, c };
    }

    it("rolls back through its dispatch on the default branch, and records the promotion", async () => {
      const { world, b, c } = await promotedWorld();
      const result = await world.run();
      expect(result).toMatchObject({
        kind: "rolled-back",
        status: "deployed",
        target: { digest: b.digest },
      });
      expect(world.github.dispatches).toEqual([
        {
          workflowFile: "opscrew-deploy.yml",
          ref: "main",
          inputs: { digest: b.digest, tag: `${b.commit}-staging`, rollback: "true" },
        },
      ]);
      expect(world.handler.requests[0]?.planHash).toBe(hashOf(world, c, b));
      expect(await readPromotion(world.deps.paths)).toEqual({
        digest: b.digest,
        source: "staging",
        runUrl: DEPLOY_RUN_URL,
        at: NOW,
        services: ["db"],
      });
      expect(await readRollback(world.deps.paths)).toMatchObject({ digest: b.digest });
      expect(world.deps.reporter.text()).toContain("opscrew promote --to prod");
    });

    it("refuses when the image ran with a service its plan no longer has", async () => {
      const { world, b, c } = await promotedWorld();
      const run = { source: "staging", runUrl: DEPLOY_RUN_URL, at: NOW };
      await writePromotion(world.deps.paths, {
        ...run,
        digest: b.digest,
        services: ["db", "search"],
      });
      await writePromotion(world.deps.paths, { ...run, digest: c.digest, services: ["db"] });
      const error = await failure(world.run());
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        `prod's image ${shortDigest(b)} ran with the service search, which prod's plan no longer has, so rolling back would run that image without it. Nothing was changed.`,
      );
      expect(error.hint).toBe(
        `Roll back to a version that ran without it (\`${COMMAND} --list\` shows the versions), or deploy a fix: once staging runs it, \`opscrew promote --to prod\` deploys it.`,
      );
      await nothingChanged(world, error);
      expect(JSON.parse(await readFile(promotionFile(world.deps.paths), "utf8")).digest).toBe(
        c.digest,
      );
    });

    it("says in the approval when this computer has no record of what the image ran with", async () => {
      const { world } = await promotedWorld();
      await world.run();
      expect(world.handler.requests[0]?.details).toContain(
        "OpsCrew has no record on this computer",
      );
    });
  });

  describe("--list", () => {
    it("lists the versions and the pause, with no approval and no write", async () => {
      const { world, a, b, c } = await prodWorld();
      const entry = { reason: "move", since: "2026-10-10T09:00:00.000Z" };
      world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/prod": entry }));
      const result = await world.run({ list: true });
      expect(result).toMatchObject({ kind: "list", paused: entry, leftOut: 0 });
      if (result.kind !== "list") throw new Error("not a list");
      expect(result.versions.map((version) => version.digest)).toEqual([
        c.digest,
        b.digest,
        a.digest,
      ]);
      expect(result.versions.map((version) => version.marks)).toEqual([
        ["running"],
        ["previous"],
        [],
      ]);
      expect(world.handler.requests).toEqual([]);
      expect(world.events).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("counts the images it left out", async () => {
      const { world } = await prodWorld();
      world.deploy("arm", 4, { platforms: [{ architecture: "arm64", os: "linux" }] });
      const result = await world.run({ list: true });
      expect(result).toMatchObject({ kind: "list", leftOut: 1 });
      expect(result).not.toHaveProperty("paused");
    });
  });
});

describe("opscrew rollback --resume", () => {
  /** Prod paused by a rollback to b, from c. */
  async function pausedWorld(o: WorldOptions = {}) {
    const { world, b, c } = await prodWorld(o);
    const entry = {
      reason: "rollback",
      since: NOW,
      image: b.digest,
      commit: b.commit,
      from: c.commit,
    };
    world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/prod": entry }));
    return { world, b, c, entry };
  }

  it("refuses while a rollback run waits for a reviewer, until the next rollback records it", async () => {
    const { world, b } = await prodWorld();
    world.github.reviewer = "pending";
    await world.run();
    const before = world.github.variables.get(DEPLOY_PAUSED_VARIABLE);
    const requests = world.handler.requests.length;
    world.events.length = 0;

    const error = await failure(world.run({ resume: true, deploy: true }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "A rollback of prod was left waiting for a required reviewer in GitHub: https://github.com/acme/shop/actions/runs/777. OpsCrew resumes the deploys only once that rollback is recorded. Nothing was changed.",
    );
    expect(error.hint).toBe(
      `Approve or reject that run in GitHub, then run \`${COMMAND}\` again to record it; after that, \`${COMMAND} --resume --deploy\` resumes the deploys.`,
    );
    expect(world.handler.requests).toHaveLength(requests);
    expect(world.events).toEqual([]);
    expect(world.github.variables.get(DEPLOY_PAUSED_VARIABLE)).toBe(before);

    // Once the next rollback recorded it, --resume goes ahead.
    world.github.reviewer = "none";
    await world.run();
    expect(await readRollback(world.deps.paths)).toMatchObject({ digest: b.digest });
    expect(await world.run({ resume: true })).toEqual({ kind: "resumed", wasPaused: true });
  });

  it("says so when the deploys are not paused, and changes nothing", async () => {
    const { world } = await prodWorld();
    const result = await world.run({ resume: true });
    expect(result).toEqual({ kind: "resumed", wasPaused: false });
    expect(world.deps.reporter.text()).toContain("prod's deploys are not paused");
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("removes the rollback's entry after a github-settings approval, which --yes grants", async () => {
    const { world } = await pausedWorld({ approve: (request) => YES_KINDS.includes(request.kind) });
    const staging = { reason: "move", since: "2026-10-10T09:00:00.000Z" };
    const both = JSON.parse(world.github.variables.get(DEPLOY_PAUSED_VARIABLE) as string);
    world.github.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({ ...both, "shop/staging": staging }),
    );
    const result = await world.run({ resume: true });
    expect(result).toEqual({ kind: "resumed", wasPaused: true });
    expect(world.handler.requests).toHaveLength(1);
    expect(world.handler.requests[0]).toMatchObject({
      kind: "github-settings",
      title: "Resume the deploys of shop/prod",
    });
    expect(paused(world)).toEqual({ "shop/staging": staging });
    expect(world.deps.audit.entries.map((entry) => entry.action)).toContain(
      "resume the deploys of shop/prod",
    );
    expect(world.github.dispatches).toEqual([]);
    expect(world.deps.reporter.text()).toContain("each push to main deploys it again");
  });

  it("changes nothing when the approval is refused", async () => {
    const { world, entry } = await pausedWorld({ approve: () => false });
    const error = await failure(world.run({ resume: true }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("Nothing was changed.");
    expect(paused(world)).toEqual({ "shop/prod": entry });
  });

  it("refuses to end a move's window", async () => {
    const { world } = await prodWorld();
    const entry = { reason: "move", since: "2026-10-10T09:00:00.000Z" };
    world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/prod": entry }));
    const error = await failure(world.run({ resume: true }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew provision");
    expect(world.handler.requests).toEqual([]);
    expect(paused(world)).toEqual({ "shop/prod": entry });
  });

  it("with --deploy also starts the workflow on the branch with no inputs, and follows it", async () => {
    const plan = prodPlan();
    const { world } = await pausedWorld({
      plan: DeployPlanSchema.parse({
        ...plan,
        app: { ...plan.app, releaseCommand: "npm run migrate" },
      }),
    });
    const fix = world.deploy("fix", 5);
    const result = await world.run({ resume: true, deploy: true });
    expect(world.handler.requests[0]?.details).toContain(
      `It also starts opscrew-deploy.yml on main now: it builds ${fix.commit.slice(0, 7)} "fix" and deploys it, with its release command.`,
    );
    expect(world.events).toEqual(["pause", "dispatch"]);
    expect(world.github.dispatches).toEqual([
      { workflowFile: "opscrew-deploy.yml", ref: "main", inputs: {} },
    ]);
    expect(paused(world)).toBeUndefined();
    expect(result).toEqual({
      kind: "resumed",
      wasPaused: true,
      deployed: {
        status: "deployed",
        runUrl: DEPLOY_RUN_URL,
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
  });

  it("with --deploy deploys the branch even when the deploys are on", async () => {
    const { world } = await prodWorld();
    const result = await world.run({ resume: true, deploy: true });
    expect(result).toMatchObject({
      kind: "resumed",
      wasPaused: false,
      deployed: { runUrl: DEPLOY_RUN_URL },
    });
    expect(world.handler.requests[0]?.kind).toBe("github-settings");
    expect(world.events).toEqual(["dispatch"]);
  });

  it("with --deploy says when its run waits for a required reviewer", async () => {
    const { world } = await prodWorld();
    world.github.reviewer = "pending";
    const result = await world.run({ resume: true, deploy: true });
    expect(result).toMatchObject({
      kind: "resumed",
      deployed: { status: "waiting", runUrl: DEPLOY_RUN_URL },
    });
  });

  it("refuses --deploy on this computer without the local runner; --resume alone clears the entry", async () => {
    const world = await rollbackWorld({ plan: localPlan() });
    const a = world.deploy("a", 1);
    const entry = { reason: "rollback", since: NOW, image: a.digest, commit: a.commit };
    world.github.variables.set(DEPLOY_PAUSED_VARIABLE, JSON.stringify({ "shop/prod": entry }));

    const error = await failure(world.run({ resume: true, deploy: true }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain("`opscrew provision --env prod`");
    expect(world.handler.requests).toEqual([]);
    expect(paused(world)).toEqual({ "shop/prod": entry });

    expect(await world.run({ resume: true })).toEqual({ kind: "resumed", wasPaused: true });
    expect(paused(world)).toBeUndefined();
    expect(world.github.dispatches).toEqual([]);
  });

  it("refuses --deploy for a promoted environment, naming opscrew promote", async () => {
    const plan = DeployPlanSchema.parse({
      ...prodPlan(),
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    const { world } = await pausedWorld({ plan });
    const error = await failure(world.run({ resume: true, deploy: true }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toContain("opscrew promote --to prod");
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });
});
