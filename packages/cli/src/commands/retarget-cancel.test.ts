/**
 * `opscrew retarget --finish` in a terminal, off a provider that cancels its servers at the end of
 * their term (feature 026, US2, US4 #2): the typed name is asked with the question that says so.
 */
import { destroyConfirmPrompt } from "@opscrew/agents";
import { APP, OLD_IDS } from "@opscrew/agents/testing";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CloudProviderDefinition,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GIT, run, ScriptedPrompts } from "../ui/__fixtures__/harness";
import { type MoveProject, moveProject } from "../ui/__fixtures__/retarget";

/*
 * No registered provider cancels its servers yet (Contabo joins the registry later), so Hetzner's
 * definition stands in for one that does, as the old side of the move: its servers are cancelled
 * at the end of a one-month term, and its snapshots go with them.
 */
vi.mock("@opscrew/providers", async (original) => {
  const actual = await original<typeof import("@opscrew/providers")>();
  const hetzner = actual.cloudProvider("hetzner");
  const cancelling: CloudProviderDefinition = {
    ...hetzner,
    offering: {
      ...hetzner.offering,
      removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
      serverSnapshotsOutliveServer: false,
    },
  };
  return {
    ...actual,
    CLOUD_PROVIDERS: actual.CLOUD_PROVIDERS.map((p) => (p.id === "hetzner" ? cancelling : p)),
    cloudProvider: (id: string) => (id === "hetzner" ? cancelling : actual.cloudProvider(id)),
  };
});

/** Answers yes to whatever reaches it. */
class YesApprovals implements ApprovalHandler {
  async request(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return { approved: true, approver: "test", decidedAt: "2026-10-13T12:00:00.000Z" };
  }
}

let move: MoveProject | undefined;
afterEach(async () => {
  await move?.project.cleanup();
  move = undefined;
});

describe.skipIf(!GIT)("opscrew retarget --finish off a provider that cancels", () => {
  it("asks for the typed name with the question that says the old server is cancelled", async () => {
    move = await moveProject();
    const m = move;
    const approvals = new YesApprovals();
    const start = m.context({
      interactive: true,
      services: {
        prompts: new ScriptedPrompts(["digitalocean-single-s-2vcpu-4gb-fra1", true, true]),
        approvalHandler: approvals,
      },
    });
    expect(await run(start, "retarget"), start.errors).toBe(0);
    expect((await readArtifact("plan", m.paths.files.plan)).retarget?.step).toBe("switched");
    // The old server's provider shuts it down and answers when its contract ends.
    const servers = m.services.servers as Record<string, ServerSnapshotApi>;
    const poweredOff: string[] = [];
    servers.hetzner = {
      ...(servers.hetzner as ServerSnapshotApi),
      powerOff: async (id) => {
        poweredOff.push(id);
      },
      findAppServers: async () => [
        { id: OLD_IDS.hetzner, name: APP, status: "off", cancelledUntil: "2026-12-11" },
      ],
    };

    const prompts = new ScriptedPrompts([APP]);
    const finish = m.context({
      interactive: true,
      services: { prompts, approvalHandler: approvals },
    });
    expect(await run(finish, "retarget", "--finish"), finish.errors).toBe(0);

    expect(prompts.calls.map((call) => call.message)).toEqual([
      destroyConfirmPrompt(APP, "hetzner"),
    ]);
    expect(prompts.calls[0]?.message).toBe(
      "Type shop to cancel the Hetzner server, billed until the end of its term, and delete the rest listed above; its disk and its Hetzner snapshots go when the term ends (anything else stops with nothing changed)",
    );
    expect(poweredOff).toEqual([OLD_IDS.hetzner]);
    expect(finish.output).toContain("its contract ends on 11 December 2026");
  });
});
