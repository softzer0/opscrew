import type { ApprovalRecord } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";

/** An approval as `opscrew/plan.yaml` keeps it. */
export type PlanApproval = DeployPlan["approvals"][number];

/**
 * An approval of a plan bound to its hash (`iac-apply`, `host-apply`, `stack-apply`) as
 * `opscrew/plan.yaml` keeps it: an informational copy, the approval store is authoritative.
 */
export function approvalEntry(record: ApprovalRecord): PlanApproval {
  return {
    planHash: record.planHash as string,
    approver: record.approver,
    at: record.decidedAt,
    kind: record.kind,
  };
}

/** `plan` with the approvals of the plans approved this run (`outcomes`, in order). */
export function withApprovals(
  plan: DeployPlan,
  outcomes: Iterable<{ approval?: ApprovalRecord | undefined }>,
): DeployPlan {
  const approvals = [...outcomes].flatMap((o) => (o.approval ? [approvalEntry(o.approval)] : []));
  return approvals.length === 0 ? plan : { ...plan, approvals: [...plan.approvals, ...approvals] };
}

/** ` (reason)` to follow a refusal's first words, or nothing when the handler gave no reason. */
export function refusalReason(approval: { reason?: string | undefined }): string {
  return approval.reason ? ` (${approval.reason})` : "";
}

/** What {@link PlanRefusedError} says: which plan, why, and what stayed as it was. */
export interface PlanRefusal {
  /** The plan in words: `host plan`, `stack plan`. */
  plan: string;
  /** Why the approval was refused, when the handler said. */
  reason?: string;
  /** What stayed as it was: `Nothing on your server was changed.` */
  unchanged: string;
  hint: string;
}

/**
 * The stop when the user did not approve a plan (`APPROVAL_REFUSED`): "The host plan was not
 * approved (reason). Nothing on your server was changed." Its parts stay readable, so a caller
 * that asked for the approval on the way to another change can say all that stayed as it was.
 */
export class PlanRefusedError extends OpsCrewError {
  readonly refusal: PlanRefusal;

  constructor(refusal: PlanRefusal, cause?: unknown) {
    super(
      "APPROVAL_REFUSED",
      `The ${refusal.plan} was not approved${refusalReason(refusal)}. ${refusal.unchanged}`,
      {
        hint: refusal.hint,
        ...(cause !== undefined ? { cause } : {}),
      },
    );
    this.name = "PlanRefusedError";
    this.refusal = refusal;
  }
}
