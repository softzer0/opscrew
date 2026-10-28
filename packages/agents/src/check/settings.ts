import { type ProjectPaths, toPosixRelative } from "@opscrew/core";
import {
  ArtifactError,
  type DeployPlan,
  type Observability,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { appPaths } from "../apps/list";

/** The scheduled check's settings in a plan (`observability.check`). */
export type CheckSettings = NonNullable<Observability["check"]>;

/**
 * True for the repository's first app's prod plan (`opscrew/plan.yaml`), the only plan that sets
 * the check's repository-wide settings, its interval and its webhook.
 */
export function holdsCheckSettings(plan: DeployPlan): boolean {
  return plan.app.key === undefined && plan.environment?.name === undefined;
}

/**
 * Stops (`ARTIFACT_INVALID`, naming the file to edit) when a plan other than the first app's prod
 * plan sets `observability.check.intervalMinutes` or `webhook`: one check runs for the whole
 * repository, so only `opscrew/plan.yaml` sets them.
 */
export function requireCheckSettingsPlace(
  paths: Pick<ProjectPaths, "root" | "files">,
  plan: DeployPlan,
): void {
  if (holdsCheckSettings(plan)) return;
  const check = plan.observability?.check;
  const fields = (["intervalMinutes", "webhook"] as const).filter(
    (field) => check?.[field] !== undefined,
  );
  if (fields.length === 0) return;
  const file = toPosixRelative(paths.root, paths.files.plan);
  throw new ArtifactError({
    code: "ARTIFACT_INVALID",
    file,
    issues: fields.map((field) => ({
      path: `observability.check.${field}`,
      message:
        "is the repository's: one scheduled check covers every app and environment, so only the first app's prod plan (opscrew/plan.yaml) sets it",
    })),
    hint: `Remove ${fields.map((field) => `observability.check.${field}`).join(" and ")} from ${file}, and set ${fields.length > 1 ? "them" : "it"} in opscrew/plan.yaml instead.`,
  });
}

/**
 * The check's repository-wide settings: those of `plan` when it is the first app's prod plan,
 * else those of `opscrew/plan.yaml` (none while it does not exist).
 */
export async function repositoryCheckSettings(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  plan: DeployPlan,
): Promise<CheckSettings | undefined> {
  if (holdsCheckSettings(plan)) return plan.observability?.check;
  const first = await readOptionalArtifact("plan", appPaths(paths, undefined).files.plan);
  return first?.observability?.check;
}

/**
 * `plan` with the check as design sets it when the plan has no setting of its own: on for prod
 * (`environment` `prod`) and off for the other environments. Localhost gets none: GitHub can't
 * reach the user's computer.
 */
export function withDesignedCheck(plan: DeployPlan, environment: string): DeployPlan {
  if (plan.observability?.check !== undefined || plan.target.provider === "localhost") return plan;
  return {
    ...plan,
    observability: { ...plan.observability, check: { enabled: environment === "prod" } },
  };
}
