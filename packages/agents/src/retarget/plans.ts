import { rm } from "node:fs/promises";
import type { ApprovalRecord, ApprovalRequest, Money, PlanSummary } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { engineLabel, hashFile } from "@opscrew/iac-engine";
import type { RenderedFile } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { applyApprovedPlan, type DeletionSession, savePlan as saveDeletionPlan } from "../destroy";
import {
  findSavedPlan,
  isMovesOnly,
  maskSensitivePlanJson,
  type PlanAndApplyOptions,
  planAndApply,
  type SavedPlan,
} from "../provision";
import { writePlanSidecar } from "../provision/plan-apply";
import {
  clearPending,
  type MoveAction,
  pendingMatches,
  readPending,
  writePending,
} from "./pending";
import type { MoveSession } from "./session";

/** What a plan step came to. */
export type PlanStep =
  | {
      kind: "applied";
      outputs: Record<string, unknown>;
      planHash: string;
      approval?: ApprovalRecord;
    }
  | { kind: "unchanged"; outputs: Record<string, unknown> }
  | { kind: "pending"; planHash: string };

/** A plan ready to apply (its hash), one waiting for `--approve <hash>`, or nothing to change. */
export type PreparedPlan =
  | { kind: "ready"; planHash: string }
  | { kind: "pending"; planHash: string }
  | { kind: "unchanged"; outputs: Record<string, unknown> };

export interface InfraPlanInput {
  action: MoveAction;
  /** The layout's rendered files (checked for engine-specific constructs before planning). */
  files: readonly RenderedFile[];
  /** The plan the policies and the approval describe (default: the session's). */
  deployPlan?: DeployPlan;
  /** Stops (throws) when the plan does more than this step may do. */
  check: (saved: SavedPlan) => void;
  /** Plain-English notes added to the approval details. */
  notes?: readonly string[];
  /**
   * Monthly cost change the approval shows (default: the new server's monthly price, right for
   * the plan that creates it); `null` for a plan that changes nothing billed (DNS switch, restore).
   */
  costDelta?: Money | null;
}

/**
 * The phase deps with a reporter that keeps steps and warnings but drops info and success lines:
 * an interactive run plans first (to check the plan) and `planAndApply` prints the plan again
 * with the approval, so it is shown once.
 */
function quietly(deps: PhaseDeps): PhaseDeps {
  const shown = deps.reporter;
  return {
    ...deps,
    reporter: {
      step: (message) => shown.step(message),
      info: () => undefined,
      success: () => undefined,
      warn: (message) => shown.warn(message),
      error: (message) => shown.error(message),
    },
  };
}

function planAndApplyOptions(session: MoveSession, input: InfraPlanInput): PlanAndApplyOptions {
  return {
    engine: session.engine,
    dir: session.dir,
    env: session.env,
    deployPlan: input.deployPlan ?? session.plan,
    files: input.files,
    command: session.command,
    phase: "retarget",
    ...(input.notes && input.notes.length > 0 ? { approvalNotes: input.notes } : {}),
    ...(input.costDelta !== undefined ? { costDelta: input.costDelta } : {}),
  };
}

/** Deletes a saved plan and its sidecar so it can never be applied later. */
async function discardSaved(planFile: string): Promise<void> {
  await rm(planFile, { force: true });
  await rm(`${planFile}.json`, { force: true });
}

/**
 * The saved plan `--approve <hash>` names, when its file still has that hash and was made with
 * this run's engine; otherwise the waiting plan is forgotten and the run stops (nothing changed).
 */
async function approvedSavedPlan(session: MoveSession, planHash: string): Promise<SavedPlan> {
  const { deps } = session;
  let saved: SavedPlan | undefined;
  try {
    saved = await findSavedPlan(deps.paths.files.plansDir, planHash, {
      hint: `Run \`${session.command}\` without --approve to plan again, review the plan and approve the new hash.`,
    });
  } catch (error) {
    // A damaged sidecar: forget the waiting plan so the next run plans this step again.
    await clearPending(deps);
    throw error;
  }
  const intact =
    saved !== undefined && (await hashFile(saved.planFile).catch(() => "")) === saved.planHash;
  if (saved !== undefined && intact && saved.engine.name === session.engine.info.name) {
    return saved;
  }
  await clearPending(deps);
  const why =
    saved === undefined || !intact
      ? "is missing or was changed after it was saved"
      : `was made with ${engineLabel(saved.engine.name)}, but this run uses ${engineLabel(session.engine.info.name)}`;
  throw new OpsCrewError(
    "PLAN_HASH_MISMATCH",
    `The plan you approved (hash ${planHash}) ${why}, so OpsCrew will not apply it. Nothing was changed.`,
    {
      hint: `Run \`${session.command}\` without --approve to plan again, review the plan and approve the new hash.`,
    },
  );
}

/**
 * Plans an infrastructure step through `planAndApply` (validation, policies, saved plan), or, with
 * `--approve <hash>` naming the plan this step saved earlier, takes that saved plan. `check` runs
 * before any approval. Interactive runs get a plan ready to apply; non-interactive runs stop with
 * the hash (constitution I: scripts name every plan they apply).
 */
export async function prepareInfraPlan(
  session: MoveSession,
  input: InfraPlanInput,
): Promise<PreparedPlan> {
  const { deps } = session;
  const pending = await readPending(deps);
  if (pendingMatches(pending, input.action, session.approve)) {
    session.approve = undefined;
    const saved = await approvedSavedPlan(session, pending.planHash);
    try {
      input.check(saved);
    } catch (error) {
      await discardSaved(saved.planFile);
      await clearPending(deps);
      throw error;
    }
    return { kind: "ready", planHash: saved.planHash };
  }
  const planned = await planAndApply(deps.interactive ? quietly(deps) : deps, {
    ...planAndApplyOptions(session, input),
    planOnly: true,
  });
  const saved = planned.plan;
  if (saved === undefined || (saved.changes.length === 0 && !isMovesOnly(saved))) {
    return { kind: "unchanged", outputs: planned.outputs };
  }
  try {
    input.check(saved);
  } catch (error) {
    await discardSaved(saved.planFile);
    throw error;
  }
  await writePending(deps, input.action, saved.planHash);
  return deps.interactive
    ? { kind: "ready", planHash: saved.planHash }
    : { kind: "pending", planHash: saved.planHash };
}

/**
 * Applies a prepared plan through `planAndApply` (approval bound to the hash, then apply). A
 * refused approval keeps the saved plan (`--approve <hash>` can apply it later); any other outcome
 * forgets it.
 */
export async function applyInfraPlan(
  session: MoveSession,
  input: InfraPlanInput,
  planHash: string,
): Promise<{ outputs: Record<string, unknown>; approval?: ApprovalRecord }> {
  try {
    const result = await planAndApply(session.deps, {
      ...planAndApplyOptions(session, input),
      approvePlanHash: planHash,
    });
    await clearPending(session.deps);
    return { outputs: result.outputs, ...(result.approval ? { approval: result.approval } : {}) };
  } catch (error) {
    if (!(isUserFacingError(error) && error.code === "APPROVAL_REFUSED")) {
      await clearPending(session.deps);
    }
    throw error;
  }
}

/** {@link prepareInfraPlan} then, when a plan is ready, {@link applyInfraPlan}. */
export async function planThenApply(
  session: MoveSession,
  input: InfraPlanInput,
): Promise<PlanStep> {
  const prepared = await prepareInfraPlan(session, input);
  if (prepared.kind !== "ready") return prepared;
  const applied = await applyInfraPlan(session, input, prepared.planHash);
  return { kind: "applied", planHash: prepared.planHash, ...applied };
}

export interface DeletionStepInput {
  action: MoveAction;
  /** Plan file name suffix under `.opscrew/plans/`. */
  suffix: string;
  /** `-var`s of the plan (only variables the layout declares). */
  vars?: Readonly<Record<string, string>>;
  /** Stops (throws) when the plan does more than this step may do. */
  check: (summary: Pick<PlanSummary, "changes" | "planJson">) => void;
  /** The `iac-apply` approval for the plan (with `allowDestroy` and the app name for deletes). */
  request: (summary: PlanSummary) => ApprovalRequest;
  /** The error when the approval is refused. */
  refused: (approval: ApprovalRecord, planHash: string) => OpsCrewError;
  allowDestroy: boolean;
  /** The apply in words, e.g. `deleting the old server`. */
  what: string;
  /** Hint after a failed apply. */
  hint: string;
  /** Runs after the approval, right before the apply (the step's first change). */
  beforeApply?: () => Promise<void>;
}

function summaryOf(saved: SavedPlan): PlanSummary {
  return {
    engine: saved.engine,
    dir: saved.dir,
    planFile: saved.planFile,
    planHash: saved.planHash,
    createdAt: saved.createdAt,
    changes: saved.changes,
    counts: saved.counts,
    hasDestroy: saved.hasDestroy,
    planJson: saved.planJson,
  };
}

/** The sidecar saved next to a move's plan file (exported for tests). */
export function savedOf(summary: PlanSummary): SavedPlan {
  return {
    planHash: summary.planHash,
    planFile: summary.planFile,
    dir: summary.dir,
    engine: summary.engine,
    createdAt: summary.createdAt,
    changes: summary.changes,
    counts: summary.counts,
    hasDestroy: summary.hasDestroy,
    policy: [],
    // Saved next to the plan file: never the prior state or a sensitive value in clear.
    planJson: maskSensitivePlanJson(summary.planJson),
  };
}

/**
 * A plan of a move's deletion (finish or abort): the protection lift or the bounded removal of a
 * server module. Planned with the destroy helpers' `savePlan` (variables allowed), checked before
 * any approval, approved with its own `iac-apply` request (bound to the hash; deletions with
 * `allowDestroy` and the typed app name) and applied with `applyApprovedPlan`. Non-interactive
 * runs stop with the hash; `--approve <hash>` re-checks the saved plan and applies it. The plan
 * file is deleted after any apply attempt; a refused approval keeps it for `--approve`.
 */
export async function deletionStep(
  session: MoveSession,
  del: DeletionSession,
  input: DeletionStepInput,
): Promise<PlanStep> {
  const { deps } = session;
  let summary: PlanSummary;
  const pending = await readPending(deps);
  if (pendingMatches(pending, input.action, session.approve)) {
    session.approve = undefined;
    summary = summaryOf(await approvedSavedPlan(session, pending.planHash));
    try {
      input.check(summary);
    } catch (error) {
      await discardSaved(summary.planFile);
      await clearPending(deps);
      throw error;
    }
  } else {
    summary = await saveDeletionPlan(del, input.suffix, input.vars ? { vars: input.vars } : {});
    if (summary.changes.length === 0) {
      await discardSaved(summary.planFile);
      return { kind: "unchanged", outputs: {} };
    }
    try {
      input.check(summary);
    } catch (error) {
      await discardSaved(summary.planFile);
      throw error;
    }
    await writePlanSidecar(deps.redactor, savedOf(summary));
    await writePending(deps, input.action, summary.planHash);
    if (!deps.interactive) {
      const request = input.request(summary);
      deps.reporter.info(
        `${request.title}\n${request.details}\nSaved the plan (hash ${summary.planHash}); nothing was changed.`,
      );
      return { kind: "pending", planHash: summary.planHash };
    }
  }
  const approval = await deps.approvals.request(input.request(summary));
  if (!approval.approved) throw input.refused(approval, summary.planHash);
  try {
    await deps.approvals.assertApprovedPlan(summary.planHash, {
      allowDestroy: input.allowDestroy,
    });
    await input.beforeApply?.();
    deps.reporter.step(`${input.what.charAt(0).toUpperCase()}${input.what.slice(1)}`);
    await applyApprovedPlan(del, summary, {
      allowDestroy: input.allowDestroy,
      what: input.what,
      hint: input.hint,
    });
  } finally {
    await discardSaved(summary.planFile);
    await clearPending(deps);
  }
  return { kind: "applied", outputs: {}, planHash: summary.planHash, approval };
}

/** `OpenTofu 1.13.1 plan:` — the first line of a plan's details. */
export function planHeading(summary: Pick<PlanSummary, "engine">): string {
  return `${engineLabel(summary.engine.name)} ${summary.engine.version} plan:`;
}
