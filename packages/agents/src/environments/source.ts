import { canonicalJson, OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import {
  type DeployPlan,
  EnvironmentSchema,
  readArtifact,
  resolveEnvironmentPaths,
  writeArtifact,
} from "@opscrew/plan-schema";
import { requireBranchFree } from "./branches";

/** `plan.environment.deploySource`: built from main, or promoted from another environment. */
export type DeploySource = NonNullable<DeployPlan["environment"]>["deploySource"];

/**
 * Sets how the environment is deployed (`opscrew env set <name> --from main|<source>`): `main`
 * (built and deployed on each push), or promoted from `from`, another existing environment whose
 * own sources never lead back to this one. Built from main again, it follows the branch its plan
 * kept, which no other environment may follow (`requireBranchFree`). Writes the plan only when it
 * changes; its next provision shows and applies the workflow change. Returns the plan.
 * @throws OpsCrewError `INVALID_INPUT` for an unknown environment or source, the environment
 * itself, a source that would promote in a cycle, or a kept branch another environment follows.
 */
export async function setDeploySource(
  root: string,
  environment: string,
  from: string,
): Promise<DeployPlan> {
  // Only the repository's files are read and written, so no OpsCrew home is read for the paths.
  const own = await resolveEnvironmentPaths(root, environment, { env: {} });
  const { files } = own;
  const plan = await readArtifact("plan", files.plan);
  let deploySource: DeploySource = { from: "main" };
  if (from !== "main") {
    if (from === environment) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The ${environment} environment cannot be promoted from itself.`,
        { hint: "Name the environment it takes its releases from, or `main`." },
      );
    }
    await resolveEnvironmentPaths(root, from, { env: {} });
    // The source's own sources must not lead back here (`environmentsOf`, through
    // `resolveEnvironmentPaths`, already refused a cycle among them).
    for (let next: string | undefined = from; next !== undefined; ) {
      const paths = resolveProjectPaths(root, { env: {}, environment: next });
      const sourcePlan: DeployPlan = await readArtifact("plan", paths.files.plan);
      const source = sourcePlan.environment?.deploySource;
      next = source?.from === "promote" ? source.source : undefined;
      if (next === environment) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `The ${environment} environment cannot be promoted from ${from}, since ${from} takes its releases from ${environment} itself.`,
          { hint: `Deploy one of them from main: \`opscrew env set ${from} --from main\`.` },
        );
      }
    }
    deploySource = { from: "promote", source: from };
  }
  const before = plan.environment?.deploySource ?? { from: "main" };
  if (canonicalJson(before) === canonicalJson(deploySource)) return plan;
  // Built from main again, it follows the branch its plan kept: no other environment's.
  if (deploySource.from === "main") await requireBranchFree(own, plan.cicd.branch);
  const changed: DeployPlan = {
    ...plan,
    environment: EnvironmentSchema.parse({ ...plan.environment, deploySource }),
  };
  await writeArtifact("plan", files.plan, changed);
  return changed;
}
