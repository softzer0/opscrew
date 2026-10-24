import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FAKE_ACCOUNT_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { renderCloudflareWorkersWorkflow } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments";
import {
  createTestPhaseDeps,
  fakeSharedCloudflare,
  ScriptedApprovalHandler,
  ScriptedRunner,
} from "../testing";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import {
  blobOf,
  cleanDrift,
  DEPLOY_RUN_URL,
  FakePromoteGitHub,
  promoteWorld,
  WORKFLOWS,
} from "./__fixtures__/world";
import { promote } from "./index";
import { buildPromotionHash, rollbackHash } from "./record";
import type { PromoteServices } from "./types";

/** The build staging runs: run 501's, with this SHA-256 (a hash, not a secret). */
const BUILD = { runId: 501, sha256: sha256Hex("site:staging") };
/** Worker version ids, as Cloudflare names them. */
const STAGING_VERSION = "aaaaaaaa-1111-4111-8111-111111111111";
const PROD_NOW = "bbbbbbbb-2222-4222-8222-222222222222";
const PROD_BEFORE = "cccccccc-3333-4333-8333-333333333333";

/** The hash of a plan as promote binds it: SHA-256 of its canonical JSON. */
const planHash = (plan: unknown) => sha256Hex(canonicalJson(plan));

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** A Worker whose latest deployment runs `running` alone; versions latest first. */
function worker(running: string, versions: { id: string; message?: string }[]) {
  return {
    versions: versions.map((version) => ({ ...version, created_on: "2026-10-23T09:00:00Z" })),
    deployments: [
      {
        id: `deployment-${running}`,
        created_on: "2026-10-23T09:00:00Z",
        source: "wrangler",
        strategy: "percentage" as const,
        versions: [{ version_id: running, percentage: 100 }],
      },
    ],
  };
}

/** A runner whose git knows the GitHub remote `acme/shop`. */
const gitRemote = () =>
  new ScriptedRunner((_command, args) =>
    args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "not scripted" },
  );

/**
 * Sites on Cloudflare's hosting: staging follows main and runs the build of run 501, prod is
 * promoted from staging and runs `PROD_NOW` (with `PROD_BEFORE` before it); both provisioned, the
 * workflows merged. With `pages`, prod is a GitHub Pages site instead.
 */
async function siteWorld(o: { staging?: { message?: string }; pages?: boolean } = {}) {
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({ runner: gitRemote(), approvalHandler: handler });
  const deployed = (plan: DeployPlan) =>
    DeployPlanSchema.parse({ ...plan, deployment: { lastApplyAt: "2026-10-23T11:00:00.000Z" } });
  const staging = deployed(
    sitePlan({ environment: "staging", domain: "staging-docs.example.com" }),
  );
  const prod = deployed(o.pages === true ? pagesTestPlan() : sitePlan({ promotedFrom: "staging" }));
  const write = async (path: string, text: string) => {
    const file = join(deps.paths.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  for (const [name, plan] of [
    ["prod", prod],
    ["staging", staging],
  ] as const) {
    await writeArtifact("plan", environmentPaths(deps.paths, name).files.plan, plan);
    await write(
      `${plan.infra.dir}/terraform.tfvars.json`,
      JSON.stringify({ cloudflare_account_id: FAKE_ACCOUNT_ID }),
    );
  }
  for (const [path, text] of Object.entries(WORKFLOWS)) await write(path, text);
  const zone = new FakeZone();
  const message =
    "message" in (o.staging ?? {}) ? o.staging?.message : `opscrew ${BUILD.runId} ${BUILD.sha256}`;
  zone.workers.set(
    "example-app-staging",
    worker(STAGING_VERSION, [
      { id: STAGING_VERSION, ...(message !== undefined ? { message } : {}) },
    ]),
  );
  zone.workers.set(
    "example-app",
    worker(PROD_NOW, [
      { id: PROD_NOW, message: `opscrew 600 ${sha256Hex("site:prod")}` },
      { id: PROD_BEFORE, message: `opscrew 550 ${sha256Hex("site:before")}` },
    ]),
  );
  const github = new FakePromoteGitHub();
  github.artifacts.set(BUILD.runId, [
    { name: "opscrew-site", expired: false, expiresAt: "2027-01-21T09:00:00Z" },
  ]);
  // The default branch holds the workflow prod's plan generates (staging builds its sites).
  if (o.pages !== true) {
    const rendered = renderCloudflareWorkersWorkflow(prod, {
      builderBranch: "main",
      builderWorkflowPath: staging.cicd.workflowPath,
    });
    github.onMain.set(rendered.path, blobOf(rendered.content));
  }
  const sleeps: number[] = [];
  const services: PromoteServices = {
    github,
    drift: async () => cleanDrift(),
    sharedCloudflare: fakeSharedCloudflare(zone),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, handler, github, zone, services, sleeps, prod, staging };
}

/** The `promote` approvals asked for. */
const promotions = (handler: ScriptedApprovalHandler) =>
  handler.requests.filter((r) => r.kind === "promote");

describe("promote on Cloudflare's hosting", () => {
  it("deploys the exact build the source runs, after an approval bound to both environments, the run, the SHA-256 and the target plan", async () => {
    const world = await siteWorld();
    const result = await promote(world.deps, { target: "prod", services: world.services });

    expect(result).toEqual({ status: "deployed", runUrl: DEPLOY_RUN_URL, build: BUILD });
    const expected = buildPromotionHash({
      target: "prod",
      source: "staging",
      ...BUILD,
      targetPlanHash: planHash(world.prod),
    });
    const request = promotions(world.handler)[0] as ApprovalRequest;
    expect(world.handler.requests).toHaveLength(1);
    expect(request).toMatchObject({ kind: "promote", planHash: expected });
    expect(request.title).toBe("Deploy the build staging runs to prod");
    expect(request.details).toContain(
      `Build: https://github.com/acme/shop/actions/runs/501, with the SHA-256 ${BUILD.sha256}`,
    );
    expect(request.details).toContain(
      `the version ${STAGING_VERSION} of its Worker example-app-staging`,
    );
    expect(request.details).toContain("GitHub keeps that build until 2027-01-21T09:00:00Z");
    expect(request.details).toContain(planHash(world.prod));
    // prod's own workflow on the default branch, given the run and the SHA-256; nothing rebuilt.
    expect(world.github.dispatches).toEqual([
      {
        workflowFile: "opscrew-deploy.yml",
        ref: "main",
        inputs: { run: "501", sha256: BUILD.sha256 },
      },
    ]);
    expect(world.deps.audit.entries.map((e) => `${e.kind}:${e.action}`)).toEqual(
      expect.arrayContaining(["approval:promote", "provider-call:dispatch workflow"]),
    );
  });

  it("binds the promotion's hash to each of its parts", () => {
    const parts = {
      target: "prod",
      source: "staging",
      ...BUILD,
      targetPlanHash: planHash({ plan: 1 }),
    };
    const hash = buildPromotionHash(parts);
    for (const changed of [
      { target: "qa" },
      { source: "dev" },
      { runId: 502 },
      { sha256: sha256Hex("site:other") },
      { targetPlanHash: planHash({ plan: 2 }) },
    ]) {
      expect(buildPromotionHash({ ...parts, ...changed }), JSON.stringify(changed)).not.toBe(hash);
    }
  });

  it("refuses when the default branch's workflow is not the one the plan generates now", async () => {
    // The plan changed since provision: the working tree's copy and the default branch's still
    // match each other (and drift compares no generated file of a site), but not the plan.
    const world = await siteWorld();
    const path = ".github/workflows/opscrew-deploy.yml";
    world.github.onMain.set(path, blobOf(WORKFLOWS[path] as string));
    const error = await failure(promote(world.deps, { target: "prod", services: world.services }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The deploy workflow on the default branch main (${path}) is not the one prod's plan generates, so its run would not do what this promotion shows. Nothing was deployed.`,
    );
    expect(error.hint).toBe(
      "Run `opscrew provision --env prod`: its pull request brings the workflow up to date with the plan. Merge it, then run `opscrew promote --to prod` again.",
    );
    expect(world.handler.requests).toEqual([]);
    expect(world.github.dispatches).toEqual([]);
  });

  it("refuses a build whose artifact GitHub no longer keeps, before any approval", async () => {
    const hint =
      "Deploy staging again (a push to main builds the site anew), then run `opscrew promote --to prod` to promote that build.";
    const expired = await siteWorld();
    expired.github.artifacts.set(BUILD.runId, [
      { name: "opscrew-site", expired: true, expiresAt: "2026-10-20T09:00:00Z" },
    ]);
    const error = await failure(
      promote(expired.deps, { target: "prod", services: expired.services }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "GitHub no longer keeps the build staging runs: the opscrew-site artifact of run 501 expired on 2026-10-20T09:00:00Z, after the repository's artifact retention (90 days by default). Nothing was deployed.",
    );
    expect(error.hint).toBe(hint);

    const missing = await siteWorld();
    missing.github.artifacts.set(BUILD.runId, [{ name: "logs", expired: false }]);
    const none = await failure(
      promote(missing.deps, { target: "prod", services: missing.services }),
    );
    expect(none.message).toBe(
      "GitHub has no opscrew-site artifact of run 501, which built what staging runs, so there is no build to promote. Nothing was deployed.",
    );
    expect(none.hint).toBe(hint);
    for (const world of [expired, missing]) {
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    }
  });

  it("refuses a version without OpsCrew's message, before any approval", async () => {
    const world = await siteWorld({ staging: { message: undefined } });
    const error = await failure(promote(world.deps, { target: "prod", services: world.services }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The version ${STAGING_VERSION} the Worker example-app-staging of staging runs was not uploaded by OpsCrew's deploy workflow (its message is not \`opscrew <run id> <sha256>\`), so OpsCrew cannot tell which build it is. Nothing was deployed.`,
    );
    expect(error.hint).toContain("a push to main");
    expect(world.handler.requests).toEqual([]);
    expect(world.github.dispatches).toEqual([]);
  });

  it("rolls back to an earlier version of the environment's own Worker, after an approval bound to it", async () => {
    const world = await siteWorld();
    const result = await promote(world.deps, {
      target: "prod",
      version: PROD_BEFORE,
      services: world.services,
    });
    expect(result).toEqual({ status: "deployed", version: PROD_BEFORE });
    const request = promotions(world.handler)[0] as ApprovalRequest;
    expect(request.planHash).toBe(
      rollbackHash({ target: "prod", version: PROD_BEFORE, targetPlanHash: planHash(world.prod) }),
    );
    expect(request.title).toBe(`Roll prod back to the version ${PROD_BEFORE} of its Worker`);
    // The version is active again for all of the Worker's traffic; nothing is dispatched.
    expect(world.zone.workers.get("example-app")?.deployments[0]?.versions).toEqual([
      { version_id: PROD_BEFORE, percentage: 100 },
    ]);
    expect(world.github.dispatches).toEqual([]);
    expect(world.deps.audit.entries.map((e) => e.action)).toContain("activate worker version");
  });

  /** A world whose version before predates a change of `secrets`, as Cloudflare refuses it. */
  async function secretsChangedWorld(secrets: string[]) {
    const world = await siteWorld();
    const before = world.zone.workers
      .get("example-app")
      ?.versions.find((version) => version.id === PROD_BEFORE);
    if (before) before.secretsChanged = secrets;
    return world;
  }
  const DEPLOYMENTS = `/accounts/${FAKE_ACCOUNT_ID}/workers/scripts/example-app/deployments`;
  const serving = (world: Awaited<ReturnType<typeof siteWorld>>) =>
    world.zone.workers.get("example-app")?.deployments[0]?.versions;

  it("refuses by default a rollback to a version older than a secret change, naming the secrets, with nothing changed", async () => {
    const world = await secretsChangedWorld(["STRIPE_SECRET_KEY"]);
    const error = await failure(
      promote(world.deps, { target: "prod", version: PROD_BEFORE, services: world.services }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      `The version ${PROD_BEFORE} of the Worker example-app predates a change to the secret STRIPE_SECRET_KEY: activated again, it would run with its old value, the one it was uploaded with, not the current one. Nothing was deployed.`,
    );
    expect(error.hint).toBe(
      `Only if it was not changed because it leaked and its old value is still safe, run \`opscrew promote --to prod --version ${PROD_BEFORE} --allow-old-secrets STRIPE_SECRET_KEY\`. Otherwise deploy a new version instead: it runs with the current value.`,
    );
    expect(error.hint).not.toMatch(/mistyped|CLOUDFLARE_API_TOKEN/);
    // Asked once, for the plain rollback; never sent with force, and prod still runs its version.
    expect(promotions(world.handler).map((r) => r.planHash)).toEqual([
      rollbackHash({ target: "prod", version: PROD_BEFORE, targetPlanHash: planHash(world.prod) }),
    ]);
    expect(world.zone.writes().map((w) => w.path)).toEqual([DEPLOYMENTS]);
    expect(serving(world)).toEqual([{ version_id: PROD_NOW, percentage: 100 }]);
  });

  it("with --allow-old-secrets names the secrets in the approval, binds them to its hash, and only then forces the rollback", async () => {
    const world = await secretsChangedWorld(["STRIPE_SECRET_KEY", "SESSION_KEY"]);
    const result = await promote(world.deps, {
      target: "prod",
      version: PROD_BEFORE,
      allowOldSecrets: ["STRIPE_SECRET_KEY", " SESSION_KEY", "STRIPE_SECRET_KEY"],
      services: world.services,
    });
    expect(result).toEqual({ status: "deployed", version: PROD_BEFORE });
    const request = promotions(world.handler)[0] as ApprovalRequest;
    const plain = rollbackHash({
      target: "prod",
      version: PROD_BEFORE,
      targetPlanHash: planHash(world.prod),
    });
    const expected = rollbackHash({
      target: "prod",
      version: PROD_BEFORE,
      targetPlanHash: planHash(world.prod),
      oldSecrets: ["SESSION_KEY", "STRIPE_SECRET_KEY"],
    });
    expect(expected).not.toBe(plain);
    expect(request.planHash).toBe(expected);
    expect(request.details).toContain(
      "Old secrets (--allow-old-secrets): SESSION_KEY and STRIPE_SECRET_KEY. If Cloudflare reports them changed since this version was active, OpsCrew activates it anyway and it runs with their old values, not the current ones; don't do this for a value rotated because it leaked",
    );
    // First without force (Cloudflare refuses it, naming the secrets), then with it.
    expect(world.zone.writes().map((w) => w.path)).toEqual([
      DEPLOYMENTS,
      `${DEPLOYMENTS}?force=true`,
    ]);
    expect(serving(world)).toEqual([{ version_id: PROD_BEFORE, percentage: 100 }]);
    const activated = world.deps.audit.entries.find((e) => e.action === "activate worker version");
    expect(activated?.detail).toContain(
      "forced, with the old values of STRIPE_SECRET_KEY and SESSION_KEY",
    );
  });

  it("never forces a rollback past a secret --allow-old-secrets does not name", async () => {
    const world = await secretsChangedWorld(["STRIPE_SECRET_KEY", "SESSION_KEY"]);
    const error = await failure(
      promote(world.deps, {
        target: "prod",
        version: PROD_BEFORE,
        allowOldSecrets: ["STRIPE_SECRET_KEY"],
        services: world.services,
      }),
    );
    expect(error.message).toContain(
      "predates a change to the secrets STRIPE_SECRET_KEY and SESSION_KEY",
    );
    expect(error.hint).toBe(
      `Only if none of them was changed because it leaked and their old values are still safe, run \`opscrew promote --to prod --version ${PROD_BEFORE} --allow-old-secrets STRIPE_SECRET_KEY,SESSION_KEY\`. Otherwise deploy a new version instead: it runs with the current values.`,
    );
    expect(world.zone.writes().map((w) => w.path)).toEqual([DEPLOYMENTS]);
    expect(serving(world)).toEqual([{ version_id: PROD_NOW, percentage: 100 }]);
  });

  it("activates without force a version no secret change blocks, even with --allow-old-secrets", async () => {
    const world = await siteWorld();
    await promote(world.deps, {
      target: "prod",
      version: PROD_BEFORE,
      allowOldSecrets: ["STRIPE_SECRET_KEY"],
      services: world.services,
    });
    expect(world.zone.writes().map((w) => w.path)).toEqual([DEPLOYMENTS]);
    expect(serving(world)).toEqual([{ version_id: PROD_BEFORE, percentage: 100 }]);
  });

  it("refuses --allow-old-secrets without --version, or on GitHub Pages, before any approval", async () => {
    for (const [pages, version] of [
      [false, undefined],
      [true, "800"],
    ] as const) {
      const world = await siteWorld({ pages });
      const error = await failure(
        promote(world.deps, {
          target: "prod",
          ...(version === undefined ? {} : { version }),
          allowOldSecrets: ["STRIPE_SECRET_KEY"],
          services: world.services,
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(
        "--allow-old-secrets goes only with --version on a site on Cloudflare's hosting: it lets that rollback activate a Worker version older than a change to the secrets it names. Nothing was deployed.",
      );
      expect(world.handler.requests).toEqual([]);
    }
  });

  it("never takes the --approve hash of another choice of old secrets", async () => {
    const parts = { target: "prod", version: PROD_BEFORE };
    for (const [given, approved] of [
      [["STRIPE_SECRET_KEY"], undefined],
      [["STRIPE_SECRET_KEY"], ["SESSION_KEY"]],
      [undefined, ["STRIPE_SECRET_KEY"]],
    ] as const) {
      const world = await secretsChangedWorld(["STRIPE_SECRET_KEY"]);
      const approveHash = rollbackHash({
        ...parts,
        targetPlanHash: planHash(world.prod),
        ...(approved === undefined ? {} : { oldSecrets: [...approved] }),
      });
      const error = await failure(
        promote(world.deps, {
          ...parts,
          ...(given === undefined ? {} : { allowOldSecrets: [...given] }),
          approveHash,
          services: world.services,
        }),
      );
      expect(error.code, JSON.stringify({ given, approved })).toBe("PLAN_NOT_APPROVED");
      expect(world.zone.writes()).toEqual([]);
    }
  });

  it("refuses an --allow-old-secrets with no name or a name that is not a secret's, before any approval", async () => {
    for (const [names, message] of [
      [[], "--allow-old-secrets names no secret. Nothing was deployed."],
      [["STRIPE_SECRET_KEY", "MY-KEY"], '"MY-KEY" is not a secret\'s name. Nothing was deployed.'],
      [["A and B"], '"A and B" is not a secret\'s name. Nothing was deployed.'],
    ] as const) {
      const world = await siteWorld();
      const error = await failure(
        promote(world.deps, {
          target: "prod",
          version: PROD_BEFORE,
          allowOldSecrets: [...names],
          services: world.services,
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toBe(message);
      expect(world.handler.requests).toEqual([]);
      expect(world.zone.writes()).toEqual([]);
    }
  });

  it("refuses a rollback to the running version or to a version of another Worker", async () => {
    const world = await siteWorld();
    const running = await failure(
      promote(world.deps, { target: "prod", version: PROD_NOW, services: world.services }),
    );
    expect(running.message).toBe(
      `The Worker example-app of the prod environment runs the version ${PROD_NOW} already. Nothing was deployed.`,
    );
    const other = await failure(
      promote(world.deps, { target: "prod", version: STAGING_VERSION, services: world.services }),
    );
    expect(other.message).toBe(
      `${STAGING_VERSION} is not a version of the Worker example-app of the prod environment. Nothing was deployed.`,
    );
    expect(world.handler.requests).toEqual([]);
  });

  it("refuses a digest, and a promotion to an environment that follows a branch", async () => {
    const world = await siteWorld();
    const digest = await failure(
      promote(world.deps, {
        target: "prod",
        digest: `sha256:${"a".repeat(64)}`,
        services: world.services,
      }),
    );
    expect(digest.code).toBe("INVALID_INPUT");
    expect(digest.message).toBe(
      "--digest names an image, and the prod environment is a site on Cloudflare hosting, which has none. Nothing was deployed.",
    );
    const follows = await failure(
      promote(world.deps, { target: "staging", services: world.services }),
    );
    expect(follows.code).toBe("PHASE_PRECONDITION");
    expect(follows.message).toContain("is deployed from main on each push, not by promotion");
    expect(follows.hint).toContain("opscrew promote --to staging --version <id>");
    expect(world.handler.requests).toEqual([]);
  });
});

describe("promote on GitHub Pages", () => {
  it("rolls back by re-running an earlier successful run, after an approval bound to it", async () => {
    const world = await siteWorld({ pages: true });
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 800, attempt: 1, startedAt: "2026-10-22T10:00:00Z", headSha: "e".repeat(40) },
    ]);
    const result = await promote(world.deps, {
      target: "prod",
      version: "800",
      services: world.services,
    });
    expect(result).toEqual({ status: "deployed", version: "800", runUrl: DEPLOY_RUN_URL });
    expect(world.github.reruns).toEqual([800]);
    const request = promotions(world.handler)[0] as ApprovalRequest;
    expect(request.planHash).toBe(
      rollbackHash({ target: "prod", version: "800", targetPlanHash: planHash(world.prod) }),
    );
    expect(request.details).toContain(`of the commit ${"e".repeat(40)}`);

    // The run that published the site now, an unknown run and a non-id are refused.
    for (const [version, message] of [
      ["900", "The run 900 published the site that GitHub Pages serves now. Nothing was deployed."],
      [
        "123",
        "123 is not a successful run of opscrew-deploy.yml, the site's workflow. Nothing was deployed.",
      ],
      ["latest", '"latest" is not a workflow run\'s id. Nothing was deployed.'],
    ] as const) {
      const error = await failure(
        promote(world.deps, { target: "prod", version, services: world.services }),
      );
      expect(error.message).toBe(message);
    }
    expect(world.github.reruns).toEqual([800]);
  });

  it("follows the re-run only once GitHub shows it, never the earlier attempt's result", async () => {
    const world = await siteWorld({ pages: true });
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 800, attempt: 1, startedAt: "2026-10-22T10:00:00Z", headSha: "e".repeat(40) },
    ]);
    // GitHub's first two reads after the re-run still show attempt 1, completed and successful.
    world.github.staleReads = 2;
    const result = await promote(world.deps, {
      target: "prod",
      version: "800",
      services: world.services,
    });
    expect(result).toMatchObject({ status: "deployed", version: "800" });
    // Three reads (two stale, then attempt 2) with a pause after each stale one, then the wait.
    expect(world.github.reads).toEqual([800, 800, 800]);
    expect(world.sleeps).toEqual([2000, 2000]);
    expect(world.github.waits).toEqual([3]);
  });

  it("stops, naming the run, when GitHub never shows the re-run", async () => {
    const world = await siteWorld({ pages: true });
    world.github.pages.set("opscrew-deploy.yml", [
      { runId: 900, attempt: 1, startedAt: "2026-10-23T10:00:00Z", headSha: "f".repeat(40) },
      { runId: 800, attempt: 1, startedAt: "2026-10-22T10:00:00Z", headSha: "e".repeat(40) },
    ]);
    world.github.staleReads = Number.POSITIVE_INFINITY;
    const error = await failure(
      promote(world.deps, { target: "prod", version: "800", services: world.services }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "GitHub accepted the re-run of run 800, but did not show it started within a minute. It may still publish the site.",
    );
    expect(error.hint).toContain("https://github.com/acme/shop/actions/runs/800");
    expect(world.github.reads).toHaveLength(30);
    expect(world.sleeps).toHaveLength(29);
    expect(world.github.waits).toEqual([]);
  });

  it("refuses a promotion: each environment builds its own site", async () => {
    const world = await siteWorld({ pages: true });
    const error = await failure(promote(world.deps, { target: "prod", services: world.services }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "GitHub Pages publishes a site from a build of its own, so each environment builds its own site and OpsCrew promotes none between them. Nothing was deployed.",
    );
    expect(error.hint).toContain("--version <run id>");
    expect(world.handler.requests).toEqual([]);
  });
});

describe("promote on a server", () => {
  it("refuses --version, which names a site's version", async () => {
    const world = await promoteWorld();
    const error = await failure(
      promote(world.deps, { target: "prod", version: PROD_BEFORE, services: world.services }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("runs on a server, which deploys images");
    expect(error.hint).toContain("--digest <digest>");
    expect(world.handler.requests).toEqual([]);
  });

  it("refuses --allow-old-secrets, which only a rollback on Cloudflare's hosting takes", async () => {
    const world = await promoteWorld();
    for (const version of [undefined, PROD_BEFORE]) {
      const error = await failure(
        promote(world.deps, {
          target: "prod",
          ...(version === undefined ? {} : { version }),
          allowOldSecrets: ["STRIPE_SECRET_KEY"],
          services: world.services,
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain(
        "--allow-old-secrets goes only with --version on a site on Cloudflare's hosting",
      );
    }
    expect(world.handler.requests).toEqual([]);
  });
});
