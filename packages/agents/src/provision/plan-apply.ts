import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalRecord,
  IacEngine,
  PlanSummary,
  PolicyResult,
  ResourceAction,
} from "@opscrew/contracts";
import { OpsCrewError, writeFileAtomic } from "@opscrew/core";
import { checkDialect, engineLabel, hashFile } from "@opscrew/iac-engine";
import type { RenderedFile } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { blockingPolicyFailures, evaluatePlanPolicies } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import type { SavedPlan } from "./types";

export interface PlanAndApplyOptions {
  engine: IacEngine;
  /** Absolute root module directory. */
  dir: string;
  /** Engine environment: provider tokens and `TF_ENCRYPTION`. Never logged. */
  env: Record<string, string | undefined>;
  deployPlan: DeployPlan;
  /** Rendered files, checked for engine-specific constructs before planning. */
  files: readonly RenderedFile[];
  /** Apply the saved plan with this hash instead of planning again. */
  approvePlanHash?: string;
  planOnly?: boolean;
}

export interface PlanAndApplyResult {
  planHash?: string;
  applied: boolean;
  outputs: Record<string, unknown>;
  approval?: ApprovalRecord;
  plan?: SavedPlan;
}

const SYMBOL: Record<ResourceAction, string> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "±",
  read: "?",
  "no-op": " ",
};

function money(amount: number, currency: string): string {
  return `${currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;
}

/** Plain-English plan summary shown before approval (resources, cost, policies, hash). */
export function describePlan(saved: SavedPlan, deployPlan: DeployPlan): string {
  const lines = [`${engineLabel(saved.engine.name)} ${saved.engine.version} plan:`];
  for (const change of saved.changes) {
    lines.push(`  ${SYMBOL[change.action]} ${change.action.padEnd(7)} ${change.address}`);
  }
  const { create, update, delete: del, replace } = saved.counts;
  lines.push(
    `Changes: ${create} to create, ${update} to update, ${del} to delete, ${replace} to replace.`,
  );
  const cost = deployPlan.cost.monthly;
  lines.push(
    `Estimated cost: ${money(cost.amount, cost.currency)} per month (${deployPlan.cost.source === "live" ? "live prices" : `price list of ${deployPlan.cost.asOf.slice(0, 10)}`}, ${deployPlan.cost.pricesIncludeVat ? "incl." : "excl."} VAT).`,
  );
  const failed = saved.policy.filter((p) => !p.passed);
  lines.push(
    `Security policies: ${saved.policy.length - failed.length} passed, ${failed.length} failed.`,
  );
  for (const result of saved.policy) {
    lines.push(`  ${result.passed ? "✓" : "✗"} [${result.severity}] ${result.title}`);
    if (!result.passed) lines.push(`      ${result.message}`);
  }
  lines.push(`Plan hash: ${saved.planHash}`);
  return lines.join("\n");
}

function sidecarFor(planFile: string): string {
  return `${planFile}.json`;
}

async function saveSidecar(saved: SavedPlan): Promise<void> {
  await writeFileAtomic(sidecarFor(saved.planFile), `${JSON.stringify(saved, null, 2)}\n`);
}

/** The saved plan (from an earlier `--plan-only`) whose hash matches, if any. */
export async function findSavedPlan(
  plansDir: string,
  planHash: string,
): Promise<SavedPlan | undefined> {
  let names: string[];
  try {
    names = await readdir(plansDir);
  } catch {
    return undefined;
  }
  const wanted = planHash.toLowerCase();
  for (const name of names
    .filter((n) => n.endsWith(".tfplan.json"))
    .sort()
    .reverse()) {
    try {
      const saved = JSON.parse(await readFile(join(plansDir, name), "utf8")) as SavedPlan;
      if (saved.planHash?.toLowerCase() === wanted) return saved;
    } catch {
      // ignore unreadable sidecars
    }
  }
  return undefined;
}

function toSaved(summary: PlanSummary, policy: PolicyResult[]): SavedPlan {
  return {
    planHash: summary.planHash,
    planFile: summary.planFile,
    dir: summary.dir,
    engine: summary.engine,
    createdAt: summary.createdAt,
    changes: summary.changes,
    counts: summary.counts,
    hasDestroy: summary.hasDestroy,
    policy,
    planJson: summary.planJson,
  };
}

function lastLines(text: string, count = 8): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

async function freshPlan(deps: PhaseDeps, options: PlanAndApplyOptions): Promise<SavedPlan> {
  const { engine, dir, env } = options;
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await mkdir(deps.paths.files.plansDir, { recursive: true });

  deps.reporter.step(
    `Initialising ${engineLabel(engine.info.name)} in ${options.deployPlan.infra.dir}`,
  );
  await engine.init(dir, { env, backendConfig: { path: statePath } });

  const validation = await engine.validate(dir, { env });
  if (!validation.valid) {
    const errors = validation.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${d.summary}${d.file ? ` (${d.file}${d.line ? `:${d.line}` : ""})` : ""}`);
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The infrastructure code is not valid: ${errors.join("; ")}.`,
      { hint: "Undo manual edits under opscrew/infra (they are regenerated), then try again." },
    );
  }

  const tfFiles = options.files.filter((f) => /\.(?:tf|tofu)(?:\.json)?$/.test(f.path));
  const issues = checkDialect(tfFiles.map((f) => ({ path: f.path, content: f.content })));
  const unsupported = issues.filter((issue) => issue.onlyIn !== engine.info.name);
  if (unsupported.length > 0) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The infrastructure code uses features ${engineLabel(engine.info.name)} does not support: ${unsupported.map((i) => `${i.message} (${i.file}:${i.line})`).join("; ")}.`,
      { hint: "Remove the engine-specific construct or run with the other engine (--engine)." },
    );
  }
  for (const issue of issues) {
    deps.reporter.warn(`${issue.file}:${issue.line}: ${issue.message}`);
  }

  const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
  const planFile = join(deps.paths.files.plansDir, `${stamp}.tfplan`);
  deps.reporter.step("Planning the infrastructure changes");
  const summary = await engine.plan(dir, planFile, { env });
  return toSaved(summary, evaluatePlanPolicies(summary.planJson, options.deployPlan));
}

/**
 * Plan → policies → approval bound to the plan hash → apply (constitution I). With `planOnly` it
 * stops after saving the plan and printing its hash; with `approvePlanHash` it applies the saved
 * plan from that earlier run (plans are never re-made, so the hash the user reviewed is the one
 * applied). Policy failures (critical/high) stop before approval is requested.
 */
export async function planAndApply(
  deps: PhaseDeps,
  options: PlanAndApplyOptions,
): Promise<PlanAndApplyResult> {
  const { engine, dir, env, deployPlan } = options;
  let saved: SavedPlan;
  if (options.approvePlanHash !== undefined) {
    const found = await findSavedPlan(deps.paths.files.plansDir, options.approvePlanHash);
    if (!found) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `No saved plan has the hash ${options.approvePlanHash}.`,
        {
          hint: "Run `opscrew provision --plan-only` again, review the plan and approve the new hash.",
        },
      );
    }
    if ((await hashFile(found.planFile).catch(() => "")) !== found.planHash) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        "The saved plan file changed after it was reviewed, so OpsCrew will not apply it.",
        { hint: "Run `opscrew provision --plan-only` again and approve the new hash." },
      );
    }
    if (found.engine.name !== engine.info.name) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `That plan was made with ${engineLabel(found.engine.name)}, but this run uses ${engineLabel(engine.info.name)}.`,
        { hint: `Re-run with --engine ${found.engine.name}.` },
      );
    }
    saved = found;
  } else {
    saved = await freshPlan(deps, options);
  }

  const details = describePlan(saved, deployPlan);
  deps.reporter.info(details);
  const blocking = blockingPolicyFailures(saved.policy);
  if (blocking.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The plan fails ${blocking.length} security ${blocking.length === 1 ? "policy" : "policies"}: ${blocking.map((p) => p.title).join("; ")}. Nothing was changed.`,
      { hint: blocking.map((p) => p.message).join(" ") },
    );
  }

  if (saved.changes.length === 0) {
    deps.reporter.success("The infrastructure is already up to date.");
    const outputs = await engine.output(dir, { env }).catch(() => ({}));
    return { planHash: saved.planHash, applied: false, outputs, plan: saved };
  }

  if (options.approvePlanHash === undefined) await saveSidecar(saved);
  if (options.planOnly) {
    deps.reporter.info(
      `Plan saved. To apply exactly this plan, run: opscrew provision --approve ${saved.planHash}`,
    );
    return { planHash: saved.planHash, applied: false, outputs: {}, plan: saved };
  }

  const { create, update, delete: del, replace } = saved.counts;
  const approval = await deps.approvals.request({
    kind: "iac-apply",
    title: `Apply the infrastructure plan on Hetzner Cloud (${create} to create, ${update} to update, ${del} to delete, ${replace} to replace)`,
    details,
    planHash: saved.planHash,
    costDelta: deployPlan.cost.monthly,
    policy: saved.policy,
    ...(saved.hasDestroy ? { allowDestroy: true, confirmPhrase: deployPlan.app.name } : {}),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The infrastructure plan was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing was changed.`,
      {
        hint: `To apply it later without prompts, run: opscrew provision --approve ${saved.planHash}`,
      },
    );
  }
  await deps.approvals.assertApprovedPlan(saved.planHash, { allowDestroy: saved.hasDestroy });

  deps.reporter.step("Applying the plan (this usually takes one to three minutes)");
  const result = await engine.apply(
    dir,
    saved.planFile,
    { approvedPlanHash: saved.planHash, allowDestroy: saved.hasDestroy },
    { env },
  );
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "apply",
    phase: "provision",
    target: saved.planHash,
    decision: result.ok ? "approved" : "refused",
    detail: result.ok ? "apply finished" : "apply failed",
  });
  if (!result.ok) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `Applying the plan failed:\n${deps.redactor.redact(lastLines(result.log))}`,
      {
        hint: "Fix the cause shown above, then run `opscrew provision` again; it plans the remaining changes.",
      },
    );
  }
  deps.reporter.success("Infrastructure applied.");
  return {
    planHash: saved.planHash,
    applied: true,
    outputs: result.outputs,
    approval,
    plan: saved,
  };
}
