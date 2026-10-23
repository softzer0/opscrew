import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { exists, findExecutable, OpsCrewError, tfstateFile } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { blobOf } from "../promote/__fixtures__/world";
import { previewDeploymentFiles } from "../provision/render";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";

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
import { setEnvironmentBranch } from "./branches";
import { environmentPaths } from "./paths";
import { setDeploySource } from "./source";

const HCLOUD = "hcloud-test-token-not-a-real-value";

/** `prod` as the plan of the environment `name`, as design writes it. */
function namedOf(prod: DeployPlan, name: string, app: Partial<DeployPlan["app"]> = {}): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name },
    app: { ...prod.app, name: `${prod.app.name}-${name}`, ...app },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
  });
}

/** `prod` as staging's plan, as design writes it. */
function stagingOf(prod: DeployPlan, app: Partial<DeployPlan["app"]> = {}): DeployPlan {
  return namedOf(prod, "staging", app);
}

/** `prod` as the plan of the environment `name`, promoted from `source`. */
function promotedOf(prod: DeployPlan, name: string, source: string): DeployPlan {
  const plan = namedOf(prod, name);
  return DeployPlanSchema.parse({
    ...plan,
    environment: { ...plan.environment, deploySource: { from: "promote", source } },
  });
}

/** An app in prod (provisioned here unless `provisioned` is false), and its environments' deps. */
async function appInProd(prod = testPlan({ userSecret: false }), provisioned = true) {
  const project = await createProject(prod);
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
  const services = (engine: FakeEngine): ProvisionServices => ({
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github: new FakeGitHub(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
  });
  const prodDeps = await deps();
  if (provisioned) {
    await runProvision(prodDeps, { services: services(new FakeEngine()) });
    // The user merges prod's pull request and goes back to the updated main.
    const { git, root } = project;
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--ff-only", "opscrew/deploy-setup");
    await git(root, "push", "-q", "origin", "main");
  }
  return { ...project, prod, prodDeps, deps, services };
}

const handlerOf = (deps: TestPhaseDeps) => deps.approvalHandler as ScriptedApprovalHandler;

describe.skipIf(!findExecutable("git"))("provision for an environment", () => {
  it("provisions staging with its own state, files and key, and prod has nothing to apply", async () => {
    const app = await appInProd();
    const { root, prodDeps } = app;
    const prodPlanBytes = await readFile(prodDeps.paths.files.plan, "utf8");
    const prodServer = await readFile(join(prodDeps.paths.stateDir, "server.json"), "utf8");
    const before = await previewDeploymentFiles(prodDeps, {
      services: app.services(new FakeEngine()),
    });
    expect([...before.created, ...before.changed]).toEqual([]);

    const staging = await app.deps("staging");
    const paths = environmentPaths(prodDeps.paths, "staging");
    await writeArtifact("plan", paths.files.plan, stagingOf(app.prod));
    const engine = new FakeEngine();
    const result = await runProvision(staging, { services: app.services(engine) });
    expect(result.applied).toBe(true);

    // staging's own state, infrastructure root, runtime folder, workflow and deploy key.
    expect(engine.initOptions?.backendConfig?.path).toBe(tfstateFile(paths));
    expect(tfstateFile(paths)).toBe(
      join(root, ".opscrew", "environments", "staging", "tfstate", "staging.tfstate"),
    );
    for (const file of [
      "opscrew/infra/staging/main.tf",
      "opscrew/environments/staging/runtime/compose.yaml",
      ".github/workflows/opscrew-deploy-staging.yml",
    ]) {
      expect(await exists(join(root, file))).toBe(true);
    }
    expect(await exists(paths.files.deployKey)).toBe(true);
    expect(await readFile(paths.files.deployKey, "utf8")).not.toBe(
      await readFile(prodDeps.paths.files.deployKey, "utf8"),
    );
    expect(handlerOf(staging).requests.map((r) => r.kind)).toContain("iac-apply");
    expect((await staging.state.read()).phases.provision?.status).toBe("ok");

    // Prod's plan, record and files are as they were: nothing to apply there.
    expect(await readFile(prodDeps.paths.files.plan, "utf8")).toBe(prodPlanBytes);
    expect(await readFile(join(prodDeps.paths.stateDir, "server.json"), "utf8")).toBe(prodServer);
    const after = await previewDeploymentFiles(prodDeps, {
      services: app.services(new FakeEngine()),
    });
    expect([...after.created, ...after.changed]).toEqual([]);
    expect(after.unchanged).toEqual(before.unchanged);
  });

  it("checks a promoted environment's images against its builder's branch, and drift then finds nothing to apply (FR-1537)", async () => {
    const app = await appInProd();
    const { root, prodDeps } = app;
    // dev follows develop; staging is promoted from dev.
    const dev = DeployPlanSchema.parse({
      ...namedOf(app.prod, "dev"),
      cicd: { ...namedOf(app.prod, "dev").cicd, branch: "develop" },
    });
    await writeArtifact("plan", environmentPaths(prodDeps.paths, "dev").files.plan, dev);
    const staging = await app.deps("staging");
    await writeArtifact("plan", staging.paths.files.plan, promotedOf(app.prod, "staging", "dev"));
    await runProvision(staging, { services: app.services(new FakeEngine()) });

    const workflow = await readFile(
      join(root, ".github/workflows/opscrew-deploy-staging.yml"),
      "utf8",
    );
    expect(workflow).toContain('          BUILD_BRANCH: "develop"\n');
    const preview = await previewDeploymentFiles(staging, {
      services: app.services(new FakeEngine()),
    });
    expect([...preview.created, ...preview.changed]).toEqual([]);
    expect(preview.unchanged).toContain(".github/workflows/opscrew-deploy-staging.yml");
  });

  it("publishes a promoted environment into the default branch, not the branch it kept (FR-1537)", async () => {
    const app = await appInProd();
    const { root, bare, git, prodDeps } = app;
    // staging followed its own branch staging (`env add staging --branch staging`)...
    await git(root, "push", "-q", "origin", "main:staging");
    await writeArtifact(
      "plan",
      environmentPaths(prodDeps.paths, "dev").files.plan,
      namedOf(app.prod, "dev"),
    );
    const staging = await app.deps("staging");
    await writeArtifact("plan", staging.paths.files.plan, namedOf(app.prod, "staging"));
    expect((await setEnvironmentBranch(staging, "staging")).cicd.branch).toBe("staging");
    // ...and is then promoted from dev (`env set staging --from dev`).
    const promoted = await setDeploySource(root, "staging", "dev");
    expect(promoted.cicd.branch).toBe("staging");

    const services = app.services(new FakeEngine());
    const result = await runProvision(staging, { services });
    expect(result.base).toBe("main");
    const github = services.github as FakeGitHub;
    expect(github.pulls.map((pull) => pull.base)).toEqual(["main"]);

    // Merged, the workflow on main is the one staging's plan generates, as `opscrew promote` checks.
    const path = ".github/workflows/opscrew-deploy-staging.yml";
    const head = github.pulls[0]?.head ?? "";
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--ff-only", head);
    await git(root, "push", "-q", "origin", "main");
    const rendered = (await readFile(join(root, path), "utf8")).replace(/\r\n/g, "\n");
    expect(await git(bare, "rev-parse", `main:${path}`)).toBe(blobOf(rendered));
    expect(
      await git(bare, "ls-tree", "--name-only", "staging", ".github/workflows/"),
    ).not.toContain("opscrew-deploy-staging.yml");
  });

  it("refuses staging promoted from prod when its shared parts differ from prod's, before anything", async () => {
    const app = await appInProd();
    const staging = await app.deps("staging");
    const promoted = promotedOf(app.prod, "staging", "prod");
    await writeArtifact(
      "plan",
      staging.paths.files.plan,
      DeployPlanSchema.parse({
        ...promoted,
        app: { ...promoted.app, port: 9999, healthPath: "/up" },
      }),
    );
    const engine = new FakeEngine();
    const error = await runProvision(staging, { services: app.services(engine) }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The staging environment runs prod's image, and its plan differs from prod's in what every environment shares: app.port and app.healthPath. Nothing was changed.",
      hint: "Run `opscrew design --env staging` to take them from prod's plan, then run the command again.",
    });
    expect(engine.calls).toEqual([]);
    expect(handlerOf(staging).requests).toEqual([]);
    expect(await exists(join(app.root, "opscrew/infra/staging"))).toBe(false);
  });

  it("refuses either environment's provision while the other holds its hostname", async () => {
    const app = await appInProd(testPlan({ userSecret: false, domain: "shop.example.com" }), false);
    const staging = await app.deps("staging");
    // Design gave staging its own hostname; plan.yaml was edited back to prod's.
    await writeArtifact("plan", staging.paths.files.plan, stagingOf(app.prod));
    const engine = new FakeEngine();
    const error = await runProvision(staging, { services: app.services(engine) }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "shop.example.com is already the prod environment's hostname, and every environment needs its own. Nothing was changed.",
    });
    expect(engine.calls).toEqual([]);
    expect(handlerOf(staging).requests).toEqual([]);

    // From prod's side too: prod's provision is refused while staging holds that hostname.
    const fromProd = await runProvision(app.prodDeps, { services: app.services(engine) }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(fromProd).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "shop.example.com is already the staging environment's hostname, and every environment needs its own. Nothing was changed.",
    });
    expect(engine.calls).toEqual([]);
    expect(handlerOf(app.prodDeps).requests).toEqual([]);
  });
});
