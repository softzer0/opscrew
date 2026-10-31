// Feature 018 (T1811): a healthy deploy that verify records also records where each service runs.
import type { FetchLike } from "@opscrew/contracts";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { APP_HOST, splitWorld } from "../status/__fixtures__/split";
import { runVerify } from "./run";

/** The app's site on its server's address: healthy, with OpsCrew's security headers. */
const site: FetchLike = async (input) => {
  const url = String(input);
  if (url === `http://${APP_HOST}/` || url === `http://${APP_HOST}/api/health`) {
    return new Response("ok", {
      headers: {
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    });
  }
  return new Response("not found", { status: 404 });
};

async function verified(fields: object = {}) {
  const w = await splitWorld();
  await writeArtifact(
    "plan",
    w.deps.paths.files.plan,
    DeployPlanSchema.parse({ ...w.plan, ...fields }),
  );
  const result = await runVerify(w.deps, {
    fetch: site,
    resolver: { resolve4: async () => [], resolve6: async () => [] },
    tcpConnect: async () => false,
    remote: w.remote,
    network: w.network,
  });
  expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
  return readArtifact("plan", w.deps.paths.files.plan);
}

describe("verify's record of a healthy deploy", () => {
  it("writes where each service runs when none is recorded", async () => {
    const plan = await verified();
    expect(plan.deployment.placement).toEqual({ db: "data" });
  });

  it("keeps a recorded placement, which only a move changes", async () => {
    const w = await splitWorld();
    // db runs on the app's server; plan.yaml was edited by hand to place it on data.
    const plan = await verified({ deployment: { ...w.plan.deployment, placement: { db: "app" } } });
    expect(plan.deployment.placement).toEqual({ db: "app" });
  });

  it("leaves the placement to the move while one is under way", async () => {
    const plan = await verified({
      move: { service: "db", from: "app", to: "data", step: "deployed", copy: "dump" },
    });
    expect(plan.deployment.placement).toBeUndefined();
  });
});
