import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../testing";
import { copiesData } from "./window";

/** `shop` with no service, moving off a Hetzner server, with `fields` and the move's `empty`. */
function moving(fields: Record<string, unknown>, empty?: string[]) {
  const base = testPlan({ postgres: false });
  return DeployPlanSchema.parse({
    ...base,
    ...fields,
    retarget: {
      from: { target: base.target, deploy: base.deploy },
      step: "deployed",
      startedAt: "2026-11-06T12:00:00.000Z",
      ...(empty === undefined ? {} : { empty }),
    },
  });
}

describe("copiesData", () => {
  it("copies the app's kept folder in the window, unless the app starts empty", () => {
    const files = { storage: { files: { dir: "storage" } } };
    expect(copiesData(moving({}))).toBe(false);
    expect(copiesData(moving(files))).toBe(true);
    expect(copiesData(moving(files, ["app"]))).toBe(false);
  });
});
