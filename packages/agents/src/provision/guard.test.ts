import { OpsCrewError } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type Retarget } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { requireNoDeployOrMove } from "../snapshot/run";
import { createTestPhaseDeps, sitePlan, testPlan } from "../testing";
import { moveInProgress, requireNoCloudflareMove, requireNoMoveInProgress } from "./guard";

/** A plan moving from Hetzner Cloud to DigitalOcean, at `step`, optionally being aborted. */
function moving(abort?: NonNullable<Retarget["abort"]>["step"]): DeployPlan {
  const from = testPlan({ deployed: true });
  return {
    ...testPlan({ provider: "digitalocean", deployed: true }),
    retarget: {
      from: { target: cloudTarget(from.target), deploy: from.deploy },
      step: "deployed",
      empty: [],
      startedAt: "2026-10-12T09:00:00.000Z",
      ...(abort !== undefined ? { abort: { step: abort } } : {}),
    },
  };
}

describe("moveInProgress", () => {
  it("is undefined without a move", () => {
    expect(moveInProgress(testPlan())).toBeUndefined();
    expect(() => requireNoMoveInProgress(testPlan())).not.toThrow();
  });

  it("names continue, finish and abort while a move runs", () => {
    expect(moveInProgress(moving())).toEqual({
      message: "A move to DigitalOcean is in progress.",
      hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
    });
  });

  it.each(["started", "new-removed", "secrets-restored"] as const)(
    "names only the abort once an abort began (%s)",
    (step) => {
      const move = moveInProgress(moving(step));
      expect(move?.message).toBe("A move to DigitalOcean is being aborted.");
      expect(move?.hint).toContain("Run `opscrew retarget --abort` to finish the abort");
      expect(move?.hint).not.toContain("continue it");
      expect(move?.hint).not.toContain("--finish");
      const error = (() => {
        try {
          requireNoMoveInProgress(moving(step));
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION", hint: move?.hint });
    },
  );
});

describe("moveInProgress for a move to the user's own server or Portainer", () => {
  const to = (target: DeployPlan["target"]): DeployPlan => ({ ...moving(), target });
  const own = to({
    provider: "own",
    mode: "vps-compose",
    arch: "amd64",
    access: "public",
    edge: "caddy",
  });
  const portainer = to({
    provider: "portainer",
    mode: "portainer-stack",
    environmentId: 3,
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "caddy" },
  });

  const pages = { ...moving(), target: sitePlan({ provider: "github-pages" }).target };
  const workers = { ...moving(), target: sitePlan({ provider: "cloudflare-workers" }).target };

  it.each([
    [own, "A move to your own server is in progress."],
    [portainer, "A move to your Portainer is in progress."],
    [pages, "A move to GitHub Pages is in progress."],
    [workers, "A move to Cloudflare hosting is in progress."],
  ])("names the target in words and refuses with that notice (%#)", (plan, message) => {
    expect(moveInProgress(plan)?.message).toBe(message);
    expect(() => requireNoMoveInProgress(plan)).toThrow(message);
    expect(JSON.stringify(moveInProgress(plan))).not.toContain("Your own server");
  });
});

describe("requireNoCloudflareMove", () => {
  const accounts = twoAccounts();
  const refusal = (plan: DeployPlan, run = () => requireNoCloudflareMove(plan)) => {
    try {
      run();
    } catch (e) {
      return e as OpsCrewError;
    }
    return undefined;
  };

  it("lets a plan without a move through", () => {
    expect(() => requireNoCloudflareMove(testPlan())).not.toThrow();
  });

  it.each([
    ["started", undefined, ["`opscrew cloudflare move` to go on", "--abort"], ["--switch"]],
    ["prepared", undefined, ["--switch", "--finish", "--abort"], ["go on preparing"]],
    ["adopted", undefined, ["--finish"], ["--switch", "--abort"]],
    ["started", "started", ["--abort` to finish the abort"], ["--switch", "--finish"]],
    ["prepared", "removed", ["--abort` to finish the abort"], ["--switch", "--finish"]],
  ] as const)("refuses at %s (abort %s) with that step's hint", (step, abort, has, hasNot) => {
    const plan = withCloudflareMove(testPlan(), accounts, step, abort);
    const error = refusal(plan);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A move of example.com to another Cloudflare account is in progress. Nothing was changed.",
    });
    for (const text of has) expect(error?.hint).toContain(text);
    for (const text of hasNot) expect(error?.hint).not.toContain(text);
    expect(error?.hint).toContain("Then run this command again.");
    expect(leaksToken(accounts, error?.message ?? "", error?.hint ?? "")).toBe(false);
    expect(accounts.cloudflare.calls).toEqual([]);
  });

  it("names the plan's own zone", () => {
    const shop = testPlan({ domain: "shop.example.org" });
    const plan = withCloudflareMove(
      { ...shop, dns: { ...shop.dns, zone: "example.org" } },
      twoAccounts("example.org"),
    );
    expect(refusal(plan)?.message).toBe(
      "A move of example.org to another Cloudflare account is in progress. Nothing was changed.",
    );
  });

  it("is part of requireNoMoveInProgress, unless the caller allows a Cloudflare move", () => {
    const plan = withCloudflareMove(testPlan(), accounts, "prepared");
    expect(refusal(plan, () => requireNoMoveInProgress(plan))?.message).toContain(
      "A move of example.com to another Cloudflare account is in progress.",
    );
    expect(() => requireNoMoveInProgress(plan, { allowCloudflareMove: true })).not.toThrow();
    // moveInProgress stays retarget's: snapshot, rollback, advise and status read only it.
    expect(moveInProgress(plan)).toBeUndefined();
  });

  it("still refuses a retarget when a Cloudflare move is allowed", () => {
    expect(() => requireNoMoveInProgress(moving(), { allowCloudflareMove: true })).toThrow(
      "A move to DigitalOcean is in progress.",
    );
  });
});

describe("snapshot during a move to another Cloudflare account", () => {
  it("goes on: its own check stops only for a retarget or a service's move", async () => {
    const deps = await createTestPhaseDeps();
    const local = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "amd64",
        ports: { https: 443, http: 80 },
        image: "registry",
      },
    });
    const plan = withCloudflareMove(local, twoAccounts(), "prepared");
    const run = { deps, plan, environment: "prod", flags: "", services: {} };
    await expect(requireNoDeployOrMove(run, "take a snapshot")).resolves.toBeUndefined();
  });
});
