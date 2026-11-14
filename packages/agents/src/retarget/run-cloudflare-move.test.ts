import { readFile } from "node:fs/promises";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { createTestPhaseDeps, testPlan } from "../testing";
import { runRetarget } from "./run";
import { startMove } from "./start";

const REFUSAL = {
  code: "PHASE_PRECONDITION",
  message:
    "A move of example.com to another Cloudflare account is in progress. Nothing was changed.",
  hint: expect.stringContaining("opscrew cloudflare move"),
};

describe("retarget during a move to another Cloudflare account", () => {
  it.each(["started", "prepared", "adopted"] as const)(
    "refuses at %s before anything else, recording no phase",
    async (step) => {
      const accounts = twoAccounts();
      const deps = await createTestPhaseDeps();
      Object.assign(deps.env, accounts.env);
      const plan = withCloudflareMove(testPlan({ deployed: true }), accounts, step);
      await writeArtifact("plan", deps.paths.files.plan, plan);
      const before = await readFile(deps.paths.files.plan, "utf8");
      let asked = false;
      const error = await runRetarget(deps, {
        to: "digitalocean",
        confirmStart: async () => {
          asked = true;
          return true;
        },
      }).catch((e: unknown) => e);
      expect(error).toMatchObject(REFUSAL);
      expect(asked).toBe(false);
      expect((await deps.state.read()).phases.retarget).toBeUndefined();
      expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
      expect(deps.audit.entries).toEqual([]);
      expect(accounts.cloudflare.calls).toEqual([]);
      const { message, hint } = error as Error & { hint: string };
      expect(leaksToken(accounts, message, hint, deps.reporter.text())).toBe(false);
    },
  );

  it("refuses at the move's start too", async () => {
    const accounts = twoAccounts();
    const deps = await createTestPhaseDeps();
    const plan = withCloudflareMove(testPlan({ deployed: true }), accounts, "prepared");
    await expect(startMove(deps, plan, { to: "digitalocean" })).rejects.toMatchObject(REFUSAL);
    expect(accounts.cloudflare.calls).toEqual([]);
  });
});
