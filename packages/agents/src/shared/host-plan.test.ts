import { existsSync } from "node:fs";
import { HostApplyError, type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import type { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { PlanRefusedError } from "./approvals";
import { approveAndApplyHostPlan, type HostPlanStep, hostPlanFile } from "./host-plan";

const PLAN: HostPlan = {
  schemaVersion: 1,
  purpose: "setup",
  app: "shop",
  steps: [
    { id: "docker", title: "Install Docker", state: "change", params: {} },
    { id: "unattended-upgrades", title: "Automatic updates", state: "in-place", params: {} },
  ],
  findings: [],
};
const REMOTE: RemoteExec = {
  host: "server",
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
};

async function setup(answer: (kind: string) => boolean = () => true) {
  const handler = new ScriptedApprovalHandler((request) => answer(request.kind));
  const deps = await createTestPhaseDeps({ approvalHandler: handler });
  const applied: { hash: string; secrets: unknown; version?: string }[] = [];
  const token = fakeSecret("cloudflare-token", "host-plan");
  const step = (over: Partial<HostPlanStep> = {}): HostPlanStep => ({
    plan: PLAN,
    remote: REMOTE,
    apply: async (_remote, plan, options) => {
      applied.push({
        hash: options.approvedHash,
        secrets: options.secrets,
        ...(options.version !== undefined ? { version: options.version } : {}),
      });
      return {
        applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
        skipped: [],
      };
    },
    verifyLogin: async () => true,
    title: "Apply the host plan to the server (1 change)",
    server: "the server",
    command: "opscrew portainer enable",
    phase: "dns",
    secrets: async () => ({ tunnelToken: token }),
    ...over,
  });
  return { deps, handler, applied, step, token };
}

describe("approveAndApplyHostPlan", () => {
  it("saves and shows the plan, approves it by its hash, applies it and audits every step", async () => {
    const s = await setup();
    const outcome = await approveAndApplyHostPlan(s.deps, s.step());
    const hash = hostPlanHash(PLAN);
    expect(outcome).toMatchObject({ hash, applied: true, steps: ["docker"] });
    expect(existsSync(hostPlanFile(s.deps.paths, hash))).toBe(true);
    expect(s.handler.requests).toMatchObject([{ kind: "host-apply", planHash: hash }]);
    expect(s.applied).toEqual([
      { hash, secrets: { tunnelToken: s.token }, version: s.deps.version },
    ]);
    const actions = s.deps.audit.entries.map((e) => [e.action, e.phase]);
    expect(actions).toContainEqual(["host apply started", "dns"]);
    expect(actions).toContainEqual(["host step docker", "dns"]);
    expect(s.deps.reporter.text()).toContain(`Host plan hash: ${hash}`);
    expect(JSON.stringify(s.deps.audit.entries)).not.toContain(s.token);
  });

  it("asks for the typed app name when the plan deletes data", async () => {
    const s = await setup();
    await approveAndApplyHostPlan(s.deps, s.step({ allowDestroy: true }));
    expect(s.handler.requests[0]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
  });

  it("changes nothing with --plan-only, or when refused, and reads no secret", async () => {
    const s = await setup(() => false);
    let read = 0;
    const secrets = async () => {
      read++;
      return {};
    };
    const shown = await approveAndApplyHostPlan(s.deps, s.step({ planOnly: true, secrets }));
    expect(shown).toMatchObject({ applied: false, steps: [] });
    expect(s.handler.requests).toHaveLength(0);
    const error = await approveAndApplyHostPlan(s.deps, s.step({ secrets })).catch((e) => e);
    expect(error).toBeInstanceOf(PlanRefusedError);
    expect((error as OpsCrewError).message).toBe(
      "The host plan was not approved. Nothing on the server was changed.",
    );
    expect((error as OpsCrewError).hint).toBe(
      `To apply it later without prompts, run: opscrew portainer enable --approve ${hostPlanHash(PLAN)}`,
    );
    expect(read).toBe(0);
    expect(s.applied).toHaveLength(0);
  });

  it("audits the steps a failed apply applied before it stopped", async () => {
    const s = await setup();
    const failing = s.step({
      apply: async () => {
        throw new HostApplyError("COMMAND_FAILED", "apt failed.", ["docker"]);
      },
    });
    await expect(approveAndApplyHostPlan(s.deps, failing)).rejects.toThrow("apt failed.");
    const failed = s.deps.audit.entries.find((e) => e.action === "host apply failed");
    expect(failed).toMatchObject({
      decision: "refused",
      detail: "steps applied before the failure: docker",
    });
  });

  it("needs no approval when nothing changes, and stops on blocking findings", async () => {
    const s = await setup();
    const inPlace: HostPlan = { ...PLAN, steps: PLAN.steps.filter((x) => x.state === "in-place") };
    expect(await approveAndApplyHostPlan(s.deps, s.step({ plan: inPlace }))).toMatchObject({
      applied: false,
    });
    expect(s.deps.reporter.text()).toContain(
      "The server is already prepared; nothing on it changes.",
    );
    const blocked: HostPlan = {
      ...PLAN,
      findings: [{ code: "other-firewall", message: "Another firewall.", hint: "Turn it off." }],
    };
    await expect(approveAndApplyHostPlan(s.deps, s.step({ plan: blocked }))).rejects.toThrow(
      /cannot prepare your server/,
    );
    expect(s.handler.requests).toHaveLength(0);
  });
});
