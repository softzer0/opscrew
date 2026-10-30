import { OpsCrewError } from "@opscrew/core";
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  type PlanService,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type RunDesignOptions, runDesign } from "../design/run";
import { selfHostedServices } from "../design/sizing";
import { promote } from "../promote";
import {
  blobOf,
  cleanDrift,
  commitOf,
  digestOf,
  inEnvironment,
  type PromoteWorld,
  type PromoteWorldOptions,
  promoteWorld,
} from "../promote/__fixtures__/world";
import {
  createTestPhaseDeps,
  euCatalog,
  forbiddenFetch,
  makeRequirements,
  nextPostgresFacts,
  ownPlan,
  ScriptedRunner,
  type TestPhaseDepsOptions,
} from "../testing";
import { addEnvironment } from "./add";
import { environmentPaths } from "./paths";
import { requireSharedParts, sharedPartsDiffer } from "./shared-parts";

const DB_ONLY = selfHostedServices({ postgres: true, redis: false });
const WITH_CACHE = selfHostedServices({ postgres: true, redis: true });

/** The image dev runs now: built by dev's workflow on a push to main. */
const DEV_IMAGE = digestOf("dev");

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const names = (plan: DeployPlan) => plan.services.map((service) => service.name);

/**
 * The promote world with the app's analysis and answers, so each environment can be designed;
 * `design(name)` runs `opscrew design --env <name>` there.
 */
async function designable(options: PromoteWorldOptions) {
  const world = await promoteWorld(options);
  const { paths } = world.deps;
  await writeArtifact("architecture", paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-11T09:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: nextPostgresFacts({ name: "shop", git: { defaultBranch: "main" } }),
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact("requirements", paths.files.requirements, makeRequirements());
  const design = async (
    name: string,
    options: RunDesignOptions = {},
    services: Pick<TestPhaseDepsOptions, "env" | "runner" | "fetch"> = {},
  ) => {
    const deps = await createTestPhaseDeps({ root: paths.root, environment: name, ...services });
    const result = await runDesign(deps, { catalog: euCatalog(), ...options });
    return { ...result, said: deps.reporter.text() };
  };
  const planOf = (name: string) => readArtifact("plan", environmentPaths(paths, name).files.plan);
  return { world, design, planOf };
}

/**
 * Promotion first: dev (built and deployed on each push to main) → staging → prod, all deployed,
 * with these services, each promoted environment's workflow merged on main, and dev's newest image
 * labelled `opscrew-dev`; staging and prod run older images.
 */
async function promotionFirst(services: Record<"dev" | "staging" | "prod", PlanService[]>) {
  const app = await designable({
    staging: (plan) =>
      DeployPlanSchema.parse({
        ...plan,
        environment: { ...plan.environment, deploySource: { from: "promote", source: "dev" } },
        services: services.staging,
      }),
    prod: (plan) => DeployPlanSchema.parse({ ...plan, services: services.prod }),
  });
  const { world } = app;
  const dev = inEnvironment(world.prodPlan, "dev");
  await world.writePlan("dev", DeployPlanSchema.parse({ ...dev, services: services.dev }));
  const workflow = ".github/workflows/opscrew-deploy-staging.yml";
  const text = "name: OpsCrew deploy (staging)\n# promoted from dev\n";
  await world.writeRepoFile(workflow, text);
  world.github.onMain.set(workflow, blobOf(text));
  world.github.build(DEV_IMAGE, { runId: 701, commit: commitOf("dev"), environment: "dev" });
  world.github.tags.set("opscrew-dev", DEV_IMAGE);
  return app;
}

const promoteTo = (world: PromoteWorld, target: string) =>
  promote(world.deps, { target, services: world.services });

/** GHCR's labels in the promote world, as design reads them. */
const labelsOf = (world: PromoteWorld): Pick<RunDesignOptions, "registry"> => ({
  registry: { taggedDigest: async (tag) => world.github.tags.get(tag) },
});

describe("the shared parts follow the image (FR-1539)", () => {
  it("adds a service where the code first runs: staging and prod are refused until their design and provision", async () => {
    // dev gained Redis; staging and prod have none.
    const { world, design, planOf } = await promotionFirst({
      dev: WITH_CACHE,
      staging: DB_ONLY,
      prod: DB_ONLY,
    });

    const refused = await failure(promoteTo(world, "staging"));
    expect(refused.code).toBe("PHASE_PRECONDITION");
    expect(refused.message).toBe(
      "The staging environment is not ready for the image dev runs: its plan differs from dev's in what every environment shares: services.cache (missing). Nothing was deployed.",
    );
    expect(refused.hint).toBe(
      "Run `opscrew design --env staging`, then `opscrew provision --env staging`, then `opscrew promote --to staging` again.",
    );
    expect(world.handler.requests).toEqual([]);
    expect(world.github.dispatches).toEqual([]);

    // staging's design copies dev's services, not prod's; its plan then waits for provision.
    await design("staging");
    expect(names(await planOf("staging"))).toEqual(["db", "cache"]);
    world.drift.report = cleanDrift({
      clean: false,
      pending: [
        {
          address: 'module.app.terraform_data.service["cache"]',
          type: "terraform_data",
          name: "service",
          provider: "terraform.io/builtin/terraform",
          action: "create",
        },
      ],
    });
    expect((await failure(promoteTo(world, "staging"))).hint).toBe(
      "Run `opscrew provision --env staging` first, then `opscrew promote --to staging` again.",
    );
    // Provisioned, staging is ready for dev's image.
    world.drift.report = cleanDrift();
    expect((await promoteTo(world, "staging")).digest).toBe(DEV_IMAGE);
    // After the healthy deploy, staging's workflow labels the image it runs.
    world.github.tags.set("opscrew-staging", DEV_IMAGE);

    // prod is refused the same way, compared with staging, until its own design and provision.
    const prod = await failure(promoteTo(world, "prod"));
    expect(prod.message).toBe(
      "The prod environment is not ready for the image staging runs: its plan differs from staging's in what every environment shares: services.cache (missing). Nothing was deployed.",
    );
    expect(prod.hint).toBe(
      "Run `opscrew design --env prod`, then `opscrew provision --env prod`, then `opscrew promote --to prod` again.",
    );
    expect(world.github.dispatches).toHaveLength(1);
    await design("prod");
    expect(names(await planOf("prod"))).toEqual(["db", "cache"]);
    expect((await promoteTo(world, "prod")).digest).toBe(DEV_IMAGE);
  });

  it("keeps a service dev dropped in staging until staging runs dev's image, then its design removes it", async () => {
    // dev dropped its cache; staging and prod still run images that use it.
    const { world, design } = await promotionFirst({
      dev: DB_ONLY,
      staging: WITH_CACHE,
      prod: WITH_CACHE,
    });
    const labels = labelsOf(world);

    const kept = await design("staging", labels);
    expect(names(kept.plan)).toEqual(["db", "cache"]);
    expect(kept.warnings).toContain(
      "The staging environment keeps the service cache, which dev's plan no longer has: staging does not run dev's image yet, and the image it runs may still use it. Once `opscrew promote --to staging` has deployed dev's image, the next `opscrew design --env staging` removes it.",
    );
    // Provision's preflight and promote's readiness both allow the extra service.
    await requireSharedParts(environmentPaths(world.deps.paths, "staging"), kept.plan);
    expect((await promoteTo(world, "staging")).digest).toBe(DEV_IMAGE);
    world.github.tags.set("opscrew-staging", DEV_IMAGE);

    const removed = await design("staging", labels);
    expect(names(removed.plan)).toEqual(["db"]);
    expect(removed.warnings.join("\n")).not.toContain("keeps the service");
    expect(removed.said).toContain(
      "The staging environment runs dev's image now, so its plan drops the service cache, as dev's did. `opscrew provision --env staging` removes it, asking as usual before any data is deleted.",
    );

    // prod, which still runs an older image, keeps it on its design.
    const prod = await design("prod", labels);
    expect(names(prod.plan)).toEqual(["db", "cache"]);
    expect(prod.warnings).toContain(
      "The prod environment keeps the service cache, which staging's plan no longer has: prod does not run staging's image yet, and the image it runs may still use it. Once `opscrew promote --to prod` has deployed staging's image, the next `opscrew design --env prod` removes it.",
    );
  });

  describe("keeps the service when it cannot tell which image the environment runs", () => {
    const kept = (reason: string) =>
      `The staging environment keeps the service cache, which dev's plan no longer has: OpsCrew cannot tell whether staging runs dev's image yet (${reason}), and the image it runs may still use it. Once \`opscrew promote --to staging\` has deployed dev's image, the next \`opscrew design --env staging\` removes it.`;
    /** git in a clone of acme/shop, with these variables and GitHub's answers. */
    const github = (env: Record<string, string | undefined>, fetch = forbiddenFetch) => ({
      env,
      fetch,
      runner: new ScriptedRunner((_command, args) => {
        if (args.includes("--is-inside-work-tree")) {
          return { exitCode: 0, stdout: "true\n", stderr: "" };
        }
        if (args.includes("get-url")) {
          return { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "not scripted" };
      }),
    });

    it("without a GitHub token", async () => {
      const { world, design } = await promotionFirst({
        dev: DB_ONLY,
        staging: WITH_CACHE,
        prod: WITH_CACHE,
      });
      const result = await design("staging", {}, github({ ...world.deps.env }));
      expect(names(result.plan)).toEqual(["db", "cache"]);
      expect(result.warnings).toContain(
        kept(
          "OpsCrew reads the app's image from GitHub Container Registry with your GitHub token, and none is set",
        ),
      );
    });

    it("when GHCR refuses the token (403)", async () => {
      const { world, design } = await promotionFirst({
        dev: DB_ONLY,
        staging: WITH_CACHE,
        prod: WITH_CACHE,
      });
      const ghcr = fakeFetch({ "GET https://ghcr.io/token": { status: 403, body: {} } });
      const env = {
        ...world.deps.env,
        GITHUB_TOKEN: fakeSecret("github-token"),
        OPSCREW_GHCR_READ_TOKEN: fakeSecret("github-token", "ghcr"),
      };
      const result = await design("staging", {}, github(env, ghcr.fetch));
      expect(names(result.plan)).toEqual(["db", "cache"]);
      expect(result.warnings).toContain(
        kept("GHCR refused to read ghcr.io/acme/shop:opscrew-staging"),
      );
      expect(ghcr.calls.map((call) => call.url)).toEqual([
        expect.stringMatching(/^https:\/\/ghcr\.io\/token\?/),
      ]);
    });
  });

  it("names the source when a promoted environment's source has no plan yet", async () => {
    const { design } = await designable({
      staging: (plan) =>
        DeployPlanSchema.parse({
          ...plan,
          environment: { ...plan.environment, deploySource: { from: "promote", source: "dev" } },
        }),
    });
    const error = await failure(design("staging"));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The staging environment is promoted from dev, so it takes what every environment shares (the build, the components, the port) from dev's plan, and opscrew/environments/dev/plan.yaml does not exist yet. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Run `opscrew design --env dev` first, then `opscrew design --env staging`.",
    );
  });

  it("takes the shared parts of a dev on this computer that runs prod's image from prod's plan", async () => {
    const { world, design } = await designable({
      prod: (plan) =>
        DeployPlanSchema.parse({ ...plan, environment: { deploySource: { from: "main" } } }),
    });
    const { paths } = world.deps;
    // This computer has prod's CPU, so dev pulls the image prod runs instead of building one.
    const here: RunDesignOptions = { localhost: { arch: "x64", portFree: async () => true } };
    const dev = await createTestPhaseDeps({ root: paths.root, environment: "dev" });
    const added = await addEnvironment(dev, { answers: { provider: "localhost" }, design: here });
    expect(added.design.plan.target).toMatchObject({ provider: "localhost", image: "registry" });

    // The port changes in the code; dev keeps the port of prod's plan, whose image it runs.
    const architecture = await readArtifact("architecture", paths.files.architecture);
    await writeArtifact("architecture", paths.files.architecture, {
      ...architecture,
      facts: { ...architecture.facts, port: 4000 },
    });
    const redesigned = await design("dev", here);
    expect(redesigned.plan.app.port).toBe(3000);
    expect(redesigned.said).toContain("Components (copied from prod's plan): PostgreSQL 17 (db).");

    // Provision's preflight compares it with prod's plan.
    const changed = DeployPlanSchema.parse({
      ...redesigned.plan,
      app: { ...redesigned.plan.app, port: 4000 },
    });
    const stop = await failure(requireSharedParts(environmentPaths(paths, "dev"), changed));
    expect(stop.message).toBe(
      "The dev environment runs prod's image, and its plan differs from prod's in what every environment shares: app.port. Nothing was changed.",
    );
  });

  it("in the branches setup, takes each environment's shared parts from its own design and compares nothing", async () => {
    // staging follows its own branch, and prod (on main) runs a cache on another port.
    const { world, design } = await designable({
      prod: (plan) =>
        DeployPlanSchema.parse({
          ...plan,
          environment: { deploySource: { from: "main" } },
          app: { ...plan.app, port: 9999 },
          services: WITH_CACHE,
        }),
      staging: (plan) =>
        DeployPlanSchema.parse({ ...plan, cicd: { ...plan.cicd, branch: "staging" } }),
    });
    const staging = await design("staging");
    expect(names(staging.plan)).toEqual(["db"]);
    expect(staging.plan.app.port).toBe(3000);
    expect(staging.plan.cicd.branch).toBe("staging");

    // Provision's preflight compares neither with the other.
    await requireSharedParts(environmentPaths(world.deps.paths, "staging"), staging.plan);
    await requireSharedParts(
      world.deps.paths,
      await readArtifact("plan", world.deps.paths.files.plan),
    );
  });
});

describe("sharedPartsDiffer", () => {
  it("does not count where a service runs: each environment places its services itself", () => {
    const plan = ownPlan();
    const placed = { ...plan, services: plan.services.map((s) => ({ ...s, server: "db" })) };
    expect(sharedPartsDiffer(placed, plan)).toEqual([]);
    const bigger = { ...placed, services: placed.services.map((s) => ({ ...s, memoryMb: 1024 })) };
    expect(sharedPartsDiffer(bigger, plan)).toEqual(["services.db (other settings)"]);
  });
});
