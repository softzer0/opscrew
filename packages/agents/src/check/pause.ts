import type { GitHubClient } from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { CHECK_PAUSED_VARIABLE, checkEnvironmentKey } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";

/** The GitHub calls the pause needs (a `GitHubClient` or a test fake). */
export type CheckPauseApi = Pick<
  GitHubClient,
  "getRepoVariable" | "setRepoVariable" | "deleteRepoVariable"
>;

/** The repository whose check is paused, and the calls to change it. */
export interface CheckPauseTarget {
  api: CheckPauseApi;
  owner: string;
  repo: string;
}

/** Why OpsCrew pauses an environment's check: a move's maintenance window, or a teardown. */
export type CheckPauseReason = "retarget" | "destroyed";

/** `OPSCREW_CHECK_PAUSED`: `{ "<app>/<env>": { reason, since } }`. */
const PausedSchema = z.record(
  z.string(),
  z.looseObject({ reason: z.enum(["retarget", "destroyed"]), since: z.string() }),
);

/** What {@link changeCheckPause} did. */
export type CheckPauseOutcome = "changed" | "unchanged" | "refused";

/**
 * Pauses (`reason`) or resumes (`undefined`) the scheduled check for `plan`'s environment
 * (`checkEnvironmentKey`) in the repository variable `OPSCREW_CHECK_PAUSED`: it is read, its one
 * entry changed, and written back (deleted once no environment is paused), after a
 * `github-settings` approval; audited. Only an environment with the check on is paused or
 * resumed (without it the variable is not even read); nothing to change asks nothing. A variable that is not OpsCrew's JSON stops with how to fix it.
 */
export async function changeCheckPause(
  deps: Pick<PhaseDeps, "approvals" | "audit" | "clock">,
  target: CheckPauseTarget,
  plan: DeployPlan,
  reason: CheckPauseReason | undefined,
  phase: PhaseName,
): Promise<CheckPauseOutcome> {
  // Without the check on, the variable is not read (the token may lack Variables).
  if (plan.observability?.check?.enabled !== true) return "unchanged";
  const { api, owner, repo } = target;
  const key = checkEnvironmentKey(plan);
  const where = `${owner}/${repo}`;
  const text = await api.getRepoVariable(owner, repo, CHECK_PAUSED_VARIABLE);
  let paused: z.infer<typeof PausedSchema> = {};
  if (text !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = PausedSchema.safeParse(json);
    if (!parsed.success) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The repository variable ${CHECK_PAUSED_VARIABLE} of ${where} is not the JSON OpsCrew writes, so OpsCrew changed nothing.`,
        {
          hint: `Delete the variable in the repository's Settings → Secrets and variables → Actions → Variables (it only pauses the scheduled check), then run the command again.`,
        },
      );
    }
    paused = parsed.data;
  }
  if (reason === undefined ? paused[key] === undefined : paused[key]?.reason === reason) {
    return "unchanged";
  }
  const { [key]: _old, ...others } = paused;
  const next =
    reason === undefined
      ? others
      : { ...others, [key]: { reason, since: deps.clock.now().toISOString() } };
  const what =
    reason === undefined
      ? `Resume the scheduled check for ${key} in ${where}`
      : `Pause the scheduled check for ${key} in ${where}`;
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: what,
    details: [
      reason === undefined
        ? `OpsCrew removes ${key} from the repository variable ${CHECK_PAUSED_VARIABLE}, so the scheduled check checks it again and opens an issue when it fails.`
        : `OpsCrew sets ${key} in the repository variable ${CHECK_PAUSED_VARIABLE} (${reason === "retarget" ? "the app is moving to another server" : "the app is torn down"}), so the scheduled check skips it, opens no issue for it and closes its open ones.`,
      "Other environments' entries stay as they are.",
    ].join("\n"),
  });
  if (!approval.approved) return "refused";
  if (Object.keys(next).length === 0) {
    await api.deleteRepoVariable(owner, repo, CHECK_PAUSED_VARIABLE);
  } else {
    await api.setRepoVariable(owner, repo, CHECK_PAUSED_VARIABLE, JSON.stringify(next));
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `${reason === undefined ? "resume" : "pause"} the scheduled check for ${key}`,
    phase,
    target: where,
    decision: "approved",
  });
  return "changed";
}
