import path from "node:path";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  FakeEngine,
  FakeGitHub,
  planJsonFor,
  provisionServices,
} from "../ui/__fixtures__/deploy";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

function context(p: DeployProject, engine = new FakeEngine()) {
  const ctx = projectContext(p, { services: { runner: new DeployRunner() } });
  withServices(ctx, { provision: provisionServices(engine, new FakeGitHub()) });
  return { ctx, engine };
}

describe.skipIf(GIT === undefined)("opscrew dns", () => {
  it("--domain puts the app behind Cloudflare and prints the hash to approve", async () => {
    project = await deployProject();
    const engine = new FakeEngine({ planJson: planJsonFor({ proxied: true }) });
    const { ctx } = context(project, engine);
    expect(await run(ctx, "dns", "--domain", "Shop.Example.com", "--plan-only", "--yes")).toBe(0);

    const plan = await readArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"));
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: "shop.example.com",
      proxied: true,
      zone: "example.com",
    });
    expect(plan.security.httpAllowedFrom).toBe("cloudflare");
    expect(engine.calls).toEqual(["init", "validate", "plan"]);
    expect(ctx.output).toContain("https://shop.example.com through Cloudflare");
    expect(ctx.output).toMatch(/ {4}opscrew dns --approve [0-9a-f]{64} --yes\n/);
  });

  it("exits 2 for an invalid domain or when there is no domain at all", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "dns", "--domain", "https://shop.example.com/x")).toBe(2);
    expect(ctx.errors).toContain("is not a valid domain name");
    expect(await run(ctx, "dns")).toBe(2);
    expect(ctx.errors).toContain("opscrew dns --domain app.example.com");
    expect(engine.calls).toEqual([]);
  });
});
