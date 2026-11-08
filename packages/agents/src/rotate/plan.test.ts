// Feature 025 (T2506): a rotation of services as its plan: the steps, the runs, the hash.
import { serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type PlanService } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { splitStagingPlan, stagingPlan } from "../snapshot/__fixtures__/world";
import { createTestPhaseDeps, type ScriptedApprovalHandler } from "../testing";
import {
  approveRotation,
  type RotationPlan,
  rotationHash,
  serverRuns,
  serviceSteps,
  stepValues,
} from "./plan";
import type { RotationValues } from "./values-pending";

const pair = (old: string, fresh: string) => ({ old, new: fresh });

function pendingOf(plan: DeployPlan, seed: string): RotationValues {
  return {
    names: plan.services.map((s) => s.name),
    services: Object.fromEntries(
      plan.services.map((service) => [
        service.name,
        Object.fromEntries(
          serviceSpec(service.kind).secrets.map((secret) => [
            secret.name,
            pair(`${service.name}-${secret.name}-old`, `${service.name}-${secret.name}-${seed}`),
          ]),
        ),
      ]),
    ),
  };
}

describe("serviceSteps", () => {
  it("takes each secret's step from the catalog's recipe, in the plan's order, with its own undo", () => {
    const plan = stagingPlan([
      { kind: "postgres", name: "db" },
      { kind: "mysql", name: "shop" },
      { kind: "meilisearch", name: "search" },
    ]);
    const steps = serviceSteps(plan, plan.services);
    expect(steps.map((s) => [s.step.service, s.step.mode, s.rotation.secrets.join(",")])).toEqual([
      ["db", "swap", "password"],
      ["shop", "dual", "password"],
      ["shop", "dual", "root-password"],
      ["search", "restart", "master-key"],
    ]);
    const [db, shop] = steps;
    expect(db?.step.envFile).toBe("db.env");
    expect(db?.step.begin).toHaveLength(1);
    expect(db?.step.undo).toBeUndefined();
    expect(shop?.step.undo).toHaveLength(1);
    expect(steps[3]?.step).toMatchObject({ begin: [], finish: [], recreate: true });
    // No value is ever in a step: only the container's OPSCREW_OLD and OPSCREW_NEW.
    expect(JSON.stringify(steps.map((s) => s.step))).toContain("OPSCREW_NEW");
  });

  it("takes Garage's key with its `unless` check, and its RPC secret by a restart", () => {
    const base = stagingPlan([
      { kind: "postgres", name: "db" },
      { kind: "garage", name: "files" },
    ]);
    const plan = DeployPlanSchema.parse({
      ...base,
      storage: {
        objectStorage: {
          provider: "garage",
          bucket: "shop-uploads",
          region: "garage",
          expected: { storageGb: 10, egressGbPerMonth: 50 },
          price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
        },
      },
    });
    const files = serviceSteps(plan, plan.services).filter((s) => s.service.name === "files");
    expect(files.map((s) => [s.step.mode, s.step.recreate, s.rotation.secrets.join(",")])).toEqual([
      ["dual", true, "key-id,secret-key"],
      ["restart", true, "rpc-secret"],
    ]);
    const [rename] = files[0]?.step.begin ?? [];
    expect(rename).toMatchObject({ unless: [expect.any(Array)], run: expect.any(Array) });
    expect(files[0]?.step.undo).toHaveLength(2);
    expect(serverRuns(plan, files)[0]?.script).toContain("if ! OPSCREW_OLD=");
  });

  it("leaves out a service that is off, which changes on this computer only", () => {
    const plan = stagingPlan([{ kind: "postgres", name: "db" }]);
    const off = plan.services.map((s) => ({ ...s, enabled: false })) as PlanService[];
    expect(serviceSteps(plan, off)).toEqual([]);
  });

  it("gives a step of several secrets no value (Garage's key), and one secret's its pair", () => {
    const plan = stagingPlan([{ kind: "postgres", name: "db" }]);
    const [db] = serviceSteps(plan, plan.services);
    const pending = pendingOf(plan, "new");
    expect(stepValues(db as NonNullable<typeof db>, pending)).toEqual(
      pair("db-password-old", "db-password-new"),
    );
    const several = {
      ...(db as NonNullable<typeof db>),
      rotation: { ...db?.rotation, secrets: ["key-id", "secret-key"] },
    };
    expect(stepValues(several as NonNullable<typeof db>, pending)).toEqual(pair("", ""));
  });
});

describe("serverRuns", () => {
  it("runs on the app's server first, whose settings change with every service's, then each extra server with a step", () => {
    const plan = splitStagingPlan();
    const [db] = plan.services;
    const runs = serverRuns(plan, serviceSteps(plan, [db as PlanService]));
    expect(runs.map((run) => [run.server, run.steps.map((s) => s.service.name)])).toEqual([
      ["app", []],
      ["data", ["db"]],
    ]);
    expect(runs[0]?.script).toContain("sh rotate.sh <hash>");
    expect(runs[1]?.script).toContain("sh rotate.sh begin <hash>");
    expect(serverRuns(plan, [])).toEqual([]);
  });
});

describe("the rotation's hash and approval", () => {
  async function input(seed: string): Promise<{
    deps: Awaited<ReturnType<typeof createTestPhaseDeps>>;
    plan: DeployPlan;
    rotation: RotationPlan;
  }> {
    const deps = await createTestPhaseDeps({ environment: "staging" });
    const plan = stagingPlan([
      { kind: "postgres", name: "db" },
      { kind: "nats", name: "events" },
      { kind: "meilisearch", name: "search" },
    ]);
    const runs = serverRuns(plan, serviceSteps(plan, plan.services));
    return {
      deps,
      plan,
      rotation: {
        services: plan.services,
        values: pendingOf(plan, seed),
        runs,
        secrets: [{ name: "OPSCREW_STAGING_APP_ENV" }],
      },
    };
  }

  it("binds the services, the scripts and each value's fingerprint, never a value", async () => {
    const a = await input("one");
    const b = await input("two");
    expect(rotationHash(a.deps, a.plan, a.rotation)).toBe(
      rotationHash(a.deps, a.plan, (await input("one")).rotation),
    );
    expect(rotationHash(a.deps, a.plan, a.rotation)).not.toBe(
      rotationHash(b.deps, b.plan, b.rotation),
    );
  });

  it("says what each step costs the running app, and asks by the hash", async () => {
    const { deps, plan, rotation } = await input("one");
    const hash = await approveRotation(deps, plan, rotation, "opscrew rotate db events search");
    const handler = deps.approvalHandler as ScriptedApprovalHandler;
    const request = handler.requests[0];
    expect(request).toMatchObject({ kind: "remote-exec", planHash: hash });
    const details = request?.details ?? "";
    expect(details).toContain(
      "db (PostgreSQL), its password: a short swap: new connections the running app opens to PostgreSQL fail for about 31 seconds",
    );
    expect(details).toContain("its open connections are closed too");
    expect(details).toContain(
      "search (Meilisearch), its master-key: a restart: Meilisearch restarts with the new value (about 5 seconds",
    );
    expect(details).toContain("the app's rolling switch to them with the image that runs");
    expect(details).toContain("`opscrew rotate db events search --undo` puts the old values back");
    expect(details).not.toContain("-old");
  });
});
