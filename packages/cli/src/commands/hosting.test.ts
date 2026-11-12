/**
 * The CLI for an app on a hosting account (feature 027, T2715): the commands that need a server
 * refuse it plainly with what to use instead, its removal is confirmed with the hostname, and
 * provision's hosting plans are approved only by their hashes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DestroyOptions,
  DestroyPreview,
  DestroyResult,
  PhaseDeps,
  ProvisionResult,
  RunProvisionOptions,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { FlagConfirmation, NonInteractiveApprovalHandler } from "../approval";
import { CliExit } from "../exit";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { HOSTING_HOSTNAME, writeHostingPlan } from "../ui/__fixtures__/hosting";
import { type DestroyFlags, runDestroyCommand } from "./destroy";
import { runInfraCommand } from "./provision";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function hostingProject(): Promise<TempProject> {
  project = await tempProject();
  await writeHostingPlan(project);
  return project;
}

const AGENT_PLAN = "a1".repeat(32);
const APP_PLAN = "b2".repeat(32);

/** A hosting plan's approval, as provision asks it. */
const hostingApply = (planHash: string, overrides: Partial<ApprovalRequest> = {}) =>
  ({
    kind: "hosting-apply",
    title: "Apply hosting plan A to the cPanel account acct at panel.example.com (2 changes)",
    details: `Hosting plan hash: ${planHash}`,
    planHash,
    ...overrides,
  }) satisfies ApprovalRequest;

describe("the commands that need a server, on a hosting account", () => {
  it.each([
    [["logs", "--service", "app"], "`opscrew logs --service`", "the agent's last lines"],
    [["logs", "--failed"], "`opscrew logs --failed`", "the agent's last lines"],
    [["logs", "--follow"], "`opscrew logs --follow`", "the agent's last lines"],
    [["addon", "enable", "beszel"], "`opscrew addon enable beszel`", "cPanel's Metrics"],
    [["addon", "enable", "monitoring"], "`opscrew addon enable monitoring`", "cPanel's Metrics"],
    [["addon", "status"], "`opscrew addon status`", "cPanel's Metrics"],
    [["addon", "open", "beszel"], "`opscrew addon open beszel`", "cPanel's Metrics"],
    [["preview", "list"], "`opscrew preview list`", "opscrew env add preview --previews"],
    [["runner", "start"], "`opscrew runner start`", "GitHub's own runners build"],
    [["env", "set", "prod", "--runner", "server"], "--runner server", "GitHub's own runners"],
    [["vpn", "list"], "`opscrew vpn list`", "phpMyAdmin"],
    [["vpn", "add", "laptop"], "`opscrew vpn add laptop`", "phpMyAdmin"],
    [["retarget", "--to", "hetzner"], "`opscrew retarget`", "opscrew destroy"],
    [["portainer", "enable"], "`opscrew portainer enable`", "Your panel shows"],
    [["portainer", "disable"], "`opscrew portainer disable`", "Your panel shows"],
    [["portainer", "status"], "`opscrew portainer status`", "Your panel shows"],
  ])("opscrew %j refuses plainly and says what to use instead", async (args, what, instead) => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    expect(await run(ctx, ...args)).toBe(1);
    expect(ctx.errors).toContain(what);
    expect(ctx.errors).toContain("doesn't apply to a hosting account");
    expect(ctx.errors).toContain(instead);
    expect(ctx.fetchUrls).toEqual([]);
  });

  it("refuses a move to a hosting account, from any target", async () => {
    project = await tempProject();
    const ctx = projectContext(project);
    expect(await run(ctx, "retarget", "--to", "hosting")).toBe(1);
    expect(ctx.errors).toContain("doesn't move an app to a hosting account");
    expect(ctx.errors).toContain("opscrew destroy");
  });
});

interface FakeDestroy {
  options: DestroyOptions[];
  decisions: ApprovalDecision[];
  destroy: (deps: PhaseDeps, options: DestroyOptions) => Promise<DestroyResult>;
}

/** A fake teardown of the hosting account's objects, confirmed with the hostname. */
function fakeDestroy(): FakeDestroy {
  const seen: FakeDestroy = {
    options: [],
    decisions: [],
    destroy: async (deps, options) => {
      seen.options.push(options);
      const preview: DestroyPreview = {
        name: HOSTING_HOSTNAME,
        confirmPrompt: `Type ${HOSTING_HOSTNAME} to remove the app from your hosting account`,
        // The hosting teardown (T2713) adds "hosting" to the deletion providers.
        provider: "hosting",
        deleteProtection: false,
        resources: [],
        snapshot: false,
      };
      if (options.confirm !== undefined && !(await options.confirm(preview))) {
        throw new OpsCrewError("APPROVAL_REFUSED", "The hostname was not confirmed.");
      }
      const decision = await deps.approvals.request(
        hostingApply(APP_PLAN, { allowDestroy: true, confirmPhrase: HOSTING_HOSTNAME }),
      );
      seen.decisions.push(decision);
      if (!decision.approved) throw new OpsCrewError("APPROVAL_REFUSED", "Not approved.");
      return { destroyed: [], secretsRemoved: [], remaining: [] };
    },
  };
  return seen;
}

async function destroy(
  ctx: ReturnType<typeof projectContext>,
  flags: DestroyFlags,
  fake: FakeDestroy,
): Promise<number> {
  try {
    await runDestroyCommand(ctx, flags, fake.destroy);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.exitCode;
    throw error;
  }
}

describe("opscrew destroy on a hosting account", () => {
  it("--confirm <hostname> approves the removal plan, typed with the hostname", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const fake = fakeDestroy();
    expect(await destroy(ctx, { confirm: [HOSTING_HOSTNAME] }, fake), ctx.errors).toBe(0);
    expect(fake.decisions[0]).toMatchObject({ approved: true });
    expect(ctx.output).toContain("(confirmed with the app's hostname)");
  });

  it("refuses the app's name in place of the hostname, changing nothing", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const fake = fakeDestroy();
    expect(await destroy(ctx, { confirm: ["example-app"] }, fake)).toBe(1);
    expect(ctx.errors).toContain("does not match the app's hostname");
    expect(ctx.errors).toContain(`opscrew destroy --confirm ${HOSTING_HOSTNAME}`);
    expect(fake.options).toEqual([]);
  });

  it("asks a terminal for the hostname", async () => {
    const p = await hostingProject();
    const prompts = new ScriptedPrompts([HOSTING_HOSTNAME]);
    const ctx = projectContext(p, { interactive: true, services: { prompts } });
    const fake = fakeDestroy();
    expect(await destroy(ctx, {}, fake), ctx.errors).toBe(0);
    expect(prompts.calls[0]?.message).toContain(`Type ${HOSTING_HOSTNAME}`);
    expect(fake.decisions[0]).toMatchObject({ approved: true });
  });

  it("refuses a run nobody can confirm, naming --confirm with the hostname", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const fake = fakeDestroy();
    expect(await destroy(ctx, {}, fake)).toBe(1);
    expect(ctx.errors).toContain("needs the app's hostname typed by a person");
    expect(ctx.errors).toContain(`opscrew destroy --confirm ${HOSTING_HOSTNAME}`);
    expect(fake.options).toEqual([]);
  });

  it("passes --snapshot and --no-snapshot on, for the final dump's offer", async () => {
    const p = await hostingProject();
    for (const snapshot of [true, false]) {
      const ctx = projectContext(p);
      const fake = fakeDestroy();
      expect(await destroy(ctx, { confirm: [HOSTING_HOSTNAME], snapshot }, fake), ctx.errors).toBe(
        0,
      );
      expect(fake.options[0]?.snapshot).toBe(snapshot);
    }
  });

  it("refuses --undo-host: OpsCrew changed nothing of the account's own", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const fake = fakeDestroy();
    expect(await destroy(ctx, { confirm: [HOSTING_HOSTNAME], undoHost: true }, fake)).toBe(2);
    expect(ctx.errors).toContain("--undo-host applies only to a server you already own");
    expect(fake.options).toEqual([]);
  });
});

/** Runs provision with a fake phase that returns `result` after asking `requests`. */
async function provision(
  ctx: ReturnType<typeof projectContext>,
  flags: Parameters<typeof runInfraCommand>[2],
  result: ProvisionResult,
  requests: ApprovalRequest[] = [],
): Promise<{ code: number; decisions: ApprovalDecision[]; options: RunProvisionOptions[] }> {
  const decisions: ApprovalDecision[] = [];
  const options: RunProvisionOptions[] = [];
  const fake = async (deps: PhaseDeps, given: RunProvisionOptions) => {
    options.push(given);
    for (const request of requests) {
      const decision = await deps.approvals.request(request);
      decisions.push(decision);
      if (!decision.approved) {
        throw new OpsCrewError("APPROVAL_REFUSED", `Refused: ${decision.reason ?? ""}`);
      }
    }
    return result;
  };
  try {
    await runInfraCommand(ctx, "provision", flags, fake);
    return { code: 0, decisions, options };
  } catch (error) {
    if (error instanceof CliExit) return { code: error.exitCode, decisions, options };
    throw error;
  }
}

describe("opscrew provision on a hosting account", () => {
  it("--plan-only prints the hosting plan's --approve command and never grants it with --yes", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const { code } = await provision(
      ctx,
      { planOnly: true },
      { applied: false, outputs: {}, hostingPlanHashes: [AGENT_PLAN] },
    );
    expect(code, ctx.errors).toBe(0);
    expect(ctx.output).toContain(`opscrew provision --approve ${AGENT_PLAN}`);
    expect(ctx.output).toContain("A hosting plan is approved only by its hash, never by --yes");
    expect(ctx.output).toContain("opscrew provision --approve <its hash> --yes");
    expect(ctx.output).not.toContain("Nothing to apply");
  });

  it("says the account already matches when no hosting plan changes anything", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const { code } = await provision(ctx, { planOnly: true }, { applied: false, outputs: {} });
    expect(code, ctx.errors).toBe(0);
    expect(ctx.output).toContain("your hosting account already matches the plans");
    expect(ctx.output).not.toContain("server readiness");
  });

  it("grants each hosting plan only by its own --approve hash; --yes grants none", async () => {
    const p = await hostingProject();
    const requests = [hostingApply(AGENT_PLAN), hostingApply(APP_PLAN)];
    const result: ProvisionResult = { applied: true, outputs: {} };

    const both = await provision(
      projectContext(p),
      { approve: [AGENT_PLAN, APP_PLAN], yes: true },
      result,
      requests,
    );
    expect(both.code).toBe(0);
    expect(both.decisions.map((decision) => decision.approved)).toEqual([true, true]);

    const onlyA = await provision(projectContext(p), { approve: [AGENT_PLAN] }, result, requests);
    expect(onlyA.code).toBe(1);
    expect(onlyA.decisions.map((decision) => decision.approved)).toEqual([true, false]);
    expect(onlyA.decisions[1]?.reason).toContain("The hosting plan's hash does not match");

    const yes = await provision(projectContext(p), { yes: true }, result, requests);
    expect(yes.code).toBe(1);
    expect(yes.decisions.map((decision) => decision.approved)).toEqual([false]);
  });

  it("labels the hostname's DNS records on Cloudflare as the infrastructure plan", async () => {
    const p = await hostingProject();
    const DNS_PLAN = "d4".repeat(32);
    const dir = resolveProjectPaths(p.root, { env: p.env }).files.plansDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "20261112T120000-dns.tfplan.json"),
      JSON.stringify({
        planHash: DNS_PLAN,
        planFile: path.join(dir, "20261112T120000-dns.tfplan"),
        dir: "opscrew/infra",
        engine: { name: "tofu", version: "1.10.6", binary: "tofu" },
        createdAt: "2026-11-12T12:00:00.000Z",
        changes: [
          {
            address: "module.dns.cloudflare_dns_record.a",
            type: "cloudflare_dns_record",
            name: "a",
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            action: "create",
          },
        ],
        counts: { create: 1, update: 0, delete: 0, replace: 0 },
        hasDestroy: false,
        policy: [],
        planJson: {},
      }),
    );
    const ctx = projectContext(p);
    const { code } = await provision(
      ctx,
      { planOnly: true },
      { applied: false, outputs: {}, planHash: DNS_PLAN, hostingPlanHashes: [APP_PLAN] },
    );
    expect(code, ctx.errors).toBe(0);
    const lines = ctx.output.split("\n").map((line) => line.trim().replace(/\s+/g, " "));
    expect(lines).toContain(`infrastructure (Cloudflare): ${DNS_PLAN}`);
    expect(lines).toContain(`hosting plan for your hosting account: ${APP_PLAN}`);
    expect(ctx.output).toContain(`--approve ${DNS_PLAN}`);
  });

  it("names verify and status as the next steps once the account is set up", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    const { code } = await provision(
      ctx,
      { approve: [AGENT_PLAN] },
      {
        applied: true,
        outputs: { url: `https://${HOSTING_HOSTNAME}` },
        hostingPlanHashes: [AGENT_PLAN],
        published: true,
        pushed: true,
        prUrl: "https://github.com/acme/notes/pull/1",
      },
    );
    expect(code, ctx.errors).toBe(0);
    expect(ctx.output).toContain("opscrew verify");
    expect(ctx.output).toContain("the release your hosting account runs");
    expect(ctx.output).not.toContain("secure");
  });
});

describe("opscrew rollback's restore on a hosting account", () => {
  const ROLLBACK = "c3".repeat(32);
  const clock = { now: () => new Date("2026-11-12T12:00:00.000Z") };
  /** The rollback that restores the database: a promotion that deletes, typed with the hostname. */
  const restore = {
    kind: "promote",
    title: "Roll notes.example.com back to 41-1 and restore its database",
    details: `Rollback hash: ${ROLLBACK}`,
    planHash: ROLLBACK,
    allowDestroy: true,
    confirmPhrase: HOSTING_HOSTNAME,
  } satisfies ApprovalRequest;
  /** Rollback's typed-name handler in a script, with `--confirm` values and `--approve`. */
  const script = (names: string[]) =>
    new FlagConfirmation(
      new NonInteractiveApprovalHandler({ approvePlanHashes: [ROLLBACK], approver: "t", clock }),
      {
        kinds: ["promote"],
        what: "a rollback that changes the database",
        names,
        hashes: [ROLLBACK],
        interactive: false,
        print: () => {},
        clock,
      },
    );

  it("takes --confirm <hostname> with --approve, never the app's name", async () => {
    expect(await script([HOSTING_HOSTNAME]).request(restore)).toMatchObject({
      approved: true,
      confirmation: HOSTING_HOSTNAME,
    });
    const named = await script(["example-app"]).request(restore);
    expect(named.approved).toBe(false);
    expect(named.reason).toContain(`--confirm ${HOSTING_HOSTNAME}`);
  });
});

describe("opscrew status on a hosting account", () => {
  it("reads no proxy or certificate of a server: the hosting status names its certificate", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    expect(await run(ctx, "status"), ctx.errors).toBe(0);
    expect(ctx.output).not.toContain("Proxy:");
    expect(ctx.errors).not.toContain("isn't available for a hosting account");
  });

  it("--ip says there is no server address", async () => {
    const p = await hostingProject();
    const ctx = projectContext(p);
    expect(await run(ctx, "status", "--ip")).toBe(1);
    expect(ctx.errors).toContain("no server of OpsCrew's, so there is no server address");
  });
});
