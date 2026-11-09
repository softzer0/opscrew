// Feature 025 (T2521): what every path of a rotation says about the environment's unfinished one.
import { randomBytes } from "node:crypto";
import { exists } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  ADDON_ROTATION_HASH,
  beganElsewhere,
  forgetPlannedRotation,
  keepPendingRotation,
  nothingToUndo,
  type PendingRotation,
  pendingRotationFile,
  registerRotationValues,
  rotateCommand,
  sameNames,
  unfinishedRotation,
} from "./values-pending";

/** An unfinished rotation of db and cache at `step`. */
const pending = (step: PendingRotation["step"], extra: Partial<PendingRotation> = {}) =>
  ({
    names: ["db", "cache"],
    services: { db: { password: { old: "a".repeat(64), new: "b".repeat(64) } } },
    hash: "c".repeat(64),
    step,
    ...extra,
  }) satisfies PendingRotation;

describe("the unfinished rotation's refusals", () => {
  it("names how to finish another rotation, and its undo only until it switched and never for an add-on", () => {
    const started = unfinishedRotation(pending("started"), "prod", " --env prod");
    expect(started).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The rotation of db and cache in prod is unfinished, so OpsCrew starts no other one. Nothing was changed.",
      hint: "Finish it with `opscrew rotate db cache --env prod`, or put the old values back with `opscrew rotate db cache --env prod --undo`, then run this command again.",
    });
    for (const forward of [
      pending("switched"),
      pending("planned", { names: ["monitoring"], hash: ADDON_ROTATION_HASH }),
    ]) {
      expect(unfinishedRotation(forward, "prod", "").hint).not.toContain("--undo");
    }
    // Provision says its own stop after the same first words.
    expect(
      unfinishedRotation(pending("started"), "prod", "", "and provision stopped.").message,
    ).toBe("The rotation of db and cache in prod is unfinished, and provision stopped.");
  });

  it("says nothing is to undo, and where a rotation began when the plan runs the app elsewhere", () => {
    expect(nothingToUndo(["db"], "prod")).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "No rotation of db is unfinished in prod, so there is nothing to undo. Nothing was changed.",
    });
    const began = beganElsewhere(
      pending("started", { target: "portainer" }),
      "server",
      "opscrew rotate db cache",
    );
    expect(began).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The rotation of db and cache began in your Portainer, and its state is there, not on the servers. Nothing was changed.",
      hint: "Finish it with `opscrew rotate db cache`, or put the old values back with `opscrew rotate db cache --undo`, while the plan still runs the app where the rotation began.",
    });
    expect(beganElsewhere(pending("switched"), "localhost", "x").message).toContain(
      "began on the servers, and its state is there, not on this computer.",
    );
    expect(beganElsewhere(pending("switched"), "site", "x").hint).not.toContain("--undo");
  });

  it("takes the same names in any order, and names the command that goes on", () => {
    expect(sameNames(["db", "cache"], ["cache", "db"])).toBe(true);
    expect(sameNames(["db"], ["db", "cache"])).toBe(false);
    expect(rotateCommand(["db", "cache"], " --app shop")).toBe(
      "opscrew rotate db cache --app shop",
    );
  });

  it("forgets a planned rotation and says so", async () => {
    const deps = await createTestPhaseDeps();
    await keepPendingRotation(deps, pending("planned"));
    await forgetPlannedRotation(deps, ["db", "cache"]);
    expect(await exists(pendingRotationFile(deps))).toBe(false);
    expect(deps.reporter.text()).toContain(
      "Forgot the rotation of db and cache in prod: it was never approved, so nothing else had changed.",
    );
  });
});

describe("registerRotationValues", () => {
  it("registers each value a previous-value variable holds on its own, beside the whole", async () => {
    const deps = await createTestPhaseDeps();
    const [key, earlier, auth, current] = [1, 2, 3, 4].map(() => randomBytes(32).toString("hex"));
    const app = {
      APP_PREVIOUS_KEYS: { old: "", new: `${key},${earlier}` },
      BETTER_AUTH_SECRETS: { old: "", new: `2:${current},1:${auth}` },
    };
    registerRotationValues(deps.redactor, { names: ["app"], services: {}, app });
    for (const value of [
      earlier,
      current,
      app.APP_PREVIOUS_KEYS.new,
      app.BETTER_AUTH_SECRETS.new,
    ]) {
      expect(deps.redactor.redact(`x ${value} y`)).not.toContain(value);
    }
  });
});
