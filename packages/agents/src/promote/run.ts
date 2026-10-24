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
  isServerlessProvider,
  readArtifact,
  resolveEnvironmentPaths,
  targetArch,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { environmentPaths, sharedPartsDiffer } from "../environments";
import { builderBranch } from "../environments/branches";
import { ghcrReadCredential } from "../localhost/image";
import { secretsEnvironment } from "../provision/secrets";
import { hasDeployment, PlanRefusedError } from "../shared";
import { codeOf, hintOf, reasonOf } from "../shared/errors";
import {
  type AppImage,
  type ChosenImage,
  checkPlatform,
  checkProvenance,
  chooseImage,
  type ImageBuild,
  imageFactsOf,
  imageReference,
} from "./image";
import {
  clearPendingPromotion,
  type PromotionRecord,
  promotionHash,
  readPendingPromotion,
  readPromotion,
  writePendingPromotion,
  writePromotion,
} from "./record";
import { githubRepository, NOTHING, requireApplied } from "./shared";
import { promoteSite } from "./site";
import type { PromoteGitHubApi, PromoteOptions, PromoteResult } from "./types";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NOT_RECORDED = "OpsCrew did not record the image as running.";

/**
 * The target is ready for the image its source runs (FR-1539): it has every service of the
 * source's plan with the same settings, and every other shared part equal; services beyond the
 * source's are allowed.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming each difference and the commands that fix it.
 */
function requireReady(
  target: string,
  source: string,
  sourcePlan: DeployPlan,
  plan: DeployPlan,
): void {
  const differ = sharedPartsDiffer(sourcePlan, plan);
  if (differ.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${target} environment is not ready for the image ${source} runs: its plan differs from ${source}'s in what every environment shares: ${listText(differ)}. ${NOTHING}`,
    {
      hint: `Run \`opscrew design --env ${target}\`, then \`opscrew provision --env ${target}\`, then \`opscrew promote --to ${target}\` again.`,
    },
  );
}

/** The names of the plan's services, as a promotion records them. */
function serviceNames(plan: DeployPlan): string[] {
  return plan.services.map((service) => service.name);
}

/**
 * A rollback to the target's previous image: that image ran with the services its promotion
 * recorded, so the target's plan must still have each of them. Its promotion is the `previous` of
 * the target's record, or the record itself when another computer promoted the target since.
 * Returns false when this computer has no record of that image's promotion, so nothing could be
 * checked.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the services the plan no longer has.
 */
function requireRollbackServices(
  run: { target: string; source: string; digest: string },
  plan: DeployPlan,
  record: PromotionRecord | undefined,
): boolean {
  const { target, source } = run;
  const before = [record?.previous, record].find((promotion) => promotion?.digest === run.digest);
  if (before === undefined) return false;
  const have = new Set(serviceNames(plan));
  const gone = before.services.filter((name) => !have.has(name));
  if (gone.length === 0) return true;
  const one = gone.length === 1;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${target}'s previous image ran with the ${one ? "service" : "services"} ${listText(gone)}, which ${target}'s plan no longer has, so rolling back would run that image without ${one ? "it" : "them"}. ${NOTHING}`,
    {
      hint: `Promote forward instead: once ${source} runs a fixed image, run \`opscrew promote --to ${target}\`.`,
    },
  );
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
  run: { target: string; command: string; services: string[] },
): Promise<PromoteResult | undefined> {
  const pending = await readPendingPromotion(paths);
  if (pending === undefined) return undefined;
  const { target, command, services } = run;
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
    services,
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
  /** A rollback this computer has no record of, so its image was not checked against the plan. */
  unchecked: boolean;
}): string {
  const { target, source, plan, chosen, build } = input;
  const url = plan.deployment.url;
  return [
    `Image: ${imageReference(input.image, chosen.digest)}`,
    chosen.rollback
      ? `  ${target}'s previous image (labelled opscrew-${target}-previous): a rollback`
      : `  the image ${source} runs (labelled opscrew-${source})`,
    ...(input.unchecked
      ? [
          `  OpsCrew has no record on this computer of what that image ran with, so it cannot check it against ${target}'s plan: a component removed since that image ran is not brought back`,
        ]
      : []),
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
 *    branch that builds the images the target is promoted with (`builderBranch`: the branch of the
 *    first environment along its sources that follows one, as its workflow's verify job checks), at
 *    the commit the image is tagged with (in the form of the environment that built it: `<commit>`
 *    for prod, `<commit>-<env>` for another). Its manifest, or one image of its index, is built for
 *    the target's CPU (`targetArch`).
 * 3. The target: provisioned; ready for the source's image (every service of the source's plan
 *    with the same settings, and every other shared part equal, FR-1539), or for a rollback still
 *    with every service its recorded previous promotion ran with (without that record, the approval
 *    says it was not checked); with nothing `opscrew provision` would apply (read-only drift); and
 *    the workflow on the default branch the one its plan generates (by git blob hash). Each
 *    promotion is recorded with the plan's services and the record it replaces.
 * 4. The `promote` approval, bound to {@link promotionHash} of both environments, the digest and
 *    the target plan's hash; never granted by `--yes`.
 * 5. The target's workflow, dispatched on the default branch with the digest and that commit tag
 *    (which its verify job checks again), and its run; the
 *    digest is recorded in the target's state once the run succeeded. With `supplyChain.sign`, the
 *    workflow's verify job checks the signature before its deploy job runs. A run that waits for
 *    a required reviewer of the target's GitHub environment is reported as waiting, with its link;
 *    one still waiting when the wait ends is the result `waiting`, recorded as the target's pending
 *    promotion, which the next `opscrew promote --to <target>` checks first ({@link checkPending}).
 * A site on a server-less target goes to `promoteSite` (a build's promotion on Cloudflare's
 * hosting, a rollback with `version` on either); `version` on a server is refused.
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

  // 0. The environments' plans (no network yet). A site on a server-less target has its own flow.
  const targetPaths = await resolveEnvironmentPaths(deps.paths.root, target, {
    env: { OPSCREW_HOME: deps.paths.homeDir },
    app: deps.paths.app,
  });
  const plan = await readArtifact("plan", targetPaths.files.plan);
  if (isServerlessProvider(plan.target.provider)) {
    return promoteSite(deps, { options, plan, paths: targetPaths });
  }
  if (options.version !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--version names a version of a site on Cloudflare's hosting or GitHub Pages, and the ${target} environment runs on a server, which deploys images. ${NOTHING}`,
      {
        hint: `To roll ${target} back to its previous image, run \`${command} --digest <digest>\` with that image's digest (labelled opscrew-${target}-previous).`,
      },
    );
  }
  if (requested !== undefined && !DIGEST.test(requested)) {
    throw new OpsCrewError("INVALID_INPUT", `"${requested}" is not an image digest.`, {
      hint: "Pass the digest as sha256: followed by 64 lower-case hexadecimal digits.",
    });
  }
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
  // The branch whose pushes build the images the target is promoted with, as its workflow's verify
  // job checks it (a promoted plan always has one: `builderBranch` stops otherwise).
  const branch = (await builderBranch(targetPaths, plan)) as string;
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${target} environment is not provisioned, so there is nowhere to deploy the image. ${NOTHING}`,
      { hint: provisionFirst },
    );
  }

  // 1. The image, and 2. where and for which CPU it was built.
  const github = await githubRepository(deps, services);
  const { owner, repo, defaultBranch } = github;
  const actions = `https://github.com/${owner}/${repo}/actions`;
  // OPSCREW_GHCR_READ_TOKEN when set (GHCR may refuse a fine-grained token), else the client's own.
  const credential = ghcrReadCredential(deps, owner);
  const image: AppImage = {
    github: github.api,
    owner,
    repo,
    key: plan.app.key,
    ...(credential !== undefined ? { credential } : {}),
  };
  const followed = await checkPending(deps, targetPaths, image, {
    target,
    command,
    services: serviceNames(plan),
  });
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
  const environments = await environmentsOf(deps.paths.root, deps.paths.app);
  // One read of GHCR's record of the image gives both its provenance and its CPUs.
  const facts = await imageFactsOf(image, digest);
  const build = await checkProvenance(image, digest, facts?.provenance, branch, environments);
  checkPlatform(image, digest, facts?.platforms, target, targetArch(plan.target));

  // 3. The target: ready for the source's image (for a rollback, still with the services its
  // previous image ran with), nothing pending, and the workflow on the default branch the one it
  // generates.
  let unchecked = false;
  if (chosen.rollback) {
    const record = await readPromotion(targetPaths);
    unchecked = !requireRollbackServices({ target, source, digest }, plan, record);
  } else {
    requireReady(target, source, sourcePlan, plan);
  }
  const workflowFile = await requireApplied(deps, {
    target,
    plan,
    paths: targetPaths,
    github,
    services,
    command,
  });

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
    unchecked,
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
    services: serviceNames(plan),
  });
  deps.reporter.success(`${target} now runs ${imageReference(image, digest)} (${run.htmlUrl}).`);
  return { status: "deployed", digest, runUrl: run.htmlUrl };
}
