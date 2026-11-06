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
import { MaintenanceWindowApproval, NonInteractiveApprovalHandler } from "../approval";
import { CANCEL, GIT, run, ScriptedPrompts } from "../ui/__fixtures__/harness";
import {
  HOST_KEY_FINGERPRINT,
  type MoveProject,
  moveProject,
  OWN_NEW_IPV4,
} from "../ui/__fixtures__/retarget";
import { retargetStatusLine } from "../ui/retarget";
import { flagProblems, RetargetApprovalHandler } from "./retarget";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const BUCKET = "shop-uploads";
const KEY = `SHA256:${"A".repeat(43)}`;

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

function scripted(options: { approve?: string; allowDowntime?: boolean; confirm?: string[] } = {}) {
  const printed: string[] = [];
  const base = new NonInteractiveApprovalHandler({
    ...(options.approve !== undefined ? { approvePlanHashes: [options.approve] } : {}),
    assumeYes: true,
    approver: "--yes flag",
  });
  const retarget = new RetargetApprovalHandler(base, {
    interactive: false,
    ...(options.approve !== undefined ? { approve: options.approve } : {}),
    typed: () => options.confirm ?? [],
    print: (text) => printed.push(text),
  });
  // As `opscrew retarget` wraps it with `--allow-downtime`.
  const handler = options.allowDowntime
    ? new MaintenanceWindowApproval(retarget, {
        interactive: false,
        print: (text) => printed.push(text),
        clock: { now: () => new Date("2026-10-13T12:00:00.000Z") },
      })
    : retarget;
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
    const { handler } = scripted({ allowDowntime: true, approve: HASH, confirm: [APP] });
    expect((await handler.request(hostKey)).approved).toBe(false);
  });

  it("approves an infrastructure plan only when --approve names its hash", async () => {
    expect((await scripted({ approve: HASH }).handler.request(apply(HASH))).approved).toBe(true);
    expect((await scripted({ approve: HASH }).handler.request(apply(OTHER))).approved).toBe(false);
    expect((await scripted().handler.request(apply(HASH))).approved).toBe(false);
  });

  it("approves a deletion only with its hash and a --confirm naming its confirmPhrase", async () => {
    const ok = scripted({ approve: HASH, confirm: [APP] });
    expect(await ok.handler.request(deletion(HASH))).toMatchObject({
      approved: true,
      confirmation: APP,
    });
    expect(ok.printed.join("")).toContain("approved with --approve and --confirm");

    const otherHash = scripted({ approve: OTHER, confirm: [APP] });
    expect(await otherHash.handler.request(deletion(HASH))).toMatchObject({ approved: false });
    const noConfirm = scripted({ approve: HASH });
    expect(await noConfirm.handler.request(deletion(HASH))).toMatchObject({
      approved: false,
      reason: "deleting needs --confirm shop",
    });
    const otherName = scripted({ approve: HASH, confirm: [BUCKET] });
    expect((await otherName.handler.request(deletion(HASH))).approved).toBe(false);
  });

  it("takes either name as each request asks: the app's, or the bucket's for its deletion", async () => {
    const bucket: ApprovalRequest = { ...deletion(HASH), confirmPhrase: BUCKET };
    const both = scripted({ approve: HASH, confirm: [APP, BUCKET] });
    expect(await both.handler.request(bucket)).toMatchObject({
      approved: true,
      confirmation: BUCKET,
    });
    expect(await both.handler.request(deletion(HASH))).toMatchObject({
      approved: true,
      confirmation: APP,
    });
    const appOnly = scripted({ approve: HASH, confirm: [APP] });
    expect(await appOnly.handler.request(bucket)).toMatchObject({
      approved: false,
      reason: `deleting needs --confirm ${BUCKET}`,
    });
  });

  it.each(["stack-apply", "host-apply", "pages-apply", "cloudflare-apply"] as const)(
    "approves a %s that asks for the name only with its hash and --confirm <app name>",
    async (kind) => {
      const plan: ApprovalRequest = { ...deletion(HASH), kind, title: "Change shop" };
      expect(await scripted({ approve: HASH, confirm: [APP] }).handler.request(plan)).toMatchObject(
        { approved: true, confirmation: APP },
      );
      expect(await scripted({ approve: HASH }).handler.request(plan)).toMatchObject({
        approved: false,
        reason: "deleting needs --confirm shop",
      });
      const otherHash = scripted({ approve: OTHER, confirm: [APP] });
      expect((await otherHash.handler.request(plan)).approved).toBe(false);
    },
  );

  it.each(["pages-apply", "cloudflare-apply"] as const)(
    "grants a %s that asks for no name by its hash only",
    async (kind) => {
      const plan: ApprovalRequest = { ...apply(HASH), kind };
      expect((await scripted({ approve: HASH }).handler.request(plan)).approved).toBe(true);
      expect((await scripted({ approve: OTHER }).handler.request(plan)).approved).toBe(false);
    },
  );

  it("leaves the GitHub steps to --yes", async () => {
    const { handler } = scripted();
    const secrets = await handler.request({ kind: "github-secrets", title: "Store", details: "" });
    expect(secrets.approved).toBe(true);
  });
});

describe("RetargetApprovalHandler in a terminal", () => {
  it("approves a deletion once its name was typed, and asks for everything else", async () => {
    const base = new RecordingApprovals();
    const typed: string[] = [];
    const printed: string[] = [];
    const handler = new RetargetApprovalHandler(base, {
      interactive: true,
      typed: () => typed,
      print: (text) => printed.push(text),
    });
    await handler.request(deletion(HASH));
    expect(base.requests).toHaveLength(1); // not typed yet: the normal prompt
    typed.push(APP);
    expect(await handler.request(deletion(HASH))).toMatchObject({
      approved: true,
      approver: "typed name",
    });
    expect(printed.join("")).toContain(`Plan hash: ${HASH}`);
    // The bucket's name was not typed: the normal prompt asks for it.
    await handler.request({ ...deletion(HASH), confirmPhrase: BUCKET });
    await handler.request(maintenance);
    await handler.request(apply(HASH));
    expect(base.requests.map((r) => r.title)).toEqual([
      deletion(HASH).title,
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
    expect(flagProblems({ to: "digitalocean", keepBucket: true })).toEqual([]);
    expect(flagProblems({ approve: HASH, dnsSwitched: true, yes: true })).toEqual([]);
    expect(
      flagProblems({ finish: true, snapshot: false, confirm: [APP, BUCKET], approve: HASH }),
    ).toEqual([]);
    expect(flagProblems({ abort: true, confirm: [APP], approve: HASH })).toEqual([]);
    // A site's switch takes the app's name in a script.
    expect(flagProblems({ to: "github-pages", pagesVerification: "abc", confirm: [APP] })).toEqual(
      [],
    );
  });

  it("explains combinations that do not fit", () => {
    expect(flagProblems({ finish: true, abort: true })).toEqual([
      "Use either --finish or --abort, not both.",
    ]);
    expect(flagProblems({ abort: true, to: "hetzner", allowDowntime: true })[0]).toBe(
      "--to, --allow-downtime only apply when starting or continuing a move, not with --abort.",
    );
    expect(flagProblems({ finish: true, keepBucket: true, pagesVerification: "x" })[0]).toBe(
      "--pages-verification, --keep-bucket only apply when starting or continuing a move, not with --finish.",
    );
    expect(flagProblems({ abort: true, snapshot: true })[0]).toContain(
      "--snapshot is only used with --finish",
    );
    expect(flagProblems({ approve: "abc" })[0]).toContain("64-character");
  });

  it("refuses a server move's flags for a site, and a site's or a bucket's elsewhere", () => {
    expect(
      flagProblems({ to: "github-pages", empty: ["db"], allowDowntime: true, option: "x" }),
    ).toEqual(["--option, --empty, --allow-downtime do not apply to a move to github-pages."]);
    expect(flagProblems({ to: "cloudflare-workers", keepBucket: true })).toEqual([
      "--keep-bucket does not apply to a move to cloudflare-workers.",
    ]);
    expect(flagProblems({ to: "cloudflare-workers", pagesVerification: "x" })).toEqual([
      "--pages-verification does not apply to a move to cloudflare-workers.",
    ]);
    expect(flagProblems({ to: "own", keepBucket: true })).toEqual([
      "--keep-bucket does not apply to a move to own.",
    ]);
  });

  it("refuses the own server's and Portainer's flags for a move elsewhere", () => {
    expect(
      flagProblems({ to: "digitalocean", answers: "a.yaml", publicImage: true, hostKey: KEY }),
    ).toEqual(["--answers, --host-key, --public-image do not apply to a move to digitalocean."]);
    expect(flagProblems({ to: "own", portainerAddress: "203.0.113.5" })).toEqual([
      "--portainer-address does not apply to a move to own.",
    ]);
    expect(flagProblems({ to: "portainer", passwordLogins: "off" })).toEqual([
      "--password-logins does not apply to a move to portainer.",
    ]);
    expect(flagProblems({ to: "own", answers: "a.yaml", hostKey: KEY })).toEqual([]);
    expect(
      flagProblems({ to: "portainer", answers: "a.yaml", portainerCert: "x", publicImage: true }),
    ).toEqual([]);
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
      "  retarget  moving from Hetzner Cloud to DigitalOcean; last completed step: created (the new Droplet on DigitalOcean created); next: run `opscrew retarget` to continue, or `opscrew retarget --abort` to undo the move.",
    );
    expect(retargetStatusLine(moving({ step: "switched" }))).toContain(
      "next: run `opscrew retarget --finish` to delete the old server on Hetzner Cloud once the app works on the new Droplet on DigitalOcean.",
    );
    expect(
      retargetStatusLine(moving({ step: "deployed", abort: { step: "new-removed" } })),
    ).toContain(
      "being aborted (last completed abort step: new-removed); next: run `opscrew retarget --abort`",
    );
    expect(
      retargetStatusLine(moving({ step: "deployed", oldAppStoppedAt: "2026-10-13T12:05:00.000Z" })),
    ).toContain("the app on the old server on Hetzner Cloud is stopped");
  });

  it("shows the step for a move to or from the user's own server and Portainer", () => {
    const own = {
      provider: "own",
      mode: "vps-compose",
      arch: "amd64",
      access: "public",
      edge: "caddy",
    } as const;
    const portainer = {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 3,
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "caddy" },
    } as const;
    const plan = testPlan({ deployed: true, userSecret: false, domain: "shop.example.com" });
    const between = (
      from: DeployPlan["target"],
      to: DeployPlan["target"],
      retarget: Record<string, unknown>,
    ) =>
      DeployPlanSchema.parse({
        ...plan,
        target: to,
        retarget: { from: { target: from }, startedAt: "2026-10-13T12:00:00.000Z", ...retarget },
      });
    expect(retargetStatusLine(between(plan.target, own, { step: "created" }))).toContain(
      "moving from Hetzner Cloud to your own server; last completed step: created (your new server prepared)",
    );
    expect(retargetStatusLine(between(plan.target, portainer, { step: "deployed" }))).toContain(
      "moving from Hetzner Cloud to your Portainer; last completed step: deployed (app deployed in your Portainer)",
    );
    expect(retargetStatusLine(between(own, plan.target, { step: "switched" }))).toContain(
      "next: run `opscrew retarget --finish` to remove the app from your old server once the app works on the new server on Hetzner Cloud.",
    );
    expect(
      retargetStatusLine(
        between(portainer, plan.target, {
          step: "migrated",
          oldAppStoppedAt: "2026-10-13T12:05:00.000Z",
        }),
      ),
    ).toContain(
      "last completed step: migrated (data copied to the new server on Hetzner Cloud); the app in your Portainer is stopped",
    );
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

  it("refuses a Portainer behind the user's own proxy with Cloudflare DNS before any change", async () => {
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
      "Your app on your Portainer is served behind your own proxy with its DNS on Cloudflare",
    );
    expect(ctx.errors).toContain("Nothing was changed.");
    expect(move.events).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).target).toEqual(portainer.target);
  });

  it.each([
    [["--to", "own", "--host-key", "SHA256:short"], "--host-key expects"],
    [["--to", "portainer", "--portainer-address", "not-an-ip"], "--portainer-address expects"],
    [["--to", "portainer", "--portainer-cert", "nope"], "--portainer-cert expects"],
    [["--finish", "--empty", "db", "--answers", "a.yaml"], "--answers, --empty only apply"],
  ])("refuses %j before anything happens", async (args, message) => {
    move = await moveProject();
    const ctx = move.context();
    expect(await run(ctx, "retarget", ...args)).toBe(2);
    expect(ctx.errors).toContain(message);
    expect(move.events).toEqual([]);
  });

  it("stops in a script without the own server's answers, naming --answers", async () => {
    move = await moveProject();
    const ctx = move.context();
    expect(await run(ctx, "retarget", "--to", "own")).toBe(1);
    expect(ctx.errors).toContain("OpsCrew needs the answers about your new server");
    expect(ctx.errors).toContain("--answers");
    expect(move.events).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).retarget).toBeUndefined();
  });

  it("asks a terminal the own server's questions as the interview does, and what starts empty", async () => {
    move = await moveProject();
    const prompts = new ScriptedPrompts([
      OWN_NEW_IPV4,
      "22",
      "root",
      "agent",
      true,
      "dns-only",
      false, // db starts empty
      false, // the summary is declined
    ]);
    const approvals = new RecordingApprovals();
    const ctx = move.context({
      interactive: true,
      services: { prompts, approvalHandler: approvals },
    });
    expect(
      await run(ctx, "retarget", "--to", "own", "--host-key", HOST_KEY_FINGERPRINT),
      ctx.errors,
    ).toBe(1);
    expect(prompts.calls.map((call) => call.message.split("\n")[0])).toEqual([
      "What is your server's address?",
      "Which port do you connect to for SSH?",
      "Which user should OpsCrew log in as?",
      "Which SSH key should OpsCrew use?",
      "Can the internet reach this server directly?",
      "If the internet can reach your server, how should it serve the site?",
      expect.stringMatching(
        /^Copy db's data \(50\.0 MB\) to your own server\? Starting it empty loses/,
      ),
      "Start the move to your own server? It adds no monthly cost, with no maintenance window.",
    ]);
    expect(ctx.output).toContain("Db's data at /var/lib/postgresql/data: 50.0 MB, starts empty");
    expect(ctx.errors).toContain("The move was not started. Nothing was changed.");
    expect(approvals.requests).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).retarget).toBeUndefined();
  });

  it("changes nothing when the summary is declined in a terminal", async () => {
    move = await moveProject();
    const prompts = new ScriptedPrompts(["digitalocean-single-s-2vcpu-4gb-fra1", true, false]);
    const approvals = new RecordingApprovals();
    const ctx = move.context({
      interactive: true,
      services: { prompts, approvalHandler: approvals },
    });
    expect(await run(ctx, "retarget", "--to", "digitalocean")).toBe(1);
    expect(prompts.calls.map((call) => call.kind)).toEqual(["select", "confirm", "confirm"]);
    expect(prompts.calls[0]?.initial).toBe("digitalocean-single-s-1vcpu-2gb-fra1");
    // Each owner of data: copy it (the default) or start it empty, with its size.
    expect(prompts.calls[1]?.message).toMatch(/^Copy db's data \(50\.0 MB\) to DigitalOcean\? /);
    expect(prompts.calls[1]?.initial).toBe(true);
    expect(prompts.calls[2]?.message).toBe(
      "Start the move to DigitalOcean? It costs $31.20 per month extra while both run, with about 3 minutes of downtime while the data is copied.",
    );
    // The summary lists each data mount with its size, and the window's minutes.
    expect(ctx.output).toContain("Extra cost while both run");
    expect(ctx.output).toContain("Db's data at /var/lib/postgresql/data: 50.0 MB, copied");
    expect(ctx.output).toContain("Expected maintenance window: about 3 minutes.");
    expect(ctx.errors).toContain("The move was not started. Nothing was changed.");
    expect(move.engine.applied).toEqual([]);
    expect(approvals.requests).toEqual([]);
    expect((await readArtifact("plan", move.paths.files.plan)).retarget).toBeUndefined();
  });

  it("moves in one terminal run after the choice and the summary, then finishes after the typed name", async () => {
    move = await moveProject();
    const m = move;
    const prompts = new ScriptedPrompts(["digitalocean-single-s-2vcpu-4gb-fra1", true, true]);
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
    expect(finish.output).toContain("(confirmed with the typed name)");
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
