/**
 * The deploy pause (features 018, 019): the repository variable `OPSCREW_DEPLOY_PAUSED` holds
 * `{ "<app>/<env>": entry }`, and an environment's deploy workflow skips its deploy job while its
 * key is there. A move's maintenance window pauses the app's deploys (`move`); a rollback pins the
 * environment to the version it went back to (`rollback`). One entry per environment.
 */
import { posix } from "node:path";
import type { GitHubClient } from "@opscrew/connector-github";
import { OpsCrewError, realSleep } from "@opscrew/core";
import { checkEnvironmentKey, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { ProvisionServices } from "../provision/types";
import { codeOf } from "./errors";
import { pollUntil } from "./wait";

/** An environment's entry in `OPSCREW_DEPLOY_PAUSED`. It holds no secret. */
export type DeployPause =
  | { reason: "move"; since: string }
  | {
      reason: "rollback";
      since: string;
      /** The digest the rollback deployed, `sha256:…`. */
      image: string;
      /** Its commit. */
      commit: string;
      /** The commit rolled back from. */
      from?: string;
    };

const PauseSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("move"), since: z.string() }),
  z.object({
    reason: z.literal("rollback"),
    since: z.string(),
    image: z.string(),
    commit: z.string(),
    from: z.string().optional(),
  }),
]);

/** The variable as a whole: other environments' entries are only checked loosely, and kept. */
const PausesSchema = z.record(z.string(), z.looseObject({ reason: z.string(), since: z.string() }));

/** How long the window waits for a running deploy of the app, and how often it looks. */
const WAIT_MS = 30 * 60_000;
const POLL_MS = 10_000;

/** The repository, with the GitHub calls `K`. */
type Repo<K extends keyof GitHubClient> = {
  api: Pick<GitHubClient, K>;
  owner: string;
  repo: string;
};
type Writable = Repo<"getRepoVariable" | "setRepoVariable" | "deleteRepoVariable">;
type Deps = Pick<PhaseDeps, "audit">;

function notOpsCrews({ owner, repo }: Repo<never>): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    `The repository variable ${DEPLOY_PAUSED_VARIABLE} of ${owner}/${repo} is not the JSON OpsCrew writes, so OpsCrew changed nothing.`,
    {
      hint: `Delete the variable in the repository's Settings → Secrets and variables → Actions → Variables (it only pauses OpsCrew's deploys), then run \`opscrew provision\` again.`,
    },
  );
}

/**
 * The variable's entries as GitHub holds them (other environments' are written back unchanged),
 * and the plan's environment's own entry.
 * @throws OpsCrewError `INVALID_INPUT` when the variable is not OpsCrew's JSON.
 */
async function readPauses(
  github: Repo<"getRepoVariable">,
  plan: DeployPlan,
): Promise<{ all: Record<string, unknown>; own: DeployPause | undefined }> {
  const text = await github.api.getRepoVariable(github.owner, github.repo, DEPLOY_PAUSED_VARIABLE);
  if (text === undefined) return { all: {}, own: undefined };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const all = PausesSchema.safeParse(json);
  if (!all.success) throw notOpsCrews(github);
  const entry = all.data[checkEnvironmentKey(plan)];
  if (entry === undefined) return { all: json as Record<string, unknown>, own: undefined };
  const own = PauseSchema.safeParse(entry);
  if (!own.success) throw notOpsCrews(github);
  return { all: json as Record<string, unknown>, own: own.data };
}

/** The entry as OpsCrew writes it, its keys always in this order. */
function stored(entry: DeployPause): DeployPause {
  if (entry.reason === "move") return { reason: "move", since: entry.since };
  const { since, image, commit, from } = entry;
  return { reason: "rollback", since, image, commit, ...(from !== undefined ? { from } : {}) };
}

/**
 * Writes the plan's environment's entry (`undefined` removes it; the variable is deleted once it
 * is empty), keeping every other entry as it was; audited.
 */
async function writePause(
  deps: Deps,
  github: Writable,
  plan: DeployPlan,
  all: Record<string, unknown>,
  entry: DeployPause | undefined,
  /** The reason of the entry written or removed. */
  reason: DeployPause["reason"],
): Promise<void> {
  const { api, owner, repo } = github;
  const key = checkEnvironmentKey(plan);
  const { [key]: _old, ...others } = all;
  const next = entry === undefined ? others : { ...others, [key]: stored(entry) };
  if (Object.keys(next).length === 0) {
    await api.deleteRepoVariable(owner, repo, DEPLOY_PAUSED_VARIABLE);
  } else {
    await api.setRepoVariable(owner, repo, DEPLOY_PAUSED_VARIABLE, JSON.stringify(next));
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `${entry === undefined ? "resume" : "pause"} the deploys of ${key}`,
    ...(reason === "move" ? { phase: "provision" as const } : {}),
    target: `${owner}/${repo}`,
    decision: "approved",
    ...(entry?.reason === "rollback"
      ? { detail: `pinned to ${entry.commit} (${entry.image})` }
      : {}),
  });
}

/** "`opscrew rollback` pinned it to <short commit> (sha256:<12>)", as refusals and notes say it. */
export function pinnedText(pause: Extract<DeployPause, { reason: "rollback" }>): string {
  return `\`opscrew rollback\` pinned it to ${pause.commit.slice(0, 7)} (${pause.image.slice(0, 19)})`;
}

/**
 * The plan's environment's entry, or `undefined` when its deploys are not paused (read-only).
 * @throws OpsCrewError `INVALID_INPUT` when the variable is not OpsCrew's JSON.
 */
export async function deployPauseOf(
  github: Repo<"getRepoVariable">,
  plan: DeployPlan,
): Promise<DeployPause | undefined> {
  return (await readPauses(github, plan)).own;
}

/**
 * {@link deployPauseOf} for a check that needs no new token permission: a token GitHub refuses the
 * variable's read (`CREDENTIALS_*`, as one without Variables: read) counts as not paused.
 */
export async function readableDeployPause(
  github: Repo<"getRepoVariable">,
  plan: DeployPlan,
): Promise<DeployPause | undefined> {
  try {
    return await deployPauseOf(github, plan);
  } catch (error) {
    if (codeOf(error).startsWith("CREDENTIALS_")) return undefined;
    throw error;
  }
}

/**
 * Pauses the plan's environment's deploys with `entry`, replacing its entry; audited. Returns the
 * entry it replaced, for {@link restoreDeployPause}.
 * @throws OpsCrewError `INVALID_INPUT` when the variable is not OpsCrew's JSON (nothing changes).
 */
export async function setDeployPause(
  deps: Deps,
  github: Writable,
  plan: DeployPlan,
  entry: DeployPause,
): Promise<DeployPause | undefined> {
  const { all, own } = await readPauses(github, plan);
  await writePause(deps, github, plan, all, entry, entry.reason);
  return own;
}

/**
 * Puts back the entry {@link setDeployPause} replaced, or removes the environment's entry when it
 * replaced none; audited. Nothing changes when there is no entry to remove.
 */
export async function restoreDeployPause(
  deps: Deps,
  github: Writable,
  plan: DeployPlan,
  entry: DeployPause | undefined,
): Promise<void> {
  const { all, own } = await readPauses(github, plan);
  const reason = entry?.reason ?? own?.reason;
  if (reason === undefined) return;
  await writePause(deps, github, plan, all, entry, reason);
}

/**
 * Removes the environment's entry when it is of `reason`, never another reason's; audited.
 * Returns whether it removed one.
 * @throws OpsCrewError `INVALID_INPUT` when the variable is not OpsCrew's JSON (nothing changes).
 */
export async function clearDeployPause(
  deps: Deps,
  github: Writable,
  plan: DeployPlan,
  reason: DeployPause["reason"],
): Promise<boolean> {
  const { all, own } = await readPauses(github, plan);
  if (own?.reason !== reason) return false;
  await writePause(deps, github, plan, all, undefined, reason);
  return true;
}

/** A run of the environment's deploy workflow that is queued or in progress, by its link. */
export async function runningDeploy(
  github: Repo<"listWorkflowRuns">,
  plan: DeployPlan,
): Promise<{ url: string } | undefined> {
  const runs = await github.api.listWorkflowRuns(github.owner, github.repo, {
    workflowFile: posix.basename(plan.cicd.workflowPath),
    perPage: 20,
  });
  const run = runs.find((known) => known.status !== "completed");
  return run === undefined ? undefined : { url: run.htmlUrl };
}

/**
 * What a caller of {@link waitForDeploys} says when a deploy still runs after 30 minutes: what did
 * not happen, following "…still runs after 30 minutes, so", and the next step.
 */
export interface DeploysStillRun {
  outcome: string;
  hint: string;
}

/**
 * Waits until no run of the app's deploy workflow is queued or in progress, looking first one
 * poll interval after the pause was set.
 * @throws OpsCrewError `COMMAND_FAILED` with `stillRun`'s words when one still runs after 30
 * minutes.
 */
export async function waitForDeploys(
  deps: Pick<PhaseDeps, "reporter">,
  github: Repo<"listWorkflowRuns">,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "sleep" | "now">,
  stillRun: DeploysStillRun,
): Promise<void> {
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  // A run that started just before the pause may not be listed yet.
  await (services.sleep ?? realSleep)(POLL_MS);
  let said = false;
  const idle = await pollUntil(
    async () => {
      const runs = await github.api.listWorkflowRuns(github.owner, github.repo, {
        workflowFile,
        perPage: 20,
      });
      if (runs.every((run) => run.status === "completed")) return true;
      if (!said) deps.reporter.step(`Waiting for the running deploy of ${plan.app.name} to end`);
      said = true;
      return undefined;
    },
    {
      timeoutMs: WAIT_MS,
      intervalMs: POLL_MS,
      ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
      ...(services.now !== undefined ? { now: services.now } : {}),
    },
  );
  if (idle) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `A deploy of ${plan.app.name} (${workflowFile}) still runs after 30 minutes, so ${stillRun.outcome}`,
    { hint: stillRun.hint },
  );
}
