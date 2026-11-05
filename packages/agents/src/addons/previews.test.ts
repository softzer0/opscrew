import { describe, expect, it } from "vitest";
import { previewProject } from "../previews/__fixtures__/plan";
import { addonEnable } from "./run";

describe("addon enable in a preview environment", () => {
  it("refuses every add-on plainly before any change", async () => {
    const { deps, plan } = await previewProject();
    for (const kind of ["beszel", "grafana-cloud", "monitoring"] as const) {
      await expect(addonEnable(deps, plan, kind)).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringMatching(/^preview is a preview environment.*Nothing was changed\.$/),
      });
    }
    expect(deps.approvalHandler).toMatchObject({ requests: [] });
  });
});
