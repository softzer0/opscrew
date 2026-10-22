import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { githubConnector, type RegistryCredential } from "@opscrew/connector-github";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  type ProjectPaths,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import {
  type DeployPlan,
  environmentsOf,
  readArtifact,
  resolveEnvironmentPaths,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type DriftReport, runDrift } from "../drift";
import { environmentPaths } from "../environments";
import { REGISTRY_TOKEN_VAR } from "../provision";
import { missing } from "../provision/credentials";
import { secretsEnvironment } from "../provision/secrets";
import { reasonOf } from "../retarget/steps";
import { codeOf, hintOf } from "../retarget/window";
import {
  gitClient,
  githubClientFromToken,
  githubCoordinates,
  hasDeployment,
  PlanRefusedError,
} from "../shared";
import {
  type AppImage,
  type ChosenImage,
  checkProvenance,
  chooseImage,
  type ImageBuild,
  imageReference,
} from "./image";
import {
  clearPendingPromotion,
  promotionHash,
  readPendingPromotion,
  writePendingPromotion,
  writePromotion,
} from "./record";
import type { PromoteGitHubApi, PromoteOptions, PromoteResult, PromoteServices } from "./types";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NOTHING = "Nothing was deployed.";
const NOT_RECORDED = "OpsCrew did not record the image as running.";

/** How many pending changes a refusal names before it says how many more there are. */
const LISTED = 5;

/** The GitHub repository the promotion deploys from, with the API and its default branch. */
async function githubRepository(deps: PhaseDeps, services: PromoteServices) {
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
  if (!api) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  const { defaultBranch } = await api.getRepo(owner, repo);
  return { api, owner, repo, defaultBranch };
}

/**
 * GHCR's credential: `OPSCREW_GHCR_READ_TOKEN` (a classic `read:packages` token, which GHCR
 * accepts where it may refuse a fine-grained one), registered with the redactor; else none, and
 * the GitHub client's own token is used.
 */
function registryCredential(deps: PhaseDeps, owner: string): RegistryCredential | undefined {
  const token = deps.env[REGISTRY_TOKEN_VAR]?.trim();
  if (!token) return undefined;
  deps.redactor.addLiteral(token, REGISTRY_TOKEN_VAR);
  return { username: owner, token };
}

/**
 * Every difference the target's check found that `opscrew provision` would apply: the
 * infrastructure plan's changes, the generated files that differ from the plan or are missing, the
 * server's differences provision puts back, OpsCrew's Cloudflare rules and the Portainer stack plan.
 * Not the Portainer deploy branch: the deploy workflow itself writes it again.
 */
function pendingChanges(report: DriftReport): string[] {
  return [
    ...report.pending.map((change) => `${change.address} (${change.action})`),
    ...report.files.changed.map((file) => `${file} (generated file changed)`),
    ...report.files.created.map((file) => `${file} (generated file missing)`),
    ...(report.host?.differences ?? [])
      .filter((difference) => difference.restoredByProvision)
      .map((difference) => `${difference.title} (on the server)`),
    ...(report.cloudflareRules ?? []).map((difference) => difference.title),
    ...(report.portainer?.differences ?? [])
      .filter((difference) => difference.area !== "deploy-branch")
      .map((difference) => difference.title),
  ];
}

/** At most {@link LISTED} items, then how many more. */
function shortList(items: readonly string[]): string {
  const more = items.length - LISTED;
  return more > 0 ? `${items.slice(0, LISTED).join(", ")} and ${more} more` : listText(items);
}

/** The git blob SHA-1 of a file's text, as GitHub's contents API names it. */
function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** A deploy run still waiting for its reviewer, with the command that records it afterwards. */
function stillWaiting(target: string, url: string, command: string): string {
  return `${target}'s deploy run still waits in GitHub for a required reviewer: ${url}. Once they approve it, the run deploys the image. ${NOT_RECORDED} Run \`${command}\` again once the run succeeded: it records the image without a new deploy.`;
}

/**
 * The target's pending promotion, whose run was left waiting for a reviewer: recorded once that
 * run succeeded (the result, with no new dispatch), reported again while it has not finished
 * (`waiting`), and cleared when it failed or was cancelled, so a new promotion goes ahead
 * (`undefined`, as without one).
 */
async function checkPending(
  deps: PhaseDeps,
  paths: ProjectPaths,
  image: AppImage,
  run: { target: string; command: string },
): Promise<PromoteResult | undefined> {
  const pending = await readPendingPromotion(paths);
  if (pending === undefined) return undefined;
  const { target, command } = run;
  const { digest, source } = pending;
  deps.reporter.step(`Checking ${target}'s deploy run that waited for a reviewer`);
  const last = await image.github.getWorkflowRun(image.owner, image.repo, pending.runId);
  if (last.status !== "completed") {
    deps.reporter.warn(
      last.status === "waiting"
        ? stillWaiting(target, last.htmlUrl, command)
        : `${target}'s deploy run ${last.htmlUrl} has not finished yet. ${NOT_RECORDED} Run \`${command}\` again once it succeeded: it records the image without a new deploy.`,
    );
    return { status: "waiting", digest, runUrl: last.htmlUrl };
  }
  const ok = last.conclusion === "success";
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "deploy workflow",
    target: last.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${last.id} finished: ${last.conclusion ?? "no result"}`,
  });
  await clearPendingPromotion(paths);
  if (!ok) {
    deps.reporter.warn(
      `${target}'s deploy run that waited for a reviewer did not succeed (${last.conclusion ?? "no result"}): ${last.htmlUrl}. OpsCrew forgot it and goes on with a new promotion.`,
    );
    return undefined;
  }
  await writePromotion(paths, {
    digest,
    source,
    runUrl: last.htmlUrl,
    at: deps.clock.now().toISOString(),
  });
  deps.reporter.success(`${target} now runs ${imageReference(image, digest)} (${last.htmlUrl}).`);
  return { status: "deployed", digest, runUrl: last.htmlUrl };
}

/** What the approval shows: the image, its build, the target's plan and the hash. */
function promotionDetails(input: {
  target: string;
  source: string;
  plan: DeployPlan;
  planFile: string;
  targetPlanHash: string;
  image: AppImage;
  chosen: ChosenImage;
  build: ImageBuild;
  workflowFile: string;
  defaultBranch: string;
  hash: string;
  /** The target's GitHub environment, when it has required reviewers. */
  reviewed: string | undefined;
}): string {
  const { target, source, plan, chosen, build } = input;
  const url = plan.deployment.url;
  return [
    `Image: ${imageReference(input.image, chosen.digest)}`,
    chosen.rollback
      ? `  ${target}'s previous image (labelled opscrew-${target}-previous): a rollback`
      : `  the image ${source} runs (labelled opscrew-${source})`,
    `Built by: ${build.runUrl}, from ${build.branch} at ${build.commit}`,
    `Target: ${target}${url !== undefined ? ` (${url})` : ""}, ${input.planFile} with plan hash ${input.targetPlanHash}; nothing is waiting for \`opscrew provision\``,
    `Deploy: ${input.workflowFile} on ${input.defaultBranch}, the one this plan generates, given the digest; nothing is rebuilt`,
    ...(plan.supplyChain.sign
      ? [
          "Signature: the workflow checks the image's cosign signature before anything is deployed (supplyChain.sign)",
        ]
      : []),
    `Promotion hash: ${input.hash}`,
    "",
    input.reviewed !== undefined
      ? `GitHub also asks a required reviewer of the GitHub environment ${input.reviewed} before the deploy job runs: that review is the real gate. OpsCrew's approval guards against mistakes.`
      : "OpsCrew's approval guards against mistakes, not against someone with write access to the repository, who can start the workflow themselves.",
  ].join("\n");
}

/**
 * `opscrew promote --to <target>` (FR-1518–FR-1520): deploys to `target` the image its source
 * environment (`deploySource.source`) runs, or with `digest` the target's previous image for a
 * rollback, without rebuilding it.
 * 1. The image: the source's `opscrew-<source>` label, or the requested digest, which must be that
 *    image or the target's `opscrew-<target>-previous`.
 * 2. Its provenance: the SLSA v1 build run is a push of this repository's own commits to the
 *    default branch, at the commit the image is tagged with (in the form of the environment that
 *    built it: `<commit>` for prod, `<commit>-<env>` for another).
 * 3. The target: provisioned, with nothing `opscrew provision` would apply (read-only drift), and
 *    the workflow on the default branch the one its plan generates (by git blob hash).
 * 4. The `promote` approval, bound to {@link promotionHash} of both environments, the digest and
 *    the target plan's hash; never granted by `--yes`.
 * 5. The target's workflow, dispatched on the default branch with the digest and that commit tag
 *    (which its verify job checks again), and its run; the
 *    digest is recorded in the target's state once the run succeeded. With `supplyChain.sign`, the
 *    workflow's verify job checks the signature before its deploy job runs. A run that waits for
 *    a required reviewer of the target's GitHub environment is reported as waiting, with its link;
 *    one still waiting when the wait ends is the result `waiting`, recorded as the target's pending
 *    promotion, which the next `opscrew promote --to <target>` checks first ({@link checkPending}).
 * `deps` may be any environment's: the target's paths are resolved here.
 * @throws OpsCrewError `PHASE_PRECONDITION` for each refusal, `PLAN_NOT_APPROVED` when
 * `approveHash` names another promotion, `APPROVAL_REFUSED` when the user does not approve, and
 * `COMMAND_FAILED` when the deploy run does not succeed.
 */
export async function promote(deps: PhaseDeps, options: PromoteOptions): Promise<PromoteResult> {
  const services = options.services ?? {};
  const { target, digest: requested } = options;
  const command = `opscrew promote --to ${target}`;
  const provisionFirst = `Run \`opscrew provision --env ${target}\` first, then \`${command}\` again.`;

  // 0. The environments' plans (no network yet).
  if (requested !== undefined && !DIGEST.test(requested)) {
    throw new OpsCrewError("INVALID_INPUT", `"${requested}" is not an image digest.`, {
      hint: "Pass the digest as sha256: followed by 64 lower-case hexadecimal digits.",
    });
  }
  const targetPaths = await resolveEnvironmentPaths(deps.paths.root, target, {
    env: { OPSCREW_HOME: deps.paths.homeDir },
  });
  const plan = await readArtifact("plan", targetPaths.files.plan);
  const deploySource = plan.environment?.deploySource;
  if (deploySource?.from !== "promote") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment is deployed from main on each push, not by promotion, so there is nothing to promote to it. ${NOTHING}`,
      {
        hint: `To deploy ${target} only with releases another environment ran, run \`opscrew env set ${target} --from <environment>\`, then \`opscrew provision --env ${target}\`.`,
      },
    );
  }
  const { source } = deploySource;
  const sourcePlan = await readArtifact("plan", environmentPaths(deps.paths, source).files.plan);
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment is not provisioned, so there is nowhere to deploy the image. ${NOTHING}`,
      { hint: provisionFirst },
    );
  }

  // 1. The image, and 2. where it was built.
  const github = await githubRepository(deps, services);
  const { owner, repo, defaultBranch } = github;
  const actions = `https://github.com/${owner}/${repo}/actions`;
  const credential = registryCredential(deps, owner);
  const image: AppImage = {
    github: github.api,
    owner,
    repo,
    ...(credential !== undefined ? { credential } : {}),
  };
  const followed = await checkPending(deps, targetPaths, image, { target, command });
  if (followed !== undefined) return followed;
  deps.reporter.step(`Finding the image to deploy to ${target}`);
  const chosen = await chooseImage(image, {
    source,
    target,
    sourceDeployed: hasDeployment(sourcePlan),
    ...(requested !== undefined ? { requested } : {}),
  });
  const { digest } = chosen;
  deps.reporter.step("Checking where the image was built (its build provenance)");
  const environments = await environmentsOf(deps.paths.root);
  const build = await checkProvenance(image, digest, defaultBranch, environments);

  // 3. The target: nothing pending, and the workflow on the default branch the one it generates.
  deps.reporter.step(`Checking ${target} for changes not applied yet (read-only)`);
  const report = await (services.drift ?? runDrift)({ ...deps, paths: targetPaths });
  const pending = pendingChanges(report);
  if (pending.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment has changes that are not applied yet: ${shortList(pending)}. OpsCrew promotes only to an environment whose plan is applied, so the approval names what will run. ${NOTHING}`,
      { hint: provisionFirst },
    );
  }
  const { workflowPath } = plan.cicd;
  const workflowFile = posix.basename(workflowPath);
  // Drift found the repository's copy equal to the rendered one, so its blob (with LF line endings,
  // as provision writes and commits it) is the rendered workflow's.
  const rendered = (await readFile(join(deps.paths.root, workflowPath), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const onDefault = await github.api.fileSha(owner, repo, workflowPath, defaultBranch);
  if (onDefault !== gitBlobSha(rendered)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      onDefault === undefined
        ? `The default branch ${defaultBranch} has no ${workflowPath}, the deploy workflow ${target}'s plan generates, so GitHub cannot start it. ${NOTHING}`
        : `The deploy workflow on the default branch ${defaultBranch} (${workflowPath}) is not the one ${target}'s plan generates, so its run would not do what this promotion shows. ${NOTHING}`,
      {
        hint: `Merge the deploy-setup pull request \`opscrew provision --env ${target}\` opened (or run it, if none is open), then run \`${command}\` again.`,
      },
    );
  }

  // 4. The approval, bound to the promotion's hash. It says whether GitHub also asks a reviewer.
  const environment = secretsEnvironment(plan);
  const reviewers =
    environment === undefined
      ? []
      : ((await github.api.getEnvironment(owner, repo, environment))?.reviewers ?? []);
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hash = promotionHash({ target, source, digest, targetPlanHash });
  const details = promotionDetails({
    target,
    source,
    plan,
    planFile: toPosixRelative(deps.paths.root, targetPaths.files.plan),
    targetPlanHash,
    image,
    chosen,
    build,
    workflowFile,
    defaultBranch,
    hash,
    reviewed: reviewers.length > 0 ? environment : undefined,
  });
  deps.reporter.info(details);
  const later = `${command} --digest ${digest} --approve ${hash}`;
  if (options.approveHash !== undefined && options.approveHash.toLowerCase() !== hash) {
    throw new OpsCrewError(
      "PLAN_NOT_APPROVED",
      `The promotion you approved (${options.approveHash}) is not this one: the image, an environment or ${target}'s plan changed since you reviewed it. ${NOTHING}`,
      { hint: `Review the promotion above; to deploy it, run: ${later}` },
    );
  }
  const approval = await deps.approvals.request({
    kind: "promote",
    title: chosen.rollback
      ? `Roll ${target} back to its previous image`
      : `Deploy the image ${source} runs to ${target}`,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "promotion",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: NOTHING,
      hint: `To deploy it later without prompts, run: ${later}`,
    });
  }
  await deps.approvals.assertApprovedPromotion(hash);

  // 5. The target's workflow with the digest, its run, and the record.
  const since = deps.clock.now().toISOString();
  deps.reporter.step(`Starting ${workflowFile} on ${defaultBranch} with the image's digest`);
  let dispatched: { runId: number; url: string };
  let accepted = false;
  try {
    // Recorded as soon as GitHub accepts the dispatch, before any wait for its run.
    dispatched = await github.api.dispatchWorkflow(
      owner,
      repo,
      workflowFile,
      defaultBranch,
      { digest, tag: build.tag },
      async () => {
        accepted = true;
        await deps.audit.append({
          kind: "provider-call",
          actor: "opscrew",
          action: "dispatch workflow",
          target: `${owner}/${repo}`,
          detail: `${workflowFile} on ${defaultBranch} with ${digest} (promotion ${hash})`,
        });
      },
    );
  } catch (error) {
    const code = codeOf(error);
    // A definite refusal starts nothing: GitHub's 404 or 422 (the connector's precondition), or a
    // token it refused. After a timeout or a dropped connection the run may have started.
    if (!accepted && (code === "PHASE_PRECONDITION" || code.startsWith("CREDENTIALS_"))) {
      throw new OpsCrewError(
        code,
        deps.redactor.redact(
          `${target}'s deploy workflow did not start: ${reasonOf(error)}. ${NOTHING}`,
        ),
        {
          hint:
            code === "PHASE_PRECONDITION"
              ? `GitHub starts it only from the default branch ${defaultBranch}, as \`opscrew provision --env ${target}\` writes it for a promoted environment: run it, merge its pull request, then run \`${command}\` again.`
              : `${hintOf(error)}Then run \`${command}\` again.`,
        },
      );
    }
    throw new OpsCrewError(
      code,
      deps.redactor.redact(
        `${accepted ? `GitHub accepted the start of ${target}'s deploy workflow ${workflowFile}, but OpsCrew could not follow it` : `OpsCrew cannot tell whether GitHub started ${target}'s deploy workflow ${workflowFile}`}: ${reasonOf(error)}. The run may have started and may deploy the image. ${NOT_RECORDED}`,
      ),
      {
        hint: `Look for the run at ${actions}: follow it if it is there, else run \`${command}\` again.`,
      },
    );
  }
  deps.reporter.step(`Waiting for the deploy run (${dispatched.url})`);
  let run: Awaited<ReturnType<PromoteGitHubApi["waitForWorkflowRun"]>>;
  try {
    run = await github.api.waitForWorkflowRun(owner, repo, {
      workflowFile,
      ref: defaultBranch,
      runId: dispatched.runId,
      since,
      onWaiting: (url) =>
        deps.reporter.info(
          `${target}'s deploy run waits in GitHub for a required reviewer: approve it at ${url}. OpsCrew follows the run and records the image once it succeeded.`,
        ),
    });
  } catch (error) {
    throw new OpsCrewError(
      codeOf(error),
      deps.redactor.redact(
        `OpsCrew could not follow ${target}'s deploy run to its end: ${reasonOf(error)}. The run may still deploy the image. ${NOT_RECORDED}`,
      ),
      {
        hint: `Follow the run at ${dispatched.url}; if it fails, fix what it says, then run \`${command}\` again.`,
      },
    );
  }
  if (run.status === "waiting") {
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "deploy workflow",
      target: run.htmlUrl,
      detail: `workflow run ${run.id} waits for a required reviewer`,
    });
    await writePendingPromotion(targetPaths, {
      digest,
      source,
      runId: run.id,
      at: deps.clock.now().toISOString(),
    });
    deps.reporter.warn(stillWaiting(target, run.htmlUrl, command));
    return { status: "waiting", digest, runUrl: run.htmlUrl };
  }
  const ok = run.conclusion === "success";
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "deploy workflow",
    target: run.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${run.id} finished: ${run.conclusion ?? "no result"}`,
  });
  if (!ok) {
    const checks = plan.supplyChain.sign
      ? "the image's provenance and signature"
      : "the image's provenance";
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${target}'s deploy run did not succeed (${run.conclusion ?? "no result"}): ${run.htmlUrl}. Its verify job checks ${checks} before the deploy job runs. ${NOT_RECORDED}`,
      {
        hint: `Open the run to see which job failed, fix what it says, then run \`${command}\` again.`,
      },
    );
  }
  await writePromotion(targetPaths, {
    digest,
    source,
    runUrl: run.htmlUrl,
    at: deps.clock.now().toISOString(),
  });
  deps.reporter.success(`${target} now runs ${imageReference(image, digest)} (${run.htmlUrl}).`);
  return { status: "deployed", digest, runUrl: run.htmlUrl };
}
