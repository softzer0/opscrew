import { OpsCrewError } from "@opscrew/core";

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
    const why = refusal.reason ? ` (${refusal.reason})` : "";
    super("APPROVAL_REFUSED", `The ${refusal.plan} was not approved${why}. ${refusal.unchanged}`, {
      hint: refusal.hint,
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = "PlanRefusedError";
    this.refusal = refusal;
  }
}
