// 026 T2627: provision refuses the provider's backups where the provider offers none through
// OpsCrew (Contabo), before any plan.
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { requireProviderBackups } from "./guard";
import { runProvision } from "./run";

const NO_BACKUPS =
  "Contabo offers no automatic backups through OpsCrew: OpsCrew's own snapshots of the app's data (`opscrew snapshot`) cover it instead.";

/** A Contabo plan whose app server has the provider's backups on. */
function contaboWithBackups(): DeployPlan {
  const plan = testPlan({ provider: "contabo" });
  return { ...plan, target: { ...cloudTarget(plan.target), backups: true } };
}

describe("requireProviderBackups", () => {
  it("refuses the app server's backups at Contabo, saying why and what to change", () => {
    expect(() => requireProviderBackups(contaboWithBackups(), "opscrew provision")).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: `The app's server has automated backups on (target.backups), but ${NO_BACKUPS} Nothing was changed.`,
        hint: "Set target.backups to false in opscrew/plan.yaml, then run `opscrew provision` again.",
      }),
    );
  });

  it("refuses an extra Contabo server's backups, naming the server", () => {
    const plan = testPlan();
    const contabo = cloudTarget(testPlan({ provider: "contabo" }).target);
    const servers = [{ name: "db", target: { ...contabo, backups: true } }];
    expect(() => requireProviderBackups({ ...plan, servers }, "opscrew provision")).toThrow(
      expect.objectContaining({
        message: `Server db has automated backups on (servers[].target.backups), but ${NO_BACKUPS} Nothing was changed.`,
        hint: "Set servers[].target.backups to false for server db in opscrew/plan.yaml, then run `opscrew provision` again.",
      }),
    );
  });

  it("lets Contabo without backups and Hetzner and DigitalOcean with backups through", () => {
    expect(() => requireProviderBackups(testPlan({ provider: "contabo" }), "x")).not.toThrow();
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const plan = testPlan({ provider });
      expect(cloudTarget(plan.target).backups).toBe(true);
      expect(() => requireProviderBackups(plan, "x")).not.toThrow();
    }
  });
});

describe.skipIf(!findExecutable("git"))("provision with backups on at Contabo", () => {
  it("stops before any plan or apply", async () => {
    const project = await createProject(contaboWithBackups());
    const engine = new FakeEngine();
    const deps = await createTestPhaseDeps({
      root: project.root,
      env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => true),
    });
    const services = {
      engine: async () => engine,
      provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
      github: new FakeGitHub(),
      tcpConnect: async () => true,
      remote: readyRemote,
      sleep: async () => undefined,
      sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    };
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("The app's server has automated backups on"),
    });
    expect(engine.calls).toEqual([]);
  });
});
