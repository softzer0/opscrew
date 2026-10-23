import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, findExecutable, OpsCrewError, Redactor, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runAnalyze } from "../analyze";
import { runDesign } from "../design/run";
import { runDestroy } from "../destroy/run";
import type { DestroyServices } from "../destroy/types";
import { runInterview } from "../interview/run";
import { runProvision } from "../provision/run";
import { deploySecretNames } from "../provision/secrets";
import type { ProvisionServices } from "../provision/types";
import { ensureStatePassphrase } from "../shared";
import { buildPhaseDeps } from "../shared/phase-deps";
import {
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeEngine,
  FakeServers,
  fakeCloudflare,
  fakeSharedCloudflare,
  forbiddenFetch,
  HOST_KEY,
  MemoryReporter,
  makeRequirements,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  ScriptedRunner,
  SERVER_IPV4,
  type TestPhaseDeps,
  testPlan,
  writeArchitecture,
} from "../testing";
import { appPlan, twoSites } from "./__fixtures__/sites";
import { addApp } from "./index";

const HCLOUD = fakeSecret("hcloud-token", "two-apps");

/** The interview's answers for a static site on Cloudflare at `domain`. */
const answers = (domain: string) => ({
  provider: "cloudflare-workers",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  uptime: "standard",
  dataCriticality: "none",
  domain,
  dnsProvider: "cloudflare",
});

describe("two static sites in one repository, each designed on Cloudflare", () => {
  it("gives each its own plan, names and files; the first app's stays as it is", async () => {
    const root = await twoSites();
    const env = { OPSCREW_HOME: join(root, ".home-opscrew") };
    const web = await createTestPhaseDeps({ root, env });
    await runAnalyze(web, { ai: false, appDir: "sites/web" });
    await writeArtifact(
      "requirements",
      web.paths.files.requirements,
      makeRequirements({
        provider: "cloudflare-workers",
        domain: "example.com",
        dnsProvider: "cloudflare",
        appDir: "sites/web",
      }),
    );
    const first = (await runDesign(web)).plan;
    const firstText = await readFile(web.paths.files.plan, "utf8");

    await addApp(root, "docs", "sites/docs");
    const docs = await createTestPhaseDeps({ root, env, app: "docs" });
    await runAnalyze(docs, { ai: false });
    // The interview fills the app's folder from its record.
    const interviewed = await runInterview(docs, { answers: answers("docs.example.com") });
    expect(interviewed.requirements.appDir).toBe("sites/docs");
    const second = (await runDesign(docs)).plan;

    // The first app is named as detection names it; a further app after its key, which is unique.
    expect(first.app).toMatchObject({ name: "sites", buildContext: "sites/web" });
    expect(first.app.key).toBeUndefined();
    expect(second.app).toMatchObject({ key: "docs", name: "docs", buildContext: "sites/docs" });
    expect(first.target).toMatchObject({ worker: "sites" });
    expect(second.target).toMatchObject({ worker: "docs" });
    expect([first.infra.dir, second.infra.dir]).toEqual([
      "opscrew/infra/prod",
      "opscrew/infra/docs",
    ]);
    expect([first.cicd.workflowPath, second.cicd.workflowPath]).toEqual([
      ".github/workflows/opscrew-deploy.yml",
      ".github/workflows/opscrew-deploy-docs.yml",
    ]);
    expect(docs.paths.files.plan).toBe(join(root, "opscrew", "apps", "docs", "plan.yaml"));
    expect(docs.reporter.text()).toContain("Wrote opscrew/apps/docs/plan.yaml");
    expect(await readArtifact("architecture", docs.paths.files.architecture)).toMatchObject({
      facts: { appDir: "sites/docs" },
    });
    expect(await readFile(web.paths.files.plan, "utf8")).toBe(firstText);
  });

  it("refuses a second app on GitHub Pages, naming the one already there", async () => {
    const root = await twoSites();
    const web = await createTestPhaseDeps({ root });
    await runAnalyze(web, { ai: false, appDir: "sites/web" });
    const pages = {
      provider: "github-pages",
      domain: "example.com",
      dnsProvider: "cloudflare",
    } as const;
    await writeArtifact(
      "requirements",
      web.paths.files.requirements,
      makeRequirements({ ...pages, appDir: "sites/web" }),
    );
    // No GitHub remote yet, so design cannot ask GitHub and offers Pages as it is.
    expect((await runDesign(web)).plan.target.provider).toBe("github-pages");
    await addApp(root, "docs", "sites/docs");
    const docs = await createTestPhaseDeps({ root, app: "docs" });
    await runAnalyze(docs, { ai: false });
    await writeArtifact(
      "requirements",
      docs.paths.files.requirements,
      makeRequirements({ ...pages, domain: "docs.example.com", appDir: "sites/docs" }),
    );
    expect(await exists(web.paths.files.plan)).toBe(true);
    const error = await runDesign(docs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "GitHub Pages publishes one site per repository, and the first app's prod is already on it, so the app docs's prod cannot be. Nothing was written.",
    );
    expect((error as OpsCrewError).hint).toContain("`opscrew interview --app docs`");
    expect(await exists(docs.paths.files.plan)).toBe(false);
  });
});

/** A git project whose first app (`shop`) and further app `docs` are both designed for Hetzner. */
async function twoServerApps() {
  const project = await createProject(testPlan({ userSecret: false }));
  const { root } = project;
  await writeArchitecture(join(root, "opscrew", "architecture.json"), "shop");
  await writeArtifact("app", join(root, "opscrew", "apps", "docs", "app.yaml"), {
    schemaVersion: 1,
    dir: ".",
  });
  await writeArchitecture(join(root, "opscrew", "apps", "docs", "architecture.json"), "docs");
  const docsPlan = appPlan("docs", undefined, testPlan({ userSecret: false }));
  await writeArtifact("plan", join(root, "opscrew", "apps", "docs", "plan.yaml"), docsPlan);
  const github = new FakeDestroyGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  const env = {
    ...process.env,
    OPSCREW_HOME: join(root, ".home-opscrew"),
    HCLOUD_TOKEN: HCLOUD,
    CLOUDFLARE_API_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  };
  const depsOf = async (app?: string) => {
    const deps = await createTestPhaseDeps({
      root,
      env,
      runner: projectRunner(),
      approvalHandler: handler,
      ...(app === undefined ? {} : { app }),
    });
    deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
    return deps;
  };
  const provisionServices = (engine: FakeEngine): ProvisionServices => ({
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(),
  });
  return { ...project, github, handler, depsOf, provisionServices, docsPlan };
}

/** Every user-visible or persisted text of `deps`'s run. */
const printed = (deps: TestPhaseDeps) =>
  `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;

describe.skipIf(!findExecutable("git"))("two apps in one repository, provisioned on fakes", () => {
  it("provisions each on its own: its files, secrets, state, approvals and branch", async () => {
    const s = await twoServerApps();
    const shop = await s.depsOf();
    const shopEngine = new FakeEngine();
    const first = await runProvision(shop, { services: s.provisionServices(shopEngine) });
    const shopSecrets = [...s.github.secrets.keys()].sort();
    // The pull request is merged, and the next app's files start from the latest main.
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "--ff-only", "opscrew/deploy-setup");
    const docs = await s.depsOf("docs");
    const docsEngine = new FakeEngine();
    s.handler.requests.length = 0;
    const second = await runProvision(docs, { services: s.provisionServices(docsEngine) });

    // Branches, workflows, infrastructure and runtime folders of their own.
    expect([first.branch, second.branch]).toEqual([
      "opscrew/deploy-setup",
      "opscrew/deploy-setup-docs",
    ]);
    expect(s.github.pulls.map((pull) => pull.head)).toEqual([
      "opscrew/deploy-setup",
      "opscrew/deploy-setup-docs",
    ]);
    for (const file of [
      ".github/workflows/opscrew-deploy-docs.yml",
      "opscrew/infra/docs/main.tf",
      "opscrew/apps/docs/runtime/compose.yaml",
    ]) {
      await expect(readFile(join(s.root, file), "utf8")).resolves.toContain("OpsCrew");
    }
    const workflow = await readFile(
      join(s.root, ".github/workflows/opscrew-deploy-docs.yml"),
      "utf8",
    );
    expect(workflow).toContain("name: OpsCrew deploy docs");
    expect(workflow).not.toMatch(/secrets\.OPSCREW_(?!DOCS_)[A-Z]/);

    // Secrets: the first app's are as they were, the further app's carry its key.
    const docsSecrets = [...s.github.secrets.keys()].filter((name) => !shopSecrets.includes(name));
    expect(docsSecrets.sort()).toEqual(
      shopSecrets.map((name) => `OPSCREW_DOCS_${name.slice("OPSCREW_".length)}`).sort(),
    );
    expect(docsSecrets).toContain("OPSCREW_DOCS_SSH_PRIVATE_KEY");
    expect(shopSecrets.some((name) => name.startsWith("OPSCREW_DOCS_"))).toBe(false);

    // State: each app's infrastructure state and records in its own folders.
    expect(shopEngine.initOptions?.backendConfig?.path).toBe(tfstateFile(shop.paths));
    expect(docsEngine.initOptions?.backendConfig?.path).toBe(
      join(s.root, ".opscrew", "apps", "docs", "tfstate", "prod.tfstate"),
    );
    expect(docs.paths.files.deployKey).toBe(
      join(s.root, ".home-opscrew", "projects", docs.paths.projectId, "apps", "docs", "deploy_key"),
    );
    expect(await exists(docs.paths.files.deployKey)).toBe(true);
    expect(await exists(shop.paths.files.deployKey)).toBe(true);

    // Approvals: each app's own plan, by its own hash, recorded in its own plan.
    const iac = s.handler.requests.filter((request) => request.kind === "iac-apply");
    expect(iac.map((request) => request.planHash)).toEqual([second.planHash]);
    expect(second.planHash).not.toBe(first.planHash);
    const shopPlan = await readArtifact("plan", shop.paths.files.plan);
    const docsPlan = await readArtifact("plan", docs.paths.files.plan);
    expect(shopPlan.deployment.lastPlanHash).toBe(first.planHash);
    expect(docsPlan.deployment.lastPlanHash).toBe(second.planHash);

    // The repository's one Dependabot file covers both apps.
    const dependabot = await readFile(join(s.root, ".github/dependabot.yml"), "utf8");
    expect(dependabot).toContain("- /opscrew/runtime\n");
    expect(dependabot).toContain("- /opscrew/apps/docs/runtime\n");
    for (const text of [printed(shop), printed(docs)]) expect(text).not.toContain(HCLOUD);
  });

  it("keeps each app's approvals, state and costs in its own files", () => {
    const input = {
      root: "/repo",
      env: { OPSCREW_HOME: "/home/dev/.opscrew" },
      reporter: new MemoryReporter(),
      redactor: new Redactor(),
      approvalHandler: new ScriptedApprovalHandler(),
      runner: new ScriptedRunner(),
      fetch: forbiddenFetch,
      clock: { now: () => new Date() },
      interactive: false,
      version: "0.0.0-test",
    };
    const files = (app?: string) => {
      const { paths } = buildPhaseDeps({ ...input, ...(app === undefined ? {} : { app }) });
      return [paths.files.approvals, paths.files.state, paths.files.costs, paths.files.plan];
    };
    const [shop, docs] = [files(), files("docs")];
    for (const [i, file] of docs.entries()) {
      expect(file).not.toBe(shop[i]);
      expect(file.split(/[\\/]/).join("/")).toContain("/apps/docs/");
    }
  });

  it("destroying one app leaves the other's resources, secrets and files", async () => {
    const s = await twoServerApps();
    const deployed = (plan: DeployPlan): DeployPlan => ({
      ...plan,
      deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z", lastPlanHash: "a".repeat(64) },
    });
    const shopPlan = deployed(testPlan({ userSecret: false }));
    const docsPlan = deployed(s.docsPlan);
    await writeArtifact("plan", join(s.root, "opscrew", "plan.yaml"), shopPlan);
    await writeArtifact("plan", join(s.root, "opscrew", "apps", "docs", "plan.yaml"), docsPlan);
    const shop = await s.depsOf();
    const docs = await s.depsOf("docs");
    for (const [deps, plan] of [
      [shop, shopPlan],
      [docs, docsPlan],
    ] as const) {
      for (const name of deploySecretNames(plan)) s.github.secrets.set(name, "stored");
      await mkdir(dirname(deps.paths.files.deploySecrets), { recursive: true });
      await writeFile(
        deps.paths.files.deploySecrets,
        `${JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names: deploySecretNames(plan) })}\n`,
      );
      await ensureStatePassphrase(deps.paths);
      await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
      await writeFile(tfstateFile(deps.paths), '{"version":4,"resources":[]}\n');
      await mkdir(join(s.root, plan.infra.dir), { recursive: true });
      await writeFile(join(s.root, plan.infra.dir, "main.tf"), "# OpsCrew\n");
      await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
      await writeArtifact("plan", deps.paths.files.plan, plan);
    }
    const shopSecrets = deploySecretNames(shopPlan).sort();
    const engine = new ScriptedDestroyEngine();
    const services: DestroyServices = {
      engine: async () => engine,
      provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
      servers: new FakeServers(),
      cloudflare: fakeCloudflare(),
      github: s.github,
      sleep: async () => undefined,
    };
    const result = await runDestroy(docs, { services, snapshot: false });

    // Only the app's own infrastructure state.
    expect(engine.initOptions?.backendConfig?.path).toBe(tfstateFile(docs.paths));
    expect(result.secretsRemoved.sort()).toEqual(deploySecretNames(docsPlan).sort());
    // What remains names the app's own images, files and command.
    expect(result.remaining).toContain(
      "The app's container images in GitHub's container registry (ghcr.io/acme/shop/docs). Delete them in the package settings on GitHub if you no longer need them.",
    );
    expect(result.remaining).toContain(
      "The deployment files in the repository (opscrew/apps/docs/ and .github/workflows/opscrew-deploy-docs.yml). Pushes still build an image, but the deploy step fails until `opscrew provision --app docs` creates a new server from these files.",
    );
    expect([...s.github.secrets.keys()].sort()).toEqual(shopSecrets);
    expect(
      (await readArtifact("plan", docs.paths.files.plan)).deployment.destroyedAt,
    ).toBeDefined();
    expect(await readArtifact("plan", shop.paths.files.plan)).toEqual(shopPlan);
    await expect(readFile(tfstateFile(shop.paths), "utf8")).resolves.toContain('"version":4');
    await expect(readFile(join(s.root, "opscrew/infra/prod/main.tf"), "utf8")).resolves.toBe(
      "# OpsCrew\n",
    );
    expect(await exists(shop.paths.files.deploySecrets)).toBe(true);
    expect(await exists(shop.paths.files.knownHosts)).toBe(true);
  });
});
