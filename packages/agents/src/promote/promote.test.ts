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
import { promotionFile } from "./record";

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

    expect(result).toEqual({ digest: STAGING_IMAGE, runUrl: DEPLOY_RUN_URL });
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
    // The dispatch: prod's own workflow on the default branch, with the digest; nothing rebuilt.
    expect(github.dispatches).toEqual([
      { workflowFile: "opscrew-deploy.yml", ref: "main", inputs: { digest: STAGING_IMAGE } },
    ]);
    // The drift check ran with the target's paths.
    expect(world.driftPaths.map((paths) => paths.environment)).toEqual(["prod"]);
    // The digest is recorded in the target's state.
    expect(promotionFile(deps.paths).replaceAll("\\", "/")).toMatch(
      /\/\.opscrew\/promotion\.json$/,
    );
    expect(await recordedPromotion(deps.paths)).toEqual({
      digest: STAGING_IMAGE,
      source: "staging",
      runUrl: DEPLOY_RUN_URL,
      at: "2026-10-11T12:00:00.000Z",
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

    expect(result).toEqual({ digest: PREVIOUS_IMAGE, runUrl: DEPLOY_RUN_URL });
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
    expect(world.github.dispatches[0]?.inputs).toEqual({ digest: PREVIOUS_IMAGE });
    expect(await recordedPromotion(world.deps.paths)).toMatchObject({ digest: PREVIOUS_IMAGE });
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
          app: { ...world.prodPlan.app, healthPath: "/healthz" },
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
      expect(error.message).toContain("built by a pull_request run, not by a push to main");
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
      expect(error.message).toContain("from the branch feature, not from the default branch main");
      expect(world.handler.requests).toEqual([]);
    });

    it("an image that is not the one tagged with its build's commit", async () => {
      const world = await promoteWorld();
      world.github.tags.set(STAGING_COMMIT, digestOf("rebuilt"));
      const error = await failure(
        promote(world.deps, { target: "prod", services: world.services }),
      );
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain(STAGING_COMMIT);
      expect(world.handler.requests).toEqual([]);
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
