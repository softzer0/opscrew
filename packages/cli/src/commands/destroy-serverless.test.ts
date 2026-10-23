import path from "node:path";
import { testPlan } from "@opscrew/agents/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

// Feature 016: destroy comes for the server-less targets with T1610b; until then it is refused.
describe.each([
  ["Cloudflare hosting", "cloudflare-workers"],
  ["GitHub Pages", "github-pages"],
] as const)("opscrew destroy for %s", (name, provider) => {
  it("is refused plainly before anything is asked or checked", async () => {
    project = await tempProject();
    const site = { tool: "none", outputDir: "site" } as const;
    const plan = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      app: { ...testPlan().app, name: "example-app", env: [] },
      target:
        provider === "github-pages"
          ? { provider, mode: "pages-workflow", site }
          : {
              provider,
              mode: "workers-assets",
              worker: "example-app",
              render: "static",
              notFound: "404-page",
              site,
            },
      services: [],
      dns: {
        provider: "cloudflare",
        domain: "docs.example.com",
        proxied: provider === "cloudflare-workers",
      },
      security: { wafCustomRules: provider === "cloudflare-workers" },
    });
    await writeArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"), plan);
    // Even a --confirm that does not match is never checked: the refusal comes first.
    for (const flags of [[], ["--confirm", "example-app"], ["--confirm", "other"]]) {
      const ctx = projectContext(project);
      expect(await run(ctx, "destroy", ...flags), flags.join(" ")).not.toBe(0);
      expect(ctx.errors, flags.join(" ")).toContain(
        `\`opscrew destroy\` is not available for ${name} yet.`,
      );
      expect(ctx.errors, flags.join(" ")).not.toContain("does not match");
      expect(ctx.fetchUrls).toEqual([]);
    }
  });
});
