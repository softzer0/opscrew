import { join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  HostApplyError,
  type HostFacts,
  type HostPlan,
  type HostStep,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { adapterBlocked, describeAdapterPlan } from "./adapter-plan";
import { PlanRefusedError } from "./approvals";
import type { HostChangeResult } from "./tunnel-connections";

/** The host adapter calls made on a server the user owns (`@opscrew/connector-ssh-host` or a fake). */
export interface HostAdapterApi {
  inspect(remote: RemoteExec): Promise<HostFacts>;
  apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult>;
}

/** `.opscrew/plans/host-<hash>.json`: the host plan the hash names, kept for review and audit. */
export function hostPlanFile(paths: Pick<ProjectPaths, "files">, hash: string): string {
  return join(paths.files.plansDir, `host-${hash}.json`);
}

/** Plain-English host plan shown before the `host-apply` approval: every step, then the hash. */
export function describeHostPlan(plan: HostPlan, hash: string): string {
  return describeAdapterPlan({
    heading: "Host plan for your server",
    items: plan.steps,
    findings: plan.findings,
    note: "OpsCrew changes nothing it did not list here, never removes what it did not install, and records every change (and the value it replaced) in /etc/opscrew/host.json on the server.",
    hashLabel: "Host plan hash",
    hash,
  });
}

/** Findings that need the user's explicit choice about password logins. */
const PASSWORD_CHOICE = new Set(["password-users-without-keys", "directory-logins"]);

/**
 * Stops (`PHASE_PRECONDITION`, nothing changed) when the host plan has blocking findings or
 * blocked steps: each named with what was found and what to do (the host plan's policy check).
 * `server` names the server (`your server`, `the server`) and `command` what to run again; the
 * choice about password logins is only offered by `opscrew provision`.
 */
export function requireNoBlockers(
  plan: HostPlan,
  where: Pick<HostPlanStep, "server" | "command">,
): void {
  const blocked = plan.steps.filter((step) => step.state === "blocked");
  if (plan.findings.length === 0 && blocked.length === 0) return;
  throw adapterBlocked({
    cannot: `OpsCrew cannot prepare ${where.server}`,
    findings: plan.findings,
    blocked,
    ...(plan.findings.some((finding) => PASSWORD_CHOICE.has(finding.code))
      ? {
          extraHint:
            "To decide, run `opscrew provision --password-logins off` (turn password logins off anyway) or `opscrew provision --password-logins keep` (leave them as they are).",
        }
      : {}),
    fallbackHint: `Fix what blocks these steps on the server, then run \`${where.command}\` again.`,
  });
}

/** A host plan to show, approve by its hash and apply ({@link approveAndApplyHostPlan}). */
export interface HostPlanStep {
  plan: HostPlan;
  /** The shell the host adapter runs its steps through. */
  remote: RemoteExec;
  apply: HostAdapterApi["apply"];
  /** Proves after an SSH or firewall change that new logins still work. */
  verifyLogin: () => Promise<boolean>;
  /** The approval's title (audited: never an address). */
  title: string;
  /** The server in words: `your server` (one the user owns) or `the server`. */
  server: string;
  /** The command that applies it later (`--approve <hash>`), for example `opscrew provision`. */
  command: string;
  phase: PhaseName;
  /** The plan deletes data: the approval needs `allowDestroy` and the typed app name. */
  allowDestroy?: boolean;
  /** Show and save the plan only. */
  planOnly?: boolean;
  /**
   * The secrets the adapter sends (the tunnel token, Portainer's password), read only once the
   * plan is approved; never shown, planned or audited.
   */
  secrets: (changes: readonly HostStep[]) => Promise<ApplyOptions["secrets"]>;
  /** Said as a step right before the apply (for example how long installing Docker takes). */
  applying?: string;
  /** Told the plan's hash as soon as it is shown, so an error after it can name the hash. */
  shown?: (hash: string) => void;
}

/** Outcome of {@link approveAndApplyHostPlan}: the plan, its hash and the steps applied. */
export interface HostPlanOutcome extends HostChangeResult {
  plan: HostPlan;
  /** Ids of the steps the adapter applied (none with `planOnly` or nothing to change). */
  steps: readonly string[];
}

/**
 * The host plan's gate: saved as `.opscrew/plans/host-<hash>.json` and shown, stopped on blocking
 * findings, approved by its hash (`host-apply`, with `allowDestroy` and the typed app name when it
 * deletes data) and checked against the approval store, then applied through the host adapter,
 * which refuses any other plan and gets the secrets only now. The start, every applied step and a
 * failure (with the steps applied before it) are audited by the hash. A plan without changes needs
 * no approval; with `planOnly` nothing is asked or changed.
 */
export async function approveAndApplyHostPlan(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "approvals" | "audit" | "version" | "clock">,
  step: HostPlanStep,
): Promise<HostPlanOutcome> {
  const { plan, server } = step;
  const hash = hostPlanHash(plan);
  step.shown?.(hash);
  await writeFileAtomic(hostPlanFile(deps.paths, hash), `${JSON.stringify(plan, null, 2)}\n`);
  const details = describeHostPlan(plan, hash);
  deps.reporter.info(details);
  requireNoBlockers(plan, step);
  const changes = plan.steps.filter((item) => item.state === "change");
  if (changes.length === 0) {
    deps.reporter.success(
      `${server.charAt(0).toUpperCase()}${server.slice(1)} is already prepared; nothing on it changes.`,
    );
    return { plan, hash, applied: false, steps: [] };
  }
  if (step.planOnly === true) {
    deps.reporter.info(`Saved the host plan (hash ${hash}); nothing on ${server} was changed.`);
    return { plan, hash, applied: false, steps: [] };
  }
  const allowDestroy = step.allowDestroy === true;
  const approval = await deps.approvals.request({
    kind: "host-apply",
    title: step.title,
    details,
    planHash: hash,
    ...(allowDestroy ? { allowDestroy: true, confirmPhrase: plan.app } : {}),
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "host plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: `Nothing on ${server} was changed.`,
      hint: `To apply it later without prompts, run: ${step.command} --approve ${hash}`,
    });
  }
  await deps.approvals.assertApprovedHostPlan(hash, { allowDestroy });
  const secrets = await step.secrets(changes);
  if (step.applying !== undefined) deps.reporter.step(step.applying);
  const changeIds = changes.map((item) => item.id);
  const audit = (action: string, decision: "approved" | "refused", detail?: string) =>
    deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action,
      phase: step.phase,
      target: hash,
      decision,
      ...(detail !== undefined ? { detail } : {}),
    });
  await audit("host apply started", "approved", `steps to change: ${changeIds.join(", ")}`);
  let result: ApplyResult;
  try {
    result = await step.apply(step.remote, plan, {
      approvedHash: hash,
      secrets,
      verifyLogin: step.verifyLogin,
      version: deps.version,
      now: () => deps.clock.now(),
    });
  } catch (error) {
    const done =
      error instanceof HostApplyError
        ? error.applied.filter((id) => changeIds.includes(id))
        : undefined;
    await audit(
      "host apply failed",
      "refused",
      done === undefined
        ? "the host adapter did not report which steps were applied before the failure; /etc/opscrew/host.json on the server lists every change"
        : `steps applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  for (const id of result.applied) {
    await audit(`host step ${id}`, "approved", plan.steps.find((item) => item.id === id)?.title);
  }
  return { plan, hash, applied: result.applied.length > 0, approval, steps: result.applied };
}
