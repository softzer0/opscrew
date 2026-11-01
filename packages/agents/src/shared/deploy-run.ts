/**
 * A deploy workflow started by OpsCrew (`workflow_dispatch`) and followed to its end: promote's
 * step 5, shared with `opscrew rollback` and its `--resume --deploy`.
 */
import type { GitHubClient } from "@opscrew/connector-github";
import { type ErrorCode, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { codeOf, hintOf, reasonOf } from "./errors";

/** What a run that may have deployed, or did not, says of OpsCrew's record. */
export const NOT_RECORDED = "OpsCrew did not record the image as running.";
const NOTHING = "Nothing was deployed.";

/** The repository the workflow runs in, with the GitHub calls a dispatch needs. */
export interface DispatchRepository {
  api: Pick<GitHubClient, "dispatchWorkflow" | "waitForWorkflowRun">;
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** The run to start. */
export interface DispatchInput {
  workflowFile: string;
  /** The branch the workflow is started on. */
  ref: string;
  inputs: Record<string, string>;
  /** The environment it deploys, as the messages name it. */
  target: string;
  /** The command to run again after a failure. */
  command: string;
  /** The audit entry's detail once GitHub accepted the dispatch. */
  detail: string;
  /** What the workflow's verify job checks before its deploy job, named when the run fails. */
  verifies?: string;
}

/** A deploy run once it ended, or waits for a required reviewer. */
type FinishedRun = Awaited<ReturnType<DispatchRepository["api"]["waitForWorkflowRun"]>>;

/**
 * What a {@link dispatchAndFollow} that threw tells of the run ({@link deployRunFailure}): GitHub
 * definitely refused the dispatch, so none started (`refused`); the run ended without success
 * (`failed`, with its conclusion and link); or the run may have started (`unknown`).
 */
export type DeployRunFailure =
  | { kind: "refused" }
  | { kind: "failed"; conclusion: string | null; runUrl: string }
  | { kind: "unknown" };

/** An error of {@link dispatchAndFollow}, with what it tells of the run. */
class DeployRunError extends OpsCrewError {
  readonly failure: DeployRunFailure;

  constructor(failure: DeployRunFailure, code: ErrorCode, message: string, hint: string) {
    super(code, message, { hint });
    this.failure = failure;
  }
}

/** What the error `dispatchAndFollow` threw tells of the run; `unknown` for any other error. */
export function deployRunFailure(error: unknown): DeployRunFailure {
  return error instanceof DeployRunError ? error.failure : { kind: "unknown" };
}

/** Audits how the deploy run `run` finished: approved when it succeeded, refused otherwise. */
export async function auditFinishedRun(
  deps: Pick<PhaseDeps, "audit">,
  run: { id: number; conclusion: string | null; htmlUrl: string },
): Promise<void> {
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "deploy workflow",
    target: run.htmlUrl,
    decision: run.conclusion === "success" ? "approved" : "refused",
    detail: `workflow run ${run.id} finished: ${run.conclusion ?? "no result"}`,
  });
}

/**
 * Starts `input.workflowFile` on `input.ref` with `input.inputs` (audited as soon as GitHub accepts
 * it, before any wait), then follows its run, and returns it with the commit it runs on
 * (`headSha`). A run left waiting for a required reviewer of its GitHub environment when the wait
 * ends is `waiting` (audited); the caller records it.
 * @throws OpsCrewError with GitHub's code and "Nothing was deployed." when GitHub definitely
 * refused the dispatch (its 404 or 422, or a refused token); saying the run may have started when
 * the dispatch's answer was lost or the run could not be followed; `COMMAND_FAILED` naming the run
 * when it did not succeed (audited). {@link deployRunFailure} tells the three apart.
 */
export async function dispatchAndFollow(
  deps: Pick<PhaseDeps, "audit" | "reporter" | "redactor">,
  github: DispatchRepository,
  input: DispatchInput,
): Promise<{ status: "deployed" | "waiting"; runId: number; runUrl: string; headSha: string }> {
  const { owner, repo } = github;
  const { workflowFile, ref, target, command } = input;
  let dispatched: { runId: number; url: string };
  let accepted = false;
  try {
    dispatched = await github.api.dispatchWorkflow(
      owner,
      repo,
      workflowFile,
      ref,
      input.inputs,
      async () => {
        accepted = true;
        await deps.audit.append({
          kind: "provider-call",
          actor: "opscrew",
          action: "dispatch workflow",
          target: `${owner}/${repo}`,
          detail: input.detail,
        });
      },
    );
  } catch (error) {
    const code = codeOf(error);
    // A definite refusal starts nothing: GitHub's 404 or 422 (the connector's precondition), or a
    // token it refused. After a timeout or a dropped connection the run may have started.
    if (!accepted && (code === "PHASE_PRECONDITION" || code.startsWith("CREDENTIALS_"))) {
      const branch =
        ref === github.defaultBranch ? `the default branch ${ref}` : `the branch ${ref}`;
      throw new DeployRunError(
        { kind: "refused" },
        code,
        deps.redactor.redact(
          `${target}'s deploy workflow did not start: ${reasonOf(error)}. ${NOTHING}`,
        ),
        code === "PHASE_PRECONDITION"
          ? `GitHub starts it only from ${branch}, as \`opscrew provision --env ${target}\` writes it: run it, merge its pull request, then run \`${command}\` again.`
          : `${hintOf(error)}Then run \`${command}\` again.`,
      );
    }
    throw new DeployRunError(
      { kind: "unknown" },
      code,
      deps.redactor.redact(
        `${accepted ? `GitHub accepted the start of ${target}'s deploy workflow ${workflowFile}, but OpsCrew could not follow it` : `OpsCrew cannot tell whether GitHub started ${target}'s deploy workflow ${workflowFile}`}: ${reasonOf(error)}. The run may have started and may deploy the image. ${NOT_RECORDED}`,
      ),
      `Look for the run at https://github.com/${owner}/${repo}/actions: follow it if it is there, else run \`${command}\` again.`,
    );
  }
  deps.reporter.step(`Waiting for the deploy run (${dispatched.url})`);
  let run: FinishedRun;
  try {
    run = await github.api.waitForWorkflowRun(owner, repo, {
      workflowFile,
      ref,
      runId: dispatched.runId,
      onWaiting: (url) =>
        deps.reporter.info(
          `${target}'s deploy run waits in GitHub for a required reviewer: approve it at ${url}. OpsCrew follows the run and records the image once it succeeded.`,
        ),
    });
  } catch (error) {
    throw new DeployRunError(
      { kind: "unknown" },
      codeOf(error),
      deps.redactor.redact(
        `OpsCrew could not follow ${target}'s deploy run to its end: ${reasonOf(error)}. The run may still deploy the image. ${NOT_RECORDED}`,
      ),
      `Follow the run at ${dispatched.url}; if it fails, fix what it says, then run \`${command}\` again.`,
    );
  }
  const found = { runId: run.id, runUrl: run.htmlUrl, headSha: run.headSha };
  if (run.status === "waiting") {
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "deploy workflow",
      target: run.htmlUrl,
      detail: `workflow run ${run.id} waits for a required reviewer`,
    });
    return { status: "waiting", ...found };
  }
  await auditFinishedRun(deps, run);
  if (run.conclusion !== "success") {
    const verifies =
      input.verifies !== undefined
        ? ` Its verify job checks ${input.verifies} before the deploy job runs.`
        : "";
    throw new DeployRunError(
      { kind: "failed", conclusion: run.conclusion, runUrl: run.htmlUrl },
      "COMMAND_FAILED",
      `${target}'s deploy run did not succeed (${run.conclusion ?? "no result"}): ${run.htmlUrl}.${verifies} ${NOT_RECORDED}`,
      `Open the run to see which job failed, fix what it says, then run \`${command}\` again.`,
    );
  }
  return { status: "deployed", ...found };
}
