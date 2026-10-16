import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deploymentRenderContext, ensureDeployKey, writeRenderedFiles } from "@opscrew/agents";
import { FakeEngine, FakeGitHub, testPlan } from "@opscrew/agents/testing";
import type { PlanSummary, ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { renderDeployment } from "@opscrew/iac-templates";
import { afterEach, describe, expect, it } from "vitest";
import { createPhaseDeps, withServices } from "../deps";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  provisionServices,
} from "../ui/__fixtures__/deploy";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Refresh-only plans report `drift`; normal plans report `pending`. Records whether apply ran. */
class DriftEngine extends FakeEngine {
  constructor(readonly found: { drift?: ResourceDrift[]; pending?: ResourceChange[] } = {}) {
    super({ changes: found.pending ?? [] });
  }

  override async plan(
    dir: string,
    planFile: string,
    options?: { refreshOnly?: boolean },
  ): Promise<PlanSummary> {
    const summary = await super.plan(dir, planFile);
    if (options?.refreshOnly) {
      return {
        ...summary,
        changes: [],
        counts: { create: 0, update: 0, delete: 0, replace: 0 },
        hasDestroy: false,
        ...(this.found.drift?.length ? { drift: this.found.drift } : {}),
      };
    }
    return summary;
  }
}

const FIREWALL: ResourceDrift = {
  address: "module.server.hcloud_firewall.this",
  type: "hcloud_firewall",
  name: "this",
  provider: "registry.opentofu.org/hetznercloud/hcloud",
  action: "update",
  attributes: ["rule"],
};

async function setup(engine: DriftEngine) {
  project = await deployProject(
    testPlan({ deployed: true, httpAllowedFrom: "any", userSecret: false }),
  );
  const ctx = projectContext(project, { services: { runner: new DeployRunner() } });
  const paths = resolveProjectPaths(project.root, { env: ctx.env });
  await mkdir(paths.files.tfstateDir, { recursive: true });
  await writeFile(
    path.join(paths.files.tfstateDir, "prod.tfstate"),
    '{"encryption_version":"v0","encrypted_data":"opaque"}',
  );
  await mkdir(paths.projectHomeDir, { recursive: true });
  await writeFile(paths.files.statePassphrase, `${"p".repeat(43)}\n`);
  // A deployed project has its deploy key; drift reads it and never creates one.
  await ensureDeployKey(paths);
  withServices(ctx, {
    provision: provisionServices(engine, new FakeGitHub(), { cloudflare: null }),
  });
  return ctx;
}

describe.skipIf(!GIT)("opscrew drift", () => {
  it("exits 0 when the infrastructure, the state and the files all match", async () => {
    const engine = new DriftEngine();
    const ctx = await setup(engine);
    const deps = createPhaseDeps(ctx, { ai: false });
    const plan = testPlan({ deployed: true, httpAllowedFrom: "any", userSecret: false });
    const key = await ensureDeployKey(deps.paths);
    const files = renderDeployment(
      plan,
      deploymentRenderContext(deps, {
        plan,
        requirements: undefined,
        github: { owner: "acme", repo: "shop" },
        deployPublicKey: key.publicKeyOpenSsh,
        cloudflare: undefined,
      }),
    );
    await writeRenderedFiles((project as DeployProject).root, files);
    expect(await run(ctx, "drift")).toBe(0);
    expect(ctx.output).toContain("nothing to do");
    // The next step names the deployment's provider.
    expect(ctx.output).toContain("changes in the Hetzner Cloud or Cloudflare console");
    expect(engine.calls).not.toContain("apply");
  });

  it("reports changes made outside OpsCrew and exits 1 without applying anything", async () => {
    const engine = new DriftEngine({ drift: [FIREWALL] });
    const ctx = await setup(engine);
    expect(await run(ctx, "drift")).toBe(1);
    expect(ctx.output).toContain("module.server.hcloud_firewall.this");
    expect(ctx.output).toContain("rule");
    expect(ctx.output).toContain("`opscrew provision`");
    expect(engine.calls).not.toContain("apply");
  });

  it("prints the report as JSON with --json", async () => {
    const engine = new DriftEngine({ drift: [FIREWALL] });
    const ctx = await setup(engine);
    expect(await run(ctx, "drift", "--json")).toBe(1);
    const report = JSON.parse(ctx.output) as { clean: boolean; drift: ResourceDrift[] };
    expect(report.clean).toBe(false);
    expect(report.drift.map((d) => d.address)).toEqual([FIREWALL.address]);
  });

  it("reports generated files that are missing from the repository", async () => {
    const ctx = await setup(new DriftEngine());
    // the generated files were never written in this project, so OpsCrew would add them
    expect(await run(ctx, "drift")).toBe(1);
    expect(ctx.output).toContain("opscrew/infra/prod/main.tf");
  });

  it("exits 2 with the copy hint when the state is not on this computer, before any plan", async () => {
    const engine = new DriftEngine();
    const ctx = await setup(engine);
    const paths = resolveProjectPaths((project as DeployProject).root, { env: ctx.env });
    await writeFile(path.join(paths.files.tfstateDir, "prod.tfstate"), "");
    expect(await run(ctx, "drift")).toBe(2);
    expect(ctx.errors).toContain(".opscrew/tfstate");
    expect(engine.calls).toEqual([]);
  });
});
