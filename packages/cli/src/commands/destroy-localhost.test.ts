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

describe("opscrew destroy for the localhost target", () => {
  it("in a script, needs the app's name with --confirm before anything runs", async () => {
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
    for (const [flags, message] of [
      [[], "Removing the app needs the app's name typed by a person"],
      [["--delete-data"], "Removing the app needs the app's name typed by a person"],
      [["--undo-host"], "on this computer OpsCrew changes nothing outside its own folders"],
      [["--confirm", "other"], "--confirm other does not match the app's name"],
    ] as const) {
      const ctx = projectContext(project);
      expect(await run(ctx, "destroy", ...flags), flags.join(" ")).not.toBe(0);
      expect(ctx.errors, flags.join(" ")).toContain(message);
      expect(ctx.fetchUrls).toEqual([]);
    }
  });
});
