/**
 * `opscrew retarget` for a site (FR-2304, plan.md "6."): between Cloudflare's hosting and GitHub
 * Pages, wherever design offers the new host for the app, in the steps `started`, `deployed` and
 * `switched`. A site has no data, so there is no maintenance window.
 */
import { formatMoney, OpsCrewError } from "@opscrew/core";
import { detectSite, type SiteDetection } from "@opscrew/detect";
import {
  type DeployPlan,
  environmentsOf,
  isServerlessProvider,
  type Requirements,
  type Retarget,
  readArtifact,
  type ServerlessProvider,
} from "@opscrew/plan-schema";
import { requireOnePagesSite } from "../apps/names";
import type { PhaseDeps } from "../context";
import {
  buildServerlessOption,
  type PagesAnswer,
  pagesAllowedFor,
  requireServerlessFit,
  serverlessTargetFor,
} from "../design/serverless";
import { readRequirements } from "../provision";
import { hasDeployment } from "../shared";
import { auditStep, moveOf, saveMove, warnUnusedApproval } from "./session";
import {
  hostWords,
  newSite,
  oldSite,
  onSiteHost,
  openSiteSession,
  pagesAddress,
  type SiteSession,
  type SiteTarget,
} from "./site-session";
import { pagesClient, siteDeployStep, siteSwitched, siteSwitchStep } from "./site-steps";
import { nothingLive, requireRequirements, siteServerNoMove } from "./start";
import { ABORT_COMMAND, FINISH_ABORT_HINT, FINISH_COMMAND, RUN_COMMAND } from "./texts";
import type { RetargetOptions, RetargetResult, RetargetSummary } from "./types";

/** The new site's target and its price, as design offers that host for the app. */
interface NewSite {
  target: SiteTarget;
  cost: DeployPlan["cost"];
}

/** The site on `provider` as design writes it, with its price; it keeps its Node.js version. */
function sitePriced(
  plan: DeployPlan,
  provider: ServerlessProvider,
  inputs: { site: SiteDetection; requirements: Requirements; pages?: PagesAnswer },
): NewSite {
  const { nodeVersion } = (plan.retarget === undefined ? newSite(plan) : oldSite(plan)).site;
  const choice = {
    provider,
    site: inputs.site,
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
  };
  const option = buildServerlessOption({
    choice,
    requirements: inputs.requirements,
    externalServices: [],
    ...(inputs.pages === undefined ? {} : { pages: inputs.pages }),
  });
  return { target: serverlessTargetFor(choice, plan.app.name), cost: option.cost };
}

/**
 * The site's target and price on `provider`, as design offers it: refused plainly
 * (`requireServerlessFit`) when that host does not fit the app (server rendering on GitHub Pages,
 * a private repository whose plan has no Pages, …).
 */
async function siteOn(
  deps: PhaseDeps,
  plan: DeployPlan,
  provider: ServerlessProvider,
): Promise<NewSite> {
  const requirements = await requireRequirements(deps);
  const facts = (await readArtifact("architecture", deps.paths.files.architecture)).facts;
  const site = await detectSite(deps.paths.root, facts);
  const pages = provider === "github-pages" ? await pagesAllowedFor(deps, facts) : undefined;
  requireServerlessFit(provider, facts, site, requirements, pages);
  return sitePriced(plan, provider, { site, requirements, ...(pages ? { pages } : {}) });
}

/**
 * The site's price on `provider` again (an abort's old host), `undefined` when OpsCrew no longer
 * finds the site or the interview's answers.
 */
export async function sitePrice(
  deps: PhaseDeps,
  plan: DeployPlan,
  provider: ServerlessProvider,
): Promise<DeployPlan["cost"] | undefined> {
  const requirements = await readRequirements(deps);
  if (requirements === undefined) return undefined;
  const facts = (await readArtifact("architecture", deps.paths.files.architecture)).facts;
  const site = await detectSite(deps.paths.root, facts);
  if (site === undefined) return undefined;
  return sitePriced(plan, provider, { site, requirements }).cost;
}

/**
 * The refusals of a move to GitHub Pages, before any change: it publishes one site per
 * repository, prod's (another app's or environment's there already is refused), and an app's
 * environments all run on prod's host, so a site moves there only as its app's only environment;
 * `www` works there only at the zone's apex.
 */
async function requirePagesMove(deps: PhaseDeps, plan: DeployPlan): Promise<void> {
  const name = deps.paths.environment;
  if (name !== "prod") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `GitHub Pages publishes one site per repository, and prod is that site, so the ${name} environment cannot move there. Nothing was changed.`,
      { hint: "Keep it on Cloudflare's hosting, where each environment has its own Worker." },
    );
  }
  const others = (await environmentsOf(deps.paths.root, deps.paths.app)).filter(
    (environment) => environment !== name,
  );
  if (others.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.app.name} has other environments (${others.join(", ")}), and GitHub Pages publishes only prod: they would stay on Cloudflare's hosting while prod moves. Nothing was changed.`,
      {
        hint: `Remove them first (\`opscrew destroy --env <name>\`, then \`opscrew env remove <name>\`), then run \`${RUN_COMMAND} --to github-pages\` again.`,
      },
    );
  }
  await requireOnePagesSite(deps.paths, {
    ...(deps.paths.app !== undefined ? { app: deps.paths.app } : {}),
    environment: name,
    plan,
  });
  const { domain, zone, www } = plan.dns;
  if (www && domain !== zone) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.app.name} also serves www.${domain}, and GitHub Pages redirects between www and the domain only at the zone's apex (${zone}). Nothing was changed.`,
      {
        hint: `Turn www off for the site first (dns.www in opscrew/plan.yaml, then \`opscrew provision\`), then run \`${RUN_COMMAND} --to github-pages\` again.`,
      },
    );
  }
}

/**
 * Refuses a move to GitHub Pages while the repository has a GitHub Pages site already: the move
 * turns on a site of its own, which an abort removes, so it never takes over one it did not make.
 */
async function requireNoPagesSite(session: SiteSession): Promise<void> {
  const { owner, repo } = session.github;
  if ((await (await pagesClient(session)).getPages(owner, repo)) === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `GitHub Pages is already on for ${owner}/${repo}, and a move to GitHub Pages turns on a site of its own. Nothing was changed.`,
    {
      hint: `Turn it off in the repository's settings (Settings → Pages) if nothing needs it, or set this app up there with \`opscrew interview\`, \`opscrew design\` and \`opscrew provision\` instead; then run \`${RUN_COMMAND} --to github-pages\` again if you still want to move.`,
    },
  );
}

/** The summary of a site's move, shown before anything changes. */
function siteSummary(
  plan: DeployPlan,
  next: NewSite,
  owner: string,
  repo: string,
): RetargetSummary {
  const from = newSite(plan);
  const to = next.target;
  const domain = plan.dns.domain as string;
  const old = hostWords(from);
  const toPages = to.provider === "github-pages";
  const prepare =
    to.provider === "cloudflare-workers"
      ? `Create the Worker ${to.worker} without custom domains (an infrastructure plan you approve by its hash) and store its deploy secrets in GitHub.`
      : `Turn GitHub Pages on for ${owner}/${repo} without a custom domain (a Pages plan you approve by its hash), store the app's values for its build, and create GitHub's verification record for ${domain} (an infrastructure plan).`;
  const check = toPages
    ? `the site at ${pagesAddress(owner, repo)}`
    : "that the Worker runs that build (through Cloudflare's API)";
  const switched = toPages
    ? `Switch ${domain} to GitHub Pages: the Pages plan sets the custom domain first, then one Cloudflare plan you approve by its hash and the app's name deletes the Worker's custom domains and creates GitHub Pages' DNS records. The site is unreachable for the seconds between the two. GitHub then issues its certificate, which can take an hour or more: until then the site answers over HTTP only, and browsers that visited it on Cloudflare (whose answers carried OpsCrew's HSTS header) refuse HTTP, so for them it stays unreachable.`
    : `Switch ${domain} to the Worker: one Cloudflare plan you approve by its hash and the app's name deletes GitHub Pages' DNS records and creates the Worker's custom domains, with their certificates. The site is unreachable for the seconds between the two. Then OpsCrew's rules in your zone cover the Worker's hostnames (a Cloudflare plan).`;
  return {
    from,
    to,
    steps: [
      prepare,
      `Open a pull request with the deploy workflow for ${hostWords(to)}; once you merge it, OpsCrew runs it and checks ${check}, while ${old} still serves ${domain}.`,
      "No maintenance window: a site has no data to copy.",
      switched,
      `Keep the site on ${old} until \`${FINISH_COMMAND}\` removes it; until the switch, \`${ABORT_COMMAND}\` undoes the move.`,
    ],
    extraMonthly: next.cost.monthly,
    data: [],
    changes: [],
  };
}

function summaryText(summary: RetargetSummary, plan: DeployPlan): string {
  const fresh = hostWords(summary.to as SiteTarget);
  const free = summary.extraMonthly.amount === 0;
  return [
    `Moving ${plan.app.name} from ${hostWords(summary.from as SiteTarget)} to ${fresh}:`,
    ...summary.steps.map((step, i) => `  ${i + 1}. ${step}`),
    free
      ? `Extra cost: none for ${fresh}.`
      : `Cost on ${fresh}: ${formatMoney(summary.extraMonthly)} per month.`,
    `While the move runs, ${plan.infra.dir} holds a transitional version of the infrastructure files; \`${FINISH_COMMAND}\` publishes the final ones in a pull request.`,
  ].join("\n");
}

/**
 * Step 1 of a site's move (plan.md "6." started): the refusals before any change (a server as
 * the new target, the same host, nothing live, GitHub Pages' one site per repository and its
 * `www`), the new host as design offers it for the app, the checks of Cloudflare, GitHub and the
 * state, the summary and `confirmStart`; then the move is recorded (`plan.target`, `cost` and the
 * DNS and security settings are the new host's; `retarget.step` is `started`).
 */
async function startSiteMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<SiteSession> {
  const from = newSite(plan);
  const to = options.to ?? (await requireRequirements(deps)).provider;
  if (!isServerlessProvider(to)) throw siteServerNoMove(plan);
  if (to === from.provider) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${plan.app.name} already runs on ${hostWords(from)}, so there is nothing to move. Nothing was changed.`,
      {
        hint: `Run \`${RUN_COMMAND} --to ${to === "github-pages" ? "cloudflare-workers" : "github-pages"}\` to move it to the other site host.`,
      },
    );
  }
  if (plan.deployment.destroyedAt !== undefined || !hasDeployment(plan)) throw nothingLive(plan);
  if (to === "github-pages") await requirePagesMove(deps, plan);
  const next = await siteOn(deps, plan, to);
  const retarget: Retarget = {
    from: { target: from, deploy: plan.deploy },
    step: "started",
    empty: [],
    startedAt: deps.clock.now().toISOString(),
  };
  // The move's plan, recorded only once the summary is confirmed.
  const moving: DeployPlan = { ...onSiteHost(plan, next.target), cost: next.cost, retarget };
  const session = await openSiteSession(deps, moving, {
    command: RUN_COMMAND,
    services: options.services ?? {},
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.approvePlanHash !== undefined ? { approvePlanHash: options.approvePlanHash } : {}),
  });
  if (to === "github-pages") await requireNoPagesSite(session);
  const summary = siteSummary(plan, next, session.github.owner, session.github.repo);
  deps.reporter.info(summaryText(summary, plan));
  if (options.confirmStart !== undefined && !(await options.confirmStart(summary))) {
    throw new OpsCrewError("APPROVAL_REFUSED", "The move was not started. Nothing was changed.", {
      hint: `Run \`${RUN_COMMAND}\` again when you are ready.`,
    });
  }
  await saveMove(session, retarget);
  deps.reporter.success(
    `Started the move of ${plan.app.name} to ${hostWords(next.target)}; opscrew/plan.yaml records each step.`,
  );
  await auditStep(session, "started", `move from ${from.provider} to ${to}`);
  return session;
}

/** Opens the run of a site's move that is already recorded in `opscrew/plan.yaml`. */
async function continueSiteMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<SiteSession> {
  const move = moveOf({ plan });
  const to = hostWords(newSite(plan));
  if (move.abort !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The move to ${to} is being aborted, so it cannot continue.`,
      { hint: FINISH_ABORT_HINT },
    );
  }
  if (options.to !== undefined && options.to !== plan.target.provider) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A move to ${to} is already in progress, so OpsCrew will not start another one.`,
      {
        hint: `Run \`${RUN_COMMAND}\` to continue it, or \`${ABORT_COMMAND}\` before the switch to undo it.`,
      },
    );
  }
  return openSiteSession(deps, plan, {
    command: RUN_COMMAND,
    services: options.services ?? {},
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.approvePlanHash !== undefined ? { approvePlanHash: options.approvePlanHash } : {}),
  });
}

/**
 * `opscrew retarget` for an app on a site host: starts the move (or opens the one recorded) and
 * runs its steps from the last completed one: the new host provisioned without the hostnames and
 * its first deploy checked (`deployed`), then the hostnames moved by one Cloudflare plan
 * (`switched`). Every change goes through its approval bound to its hash; non-interactive runs
 * stop with the hash (`pendingPlanHash`) and continue with `approvePlanHash`.
 */
export async function runSiteMove(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RetargetOptions,
): Promise<RetargetResult> {
  const session =
    plan.retarget === undefined
      ? await startSiteMove(deps, plan, options)
      : await continueSiteMove(deps, plan, options);
  const result = await siteSteps(session, options);
  warnUnusedApproval(session);
  return result;
}

async function siteSteps(session: SiteSession, options: RetargetOptions): Promise<RetargetResult> {
  for (;;) {
    const { step } = moveOf(session);
    let stop: RetargetResult | undefined;
    switch (step) {
      case "started":
        stop = await siteDeployStep(session, options);
        break;
      case "deployed":
        stop = await siteSwitchStep(session);
        break;
      case "switched":
        return siteSwitched(session);
      default:
        throw new OpsCrewError("INTERNAL", `A site's move recorded the step ${step}.`, {
          hint: "This is a bug in OpsCrew; please report it.",
        });
    }
    if (stop !== undefined) return stop;
  }
}
