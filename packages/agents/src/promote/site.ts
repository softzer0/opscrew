/**
 * `opscrew promote` for the server-less targets (feature 016, FR-1608, FR-1609): a site's
 * promotion on Cloudflare's hosting (the exact build the source runs, by its run and SHA-256), and
 * a rollback on either target (`--version`). Each after a `promote` approval bound to its hash.
 */
import { posix } from "node:path";
import {
  type CloudflareClient,
  WORKER_SECRET_NAME,
  WorkerSecretsChangedError,
  type WorkerVersion,
} from "@opscrew/connector-cloudflare";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  type ProjectPaths,
  realSleep,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import {
  githubEnvironment,
  renderCloudflareWorkersWorkflow,
  SITE_ARTIFACT,
} from "@opscrew/iac-templates";
import {
  type CloudflareWorkersDeployTarget,
  type DeployPlan,
  readArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { builderCicd } from "../environments/branches";
import { environmentPaths } from "../environments/paths";
import { committedTfvars } from "../provision/render";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import { PAGES_ENVIRONMENT } from "../serverless/pages/plan";
import { hasDeployment, PlanRefusedError, serverlessName } from "../shared";
import { codeOf, hintOf, reasonOf } from "../shared/errors";
import { runningVersions, versionBuild } from "../status/site";
import { buildPromotionHash, rollbackHash } from "./record";
import { githubRepository, NOTHING, type PromoteRepository, requireApplied } from "./shared";
import type { PromoteOptions, PromoteResult, PromoteServices } from "./types";

/** A run's page on GitHub. */
function runUrl(github: Pick<PromoteRepository, "owner" | "repo">, run: number): string {
  return `https://github.com/${github.owner}/${github.repo}/actions/runs/${run}`;
}

/** What a site's promotion and rollback share: the target, its plan, its paths and the command. */
interface SiteRun {
  deps: PhaseDeps;
  target: string;
  plan: DeployPlan;
  paths: ProjectPaths;
  services: PromoteServices;
  command: string;
  approveHash: string | undefined;
  /** `--allow-old-secrets`, checked, trimmed, without repeats and sorted. */
  allowOldSecrets?: string[];
}

/** Stops (nothing deployed) unless the environment is provisioned. */
function requireProvisioned(run: SiteRun, plan: DeployPlan, name: string): void {
  if (hasDeployment(plan)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${name} environment is not provisioned, so there is nothing to deploy to or from. ${NOTHING}`,
    {
      hint: `Run \`opscrew provision${name === "prod" ? "" : ` --env ${name}`}\` first, then \`${run.command}\` again.`,
    },
  );
}

/** The Cloudflare account of an environment's Worker, as its committed infrastructure code names it. */
async function accountOf(run: SiteRun, plan: DeployPlan, name: string): Promise<string> {
  const account = (await committedTfvars(run.deps.paths.root, plan))?.cloudflare_account_id;
  if (typeof account === "string" && account !== "") return account;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The infrastructure code of the ${name} environment (${plan.infra.dir}) names no Cloudflare account, so OpsCrew cannot find its Worker. ${NOTHING}`,
    {
      hint: `Check out the branch that contains ${plan.infra.dir}, or run \`opscrew provision${name === "prod" ? "" : ` --env ${name}`}\`, then run \`${run.command}\` again.`,
    },
  );
}

/** The Worker's versions and the one running now ({@link runningVersions}; read-only). */
async function workerState(
  client: CloudflareClient,
  accountId: string,
  worker: string,
): Promise<{ versions: WorkerVersion[]; running?: string } | undefined> {
  const versions = await client.listWorkerVersions(accountId, worker);
  if (versions === undefined) return undefined;
  const deployments = (await client.listWorkerDeployments(accountId, worker)) ?? [];
  const running = runningVersions(deployments).running?.versionId;
  return { versions, ...(running !== undefined ? { running } : {}) };
}

/** The approval's closing words: what OpsCrew's approval guards against, and GitHub's review. */
function guardText(reviewed: string | undefined): string {
  return reviewed !== undefined
    ? `GitHub also asks a required reviewer of the GitHub environment ${reviewed} before the deploy job runs: that review is the real gate. OpsCrew's approval guards against mistakes.`
    : "OpsCrew's approval guards against mistakes, not against someone with write access to the repository, who can start the workflow themselves.";
}

/**
 * Shows `details`, refuses an `--approve` hash that is not `hash`, asks the `promote` approval
 * bound to `hash` and checks it; `later` is the command that applies it without prompts.
 */
async function approve(
  run: SiteRun,
  input: { title: string; details: string; hash: string; later: string },
): Promise<void> {
  const { deps } = run;
  deps.reporter.info(input.details);
  if (run.approveHash !== undefined && run.approveHash.toLowerCase() !== input.hash) {
    throw new OpsCrewError(
      "PLAN_NOT_APPROVED",
      `The promotion you approved (${run.approveHash}) is not this one: what runs, an environment or ${run.target}'s plan changed since you reviewed it. ${NOTHING}`,
      { hint: `Review the promotion above; to deploy it, run: ${input.later}` },
    );
  }
  const approval = await deps.approvals.request({
    kind: "promote",
    title: input.title,
    details: input.details,
    planHash: input.hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "promotion",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: NOTHING,
      hint: `To deploy it later without prompts, run: ${input.later}`,
    });
  }
  await deps.approvals.assertApprovedPromotion(input.hash);
}

/**
 * Follows the deploy run `id` that `what` started to its end: `waiting` while a required reviewer
 * of its GitHub environment holds it when the wait ends; a run that did not succeed stops with
 * `COMMAND_FAILED`. Audited.
 */
async function followRun(
  run: SiteRun,
  github: PromoteRepository,
  input: { id: number; url: string; workflowFile: string; ref: string },
): Promise<{ status: "deployed" | "waiting"; runUrl: string }> {
  const { deps, target, command } = run;
  deps.reporter.step(`Waiting for the deploy run (${input.url})`);
  let done: Awaited<ReturnType<PromoteRepository["api"]["waitForWorkflowRun"]>>;
  try {
    done = await github.api.waitForWorkflowRun(github.owner, github.repo, {
      workflowFile: input.workflowFile,
      ref: input.ref,
      runId: input.id,
      onWaiting: (url) =>
        deps.reporter.info(
          `${target}'s deploy run waits in GitHub for a required reviewer: approve it at ${url}.`,
        ),
    });
  } catch (error) {
    throw new OpsCrewError(
      codeOf(error),
      deps.redactor.redact(
        `OpsCrew could not follow ${target}'s deploy run to its end: ${reasonOf(error)}. The run may still deploy the site.`,
      ),
      {
        hint: `Follow the run at ${input.url}; if it fails, fix what it says, then run \`${command}\` again.`,
      },
    );
  }
  if (done.status === "waiting") {
    deps.reporter.warn(
      `${target}'s deploy run still waits in GitHub for a required reviewer: ${done.htmlUrl}. Once they approve it, the run deploys the site; \`opscrew status --env ${target}\` shows what runs then.`,
    );
    return { status: "waiting", runUrl: done.htmlUrl };
  }
  const ok = done.conclusion === "success";
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "deploy workflow",
    target: done.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${done.id} finished: ${done.conclusion ?? "no result"}`,
  });
  if (!ok) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${target}'s deploy run did not succeed (${done.conclusion ?? "no result"}): ${done.htmlUrl}.`,
      {
        hint: `Open the run to see which step failed, fix what it says, then run \`${command}\` again.`,
      },
    );
  }
  return { status: "deployed", runUrl: done.htmlUrl };
}

/**
 * The GitHub environment the target's deploy job runs in (on GitHub Pages always
 * `github-pages`), when it has required reviewers.
 */
async function reviewedEnvironment(
  run: SiteRun,
  github: PromoteRepository,
): Promise<string | undefined> {
  const environment =
    run.plan.target.provider === "github-pages" ? PAGES_ENVIRONMENT : githubEnvironment(run.plan);
  if (environment === undefined) return undefined;
  const view = await github.api.getEnvironment(github.owner, github.repo, environment);
  return (view?.reviewers ?? []).length > 0 ? environment : undefined;
}

/**
 * A promotion on Cloudflare's hosting (`deploySource.from: promote`): the version the source's
 * Worker runs → the build its message names (`opscrew <run id> <sha256>`, from OpsCrew's deploy
 * job), whose artifact GitHub must still keep → the target applied and its workflow on the
 * default branch the one its plan generates →
 * the `promote` approval, bound to {@link buildPromotionHash} of both environments, the run, the
 * SHA-256 and the target plan's hash → the target's workflow dispatched with `run` and `sha256`,
 * which deploys exactly that build after checking its run and SHA-256, and followed to its end.
 */
async function promoteBuild(run: SiteRun): Promise<PromoteResult> {
  const { deps, target, plan, command } = run;
  const deploySource = plan.environment?.deploySource;
  if (deploySource?.from !== "promote") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment is deployed from ${plan.cicd.branch} on each push, not by promotion, so there is nothing to promote to it. ${NOTHING}`,
      {
        hint: `To roll it back, run \`${command} --version <id>\` with a version \`opscrew status --env ${target}\` lists. To deploy ${target} only with what another environment ran, run \`opscrew env set ${target} --from <environment>\`, then \`opscrew provision --env ${target}\`.`,
      },
    );
  }
  const { source } = deploySource;
  const sourcePlan = await readArtifact("plan", environmentPaths(deps.paths, source).files.plan);
  requireProvisioned(run, plan, target);
  requireProvisioned(run, sourcePlan, source);
  if (sourcePlan.target.provider !== "cloudflare-workers") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment is promoted from ${source}, which does not run on Cloudflare's hosting, so there is no build of a Worker to promote. ${NOTHING}`,
      {
        hint: `Design ${source} on Cloudflare's hosting too (\`opscrew env add\` gives every environment prod's target), then run \`${command}\` again.`,
      },
    );
  }

  // 1. What the source runs, and the build it came from.
  deps.reporter.step(`Finding the build ${source} runs`);
  const client = sharedCloudflareClient(deps, run.services);
  const worker = sourcePlan.target.worker;
  const state = await workerState(client, await accountOf(run, sourcePlan, source), worker);
  const running = state?.versions.find((version) => version.id === state.running);
  if (running === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The Worker ${worker} of the ${source} environment runs no version of its own yet, so there is nothing to promote. ${NOTHING}`,
      {
        hint: `Deploy ${source} first (a push to ${sourcePlan.cicd.branch} runs its workflow), then run \`${command}\` again.`,
      },
    );
  }
  const build = versionBuild(running);
  if (build === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The version ${running.id} the Worker ${worker} of ${source} runs was not uploaded by OpsCrew's deploy workflow (its message is not \`opscrew <run id> <sha256>\`), so OpsCrew cannot tell which build it is. ${NOTHING}`,
      {
        hint: `Deploy ${source} with its workflow (a push to ${sourcePlan.cicd.branch}), then run \`${command}\` again.`,
      },
    );
  }

  // 2. The build's artifact, which the target's workflow downloads: GitHub keeps it for the
  // repository's artifact retention only (90 days by default).
  const github = await githubRepository(deps, run.services);
  const artifacts = await github.api.runArtifacts(
    github.owner,
    github.repo,
    build.runId,
    SITE_ARTIFACT,
  );
  const artifact = artifacts?.find((known) => known.name === SITE_ARTIFACT);
  if (artifact === undefined || artifact.expired) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      artifact === undefined
        ? `GitHub has no ${SITE_ARTIFACT} artifact of run ${build.runId}, which built what ${source} runs, so there is no build to promote. ${NOTHING}`
        : `GitHub no longer keeps the build ${source} runs: the ${SITE_ARTIFACT} artifact of run ${build.runId} expired${artifact.expiresAt !== undefined ? ` on ${artifact.expiresAt}` : ""}, after the repository's artifact retention (90 days by default). ${NOTHING}`,
      {
        hint: `Deploy ${source} again (a push to ${sourcePlan.cicd.branch} builds the site anew), then run \`${command}\` to promote that build.`,
      },
    );
  }

  // 3. The target: applied, and its workflow on the default branch the one its plan generates
  // now (rendered as provision renders it, with the branch and workflow that build its sites).
  const builder = await builderCicd(run.paths, plan);
  const workflowFile = await requireApplied(deps, {
    target,
    plan,
    paths: run.paths,
    github,
    services: run.services,
    command,
    workflow: renderCloudflareWorkersWorkflow(
      plan,
      builder === undefined
        ? {}
        : { builderBranch: builder.branch, builderWorkflowPath: builder.workflowPath },
    ).content,
  });

  // 4. The approval, bound to the promotion's hash.
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hash = buildPromotionHash({ target, source, ...build, targetPlanHash });
  const targetWorker = (plan.target as CloudflareWorkersDeployTarget).worker;
  const url = plan.deployment.url;
  const details = [
    `Build: ${runUrl(github, build.runId)}, with the SHA-256 ${build.sha256}`,
    `  what ${source} runs (the version ${running.id} of its Worker ${worker}, uploaded ${running.createdOn})`,
    ...(artifact.expiresAt !== undefined
      ? [`  GitHub keeps that build until ${artifact.expiresAt}`]
      : []),
    `Target: ${target}${url !== undefined ? ` (${url})` : ""}, ${toPosixRelative(deps.paths.root, run.paths.files.plan)} with plan hash ${targetPlanHash}; nothing is waiting for \`opscrew provision\``,
    `Deploy: ${workflowFile} on ${github.defaultBranch}, given the run and the SHA-256: it downloads that build, refuses it unless its SHA-256 matches, and uploads it to the Worker ${targetWorker}; nothing is rebuilt`,
    `Promotion hash: ${hash}`,
    "",
    guardText(await reviewedEnvironment(run, github)),
  ].join("\n");
  await approve(run, {
    title: `Deploy the build ${source} runs to ${target}`,
    details,
    hash,
    later: `${command} --approve ${hash}`,
  });

  // 5. The target's workflow with the build's run and SHA-256, and its run.
  const { owner, repo, defaultBranch } = github;
  deps.reporter.step(
    `Starting ${workflowFile} on ${defaultBranch} with the build's run and SHA-256`,
  );
  let accepted = false;
  let dispatched: { runId: number; url: string };
  try {
    dispatched = await github.api.dispatchWorkflow(
      owner,
      repo,
      workflowFile,
      defaultBranch,
      { run: String(build.runId), sha256: build.sha256 },
      async () => {
        accepted = true;
        await deps.audit.append({
          kind: "provider-call",
          actor: "opscrew",
          action: "dispatch workflow",
          target: `${owner}/${repo}`,
          detail: `${workflowFile} on ${defaultBranch} with run ${build.runId} and ${build.sha256} (promotion ${hash})`,
        });
      },
    );
  } catch (error) {
    const code = codeOf(error);
    // A definite refusal starts nothing: GitHub's 404 or 422, or a token it refused. After a
    // timeout or a dropped connection the run may have started.
    if (!accepted && (code === "PHASE_PRECONDITION" || code.startsWith("CREDENTIALS_"))) {
      throw new OpsCrewError(
        code,
        deps.redactor.redact(
          `${target}'s deploy workflow did not start: ${reasonOf(error)}. ${NOTHING}`,
        ),
        { hint: `${hintOf(error)}Then run \`${command}\` again.` },
      );
    }
    throw new OpsCrewError(
      code,
      deps.redactor.redact(
        `${accepted ? `GitHub accepted the start of ${target}'s deploy workflow ${workflowFile}, but OpsCrew could not follow it` : `OpsCrew cannot tell whether GitHub started ${target}'s deploy workflow ${workflowFile}`}: ${reasonOf(error)}. The run may have started and may deploy the build.`,
      ),
      {
        hint: `Look for the run at https://github.com/${owner}/${repo}/actions: follow it if it is there, else run \`${command}\` again.`,
      },
    );
  }
  const followed = await followRun(run, github, {
    id: dispatched.runId,
    url: dispatched.url,
    workflowFile,
    ref: defaultBranch,
  });
  if (followed.status === "deployed") {
    deps.reporter.success(`${target} now runs the build ${source} runs (${followed.runUrl}).`);
  }
  return { ...followed, build };
}

/**
 * `--allow-old-secrets`, trimmed, without empty names or repeats, and sorted.
 * @throws OpsCrewError `INVALID_INPUT` for an empty list or a name that is not a secret's.
 */
function oldSecretNames(names: readonly string[]): string[] {
  const trimmed = names.map((name) => name.trim()).filter(Boolean);
  const wrong = trimmed.find((name) => !WORKER_SECRET_NAME.test(name));
  if (trimmed.length === 0 || wrong !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${wrong === undefined ? "--allow-old-secrets names no secret" : `"${wrong}" is not a secret's name`}. ${NOTHING}`,
      {
        hint: "Pass the names OpsCrew's refusal of the rollback listed, comma-separated: letters, digits and underscores, not starting with a digit.",
      },
    );
  }
  return [...new Set(trimmed)].sort();
}

/**
 * The refusal of a rollback to `version`, which predates a change to `secrets` (as Cloudflare
 * listed them): it would run with their old values, which may be a value rotated because it leaked.
 */
function oldSecretsRefusal(
  run: SiteRun,
  input: { worker: string; version: string; secrets: string[] },
): OpsCrewError {
  const one = input.secrets.length === 1;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The version ${input.version} of the Worker ${input.worker} predates a change to the ${one ? "secret" : "secrets"} ${listText(input.secrets)}: activated again, it would run with ${one ? "its old value, the one" : "their old values, the ones"} it was uploaded with, not the current ${one ? "one" : "ones"}. ${NOTHING}`,
    {
      hint: `Only if ${one ? "it was not changed because it leaked and its old value is" : "none of them was changed because it leaked and their old values are"} still safe, run \`${run.command} --version ${input.version} --allow-old-secrets ${input.secrets.join(",")}\`. Otherwise deploy a new version instead: it runs with the current ${one ? "value" : "values"}.`,
    },
  );
}

/**
 * A rollback on Cloudflare's hosting (`--version <id>`): a version of the environment's own Worker
 * other than the one running, activated again for all its traffic through Cloudflare's API after
 * the `promote` approval, bound to {@link rollbackHash} of the target, the version, its plan's
 * hash and the secrets `--allow-old-secrets` names. No build and no workflow run. When Cloudflare
 * refuses the version because secrets changed since it was active, the rollback is forced only
 * when the approval named each of them; otherwise it is refused, with nothing changed.
 */
async function rollBackWorker(run: SiteRun, version: string): Promise<PromoteResult> {
  const { deps, target, plan, command } = run;
  requireProvisioned(run, plan, target);
  const { worker } = plan.target as CloudflareWorkersDeployTarget;
  const client = sharedCloudflareClient(deps, run.services);
  const accountId = await accountOf(run, plan, target);
  const state = await workerState(client, accountId, worker);
  const chosen = state?.versions.find((known) => known.id === version);
  const list = `\`opscrew status${target === "prod" ? "" : ` --env ${target}`}\` lists the version that ran before`;
  if (chosen === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${version} is not a version of the Worker ${worker} of the ${target} environment. ${NOTHING}`,
      { hint: `${list}; run \`${command} --version <id>\` with it.` },
    );
  }
  if (chosen.id === state?.running) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The Worker ${worker} of the ${target} environment runs the version ${chosen.id} already. ${NOTHING}`,
      { hint: `${list}; run \`${command} --version <id>\` with it.` },
    );
  }
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const allowed = run.allowOldSecrets;
  const hash = rollbackHash({
    target,
    version: chosen.id,
    targetPlanHash,
    ...(allowed !== undefined ? { oldSecrets: allowed } : {}),
  });
  const build = versionBuild(chosen);
  const url = plan.deployment.url;
  const allowFlag = allowed !== undefined ? ` --allow-old-secrets ${allowed.join(",")}` : "";
  await approve(run, {
    title: `Roll ${target} back to the version ${chosen.id} of its Worker`,
    details: [
      `Version: ${chosen.id} of the Worker ${worker}, uploaded ${chosen.createdOn}${build !== undefined ? ` from the build of run ${build.runId} (SHA-256 ${build.sha256})` : ""}`,
      `Target: ${target}${url !== undefined ? ` (${url})` : ""}, ${toPosixRelative(deps.paths.root, run.paths.files.plan)} with plan hash ${targetPlanHash}`,
      `Deploy: Cloudflare serves that version for all of ${target}'s traffic again, within a minute; nothing is rebuilt`,
      ...(allowed !== undefined
        ? [
            `Old secrets (--allow-old-secrets): ${listText(allowed)}. If Cloudflare reports them changed since this version was active, OpsCrew activates it anyway and it runs with their old values, not the current ones; don't do this for a value rotated because it leaked`,
          ]
        : []),
      `Promotion hash: ${hash}`,
    ].join("\n"),
    hash,
    later: `${command} --version ${chosen.id}${allowFlag} --approve ${hash}`,
  });
  deps.reporter.step(`Activating the version ${chosen.id} of the Worker ${worker}`);
  const message = `opscrew rollback ${hash}`;
  let forced: string[] | undefined;
  try {
    await client.deployWorkerVersion(accountId, worker, chosen.id, message);
  } catch (error) {
    if (!(error instanceof WorkerSecretsChangedError)) throw error;
    const { secrets } = error;
    if (allowed === undefined || !secrets.every((name) => allowed.includes(name))) {
      throw oldSecretsRefusal(run, { worker, version: chosen.id, secrets });
    }
    deps.reporter.step(`Activating it anyway, with the old values of ${listText(secrets)}`);
    await client.deployWorkerVersion(accountId, worker, chosen.id, message, { force: true });
    forced = secrets;
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "activate worker version",
    target: worker,
    decision: "approved",
    detail: `version ${chosen.id} at 100%${forced !== undefined ? `, forced, with the old values of ${listText(forced)}` : ""} (promotion ${hash})`,
  });
  deps.reporter.success(`${target} runs the version ${chosen.id} of its Worker again.`);
  return { status: "deployed", version: chosen.id };
}

/** How long a re-run may take to show at GitHub: at most this many reads, this far apart. */
const RERUN_READS = 30;
const RERUN_INTERVAL_MS = 2_000;

/**
 * Waits (read-only, at most a minute) until GitHub shows an attempt of the run `runId` newer than
 * `attempt`: a re-run keeps the run's id and GitHub's answers can lag behind, so the earlier
 * attempt, completed already, never counts as the re-run's outcome.
 * @throws OpsCrewError `PROVIDER_ERROR` naming the run when GitHub shows no newer attempt in time.
 */
async function waitForRerun(
  run: SiteRun,
  github: PromoteRepository,
  input: { runId: number; attempt: number; url: string },
): Promise<void> {
  const sleep = run.services.sleep ?? realSleep;
  for (let read = 1; read <= RERUN_READS; read++) {
    const latest = await github.api.getWorkflowRun(github.owner, github.repo, input.runId);
    if ((latest.attempt ?? 0) > input.attempt) return;
    if (read < RERUN_READS) await sleep(RERUN_INTERVAL_MS);
  }
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    `GitHub accepted the re-run of run ${input.runId}, but did not show it started within a minute. It may still publish the site.`,
    {
      hint: `Follow it at ${input.url}; \`opscrew status${run.target === "prod" ? "" : ` --env ${run.target}`}\` shows what GitHub Pages serves once it ran.`,
    },
  );
}

/**
 * A rollback on GitHub Pages (`--version <run id>`): an earlier successful run of the site's
 * workflow, other than the one that published the site now, re-run after the `promote` approval,
 * bound to {@link rollbackHash} of the target, the run and its plan's hash, and followed to its
 * end. GitHub builds the site again from that run's commit and publishes it.
 */
async function rollBackPages(run: SiteRun, version: string): Promise<PromoteResult> {
  const { deps, target, plan, command } = run;
  if (!/^[1-9][0-9]*$/.test(version)) {
    throw new OpsCrewError("INVALID_INPUT", `"${version}" is not a workflow run's id. ${NOTHING}`, {
      hint: "Pass the id of an earlier GitHub Pages run, as `opscrew status` lists it.",
    });
  }
  requireProvisioned(run, plan, target);
  const github = await githubRepository(deps, run.services);
  const { owner, repo } = github;
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const runs = await github.api.pagesRuns(owner, repo, workflowFile);
  const at = runs.findIndex((known) => known.runId === Number(version));
  const chosen = runs[at];
  const list = "`opscrew status` lists the run that published the site before";
  if (chosen === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${version} is not a successful run of ${workflowFile}, the site's workflow. ${NOTHING}`,
      { hint: `${list}; run \`${command} --version <run id>\` with it.` },
    );
  }
  if (at === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The run ${chosen.runId} published the site that GitHub Pages serves now. ${NOTHING}`,
      { hint: `${list}; run \`${command} --version <run id>\` with it.` },
    );
  }
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hash = rollbackHash({ target, version: String(chosen.runId), targetPlanHash });
  const url = runUrl(github, chosen.runId);
  await approve(run, {
    title: `Roll ${target} back to the site run ${chosen.runId} published`,
    details: [
      `Run: ${url}, of the commit ${chosen.headSha}, last started ${chosen.startedAt}`,
      `Target: ${target}${plan.deployment.url !== undefined ? ` (${plan.deployment.url})` : ""}, ${toPosixRelative(deps.paths.root, run.paths.files.plan)} with plan hash ${targetPlanHash}`,
      `Deploy: GitHub re-runs that run: it builds the site again from that commit and publishes it`,
      `Promotion hash: ${hash}`,
      "",
      guardText(await reviewedEnvironment(run, github)),
    ].join("\n"),
    hash,
    later: `${command} --version ${chosen.runId} --approve ${hash}`,
  });
  deps.reporter.step(`Re-running the GitHub Pages run ${chosen.runId}`);
  await github.api.rerunWorkflowRun(owner, repo, chosen.runId);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "re-run workflow",
    target: `${owner}/${repo}`,
    detail: `${workflowFile} run ${chosen.runId} (promotion ${hash})`,
  });
  await waitForRerun(run, github, { runId: chosen.runId, attempt: chosen.attempt, url });
  const followed = await followRun(run, github, {
    id: chosen.runId,
    url,
    workflowFile,
    ref: plan.cicd.branch,
  });
  if (followed.status === "deployed") {
    deps.reporter.success(`GitHub Pages serves the site run ${chosen.runId} published again.`);
  }
  return { ...followed, version: String(chosen.runId) };
}

/**
 * `opscrew promote` for a site on a server-less target (`plan` is the target environment's, read
 * from `paths`): `--digest` is refused (no image); with `version` a rollback on either target;
 * without, a promotion on Cloudflare's hosting ({@link promoteBuild}). GitHub Pages refuses a
 * promotion: each environment builds its own site.
 */
export async function promoteSite(
  deps: PhaseDeps,
  input: { options: PromoteOptions; plan: DeployPlan; paths: ProjectPaths },
): Promise<PromoteResult> {
  const { options, plan, paths } = input;
  const { target } = options;
  // `promote` hands over only the server-less targets.
  const provider = plan.target.provider as "cloudflare-workers" | "github-pages";
  const command = `opscrew promote --to ${target}`;
  const run: SiteRun = {
    deps,
    target,
    plan,
    paths,
    services: options.services ?? {},
    command,
    approveHash: options.approveHash,
    ...(options.allowOldSecrets !== undefined
      ? { allowOldSecrets: oldSecretNames(options.allowOldSecrets) }
      : {}),
  };
  if (options.digest !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--digest names an image, and the ${target} environment is a site on ${serverlessName(provider)}, which has none. ${NOTHING}`,
      {
        hint: `To roll it back, run \`${command} --version <id>\` with a version \`opscrew status\` lists.`,
      },
    );
  }
  if (options.version !== undefined) {
    const version = options.version.trim();
    return provider === "github-pages" ? rollBackPages(run, version) : rollBackWorker(run, version);
  }
  if (provider === "github-pages") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Pages publishes a site from a build of its own, so each environment builds its own site and OpsCrew promotes none between them. ${NOTHING}`,
      {
        hint: `A push to ${plan.cicd.branch} builds and publishes the site. To roll it back, run \`${command} --version <run id>\` with a run \`opscrew status\` lists.`,
      },
    );
  }
  return promoteBuild(run);
}
