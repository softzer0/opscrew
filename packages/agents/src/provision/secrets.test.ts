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
/** The capability check's throwaway GitHub environment. */
const PROBE = /^opscrew-probe-[0-9a-f]{8}$/;

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
    // The check runs on a throwaway environment of its own, which the approval names.
    expect(github.probes).toEqual([expect.stringMatching(PROBE)]);
    const [probe] = github.probes;
    expect(requestsOf(staging).find((r) => r.kind === "github-settings")?.details).toContain(
      `OpsCrew creates the throwaway GitHub environment ${probe}, tries a branch rule on it and then a required reviewer and a wait timer, reads it back to see what GitHub enforces there, and removes it again. It changes no other environment.`,
    );
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
    ).toEqual(expect.arrayContaining([`check environment ${probe}`, "create environment staging"]));
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
    expect(github.probes).toEqual([probe, expect.stringMatching(PROBE)]);
    expect(github.probes[1]).not.toBe(probe);
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

  it("puts prod's secrets into a production environment GitHub made, keeping its rules byte-identical", async () => {
    const app = await appInProd();
    const { github } = app;
    github.reviewersWork = true;
    // GitHub created `production` by itself when a deploy workflow named it; the user gave it rules.
    github.environments.set("production", new Map());
    github.rules.set("production", {
      name: "production",
      waitTimer: 5,
      preventSelfReview: true,
      reviewers: [{ type: "User", id: 42 }],
      branchPolicy: { protectedBranches: true, customBranchPolicies: false },
      canAdminsBypass: false,
    });
    const rules = JSON.stringify(github.rules.get("production"));
    await runProvision(await app.addStaging(), { services: app.services() });
    await app.merge();

    const prod = await app.deps();
    prod.interactive = true;
    await runProvision(prod, { services: app.services() });
    // The checks ran on throwaway environments only.
    expect(github.probes).toEqual([expect.stringMatching(PROBE), expect.stringMatching(PROBE)]);
    expect(JSON.stringify(github.rules.get("production"))).toBe(rules);
    expect(github.environmentPuts.filter((put) => put.name === "production")).toEqual([]);
    expect(github.deploymentBranches.has("production")).toBe(false);
    expect(github.environments.get("production")?.has(DEPLOY_SECRETS.appEnv)).toBe(true);
    expect(prod.reporter.text()).toContain(
      "OpsCrew did not create the GitHub environment production, so it changes none of its rules.",
    );
    expect(
      JSON.parse(await readFile(prod.paths.files.deploySecrets, "utf8")).createdEnvironment,
    ).toBeUndefined();
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

/** Staging deployed by promotion from prod. */
function promotedStagingOf(prod: DeployPlan): DeployPlan {
  const staging = stagingOf(prod);
  return DeployPlanSchema.parse({
    ...staging,
    environment: { ...staging.environment, deploySource: { from: "promote", source: "prod" } },
  });
}

const RULES_TITLE = "Set the rules of the GitHub environment staging in acme/shop";
const rulesRequest = (deps: TestPhaseDeps) =>
  requestsOf(deps).find((request) => request.title === RULES_TITLE);
const SETTINGS = "https://github.com/acme/shop/settings/environments";
const CUSTOM = { protectedBranches: false, customBranchPolicies: true };
const GUARD =
  "OpsCrew's approval guards against mistakes, not against someone with write access to the repository";
const count = (text: string, part: string) => text.split(part).length - 1;

describe.skipIf(!findExecutable("git"))("the rules of GitHub environments (FR-1521)", () => {
  /** Staging's provision with `plan`, `interactive` or not, approving what `approve` allows. */
  async function provisionStaging(
    app: Awaited<ReturnType<typeof appInProd>>,
    plan: DeployPlan,
    options: { interactive?: boolean; approve?: (title: string) => boolean } = {},
  ) {
    const staging = await createTestPhaseDeps({
      root: app.root,
      env: app.prodDeps.env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler((r) => options.approve?.(r.title) ?? true),
      environment: "staging",
    });
    staging.interactive = options.interactive ?? false;
    await writeArtifact("plan", staging.paths.files.plan, plan);
    return { staging, run: () => runProvision(staging, { services: app.services() }) };
  }

  it("offers the repository's owner as reviewer and the branch rule in an interactive run, under one github-settings approval", async () => {
    const app = await appInProd();
    app.github.reviewersWork = true;
    const { staging, run } = await provisionStaging(app, promotedStagingOf(app.prod), {
      interactive: true,
    });
    await run();

    const request = rulesRequest(staging);
    expect(request?.kind).toBe("github-settings");
    expect(request?.details).toBe(
      [
        "OpsCrew created staging for the deploy secrets of staging, and changes only these of its rules:",
        "  Required reviewer: acme, the repository's owner. Each deploy to staging waits in GitHub until they approve it.",
        "  Deployment branches: only main, the default branch. A workflow run on any other branch cannot deploy to staging or read its secrets.",
      ].join("\n"),
    );
    // The rules are set before the deploy secrets are stored.
    const titles = requestsOf(staging).map((r) => r.title);
    expect(titles.indexOf(RULES_TITLE)).toBeLessThan(
      requestsOf(staging).findIndex((r) => r.kind === "github-secrets"),
    );
    expect(app.github.rules.get("staging")).toMatchObject({
      reviewers: [{ type: "User", id: 1001 }],
      branchPolicy: CUSTOM,
    });
    expect(app.github.deploymentBranches.get("staging")).toEqual(["main"]);
    // GitHub merges a PUT, so only the rules that change are sent: never a wait timer or
    // self-review left at its default, which GitHub refuses where it has no such rule.
    expect(app.github.environmentPuts).toEqual([
      { name: "staging", settings: {} },
      {
        name: "staging",
        settings: { reviewers: [{ type: "User", id: 1001 }], branchPolicy: CUSTOM },
      },
    ]);
    expect(staging.audit.entries.map((e) => e.action)).toContain(
      "set rules of environment staging",
    );
    expect(staging.reporter.text()).not.toContain(GUARD);

    // Set once: the next provision offers nothing again.
    await app.merge();
    const again = await app.deps("staging");
    again.interactive = true;
    await runProvision(again, { services: app.services() });
    expect(rulesRequest(again)).toBeUndefined();
    expect(app.github.deploymentBranches.get("staging")).toEqual(["main"]);
  });

  it("keeps no reviewer in a script and says how to add one; the branch rule is still offered", async () => {
    const app = await appInProd();
    app.github.reviewersWork = true;
    const { staging, run } = await provisionStaging(app, promotedStagingOf(app.prod));
    await run();

    expect(rulesRequest(staging)?.details).not.toContain("Required reviewer");
    expect(rulesRequest(staging)?.details).toContain("Deployment branches: only main");
    expect(app.github.rules.get("staging")).toMatchObject({ reviewers: [], branchPolicy: CUSTOM });
    expect(staging.reporter.text()).toContain(
      `This run is not interactive, so OpsCrew adds no required reviewer for staging, which is deployed by promotion. To have each deploy to staging wait in GitHub for a reviewer's approval, add required reviewers to the GitHub environment staging in ${SETTINGS}.`,
    );
  });

  it("offers no reviewer when the repository's owner is an organization, and says how to add one", async () => {
    const app = await appInProd();
    app.github.reviewersWork = true;
    app.github.ownerType = "Organization";
    const { staging, run } = await provisionStaging(app, promotedStagingOf(app.prod), {
      interactive: true,
    });
    await run();

    expect(rulesRequest(staging)?.details).not.toContain("Required reviewer");
    expect(staging.reporter.text()).toContain(
      "acme is an organization, so OpsCrew has no reviewer to offer for staging",
    );
  });

  it("gives an environment that follows main only the branch rule, and says once what OpsCrew's approval guards against", async () => {
    const app = await appInProd();
    const { staging, run } = await provisionStaging(app, stagingOf(app.prod), {
      interactive: true,
    });
    await run();

    expect(rulesRequest(staging)?.details).toBe(
      [
        "OpsCrew created staging for the deploy secrets of staging, and changes only these of its rules:",
        "  Deployment branches: only main, the default branch. A workflow run on any other branch cannot deploy to staging or read its secrets.",
      ].join("\n"),
    );
    expect(app.github.deploymentBranches.get("staging")).toEqual(["main"]);
    const text = staging.reporter.text();
    expect(count(text, GUARD)).toBe(1);
    expect(text).toContain(
      "GitHub enforces no required reviewers in acme/shop (a private repository has them only on GitHub Enterprise)",
    );
  });

  it("leaves the rules as they are when the user refuses them, goes on, and never offers a declined reviewer again", async () => {
    const app = await appInProd();
    app.github.reviewersWork = true;
    const { staging, run } = await provisionStaging(app, promotedStagingOf(app.prod), {
      interactive: true,
      approve: (title) => title !== RULES_TITLE,
    });
    await run();

    expect(rulesRequest(staging)?.details).toContain("Required reviewer: acme");
    expect(app.github.rules.get("staging")).toMatchObject({ reviewers: [], branchPolicy: null });
    expect(app.github.deploymentBranches.has("staging")).toBe(false);
    expect(staging.reporter.text()).toContain(
      `OpsCrew left the rules of the GitHub environment staging as they are, and does not offer a reviewer for staging again. To add one later, add required reviewers to staging in ${SETTINGS}. The branch rule is offered again at the next \`opscrew provision\`.`,
    );
    // Provisioning went on: the deploy secrets are stored, and the record keeps the answer.
    expect(app.github.environments.get("staging")?.has("OPSCREW_STAGING_HOST")).toBe(true);
    expect(JSON.parse(await readFile(staging.paths.files.deploySecrets, "utf8"))).toMatchObject({
      createdEnvironment: true,
      reviewersDeclined: true,
    });

    // The next interactive provision offers only the branch rule, and says nothing more of reviewers.
    await app.merge();
    const again = await app.deps("staging");
    again.interactive = true;
    await runProvision(again, { services: app.services() });
    expect(rulesRequest(again)?.details).not.toContain("Required reviewer");
    expect(rulesRequest(again)?.details).toContain("Deployment branches: only main");
    expect(again.reporter.text()).not.toContain("reviewer for staging");
    expect(app.github.rules.get("staging")).toMatchObject({ reviewers: [], branchPolicy: CUSTOM });
  });

  it("offers a refused branch rule again", async () => {
    const app = await appInProd();
    const { staging, run } = await provisionStaging(app, stagingOf(app.prod), {
      approve: (title) => title !== RULES_TITLE,
    });
    await run();

    expect(staging.reporter.text()).toContain(
      `OpsCrew left the rules of the GitHub environment staging as they are. Set them in ${SETTINGS}, or run \`opscrew provision\` again to be offered them again.`,
    );
    expect(
      JSON.parse(await readFile(staging.paths.files.deploySecrets, "utf8")).reviewersDeclined,
    ).toBeUndefined();
  });

  it("changes no rule of a GitHub environment the user made, and says so", async () => {
    const app = await appInProd();
    app.github.reviewersWork = true;
    app.github.environments.set("staging", new Map());
    const { staging, run } = await provisionStaging(app, promotedStagingOf(app.prod), {
      interactive: true,
    });
    await run();

    expect(rulesRequest(staging)).toBeUndefined();
    expect(app.github.environmentPuts.filter((put) => put.name === "staging")).toEqual([]);
    expect(staging.reporter.text()).toContain(
      `OpsCrew did not create the GitHub environment staging, so it changes none of its rules. To let only main deploy to it, or to have each deploy wait for a reviewer, set its rules yourself in ${SETTINGS}.`,
    );
    // Its deploy secrets still live there.
    expect(app.github.environments.get("staging")?.has("OPSCREW_STAGING_HOST")).toBe(true);
  });

  it("puts the rules back when GitHub refuses the default branch, since no branch could deploy", async () => {
    const app = await appInProd();
    app.github.deploymentBranchError = new Error("GitHub could not answer");
    const { staging, run } = await provisionStaging(app, stagingOf(app.prod));
    await expect(run()).rejects.toMatchObject({
      message:
        "OpsCrew could not let main deploy to the GitHub environment staging (GitHub could not answer), so it put the environment's rules back as they were.",
      hint: "Then run `opscrew provision` again.",
    });
    expect(app.github.rules.get("staging")).toMatchObject({ branchPolicy: null });
    expect(rulesRequest(staging)).toBeDefined();
    expect(
      staging.audit.entries.find((e) => e.action === "set rules of environment staging (failed)")
        ?.detail,
    ).toBe(
      "main could not be added to its deployment branches; the rules were put back as they were",
    );
  });

  it("says no branch can deploy when the rules cannot be put back, and offers the branch rule again", async () => {
    const app = await appInProd();
    const { github } = app;
    const put = github.putEnvironment.bind(github);
    // The branch is refused, and so is the PUT that would put the rules back.
    github.addDeploymentBranch = async () => {
      github.putEnvironment = async () => {
        throw new Error("GitHub could not answer");
      };
      throw new Error("GitHub could not answer");
    };
    const { staging, run } = await provisionStaging(app, stagingOf(app.prod));
    await expect(run()).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew could not let main deploy to the GitHub environment staging (GitHub could not answer), and could not put its rules back: no branch can deploy to staging now.",
      hint: `In ${SETTINGS}, add main under Deployment branches of staging, or set them to No restriction. Then run \`opscrew provision\` again.`,
    });
    expect(github.rules.get("staging")).toMatchObject({ branchPolicy: CUSTOM });
    expect(
      staging.audit.entries.find((e) => e.action === "set rules of environment staging (failed)")
        ?.detail,
    ).toBe("main could not be added to its deployment branches; the rules could not be put back");

    // The next provision sees custom branch policies without a branch and offers the default
    // branch again, without another PUT.
    github.putEnvironment = put;
    github.addDeploymentBranch = Object.getPrototypeOf(github).addDeploymentBranch.bind(github);
    const puts = github.environmentPuts.length;
    const again = await provisionStaging(app, stagingOf(app.prod));
    await again.run();
    expect(rulesRequest(again.staging)?.details).toContain("Deployment branches: only main");
    expect(github.deploymentBranches.get("staging")).toEqual(["main"]);
    expect(github.environmentPuts.length).toBe(puts);
  });

  it("changes no rule on a Free private repository, where GitHub enforces none", async () => {
    const app = await appInProd();
    app.github.branchPoliciesWork = false;
    const { staging, run } = await provisionStaging(app, promotedStagingOf(app.prod), {
      interactive: true,
    });
    await run();

    // The deploy secrets live in the GitHub environment, which gets no rule.
    expect(app.github.environments.get("staging")?.has("OPSCREW_STAGING_HOST")).toBe(true);
    expect(rulesRequest(staging)).toBeUndefined();
    expect(app.github.environmentPuts).toEqual([{ name: "staging", settings: {} }]);
    expect(count(staging.reporter.text(), GUARD)).toBe(1);

    // Without GitHub environments at all, the same plain statement, once.
    const plain = await appInProd();
    plain.github.environmentsWork = false;
    const other = await provisionStaging(plain, promotedStagingOf(plain.prod));
    await other.run();
    expect(rulesRequest(other.staging)).toBeUndefined();
    expect(count(other.staging.reporter.text(), GUARD)).toBe(1);
  });
});
