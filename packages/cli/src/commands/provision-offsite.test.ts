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
  it("lists the backups plan's hash and names it in the --approve command", async () => {
    project = await tempProject();
    await writeProjectPlan(project, testPlan({ deployed: true, userSecret: false }));
    const ctx = projectContext(project);
    const backups = "b".repeat(64);
    await runInfraCommand(ctx, "provision", { planOnly: true }, async () => ({
      applied: false,
      outputs: {},
      storagePlanHash: "c".repeat(64),
      backupsPlanHash: backups,
    }));
    expect(ctx.output).toContain(`bucket of the off-server copies:  ${backups}`);
    expect(ctx.output).toContain(
      `opscrew provision --approve ${"c".repeat(64)} --approve ${backups}`,
    );
  });

  it("prints no such line and no other hash without one", async () => {
    project = await tempProject();
    await writeProjectPlan(project, testPlan({ deployed: true, userSecret: false }));
    const ctx = projectContext(project);
    await runInfraCommand(ctx, "provision", { planOnly: true }, async () => ({
      applied: false,
      outputs: {},
      storagePlanHash: "c".repeat(64),
    }));
    expect(ctx.output).toContain(`opscrew provision --approve ${"c".repeat(64)}`);
    expect(ctx.output).not.toContain("off-server");
  });
});
