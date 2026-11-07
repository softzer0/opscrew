import { testPlan } from "@opscrew/agents/testing";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import { projectContext, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { runInfraCommand } from "./provision";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

describe("opscrew provision --plan-only and the off-server copies' bucket", () => {
  it("lists the backups plan's hash and names it in the --approve command, and nothing without one", async () => {
    const made = await tempProject();
    project = made;
    await writeProjectPlan(made, testPlan({ deployed: true, userSecret: false }));
    const storage = "c".repeat(64);
    const backups = "b".repeat(64);
    /** `provision --plan-only`'s output for a storage plan and, when given, a backups plan. */
    const planOnly = async (backupsPlanHash?: string) => {
      const ctx = projectContext(made);
      await runInfraCommand(ctx, "provision", { planOnly: true }, async () => ({
        applied: false,
        outputs: {},
        storagePlanHash: storage,
        ...(backupsPlanHash === undefined ? {} : { backupsPlanHash }),
      }));
      return ctx.output;
    };

    const both = await planOnly(backups);
    expect(both).toContain(`bucket of the off-server copies:  ${backups}`);
    expect(both).toContain(`opscrew provision --approve ${storage} --approve ${backups}`);

    const alone = await planOnly();
    expect(alone).toContain(`opscrew provision --approve ${storage}`);
    expect(alone).not.toContain("off-server");
  });
});
