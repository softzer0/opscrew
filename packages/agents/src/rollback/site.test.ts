import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FAKE_ACCOUNT_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { blobOf, cleanDrift, commitOf } from "../promote/__fixtures__/world";
import { rollbackHash } from "../promote/record";
import { siteWorkflow } from "../promote/site";
import {
  createTestPhaseDeps,
  fakeSharedCloudflare,
  ScriptedApprovalHandler,
  ScriptedRunner,
} from "../testing";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { FakeRollbackGitHub } from "./__fixtures__/versions";
import { type RollbackOptions, type RollbackServices, rollback } from "./index";

/** Worker version ids, as Cloudflare names them. */
const NOW = "bbbbbbbb-2222-4222-8222-222222222222";
const BEFORE = "cccccccc-3333-4333-8333-333333333333";
const OLDEST = "dddddddd-4444-4444-8444-444444444444";
/** The commit run 550 built `BEFORE` from. */
const BEFORE_COMMIT = commitOf("before");
const COMMAND = "opscrew rollback --env prod";
/** The test deps' clock. */
const CLOCK = "2026-10-11T12:00:00.000Z";

/** The kinds `--yes` grants in the CLI: none of them is bound to a hash. */
const YES_KINDS: readonly ApprovalRequest["kind"][] = [
  "repo-write",
  "github-secrets",
  "github-settings",
  "git-push",
  "pull-request",
];

const planHash = (plan: unknown) => sha256Hex(canonicalJson(plan));

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** A runner whose git knows the GitHub remote `acme/shop`. */
const gitRemote = () =>
  new ScriptedRunner((_command, args) =>
    args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "not scripted" },
  );

const deployed = (plan: DeployPlan) =>
  DeployPlanSchema.parse({ ...plan, deployment: { lastApplyAt: "2026-10-23T11:00:00.000Z" } });

/** A deployment of the Worker that serves `version` alone. */
const deployment = (version: string, at: string) => ({
  id: `deployment-${version}`,
  created_on: at,
  source: "wrangler",
  strategy: "percentage" as const,
  versions: [{ version_id: version, percentage: 100 }],
});

/**
 * prod's site deployed from main, on Cloudflare's hosting (its Worker `example-app` serves `NOW`,
 * and served `BEFORE` before it; `OLDEST` never ran) or on GitHub Pages (`pages`: runs 900, then
 * 800, then 700). `events` records each approval, each write of the pause variable, and each
 * change at Cloudflare or GitHub, in order.
 */
async function siteWorld(
  o: {
    pages?: boolean;
    approve?: (r: ApprovalRequest) => boolean;
    /** A run of the site's workflow in progress: from the start, or once the pause is set. */
    running?: "before" | "after";
  } = {},
) {
  const events: string[] = [];
  const handler = new ScriptedApprovalHandler((request) => {
    events.push(`approve:${request.kind}`);
    return o.approve?.(request) ?? true;
  });
  const deps = await createTestPhaseDeps({ runner: gitRemote(), approvalHandler: handler });
  const plan = deployed(o.pages === true ? pagesTestPlan() : sitePlan());
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const tfvars = join(deps.paths.root, plan.infra.dir, "terraform.tfvars.json");
  await mkdir(dirname(tfvars), { recursive: true });
  await writeFile(tfvars, JSON.stringify({ cloudflare_account_id: FAKE_ACCOUNT_ID }));

  const zone = new FakeZone();
  zone.workers.set("example-app", {
    versions: [
      { id: NOW, created_on: "2026-10-23T10:00:00Z", message: `opscrew 600 ${"a".repeat(64)}` },
      { id: BEFORE, created_on: "2026-10-22T10:00:00Z", message: `opscrew 550 ${"b".repeat(64)}` },
      { id: OLDEST, created_on: "2026-10-21T10:00:00Z", source: "terraform" },
    ],
    deployments: [
      deployment(NOW, "2026-10-23T10:00:00Z"),
      deployment(BEFORE, "2026-10-22T10:00:00Z"),
    ],
  });
  const github = new FakeRollbackGitHub();
  github.build(`sha256:${"b".repeat(64)}`, { runId: 550, commit: BEFORE_COMMIT });
  github.pages.set("opscrew-deploy.yml", [
    { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
    { runId: 800, attempt: 1, startedAt: "2026-10-22T10:00:00Z", headSha: "e".repeat(40) },
    { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
  ]);
  // The default branch holds the workflow the plan generates.
  github.onMain.set(plan.cicd.workflowPath, blobOf(await siteWorkflow(deps.paths, plan)));
  const inProgress = () =>
    github.runs.set(990, {
      repository: "acme/shop",
      headRepository: "acme/shop",
      event: "push",
      headBranch: "main",
      headSha: "9".repeat(40),
      path: plan.cicd.workflowPath,
      createdAt: "2026-10-23T11:30:00Z",
      status: "in_progress",
      conclusion: null,
    });
  if (o.running === "before") inProgress();
  const api = Object.assign(github, {
    async setRepoVariable(_owner: string, _repo: string, name: string, value: string) {
      events.push("pause");
      github.variables.set(name, value);
      if (o.running === "after") inProgress();
    },
    async deleteRepoVariable(_owner: string, _repo: string, name: string) {
      events.push("unpause");
      github.variables.delete(name);
    },
  });
  const rerun = api.rerunWorkflowRun.bind(api);
  api.rerunWorkflowRun = async (...args: Parameters<typeof rerun>) => {
    events.push("rerun");
    return rerun(...args);
  };
  let clock = 0;
  const services: RollbackServices = {
    github: api,
    sharedCloudflare: fakeSharedCloudflare(zone),
    drift: async () => cleanDrift(),
    sleep: async () => {
      events.push("sleep");
    },
    // Ten minutes a look, so a deploy that keeps running outlasts the 30 minutes' wait.
    now: () => (clock += 10 * 60_000),
  };
  const run = (options: Omit<RollbackOptions, "services"> = {}) =>
    rollback(deps, { ...options, services });
  const serving = () => zone.workers.get("example-app")?.deployments[0]?.versions[0]?.version_id;
  const paused = () => {
    const text = github.variables.get(DEPLOY_PAUSED_VARIABLE);
    return text === undefined ? undefined : JSON.parse(text);
  };
  return { deps, handler, github, zone, events, plan, run, serving, paused };
}

describe("opscrew rollback on Cloudflare's hosting", () => {
  it("activates the version served before, with no build, the pause set between the approval and the activation", async () => {
    const world = await siteWorld();
    const result = await world.run();

    expect(result).toEqual({
      kind: "rolled-back",
      status: "deployed",
      target: { version: BEFORE, builtAt: "2026-10-22T10:00:00Z" },
      from: { version: NOW },
      paused: true,
      how: "worker",
    });
    expect(world.serving()).toBe(BEFORE);
    expect(world.events).toEqual(["approve:promote", "pause", "sleep"]);
    const request = world.handler.requests[0] as ApprovalRequest;
    expect(request.planHash).toBe(
      rollbackHash({ target: "prod", version: BEFORE, targetPlanHash: planHash(world.plan) }),
    );
    // The entry names the version, the commit its build came from, and when.
    expect(world.paused()).toEqual({
      "example-app/prod": {
        reason: "rollback",
        since: CLOCK,
        image: BEFORE,
        commit: BEFORE_COMMIT,
      },
    });
    expect(world.deps.reporter.text()).toContain(
      `prod's deploys are paused: a push to main builds but doesn't deploy. When the fix is pushed, run \`${COMMAND} --resume\` (add --deploy to deploy main's latest commit now).`,
    );
    expect(world.deps.audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(["pause the deploys of example-app/prod", "activate worker version"]),
    );
  });

  it("says that nothing is rebuilt before the approval", async () => {
    const said: boolean[] = [];
    const world = await siteWorld({
      approve: () => {
        said.push(
          world.deps.reporter
            .text()
            .includes(
              "Cloudflare serves that Worker version at 100% within a minute; nothing is rebuilt.",
            ),
        );
        return true;
      },
    });
    await world.run();
    expect(said).toEqual([true]);
  });

  it("goes further back on a rollback of a rollback, never undoing the first (D4)", async () => {
    const world = await siteWorld();
    await world.run();
    expect(world.serving()).toBe(BEFORE);
    expect(await world.run({ list: true })).toMatchObject({
      versions: [
        { version: NOW },
        { version: BEFORE, marks: ["running"] },
        { version: OLDEST, marks: ["previous"] },
      ],
    });
    const second = await world.run();
    expect(second).toMatchObject({ target: { version: OLDEST }, from: { version: BEFORE } });
    expect(world.serving()).toBe(OLDEST);
    expect(world.paused()?.["example-app/prod"]).toMatchObject({ image: OLDEST });
  });

  it("after a rollback and a deploy forward, goes back to the version served before, never the bad one (D4)", async () => {
    const world = await siteWorld();
    await world.run();
    expect(world.serving()).toBe(BEFORE);
    // NOW was bad; once the fix was pushed, the deploys resumed and FIX was deployed.
    const FIX = "eeeeeeee-5555-4555-8555-555555555555";
    const worker = world.zone.workers.get("example-app");
    if (worker === undefined) throw new Error("no Worker");
    worker.versions.unshift({ id: FIX, created_on: "2026-10-25T10:00:00Z" });
    worker.deployments.unshift(deployment(FIX, "2026-10-25T10:00:00Z"));
    world.github.variables.delete(DEPLOY_PAUSED_VARIABLE);

    expect(await world.run({ list: true })).toMatchObject({
      versions: [
        { version: FIX, marks: ["running"] },
        { version: NOW },
        { version: BEFORE, marks: ["previous"] },
        { version: OLDEST },
      ],
    });
    const second = await world.run();
    expect(second).toMatchObject({ target: { version: BEFORE }, from: { version: FIX } });
    expect(world.serving()).toBe(BEFORE);
  });

  it("goes to the version --to names, even one that never ran, its commit unknown without OpsCrew's build", async () => {
    const world = await siteWorld();
    const result = await world.run({ to: OLDEST });
    expect(result).toMatchObject({
      kind: "rolled-back",
      target: { version: OLDEST },
      how: "worker",
    });
    expect(world.serving()).toBe(OLDEST);
    expect(world.paused()?.["example-app/prod"]).toMatchObject({
      image: OLDEST,
      commit: "unknown",
    });
  });

  it("lists the Worker's versions and the pause, with no approval and no change", async () => {
    const world = await siteWorld();
    const entry = { reason: "move", since: CLOCK };
    world.github.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({ "example-app/prod": entry }),
    );
    const result = await world.run({ list: true });
    expect(result).toEqual({
      kind: "list",
      versions: [
        { version: NOW, builtAt: "2026-10-23T10:00:00Z", marks: ["running"] },
        { version: BEFORE, builtAt: "2026-10-22T10:00:00Z", marks: ["previous"] },
        { version: OLDEST, builtAt: "2026-10-21T10:00:00Z" },
      ],
      paused: entry,
      leftOut: 0,
    });
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.zone.writes()).toEqual([]);
  });

  it("refuses when the Worker has no version older than the one running, with nothing changed", async () => {
    const world = await siteWorld();
    const worker = world.zone.workers.get("example-app");
    if (worker) worker.deployments = [deployment(OLDEST, "2026-10-23T10:00:00Z")];
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The Worker example-app of prod has no version uploaded before the one it runs, so there is nothing to roll back to. Nothing was changed.",
    );
    expect(error.hint).toContain(`\`${COMMAND} --list\``);
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("refuses the version running, and a mismatched --approve, before the pause", async () => {
    const world = await siteWorld();
    const running = await failure(world.run({ to: NOW }));
    expect(running.message).toBe(
      `The Worker example-app of the prod environment runs the version ${NOW} already. Nothing was changed.`,
    );
    const mismatch = await failure(world.run({ approveHash: "0".repeat(64) }));
    expect(mismatch.code).toBe("PLAN_NOT_APPROVED");
    expect(mismatch.message).toBe(
      `The rollback you approved (${"0".repeat(64)}) is not this one: what prod runs, the version to go back to or prod's plan changed since you reviewed it. Nothing was changed.`,
    );
    expect(mismatch.hint).toMatch(
      new RegExp(
        `^Review the rollback above; to apply it, run: ${COMMAND} --to ${BEFORE} --approve [0-9a-f]{64}$`,
      ),
    );
    expect(world.events).toEqual([]);
    expect(world.serving()).toBe(NOW);
  });

  it("is never granted by --yes, and prints the command that approves it, worded as a rollback", async () => {
    const world = await siteWorld({ approve: (request) => YES_KINDS.includes(request.kind) });
    const error = await failure(world.run());
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toMatch(/^The rollback was not approved.*Nothing was changed\.$/);
    expect(error.hint).toMatch(
      new RegExp(
        `^To roll back later without prompts, run: ${COMMAND} --to ${BEFORE} --approve [0-9a-f]{64}$`,
      ),
    );
    expect(world.handler.requests[0]?.details).toContain("Rollback hash: ");
    expect(world.handler.requests[0]?.details).not.toMatch(/promotion/i);
    expect(world.paused()).toBeUndefined();
    expect(world.serving()).toBe(NOW);
  });

  it("refuses while a deploy of the site runs, before any change (FR-1907)", async () => {
    const world = await siteWorld({ running: "before" });
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "A run of prod's deploy workflow is queued or in progress: https://github.com/acme/shop/actions/runs/990. OpsCrew rolls back only between deploys, so the two never race. Nothing was changed.",
    );
    expect(error.hint).toBe(`Let it end, then run \`${COMMAND}\` again.`);
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("refuses when the branch's workflow is not the one the plan generates, which has no pause", async () => {
    const world = await siteWorld();
    world.github.onMain.set(world.plan.cicd.workflowPath, blobOf("name: an older workflow\n"));
    const error = await failure(world.run());
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The deploy workflow on the default branch main (${world.plan.cicd.workflowPath}) is not the one prod's plan generates, so its run would not do what this rollback shows. Nothing was changed.`,
    );
    expect(error.hint).toContain("opscrew provision --env prod");
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("waits for a deploy that started just before the pause, and puts the pause back when it outlasts the wait", async () => {
    const world = await siteWorld({ running: "after" });
    const error = await failure(world.run());
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain(
      "still runs after 30 minutes, so the rollback did not start, and OpsCrew put prod's deploy pause back as it was. Nothing was changed.",
    );
    expect(error.hint).toBe(
      `Let it end (https://github.com/acme/shop/actions), then run \`${COMMAND}\` again.`,
    );
    expect(world.events.at(-1)).toBe("unpause");
    expect(world.paused()).toBeUndefined();
    expect(world.serving()).toBe(NOW);
  });

  it("trims --allow-old-secrets, drops repeats, and refuses a name that is not a secret's", async () => {
    const world = await siteWorld();
    const before = world.zone.workers.get("example-app")?.versions.find((v) => v.id === BEFORE);
    if (before) before.secretsChanged = ["STRIPE_SECRET_KEY"];
    const wrong = await failure(world.run({ allowOldSecrets: ["not a name"] }));
    expect(wrong.code).toBe("INVALID_INPUT");
    expect(wrong.message).toBe('"not a name" is not a secret\'s name. Nothing was changed.');
    expect(world.handler.requests).toEqual([]);

    await world.run({ allowOldSecrets: [" STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"] });
    expect(world.handler.requests[0]?.planHash).toBe(
      rollbackHash({
        target: "prod",
        version: BEFORE,
        targetPlanHash: planHash(world.plan),
        oldSecrets: ["STRIPE_SECRET_KEY"],
      }),
    );
    expect(world.serving()).toBe(BEFORE);
  });

  it("puts back the entry it replaced when Cloudflare refuses the version for changed secrets", async () => {
    const world = await siteWorld();
    const before = world.zone.workers.get("example-app")?.versions.find((v) => v.id === BEFORE);
    if (before) before.secretsChanged = ["STRIPE_SECRET_KEY"];
    // A rollback of a rollback: the earlier rollback's entry is the one put back.
    const earlier = {
      reason: "rollback",
      since: "2026-10-11T10:00:00.000Z",
      image: NOW,
      commit: commitOf("now"),
    };
    world.github.variables.set(
      DEPLOY_PAUSED_VARIABLE,
      JSON.stringify({ "example-app/prod": earlier }),
    );

    const error = await failure(world.run());

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("predates a change to the secret STRIPE_SECRET_KEY");
    expect(error.message).toMatch(/OpsCrew put prod's deploy pause back as it was\.$/);
    expect(error.hint).toContain(`${COMMAND} --to ${BEFORE} --allow-old-secrets STRIPE_SECRET_KEY`);
    expect(world.events).toEqual(["approve:promote", "pause", "sleep", "pause"]);
    expect(world.paused()).toEqual({ "example-app/prod": earlier });
    expect(world.serving()).toBe(NOW);
    expect(world.deps.audit.entries.map((e) => e.action)).toContain(
      "pause the deploys of example-app/prod",
    );
  });

  it("with --allow-old-secrets binds them to the hash and activates the version anyway", async () => {
    const world = await siteWorld();
    const before = world.zone.workers.get("example-app")?.versions.find((v) => v.id === BEFORE);
    if (before) before.secretsChanged = ["STRIPE_SECRET_KEY"];
    const result = await world.run({ allowOldSecrets: ["STRIPE_SECRET_KEY"] });
    expect(result).toMatchObject({ kind: "rolled-back", status: "deployed", how: "worker" });
    expect(world.handler.requests[0]?.planHash).toBe(
      rollbackHash({
        target: "prod",
        version: BEFORE,
        targetPlanHash: planHash(world.plan),
        oldSecrets: ["STRIPE_SECRET_KEY"],
      }),
    );
    expect(world.serving()).toBe(BEFORE);
  });

  it("puts no Cloudflare token in the pause, the output or the audit", async () => {
    // The token of `fakeSharedCloudflare`'s client.
    const token = fakeSecret("cloudflare-token", "shared");
    const world = await siteWorld();
    await world.run();
    const everything = [
      world.deps.reporter.text(),
      JSON.stringify(world.deps.audit.entries),
      world.github.variables.get(DEPLOY_PAUSED_VARIABLE) ?? "",
    ].join("\n");
    expect(everything).not.toContain(token);
  });
});

describe("opscrew rollback on GitHub Pages", () => {
  it("re-runs the run before the one serving, saying first that it rebuilds, for 30 days, the pause set before the re-run", async () => {
    const said: boolean[] = [];
    const world = await siteWorld({
      pages: true,
      approve: () => {
        said.push(
          world.deps.reporter
            .text()
            .includes(
              "GitHub re-runs that run: it builds the site again from eeeeeee, and a base image or a dependency may have changed since; GitHub re-runs a run for up to 30 days.",
            ),
        );
        return true;
      },
    });
    const result = await world.run();

    expect(said).toEqual([true]);
    expect(result).toEqual({
      kind: "rolled-back",
      status: "deployed",
      target: {
        version: "800",
        commit: "e".repeat(40),
        builtAt: "2026-10-22T10:00:00Z",
        marks: ["previous"],
      },
      from: {
        version: "900",
        commit: "f".repeat(40),
        builtAt: "2026-10-23T10:00:00Z",
        marks: ["running"],
      },
      runUrl: "https://github.com/acme/shop/actions/runs/777",
      paused: true,
      how: "pages",
    });
    expect(world.events).toEqual(["approve:promote", "pause", "sleep", "rerun"]);
    expect(world.github.reruns).toEqual([800]);
    expect(world.paused()).toEqual({
      "example-app/prod": {
        reason: "rollback",
        since: CLOCK,
        image: "800",
        commit: "e".repeat(40),
        from: "f".repeat(40),
      },
    });
  });

  it("goes further back on a rollback of a rollback, by run id, never undoing the first (D4)", async () => {
    const world = await siteWorld({ pages: true });
    await world.run();
    expect(world.github.reruns).toEqual([800]);
    // The re-run keeps run 800's id and is now the latest started, so it serves the site.
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 800, attempt: 2, startedAt: "2026-10-23T12:00:00Z", headSha: "e".repeat(40) },
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
    ]);
    expect(await world.run({ list: true })).toMatchObject({
      versions: [
        { version: "800", marks: ["running"] },
        { version: "900" },
        { version: "700", marks: ["previous"] },
      ],
    });
    const second = await world.run();
    expect(second).toMatchObject({ target: { version: "700" }, from: { version: "800" } });
    expect(world.github.reruns).toEqual([800, 700]);
  });

  it("after a push while paused, still marks the pinned run running and goes further back, never to the bad run (D4)", async () => {
    // 900 (B) is bad: the rollback re-ran 800 (A) and pinned it.
    const world = await siteWorld({ pages: true });
    await world.run();
    // 1000 (C) was pushed while paused: it succeeded with its deploy job skipped.
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 1000, attempt: 1, startedAt: "2026-10-23T13:00:00Z", headSha: "c".repeat(40) },
      { runId: 800, attempt: 2, startedAt: "2026-10-23T12:00:00Z", headSha: "e".repeat(40) },
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
    ]);
    const list = await world.run({ list: true });
    expect(list).toMatchObject({
      versions: [
        { version: "1000" },
        { version: "800", marks: ["running"] },
        { version: "900" },
        { version: "700", marks: ["previous"] },
      ],
    });
    expect(list.kind === "list" && list.versions[0]).not.toHaveProperty("marks");
    const second = await world.run();
    expect(second).toMatchObject({ target: { version: "700" }, from: { version: "800" } });
    expect(world.github.reruns).toEqual([800, 700]);
  });

  it("after --resume without --deploy, takes the run that published for the running one, marks the skipped push, and goes further back (D4)", async () => {
    // 900 (B) is bad: the rollback re-ran 800 (A) and pinned it.
    const world = await siteWorld({ pages: true });
    await world.run();
    // 1000 (C) was pushed while paused: its publish job was skipped. Then the pause ended.
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 1000, attempt: 1, startedAt: "2026-10-23T13:00:00Z", headSha: "c".repeat(40) },
      { runId: 800, attempt: 2, startedAt: "2026-10-23T12:00:00Z", headSha: "e".repeat(40) },
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
    ]);
    world.github.skippedRuns.add(1000);
    expect(await world.run({ resume: true })).toEqual({ kind: "resumed", wasPaused: true });
    expect(world.paused()).toBeUndefined();

    world.github.jobReads.length = 0;
    const list = await world.run({ list: true });
    expect(list).toMatchObject({
      versions: [
        { version: "1000", marks: ["skipped"] },
        { version: "800", marks: ["running"] },
        { version: "900" },
        { version: "700", marks: ["previous"] },
      ],
    });
    expect(list.kind === "list" && list.versions[2]).not.toHaveProperty("marks");
    // Newest first, each once: 900, which published before 800's re-run, was created after 800,
    // so the walk goes on below 800.
    expect(world.github.jobReads).toEqual([1000, 800, 900, 700]);
    const second = await world.run();
    expect(second).toMatchObject({ target: { version: "700" }, from: { version: "800" } });
    expect(world.github.reruns).toEqual([800, 700]);
  });

  it("after --resume --deploy, goes back to the run that published before, never the bad one, with one walk (D4)", async () => {
    // 900 (B) is bad: the rollback re-ran 800 (A) and pinned it.
    const world = await siteWorld({ pages: true });
    await world.run();
    // 1000 (C) was pushed while paused, its publish skipped; `--resume --deploy` published 1100 (E).
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 1100, attempt: 1, startedAt: "2026-10-23T14:00:00Z", headSha: "a".repeat(40) },
      { runId: 1000, attempt: 1, startedAt: "2026-10-23T13:00:00Z", headSha: "c".repeat(40) },
      { runId: 800, attempt: 2, startedAt: "2026-10-23T12:00:00Z", headSha: "e".repeat(40) },
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
    ]);
    world.github.skippedRuns.add(1000);
    world.github.variables.delete(DEPLOY_PAUSED_VARIABLE);

    expect(await world.run({ list: true })).toMatchObject({
      versions: [
        { version: "1100", marks: ["running"] },
        { version: "1000", marks: ["skipped"] },
        { version: "800", marks: ["previous"] },
        { version: "900" },
        { version: "700" },
      ],
    });
    world.github.jobReads.length = 0;
    const second = await world.run();
    expect(second).toMatchObject({ target: { version: "800" }, from: { version: "1100" } });
    expect(world.github.reruns).toEqual([800, 800]);
    // The rollback's own walk only: the re-run reads no run's jobs again.
    expect(world.github.jobReads).toEqual([1100, 1000, 800]);
  });

  it("while paused, re-runs the push's skipped run --to names, and refuses the pinned one, which serves the site", async () => {
    const world = await siteWorld({ pages: true });
    await world.run();
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 1000, attempt: 1, startedAt: "2026-10-23T13:00:00Z", headSha: "c".repeat(40) },
      { runId: 800, attempt: 2, startedAt: "2026-10-23T12:00:00Z", headSha: "e".repeat(40) },
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
    ]);
    world.github.skippedRuns.add(1000);
    const pinned = await failure(world.run({ to: "800" }));
    expect(pinned.message).toBe(
      "The run 800 published the site that GitHub Pages serves now. Nothing was changed.",
    );
    const forward = await world.run({ to: "1000" });
    expect(forward).toMatchObject({
      target: { version: "1000" },
      from: { version: "800", marks: ["running"] },
    });
    expect(world.github.reruns).toEqual([800, 1000]);
  });

  it("refuses with the next step when the pinned run has not succeeded, and still goes --to a run", async () => {
    const world = await siteWorld({ pages: true });
    await world.run();
    // A reviewer rejected 800's re-run: its latest attempt failed, so GitHub lists it no more.
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 700, attempt: 1, startedAt: "2026-10-21T10:00:00Z", headSha: "d".repeat(40) },
    ]);
    const events = world.events.length;
    const refused = await failure(world.run());
    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toBe(
      "The run 800 that `opscrew rollback` pinned prod's site to has not succeeded: it is still running, waits for a reviewer, or failed. Nothing was changed.",
    );
    expect(refused.hint).toBe(
      `Roll back to another run with \`${COMMAND} --to <run id>\` (\`${COMMAND} --list\` lists the runs), or run \`${COMMAND} --resume\` to deploy forward again.`,
    );
    expect(world.events.length).toBe(events);
    const list = await world.run({ list: true });
    expect(list.kind === "list" && list.versions.flatMap((v) => v.marks ?? [])).toEqual([]);
    expect(await world.run({ to: "700" })).toMatchObject({ target: { version: "700" } });
    expect(world.github.reruns).toEqual([800, 700]);
  });

  it("puts no GitHub token in the output, the audit, the approval or the pause", async () => {
    const token = fakeSecret("github-token", "rollback-pages");
    const world = await siteWorld({ pages: true });
    world.deps.env.GITHUB_TOKEN = token;
    await world.run();
    const everything = [
      world.deps.reporter.text(),
      JSON.stringify(world.deps.audit.entries),
      JSON.stringify(world.handler.requests),
      world.github.variables.get(DEPLOY_PAUSED_VARIABLE) ?? "",
    ].join("\n");
    expect(everything).not.toContain(token);
  });

  it("goes to the run --to names, by its id or its commit", async () => {
    for (const to of ["700", "ddddddd"]) {
      const world = await siteWorld({ pages: true });
      const result = await world.run({ to });
      expect(result).toMatchObject({ target: { version: "700" }, how: "pages" });
      expect(world.github.reruns).toEqual([700]);
    }
  });

  it("refuses a --to that names no successful run, and a site with one run only", async () => {
    const world = await siteWorld({ pages: true });
    const now = await failure(world.run({ to: "900" }));
    expect(now.message).toBe(
      "The run 900 published the site that GitHub Pages serves now. Nothing was changed.",
    );
    const unknown = await failure(world.run({ to: "abcdef1" }));
    expect(unknown.code).toBe("PHASE_PRECONDITION");
    expect(unknown.message).toBe(
      "abcdef1 is neither the id nor the commit of a successful run of opscrew-deploy.yml, prod's site workflow. Nothing was changed.",
    );
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
    ]);
    const only = await failure(world.run());
    expect(only.message).toBe(
      "No successful run of opscrew-deploy.yml was created before the one that published prod's site now, so there is nothing to roll back to. Nothing was changed.",
    );
    expect(world.handler.requests).toEqual([]);
    expect(world.events).toEqual([]);
  });

  it("lists the successful runs, with no approval and no change", async () => {
    const world = await siteWorld({ pages: true });
    const result = await world.run({ list: true });
    expect(result).toMatchObject({
      kind: "list",
      versions: [
        { version: "900", marks: ["running"] },
        { version: "800", marks: ["previous"] },
        { version: "700", commit: "d".repeat(40) },
      ],
      leftOut: 0,
    });
    expect(result).not.toHaveProperty("paused");
    expect(world.events).toEqual([]);
  });

  it("puts the pause back when the re-run fails", async () => {
    const world = await siteWorld({ pages: true });
    world.github.conclusion = "failure";
    const error = await failure(world.run());
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toMatch(/OpsCrew put prod's deploy pause back as it was\.$/);
    expect(world.events).toEqual(["approve:promote", "pause", "sleep", "rerun", "unpause"]);
    expect(world.paused()).toBeUndefined();
  });

  it("keeps the pause while the re-run waits for a required reviewer", async () => {
    const world = await siteWorld({ pages: true });
    world.github.reviewer = "pending";
    const result = await world.run();
    expect(result).toMatchObject({ kind: "rolled-back", status: "waiting", paused: true });
    expect(world.paused()?.["example-app/prod"]).toMatchObject({ image: "800" });
  });
});
