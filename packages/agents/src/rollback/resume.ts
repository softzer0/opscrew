/**
 * `opscrew rollback --resume [--deploy]` (plan.md 4., ADR 0023 D3): ends the pause a rollback set
 * on the environment's deploys, after a `github-settings` approval, which `--yes` grants; with
 * `--deploy` it also deploys its branch's latest commit now.
 */
import { posix } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { checkEnvironmentKey, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { PlanRefusedError } from "../shared";
import { clearDeployPause, deployPauseOf, pinnedText } from "../shared/deploy-pause";
import { dispatchAndFollow } from "../shared/deploy-run";
import type { RollbackResult } from "./index";
import { readPendingRollback } from "./record";
import { NOTHING, type RollbackRun, rollbackRepository } from "./run";

/** How the environment deploys while its deploys are on. */
function deploysOn(run: RollbackRun): string {
  const { plan } = run;
  if (plan.environment?.deploySource?.from === "promote") {
    return `\`opscrew promote --to ${run.environment}\` deploys it`;
  }
  // On this computer without the local runner, nothing deploys on a push.
  return plan.target.provider === "localhost" && plan.environment?.runner !== "local"
    ? `\`opscrew provision${run.flags}\` deploys it`
    : `each push to ${plan.cicd.branch} deploys it`;
}

/**
 * Removes the environment's `rollback` entry from `OPSCREW_DEPLOY_PAUSED` (audited), after a
 * `github-settings` approval; other environments' entries stay. With `deploy`, the approval also
 * names the commit the newest run of its workflow on its branch built, and the workflow is then
 * started there with no inputs (it builds and deploys, with its release command) and followed;
 * that works whether or not the deploys were paused. Refusals, before any change: a rollback
 * run left waiting for a reviewer (the next `opscrew rollback` records it first), a move's window
 * pausing the deploys (`opscrew provision` ends it), and `deploy` for a promoted environment,
 * which has no branch of its own, or on this computer without the local runner, where no
 * workflow deploys. Not paused and no `deploy`: it says so.
 * @throws OpsCrewError `APPROVAL_REFUSED` when the user does not approve, and
 * `dispatchAndFollow`'s errors for the deploy.
 */
export async function resumeDeploys(run: RollbackRun): Promise<RollbackResult> {
  const { deps, options, plan, environment, command, flags, services } = run;
  const deploy = options.deploy === true;
  const github = await rollbackRepository(deps, services);
  const { owner, repo } = github;
  const pending = await readPendingRollback(deps.paths);
  if (pending !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A rollback of ${environment} was left waiting for a required reviewer in GitHub: https://github.com/${owner}/${repo}/actions/runs/${pending.runId}. OpsCrew resumes the deploys only once that rollback is recorded. ${NOTHING}`,
      {
        hint: `Approve or reject that run in GitHub, then run \`${command}\` again to record it; after that, \`${command} --resume${deploy ? " --deploy" : ""}\` resumes the deploys.`,
      },
    );
  }
  const key = checkEnvironmentKey(plan);
  const pause = await deployPauseOf(github, plan);
  if (pause?.reason === "move") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment}'s deploys are paused since ${pause.since} for a move's maintenance window, which \`opscrew provision\` ends, not \`${command} --resume\`. ${NOTHING}`,
      { hint: `Run \`opscrew provision${flags}\` to go on with the move.` },
    );
  }
  const deploySource = plan.environment?.deploySource;
  if (deploy && deploySource?.from === "promote") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} is promoted from ${deploySource.source}, so it has no branch of its own for --deploy to deploy. ${NOTHING}`,
      {
        hint: `Run \`${command} --resume\`, then \`opscrew promote --to ${environment}\` to deploy what ${deploySource.source} runs.`,
      },
    );
  }
  if (deploy && plan.target.provider === "localhost" && plan.environment?.runner !== "local") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} runs on this computer without the local runner, so no workflow deploys it and --deploy has nothing to start. ${NOTHING}`,
      {
        hint: `Run \`${command} --resume\` without --deploy if its deploys are paused, then \`opscrew provision${flags}\` to deploy the checked-out commit.`,
      },
    );
  }
  if (pause === undefined && !deploy) {
    deps.reporter.info(`${environment}'s deploys are not paused: ${deploysOn(run)}. ${NOTHING}`);
    return { kind: "resumed", wasPaused: false };
  }

  // The approval: the pause removed, and with --deploy the run started.
  const branch = plan.cicd.branch;
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const lines: string[] = [];
  if (pause !== undefined) {
    lines.push(
      `OpsCrew removes ${key} from the repository variable ${DEPLOY_PAUSED_VARIABLE} (paused since ${pause.since}: ${pinnedText(pause)}), so ${deploysOn(run)} again.`,
    );
  }
  if (deploy) {
    const [newest] = await github.api.listWorkflowRuns(owner, repo, {
      workflowFile,
      branch,
      perPage: 1,
    });
    const subject = newest?.headCommit?.message.split("\n")[0]?.trim();
    const built =
      newest === undefined
        ? `${branch}'s latest commit`
        : `${newest.headSha.slice(0, 7)}${subject ? ` "${deps.redactor.redact(subject)}"` : ""}`;
    lines.push(
      `It also starts ${workflowFile} on ${branch} now: it builds ${built} and deploys it${plan.app.releaseCommand !== undefined ? ", with its release command" : ""}.`,
    );
  }
  lines.push("Other environments' entries stay as they are.");
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title:
      pause !== undefined
        ? `Resume the deploys of ${key}`
        : `Deploy ${branch} to ${environment} now`,
    details: lines.join("\n"),
  });
  const again = `${command} --resume${deploy ? " --deploy" : ""}`;
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: pause !== undefined ? `resume of ${key}'s deploys` : `deploy of ${branch}`,
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: NOTHING,
      hint: `Run \`${again}\` again when you want it; in a script, add --yes.`,
    });
  }
  if (pause !== undefined) {
    await clearDeployPause(deps, github, plan, "rollback");
    deps.reporter.success(`${environment}'s deploys are on: ${deploysOn(run)} again.`);
  }
  if (!deploy) return { kind: "resumed", wasPaused: true };

  deps.reporter.step(`Starting ${workflowFile} on ${branch}`);
  const started = await dispatchAndFollow(deps, github, {
    workflowFile,
    ref: branch,
    inputs: {},
    target: environment,
    command: again,
    detail: `${workflowFile} on ${branch}, deploying its latest commit (resume of ${key})`,
  });
  const commit = (await github.api.getWorkflowRun(owner, repo, started.runId)).headSha;
  if (started.status === "waiting") {
    deps.reporter.warn(
      `${environment}'s deploy run waits in GitHub for a required reviewer: ${started.runUrl}. Once they approve it, it deploys ${commit.slice(0, 7)}.`,
    );
  } else {
    deps.reporter.success(`${environment} runs ${commit.slice(0, 7)} (${started.runUrl}).`);
  }
  return {
    kind: "resumed",
    wasPaused: pause !== undefined,
    deployed: { status: started.status, runUrl: started.runUrl, commit },
  };
}
