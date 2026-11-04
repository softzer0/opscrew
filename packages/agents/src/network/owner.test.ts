import { join, resolve } from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { monitoredPlan, senderPlan, splitPlan } from "./__fixtures__/plans";
import { monitoringOwner } from "./owner";

/** A repository's paths at its staging environment; nothing is read or written there. */
const ROOT = resolve("example-repo");
const HOME = join(ROOT, ".home-opscrew");
const STAGING = resolveProjectPaths(ROOT, { env: { OPSCREW_HOME: HOME }, environment: "staging" });

/** The sender, sending to the server `monitoring` of the plan file `file`. */
function sendingTo(file: string): Omit<DeployPlan, "network"> {
  const plan = senderPlan();
  const monitoring = plan.observability?.monitoring;
  if (monitoring === undefined) throw new Error("the sender has no monitoring");
  return {
    ...plan,
    observability: {
      ...plan.observability,
      monitoring: {
        ...monitoring,
        where: { kind: "shared", owner: { plan: file, server: "monitoring" } },
      },
    },
  };
}

describe("monitoringOwner", () => {
  it("is the environment of the owner's plan file, beside this one's paths", () => {
    const owner = monitoringOwner(STAGING, senderPlan());
    expect(owner).toMatchObject({ plan: "opscrew/plan.yaml", server: "monitoring" });
    expect(owner?.paths).toEqual(resolveProjectPaths(ROOT, { env: { OPSCREW_HOME: HOME } }));
    expect(owner?.paths.files.plan).toBe(join(ROOT, "opscrew", "plan.yaml"));

    const further = monitoringOwner(
      STAGING,
      sendingTo("opscrew/apps/admin/environments/qa/plan.yaml"),
    );
    expect(further?.paths).toMatchObject({ app: "admin", environment: "qa" });
    expect(further?.paths.files.plan).toBe(
      join(ROOT, "opscrew", "apps", "admin", "environments", "qa", "plan.yaml"),
    );
    expect(
      monitoringOwner(STAGING, sendingTo("opscrew/environments/qa/plan.yaml"))?.paths,
    ).toMatchObject({ environment: "qa", stateDir: join(ROOT, ".opscrew", "environments", "qa") });
  });

  it("is none for a plan that sends to no other environment's server", () => {
    for (const plan of [splitPlan(), monitoredPlan(), monitoredPlan({ on: "app" })]) {
      expect(monitoringOwner(STAGING, plan)).toBeUndefined();
    }
  });

  it("refuses an owner's plan that is not an environment's plan file as OpsCrew writes it", () => {
    for (const file of [
      "plans/prod.yaml",
      "opscrew/apps/../plan.yaml",
      "opscrew/environments/../plan.yaml",
      // Prod's plan is opscrew/plan.yaml: one spelling per plan file.
      "opscrew/environments/prod/plan.yaml",
    ]) {
      expect(() => monitoringOwner(STAGING, sendingTo(file))).toThrow(
        expect.objectContaining({
          code: "INVALID_INPUT",
          message: `observability.monitoring.where.owner.plan is ${file}, which is not the plan file of one of the repository's environments, such as opscrew/plan.yaml.`,
        }),
      );
    }
  });
});
