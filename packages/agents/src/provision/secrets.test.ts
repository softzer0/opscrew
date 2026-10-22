import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable } from "@opscrew/core";
import { DEPLOY_SECRETS } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const HCLOUD = "hcloud-test-token-not-a-real-value";
const PROD_WORKFLOW = ".github/workflows/opscrew-deploy.yml";
const STAGING_WORKFLOW = ".github/workflows/opscrew-deploy-staging.yml";
const BUILD = [DEPLOY_SECRETS.buildEnv, DEPLOY_SECRETS.buildSecrets];

/** `prod` as staging's plan, as design writes it. */
function stagingOf(prod: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name: "staging" },
    app: { ...prod.app, name: `${prod.app.name}-staging` },
    infra: { ...prod.infra, dir: "opscrew/infra/staging" },
    cicd: { ...prod.cicd, workflowPath: STAGING_WORKFLOW },
  });
}

/** An app provisioned in prod, with one GitHub fake for every run; prod's pull request merged. */
async function appInProd() {
  const prod = testPlan({ userSecret: false, postgres: true });
  const project = await createProject(prod);
  const github = new FakeGitHub();
  const env = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
  };
  const deps = (environment?: string) =>
    createTestPhaseDeps({
      root: project.root,
      env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => true),
      ...(environment === undefined ? {} : { environment }),
    });
  const services = (): ProvisionServices => ({
    engine: async () => new FakeEngine(),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
  });
  const { git, root } = project;
  /** The user merges the run's pull request and goes back to the updated main. */
  const merge = async () => {
    const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--no-edit", branch);
    await git(root, "push", "-q", "origin", "main");
  };
  const prodDeps = await deps();
  await runProvision(prodDeps, { services: services() });
  await merge();
  const addStaging = async () => {
    const staging = await deps("staging");
    await writeArtifact(
      "plan",
      environmentPaths(prodDeps.paths, "staging").files.plan,
      stagingOf(prod),
    );
    return staging;
  };
  return { ...project, prod, prodDeps, deps, services, github, merge, addStaging };
}

const requestsOf = (deps: TestPhaseDeps) =>
  (deps.approvalHandler as ScriptedApprovalHandler).requests;
const secretsRequest = (deps: TestPhaseDeps) =>
  requestsOf(deps).find((request) => request.kind === "github-secrets");

/** The secret values a run stored that look like secrets (the key, the env files), never short words. */
function secretValues(github: FakeGitHub): string[] {
  const all = [...github.secrets, ...[...github.environments.values()].flatMap((s) => [...s])];
  return all
    .filter(([name]) => /SSH_PRIVATE_KEY|APP_ENV|SERVICE_/.test(name))
    .flatMap(([, value]) => value.split("\n"))
    .filter((line) => line.length >= 12);
}

/** No stored value in what the run printed, audited or asked to approve. */
function expectNoSecretValue(deps: TestPhaseDeps, github: FakeGitHub): void {
  const shown = [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(requestsOf(deps)),
  ].join("\n");
  const values = secretValues(github);
  expect(values.length).toBeGreaterThan(3);
  for (const value of values) expect(shown).not.toContain(value);
}

describe.skipIf(!findExecutable("git"))("deploy secrets per environment", () => {
  it("keeps a prod-only app as it was, then puts staging's own secrets in its GitHub environment and moves prod's at prod's provision", async () => {
    const app = await appInProd();
    const { github, prodDeps, root } = app;

    // A prod-only app: no check, no settings change, today's repository secrets.
    expect(github.probes).toEqual([]);
    expect(requestsOf(prodDeps).map((r) => r.kind)).not.toContain("github-settings");
    expect(github.environments.size).toBe(0);
    expect(github.secrets.has(DEPLOY_SECRETS.host)).toBe(true);
    expect((await readArtifact("plan", prodDeps.paths.files.plan)).environment).toBeUndefined();
    const prodSecrets = new Map(github.secrets);
    const prodWorkflow = await readFile(join(root, PROD_WORKFLOW), "utf8");

    // staging: the check, its GitHub environment, OPSCREW_STAGING_* there, its build values in
    // the repository; prod's secrets untouched.
    const staging = await app.addStaging();
    await runProvision(staging, { services: app.services() });
    expect(github.probes).toEqual(["staging"]);
    const kinds = requestsOf(staging).map((r) => r.kind);
    expect(kinds.indexOf("github-settings")).toBeLessThan(kinds.indexOf("github-secrets"));
    const inStaging = [...(github.environments.get("staging")?.keys() ?? [])].sort();
    expect(inStaging).toContain("OPSCREW_STAGING_HOST");
    expect(inStaging).toContain("OPSCREW_STAGING_SERVICE_DB_ENV");
    for (const name of inStaging) expect(name).toMatch(/^OPSCREW_STAGING_/);
    expect(inStaging).not.toContain("OPSCREW_STAGING_BUILD_ENV");
    expect([...github.secrets.keys()].sort()).toEqual(
      [...prodSecrets.keys(), "OPSCREW_STAGING_BUILD_ENV", "OPSCREW_STAGING_BUILD_SECRETS"].sort(),
    );
    for (const [name, value] of prodSecrets) expect(github.secrets.get(name)).toBe(value);
    expect(secretsRequest(staging)?.details).toContain(
      "Secrets in the GitHub environment staging (names only;",
    );
    // The check and the creation are audited, and the record says OpsCrew created the environment
    // (only then does destroy delete it).
    expect(
      staging.audit.entries.filter((e) => e.kind === "provider-call").map((e) => e.action),
    ).toEqual(expect.arrayContaining(["check environment staging", "create environment staging"]));
    expect(JSON.parse(await readFile(staging.paths.files.deploySecrets, "utf8"))).toMatchObject({
      repo: "acme/shop",
      environment: "staging",
      createdEnvironment: true,
    });
    const stagingPlan = await readArtifact("plan", staging.paths.files.plan);
    expect(stagingPlan.environment?.secrets).toBe("environment");
    const stagingWorkflow = await readFile(join(root, STAGING_WORKFLOW), "utf8");
    expect(stagingWorkflow).toContain("    environment: staging\n");
    expect(stagingWorkflow).toContain("secrets.OPSCREW_STAGING_HOST");
    expect(stagingWorkflow).not.toMatch(/secrets\.OPSCREW_HOST\b/);
    expect(staging.reporter.text()).toContain(
      "the deploy secrets of staging live in the GitHub environment staging",
    );
    expectNoSecretValue(staging, github);
    await app.merge();

    // prod's own provision moves its secrets into `production` and deletes the repository's
    // copies, so a missing one never falls back to them; staging's stay.
    const stagingSecrets = new Map(github.environments.get("staging"));
    const prod = await app.deps();
    await runProvision(prod, { services: app.services() });
    expect(github.probes).toEqual(["staging", "production"]);
    const inProduction = [...(github.environments.get("production")?.keys() ?? [])].sort();
    expect(inProduction).toEqual(
      [...prodSecrets.keys()].filter((name) => !BUILD.includes(name as never)).sort(),
    );
    expect([...github.secrets.keys()].sort()).toEqual(
      [...BUILD, "OPSCREW_STAGING_BUILD_ENV", "OPSCREW_STAGING_BUILD_SECRETS"].sort(),
    );
    expect(github.environments.get("staging")).toEqual(stagingSecrets);
    const moved = secretsRequest(prod)?.details ?? "";
    expect(moved).toContain(
      "Deleted from the repository's secrets, since these secrets now live in the GitHub environment production (names only):\n  OPSCREW_APP_ENV\n",
    );
    expect((await readArtifact("plan", prod.paths.files.plan)).environment).toEqual({
      deploySource: { from: "main" },
      runner: "github",
      secrets: "environment",
    });
    // Prod's workflow stays byte-identical.
    expect(await readFile(join(root, PROD_WORKFLOW), "utf8")).toBe(prodWorkflow);
    expectNoSecretValue(prod, github);
    await app.merge();

    // GitHub stops supporting environments (a private repository on Free): prod's secrets move
    // back to repository secrets, shown as a planned change.
    github.environmentsWork = false;
    const again = await app.deps();
    await runProvision(again, { services: app.services() });
    expect(github.secrets.get(DEPLOY_SECRETS.host)).toBe(prodSecrets.get(DEPLOY_SECRETS.host));
    expect(github.environments.get("production")?.size).toBe(0);
    expect(github.environments.get("staging")).toEqual(stagingSecrets);
    expect(secretsRequest(again)?.details).toContain(
      "Deleted from their GitHub environment, since these secrets are now repository secrets (names only):\n  OPSCREW_APP_ENV (in the GitHub environment production)\n",
    );
    expect(again.reporter.text()).toContain(
      "The deploy secrets of prod move from the GitHub environment production to repository secrets",
    );
    expect(await readFile(join(root, PROD_WORKFLOW), "utf8")).toBe(
      prodWorkflow.replace("\n    environment: production", ""),
    );
    expectNoSecretValue(again, github);
  });

  it("stores staging's secrets as OPSCREW_STAGING_* repository secrets where GitHub has no environments", async () => {
    const app = await appInProd();
    const { github, root } = app;
    github.environmentsWork = false;
    const prodSecrets = new Map(github.secrets);
    const staging = await app.addStaging();
    await runProvision(staging, { services: app.services() });

    expect(github.environments.size).toBe(0);
    const added = [...github.secrets.keys()].filter((name) => !prodSecrets.has(name)).sort();
    expect(added).toContain("OPSCREW_STAGING_HOST");
    expect(added).toContain("OPSCREW_STAGING_BUILD_ENV");
    for (const name of added) expect(name).toMatch(/^OPSCREW_STAGING_/);
    for (const [name, value] of prodSecrets) expect(github.secrets.get(name)).toBe(value);
    expect((await readArtifact("plan", staging.paths.files.plan)).environment?.secrets).toBe(
      "prefixed",
    );
    const workflow = await readFile(join(root, STAGING_WORKFLOW), "utf8");
    expect(workflow).not.toContain("environment:");
    expect(workflow).toContain("secrets.OPSCREW_STAGING_HOST");
    expect(staging.reporter.text()).toContain(
      "does not support GitHub environments (GitHub Free has them only in public repositories), so the deploy secrets of staging are repository secrets named OPSCREW_STAGING_…",
    );
    expectNoSecretValue(staging, github);
  });

  it("stops before any change when the check of GitHub environments is refused", async () => {
    const app = await appInProd();
    const staging = await createTestPhaseDeps({
      root: app.root,
      env: app.prodDeps.env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler((r) => r.kind !== "github-settings"),
      environment: "staging",
    });
    await writeArtifact("plan", staging.paths.files.plan, stagingOf(app.prod));
    const before = new Map(app.github.secrets);
    await expect(runProvision(staging, { services: app.services() })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message:
        "OpsCrew did not check whether acme/shop supports GitHub environments, so it does not know where the deploy secrets of staging go. Nothing was changed.",
    });
    expect(app.github.probes).toEqual([]);
    expect(app.github.secrets).toEqual(before);
    expect(requestsOf(staging).map((r) => r.kind)).toEqual(["github-settings"]);
  });

  it("changes nothing at GitHub in a plan-only run: no check, no environment, repository secrets shown", async () => {
    const app = await appInProd();
    const { github, root } = app;
    const staging = await app.addStaging();
    await runProvision(staging, { services: app.services(), planOnly: true });

    expect(github.probes).toEqual([]);
    expect(github.environments.size).toBe(0);
    expect(requestsOf(staging).map((r) => r.kind)).not.toContain("github-settings");
    expect(staging.reporter.text()).toContain(
      "A plan-only run changes nothing at GitHub, so it does not check where the deploy secrets of staging live: this plan shows them as repository secrets named OPSCREW_STAGING_…. `opscrew provision` checks it before it stores them.",
    );
    const workflow = await readFile(join(root, STAGING_WORKFLOW), "utf8");
    expect(workflow).not.toContain("environment:");
    expect(workflow).toContain("secrets.OPSCREW_STAGING_HOST");
    // The plan keeps its environment as it was: no answer is recorded without the check.
    expect((await readArtifact("plan", staging.paths.files.plan)).environment).toEqual(
      stagingOf(app.prod).environment,
    );

    // With an answer recorded, a plan-only run keeps it, still without asking GitHub.
    const plan = stagingOf(app.prod);
    const recorded = DeployPlanSchema.parse({
      ...plan,
      environment: { ...plan.environment, secrets: "environment" },
    });
    await writeArtifact("plan", staging.paths.files.plan, recorded);
    await runProvision(await app.deps("staging"), { services: app.services(), planOnly: true });
    expect(github.probes).toEqual([]);
    expect(await readFile(join(root, STAGING_WORKFLOW), "utf8")).toContain(
      "    environment: staging\n",
    );
  });

  it("warns that the deploy secrets are not stored after a move with --no-secrets", async () => {
    const app = await appInProd();
    const staging = await app.addStaging();
    await runProvision(staging, { services: app.services() });
    expect((await readArtifact("plan", staging.paths.files.plan)).environment?.secrets).toBe(
      "environment",
    );

    await app.merge();

    // GitHub stops supporting environments, and this run stores no secrets.
    app.github.environmentsWork = false;
    const again = await app.deps("staging");
    await runProvision(again, { services: app.services(), secrets: false });
    expect(again.reporter.text()).toContain(
      "The deploy secrets are not stored in GitHub Actions for this server yet, so a deploy would fail.",
    );
  });
});
