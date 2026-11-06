/**
 * `--finish` and `--abort` of a site's move (plan.md "6."): after the switch the old host's site
 * goes (the Worker with OpsCrew's rules for its hostnames, or the GitHub Pages site); before it
 * the new host's site goes and the hostnames stay where they were. Each removal after the typed
 * app name, every plan approved by its hash.
 */
import { rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLOUDFLARE_TOKEN_PAGE } from "@opscrew/connector-cloudflare";
import type { ResourceChange } from "@opscrew/contracts";
import {
  isUserFacingError,
  lowerFirst,
  OpsCrewError,
  tfstateFile,
  toPosixRelative,
  upperFirst,
} from "@opscrew/core";
import {
  CLOUDFLARE_DEPLOY_SECRETS,
  deploySecretName,
  type RenderedFile,
  renderPagesVerification,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { confirmDeletion, type DeletionScope } from "../destroy/deletion";
import { applySharedRemoval, planSharedRemoval, removalDetails } from "../destroy/shared-rules";
import type { DestroyPreview } from "../destroy/types";
import { findSavedPlan, publishDeploySetup } from "../provision";
import { PAGES_ENVIRONMENT, pagesTeardownSteps, planPagesTeardown } from "../serverless/pages/plan";
import {
  pagesVerificationValue,
  verificationPage,
  verificationRecordName,
} from "../serverless/pages/verification";
import { describeChanges, trackedFiles, writeRenderedFiles } from "../shared";
import { reasonOf } from "../shared/errors";
import { runPhase } from "../shared/phase-status";
import { clearPending, type MoveAction } from "./pending";
import { applyInfraPlan, type InfraPlanInput, prepareInfraPlan } from "./plans";
import { auditStep, moveOf, recordApply, saveMove, savePlan, warnUnusedApproval } from "./session";
import { sitePrice } from "./site";
import {
  afterMove,
  appliesNow,
  beforeMove,
  hostWords,
  newSite,
  oldSite,
  openSiteSession,
  renderSiteFiles,
  type SiteSession,
  type SiteTarget,
  siteContext,
  sitePending,
} from "./site-session";
import {
  answers,
  customDomain,
  onlyChanges,
  pagesClient,
  pagesStep,
  proposeSiteSetup,
  workerRules,
} from "./site-steps";
import { ABORT_COMMAND, FINISH_ABORT_HINT, FINISH_COMMAND, RUN_COMMAND } from "./texts";
import type { AbortRetargetOptions, FinishRetargetOptions, RetargetResult } from "./types";

/** Where a removal happens, for the typed confirmation and its audit entry. */
function scopeOf(session: SiteSession, provider: DeletionScope["provider"]): DeletionScope {
  return {
    deps: session.deps,
    provider,
    app: session.plan.app.name,
    command: session.command,
    what: "move",
    phase: "retarget",
  };
}

/**
 * Writes `plan`'s files (its plain root), deletes the files only the move's root (the Worker's
 * shell beside GitHub Pages' records) or `other` (the other host's plan) had, and initialises the
 * engine for the root again. Returns the written files and the removed paths (repository-relative).
 */
async function writeHostFiles(
  session: SiteSession,
  plan: DeployPlan,
  other: DeployPlan,
): Promise<{ files: RenderedFile[]; removed: string[] }> {
  const { deps } = session;
  const files = await renderSiteFiles(session, plan);
  await writeRenderedFiles(deps.paths.root, files);
  const kept = new Set(files.map((file) => file.path));
  const before = [
    ...(await renderSiteFiles(session, session.plan, true)),
    ...(await renderSiteFiles(session, other)),
  ];
  const removed = [...new Set(before.map((file) => file.path))].filter((path) => !kept.has(path));
  const dirs = new Set<string>();
  for (const path of removed) {
    await rm(join(deps.paths.root, path), { force: true });
    dirs.add(dirname(path));
  }
  // Deepest first; a directory that still holds other files stays.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(join(deps.paths.root, dir)).catch(() => undefined);
  }
  await session.engine.init(session.dir, {
    env: session.env,
    backendConfig: { path: tfstateFile(deps.paths) },
  });
  return { files, removed };
}

/**
 * A plan of the site's root (`action`) towards `plan`'s plain root (its `files`, written), which
 * may change only what `allowed` lets through (`what` names the plan in a refusal): the Worker's
 * removal at `--finish`, or at `--abort` the hostnames put back on the old host (and the new Worker
 * removed). Prepared and checked; when it deletes anything, or with `rules` (OpsCrew's rules for
 * the Worker's hostnames, removed first), confirmed with the typed app name; then each applied
 * after its own approval. A non-interactive run stops with each hash in turn.
 */
async function rootPlan(
  session: SiteSession,
  input: {
    action: MoveAction;
    plan: DeployPlan;
    files: readonly RenderedFile[];
    what: string;
    allowed: (change: ResourceChange) => boolean;
    rules: boolean;
    confirm: ((preview: DestroyPreview) => Promise<boolean>) | undefined;
  },
): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const app = session.plan.app.name;
  const plan: InfraPlanInput = {
    action: input.action,
    files: input.files.filter((file) => file.kind === "infra"),
    deployPlan: input.plan,
    costDelta: null,
    check: onlyChanges(input.what, input.allowed),
  };
  const prepared = await prepareInfraPlan(session, plan);
  const removal = input.rules
    ? await planSharedRemoval(deps, input.plan, session.services, session.command)
    : undefined;
  const rules = removalDetails(removal);
  const saved =
    prepared.kind === "unchanged"
      ? undefined
      : await findSavedPlan(deps.paths.files.plansDir, prepared.planHash);
  const changes = saved?.changes ?? [];
  const deletes = changes.filter((change) => change.action === "delete");
  if (deletes.length > 0 || rules !== undefined) {
    deps.reporter.info(
      [
        `This changes the site on Cloudflare (${hostWords(input.plan.target as SiteTarget)} keeps ${input.plan.dns.domain}):`,
        ...describeChanges(changes),
        ...(rules === undefined ? [] : [rules]),
      ].join("\n"),
    );
    await confirmDeletion(
      scopeOf(session, "cloudflare-workers"),
      {
        name: app,
        provider: "cloudflare-workers",
        deleteProtection: false,
        resources: deletes,
        snapshot: false,
        ...(rules !== undefined ? { cloudflarePlan: rules } : {}),
      },
      input.confirm,
    );
  }
  const flags = deletes.length > 0 || rules !== undefined ? ["--confirm", app] : [];
  if (removal !== undefined) {
    // Without changes in the zone only the record is written: it lists no hostnames any more.
    const hash = removal.zone.plan.hash;
    if (rules !== undefined && !appliesNow(session, hash)) return sitePending(session, hash, flags);
    await applySharedRemoval(deps, input.plan, removal, {
      command: session.command,
      phase: "retarget",
    });
  }
  if (prepared.kind === "pending") return sitePending(session, prepared.planHash, flags);
  if (prepared.kind === "ready") {
    const applied = await applyInfraPlan(session, plan, prepared.planHash);
    await recordApply(session, { planHash: prepared.planHash, ...applied });
  }
  return undefined;
}

/** The changes of the site's root that touch the Worker, and those of GitHub Pages' records. */
const ofWorker = (change: ResourceChange) => change.address.startsWith("module.worker.");
const ofPages = (change: ResourceChange) => change.address.startsWith("module.dns.");

/**
 * The GitHub Pages site's removal: its custom domain (if it has one), the site and its
 * `github-pages` environment, in one Pages plan after the typed app name (`allowDestroy`). Its
 * DNS records went with the switch, or never existed. GitHub's verification record stays.
 */
async function removePages(
  session: SiteSession,
  confirm: ((preview: DestroyPreview) => Promise<boolean>) | undefined,
): Promise<RetargetResult | undefined> {
  const { deps, github } = session;
  const { owner, repo } = github;
  const pages = await pagesClient(session);
  const teardown = planPagesTeardown({
    owner,
    repo,
    site: await pages.getPages(owner, repo),
    environment: (await pages.getEnvironment(owner, repo, PAGES_ENVIRONMENT)) !== undefined,
  });
  if (teardown.steps.length === 0) {
    deps.reporter.info(`GitHub Pages is already off for ${owner}/${repo}.`);
    return undefined;
  }
  const steps = pagesTeardownSteps(teardown);
  deps.reporter.info(
    [
      `This changes the GitHub Pages site of ${owner}/${repo}:`,
      ...steps.map((s) => `  - ${s}`),
    ].join("\n"),
  );
  await confirmDeletion(
    scopeOf(session, "github-pages"),
    {
      name: session.plan.app.name,
      provider: "github-pages",
      deleteProtection: false,
      resources: [],
      snapshot: false,
      pagesChanges: steps,
    },
    confirm,
  );
  return pagesStep(session, pages, teardown);
}

/** The Cloudflare deploy secrets in GitHub that only a Worker's deploys use, by their names. */
function workerSecretsLeft(session: SiteSession, plan: DeployPlan): string {
  const names = Object.values(CLOUDFLARE_DEPLOY_SECRETS).map((name) =>
    deploySecretName(plan, name),
  );
  return `The GitHub secrets ${names.join(" and ")} of ${session.github.owner}/${session.github.repo}, which only the Worker's deploys used: delete them in the repository's settings (Secrets and variables → Actions), and the deploy token itself at ${CLOUDFLARE_TOKEN_PAGE} if no other app uses it.`;
}

/** GitHub's verification record, which a move keeps as `opscrew destroy` does. */
function verificationLeft(session: SiteSession, plan: DeployPlan): string {
  const domain = plan.dns.domain as string;
  return `GitHub's domain verification record ${verificationRecordName(session.github.owner, domain)} stays, so ${domain} stays verified for your GitHub account.`;
}

/**
 * GitHub's verification record's root as the move wrote it, from the value it recorded: a site
 * that moved to GitHub Pages commits it with its final files, as provision does.
 */
async function verificationFiles(session: SiteSession, plan: DeployPlan): Promise<RenderedFile[]> {
  const { deps, github } = session;
  const domain = plan.dns.domain as string;
  const value = await pagesVerificationValue(deps, {
    plan,
    domain,
    page: verificationPage(github.owner, (await github.api.account(github.owner)).type),
    given: undefined,
    ask: undefined,
    command: session.command,
  });
  const { plan: zoned, ctx } = await siteContext(session, plan);
  return renderPagesVerification(zoned, ctx, value);
}

/** Publishes the final files (and the plan) in a pull request; what to do next, in words. */
async function publishFinal(
  session: SiteSession,
  plan: DeployPlan,
  written: { files: readonly RenderedFile[]; removed: string[] },
  what: string,
): Promise<string> {
  const { deps } = session;
  const branch = plan.cicd.branch;
  const byHand = `commit the changed files under opscrew/ and open a pull request into ${branch} yourself, so the repository describes ${what}.`;
  try {
    const tracked = new Set(await trackedFiles(deps, written.removed));
    const published = await publishDeploySetup(deps, {
      git: session.git,
      github: session.github,
      plan,
      paths: [
        ...written.files.map((file) => file.path),
        toPosixRelative(deps.paths.root, deps.paths.files.plan),
        ...written.removed.filter((path) => tracked.has(path)),
      ],
      push: true,
      phase: "retarget",
    });
    return published.prUrl
      ? `Merge ${published.prUrl} so the repository describes ${what}.`
      : `Push the branch ${published.branch} and open a pull request into ${branch} so the repository describes ${what}.`;
  } catch (error) {
    const stopped = isUserFacingError(error) && error.code === "PHASE_PRECONDITION";
    deps.reporter.warn(
      deps.redactor.redact(
        stopped
          ? `The move is over, but ${lowerFirst(error.message)}`
          : `The move is over, but publishing the final files failed: ${reasonOf(error)}.`,
      ),
    );
    return upperFirst(byHand);
  }
}

async function finishSite(
  session: SiteSession,
  options: FinishRetargetOptions,
): Promise<RetargetResult> {
  const { deps } = session;
  const app = session.plan.app.name;
  const from = oldSite(session.plan);
  const fresh = hostWords(newSite(session.plan));
  const finalPlan = afterMove(session.plan);
  const fromWorker = from.provider === "cloudflare-workers";

  // 1. On the Worker, OpsCrew's rules in the zone cover its hostnames before the old site goes.
  if (!fromWorker) {
    const rules = await workerRules(session);
    if (rules !== undefined) return rules;
  }

  // 2. The final files, then the old host's site, after the typed name.
  const written = await writeHostFiles(session, finalPlan, beforeMove(session.plan));
  const stop = fromWorker
    ? await rootPlan(session, {
        action: "finish-destroy",
        plan: finalPlan,
        files: written.files,
        what: `plan that removes the Worker ${from.worker}`,
        allowed: (change) => change.action === "delete" && ofWorker(change),
        rules: true,
        confirm: options.confirm,
      })
    : await removePages(session, options.confirm);
  if (stop !== undefined) return stop;

  // 3. The plan without the move, and the final files in a pull request.
  await savePlan(session, finalPlan);
  await clearPending(deps);
  await deps.state.markPhase("retarget", "ok", `moved to ${fresh}`);
  const gone = fromWorker
    ? `the Worker ${from.worker} is deleted`
    : "the GitHub Pages site is turned off";
  await auditStep(session, "finished", `${gone}; the site runs on ${finalPlan.target.provider}`);
  deps.reporter.success(`The move of ${app} to ${fresh} is finished; ${gone}.`);
  const verification = fromWorker ? await verificationFiles(session, finalPlan) : [];
  const publish = await publishFinal(
    session,
    finalPlan,
    { files: [...written.files, ...verification], removed: written.removed },
    "the new deployment",
  );
  const remaining = fromWorker
    ? [
        workerSecretsLeft(session, finalPlan),
        "Run `opscrew provision` once GitHub has checked the DNS records: it asks GitHub for the site's certificate and enforces HTTPS once it is issued.",
      ]
    : [verificationLeft(session, finalPlan)];
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return { step: "finished", done: true, next: [publish, ...remaining] };
}

/**
 * `opscrew retarget --finish` for a site (only after the switch): the old host's site goes after
 * the typed app name (the Worker and OpsCrew's rules for its hostnames, or the GitHub Pages site,
 * whose verification record stays), the final files are written and published in a pull request,
 * and the move is cleared from `opscrew/plan.yaml`.
 */
export async function finishSiteMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: FinishRetargetOptions,
): Promise<RetargetResult> {
  const move = moveOf({ plan });
  if (move.abort !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The move is being aborted, so it cannot be finished. Nothing was changed.",
      { hint: FINISH_ABORT_HINT },
    );
  }
  if (move.step !== "switched") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The site's hostnames do not go to ${hostWords(newSite(plan))} yet, so the site on ${hostWords(oldSite(plan))} cannot be removed. Nothing was changed.`,
      { hint: `Run \`${RUN_COMMAND}\` to continue the move, or \`${ABORT_COMMAND}\` to undo it.` },
    );
  }
  return runPhase(deps, "retarget", async () => {
    const session = await openSiteSession(deps, plan, {
      command: FINISH_COMMAND,
      services: options.services ?? {},
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      ...(options.approvePlanHash !== undefined
        ? { approvePlanHash: options.approvePlanHash }
        : {}),
    });
    const result = await finishSite(session, options);
    warnUnusedApproval(session);
    return result;
  });
}

async function abortSite(
  session: SiteSession,
  options: AbortRetargetOptions,
): Promise<RetargetResult> {
  const { deps } = session;
  const app = session.plan.app.name;
  const from = oldSite(session.plan);
  const to = newSite(session.plan);
  const cost = await sitePrice(deps, session.plan, from.provider);
  if (cost === undefined) {
    deps.reporter.warn(
      `OpsCrew could not price ${hostWords(from)} again, so opscrew/plan.yaml keeps the cost of ${hostWords(to)}. Run \`opscrew design\` to refresh it.`,
    );
  }
  const plan = { ...beforeMove(session.plan), ...(cost !== undefined ? { cost } : {}) };

  // 1. The files as before the move, and the old root's plan: it changes nothing unless a switch
  // stopped part-way, and then it puts the hostnames back on the old host. To GitHub Pages, the
  // Worker's custom domains come back and GitHub Pages' records go; to the Worker, GitHub Pages'
  // records come back and the new Worker goes with the same plan.
  const written = await writeHostFiles(session, plan, afterMove(session.plan));
  const toWorker = to.provider === "cloudflare-workers";
  const restored = await rootPlan(session, {
    action: toWorker ? "abort-remove" : "abort-dns",
    plan,
    files: written.files,
    what: `plan that keeps ${plan.dns.domain} on ${hostWords(from)}`,
    allowed: (change) =>
      toWorker
        ? (change.action === "create" && ofPages(change)) ||
          (change.action === "delete" && ofWorker(change))
        : (change.action === "create" && customDomain(change.address)) ||
          (change.action === "delete" && ofPages(change)),
    rules: false,
    confirm: options.confirm,
  });
  if (restored !== undefined) return restored;

  // 2. The new GitHub Pages site, after the typed name, once no record points at it.
  if (!toWorker) {
    const stop = await removePages(session, options.confirm);
    if (stop !== undefined) return stop;
  }

  // 3. The plan as before the move, and the old host's deploy setup back on GitHub.
  await savePlan(session, plan);
  await clearPending(deps);
  await deps.state.markPhase("retarget", "skipped", `move to ${hostWords(to)} aborted`);
  await auditStep(session, "aborted", `the site stays on ${from.provider}`);
  const url = `https://${plan.dns.domain}/`;
  if (await answers(session, url)) {
    deps.reporter.success(`The move is aborted; ${app} stays on ${hostWords(from)}.`);
  } else {
    deps.reporter.warn(
      `The move is aborted and ${app} stays on ${hostWords(from)}, but the site does not answer at ${url} yet: a change of its DNS records can take a few minutes to reach this computer. \`opscrew verify\` checks it again.`,
    );
  }
  const proposal = await proposeSiteSetup(session, plan, written.removed).catch(
    (error: unknown) => {
      deps.reporter.warn(
        deps.redactor.redact(
          `The move is aborted, but OpsCrew could not propose the deploy setup back: ${reasonOf(error)}.`,
        ),
      );
      return { kind: "waiting" as const, branch: plan.cicd.branch, why: "" };
    },
  );
  const back =
    proposal.kind === "merged"
      ? `Pushes to ${plan.cicd.branch} deploy to ${hostWords(from)} again.`
      : proposal.kind === "proposed"
        ? `${proposal.merge}: it puts the deploy setup for ${hostWords(from)} back, so pushes deploy there again.`
        : `${proposal.why} Commit the deploy setup in this folder and merge it into ${proposal.branch}, so pushes deploy to ${hostWords(from)} again.`.trimStart();
  const remaining = [
    ...(to.provider === "github-pages" ? [verificationLeft(session, plan)] : []),
    ...(to.provider === "cloudflare-workers" ? [workerSecretsLeft(session, plan)] : []),
  ];
  return {
    step: "aborted",
    done: true,
    next: [back, ...remaining, `To move later, run \`${RUN_COMMAND} --to ${to.provider}\` again.`],
  };
}

/**
 * `opscrew retarget --abort` for a site (only before the switch is recorded): the old root's plan
 * puts the hostnames back on the old host when a switch stopped part-way (else it changes
 * nothing), the new host's site goes after the typed app name (the Worker's shell, or the GitHub
 * Pages site), the plan and its files are as before the move, the site is checked on its domain,
 * and the old host's deploy setup goes back on GitHub in a pull request. `retarget.abort` is
 * recorded first, so the move cannot continue meanwhile.
 */
export async function abortSiteMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: AbortRetargetOptions,
): Promise<RetargetResult> {
  const move = moveOf({ plan });
  if (move.step === "switched") {
    const from = oldSite(plan);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The site's hostnames already go to ${hostWords(newSite(plan))}, so the move can no longer be aborted. Nothing was changed.`,
      {
        hint: `To go back to ${hostWords(from)}, finish this move with \`${FINISH_COMMAND}\` and then move again with \`${RUN_COMMAND} --to ${from.provider}\`.`,
      },
    );
  }
  return runPhase(deps, "retarget", async () => {
    const session = await openSiteSession(deps, plan, {
      command: ABORT_COMMAND,
      services: options.services ?? {},
      ...(options.engine !== undefined ? { engine: options.engine } : {}),
      ...(options.approvePlanHash !== undefined
        ? { approvePlanHash: options.approvePlanHash }
        : {}),
    });
    if (move.abort === undefined) await saveMove(session, { ...move, abort: { step: "started" } });
    const result = await abortSite(session, options);
    warnUnusedApproval(session);
    return result;
  });
}
