/**
 * The rollback of a site on Cloudflare's hosting or GitHub Pages, through the target's own version
 * history (plan.md 5.). Not available yet: T1910 fills it.
 */
import { OpsCrewError } from "@opscrew/core";
import type { RollbackResult } from "./index";
import { NOTHING, type RollbackRun } from "./run";

/**
 * A site's rollback, or its `--list`.
 * @throws OpsCrewError `PHASE_PRECONDITION`: not available yet.
 */
export async function rollbackSite(run: RollbackRun): Promise<RollbackResult> {
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `\`opscrew rollback\` is not available yet for a site on Cloudflare's hosting or GitHub Pages. ${NOTHING}`,
    {
      hint: `Run \`opscrew promote --to ${run.environment} --version <id>\` with a version \`opscrew status\` lists.`,
    },
  );
}
