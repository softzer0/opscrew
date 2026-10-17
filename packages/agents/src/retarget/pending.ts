import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readValidJson } from "../shared";

/** Every infrastructure plan a move applies, each approved on its own (constitution I). */
export const MOVE_ACTIONS = [
  "rename",
  "create",
  "switch",
  "finish-unprotect",
  "finish-destroy",
  "abort-dns",
  "abort-unprotect",
  "abort-remove",
  "abort-rename",
] as const;
export type MoveAction = (typeof MOVE_ACTIONS)[number];

const PendingSchema = z.strictObject({
  action: z.enum(MOVE_ACTIONS),
  planHash: z.string().regex(/^[0-9a-f]{64}$/i),
  savedAt: z.string(),
});

/** The saved plan a move waits for: which step it belongs to and its hash. */
export type PendingPlan = z.infer<typeof PendingSchema>;

/** `.opscrew/retarget-pending.json`: machine-local, names a saved plan, never its content. */
export function pendingPlanFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.stateDir, "retarget-pending.json");
}

/** The saved plan the move waits for, or `undefined` when there is none (or it is damaged). */
export function readPending(deps: Pick<PhaseDeps, "paths">): Promise<PendingPlan | undefined> {
  return readValidJson(pendingPlanFile(deps), PendingSchema);
}

/** Records that `action`'s saved plan `planHash` waits for `--approve <hash>`. */
export async function writePending(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  action: MoveAction,
  planHash: string,
): Promise<void> {
  const record: PendingPlan = {
    action,
    planHash: planHash.toLowerCase(),
    savedAt: deps.clock.now().toISOString(),
  };
  await writeFileAtomic(pendingPlanFile(deps), `${JSON.stringify(record)}\n`);
}

/** Forgets the waiting plan (after it was applied, or when the move ended). */
export async function clearPending(deps: Pick<PhaseDeps, "paths">): Promise<void> {
  await rm(pendingPlanFile(deps), { force: true });
}

/** True when `pending` is `action`'s plan and `approved` names it (hash case ignored). */
export function pendingMatches(
  pending: PendingPlan | undefined,
  action: MoveAction,
  approved: string | undefined,
): pending is PendingPlan {
  return (
    pending !== undefined &&
    approved !== undefined &&
    pending.action === action &&
    pending.planHash.toLowerCase() === approved.trim().toLowerCase()
  );
}
