import { join } from "node:path";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { createTestPhaseDeps, testPlan } from "../testing";
import { deploymentFiles, deploymentRenderContext } from "./render";

/** The render input of a server app with no Cloudflare and no known server. */
const inputFor = (plan: DeployPlan) => ({
  plan,
  requirements: undefined,
  github: { owner: "acme", repo: "shop" },
  deployPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey opscrew",
  cloudflare: undefined,
});

/** The push filter of the deploy workflow provision renders for `plan`. */
async function pushFilter(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const files = deploymentFiles(plan, await deploymentRenderContext(deps, inputFor(plan)));
  const flow = files.find((file) => file.path === plan.cicd.workflowPath);
  return (parse(flow?.content ?? "") as { on: { push: { paths: string[] } } }).on.push.paths;
}

describe("deploymentRenderContext and the repository's other apps", () => {
  it("leaves another app's folder out of the push filter of an app at the repository root", async () => {
    const deps = await createTestPhaseDeps();
    // The repository's first app, at its root (no requirements or facts name another folder).
    const plan = testPlan();
    expect(plan.app.buildContext).toBe(".");
    expect((await deploymentRenderContext(deps, inputFor(plan))).otherAppDirs).toBeUndefined();
    expect(await pushFilter(deps, plan)).not.toContain("!sites/docs/**");

    await writeArtifact("app", join(deps.paths.root, "opscrew", "apps", "docs", "app.yaml"), {
      schemaVersion: 1,
      dir: "sites/docs",
    });
    expect((await deploymentRenderContext(deps, inputFor(plan))).otherAppDirs).toEqual([
      "sites/docs",
    ]);
    const filter = await pushFilter(deps, plan);
    expect(filter.slice(0, 4)).toEqual([
      "**",
      "!opscrew/**",
      "!.github/workflows/opscrew-deploy*.yml",
      "!sites/docs/**",
    ]);

    // The further app's render names neither its own folder nor the root, which holds it.
    const docs = await createTestPhaseDeps({ root: deps.paths.root, env: deps.env, app: "docs" });
    expect((await deploymentRenderContext(docs, inputFor(plan))).otherAppDirs).toBeUndefined();
  });
});
