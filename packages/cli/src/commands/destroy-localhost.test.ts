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

// Feature 015: the localhost target is in the schema (T1501a) before its flows (T1510).
describe("opscrew destroy for the localhost target", () => {
  it("refuses plainly before checking its flags or asking for a name", async () => {
    project = await tempProject();
    const plan = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "amd64",
        ports: { https: 443, http: 80 },
        image: "registry",
      },
    });
    await writeArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"), plan);
    for (const flags of [[], ["--delete-data"], ["--undo-host"], ["--confirm", "shop"]]) {
      const ctx = projectContext(project);
      expect(await run(ctx, "destroy", ...flags), flags.join(" ")).not.toBe(0);
      expect(ctx.errors, flags.join(" ")).toContain(
        "`opscrew destroy` is not supported for the localhost target yet.",
      );
      expect(ctx.fetchUrls).toEqual([]);
    }
  });
});
