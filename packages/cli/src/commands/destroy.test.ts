import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  testPlan,
} from "../ui/__fixtures__/deploy";
import { DestroyEngine, destroyServices } from "../ui/__fixtures__/destroy";
import { CANCEL, GIT, projectContext, run, ScriptedPrompts } from "../ui/__fixtures__/harness";
import { withDeployServices } from "../ui/deploy-services";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Answers yes to whatever reaches it and records the requests. */
class RecordingApprovals implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: "2026-10-12T12:00:00.000Z" };
  }
}

async function setup(options: { interactive?: boolean; typed?: unknown } = {}) {
  project = await deployProject(testPlan({ deployed: true, httpAllowedFrom: "any" }));
  const approvals = new RecordingApprovals();
  const prompts = new ScriptedPrompts(options.typed === undefined ? [] : [options.typed]);
  const ctx = projectContext(project, {
    interactive: options.interactive ?? false,
    services: { runner: new DeployRunner(), approvalHandler: approvals, prompts },
  });
  const paths = resolveProjectPaths(project.root, { env: ctx.env });
  await mkdir(paths.files.tfstateDir, { recursive: true });
  await writeFile(
    path.join(paths.files.tfstateDir, "prod.tfstate"),
    '{"version":4,"resources":[{}]}',
  );
  await mkdir(path.join(project.root, "opscrew/infra/prod"), { recursive: true });
  await writeFile(
    path.join(project.root, "opscrew/infra/prod/variables.tf"),
    'variable "delete_protection" {\n  type    = bool\n  default = true\n}\n',
  );
  await mkdir(paths.projectHomeDir, { recursive: true });
  await writeFile(
    paths.files.statePassphrase,
    `${"p".repeat(43)}
`,
  );
  const engine = new DestroyEngine();
  const fakes = destroyServices(engine);
  withDeployServices(ctx, { destroy: fakes.services });
  return { ctx, engine, fakes, approvals, prompts, paths };
}

describe.skipIf(!GIT)("opscrew destroy", () => {
  it("names no provider in --help", async () => {
    const { ctx } = await setup();
    expect(await run(ctx, "destroy", "--help")).toBe(0);
    expect(ctx.output).toContain("Take a snapshot of the server first");
    expect(ctx.output).toContain("Do not take a snapshot of the server first");
    expect(ctx.output).not.toMatch(/hetzner|digitalocean/i);
  });

  it("refuses a non-interactive run without --confirm and says how to run it", async () => {
    const { ctx, engine, fakes } = await setup();
    expect(await run(ctx, "destroy")).toBe(1);
    expect(ctx.errors).toContain("opscrew destroy --confirm shop");
    expect(engine.applied).toEqual([]);
    expect(fakes.snapshots).toEqual([]);
  });

  it("refuses a --confirm that is not the server name before anything happens", async () => {
    const { ctx, engine, fakes } = await setup();
    expect(await run(ctx, "destroy", "--confirm", "shpo")).toBe(1);
    expect(ctx.errors).toContain("does not match the server name");
    expect(engine.applied).toEqual([]);
    expect(fakes.snapshots).toEqual([]);
  });

  it("tears everything down without prompts with --confirm <server name>", async () => {
    const { ctx, engine, fakes, approvals, paths } = await setup();
    expect(await run(ctx, "destroy", "--confirm", "shop")).toBe(0);
    expect(fakes.snapshots).toEqual([4711]);
    expect(engine.applied).toEqual(["unprotect", "destroy"]);
    expect(fakes.deletedSecrets).toContain("OPSCREW_HOST");
    expect(approvals.requests).toEqual([]);
    const plan = await readArtifact("plan", paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.deployment.serverIpv4).toBeUndefined();
    expect(ctx.output).toContain("`opscrew provision` to deploy again");
  });

  it("skips the snapshot when no data lives only on the server, unless --snapshot asks", async () => {
    const { ctx, fakes, paths } = await setup();
    const plan = await readArtifact("plan", paths.files.plan);
    await writeArtifact("plan", paths.files.plan, {
      ...plan,
      services: { ...plan.services, postgres: false },
      target: { ...plan.target, backups: false },
    });
    expect(await run(ctx, "destroy", "--confirm", "shop", "--snapshot")).toBe(0);
    expect(fakes.snapshots).toEqual([4711]);
  });

  it("takes no snapshot by default when no data lives only on the server", async () => {
    const { ctx, engine, fakes, paths } = await setup();
    const plan = await readArtifact("plan", paths.files.plan);
    await writeArtifact("plan", paths.files.plan, {
      ...plan,
      services: { ...plan.services, postgres: false },
      target: { ...plan.target, backups: false },
    });
    expect(await run(ctx, "destroy", "--confirm", "shop")).toBe(0);
    expect(fakes.snapshots).toEqual([]);
    expect(engine.applied).toEqual(["unprotect", "destroy"]);
  });

  it("changes nothing when the typed name is wrong, not even a snapshot", async () => {
    const { ctx, engine, fakes, prompts } = await setup({ interactive: true, typed: "shpo" });
    expect(await run(ctx, "destroy")).toBe(1);
    expect(prompts.calls[0]?.message).toContain("Type shop to delete everything listed above");
    expect(ctx.errors).toContain("nothing was deleted and nothing was changed");
    expect(engine.applied).toEqual([]);
    expect(fakes.snapshots).toEqual([]);
  });

  it("changes nothing when the prompt is cancelled", async () => {
    const { ctx, engine } = await setup({ interactive: true, typed: CANCEL });
    expect(await run(ctx, "destroy")).toBe(1);
    expect(engine.applied).toEqual([]);
  });

  it("deletes after the typed name and still asks before removing the GitHub secrets", async () => {
    const { ctx, engine, fakes, approvals } = await setup({ interactive: true, typed: "shop" });
    expect(await run(ctx, "destroy", "--no-snapshot")).toBe(0);
    expect(fakes.snapshots).toEqual([]);
    expect(engine.applied).toEqual(["unprotect", "destroy"]);
    expect(approvals.requests.map((r) => r.kind)).toEqual(["github-secrets"]);
    expect(ctx.output).toContain("confirmed with the server name");
  });
});
