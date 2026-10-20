import { readServerAddresses } from "@opscrew/agents";
import { APP, NEW_SERVERS, testPlan } from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { NonInteractiveApprovalHandler } from "../approval";
import { CANCEL, GIT, run, ScriptedPrompts } from "../ui/__fixtures__/harness";
import { type MoveProject, moveProject } from "../ui/__fixtures__/retarget";
import { retargetStatusLine } from "../ui/retarget";
import { flagProblems, RetargetApprovalHandler } from "./retarget";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

/** Answers yes to whatever reaches it and records the requests. */
class RecordingApprovals implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approver: "test", decidedAt: "2026-10-13T12:00:00.000Z" };
  }
}

const maintenance: ApprovalRequest = {
  kind: "remote-exec",
  title: "Maintenance window: stop shop on the old server and copy its database",
  details: "docker compose stop app",
};
const hostKey: ApprovalRequest = {
  kind: "remote-exec",
  title: "Trust the new SSH host key of 198.51.100.30",
  details: "The server's SSH host key is different from the one OpsCrew pinned earlier.",
};
const deletion = (planHash: string): ApprovalRequest => ({
  kind: "iac-apply",
  title: "Delete the old server shop on Hetzner Cloud (3 resources to delete)",
  details: `Plan hash: ${planHash}`,
  planHash,
  allowDestroy: true,
  confirmPhrase: APP,
});
const apply = (planHash: string): ApprovalRequest => ({
  kind: "iac-apply",
  title: "Apply the plan",
  details: "",
  planHash,
});

function scripted(
  options: { approve?: string; allowDowntime?: boolean; confirm?: string; appName?: string } = {},
) {
  const printed: string[] = [];
  const base = new NonInteractiveApprovalHandler({
    ...(options.approve !== undefined ? { approvePlanHashes: [options.approve] } : {}),
    assumeYes: true,
    approver: "--yes flag",
  });
  const handler = new RetargetApprovalHandler(base, {
    interactive: false,
    ...(options.appName !== undefined ? { appName: options.appName } : {}),
    ...(options.approve !== undefined ? { approve: options.approve } : {}),
    ...(options.allowDowntime ? { allowDowntime: true } : {}),
    typed: () => options.confirm,
    print: (text) => printed.push(text),
  });
  return { handler, printed };
}

describe("RetargetApprovalHandler in a non-interactive run", () => {
  it("approves the maintenance window only with --allow-downtime", async () => {
    expect((await scripted().handler.request(maintenance)).approved).toBe(false);
    const { handler, printed } = scripted({ allowDowntime: true });
    expect(await handler.request(maintenance)).toMatchObject({
      approved: true,
      approver: "--allow-downtime flag",
    });
    expect(printed.join("")).toContain("allowed with --allow-downtime");
  });

  it("never approves a changed host key, not even with --allow-downtime, --yes and --approve", async () => {
    const { handler } = scripted({
      allowDowntime: true,
      approve: HASH,
      confirm: APP,
      appName: APP,
    });
    expect((await handler.request(hostKey)).approved).toBe(false);
  });

  it("approves an infrastructure plan only when --approve names its hash", async () => {
    expect((await scripted({ approve: HASH }).handler.request(apply(HASH))).approved).toBe(true);
    expect((await scripted({ approve: HASH }).handler.request(apply(OTHER))).approved).toBe(false);
    expect((await scripted().handler.request(apply(HASH))).approved).toBe(false);
  });

  it("approves a deletion only with its hash and --confirm <app name>", async () => {
    const ok = scripted({ approve: HASH, confirm: APP, appName: APP });
    expect(await ok.handler.request(deletion(HASH))).toMatchObject({
      approved: true,
      confirmation: APP,
    });
    expect(ok.printed.join("")).toContain("approved with --approve and --confirm");

    const otherHash = scripted({ approve: OTHER, confirm: APP, appName: APP });
    expect(await otherHash.handler.request(deletion(HASH))).toMatchObject({ approved: false });
    const noConfirm = scripted({ approve: HASH, appName: APP });
    expect(await noConfirm.handler.request(deletion(HASH))).toMatchObject({
      approved: false,
      reason: "deleting needs --confirm shop",
    });
    // In `opscrew retarget` (no --finish or --abort) nothing is deleted at all.
    const run = scripted({ approve: HASH, confirm: APP });
    expect((await run.handler.request(deletion(HASH))).approved).toBe(false);
  });

  it("leaves the GitHub steps to --yes", async () => {
    const { handler } = scripted();
    const secrets = await handler.request({ kind: "github-secrets", title: "Store", details: "" });
    expect(secrets.approved).toBe(true);
  });
});

describe("RetargetApprovalHandler in a terminal", () => {
  it("approves a deletion once the app name was typed, and asks for everything else", async () => {
    const base = new RecordingApprovals();
    let typed: string | undefined;
    const printed: string[] = [];
    const handler = new RetargetApprovalHandler(base, {
      interactive: true,
      appName: APP,
      allowDowntime: true,
      typed: () => typed,
      print: (text) => printed.push(text),
    });
    await handler.request(deletion(HASH));
    expect(base.requests).toHaveLength(1); // not typed yet: the normal prompt
    typed = APP;
    expect(await handler.request(deletion(HASH))).toMatchObject({
      approved: true,
      approver: "typed app name",
    });
    expect(printed.join("")).toContain(`Plan hash: ${HASH}`);
    await handler.request(maintenance);
    await handler.request(apply(HASH));
    expect(base.requests.map((r) => r.title)).toEqual([
      deletion(HASH).title,
      maintenance.title,
      apply(HASH).title,
    ]);
  });
});

describe("flagProblems", () => {
  it("accepts the documented combinations", () => {
    expect(flagProblems({})).toEqual([]);
    expect(flagProblems({ to: "digitalocean", option: "x", allowDowntime: true })).toEqual([]);
    expect(flagProblems({ approve: HASH, dnsSwitched: true, yes: true })).toEqual([]);
    expect(flagProblems({ finish: true, snapshot: false, confirm: APP, approve: HASH })).toEqual(
      [],
    );
    expect(flagProblems({ abort: true, confirm: APP, approve: HASH })).toEqual([]);
  });

  it("explains combinations that do not fit", () => {
    expect(flagProblems({ finish: true, abort: true })).toEqual([
      "Use either --finish or --abort, not both.",
    ]);
    expect(flagProblems({ abort: true, to: "hetzner", allowDowntime: true })[0]).toBe(
      "--to, --allow-downtime only apply when starting or continuing a move, not with --abort.",
    );
    expect(flagProblems({ confirm: APP })[0]).toContain("only used with --finish or --abort");
    expect(flagProblems({ abort: true, snapshot: true })[0]).toContain(
      "--snapshot is only used with --finish",
    );
    expect(flagProblems({ approve: "abc" })[0]).toContain("64-character");
  });
});

describe("retargetStatusLine", () => {
  const moving = (retarget: Record<string, unknown>): DeployPlan => {
    const from = testPlan({ deployed: true, userSecret: false });
    return DeployPlanSchema.parse({
      ...from,
      target: {
        ...from.target,
        provider: "digitalocean",
        location: "fra1",
        serverType: "s-1vcpu-2gb",
      },
      retarget: {
        from: { target: from.target },
        startedAt: "2026-10-13T12:00:00.000Z",
        ...retarget,
      },
    });
  };

  it("is absent without a move", () => {
    expect(retargetStatusLine(testPlan({ deployed: true, userSecret: false }))).toBeUndefined();
  });

  it("names the providers, the last step and the next command", () => {
    expect(retargetStatusLine(moving({ step: "created" }))).toBe(
      "  retarget  moving from Hetzner Cloud to DigitalOcean; last completed step: created (new server created); next: run `opscrew retarget` to continue, or `opscrew retarget --abort` to undo the move.",
    );
    expect(retargetStatusLine(moving({ step: "switched" }))).toContain(
      "next: run `opscrew retarget --finish`",
    );
    expect(
      retargetStatusLine(moving({ step: "deployed", abort: { step: "new-removed" } })),
    ).toContain(
      "being aborted (last completed abort step: new-removed); next: run `opscrew retarget --abort`",
    );
    expect(
      retargetStatusLine(moving({ step: "deployed", oldAppStoppedAt: "2026-10-13T12:05:00.000Z" })),
    ).toContain("the app on the old server is stopped");
  });
});

let move: MoveProject | undefined;
afterEach(async () => {
  await move?.project.cleanup();
  move = undefined;
});

describe.skipIf(!GIT)("opscrew retarget", () => {
  it("explains moving between providers in --help", async () => {
    move = await moveProject();
    const ctx = move.context();
    expect(await run(ctx, "retarget", "--help")).toBe(0);
    expect(ctx.output).toContain("Move the live deployment to another cloud provider");
    expect(ctx.output).toContain("opscrew retarget --finish");
    expect(ctx.output).toContain("--allow-downtime");
    expect(ctx.output).toContain("--dns-switched");
    // Plain English: never a colon right after an environment variable name.
    expect(ctx.output).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+:/);
  });

  it.each([
    [["--finish", "--abort"]],
    [["--to", "digitalocean", "--finish"]],
    [["--to", "aws"]],
    [["--snapshot"]],
    [["--confirm", "shop"]],
    [["--approve", "not-a-hash"]],
    [["--abort", "--allow-downtime", "--confirm", "shop"]],
  ])("exits 2 for %j before anything happens", async (args) => {
    move = await moveProject();
    const ctx = move.context();
    expect(await run(ctx, "retarget", ...args)).toBe(2);
    expect(move.events).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).retarget).toBeUndefined();
  });

  it("refuses a wrong --confirm before anything happens", async () => {
    move = await moveProject();
    const ctx = move.context();
    expect(await run(ctx, "retarget", "--finish", "--confirm", "shpo")).toBe(1);
    expect(ctx.errors).toContain("--confirm shpo does not match the app name");
    expect(move.events).toEqual([]);
  });

  it("refuses a Portainer target plainly: it never moves", async () => {
    move = await moveProject();
    const current = await readArtifact("plan", move.paths.files.plan);
    const portainer = DeployPlanSchema.parse({
      ...current,
      target: {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 3,
        arch: "amd64",
        redeploy: "updater",
        web: { mode: "proxy", port: 8080 },
      },
    });
    await writeArtifact("plan", move.paths.files.plan, portainer);
    const ctx = move.context();
    expect(await run(ctx, "retarget", "--to", "digitalocean")).toBe(1);
    expect(ctx.errors).toContain(
      "Moving an app to or from a Portainer target is not supported; destroy it and provision again.",
    );
    expect(move.events).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).target).toEqual(portainer.target);
  });

  it("changes nothing when the summary is declined in a terminal", async () => {
    move = await moveProject();
    const prompts = new ScriptedPrompts(["digitalocean-single-s-2vcpu-4gb-fra1", false]);
    const approvals = new RecordingApprovals();
    const ctx = move.context({
      interactive: true,
      services: { prompts, approvalHandler: approvals },
    });
    expect(await run(ctx, "retarget", "--to", "digitalocean")).toBe(1);
    expect(prompts.calls.map((call) => call.kind)).toEqual(["select", "confirm"]);
    expect(prompts.calls[0]?.initial).toBe("digitalocean-single-s-1vcpu-2gb-fra1");
    expect(prompts.calls[1]?.message).toBe(
      "Start the move to DigitalOcean? It costs $31.20 per month extra while both servers run, with about 3 minutes of downtime during the database copy.",
    );
    expect(ctx.output).toContain("Extra cost while both servers run");
    expect(ctx.errors).toContain("The move was not started. Nothing was changed.");
    expect(move.engine.applied).toEqual([]);
    expect(approvals.requests).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).retarget).toBeUndefined();
  });

  it("moves in one terminal run after the choice and the summary, then finishes after the typed name", async () => {
    move = await moveProject();
    const m = move;
    const prompts = new ScriptedPrompts(["digitalocean-single-s-2vcpu-4gb-fra1", true]);
    const approvals = new RecordingApprovals();
    const ctx = m.context({ interactive: true, services: { prompts, approvalHandler: approvals } });
    expect(await run(ctx, "retarget"), ctx.errors).toBe(0);
    let plan = await readArtifact("plan", m.paths.files.plan);
    expect(plan.retarget?.step).toBe("switched");
    expect(plan.target).toMatchObject({ serverType: "s-2vcpu-4gb" });
    expect((await readServerAddresses(m.paths)).deployment?.ipv4).toBe(
      NEW_SERVERS.digitalocean.ipv4,
    );
    expect(m.engine.applied).toHaveLength(3); // rename, create, DNS switch
    expect(approvals.requests.map((r) => r.kind)).toEqual([
      "iac-apply",
      "iac-apply",
      "github-secrets",
      "remote-exec",
      "iac-apply",
    ]);
    expect(ctx.output).toContain("opscrew retarget --finish");

    // A wrong name deletes nothing, not even a snapshot.
    const wrong = new ScriptedPrompts(["shpo"]);
    const declined = m.context({
      interactive: true,
      services: { prompts: wrong, approvalHandler: approvals },
    });
    expect(await run(declined, "retarget", "--finish", "--no-snapshot")).toBe(1);
    expect(wrong.calls[0]?.message).toBe(
      "Type shop to delete everything listed above (anything else cancels)",
    );
    expect(declined.errors).toContain("nothing was deleted and nothing was changed");
    expect(m.engine.applied).toHaveLength(3);

    const cancelled = m.context({
      interactive: true,
      services: { prompts: new ScriptedPrompts([CANCEL]), approvalHandler: approvals },
    });
    expect(await run(cancelled, "retarget", "--finish")).toBe(1);
    expect(m.engine.applied).toHaveLength(3);
    expect(m.events.filter((e) => e.type === "snapshot")).toEqual([]);

    const before = approvals.requests.length;
    const finish = m.context({
      interactive: true,
      services: { prompts: new ScriptedPrompts([APP]), approvalHandler: approvals },
    });
    expect(await run(finish, "retarget", "--finish", "--no-snapshot"), finish.errors).toBe(0);
    expect(finish.output).toContain("(confirmed with the app name)");
    expect(m.events.filter((e) => e.type === "snapshot")).toEqual([]);
    // The protection lift is asked for; the deletion was confirmed with the typed name.
    expect(approvals.requests.slice(before).map((r) => r.kind)).toEqual([
      "iac-apply",
      "git-push",
      "pull-request",
    ]);
    expect(m.engine.applied).toHaveLength(5);
    plan = await readArtifact("plan", m.paths.files.plan);
    expect(plan.retarget).toBeUndefined();
  });
});
