import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { detectProject } from "@opscrew/detect";
import {
  type DeployPlan,
  DeployPlanSchema,
  type ProjectFacts,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments/paths";
import {
  createTestPhaseDeps,
  makeRequirements,
  movePlan,
  type ScriptedApprovalHandler,
  type TestPhaseDeps,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { runRetarget } from "./run";
import type { RetargetOptions } from "./types";

/** A Vite single-page app, as analyze detects it. */
const SITE_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify({
    name: "example-app",
    private: true,
    scripts: { build: "vite build" },
    devDependencies: { vite: "^8.3.4" },
  })}\n`,
  "package-lock.json": `${JSON.stringify({ name: "example-app", lockfileVersion: 3, packages: {} })}\n`,
  "vite.config.js": "export default {};\n",
  "index.html": "<!doctype html><title>example-app</title>\n",
};

/** A project with `plan` written, its site analysed (`facts` set over it) and the answers. */
async function project(
  plan: DeployPlan,
  o: { environment?: string; facts?: Partial<ProjectFacts> } = {},
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps(
    o.environment === undefined ? {} : { environment: o.environment },
  );
  for (const [path, content] of Object.entries(SITE_FILES)) {
    await writeFile(join(deps.paths.root, path), content);
  }
  await mkdir(dirname(deps.paths.files.plan), { recursive: true });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const facts = { ...(await detectProject(deps.paths.root)), ...o.facts };
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-10-23T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A site.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({
      provider: "github-pages",
      domain: plan.dns.domain ?? "docs.example.com",
      dnsProvider: "cloudflare",
    }),
  );
  return deps;
}

/** The refusal `runRetarget` stopped with, after checking that nothing was changed or asked. */
async function refusal(
  deps: TestPhaseDeps,
  options: RetargetOptions,
  before: DeployPlan,
): Promise<OpsCrewError> {
  const error = await runRetarget(deps, options).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(before);
  expect((deps.approvalHandler as ScriptedApprovalHandler).requests).toEqual([]);
  expect(deps.audit.entries.filter((entry) => entry.kind !== "phase")).toEqual([]);
  return error as OpsCrewError;
}

const SITE_TO_SERVER = /between a site host and a server changes the app's whole design/;

describe("retarget for a site: the refusals, before any change", () => {
  it("refuses a site to a server, and says how: destroy, then interview, design and provision", async () => {
    const plan = sitePlan({ deployed: true });
    const deps = await project(plan);
    for (const to of ["hetzner", "own", "portainer"] as const) {
      const error = await refusal(deps, { to }, plan);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringMatching(SITE_TO_SERVER),
      });
      expect(error.message).toContain("Nothing was changed.");
      expect(error.hint).toBe(
        "Run `opscrew destroy`, then `opscrew interview`, `opscrew design` and `opscrew provision` for the new target.",
      );
    }
  });

  it("refuses a site whose interview now asks for a server", async () => {
    const plan = sitePlan({ deployed: true });
    const deps = await project(plan);
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({
        provider: "hetzner",
        domain: "docs.example.com",
        dnsProvider: "cloudflare",
      }),
    );
    const error = await refusal(deps, {}, plan);
    expect(error.message).toMatch(SITE_TO_SERVER);
  });

  it("refuses an app with a server moving to a site host, before any check", async () => {
    const plan = movePlan();
    const deps = await project(plan);
    for (const to of ["cloudflare-workers", "github-pages"] as const) {
      const error = await refusal(deps, { to }, plan);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringMatching(SITE_TO_SERVER),
      });
      expect(error.hint).toContain("`opscrew destroy`");
    }
  });

  it("says there is nothing to move to the host the site is on, or when it was torn down", async () => {
    const plan = sitePlan({ deployed: true });
    const deps = await project(plan);
    const same = await refusal(deps, { to: "cloudflare-workers" }, plan);
    expect(same.message).toContain(
      "already runs on Cloudflare hosting, so there is nothing to move",
    );
    expect(same.hint).toContain("--to github-pages");

    const gone = DeployPlanSchema.parse({
      ...plan,
      deployment: { destroyedAt: "2026-11-01T10:00:00.000Z" },
    });
    const torn = await project(gone);
    const error = await refusal(torn, { to: "github-pages" }, gone);
    expect(error.message).toContain("has no live deployment on this computer");
  });

  it("moves only prod to GitHub Pages, and only while the app has no other environment", async () => {
    const staging = sitePlan({ environment: "staging", deployed: true });
    const deps = await project(staging, { environment: "staging" });
    const notProd = await refusal(deps, { to: "github-pages" }, staging);
    expect(notProd.message).toContain(
      "GitHub Pages publishes one site per repository, and prod is that site, so the staging environment cannot move there.",
    );

    const prod = sitePlan({ deployed: true });
    const withStaging = await project(prod);
    const other = environmentPaths(withStaging.paths, "staging");
    await mkdir(dirname(other.files.plan), { recursive: true });
    await writeArtifact("plan", other.files.plan, staging);
    const error = await refusal(withStaging, { to: "github-pages" }, prod);
    expect(error.message).toContain(
      "has other environments (staging), and GitHub Pages publishes only prod",
    );
    expect(error.hint).toContain("`opscrew env remove <name>`");
  });

  it("refuses www on a subdomain for GitHub Pages, which redirects it only at the zone's apex", async () => {
    const plan = sitePlan({ deployed: true, www: true });
    const deps = await project(plan);
    const error = await refusal(deps, { to: "github-pages" }, plan);
    expect(error.message).toContain(
      "also serves www.docs.example.com, and GitHub Pages redirects between www and the domain only at the zone's apex (example.com)",
    );
  });

  it("offers only the hosts design offers the app: a site with SQLite does not go to GitHub Pages", async () => {
    const plan = sitePlan({ deployed: true });
    const deps = await project(plan, {
      facts: { sqlite: { paths: ["data/app.db"], dir: "data" } },
    });
    const error = await refusal(deps, { to: "github-pages" }, plan);
    expect(error.message).toContain(
      "GitHub Pages is not offered for this app: the app keeps its data in SQLite",
    );
  });
});
