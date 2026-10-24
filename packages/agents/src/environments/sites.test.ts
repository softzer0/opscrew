import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, OpsCrewError } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import {
  type DeployPlan,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import {
  createTestPhaseDeps,
  makeRequirements,
  nextPostgresFacts,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { addEnvironment, environmentQuestions } from "./index";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const DOMAIN = "docs.example.com";

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Requirements on `provider` for `DOMAIN` on Cloudflare (no region off a cloud server). */
function requirementsFor(provider: Requirements["provider"]): Requirements {
  const { region, ...rest } = makeRequirements({
    provider,
    domain: DOMAIN,
    dnsProvider: "cloudflare",
  });
  return provider === "hetzner" ? { ...rest, region } : rest;
}

/** Writes the analysis of `facts`, prod's answers and, unless designed later, prod's plan. */
async function project(
  deps: TestPhaseDeps,
  facts: ProjectFacts,
  requirements: Requirements,
  plan?: DeployPlan,
): Promise<void> {
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-23T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A site.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  if (plan !== undefined) await writeArtifact("plan", deps.paths.files.plan, plan);
}

/** A project of `examples/static-vite`, analysed, with prod's answers on Cloudflare's hosting. */
async function staticSite(): Promise<TestPhaseDeps> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-test-"));
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew") },
  });
  await materializeFixture(join(EXAMPLES, "static-vite"), root);
  await project(deps, await detectProject(root), requirementsFor("cloudflare-workers"));
  return deps;
}

/** The deps of the environment `name` beside `prod`. */
const environment = (prod: TestPhaseDeps, name: string) =>
  createTestPhaseDeps({ root: prod.paths.root, env: prod.env, environment: name });

describe("environments of a site", () => {
  it("on Cloudflare's hosting: prod's target, with a Worker and a hostname of its own", async () => {
    const prod = await staticSite();
    const { plan: prodPlan } = await runDesign(prod);
    const staging = await environment(prod, "staging");

    const { design } = await addEnvironment(staging, { answers: {} });
    expect(design.plan.target).toMatchObject({
      provider: "cloudflare-workers",
      worker: `${prodPlan.app.name}-staging`,
    });
    expect(design.plan.app.name).toBe(`${prodPlan.app.name}-staging`);
    expect(design.plan.dns.domain).toMatch(/^staging[.-]docs\.example\.com$/);
    expect(design.plan.dns.domain).not.toBe(prodPlan.dns.domain);
    expect(await readArtifact("plan", staging.paths.files.plan)).toEqual(design.plan);
    // A dev environment's target is prod's too, never this computer.
    const facts = (await readArtifact("architecture", prod.paths.files.architecture)).facts;
    const base = requirementsFor("cloudflare-workers");
    const [dev] = environmentQuestions("dev", { prodPlan, base, environments: ["prod"] }, facts);
    expect(dev).toMatchObject({ id: "provider", default: "cloudflare-workers" });
  });

  it("refuses a localhost environment, naming the framework's own dev server", async () => {
    const prod = await createTestPhaseDeps();
    await project(
      prod,
      nextPostgresFacts({ name: "example-app" }),
      requirementsFor("cloudflare-workers"),
      sitePlan(),
    );
    const dev = await environment(prod, "dev");
    const error = await failure(addEnvironment(dev, { answers: { provider: "localhost" } }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "A copy of a site on Cloudflare hosting on this computer is the framework's own dev server (`npm run dev`), so OpsCrew sets up no localhost environment for it. Nothing was written.",
    );
    expect(error.hint).toContain("opscrew env add dev --target cloudflare-workers");
    expect(await exists(dev.paths.files.requirements)).toBe(false);
  });

  it("refuses another target beside a site on Cloudflare's hosting", async () => {
    const prod = await createTestPhaseDeps();
    await project(
      prod,
      nextPostgresFacts({ name: "example-app" }),
      requirementsFor("cloudflare-workers"),
      sitePlan(),
    );
    const staging = await environment(prod, "staging");
    const error = await failure(addEnvironment(staging, { answers: { provider: "hetzner" } }));
    expect(error.message).toBe(
      "Every environment of a site on Cloudflare hosting runs there too, each with its own Worker and hostname, so the staging environment cannot run on hetzner. Nothing was written.",
    );
    expect(error.hint).toBe(
      "Run `opscrew env add staging --target cloudflare-workers`, or leave --target out: it is prod's.",
    );
    expect(await exists(staging.paths.files.requirements)).toBe(false);
  });

  it("on GitHub Pages: prod only, since a repository has one Pages site", async () => {
    const prod = await createTestPhaseDeps();
    await project(
      prod,
      nextPostgresFacts({ name: "example-app" }),
      requirementsFor("github-pages"),
      pagesTestPlan(),
    );
    const staging = await environment(prod, "staging");
    const error = await failure(addEnvironment(staging, { answers: {} }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "GitHub Pages publishes one site per repository, and prod is that site, so the staging environment cannot have one of its own. Nothing was written.",
    );
    expect(error.hint).toContain("Cloudflare's hosting, where each environment has its own Worker");
    expect(await exists(staging.paths.files.requirements)).toBe(false);
  });

  it.each([
    ["cloudflare-workers", "Cloudflare hosting"],
    ["github-pages", "GitHub Pages"],
  ] as const)("refuses a site on %s beside a prod that is not one", async (provider, name) => {
    const prod = await createTestPhaseDeps();
    await project(
      prod,
      nextPostgresFacts({ name: "example-app" }),
      requirementsFor("hetzner"),
      testPlan(),
    );
    const staging = await environment(prod, "staging");
    const error = await failure(addEnvironment(staging, { answers: { provider } }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `The staging environment cannot be a site on ${name} while prod is not one: an app's environments are all sites on prod's target, or none is. Nothing was written.`,
    );
    expect(await exists(staging.paths.files.requirements)).toBe(false);
  });
});
