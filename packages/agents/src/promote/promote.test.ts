import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApprovalRequest } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments";
import {
  blobOf,
  cleanDrift,
  commitOf,
  DEPLOY_RUN_URL,
  digestOf,
  inEnvironment,
  PREVIOUS_COMMIT,
  PREVIOUS_IMAGE,
  PROD_IMAGE,
  type PromoteWorld,
  promoteWorld,
  recordedPromotion,
  STAGING_COMMIT,
  STAGING_IMAGE,
  STAGING_RUN,
  WORKFLOWS,
} from "./__fixtures__/world";
import { promote, promotionHash } from "./index";
import { promotionFile, readPendingPromotion } from "./record";

/** What promote says of prod's deploy run left waiting for its reviewer. */
const STILL_WAITING = `prod's deploy run still waits in GitHub for a required reviewer: ${DEPLOY_RUN_URL}. Once they approve it, the run deploys the image. OpsCrew did not record the image as running. Run \`opscrew promote --to prod\` again once the run succeeded: it records the image without a new deploy.`;

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** The hash of a plan as promote binds it: SHA-256 of its canonical JSON. */
const planHash = (plan: unknown) => sha256Hex(canonicalJson(plan));

const PROD_WORKFLOW = ".github/workflows/opscrew-deploy.yml";

/** The kinds `--yes` grants in the CLI: none of them is bound to a hash. */
const YES_KINDS: readonly ApprovalRequest["kind"][] = [
  "repo-write",
  "github-secrets",
  "github-settings",
  "git-push",
  "pull-request",
];

/** The audit entry of the accepted dispatch. */
const dispatchAudited = (world: PromoteWorld) =>
  world.deps.audit.entries.some(
    (entry) => entry.kind === "provider-call" && entry.action === "dispatch workflow",
  );

describe("promote", () => {
  it("deploys the image the source runs, after the provenance check and a hash-bound approval", async () => {
    const world = await promoteWorld();
    const { deps, github, handler } = world;

    const result = await promote(deps, { target: "prod", services: world.services });

    expect(result).toEqual({ status: "deployed", digest: STAGING_IMAGE, runUrl: DEPLOY_RUN_URL });
    // The approval: kind promote, bound to the four parts.
    const expected = promotionHash({
      target: "prod",
      source: "staging",
      digest: STAGING_IMAGE,
      targetPlanHash: planHash(world.prodPlan),
    });
    expect(handler.requests).toHaveLength(1);
    const request = handler.requests[0] as ApprovalRequest;
    expect(request).toMatchObject({ kind: "promote", planHash: expected });
    expect(request.title).toBe("Deploy the image staging runs to prod");
    // It shows the image, its build, the target's plan and the promotion hash.
    expect(request.details).toContain(`ghcr.io/acme/shop@${STAGING_IMAGE}`);
    expect(request.details).toContain(`https://github.com/acme/shop/actions/runs/${STAGING_RUN}`);
    expect(request.details).toContain(STAGING_COMMIT);
    expect(request.details).toContain(planHash(world.prodPlan));
    expect(request.details).toContain(expected);
    expect(request.details).toContain(
      "guards against mistakes, not against someone with write access",
    );
    // The dispatch: prod's own workflow on the default branch, with the digest and the commit tag
    // staging's build gave it; nothing rebuilt.
    expect(github.dispatches).toEqual([
      {
        workflowFile: "opscrew-deploy.yml",
        ref: "main",
        inputs: { digest: STAGING_IMAGE, tag: `${STAGING_COMMIT}-staging` },
      },
    ]);
    // The drift check ran with the target's paths.
    expect(world.driftPaths.map((paths) => paths.environment)).toEqual(["prod"]);
    // The digest is recorded in the target's state.
    expect(promotionFile(deps.paths).replaceAll("\\", "/")).toMatch(
      /\/\.opscrew\/promotion\.json$/,
    );
    // With the services of the plan it was deployed with, as a later rollback checks them.
    expect(await recordedPromotion(deps.paths)).toEqual({
      digest: STAGING_IMAGE,
      source: "staging",
      runUrl: DEPLOY_RUN_URL,
      at: "2026-10-11T12:00:00.000Z",
      services: ["db"],
    });
    // The approval and the dispatch are audited.
    const actions = deps.audit.entries.map((entry) => `${entry.kind}:${entry.action}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "approval:promote",
        "provider-call:dispatch workflow",
        "provider-call:deploy workflow",
      ]),
    );
  });

  it("promotes into a named environment with its own workflow, label and state", async () => {
    const world = await promoteWorld();
    const qa = inEnvironment(world.prodPlan, "qa", {
      deploySource: { from: "promote", source: "staging" },
    });
    await world.writePlan("qa", qa);

    const result = await promote(world.deps, { target: "qa", services: world.services });

    expect(result.digest).toBe(STAGING_IMAGE);
    expect(world.github.dispatches[0]?.workflowFile).toBe("opscrew-deploy-qa.yml");
    expect(world.driftPaths.map((paths) => paths.environment)).toEqual(["qa"]);
    const qaPaths = environmentPaths(world.deps.paths, "qa");
    expect(promotionFile(qaPaths)).toContain("environments");
    expect(await recordedPromotion(qaPaths)).toMatchObject({ digest: STAGING_IMAGE });
    // Prod's state is left alone.
    expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
  });

  it("rolls back to the target's previous image the same way, with the same checks and approval", async () => {
    const world = await promoteWorld();

    const result = await promote(world.deps, {
      target: "prod",
      digest: PREVIOUS_IMAGE,
      services: world.services,
    });

    expect(result).toEqual({ status: "deployed", digest: PREVIOUS_IMAGE, runUrl: DEPLOY_RUN_URL });
    const request = world.handler.requests[0] as ApprovalRequest;
    expect(request.kind).toBe("promote");
    expect(request.title).toBe("Roll prod back to its previous image");
    expect(request.planHash).toBe(
      promotionHash({
        target: "prod",
        source: "staging",
        digest: PREVIOUS_IMAGE,
        targetPlanHash: planHash(world.prodPlan),
      }),
    );
    expect(world.github.dispatches[0]?.inputs).toEqual({
      digest: PREVIOUS_IMAGE,
      tag: `${PREVIOUS_COMMIT}-staging`,
    });
    expect(await recordedPromotion(world.deps.paths)).toMatchObject({ digest: PREVIOUS_IMAGE });
    // This computer has no record of what the previous image ran with: the approval says so.
    expect(request.details).toContain(
      "  OpsCrew has no record on this computer of what that image ran with, so it cannot check it against prod's plan: a component removed since that image ran is not brought back",
    );
  });

  describe("a rollback checked against the recorded promotion", () => {
    /** prod's record: it runs PROD_IMAGE, and before it ran PREVIOUS_IMAGE with `services`. */
    async function recorded(world: PromoteWorld, services: string[]) {
      const promotion = (digest: string, names: string[]) => ({
        digest,
        source: "staging",
        runUrl: DEPLOY_RUN_URL,
        at: "2026-10-10T12:00:00.000Z",
        services: names,
      });
      const file = promotionFile(world.deps.paths);
      await mkdir(dirname(file), { recursive: true });
      const record = {
        ...promotion(PROD_IMAGE, ["db"]),
        previous: promotion(PREVIOUS_IMAGE, services),
      };
      await writeFile(file, JSON.stringify(record));
    }

    it("records each promotion with the one it replaces", async () => {
      const world = await promoteWorld();
      await recorded(world, ["db"]);
      await promote(world.deps, { target: "prod", services: world.services });
      expect(await recordedPromotion(world.deps.paths)).toMatchObject({
        digest: STAGING_IMAGE,
        services: ["db"],
        previous: { digest: PROD_IMAGE, services: ["db"] },
      });
    });

    it("refuses when the previous image ran with a service the plan no longer has, before the check and the approval", async () => {
      const world = await promoteWorld();
      await recorded(world, ["db", "cache"]);
      const error = await failure(
        promote(world.deps, { target: "prod", digest: PREVIOUS_IMAGE, services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        "prod's previous image ran with the service cache, which prod's plan no longer has, so rolling back would run that image without it. Nothing was deployed.",
      );
      expect(error.hint).toBe(
        "Promote forward instead: once staging runs a fixed image, run `opscrew promote --to prod`.",
      );
      expect(world.driftPaths).toEqual([]);
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("checks the image of the last recorded promotion when another computer promoted since", async () => {
      // Another computer promoted prod after this one: PROD_IMAGE, this computer's last
      // promotion, is now prod's previous image.
      const world = await promoteWorld();
      const file = promotionFile(world.deps.paths);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          digest: PREVIOUS_IMAGE,
          source: "staging",
          runUrl: DEPLOY_RUN_URL,
          at: "2026-10-10T12:00:00.000Z",
          services: ["db", "cache"],
        }),
      );
      const error = await failure(
        promote(world.deps, { target: "prod", digest: PREVIOUS_IMAGE, services: world.services }),
      );
      expect(error.message).toBe(
        "prod's previous image ran with the service cache, which prod's plan no longer has, so rolling back would run that image without it. Nothing was deployed.",
      );
      expect(world.github.dispatches).toEqual([]);
    });

    it("goes ahead, without the note, when the plan still has every service it ran with", async () => {
      const world = await promoteWorld();
      await recorded(world, ["db"]);
      const result = await promote(world.deps, {
        target: "prod",
        digest: PREVIOUS_IMAGE,
        services: world.services,
      });
      expect(result.digest).toBe(PREVIOUS_IMAGE);
      expect(world.handler.requests[0]?.details).not.toContain("no record");
    });
  });

  it("accepts the source's digest given explicitly", async () => {
    const world = await promoteWorld();
    const result = await promote(world.deps, {
      target: "prod",
      digest: STAGING_IMAGE,
      services: world.services,
    });
    expect(result.digest).toBe(STAGING_IMAGE);
    expect(world.handler.requests[0]?.title).toBe("Deploy the image staging runs to prod");
  });

  it("reads GHCR with OPSCREW_GHCR_READ_TOKEN and never shows it", async () => {
    const token = fakeSecret("github-token", "ghcr-read");
    const world = await promoteWorld({ env: { OPSCREW_GHCR_READ_TOKEN: token } });
    world.github.conclusion = "failure";

    const error = await failure(promote(world.deps, { target: "prod", services: world.services }));

    // The token reached only the registry reads.
    expect(world.github.credentials.length).toBeGreaterThan(0);
    for (const credential of world.github.credentials) {
      expect(credential).toEqual({ username: "acme", token });
    }
    const shown = JSON.stringify({
      error: [error.message, error.hint],
      reporter: world.deps.reporter.lines,
      audit: world.deps.audit.entries,
      requests: world.handler.requests,
      dispatches: world.github.dispatches,
    });
    expect(shown).not.toContain(token);
    expect(world.deps.redactor.redact(`x ${token} y`)).not.toContain(token);
  });

  describe("the commit tag of the environment that built the image (T1515's live run)", () => {
    const STAGING_BUILD = digestOf("staging's build");
    const PROD_BUILD = digestOf("prod's build");

    /** prod and staging both follow main and built one commit; qa is promoted from staging, uat from prod. */
    async function twoBuilders() {
      const world = await promoteWorld({
        prod: (plan) =>
          DeployPlanSchema.parse({ ...plan, environment: { deploySource: { from: "main" } } }),
      });
      for (const [name, source] of [
        ["qa", "staging"],
        ["uat", "prod"],
      ] as const) {
        const plan = inEnvironment(world.prodPlan, name, {
          deploySource: { from: "promote", source },
        });
        await world.writePlan(name, plan);
      }
      const uat = ".github/workflows/opscrew-deploy-uat.yml";
      const text = "name: OpsCrew deploy (uat)\n# promoted from prod\n";
      await world.writeRepoFile(uat, text);
      world.github.onMain.set(uat, blobOf(text));
      // One push built the commit twice: each build has a digest and a tag of its own.
      const commit = commitOf("one push");
      world.github.build(STAGING_BUILD, { runId: 601, commit });
      world.github.build(PROD_BUILD, { runId: 602, commit, environment: "prod" });
      world.github.tags.set("opscrew-staging", STAGING_BUILD);
      world.github.tags.set("opscrew-prod", PROD_BUILD);
      return { world, commit };
    }

    it("passes for each of the two images of one commit, from staging and from prod", async () => {
      const { world, commit } = await twoBuilders();
      expect(world.github.tags.get(`${commit}-staging`)).toBe(STAGING_BUILD);
      expect(world.github.tags.get(commit)).toBe(PROD_BUILD);

      const fromStaging = await promote(world.deps, { target: "qa", services: world.services });
      const fromProd = await promote(world.deps, { target: "uat", services: world.services });

      expect([fromStaging.digest, fromProd.digest]).toEqual([STAGING_BUILD, PROD_BUILD]);
      expect(world.github.dispatches.map((d) => [d.workflowFile, d.inputs])).toEqual([
        ["opscrew-deploy-qa.yml", { digest: STAGING_BUILD, tag: `${commit}-staging` }],
        ["opscrew-deploy-uat.yml", { digest: PROD_BUILD, tag: commit }],
      ]);
    });

    it("finds the tag of the environment the source itself was promoted from", async () => {
      // dev follows main; staging is promoted from dev, and prod from staging.
      const world = await promoteWorld({
        staging: (plan) =>
          DeployPlanSchema.parse({
            ...plan,
            environment: { ...plan.environment, deploySource: { from: "promote", source: "dev" } },
          }),
      });
      await world.writePlan("dev", inEnvironment(world.prodPlan, "dev"));
      const commit = commitOf("dev");
      const built = digestOf("dev's build");
      world.github.build(built, { runId: 701, commit, environment: "dev" });
      world.github.tags.set("opscrew-staging", built);

      const result = await promote(world.deps, { target: "prod", services: world.services });

      expect(result.digest).toBe(built);
      expect(world.github.dispatches[0]?.inputs).toEqual({ digest: built, tag: `${commit}-dev` });
    });
  });

  describe("the build's branch (FR-1537)", () => {
    /** staging follows develop, and its build of the image ran on `branch`. */
    async function stagingOnDevelop(branch: string) {
      const world = await promoteWorld({
        staging: (plan) =>
          DeployPlanSchema.parse({ ...plan, cicd: { ...plan.cicd, branch: "develop" } }),
      });
      world.github.build(STAGING_IMAGE, {
        runId: STAGING_RUN,
        commit: STAGING_COMMIT,
        run: { headBranch: branch },
      });
      return world;
    }

    it("passes an image built on the branch the source environment follows, and dispatches on the default branch", async () => {
      const world = await stagingOnDevelop("develop");
      const result = await promote(world.deps, { target: "prod", services: world.services });
      expect(result.digest).toBe(STAGING_IMAGE);
      expect(world.handler.requests[0]?.details).toContain(
        `Built by: https://github.com/acme/shop/actions/runs/${STAGING_RUN}/attempts/1, from develop at ${STAGING_COMMIT}`,
      );
      // The target's workflow lives on the default branch, and runs there.
      expect(world.github.dispatches.map((d) => [d.workflowFile, d.ref])).toEqual([
        ["opscrew-deploy.yml", "main"],
      ]);
    });

    it("refuses an image built on another branch, the default one too", async () => {
      const world = await stagingOnDevelop("main");
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        "The image was built from the branch main, not from develop, the branch whose pushes build the images this environment is promoted with. Nothing was deployed.",
      );
      expect(error.hint).toBe(
        "OpsCrew promotes only images acme/shop's deploy workflow built from develop. Promote the image another environment runs, built by a push to develop.",
      );
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("checks the branch of the environment that built the image, at the start of the chain", async () => {
      // dev follows develop; staging is promoted from dev, and prod from staging.
      const world = await promoteWorld({
        staging: (plan) =>
          DeployPlanSchema.parse({
            ...plan,
            environment: { ...plan.environment, deploySource: { from: "promote", source: "dev" } },
          }),
      });
      const dev = inEnvironment(world.prodPlan, "dev");
      await world.writePlan(
        "dev",
        DeployPlanSchema.parse({ ...dev, cicd: { ...dev.cicd, branch: "develop" } }),
      );
      const commit = commitOf("dev");
      const built = digestOf("dev's build");
      world.github.build(built, {
        runId: 701,
        commit,
        environment: "dev",
        run: { headBranch: "develop" },
      });
      world.github.tags.set("opscrew-staging", built);
      expect((await promote(world.deps, { target: "prod", services: world.services })).digest).toBe(
        built,
      );

      world.github.build(built, { runId: 701, commit, environment: "dev" });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.message).toContain(
        "built from the branch main, not from develop, the branch whose pushes build the images this environment is promoted with",
      );
    });

    it("refuses a rollback to an image built on a branch the chain no longer builds from, before the approval", async () => {
      // prod's previous image was built on main by staging; now prod ← staging ← dev, dev on develop.
      const world = await promoteWorld({
        staging: (plan) =>
          DeployPlanSchema.parse({
            ...plan,
            environment: { ...plan.environment, deploySource: { from: "promote", source: "dev" } },
          }),
      });
      const dev = inEnvironment(world.prodPlan, "dev");
      await world.writePlan(
        "dev",
        DeployPlanSchema.parse({ ...dev, cicd: { ...dev.cicd, branch: "develop" } }),
      );
      const error = await failure(
        promote(world.deps, {
          target: "prod",
          digest: PREVIOUS_IMAGE,
          services: world.services,
        }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        "The image was built from the branch main, not from develop, the branch whose pushes build the images this environment is promoted with. Nothing was deployed.",
      );
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });
  });

  describe("the image's CPU (T1522)", () => {
    const ARM64 = { architecture: "arm64", os: "linux" };
    const AMD64 = { architecture: "amd64", os: "linux" };

    /** Promote stopped before the drift check, the approval and the dispatch. */
    function nothingChanged(world: PromoteWorld) {
      expect(world.driftPaths).toEqual([]);
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    }

    it("refuses an arm64 image for an amd64 target, naming both CPUs and the fix", async () => {
      const world = await promoteWorld();
      world.github.platforms.set(STAGING_IMAGE, [ARM64]);
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        `The image ghcr.io/acme/shop@${STAGING_IMAGE} is built for arm64 only, but prod runs on amd64, so it would not start there. Nothing was deployed.`,
      );
      expect(error.hint).toBe(
        "Build the image for amd64: let it be built by a source environment on an amd64 server, or by the GitHub-hosted build, then run `opscrew promote --to prod` again.",
      );
      nothingChanged(world);
    });

    it("passes a single image built for the target's CPU", async () => {
      const world = await promoteWorld();
      world.github.platforms.set(STAGING_IMAGE, [AMD64]);
      const result = await promote(world.deps, { target: "prod", services: world.services });
      expect(result.status).toBe("deployed");
    });

    it("passes an index with both CPUs", async () => {
      const world = await promoteWorld();
      world.github.platforms.set(STAGING_IMAGE, [ARM64, AMD64]);
      const result = await promote(world.deps, { target: "prod", services: world.services });
      expect(result.status).toBe("deployed");
    });

    it("stops when GHCR shows no platforms, never guessing the CPU", async () => {
      const world = await promoteWorld();
      world.github.platforms.delete(STAGING_IMAGE);
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        `GitHub Container Registry names no CPU for the image ghcr.io/acme/shop@${STAGING_IMAGE}, so OpsCrew cannot tell whether it runs on prod's amd64. Nothing was deployed.`,
      );
      nothingChanged(world);
    });

    it("checks a rollback's image the same way", async () => {
      const world = await promoteWorld();
      world.github.platforms.set(PREVIOUS_IMAGE, [ARM64]);
      const error = await failure(
        promote(world.deps, { target: "prod", digest: PREVIOUS_IMAGE, services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("is built for arm64 only, but prod runs on amd64");
      nothingChanged(world);
    });
  });

  describe("the approval", () => {
    it("is never granted by --yes: the kinds --yes grants cannot deploy", async () => {
      const world = await promoteWorld({
        approve: (request) => YES_KINDS.includes(request.kind),
      });

      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );

      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.message).toContain("Nothing was deployed");
      expect(error.hint).toContain("opscrew promote --to prod");
      expect(error.hint).toContain("--approve");
      expect(world.handler.requests.map((request) => request.kind)).toEqual(["promote"]);
      expect(world.github.dispatches).toEqual([]);
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
    });

    it("changes with each of its four parts", () => {
      const parts = {
        target: "prod",
        source: "staging",
        digest: STAGING_IMAGE,
        targetPlanHash: "a".repeat(64),
      };
      const hash = promotionHash(parts);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(sha256Hex(canonicalJson(parts)));
      const changed = [
        { ...parts, target: "qa" },
        { ...parts, source: "dev" },
        { ...parts, digest: PREVIOUS_IMAGE },
        { ...parts, targetPlanHash: "b".repeat(64) },
      ].map(promotionHash);
      expect(new Set([hash, ...changed]).size).toBe(5);
    });

    it("needs a new approval when the source's image moved since the review", async () => {
      const world = await promoteWorld();
      const reviewed = promotionHash({
        target: "prod",
        source: "staging",
        digest: STAGING_IMAGE,
        targetPlanHash: planHash(world.prodPlan),
      });
      const newer = digestOf("staging-2");
      world.github.build(newer, { runId: 502, commit: commitOf("staging-2") });
      world.github.tags.set("opscrew-staging", newer);

      const error = await failure(
        promote(world.deps, { target: "prod", approveHash: reviewed, services: world.services }),
      );

      expect(error.code).toBe("PLAN_NOT_APPROVED");
      expect(error.message).toContain(reviewed);
      expect(error.message).toContain("Nothing was deployed");
      const now = promotionHash({
        target: "prod",
        source: "staging",
        digest: newer,
        targetPlanHash: planHash(world.prodPlan),
      });
      expect(error.hint).toContain(`--approve ${now}`);
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("needs a new approval when the target's plan changed since the review", async () => {
      const world = await promoteWorld();
      const reviewed = promotionHash({
        target: "prod",
        source: "staging",
        digest: STAGING_IMAGE,
        targetPlanHash: planHash(world.prodPlan),
      });
      await world.writePlan(
        "prod",
        DeployPlanSchema.parse({
          ...world.prodPlan,
          app: { ...world.prodPlan.app, maxBodyMb: 50 },
        }),
      );

      const error = await failure(
        promote(world.deps, { target: "prod", approveHash: reviewed, services: world.services }),
      );

      expect(error.code).toBe("PLAN_NOT_APPROVED");
      expect(world.github.dispatches).toEqual([]);
    });

    it("goes ahead with --approve naming this promotion's hash", async () => {
      const world = await promoteWorld();
      const hash = promotionHash({
        target: "prod",
        source: "staging",
        digest: STAGING_IMAGE,
        targetPlanHash: planHash(world.prodPlan),
      });
      const result = await promote(world.deps, {
        target: "prod",
        approveHash: hash.toUpperCase(),
        services: world.services,
      });
      expect(result.digest).toBe(STAGING_IMAGE);
      expect(world.github.dispatches).toHaveLength(1);
      expect(world.handler.requests[0]?.planHash).toBe(hash);
    });
  });

  describe("the workflow on the default branch", () => {
    it("goes ahead when main's blob is the generated file's, whatever the working tree's line endings", async () => {
      const world = await promoteWorld();
      await world.writeRepoFile(
        PROD_WORKFLOW,
        (WORKFLOWS[PROD_WORKFLOW] as string).replaceAll("\n", "\r\n"),
      );
      await promote(world.deps, { target: "prod", services: world.services });
      expect(world.github.dispatches).toHaveLength(1);
    });

    it("compares git's blob hash (sha1 of `blob <bytes>\\0` and the text)", async () => {
      const world = await promoteWorld();
      await world.writeRepoFile(PROD_WORKFLOW, "hello\n");
      // `git hash-object` of "hello\n".
      world.github.onMain.set(PROD_WORKFLOW, "ce013625030ba8dba906f756967f9e9ca394464a");
      expect(blobOf("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
      await promote(world.deps, { target: "prod", services: world.services });
      expect(world.github.dispatches).toHaveLength(1);
    });

    it("refuses a workflow missing on main, before any approval", async () => {
      const world = await promoteWorld();
      world.github.onMain.delete(PROD_WORKFLOW);
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(`The default branch main has no ${PROD_WORKFLOW}`);
      expect(error.message).toContain("Nothing was deployed");
      expect(error.hint).toContain("Merge the deploy-setup pull request");
      expect(error.hint).toContain("opscrew provision --env prod");
      expect(error.hint).toContain("opscrew promote --to prod");
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("refuses main's workflow when it is not the one the plan generates, before any approval", async () => {
      // For example, signing turned on with the deploy-setup pull request still open: main's old
      // workflow would not check the signature the approval names.
      const world = await promoteWorld();
      world.github.onMain.set(PROD_WORKFLOW, blobOf("name: OpsCrew deploy\n# an older one\n"));
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(
        `The deploy workflow on the default branch main (${PROD_WORKFLOW}) is not the one prod's plan generates`,
      );
      expect(error.hint).toContain("Merge the deploy-setup pull request");
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });
  });

  describe("refuses, in plain English with the next step", () => {
    it("a target deployed from main", async () => {
      const world = await promoteWorld();
      const error = await failure(
        promote(world.deps, { target: "staging", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("deployed from main");
      expect(error.hint).toContain("opscrew env set staging --from");
      expect(world.github.dispatches).toEqual([]);
    });

    it("an unknown environment, with the list", async () => {
      const world = await promoteWorld();
      const error = await failure(promote(world.deps, { target: "qa", services: world.services }));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain('"staging"');
    });

    it("a digest that is not one", async () => {
      const world = await promoteWorld();
      const error = await failure(
        promote(world.deps, { target: "prod", digest: "latest", services: world.services }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(world.handler.requests).toEqual([]);
    });

    it("a target that is not provisioned", async () => {
      const world = await promoteWorld({
        prod: (plan) => DeployPlanSchema.parse({ ...plan, deployment: {} }),
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.hint).toContain("opscrew provision --env prod");
      expect(world.github.dispatches).toEqual([]);
    });

    it("a source that is not deployed", async () => {
      const world = await promoteWorld({
        staging: (plan) =>
          DeployPlanSchema.parse({
            ...plan,
            deployment: { ...plan.deployment, destroyedAt: "2026-10-11T11:30:00.000Z" },
          }),
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("staging environment is not deployed");
      expect(error.message).toContain("Nothing was deployed");
      expect(world.handler.requests).toEqual([]);
    });

    it("a source without a labelled image", async () => {
      const world = await promoteWorld();
      world.github.tags.delete("opscrew-staging");
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("opscrew-staging");
      expect(world.handler.requests).toEqual([]);
    });

    it("a digest that is neither the source's nor the target's previous one", async () => {
      const world = await promoteWorld();
      for (const digest of [PROD_IMAGE, digestOf("elsewhere")]) {
        const error = await failure(
          promote(world.deps, { target: "prod", digest, services: world.services }),
        );
        expect(error.code).toBe("PHASE_PRECONDITION");
        expect(error.message).toContain(digest);
        expect(error.message).toContain(STAGING_IMAGE);
        expect(error.message).toContain(PREVIOUS_IMAGE);
        expect(error.hint).toContain(`--digest ${PREVIOUS_IMAGE}`);
      }
      expect(world.handler.requests).toEqual([]);
    });

    it("an image without build provenance", async () => {
      const world = await promoteWorld();
      world.github.provenance.delete(STAGING_IMAGE);
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("no SLSA build provenance");
      expect(world.handler.requests).toEqual([]);
    });

    it("an image another repository built", async () => {
      const world = await promoteWorld();
      world.github.provenance.set(STAGING_IMAGE, {
        builderId: "https://github.com/mallory/shop/actions/runs/9/attempts/1",
        runId: 9,
        repository: "mallory/shop",
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("a run of mallory/shop, not of acme/shop");
      expect(world.handler.requests).toEqual([]);
    });

    it("an image built outside GitHub Actions, without printing its builder", async () => {
      const world = await promoteWorld();
      const builder = "https://ci.example.com/job/1?note=anything-at-all";
      world.github.provenance.set(STAGING_IMAGE, { builderId: builder });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("was not built by a GitHub Actions run of acme/shop");
      expect(`${error.message} ${error.hint}`).not.toContain("ci.example.com");
      expect(JSON.stringify(world.deps.reporter.lines)).not.toContain("ci.example.com");
    });

    it("an image whose build run GitHub does not show", async () => {
      const world = await promoteWorld();
      world.github.runs.delete(STAGING_RUN);
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(`no run ${STAGING_RUN}`);
    });

    it("an image a run other than a push built, such as a pull request's", async () => {
      const world = await promoteWorld();
      world.github.build(STAGING_IMAGE, {
        runId: STAGING_RUN,
        commit: STAGING_COMMIT,
        run: { event: "pull_request" },
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(
        "The image was built by a pull_request run, not by a push to main.",
      );
      expect(world.handler.requests).toEqual([]);
    });

    it("an image built from a fork's commits, with its branch named like the default one", async () => {
      const world = await promoteWorld();
      world.github.build(STAGING_IMAGE, {
        runId: STAGING_RUN,
        commit: STAGING_COMMIT,
        run: { headRepository: "mallory/shop" },
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("built from the commits of mallory/shop, not of acme/shop");
      expect(world.handler.requests).toEqual([]);
    });

    it("compares the head repository without case", async () => {
      const world = await promoteWorld();
      world.github.build(STAGING_IMAGE, {
        runId: STAGING_RUN,
        commit: STAGING_COMMIT,
        run: { headRepository: "Acme/Shop" },
      });
      await promote(world.deps, { target: "prod", services: world.services });
      expect(world.github.dispatches).toHaveLength(1);
    });

    it("an image built from another branch", async () => {
      const world = await promoteWorld();
      world.github.build(STAGING_IMAGE, {
        runId: STAGING_RUN,
        commit: STAGING_COMMIT,
        run: { headBranch: "feature" },
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(
        "The image was built from the branch feature, not from main, the branch whose pushes build the images this environment is promoted with.",
      );
      expect(world.handler.requests).toEqual([]);
    });

    it("an image that is not the one tagged with its build's commit", async () => {
      const world = await promoteWorld();
      world.github.tags.set(`${STAGING_COMMIT}-staging`, digestOf("rebuilt"));
      // prod's form of the commit names another image too.
      world.github.tags.set(STAGING_COMMIT, digestOf("prod's build"));
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(
        `The image is not the one tagged with its build's commit (${STAGING_COMMIT}, or ${STAGING_COMMIT}-<environment> for an environment other than prod)`,
      );
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("a target not ready for the source's image, naming each difference, before the check and the approval", async () => {
      const world = await promoteWorld({
        prod: (plan) =>
          DeployPlanSchema.parse({
            ...plan,
            app: { ...plan.app, port: 8080, healthPath: "/healthz" },
            services: [],
          }),
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        "The prod environment is not ready for the image staging runs: its plan differs from staging's in what every environment shares: services.db (missing), app.port and app.healthPath. Nothing was deployed.",
      );
      expect(error.hint).toBe(
        "Run `opscrew design --env prod`, then `opscrew provision --env prod`, then `opscrew promote --to prod` again.",
      );
      expect(world.driftPaths).toEqual([]);
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);

      // A rollback deploys the target's own previous image, which ran with its plan: not checked.
      const rollback = await promote(world.deps, {
        target: "prod",
        digest: PREVIOUS_IMAGE,
        services: world.services,
      });
      expect(rollback.digest).toBe(PREVIOUS_IMAGE);
    });

    it("pending infrastructure changes in the target", async () => {
      const world = await promoteWorld();
      world.drift.report = cleanDrift({
        clean: false,
        pending: [
          {
            address: "module.server.hcloud_server.this",
            type: "hcloud_server",
            name: "this",
            provider: "registry.opentofu.org/hetznercloud/hcloud",
            action: "update",
          },
        ],
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("module.server.hcloud_server.this (update)");
      expect(error.hint).toContain("opscrew provision --env prod");
      expect(world.handler.requests).toEqual([]);
      expect(world.github.dispatches).toEqual([]);
    });

    it("generated files that differ from the target's plan, or are missing", async () => {
      const world = await promoteWorld();
      world.drift.report = cleanDrift({
        clean: false,
        files: {
          changed: ["opscrew/infra/prod/terraform.tfvars"],
          created: ["opscrew/runtime/redis.conf"],
        },
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(
        "opscrew/infra/prod/terraform.tfvars (generated file changed)",
      );
      expect(error.message).toContain("opscrew/runtime/redis.conf (generated file missing)");
      expect(error.hint).toContain("opscrew provision --env prod");
      expect(world.handler.requests).toEqual([]);
    });

    it("the server's differences provision puts back, and OpsCrew's Cloudflare rules", async () => {
      const world = await promoteWorld();
      world.drift.report = cleanDrift({
        clean: false,
        host: {
          differences: [
            {
              area: "sshd",
              title: "SSH settings",
              detail: "Password logins are on again.",
              restoredByProvision: true,
            },
            {
              area: "app",
              title: "The app's containers",
              detail: "The web container is stopped.",
              restoredByProvision: false,
            },
          ],
        },
        cloudflareRules: [
          {
            title: "OpsCrew's WAF rule no longer lists shop.example.com",
            detail: "Run opscrew provision.",
          },
        ],
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("SSH settings (on the server)");
      expect(error.message).toContain("OpsCrew's WAF rule no longer lists shop.example.com");
      // What the deploy itself puts back is no reason to stop.
      expect(error.message).not.toContain("The app's containers");
      expect(world.github.dispatches).toEqual([]);
    });

    it("the target's Portainer differences, but not its deploy branch", async () => {
      const world = await promoteWorld();
      world.drift.report = cleanDrift({
        clean: false,
        provider: "portainer",
        portainer: {
          environment: "local",
          differences: [
            { area: "deploy-branch", title: "The deploy branch was changed by hand" },
            { area: "stack", title: "Update the stack opscrew-shop" },
            { area: "portainer", title: "Your Portainer environment runs on arm64" },
          ],
        },
      });
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("Update the stack opscrew-shop");
      expect(error.message).toContain("Your Portainer environment runs on arm64");
      expect(error.message).not.toContain("deploy branch");
      expect(world.github.dispatches).toEqual([]);

      // The deploy branch alone is rewritten by the deploy workflow itself.
      world.drift.report = cleanDrift({
        clean: false,
        provider: "portainer",
        portainer: {
          environment: "local",
          differences: [{ area: "deploy-branch", title: "The deploy branch was changed by hand" }],
        },
      });
      await promote(world.deps, { target: "prod", services: world.services });
      expect(world.github.dispatches).toHaveLength(1);
    });

    it("by default checks the target with drift, through the target's own paths", async () => {
      // The deps are staging's; prod's drift needs prod's state, which this computer lacks.
      const world = await promoteWorld({ environment: "staging" });
      const { drift: _drift, ...services } = world.services;
      const error = await failure(promote(world.deps, { target: "prod", services }));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(".opscrew/tfstate/prod.tfstate");
      expect(world.github.dispatches).toEqual([]);
    });

    it("a dispatch GitHub refuses as a missing or not promoted workflow (404 or 422)", async () => {
      const world = await promoteWorld();
      // The connector's answer to GitHub's 404 or 422.
      world.github.dispatchError = new OpsCrewError(
        "PHASE_PRECONDITION",
        'GitHub cannot start the workflow opscrew-deploy.yml on main: Unexpected inputs provided: ["digest"].',
      );
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("Unexpected inputs provided");
      expect(error.message).toContain("Nothing was deployed");
      expect(error.hint).toContain("default branch main");
      expect(error.hint).toContain("opscrew provision --env prod");
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
    });

    it("a dispatch with a token GitHub refused, keeping its hint", async () => {
      const world = await promoteWorld();
      world.github.dispatchError = new OpsCrewError(
        "CREDENTIALS_INVALID",
        "GitHub rejected the token while trying to start the workflow opscrew-deploy.yml on main.",
        { hint: "Create a new token." },
      );
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.message).toContain("Nothing was deployed");
      expect(error.hint).toBe("Create a new token. Then run `opscrew promote --to prod` again.");
    });
  });

  describe("with a required reviewer in GitHub", () => {
    it("says in the approval that GitHub's review is the real gate", async () => {
      const world = await promoteWorld({
        prod: (plan) =>
          DeployPlanSchema.parse({
            ...plan,
            environment: { ...plan.environment, secrets: "environment" },
          }),
      });
      world.github.environments.set("production", {
        name: "production",
        waitTimer: 0,
        preventSelfReview: false,
        reviewers: [{ type: "User", id: 1001 }],
        branchPolicy: { protectedBranches: false, customBranchPolicies: true },
        canAdminsBypass: true,
      });

      await promote(world.deps, { target: "prod", services: world.services });

      const details = world.handler.requests[0]?.details ?? "";
      expect(details).toContain(
        "GitHub also asks a required reviewer of the GitHub environment production before the deploy job runs: that review is the real gate. OpsCrew's approval guards against mistakes.",
      );
      expect(details).not.toContain("not against someone with write access");
    });

    it("says the run waits for the reviewer, with its link, and records the image once it succeeded", async () => {
      const world = await promoteWorld();
      world.github.reviewer = "approves";

      const result = await promote(world.deps, { target: "prod", services: world.services });

      expect(result).toEqual({ status: "deployed", digest: STAGING_IMAGE, runUrl: DEPLOY_RUN_URL });
      expect(world.deps.reporter.text()).toContain(
        `prod's deploy run waits in GitHub for a required reviewer: approve it at ${DEPLOY_RUN_URL}.`,
      );
      expect(await recordedPromotion(world.deps.paths)).toMatchObject({ digest: STAGING_IMAGE });
    });

    it("reports a run still waiting for its reviewer as waiting, never as a failure, and records nothing", async () => {
      const world = await promoteWorld();
      world.github.reviewer = "pending";

      const result = await promote(world.deps, { target: "prod", services: world.services });

      expect(result).toEqual({ status: "waiting", digest: STAGING_IMAGE, runUrl: DEPLOY_RUN_URL });
      const text = world.deps.reporter.text();
      expect(text).toContain(STILL_WAITING);
      expect(text).not.toMatch(/did not succeed|did not finish|timed out/);
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
      expect(await readPendingPromotion(world.deps.paths)).toEqual({
        digest: STAGING_IMAGE,
        source: "staging",
        runId: 777,
        at: "2026-10-11T12:00:00.000Z",
      });
      expect(
        world.deps.audit.entries.find((entry) => entry.action === "deploy workflow")?.detail,
      ).toBe("workflow run 777 waits for a required reviewer");
    });

    /** A promotion to prod left waiting for its reviewer, then a fresh run's deps. */
    async function leftWaiting() {
      const world = await promoteWorld();
      world.github.reviewer = "pending";
      await promote(world.deps, { target: "prod", services: world.services });
      world.deps.reporter.lines.length = 0;
      world.handler.requests.length = 0;
      return world;
    }

    it("records the pending promotion once its run succeeded, with no new dispatch", async () => {
      const world = await leftWaiting();
      world.github.reviewer = "approves";

      const result = await promote(world.deps, { target: "prod", services: world.services });

      expect(result).toEqual({ status: "deployed", digest: STAGING_IMAGE, runUrl: DEPLOY_RUN_URL });
      expect(world.github.reads).toEqual([777]);
      expect(world.github.dispatches).toHaveLength(1);
      expect(world.handler.requests).toEqual([]);
      expect(await recordedPromotion(world.deps.paths)).toMatchObject({
        digest: STAGING_IMAGE,
        source: "staging",
        runUrl: DEPLOY_RUN_URL,
      });
      expect(await readPendingPromotion(world.deps.paths)).toBeUndefined();
    });

    it("says again that the pending run waits, with its link and the command", async () => {
      const world = await leftWaiting();

      const result = await promote(world.deps, { target: "prod", services: world.services });

      expect(result).toEqual({ status: "waiting", digest: STAGING_IMAGE, runUrl: DEPLOY_RUN_URL });
      expect(world.deps.reporter.text()).toContain(STILL_WAITING);
      expect(world.github.dispatches).toHaveLength(1);
      expect(await readPendingPromotion(world.deps.paths)).toMatchObject({ runId: 777 });
    });

    it("forgets a pending run that was cancelled, and lets a new promotion go ahead", async () => {
      const world = await leftWaiting();
      world.github.reviewer = "none";
      world.github.reread = { status: "completed", conclusion: "cancelled" };

      const result = await promote(world.deps, { target: "prod", services: world.services });

      expect(world.deps.reporter.text()).toContain(
        `prod's deploy run that waited for a reviewer did not succeed (cancelled): ${DEPLOY_RUN_URL}. OpsCrew forgot it and goes on with a new promotion.`,
      );
      expect(world.handler.requests.map((r) => r.kind)).toEqual(["promote"]);
      expect(world.github.dispatches).toHaveLength(2);
      expect(result.status).toBe("deployed");
      expect(await readPendingPromotion(world.deps.paths)).toBeUndefined();
    });
  });

  describe("when the run may have started", () => {
    const ACTIONS = "https://github.com/acme/shop/actions";

    it("says so, with the Actions link, when the dispatch's answer was lost", async () => {
      const world = await promoteWorld();
      world.github.dispatchError = new OpsCrewError(
        "PROVIDER_ERROR",
        "GitHub did not answer within 30 seconds when trying to start the workflow opscrew-deploy.yml on main.",
      );
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).not.toContain("Nothing was deployed");
      expect(error.message).toContain("The run may have started");
      expect(error.hint).toContain(ACTIONS);
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
    });

    it("says so after GitHub accepted the dispatch and the run could not be found", async () => {
      const world = await promoteWorld();
      world.github.afterAcceptedError = new OpsCrewError(
        "PROVIDER_ERROR",
        `GitHub accepted the dispatch of opscrew-deploy.yml on main but showed no run of it within 2 minutes; look in ${ACTIONS}.`,
      );
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.message).not.toContain("Nothing was deployed");
      expect(error.message).toContain("GitHub accepted the start of prod's deploy workflow");
      expect(error.message).toContain("The run may have started");
      expect(error.hint).toContain(ACTIONS);
      expect(dispatchAudited(world)).toBe(true);
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
    });

    it("says so when the wait for the run timed out", async () => {
      const world = await promoteWorld();
      world.github.waitError = new OpsCrewError(
        "PROVIDER_ERROR",
        "The opscrew-deploy.yml run on main did not finish within 30 minutes.",
        {
          hint: `Follow it at ${DEPLOY_RUN_URL}, then run the command again once it has finished.`,
        },
      );
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).not.toContain("Nothing was deployed");
      expect(error.message).toContain("did not finish within 30 minutes");
      expect(error.message).toContain("The run may still deploy the image");
      expect(error.hint).toContain(DEPLOY_RUN_URL);
      expect(dispatchAudited(world)).toBe(true);
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
    });

    it("names the checks of a signed image when the deploy run failed", async () => {
      const world = await promoteWorld({
        prod: (plan) =>
          DeployPlanSchema.parse({ ...plan, supplyChain: { ...plan.supplyChain, sign: true } }),
        staging: (plan) =>
          DeployPlanSchema.parse({ ...plan, supplyChain: { ...plan.supplyChain, sign: true } }),
      });
      world.github.conclusion = "failure";

      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );

      expect(world.handler.requests[0]?.details).toContain("cosign signature");
      expect(error.code).toBe("COMMAND_FAILED");
      expect(error.message).toContain(DEPLOY_RUN_URL);
      expect(error.message).toContain("signature");
      expect(error.message).not.toContain("Nothing was deployed");
      expect(dispatchAudited(world)).toBe(true);
      expect(await recordedPromotion(world.deps.paths)).toBeUndefined();
    });
  });
});
