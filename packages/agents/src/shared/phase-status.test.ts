import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { runPhase } from "./phase-status";

describe("runPhase", () => {
  it("returns the result and records nothing itself when the phase succeeds", async () => {
    const deps = await createTestPhaseDeps();
    expect(await runPhase(deps, "verify", async () => 42)).toBe(42);
    expect((await deps.state.read()).phases.verify).toBeUndefined();
  });

  it("records the redacted user-facing message, cut to 300 characters, and rethrows", async () => {
    const deps = await createTestPhaseDeps();
    const secret = fakeSecret("generic-password");
    deps.redactor.addLiteral(secret, "test-secret");
    const error = new OpsCrewError(
      "PHASE_PRECONDITION",
      `Stopped at ${secret}. ${"x".repeat(400)}`,
    );
    await expect(
      runPhase(deps, "design", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const record = (await deps.state.read()).phases.design;
    expect(record?.status).toBe("failed");
    expect(record?.summary).not.toContain(secret);
    expect(record?.summary).toMatch(/^Stopped at /);
    expect(record?.summary).toHaveLength(300);
  });

  it('records "unexpected error" for an error that is not meant for the user', async () => {
    const deps = await createTestPhaseDeps();
    const error = new Error("internal detail");
    await expect(
      runPhase(deps, "secure", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect((await deps.state.read()).phases.secure).toMatchObject({
      status: "failed",
      summary: "unexpected error",
    });
  });

  it("never hides the original error behind a failed state write", async () => {
    const deps = await createTestPhaseDeps();
    // A damaged state file makes every state write fail.
    await mkdir(dirname(deps.paths.files.state), { recursive: true });
    await writeFile(deps.paths.files.state, "{ not json");
    const error = new OpsCrewError("ARTIFACT_MISSING", "opscrew/plan.yaml is missing.");
    await expect(
      runPhase(deps, "adapt", async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const failing = {
      ...deps,
      state: {
        markPhase: async () => {
          throw new Error("disk full");
        },
      } as unknown as typeof deps.state,
    };
    await expect(
      runPhase(failing, "portainer", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
