import { canonicalJson, OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import {
  type DeployPlan,
  EnvironmentSchema,
  readArtifact,
  resolveEnvironmentPaths,
  writeArtifact,
} from "@opscrew/plan-schema";

/** `plan.environment.deploySource`: built from main, or promoted from another environment. */
export type DeploySource = NonNullable<DeployPlan["environment"]>["deploySource"];

/**
 * Sets how the environment is deployed (`opscrew env set <name> --from main|<source>`): `main`
 * (built and deployed on each push), or promoted from `from`, another existing environment whose
 * own sources never lead back to this one. Writes the environment's plan only when it changes;
 * its next provision shows and applies the workflow change. Returns the plan.
 * @throws OpsCrewError `INVALID_INPUT` for an unknown environment or source, the environment
 * itself, or a source that would promote in a cycle.
 */
export async function setDeploySource(
  root: string,
  environment: string,
  from: string,
): Promise<DeployPlan> {
  // Only the repository's files are read and written, so no OpsCrew home is read for the paths.
  const { files } = await resolveEnvironmentPaths(root, environment, { env: {} });
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
  const changed: DeployPlan = {
    ...plan,
    environment: EnvironmentSchema.parse({ ...plan.environment, deploySource }),
  };
  await writeArtifact("plan", files.plan, changed);
  return changed;
}
