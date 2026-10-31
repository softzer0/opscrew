/**
 * The rollback of an app on this computer, to the image it ran before while Docker still has it
 * (plan.md 5.). Not available yet: T1910 fills it.
 */
import { OpsCrewError } from "@opscrew/core";
import type { RollbackResult } from "./index";
import { NOTHING, type RollbackRun } from "./run";

/**
 * This computer's rollback, or its `--list`.
 * @throws OpsCrewError `PHASE_PRECONDITION`: not available yet.
 */
export async function rollbackLocal(run: RollbackRun): Promise<RollbackResult> {
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `\`opscrew rollback\` is not available yet for an app on this computer. ${NOTHING}`,
    {
      hint: `Check out the commit to go back to, then run \`opscrew provision${run.flags}\`: it deploys it.`,
    },
  );
}
