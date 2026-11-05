import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments";
import { previewProject } from "../previews/__fixtures__/plan";
import { testPlan } from "../testing";
import { promote } from "./run";

describe("promote and preview environments", () => {
  it("refuses to promote to a preview environment, before any change", async () => {
    const { deps } = await previewProject();
    await expect(promote(deps, { target: "preview" })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/^preview is a preview environment.*Nothing was changed\.$/),
    });
    expect(deps.approvalHandler).toMatchObject({ requests: [] });
  });

  it("refuses to promote from a preview environment (the environments' check), before any change", async () => {
    const { deps } = await previewProject();
    const base = testPlan({ deployed: true });
    const staging = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging", deploySource: { from: "promote", source: "preview" } },
    });
    await writeArtifact("plan", environmentPaths(deps.paths, "staging").files.plan, staging);
    await expect(promote(deps, { target: "staging" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining('promoted from "preview", a preview environment'),
    });
    expect(deps.approvalHandler).toMatchObject({ requests: [] });
  });
});
