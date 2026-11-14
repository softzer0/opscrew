import { readFile } from "node:fs/promises";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { createTestPhaseDeps, testPlan } from "../testing";
import { runDestroy } from "./run";

describe("destroy during a move to another Cloudflare account", () => {
  it.each([
    ["started", undefined],
    ["prepared", undefined],
    ["adopted", undefined],
    ["prepared", "started"],
  ] as const)("refuses at %s (abort %s) before any check or change", async (step, abort) => {
    const accounts = twoAccounts();
    const deps = await createTestPhaseDeps();
    Object.assign(deps.env, accounts.env);
    const plan = withCloudflareMove(testPlan({ deployed: true }), accounts, step, abort);
    await writeArtifact("plan", deps.paths.files.plan, plan);
    const before = await readFile(deps.paths.files.plan, "utf8");
    let asked = false;
    const error = await runDestroy(deps, {
      confirm: async () => {
        asked = true;
        return true;
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A move of example.com to another Cloudflare account is in progress. Nothing was changed.",
      hint: expect.stringContaining("opscrew cloudflare move"),
    });
    expect(asked).toBe(false);
    expect(deps.audit.entries).toEqual([]);
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(accounts.cloudflare.calls).toEqual([]);
    const { message, hint } = error as Error & { hint: string };
    expect(leaksToken(accounts, message, hint, deps.reporter.text())).toBe(false);
  });
});
