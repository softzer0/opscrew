import { describe, expect, it } from "vitest";
import { previewProject } from "../previews/__fixtures__/plan";
import { runRetarget } from "./run";

describe("retarget in a preview environment", () => {
  it("refuses plainly before any change", async () => {
    const { deps } = await previewProject();
    await expect(runRetarget(deps, { to: "digitalocean" })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/^preview is a preview environment.*Nothing was changed\.$/),
    });
    expect(await deps.state.read()).toMatchObject({ phases: {} });
    expect(deps.approvalHandler).toMatchObject({ requests: [] });
  });
});
