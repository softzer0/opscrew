/**
 * The steps of a site's move (plan.md "6."): `deployed`, the new host provisioned without the
 * hostnames and its first deploy checked, and `switched`, the hostnames moved by one Cloudflare
 * plan. Every change goes through its approval bound to its hash.
 */
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import { type GitHubClient, githubConnector } from "@opscrew/connector-github";
import type { ApprovalRecord } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import {
  CLOUDFLARE_DEPLOY_SECRETS,
  pagesVerificationRootDir,
  renderPagesVerification,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { workflowBranch } from "../environments/branches";
import {
  deploySecretsStoredFor,
  findSavedPlan,
  planAndApply,
  publishDeploySetup,
} from "../provision";
import { missing } from "../provision/credentials";
import {
  applySharedCloudflare,
  cloudflarePlanHashes,
  planSharedCloudflare,
  sharedCloudflareClient,
} from "../provision/shared-cloudflare";
import {
  requireFreeHostnames,
  requireOwnWorker,
  requireWorkersTokens,
} from "../serverless/cloudflare/checks";
import {
  pagesHostnames,
  requireCaaAllowsLetsEncrypt,
  requirePagesAllowed,
} from "../serverless/pages/checks";
import {
  type PagesPlan,
  pagesPlanDeletes,
  pagesPlanHash,
  planPages,
} from "../serverless/pages/plan";
import { VERIFICATION_PLAN_SUFFIX } from "../serverless/pages/provision";
import { pagesPlanStep } from "../serverless/pages/step";
import {
  pagesVerificationValue,
  verificationPage,
  verifyStepNote,
} from "../serverless/pages/verification";
import { storeSiteSecrets } from "../serverless/shared";
import {
  approvalEntry,
  githubClientFromToken,
  pagesVerificationStateFile,
  pollUntil,
  trackedFiles,
  writeRenderedFiles,
} from "../shared";
import { codeOf, hintOf, reasonOf } from "../shared/errors";
import { runningVersions, versionBuild } from "../status/site";
import { planBounded, planThenApply } from "./plans";
import { auditMove, auditStep, moveOf, recordApply, saveMove, savePlan, waitsOf } from "./session";
import {
  hostWords,
  movingWorker,
  newSite,
  oldSite,
  pagesAddress,
  renderSiteFiles,
  type SiteSession,
  siteContext,
  useSiteRoot,
} from "./site-session";
import { appliesNow, fileOnGitHub, normalised, pendingStop } from "./steps";
import { ABORT_COMMAND, FINISH_COMMAND, RUN_COMMAND } from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";

const WORKFLOW_WAIT_MS = 30 * 60_000;
/** How long a site may take to answer: GitHub Pages' deploy, or DNS reaching this computer. */
const ANSWER_WAIT_MS = 10 * 60_000;
const ANSWER_POLL_MS = 15_000;

/** The `--confirm <app>` a scripted run repeats with a plan that takes the hostnames away. */
function confirmFlags(session: SiteSession): string[] {
  return ["--confirm", session.plan.app.name];
}

/** Adds this run's approval to `opscrew/plan.yaml`'s approvals right away. */
async function recordApproval(session: SiteSession, approval: ApprovalRecord): Promise<void> {
  const { plan } = session;
  await savePlan(session, { ...plan, approvals: [...plan.approvals, approvalEntry(approval)] });
}

/** The GitHub client with the user's token, which changes the repository's GitHub Pages site. */
export async function pagesClient(session: SiteSession): Promise<GitHubClient> {
  const pages = await githubClientFromToken(session.deps);
  if (pages === undefined) {
    throw missing(
      "GitHub",
      githubConnector({ token: undefined, fetch: session.deps.fetch }).credentials,
    );
  }
  return pages;
}

/**
 * A Pages plan shown and, when this run applies it ({@link appliesNow}), approved by its hash
 * (`pages-apply`, with the typed app name when it takes a domain away) and applied; a
 * non-interactive run without its hash stops with it.
 */
export async function pagesStep(
  session: SiteSession,
  api: GitHubClient,
  plan: PagesPlan,
): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const hash = pagesPlanHash(plan);
  const now = plan.steps.length > 0 && appliesNow(session, hash);
  const step = await pagesPlanStep(deps, {
    api,
    plan,
    planOnly: plan.steps.length > 0 && !now,
    command: session.command,
    app: session.plan.app.name,
  });
  if (plan.steps.length > 0 && !now) {
    return pendingStop(session, hash, pagesPlanDeletes(plan) ? confirmFlags(session) : []);
  }
  if (step.approval !== undefined) await recordApproval(session, step.approval);
  return undefined;
}

/**
 * The {@link planBounded} words of a site step's plan (`what`), whose state moves pass: the step
 * passes its own changes, and nothing else.
 */
export function siteBounds(what: string): {
  lead: string;
  move: () => true;
  hint: string;
} {
  return {
    lead: `The ${what} would change more than it should, so OpsCrew stopped. Nothing was changed.`,
    move: () => true,
    hint: `The infrastructure no longer matches what OpsCrew applied. Run \`${ABORT_COMMAND}\` to undo the move, then \`opscrew drift\` to see the differences, and start the move again.`,
  };
}

/** True for a change of the Worker's custom domains. */
export const customDomain = (address: string) =>
  address.startsWith("module.worker.cloudflare_workers_custom_domain.");

/**
 * GitHub Pages as the new host, before its hostnames: the checks (GitHub allows Pages, CAA
 * records, the verification record's value), the Pages plan that turns the site on without a
 * custom domain, GitHub's verification record (its own root and state) and the app's values for
 * its build.
 */
async function preparePages(
  session: SiteSession,
  options: Pick<RetargetOptions, "pagesVerification">,
): Promise<RetargetResult | undefined> {
  const { deps, plan, github, cloudflare, services, command } = session;
  const { owner, repo } = github;
  const domain = plan.dns.domain as string;
  const pages = await pagesClient(session);
  await requirePagesAllowed(deps, pages, github);
  const api = services.cloudflare ?? cloudflareConnector(deps).client;
  if (!api) throw missing("Cloudflare", cloudflareConnector(deps).credentials);
  await requireCaaAllowsLetsEncrypt(deps, {
    api,
    zoneId: cloudflare.zoneId,
    zone: cloudflare.zoneName,
    hostnames: pagesHostnames({ domain, www: plan.dns.www }),
    command,
  });
  const page = verificationPage(owner, (await github.api.account(owner)).type);
  const verification = await pagesVerificationValue(deps, {
    plan,
    domain,
    page,
    given: options.pagesVerification,
    ask: services.askPagesVerification,
    command,
  });

  // The site, published by the workflow, with no custom domain until the switch.
  const site = planPages({
    owner,
    repo,
    site: await pages.getPages(owner, repo),
    savedAgain: false,
  });
  const stop = await pagesStep(session, pages, site);
  if (stop !== undefined) return stop;

  // GitHub's verification record: a root and state of its own, as provision keeps it.
  const { plan: zoned, ctx } = await siteContext(session, plan);
  const files = renderPagesVerification(zoned, ctx, verification);
  await writeRenderedFiles(deps.paths.root, files);
  const named =
    session.approve === undefined
      ? undefined
      : await findSavedPlan(deps.paths.files.plansDir, session.approve);
  const approved =
    named !== undefined &&
    named.appliedAt === undefined &&
    named.planFile.endsWith(VERIFICATION_PLAN_SUFFIX)
      ? named.planHash
      : undefined;
  if (approved !== undefined) session.approve = undefined;
  const record = await planAndApply(deps, {
    engine: session.engine,
    dir: join(deps.paths.root, pagesVerificationRootDir(plan)),
    env: session.env,
    deployPlan: plan,
    files,
    command,
    phase: "retarget",
    costDelta: null,
    statePath: pagesVerificationStateFile(deps.paths),
    planSuffix: VERIFICATION_PLAN_SUFFIX,
    planNoun: "plan of GitHub's verification record",
    approvalTitle: `Apply the infrastructure plan on Cloudflare: GitHub's domain verification record for ${domain}`,
    ...(approved !== undefined
      ? { approvePlanHash: approved }
      : deps.interactive
        ? {}
        : { planOnly: true }),
  });
  const waits =
    approved === undefined && !deps.interactive && (record.plan?.changes.length ?? 0) > 0;
  if (waits && record.planHash !== undefined) return pendingStop(session, record.planHash);
  if (record.approval !== undefined) await recordApproval(session, record.approval);
  if (record.applied) deps.reporter.info(verifyStepNote({ owner, domain, page }));

  // The app's values for its build; a site without values has none. The Worker's deploy secrets
  // stay: it deploys with them again after an abort.
  const where = { host: plan.target.provider, owner, repo };
  if (plan.app.env.length > 0 && !(await deploySecretsStoredFor(deps, plan, where))) {
    await storeSiteSecrets(deps, {
      github,
      plan,
      services,
      store: true,
      keep: Object.values(CLOUDFLARE_DEPLOY_SECRETS),
      done: "GitHub Pages is on for the site, without its custom domain; its build gets none of the app's values yet.",
    });
  }
  return undefined;
}

/**
 * Cloudflare's hosting as the new host, before its hostnames: the tokens, the Worker's name and
 * the hostnames' records checked, the Worker created without custom domains beside GitHub Pages'
 * records (one infrastructure plan), and its deploy secrets.
 */
async function prepareWorker(session: SiteSession): Promise<RetargetResult | undefined> {
  const { deps, plan, github, cloudflare, services, command } = session;
  const target = movingWorker(plan);
  const client = sharedCloudflareClient(deps, services);
  const where = { host: plan.target.provider, owner: github.owner, repo: github.repo };
  const stored = await deploySecretsStoredFor(deps, plan, where);
  const deployToken = await requireWorkersTokens(deps, {
    client,
    cloudflare,
    deployToken: !stored,
    command,
  });
  const { accountId } = cloudflare;
  await requireOwnWorker(deps, {
    client,
    accountId,
    plan,
    target,
    engine: session.engine,
    env: session.env,
    command,
  });
  await requireFreeHostnames(deps, {
    client,
    accountId,
    plan,
    worker: target.worker,
    foreign: cloudflare.foreignRecords,
    command,
  });

  const files = await useSiteRoot(session, true);
  const step = await planThenApply(session, {
    action: "create",
    files,
    costDelta: null,
    notes: ["The Worker gets no custom domains yet: GitHub Pages keeps serving the hostnames."],
    check: planBounded({
      ...siteBounds("plan of the new Worker"),
      change: (change) =>
        change.action === "create" &&
        change.address.startsWith("module.worker.") &&
        !customDomain(change.address),
    }),
  });
  if (step.kind === "pending") return pendingStop(session, step.planHash);
  if (step.kind === "applied") await recordApply(session, step);

  if (deployToken !== undefined) {
    await storeSiteSecrets(deps, {
      github,
      plan,
      services,
      store: true,
      deploy: {
        [CLOUDFLARE_DEPLOY_SECRETS.apiToken]: deployToken,
        [CLOUDFLARE_DEPLOY_SECRETS.accountId]: accountId,
      },
      done: `The Worker ${target.worker} is created, without custom domains; its deploy secrets are not stored yet.`,
    });
  }
  return undefined;
}

/** Where a site host's deploy setup stands on GitHub's deploy branch. */
export type SetupProposal =
  | { kind: "merged" }
  | { kind: "proposed"; merge: string; branch: string }
  | { kind: "waiting"; why: string; branch: string };

/**
 * Proposes `plan`'s deploy setup (its workflow, and on Cloudflare the Worker's settings) in a pull
 * request unless GitHub's deploy branch holds it already, without the `removed` files (deleted
 * here, and in the pull request when git tracks them): `merged` then. `waiting` when an earlier
 * run's pull request is in the way.
 */
export async function proposeSiteSetup(
  session: SiteSession,
  plan: DeployPlan,
  removed: readonly string[] = [],
): Promise<SetupProposal> {
  const { deps, github } = session;
  const files = (await renderSiteFiles(session, plan)).filter((file) => file.kind !== "infra");
  const branch = workflowBranch(plan, github.defaultBranch);
  let merged = true;
  for (const file of files) {
    const committed = await fileOnGitHub(session, branch, file.path);
    if (committed === undefined || normalised(committed) !== normalised(file.content)) {
      merged = false;
      break;
    }
  }
  for (const path of removed) {
    if (!merged) break;
    if ((await fileOnGitHub(session, branch, path)) !== undefined) merged = false;
  }
  if (merged) return { kind: "merged" };
  deps.reporter.step(`Proposing the deploy setup for ${hostWords(newSite(plan))} on GitHub`);
  await writeRenderedFiles(deps.paths.root, files);
  for (const path of removed) await rm(join(deps.paths.root, path), { force: true });
  const tracked = new Set(await trackedFiles(deps, removed));
  try {
    const published = await publishDeploySetup(deps, {
      git: session.git,
      github,
      plan,
      paths: [...files.map((file) => file.path), ...removed.filter((path) => tracked.has(path))],
      push: true,
      phase: "retarget",
    });
    return {
      kind: "proposed",
      branch,
      merge: published.prUrl
        ? `Merge ${published.prUrl}`
        : `Push the branch ${published.branch} and merge it into ${branch}`,
    };
  } catch (error) {
    if (!(isUserFacingError(error) && error.code === "PHASE_PRECONDITION")) throw error;
    const hint = error.hint === undefined ? "" : ` ${error.hint}`;
    return { kind: "waiting", branch, why: deps.redactor.redact(`${error.message}${hint}`) };
  }
}

/**
 * Until the new host's deploy setup is on GitHub's deploy branch, it goes into a pull request and
 * the move stops; the next run continues once it is merged.
 */
async function deploySetupStop(session: SiteSession): Promise<RetargetResult | undefined> {
  const { plan } = session;
  const proposal = await proposeSiteSetup(session, plan);
  if (proposal.kind === "merged") return undefined;
  const fresh = hostWords(newSite(plan));
  const differs = `The deploy setup for ${fresh} is not on ${proposal.branch} yet`;
  return {
    step: moveOf(session).step,
    done: false,
    next:
      proposal.kind === "waiting"
        ? [
            `${differs}, and it is not merged yet: ${proposal.why}`,
            `Once it is merged, run \`${RUN_COMMAND}\` again to deploy the site there and continue the move.`,
          ]
        : [
            `${differs}. ${proposal.merge}: once it is merged, every push deploys to ${fresh}, while ${hostWords(oldSite(plan))} keeps serving the site until the switch.`,
            `Then run \`${RUN_COMMAND}\` again to deploy the site there and continue the move (\`${ABORT_COMMAND}\` undoes it).`,
          ],
  };
}

/** Dispatches the deploy workflow on the plan's branch and waits for it to succeed; its run id. */
async function runSiteWorkflow(session: SiteSession): Promise<number> {
  const { deps, plan, githubApi } = session;
  const { owner, repo } = session.github;
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const branch = plan.cicd.branch;
  const fresh = hostWords(newSite(plan));
  const oldStill = `${hostWords(oldSite(plan))} still serves the site.`;
  deps.reporter.step(`Running the deploy workflow (${workflowFile} on ${branch}) for ${fresh}`);
  let run: Awaited<ReturnType<typeof githubApi.waitForWorkflowRun>>;
  try {
    // Recorded as soon as GitHub accepts the dispatch, before any wait for its run.
    const { runId } = await githubApi.dispatchWorkflow(owner, repo, workflowFile, branch, {}, () =>
      auditMove(session, {
        kind: "provider-call",
        action: "dispatch workflow",
        target: `${owner}/${repo}`,
        detail: `${workflowFile} on ${branch}`,
      }),
    );
    run = await githubApi.waitForWorkflowRun(owner, repo, {
      workflowFile,
      ref: branch,
      runId,
      timeoutMs: WORKFLOW_WAIT_MS,
    });
  } catch (error) {
    throw new OpsCrewError(
      codeOf(error),
      deps.redactor.redact(`Running the deploy workflow failed: ${reasonOf(error)}. ${oldStill}`),
      {
        hint: `${hintOf(error)}Check the workflow in your repository's Actions tab, then run \`${RUN_COMMAND}\` again, or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }
  const ok = run.conclusion === "success";
  await auditMove(session, {
    kind: "provider-call",
    action: "deploy workflow",
    target: run.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${run.id} finished: ${run.conclusion ?? "no result"}`,
  });
  if (!ok) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The deploy workflow did not succeed (${run.conclusion ?? "no result"}): ${run.htmlUrl}. ${oldStill} Nothing else changed.`,
      {
        hint: `Open the run to see what failed and push a fix (deploys now go to ${fresh}), then run \`${RUN_COMMAND}\` again. To go back instead, run \`${ABORT_COMMAND}\`.`,
      },
    );
  }
  deps.reporter.success(`The deploy workflow succeeded (${run.htmlUrl}).`);
  return run.id;
}

/** Polls `url` until it answers with a success status; false when it never did in time. */
export async function answers(session: SiteSession, url: string): Promise<boolean> {
  const answered = await pollUntil(
    async () => {
      try {
        const response = await session.deps.fetch(url, { method: "GET", redirect: "follow" });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    { timeoutMs: ANSWER_WAIT_MS, intervalMs: ANSWER_POLL_MS, ...waitsOf(session.services) },
  );
  return answered === true;
}

/**
 * The new host's first deploy, checked before the switch: on Cloudflare the Worker runs the build
 * of `runId` (the active deployment's version names its run, through Cloudflare's API); GitHub
 * Pages answers on its own address. Stops (`PHASE_PRECONDITION`) otherwise; the old host still
 * serves the site.
 */
async function checkFirstDeploy(session: SiteSession, runId: number): Promise<void> {
  const { deps, plan, cloudflare } = session;
  const target = newSite(plan);
  const oldStill = `${hostWords(oldSite(plan))} still serves the site.`;
  const again = `Run \`${RUN_COMMAND}\` again once it does, or \`${ABORT_COMMAND}\` to undo the move.`;
  if (target.provider === "cloudflare-workers") {
    const client = sharedCloudflareClient(deps, session.services);
    const { accountId } = cloudflare;
    const { running } = runningVersions(
      (await client.listWorkerDeployments(accountId, target.worker)) ?? [],
    );
    const versions = (await client.listWorkerVersions(accountId, target.worker)) ?? [];
    const build = versionBuild(versions.find((version) => version.id === running?.versionId));
    if (build?.runId !== runId) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The Worker ${target.worker} does not run the build of the deploy workflow's run ${runId}. ${oldStill}`,
        { hint: `Check the run's deploy job in your repository's Actions tab. ${again}` },
      );
    }
    deps.reporter.success(`The Worker ${target.worker} runs the new build.`);
    return;
  }
  const url = pagesAddress(session.github.owner, session.github.repo);
  deps.reporter.step(`Checking the site at ${url}`);
  if (!(await answers(session, url))) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Pages does not answer at ${url} after the deploy. ${oldStill}`,
      { hint: `Check the run's deploy job in your repository's Actions tab. ${again}` },
    );
  }
  deps.reporter.success(`GitHub Pages serves the site at ${url}.`);
}

/**
 * Step 2 of a site's move: the new host provisioned without the hostnames, its deploy setup
 * merged (a pull request first), its deploy workflow run and its first deploy checked; then
 * `deployed`. The old host keeps serving the site.
 */
export async function siteDeployStep(
  session: SiteSession,
  options: Pick<RetargetOptions, "pagesVerification">,
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const fresh = hostWords(newSite(plan));
  const prepared =
    plan.target.provider === "github-pages"
      ? await preparePages(session, options)
      : await prepareWorker(session);
  if (prepared !== undefined) return prepared;
  const setup = await deploySetupStop(session);
  if (setup !== undefined) return setup;
  const runId = await runSiteWorkflow(session);
  await checkFirstDeploy(session, runId);
  await saveMove(session, { ...moveOf(session), step: "deployed" });
  deps.reporter.success(`The site runs on ${fresh}; ${hostWords(oldSite(plan))} still serves it.`);
  await auditStep(session, "deployed", `site deployed and checked on ${plan.target.provider}`);
  return undefined;
}

/**
 * Step 3 of a site's move: the hostnames move to the new host. To GitHub Pages, the Pages plan sets
 * the custom domain first (so no record points at GitHub while no site claims it), then one
 * Cloudflare plan deletes the Worker's custom domains and creates GitHub Pages' records; to the
 * Worker, one Cloudflare plan deletes GitHub Pages' records and creates its custom domains. Each
 * plan deletes, so it is approved with `allowDestroy` and the typed app name; the site is
 * unreachable for the seconds between the deletes and the creates.
 */
export async function siteSwitchStep(session: SiteSession): Promise<RetargetResult | undefined> {
  const { deps, plan, github } = session;
  const domain = plan.dns.domain as string;
  const toPages = plan.target.provider === "github-pages";
  if (toPages) {
    const pages = await pagesClient(session);
    const site = planPages({
      owner: github.owner,
      repo: github.repo,
      site: await pages.getPages(github.owner, github.repo),
      cname: domain,
      savedAgain: false,
    });
    const stop = await pagesStep(session, pages, site);
    if (stop !== undefined) return stop;
  }
  // To GitHub Pages: the Worker's shell beside the records; to the Worker: its plain root.
  const files = await useSiteRoot(session, toPages);
  const step = await planThenApply(session, {
    action: "switch",
    files,
    costDelta: null,
    notes: [
      `The plan moves ${domain} from ${hostWords(oldSite(plan))} to ${hostWords(newSite(plan))}: the site is unreachable for the seconds between the deletes and the creates.`,
    ],
    check: planBounded({
      ...siteBounds("switch plan"),
      change: (change) =>
        toPages
          ? (change.action === "delete" && customDomain(change.address)) ||
            (change.action === "create" && change.address.startsWith("module.dns."))
          : (change.action === "delete" && change.address.startsWith("module.dns.")) ||
            (change.action === "create" && customDomain(change.address)),
    }),
  });
  if (step.kind === "pending") return pendingStop(session, step.planHash, confirmFlags(session));
  if (step.kind === "applied") await recordApply(session, step);
  await saveMove(session, { ...moveOf(session), step: "switched" });
  deps.reporter.success(`${domain} now goes to ${hostWords(newSite(plan))}.`);
  await auditStep(session, "switched", `${domain} moved to ${plan.target.provider}`);
  return undefined;
}

/** On the Worker, OpsCrew's rules in the zone for its hostnames (a Cloudflare plan). */
export async function workerRules(session: SiteSession): Promise<RetargetResult | undefined> {
  const { deps, plan, services, cloudflare, command } = session;
  const shared = await planSharedCloudflare(deps, {
    services: { sharedCloudflare: sharedCloudflareClient(deps, services) },
    plan,
    cloudflare,
    command,
    tls: { minTls: true },
  });
  const hash = cloudflarePlanHashes(shared)[0];
  if (shared === undefined || hash === undefined) return undefined;
  const changes = [shared.leave, shared.main].some((zone) => (zone?.plan.changes.length ?? 0) > 0);
  const now = changes && appliesNow(session, hash);
  const applied = await applySharedCloudflare(deps, shared, {
    app: plan.app.name,
    command,
    phase: "retarget",
    planOnly: !now,
  });
  if (changes && !now) {
    return pendingStop(
      session,
      hash,
      applied.fields.cloudflarePlanDeletes ? confirmFlags(session) : [],
    );
  }
  for (const approval of applied.approvals) await recordApproval(session, approval);
  return undefined;
}

/**
 * After the switch: on the Worker, OpsCrew's rules in the zone; then the site checked on its
 * domain (over HTTPS on the Worker; over HTTP on GitHub Pages, whose certificate comes later),
 * and what is left to do.
 */
export async function siteSwitched(session: SiteSession): Promise<RetargetResult> {
  const { deps, plan } = session;
  const domain = plan.dns.domain as string;
  const toPages = plan.target.provider === "github-pages";
  if (!toPages) {
    const stop = await workerRules(session);
    if (stop !== undefined) return stop;
  }
  const url = `${toPages ? "http" : "https"}://${domain}/`;
  deps.reporter.step(`Checking the site at ${url}`);
  if (!(await answers(session, url))) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The site does not answer at ${url} yet: the change of its DNS records can take a few minutes to reach this computer.`,
      {
        hint: `Run \`${RUN_COMMAND}\` again in a few minutes to check again. Once the site answers, \`${FINISH_COMMAND}\` removes the site on ${hostWords(oldSite(plan))}.`,
      },
    );
  }
  deps.reporter.success(`${hostWords(newSite(plan))} serves ${domain}.`);
  return {
    step: "switched",
    done: true,
    next: [
      `Run \`${FINISH_COMMAND}\` to remove the site on ${hostWords(oldSite(plan))} and publish the final files.`,
      ...(toPages
        ? [
            `GitHub issues the certificate for ${domain} once it has checked the records, which can take an hour or more; until then the site answers over HTTP only. After the finish, run \`opscrew provision\`: it asks GitHub for the certificate and enforces HTTPS once it is issued.`,
          ]
        : []),
    ],
  };
}
