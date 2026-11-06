import { describe, expect, it } from "vitest";
import { previewProject } from "../previews/__fixtures__/plan";
import { rollback } from "./index";

describe("rollback in a preview environment", () => {
  it("refuses plainly before any change, even --list and --resume", async () => {
    const { deps } = await previewProject();
    const choices = [{ database: "snapshot" }, { database: "migrations" }] as const;
    for (const options of [{}, { list: true }, { resume: true }, ...choices]) {
      await expect(rollback(deps, options)).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringMatching(/^preview is a preview environment.*Nothing was changed\.$/),
      });
    }
    expect(deps.approvalHandler).toMatchObject({ requests: [] });
  });
});
