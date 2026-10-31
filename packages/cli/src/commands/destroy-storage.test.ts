import type { DestroyOptions, DestroyResult, PhaseDeps } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { CliExit } from "../exit";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import { projectContext, type TempProject, tempProject } from "../ui/__fixtures__/harness";
import { runDestroyCommand } from "./destroy";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const BUCKET = {
  objectStorage: {
    provider: "hetzner",
    bucket: "shop-uploads",
    region: "fsn1",
    expected: { storageGb: 10, egressGbPerMonth: 50 },
    price: { monthly: 6.49, currency: "EUR", source: "test", checkedOn: "2026-10-19" },
  },
};

async function destroyWith(
  withBucket: boolean,
): Promise<{ code: number; options: DestroyOptions[]; errors: string }> {
  project = await tempProject();
  const plan = testPlan({ deployed: true });
  await writeProjectPlan(
    project,
    DeployPlanSchema.parse(withBucket ? { ...plan, storage: BUCKET } : plan),
  );
  const ctx = projectContext(project);
  const options: DestroyOptions[] = [];
  const destroy = async (_deps: PhaseDeps, given: DestroyOptions): Promise<DestroyResult> => {
    options.push(given);
    return { destroyed: [], secretsRemoved: [], remaining: [] };
  };
  try {
    await runDestroyCommand(ctx, { confirm: ["shop"], deleteData: true }, destroy);
    return { code: 0, options, errors: ctx.errors };
  } catch (error) {
    if (error instanceof CliExit) return { code: error.exitCode, options, errors: ctx.errors };
    throw error;
  }
}

describe("opscrew destroy --delete-data on a server OpsCrew created", () => {
  it("passes --delete-data on when the app keeps its files in a bucket at a provider", async () => {
    const result = await destroyWith(true);
    expect(result.code, result.errors).toBe(0);
    expect(result.options[0]).toMatchObject({ deleteData: true });
  });

  it("refuses it without a bucket: the server is deleted with its data anyway", async () => {
    const result = await destroyWith(false);
    expect(result.code).toBe(2);
    expect(result.options).toEqual([]);
    expect(result.errors).toContain(
      "--undo-host and --delete-data apply only to a server you already own, your Portainer, this computer or an app with a bucket at a provider",
    );
  });
});
