import {
  type DeployPlan,
  readOptionalArtifact,
  serializeArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";

/**
 * Writes `plan` to `opscrew/plan.yaml` with `updatedAt` now, unless it equals the plan there apart
 * from `updatedAt`: then the file stays as it is, so a run with nothing to change commits nothing.
 * Every phase that records something in the plan writes it here.
 */
export async function writePlanIfChanged(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  plan: DeployPlan,
): Promise<void> {
  const file = deps.paths.files.plan;
  const onDisk = await readOptionalArtifact("plan", file);
  if (
    onDisk !== undefined &&
    serializeArtifact("plan", { ...plan, updatedAt: onDisk.updatedAt }) ===
      serializeArtifact("plan", onDisk)
  ) {
    return;
  }
  await writeArtifact("plan", file, { ...plan, updatedAt: deps.clock.now().toISOString() });
}
