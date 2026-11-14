import { OpsCrewError } from "@opscrew/core";
import type { CloudflareMove, DeployPlan } from "@opscrew/plan-schema";
import { placeWords } from "../retarget/sides";

/** What to say while `opscrew retarget` is moving the deployment. */
export interface MoveInProgress {
  message: string;
  hint: string;
}

/**
 * The plain-English notice for a move in progress (`plan.retarget` exists), or `undefined` when
 * no move is under way. `plan.target` is already the provider the move goes to. Once an abort
 * began (`retarget.abort`), the move can only be aborted, so the hint names only the abort.
 */
export function moveInProgress(
  plan: Pick<DeployPlan, "target" | "retarget">,
): MoveInProgress | undefined {
  if (plan.retarget === undefined) return undefined;
  const to = placeWords(plan.target);
  if (plan.retarget.abort !== undefined) {
    return {
      message: `A move to ${to} is being aborted.`,
      hint: "Run `opscrew retarget --abort` to finish the abort; it continues where it stopped and puts the app back on the previous server.",
    };
  }
  return {
    message: `A move to ${to} is in progress.`,
    hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
  };
}

/** The command a Cloudflare move's step needs next: preparing, the switch, the finish or the abort. */
function cloudflareMoveHint(move: CloudflareMove): string {
  const run = "opscrew cloudflare move";
  const next =
    move.abort !== undefined
      ? `Run \`${run} --abort\` to finish the abort; it goes on where it stopped.`
      : move.step === "started"
        ? `Run \`${run}\` to go on preparing it, or \`${run} --abort\` to call it off.`
        : move.step === "prepared"
          ? `Run \`${run} --switch\` once every app in the zone is prepared and \`${run} --finish\` after it, or \`${run} --abort\` before the switch.`
          : `Run \`${run} --finish\` to complete it.`;
  return `${next} Then run this command again.`;
}

/**
 * Stops with `PHASE_PRECONDITION` while the app's zone moves to another Cloudflare account
 * (`plan.cloudflareMove` exists), naming the command its step needs next. `destroy`, `retarget`,
 * every rotation, a new preview environment and {@link requireNoMoveInProgress}'s callers refuse
 * with it; snapshot, rollback, advise and design go on during such a move.
 */
export function requireNoCloudflareMove(plan: Pick<DeployPlan, "cloudflareMove">): void {
  const move = plan.cloudflareMove;
  if (move === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `A move of ${move.zone} to another Cloudflare account is in progress. Nothing was changed.`,
    { hint: cloudflareMoveHint(move) },
  );
}

/**
 * Stops with `PHASE_PRECONDITION` while a move to another provider is in progress, so provision,
 * dns, drift and the other phases never act on a half-moved deployment; also while the app's zone
 * moves to another Cloudflare account ({@link requireNoCloudflareMove}) unless
 * `allowCloudflareMove` (design's).
 */
export function requireNoMoveInProgress(
  plan: Pick<DeployPlan, "target" | "retarget" | "cloudflareMove">,
  options: { allowCloudflareMove?: true } = {},
): void {
  const move = moveInProgress(plan);
  if (move !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", move.message, { hint: move.hint });
  }
  if (options.allowCloudflareMove !== true) requireNoCloudflareMove(plan);
}
