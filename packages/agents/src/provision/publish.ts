import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { GitClient, PullRequest } from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import {
  exists,
  isUserFacingError,
  OpsCrewError,
  upperFirst,
  writeFileAtomic,
} from "@opscrew/core";
import {
  CHECK_WORKFLOW_FILE,
  pagesVerificationRootDir,
  portainerDeployBranch,
  portainerStackTemplatePath,
  portainerTarget,
  previewRecipeDir,
  previewWorkflowPath,
  type RenderedFile,
  renderWranglerConfig,
  runnerLabel,
  runtimeDir,
} from "@opscrew/iac-templates";
import { type DeployPlan, isServerlessProvider } from "@opscrew/plan-schema";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { OWN_SERVER_BACKUPS_NOTE } from "../design/own";
import { PORTAINER_HOST_NOTE, portainerBackupsNote, portainerHasData } from "../design/portainer";
import { workflowBranch } from "../environments/branches";
import { planProvider, providerProfile } from "../providers";
import { planFile, planWhere } from "../runners/words";
import {
  copyPath,
  keyHandoverNote,
  type RefreshRecoveryOptions,
  refreshRecoveryCopy,
  SOPS_CONFIG_PATH,
} from "../secrets";
import { appBranchNames, numberedBranches } from "../shared/app-branches";
import { type GitHubSetup, portainerCloudflare } from "./credentials";
import { type DependabotStep, dependabotPullRequestLines } from "./dependabot";

/**
 * Branch holding the generated deployment files of the repository's first app, then `-2`, `-3`,
 * …; a further app's is `opscrew/deploy-setup-<key>`, then `_2`, … (`appBranchNames`).
 */
export const DEPLOY_SETUP_BRANCH = "opscrew/deploy-setup";

/** The review checklist item of every deploy-setup pull request about the workflow's actions. */
const PINNED_ACTIONS_CHECK = "- [ ] The workflow only uses pinned, first-party actions.";

/** The pull request's line about the recovery copy at `path`, when it is in the pull request. */
const recoveryCopyLine = (path: string) =>
  `- \`${path}\`: the encrypted recovery copy of what OpsCrew keeps on your computer for this app (its generated secrets, the deploy key, the infrastructure state and its records). Only your age key opens it; the names of the files in it are readable. \`opscrew secrets restore\` rebuilds them on another computer.`;

export interface PublishResult {
  /** The branch holding the files: the current one when nothing was committed. */
  branch: string;
  /** The branch the pull request goes into (`workflowBranch`). */
  base: string;
  /** This run's commit, when it committed anything. */
  commit?: string;
  prUrl?: string;
  /**
   * False when there was nothing to publish: the files did not change and GitHub has them as this
   * clone does. True when this run committed them or the branch holds them unpushed; `pushed`
   * then says whether they reached GitHub.
   */
  published: boolean;
  pushed: boolean;
}

/**
 * The pull request's next step: merging it deploys the app to `where` once the deploy secrets are
 * stored; while OpsCrew has no record of them (`secretsStored` false), first `opscrew provision` in
 * a terminal. `ready` says what is set up already; `flag` is the environment's ` --env <name>`.
 */
function nextStepLines(
  secretsStored: boolean | undefined,
  ready: string,
  where: string,
  flag: string,
): string[] {
  return secretsStored === false
    ? [
        `${ready}, but OpsCrew has no record of storing the deploy secrets in GitHub Actions, so a deploy would fail.`,
        `**Before merging, run \`opscrew provision${flag}\` in a terminal in the project directory.** It finds nothing to change, asks for the production environment values and stores the secrets. After that, merging this pull request deploys the app to ${where}. When the first deploy finishes, run \`opscrew verify${flag}\`.`,
      ]
    : [
        `${ready} and the deploy secrets are stored in GitHub Actions. **Merging this pull request deploys the app to ${where}.** After the first deploy finishes, run \`opscrew verify${flag}\`.`,
      ];
}

/** What the deploy-setup pull request's body says beyond the plan. */
interface DeploySetupBodyOptions {
  /** ` --env <name>` for the commands it names (`planWhere`); "" by default. */
  flag?: string;
  /** Whether the deploy secrets are known to be stored (default true). */
  secretsStored?: boolean;
  /** Dependabot's configuration: added in this pull request, or the user's and what it lacks. */
  dependabot?: DependabotStep;
  /** The recovery copy's path (`copyPath`) when it is in the pull request. */
  recoveryCopy?: string;
}

/**
 * How the workflow gets the image it deploys, for the pull request body: for a promoted
 * environment, from its source by `opscrew promote` (its workflow never builds); else built on
 * each push to the branch the environment follows.
 */
function imageArrives(plan: DeployPlan): { promoted: boolean; text: string } {
  const source = plan.environment?.deploySource;
  return source?.from === "promote"
    ? {
        promoted: true,
        text: `an image promoted from \`${source.source}\` with \`opscrew promote --to ${plan.environment?.name ?? "prod"}\` (it never builds)`,
      }
    : { promoted: false, text: `every push to \`${plan.cicd.branch}\`` };
}

/**
 * Pull request body for the generated deployment files. `secretsStored` (default true) says
 * whether the GitHub Actions deploy secrets are known to be stored for this server; when they are
 * not, the body tells the user to run `opscrew provision` in a terminal before merging. It names
 * the domain or "the server", never the server's IP address (pull requests are often public).
 */
export function deploySetupPullRequestBody(
  plan: DeployPlan,
  version: string,
  options: DeploySetupBodyOptions = {},
): string {
  if (plan.environment?.previews !== undefined) {
    return previewsPullRequestBody(plan, version, options);
  }
  if (plan.target.provider === "portainer") return portainerPullRequestBody(plan, version, options);
  if (plan.target.provider === "localhost") return localPullRequestBody(plan, version, options);
  if (isServerlessProvider(plan.target.provider)) {
    return sitePullRequestBody(plan, version, options);
  }
  const profile = providerProfile(planProvider(plan));
  const own = plan.target.provider === "own";
  const tunnel = plan.target.provider === "own" && plan.target.access === "tunnel";
  const host = plan.dns.domain ?? (own ? "your server" : `the ${profile.serverNoun}`);
  const ready = own ? "Your server is prepared" : "The server is already running";
  const file = planFile(plan);
  const flag = options.flag ?? "";
  const runtime = runtimeDir(plan);
  const arrives = imageArrives(plan);
  const infra = own
    ? tunnel
      ? "the Cloudflare Tunnel that serves the app, its DNS records and the Cloudflare Access application GitHub Actions deploys through (works with OpenTofu and Terraform). OpsCrew never creates, reinstalls or deletes your server itself."
      : `${plan.dns.provider === "cloudflare" ? "the Cloudflare DNS records that point the domain at your server" : "the outputs that describe your server"} (works with OpenTofu and Terraform). OpsCrew never creates, reinstalls or deletes your server itself.`
    : `infrastructure code for the ${profile.displayName} ${profile.serverNoun}${plan.dns.provider === "cloudflare" ? " and the Cloudflare DNS records" : ""} (works with OpenTofu and Terraform).`;
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`${file}\` for **${plan.app.name}**:`,
    "",
    `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: ${infra}`,
    tunnel
      ? `- \`${runtime}/\`: Docker Compose and Caddy configuration for the server, and the Cloudflare Tunnel connector (\`cloudflared/compose.yaml\`; its token is only on the server).`
      : `- \`${runtime}/\`: Docker Compose and Caddy configuration for the server.`,
    arrives.promoted
      ? `- \`${plan.cicd.workflowPath}\`: deploys ${arrives.text}, rolling back when the health check fails.`
      : `- \`${plan.cicd.workflowPath}\`: builds the image, pushes it to GitHub Container Registry and deploys it on ${arrives.text}, rolling back when the health check fails.`,
    `- \`${file}\`: the deployment plan. The server's IP address is not in the repository; \`opscrew status${flag}\` shows it on the computer that ran \`opscrew provision${flag}\`.`,
    ...(options.recoveryCopy === undefined ? [] : [recoveryCopyLine(options.recoveryCopy)]),
    ...dependabotPullRequestLines(options.dependabot),
    "",
    ...nextStepLines(options.secretsStored, ready, host, flag),
    ...(own ? ["", OWN_SERVER_BACKUPS_NOTE] : []),
    "",
    "Review checklist:",
    PINNED_ACTIONS_CHECK,
    own
      ? "- [ ] The host changes OpsCrew showed before applying them (Docker, the deploy user, SSH settings, the ufw firewall) match what you expect."
      : "- [ ] The firewall rules in the infrastructure code match what you expect.",
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/**
 * What happens once a preview environment's workflow is on the repository's default branch: each
 * pull request from a branch of the repository that changes the app gets its preview.
 */
export function previewsNext(plan: DeployPlan): string {
  return `each pull request from a branch of this repository that changes the app gets its own preview at pr-<number>-<random>.${plan.environment?.previews?.domain}, an address nobody can guess, with a comment holding it; it is updated on each push and removed with its data when the pull request is closed or merged`;
}

/**
 * The pull request body for a preview environment (ADR 0026): its root (the server and the
 * wildcard record), the preview workflow, the recipe as the preview server has it without its
 * values, and the plan; no deploy workflow, runtime or Dependabot entry. Never the server's
 * address.
 */
function previewsPullRequestBody(
  plan: DeployPlan,
  version: string,
  options: DeploySetupBodyOptions,
): string {
  const base = plan.environment?.previews?.domain;
  const own = plan.target.provider === "own";
  const flag = options.flag ?? "";
  const server = own
    ? "the proxied wildcard record"
    : `the ${providerProfile(planProvider(plan)).displayName} server previews run on and the proxied wildcard record`;
  return [
    `This pull request sets up previews of pull requests for **${plan.app.name}**, generated by OpsCrew from \`${planFile(plan)}\`:`,
    "",
    `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: ${server} *.${base}${own ? ", which points at your server" : ""} (works with OpenTofu and Terraform).`,
    `- \`${previewWorkflowPath(plan)}\`: builds each pull request from a branch of this repository on GitHub's machines and asks the preview server to start, update or remove its preview; pull requests from forks and Dependabot get none.`,
    `- \`${previewRecipeDir(plan)}/\`: the preview recipe you approved, as the preview server has it without its values: its bounds (\`settings.env\`), each preview's files (\`template/\`) and the command that enforces them (\`bin/opscrew-preview\`).`,
    `- \`${planFile(plan)}\`: the deployment plan. The server's IP address is not in the repository.`,
    ...(options.recoveryCopy === undefined ? [] : [recoveryCopyLine(options.recoveryCopy)]),
    "",
    options.secretsStored === false
      ? `The preview server is set up, but OpsCrew has no record of storing its secrets in GitHub Actions, so previews would fail. **Before merging, run \`opscrew provision${flag}\` in a terminal in the project directory.**`
      : `The preview server is set up and its secrets are stored in GitHub Actions. **Once this pull request is merged, ${previewsNext(plan)}.**`,
    "",
    "Review checklist:",
    PINNED_ACTIONS_CHECK,
    "- [ ] The bounds in `settings.env` and the files in `template/` are the ones you approved.",
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/**
 * The pull request body on this computer (the localhost target), whose deploy job runs on the
 * local runner: the stack's files, the workflow and the plan; never a path of this computer.
 */
function localPullRequestBody(
  plan: DeployPlan,
  version: string,
  options: DeploySetupBodyOptions,
): string {
  const start = `opscrew runner start --env ${plan.environment?.name ?? "prod"}`;
  const file = planFile(plan);
  const flag = options.flag ?? "";
  const arrives = imageArrives(plan);
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`${file}\` for **${plan.app.name}**, which runs on your own computer:`,
    "",
    `- \`${runtimeDir(plan)}/\`: Docker Compose and the edge's configuration for your computer (on 127.0.0.1 only, with OpsCrew's local certificate authority).`,
    arrives.promoted
      ? `- \`${plan.cicd.workflowPath}\`: deploys ${arrives.text} with the runner on your computer, rolling back when the health check fails.`
      : `- \`${plan.cicd.workflowPath}\`: builds the image on GitHub's machines, pushes it to GitHub Container Registry and, on ${arrives.text}, deploys it with the runner on your computer, rolling back when the health check fails.`,
    `- \`${file}\`: the deployment plan.`,
    ...(options.recoveryCopy === undefined ? [] : [recoveryCopyLine(options.recoveryCopy)]),
    ...dependabotPullRequestLines(options.dependabot),
    "",
    ...(options.secretsStored === false
      ? nextStepLines(false, "The app runs on your computer", "your computer", flag)
      : [
          `The app runs on your computer and the deploy secrets are stored in GitHub Actions. **After merging, ${arrives.promoted ? `each \`opscrew promote --to ${plan.environment?.name ?? "prod"}\`` : `each push to \`${plan.cicd.branch}\``} deploys it there while \`${start}\` runs.**`,
        ]),
    "",
    "Review checklist:",
    PINNED_ACTIONS_CHECK,
    `- [ ] The deploy job runs only on your computer's runner (\`runs-on: [self-hosted, ${runnerLabel(plan)}]\`).`,
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/**
 * The pull request body for a site with no server (Cloudflare's hosting, GitHub Pages): the
 * infrastructure code (the Worker's shell and custom domains, or the site's DNS records), on
 * Cloudflare the Worker's settings, on GitHub Pages the verification record's root, the workflow
 * and the plan; on GitHub Pages also the manual Verify step and when HTTPS follows. The site's
 * secrets are in GitHub Actions only.
 */
function sitePullRequestBody(
  plan: DeployPlan,
  version: string,
  options: DeploySetupBodyOptions,
): string {
  const workers = plan.target.provider === "cloudflare-workers" ? plan.target : undefined;
  const file = planFile(plan);
  const flag = options.flag ?? "";
  const where = workers !== undefined ? "Cloudflare" : "GitHub Pages";
  const source = plan.environment?.deploySource;
  const app = plan.app.key === undefined ? "" : ` --app ${plan.app.key}`;
  const workflow =
    source?.from === "promote"
      ? `deploys the build the \`${source.source}\` environment runs, started with \`opscrew promote${app} --to ${plan.environment?.name ?? "prod"}\` (it never builds), as a new version of the Worker, and activates the version that ran before again when the new one does not answer.`
      : workers !== undefined
        ? `builds the site on every push to \`${plan.cicd.branch}\` and uploads it to Cloudflare as a new version of the Worker with OpsCrew's security headers, and activates the version that ran before again when the new one does not answer.`
        : `builds the site on every push to \`${plan.cicd.branch}\` and publishes it to GitHub Pages.`;
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`${file}\` for **${plan.app.name}**, which ${where} serves with no server:`,
    "",
    workers !== undefined
      ? `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: the Worker ${workers.worker}'s shell and a custom domain for each hostname, which bring their own DNS records and certificates (works with OpenTofu and Terraform). The Worker's code, files and secrets come only from the deploy workflow.`
      : `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: the site's DNS records at Cloudflare, all DNS only, since Cloudflare's proxy would stop GitHub from issuing and renewing the site's certificate (works with OpenTofu and Terraform). The GitHub Pages site claimed the domain before they existed, so no record points at GitHub while no site claims it.`,
    ...(workers !== undefined
      ? [
          // The Worker's settings live in its Wrangler config, never in Terraform (spike result 1).
          `- \`${posix.dirname(renderWranglerConfig(plan).path)}/\`: the Worker's settings for Wrangler (the site's files, how a missing page is answered, the workers.dev address and preview URLs)${workers.render === "ssr" ? ", and the module that adds OpsCrew's security headers to the pages the Worker renders" : ""}.`,
        ]
      : [
          `- \`${pagesVerificationRootDir(plan)}/\`: GitHub's domain verification record, a TXT record in a root of its own, so that destroying the site keeps the domain verified.`,
        ]),
    `- \`${plan.cicd.workflowPath}\`: ${workflow}`,
    `- \`${file}\`: the deployment plan.`,
    ...(options.recoveryCopy === undefined ? [] : [recoveryCopyLine(options.recoveryCopy)]),
    ...dependabotPullRequestLines(options.dependabot),
    "",
    ...nextStepLines(
      options.secretsStored,
      workers !== undefined
        ? "The Worker and its custom domains are set up"
        : "The GitHub Pages site and its DNS records are set up",
      plan.dns.domain ?? where,
      flag,
    ),
    ...(workers !== undefined
      ? []
      : [
          "",
          `One step is yours, because GitHub has no API for it: once the verification record resolves, click Verify next to ${plan.dns.domain ?? "the domain"} in your GitHub account's (or organization's) Settings → Pages; \`opscrew provision${flag}\` named the exact page. A verified domain can be used only by your account's GitHub Pages sites.`,
          `GitHub issues the site's certificate once it has checked the DNS records, which can take up to 24 hours. Until then the site answers over HTTP; run \`opscrew provision${flag}\` again then to enforce HTTPS (\`opscrew verify${flag}\` shows when the certificate is there).`,
        ]),
    "",
    "Review checklist:",
    PINNED_ACTIONS_CHECK,
    workers !== undefined
      ? `- [ ] The Worker's settings in \`${renderWranglerConfig(plan).path}\` match what you expect.`
      : "- [ ] The DNS records in the infrastructure code match what you expect.",
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/**
 * What the user does so visitors reach an app in their Portainer in web mode `proxy` or `caddy`,
 * where OpsCrew creates no DNS record (a home address changes, and OpsCrew never knows it): the
 * record to create, and for `proxy` the port the user's reverse proxy forwards to. `undefined` in
 * web mode `tunnel` (the tunnel's records are OpsCrew's). Never Portainer's address.
 */
export function portainerDnsRecordNote(plan: DeployPlan): string | undefined {
  const target = plan.target;
  if (target.provider !== "portainer" || target.web.mode === "tunnel") return undefined;
  const domain = plan.dns.domain;
  const web = target.web;
  if (domain === undefined) {
    return web.mode === "proxy"
      ? `Route your reverse proxy to port ${web.port} of your Portainer host; it manages the address and the certificate.`
      : undefined;
  }
  const hosts = plan.dns.www ? [domain, `www.${domain}`] : [domain];
  const where =
    "(an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name)";
  const records =
    hosts.length === 1
      ? `OpsCrew creates no DNS record for ${domain}: create one yourself that points it at your Portainer host ${where}`
      : `OpsCrew creates no DNS record for ${hosts.join(" and ")}: create them yourself so they point at your Portainer host ${where}`;
  return web.mode === "proxy"
    ? `${records}, and let your reverse proxy forward ${hosts.join(" and ")} to port ${web.port} of that host; your proxy manages the certificate.`
    : `${records}. Caddy gets their certificates once ports 80 and 443 of the host are reachable from the internet.`;
}

/**
 * The pull request body for the user's Portainer: the Cloudflare root only when the plan has one
 * (the app's tunnel, or the tunnel and Access in front of Portainer's webhook), the app's stack
 * template and the environment's deploy branch it is written to, how new versions reach Portainer, the
 * DNS record the user creates for `proxy` and `caddy`, and that OpsCrew does not change the host and
 * backups are the user's. Never Portainer's address.
 */
function portainerPullRequestBody(
  plan: DeployPlan,
  version: string,
  options: DeploySetupBodyOptions,
): string {
  const target = portainerTarget(plan.target);
  const { appTunnel, webhook } = portainerCloudflare(plan) ?? { appTunnel: false, webhook: false };
  const where = plan.dns.domain ?? "your Portainer";
  const roots = [
    ...(appTunnel ? ["the Cloudflare Tunnel that serves the app and its DNS records"] : []),
    ...(webhook
      ? [
          "the Cloudflare Tunnel and Cloudflare Access application through which GitHub Actions reaches Portainer's webhook (and nothing else of Portainer)",
        ]
      : []),
  ];
  const redeploy =
    target.redeploy === "updater"
      ? "the updater stack in your Portainer asks Portainer to redeploy it within about a minute"
      : "it asks Portainer to redeploy at once, through Cloudflare Access";
  const dns = portainerDnsRecordNote(plan);
  const file = planFile(plan);
  const flag = options.flag ?? "";
  const branch = portainerDeployBranch(plan);
  const arrives = imageArrives(plan);
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`${file}\` for **${plan.app.name}**, which runs as stacks in your Portainer:`,
    "",
    ...(roots.length > 0
      ? [
          `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: ${roots.join(", and ")} (works with OpenTofu and Terraform).`,
        ]
      : []),
    `- \`${portainerStackTemplatePath(plan)}\`: the app's stack in your Portainer (the app, its release command and the services it needs). The deploy workflow fills in each new image and writes the file to the \`${branch}\` branch, which Portainer deploys. The values of its variables live only in the stack's environment in Portainer.`,
    arrives.promoted
      ? `- \`${plan.cicd.workflowPath}\`: writes ${arrives.text} to the \`${branch}\` branch; ${redeploy}. It checks the site and writes the previous version back when the health check fails.`
      : `- \`${plan.cicd.workflowPath}\`: builds the image, pushes it to GitHub Container Registry and writes it to the \`${branch}\` branch on ${arrives.text}; ${redeploy}. It checks the site and writes the previous version back when the health check fails.`,
    `- \`${file}\`: the deployment plan. Portainer's address is not in the repository; it stays on the computer that ran \`opscrew provision${flag}\`.`,
    ...(options.recoveryCopy === undefined ? [] : [recoveryCopyLine(options.recoveryCopy)]),
    ...dependabotPullRequestLines(options.dependabot),
    "",
    ...nextStepLines(
      options.secretsStored,
      "The app's stacks are set up in your Portainer",
      where,
      flag,
    ),
    ...(dns !== undefined ? ["", dns] : []),
    "",
    PORTAINER_HOST_NOTE,
    portainerBackupsNote(portainerHasData(plan)),
    "",
    "Review checklist:",
    PINNED_ACTIONS_CHECK,
    "- [ ] The stacks and the registry entry OpsCrew showed before creating them in Portainer match what you expect.",
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/** The branch the deployment files go on, and the open pull request from it that a run adds to. */
export interface DeployBranch {
  branch: string;
  pullRequest?: PullRequest;
}

/** Phases that publish the deployment files. */
export type PublishPhase = Extract<PhaseName, "provision" | "dns" | "retarget">;

/** What to do when the final files of a finished move were not published. */
const PUBLISH_BY_HAND =
  "commit the changed files under opscrew/ on a new branch and open a pull request yourself, so the repository describes the deployment.";

/**
 * A branch-check stop. Before a provision (or dns) run nothing has changed yet, and the user runs
 * the command again; at the end of a finished retarget only the final files were not published,
 * and the user publishes them by hand.
 */
function branchStop(
  phase: PublishPhase,
  reason: string,
  hints: { rerun: string; retarget: string },
): OpsCrewError {
  if (phase === "retarget") {
    return new OpsCrewError(
      "PHASE_PRECONDITION",
      `The final files were not published; ${reason}.`,
      {
        hint: hints.retarget,
      },
    );
  }
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${upperFirst(reason)}, so OpsCrew did not change anything.`,
    { hint: hints.rerun },
  );
}

/** Where the deployment files must start from, and how a stop is worded. */
interface BaseCheck {
  phase: PublishPhase;
  /** The branch the pull request goes into (`workflowBranch`, usually `main`). */
  base: string;
  /** The branch this clone is on (`HEAD` when detached). */
  current: string;
}

/** The stop when the deployment files would not start from the latest {@link BaseCheck.base}. */
function baseStop(check: BaseCheck, reason: string, rerun: string): OpsCrewError {
  const { phase, base } = check;
  return branchStop(phase, reason, {
    rerun: `${rerun}, then run \`opscrew ${phase}\` again.`,
    retarget: `Switch to the latest ${base} (\`git checkout ${base} && git pull\`), then ${PUBLISH_BY_HAND}`,
  });
}

/**
 * Stops (before anything changes) unless the deployment files start from the latest
 * `check.base`, so the pull request never carries old or already-merged changes again: a new
 * deploy branch is only created from that branch itself, and only when it has every commit GitHub
 * has (`baseTip`); the deploy branch this clone is on is only reused when it has them too (a
 * branch GitHub deleted after squash-merging its pull request does not). `baseTip` undefined: the
 * tip is not known (no such branch on GitHub, or nothing fetched), so only the branch is checked.
 */
async function requireLatestBase(
  git: GitClient,
  check: BaseCheck,
  target: { branch: string; baseTip: string | undefined },
): Promise<void> {
  const { base, current } = check;
  const hasTip = target.baseTip === undefined || (await git.isAncestor(target.baseTip, "HEAD"));
  const checkout = `Run \`git checkout ${base} && git pull\``;
  if (target.branch === current) {
    if (hasTip) return;
    throw baseStop(
      check,
      `this clone is on ${current}, an earlier OpsCrew branch without the latest ${base} from GitHub (its pull request was probably merged)`,
      checkout,
    );
  }
  if (current !== base) {
    const where =
      current === "HEAD" ? "this clone is not on a branch" : `this clone is on ${current}`;
    throw baseStop(
      check,
      `${where}, but the deployment files go on a new branch from the latest ${base}`,
      checkout,
    );
  }
  if (!hasTip) {
    throw baseStop(
      check,
      `this clone's ${base} is behind GitHub, and the deployment files go on a new branch from the latest ${base}`,
      "Run `git pull`",
    );
  }
}

/**
 * `origin/<base>` as this clone last fetched it, when it has that remote-tracking branch (no
 * network: for runs that do not reach GitHub).
 */
async function lastFetchedTip(git: GitClient, base: string): Promise<string | undefined> {
  const ref = `refs/remotes/origin/${base}`;
  // A ref is its own ancestor exactly when it names a commit in this clone.
  return (await git.isAncestor(ref, ref)) ? ref : undefined;
}

/**
 * The branch for the deployment files of the app `key` (a further app's; `undefined`: the first
 * app) chosen without reaching GitHub: the first of its {@link DEPLOY_SETUP_BRANCH} names
 * (`appBranchNames`) that is the current branch or does not exist in this clone, so a stale local
 * branch (its pull request merged long ago) is never committed on. Like {@link chooseDeployBranch}
 * it stops with `PHASE_PRECONDITION` unless the files start from `base` (`workflowBranch`), here
 * judged by what this clone last fetched (`origin/<branch>`).
 */
export async function localDeployBranch(
  git: GitClient,
  base: string,
  key: string | undefined,
  phase: PublishPhase = "provision",
): Promise<string> {
  const current = await git.currentBranch();
  const check: BaseCheck = { phase, base, current };
  const names = appBranchNames(DEPLOY_SETUP_BRANCH, key);
  for (const branch of names) {
    if (branch === current || !(await git.branchExists(branch))) {
      const baseTip = await lastFetchedTip(git, check.base);
      await requireLatestBase(git, check, { branch, baseTip });
      return branch;
    }
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `There are already 100 ${names[0]} branches in this clone, so OpsCrew did not create another one.`,
    {
      hint: `Delete the old ones with \`git branch -D ${numberedBranches(DEPLOY_SETUP_BRANCH, key)}\`, then try again.`,
    },
  );
}

/**
 * Picks the branch for the deployment files of the plan's app before anything changes, so the
 * push never collides with a branch an earlier run left on GitHub: its {@link DEPLOY_SETUP_BRANCH}
 * (`opscrew/deploy-setup-<key>` for a further app), or the next free `-2`, `-3`, … (a further
 * app's `_2`, `_3`, …: `appBranchNames`). A branch on GitHub whose pull request is merged or
 * closed is skipped (never pushed to), and so is a branch only this clone has unless it is the
 * current branch (a stale local branch is never committed on). One with an open pull request is
 * added to when this clone is on that branch and the push is a fast-forward (its head is in this
 * clone's branch, so OpsCrew pushed it from here); otherwise this throws `PHASE_PRECONDITION`
 * naming the pull request, and
 * nothing is force-pushed. Any other branch must start from the latest branch the plan's files
 * live on (`workflowBranch`: `cicd.branch`, or the default branch for a promoted environment) as
 * GitHub has it (read with `git ls-remote`, nothing is fetched): a new branch is created only from
 * that branch with every commit GitHub has, and the deploy branch this clone is on only when it
 * has them too; otherwise this throws `PHASE_PRECONDITION` telling the user to check it out and
 * pull (after `opscrew adapt` the clone is on the adapt branch, and after a squash merge neither
 * that branch nor a merged deploy branch has `main`'s new commit, so a pull request from them
 * would carry the merged changes again). When GitHub cannot be reached through git, it warns and
 * picks the branch from this clone alone ({@link localDeployBranch}). `phase` (default
 * `provision`) words a stop for the command that publishes: a finished retarget says the final
 * files were not published.
 */
export async function chooseDeployBranch(
  deps: PhaseDeps,
  git: GitClient,
  github: GitHubSetup,
  plan: Pick<DeployPlan, "app" | "cicd" | "environment">,
  phase: PublishPhase = "provision",
): Promise<DeployBranch> {
  const command = `opscrew ${phase}`;
  const key = plan.app.key;
  const names = appBranchNames(DEPLOY_SETUP_BRANCH, key);
  const current = await git.currentBranch();
  const check: BaseCheck = { phase, base: workflowBranch(plan, github.defaultBranch), current };
  /** A branch's sha on GitHub; `null` when GitHub cannot be reached (this clone decides then). */
  const remoteSha = async (branch: string): Promise<string | undefined | null> => {
    try {
      return await git.remoteBranchSha(branch);
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      deps.reporter.warn(
        deps.redactor.redact(
          `OpsCrew could not check GitHub for the latest ${check.base} or a branch left by an earlier run (${error.message}). It continues with what this clone knows.`,
        ),
      );
      return null;
    }
  };
  const baseTip = await remoteSha(check.base);
  if (baseTip === null) return { branch: await localDeployBranch(git, check.base, key, phase) };
  for (const branch of names) {
    const sha = await remoteSha(branch);
    if (sha === null) return { branch: await localDeployBranch(git, check.base, key, phase) };
    if (sha === undefined) {
      if (branch !== current && (await git.branchExists(branch))) {
        deps.reporter.info(
          `${branch} is only in this clone, from an earlier run, and you are not on it, so OpsCrew leaves it alone.`,
        );
        continue;
      }
      await requireLatestBase(git, check, { branch, baseTip });
      return { branch };
    }
    const open = await github.api.findOpenPullRequest(github.owner, github.repo, branch);
    if (open === undefined) {
      deps.reporter.info(
        `${branch} is already on GitHub from an earlier run, and no pull request from it is open, so OpsCrew leaves it alone.`,
      );
      continue;
    }
    if ((await git.branchExists(branch)) && (await git.isAncestor(sha, branch))) {
      if (current === branch) {
        deps.reporter.info(`Adding to the open pull request ${open.url} (branch ${branch}).`);
        return { branch, pullRequest: open };
      }
      throw branchStop(
        phase,
        `the pull request ${open.url} from an earlier OpsCrew run is still open and the files belong on its branch ${branch}, but this clone is on ${current}`,
        {
          rerun: `Run \`git checkout ${branch}\`, then run \`${command}\` again. To start a new pull request instead, merge or close ${open.url} first.`,
          retarget: `Add them to ${open.url} by committing the changed files under opscrew/ on ${branch} and pushing it, or merge or close that pull request, then ${PUBLISH_BY_HAND}`,
        },
      );
    }
    throw branchStop(
      phase,
      `the pull request ${open.url} from an earlier OpsCrew run is still open, and its branch ${branch} has commits this clone does not have`,
      {
        rerun: `Merge or close it on GitHub, then run \`${command}\` again. To add to it instead, bring its commits here first (\`git fetch origin ${branch}\`, \`git checkout ${branch}\`, \`git pull\`).`,
        retarget: `Merge or close it on GitHub, then ${PUBLISH_BY_HAND}`,
      },
    );
  }
  throw branchStop(phase, `there are already 100 ${names[0]} branches on GitHub`, {
    rerun: "Delete the old ones on GitHub, then try again.",
    retarget: `Delete the old ones on GitHub, then ${PUBLISH_BY_HAND}`,
  });
}

/**
 * The recovery copy as {@link recoveryCopyFiles} brought it up to date: the files for the pull
 * request and, when it made a new copy, the age recipients (`age1…`) it encrypted it to, the main
 * key's first. No private key is ever in it.
 */
export interface RecoveryCopy {
  files: RenderedFile[];
  recipients?: string[];
}

/**
 * The recovery copy's files for the pull request when this computer's files changed since the
 * last copy ({@link refreshRecoveryCopy}, which asks GitHub whether the repository is private only
 * before the copy's first commit), saying where the first key and the folder copy were written, or
 * why there is no copy; and its recipients ({@link RecoveryCopy}). Provision brings it up to date
 * before the deploy secrets when the off-server copy needs its recipient (024 D11), and gives the
 * result to {@link publishDeploySetup}, which then does not do it again.
 */
export async function recoveryCopyFiles(
  deps: PhaseDeps,
  input: {
    github: GitHubSetup;
    plan: DeployPlan;
    recovery?: Pick<RefreshRecoveryOptions, "recipient" | "keyOut" | "backup">;
  },
): Promise<RecoveryCopy> {
  const { github } = input;
  const result = await refreshRecoveryCopy(deps, input.plan, {
    repositoryPrivate: async () => (await github.api.getRepo(github.owner, github.repo)).private,
    ...input.recovery,
  });
  if (result.changed && result.firstKey !== undefined) {
    deps.reporter.warn(keyHandoverNote(result.firstKey));
  }
  if (result.changed && result.recipient !== undefined) {
    deps.reporter.info(
      `The recovery copy of this app's secrets is encrypted to your own age key ${result.recipient}; only that key (or your backup key) opens it.`,
    );
  }
  if (result.changed && result.folderCopy !== undefined) {
    deps.reporter.info(`Wrote the encrypted recovery copy to ${result.folderCopy}.`);
  }
  if (result.warning !== undefined) deps.reporter.warn(deps.redactor.redact(result.warning));
  return result.changed
    ? { files: result.repositoryFiles, recipients: result.recipients }
    : { files: [] };
}

/** A path a commit or pull request changes; `added` when the file is new there. */
export interface PathChange {
  path: string;
  added: boolean;
}

/** A pull request's title and body, and the commit message, whose subject follows the title. */
export interface Proposal {
  title: string;
  body: string;
  commitMessage: string;
}

/** Runs `git -C <root> <args>` and returns its output; a failure is an error. */
async function gitOutput(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  args: readonly string[],
): Promise<string> {
  const result = await deps.runner.run("git", ["-C", deps.paths.root, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * The files (of `paths`, by default all) that `git diff <range>` names, each with whether it was
 * added.
 */
async function changesOf(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  range: readonly string[],
  paths: readonly string[] = [],
): Promise<PathChange[]> {
  const out = await gitOutput(deps, [
    "diff",
    "--name-status",
    "--no-renames",
    "--relative",
    ...range,
    "--",
    ...paths,
  ]);
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { path: path ?? "", added: status === "A" };
    });
}

/**
 * A plan file without what OpsCrew records as it deploys and verifies (`updatedAt`,
 * `deployment.firstDeployAt`, `lastApplyAt`, `lastPlanHash`), which alone is no change to propose.
 */
function withoutRecords(text: string): unknown {
  const { updatedAt: _updated, deployment, ...rest } = parse(text) ?? {};
  const {
    firstDeployAt: _first,
    lastApplyAt: _apply,
    lastPlanHash: _hash,
    ...kept
  } = deployment ?? {};
  return { ...rest, deployment: kept };
}

/**
 * True when, of `paths`, only the plan file `planPath` differs from HEAD (staged, unstaged or
 * untracked files count), and only in its records ({@link withoutRecords}).
 */
async function onlyPlanRecords(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  git: GitClient,
  paths: readonly string[],
  planPath: string,
): Promise<boolean> {
  const wanted = new Set(paths);
  const changed = (await git.status()).filter((entry) => wanted.has(entry.path));
  const [only] = changed;
  if (changed.length !== 1 || only?.path !== planPath) return false;
  if (![...only.code].every((c) => c === " " || c === "M")) return false;
  const committed = await gitOutput(deps, ["show", `HEAD:${planPath}`]);
  const current = await readFile(join(deps.paths.root, planPath), "utf8");
  return isDeepStrictEqual(withoutRecords(committed), withoutRecords(current));
}

/** A group of a deployment's files, as a pull request names and lists it. */
interface ChangeGroup {
  /** Whether the changed file `path` is in the group (the first group that has it). */
  has: (path: string) => boolean;
  /** The title's phrase when the run changes this group alone; `undefined`: the general title. */
  phrase: (paths: readonly string[]) => string | undefined;
  /** The body's lines for the group's changed files. */
  lines: (paths: readonly string[]) => string[];
}

/** The most files a pull request lists for one group of {@link changeGroups}. */
const LISTED_FILES = 20;

/** The scheduled check's workflow, one per repository. */
const CHECK_WORKFLOW_PATH = `.github/workflows/${CHECK_WORKFLOW_FILE}`;

/** OpsCrew's own workflows of `plan`: the deploy (or preview) workflow and the scheduled check. */
const ownWorkflows = (plan: DeployPlan): string[] => [
  plan.cicd.workflowPath,
  previewWorkflowPath(plan),
  CHECK_WORKFLOW_PATH,
];

/** The groups of `plan`'s deployment files, in the order a pull request lists them. */
function changeGroups(plan: DeployPlan, copy: string): ChangeGroup[] {
  const file = planFile(plan);
  // At most LISTED_FILES files a group, so the body stays far below GitHub's size limit.
  const listed = (label: string) => (paths: readonly string[]) => {
    const shown = paths.slice(0, LISTED_FILES).map((path) => `\`${path}\``);
    const more = paths.length - shown.length;
    return [`- ${label}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`];
  };
  const named = (phrase: string) => () => phrase;
  return [
    {
      has: (path) =>
        path.startsWith("opscrew/infra/") || path.startsWith(`${posix.dirname(plan.infra.dir)}/`),
      phrase: named("the infrastructure code"),
      lines: listed("The infrastructure code (works with OpenTofu and Terraform)"),
    },
    {
      has: (path) => path === CHECK_WORKFLOW_PATH,
      phrase: named("the scheduled check"),
      lines: listed("The scheduled check"),
    },
    {
      // The scheduled check matched above.
      has: (path) => ownWorkflows(plan).includes(path),
      phrase: named("the deploy workflow"),
      lines: listed("The deploy workflow"),
    },
    {
      has: (path) => path === copy || path === SOPS_CONFIG_PATH || path === ".gitattributes",
      phrase: (paths) => (paths.includes(copy) ? "the recovery copy" : "the recovery copy's keys"),
      lines: (paths) =>
        paths.map((path) =>
          path === copy
            ? recoveryCopyLine(copy)
            : path === SOPS_CONFIG_PATH
              ? `- \`${SOPS_CONFIG_PATH}\`: the keys that open the recovery copy (its recipients).`
              : "- `.gitattributes`: keeps the recovery copy's line endings as they are on every computer.",
        ),
    },
    {
      has: (path) => path === file,
      phrase: named("the deployment plan"),
      lines: () => [
        `- \`${file}\`: the deployment plan, with OpsCrew's records of the deployment.`,
      ],
    },
    {
      has: (path) => path.startsWith("opscrew/") && path.endsWith(".md"),
      phrase: named("the runbook and reports"),
      lines: listed("The runbook and reports"),
    },
    {
      has: (path) => path.startsWith(`${posix.dirname(file)}/`),
      phrase: named("the runtime"),
      lines: listed("The runtime the app runs with"),
    },
    { has: () => true, phrase: () => undefined, lines: listed("Other files") },
  ];
}

/**
 * The pull request of a run that is not the first setup: its title names the one group of files
 * it changes ("OpsCrew: the recovery copy's keys for shop"), or else "OpsCrew: update the
 * deployment of shop"; its body lists the changed files by group, whether the deploy secrets are
 * stored (`flag` names the environment in the command that stores them), and the pinned-actions
 * check when a workflow changed. The commit message follows the title.
 */
function deploymentUpdate(
  plan: DeployPlan,
  version: string,
  changes: readonly PathChange[],
  options: { copy: string; flag: string; secretsStored: boolean },
): Proposal {
  const app = plan.app.name;
  const file = planFile(plan);
  const all = changeGroups(plan, options.copy);
  const byGroup = new Map<ChangeGroup, string[]>();
  for (const { path } of changes) {
    const group = all.find((candidate) => candidate.has(path)) as ChangeGroup;
    byGroup.set(group, [...(byGroup.get(group) ?? []), path]);
  }
  const groups = all.filter((group) => byGroup.has(group));
  const [only] = groups;
  const phrase =
    groups.length === 1 && only !== undefined ? only.phrase(byGroup.get(only) ?? []) : undefined;
  const subject = phrase !== undefined ? `${phrase} for ${app}` : `update the deployment of ${app}`;
  const workflowChanged = changes.some(({ path }) => ownWorkflows(plan).includes(path));
  const body = [
    `This pull request updates the deployment of **${app}** that OpsCrew generated from \`${file}\`:`,
    "",
    ...groups.flatMap((group) => group.lines(byGroup.get(group) ?? [])),
    "",
    options.secretsStored
      ? "Nothing else is needed before merging: the deploy secrets are stored in GitHub Actions."
      : `OpsCrew has no record of storing the deploy secrets in GitHub Actions, so a deploy would fail. **Before merging, run \`opscrew provision${options.flag}\` in a terminal in the project directory.**`,
    ...(workflowChanged ? ["", "Review checklist:", PINNED_ACTIONS_CHECK] : []),
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
  return {
    title: `OpsCrew: ${subject}`,
    body,
    commitMessage: `chore(opscrew): ${subject}\n\nGenerated by OpsCrew ${version} from ${file}.`,
  };
}

/**
 * Commits the generated files and the plan on the deploy branch (`input.branch`, chosen with
 * {@link chooseDeployBranch} before anything changed; when absent it is chosen here, or with
 * {@link localDeployBranch} without a push), with the recovery copy's files when this computer's
 * files changed since the last copy, then (when `push`) pushes it and opens a pull request into the
 * deploy branch, each after its own approval. A refused push or pull request is not an error: the
 * commit stays local and the user is told how to continue. When nothing changed and nothing waits
 * to be pushed, it commits, pushes and opens nothing ({@link commitAndPropose}); so too when only
 * the plan's records changed (`deployment.firstDeployAt` and the like), which then stay on this
 * computer and go with the next change. The first setup's pull request is
 * {@link deploySetupPullRequestBody}'s; a later one says what it changes.
 */
export async function publishDeploySetup(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    paths: readonly string[];
    push: boolean;
    /** Whether the deploy secrets are known to be stored for this server (default true). */
    secretsStored?: boolean;
    /** Phase recorded in the audit log and named in branch-check stops (default `provision`). */
    phase?: PublishPhase;
    /** The branch from {@link chooseDeployBranch}, when the caller chose it up front. */
    branch?: DeployBranch;
    /** Dependabot's configuration, for the pull request's file list. */
    dependabot?: DependabotStep;
    /**
     * What the recovery copy's first key needs: the user's own recipient, or the file to write a
     * new key to; a backup recipient.
     */
    recovery?: Pick<RefreshRecoveryOptions, "recipient" | "keyOut" | "backup">;
    /** The recovery copy this run already brought up to date ({@link recoveryCopyFiles}). */
    recoveryCopy?: RecoveryCopy;
  },
): Promise<PublishResult> {
  const { git, github, plan } = input;
  const phase = input.phase ?? "provision";
  const chosen =
    input.branch ??
    (input.push
      ? await chooseDeployBranch(deps, git, github, plan, phase)
      : {
          branch: await localDeployBranch(
            git,
            workflowBranch(plan, github.defaultBranch),
            plan.app.key,
            phase,
          ),
        });
  const recovery = (input.recoveryCopy ?? (await recoveryCopyFiles(deps, input))).files;
  const paths = [
    ...input.paths,
    ...(await providerLockFiles(deps.paths.root, input.paths)),
    ...recovery.map((file) => file.path),
  ];
  const file = planFile(plan);
  const base = workflowBranch(plan, github.defaultBranch);
  const current = await git.currentBranch();
  if (
    recovery.length === 0 &&
    (await onlyPlanRecords(deps, git, paths, file)) &&
    // An earlier commit that waits to be pushed still goes out.
    !(
      input.push &&
      current === chosen.branch &&
      (await hasUnpublishedFiles(deps, git, { branch: chosen.branch, base, paths }))
    )
  ) {
    deps.reporter.info(
      `Only the plan's records changed (such as when the app was first deployed), so OpsCrew opened no pull request: ${file} goes with the next change.`,
    );
    const open = chosen.branch === current ? chosen.pullRequest?.url : undefined;
    return {
      branch: current,
      base,
      published: false,
      pushed: false,
      ...(open !== undefined ? { prUrl: open } : {}),
    };
  }
  const copy = copyPath(deps.paths);
  const flag = (await planWhere(deps.paths.root, plan)).flag;
  const secretsStored = input.secretsStored !== false;
  // The first setup adds the workflow that deploys (or, for previews, the preview workflow); the
  // plan file may be on the base branch already, as `opscrew adapt` commits it.
  const workflow =
    plan.environment?.previews !== undefined ? previewWorkflowPath(plan) : plan.cicd.workflowPath;
  const firstSetup = (changes: readonly PathChange[]): Proposal => ({
    title: `OpsCrew: deployment infrastructure for ${plan.app.name}`,
    body: deploySetupPullRequestBody(plan, deps.version, {
      flag,
      secretsStored,
      ...(input.dependabot !== undefined ? { dependabot: input.dependabot } : {}),
      ...(changes.some((change) => change.path === copy) ? { recoveryCopy: copy } : {}),
    }),
    commitMessage: `chore(opscrew): deployment infrastructure for ${plan.app.name}\n\nGenerated by OpsCrew ${deps.version} from ${file}.`,
  });
  return commitAndPropose(deps, {
    git,
    github,
    plan,
    chosen,
    files: recovery,
    paths,
    what: "the deployment files",
    describe: (changes) =>
      changes.some((change) => change.added && change.path === workflow)
        ? firstSetup(changes)
        : deploymentUpdate(plan, deps.version, changes, { copy, flag, secretsStored }),
    push: input.push,
    phase,
  });
}

/**
 * The `.terraform.lock.hcl` files that `tofu init` / `terraform init` wrote beside the IaC in
 * `paths` (one per folder with a `.tf` or `.tofu` file, once initialised). They pin the providers'
 * checksums and belong in git, so they are committed with the IaC they lock.
 */
async function providerLockFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const dirs = new Set(
    paths.filter((p) => /\.(?:tf|tofu)(?:\.json)?$/.test(p)).map((p) => posix.dirname(p)),
  );
  const locks = [...dirs].map((dir) => posix.join(dir, ".terraform.lock.hcl"));
  const found = await Promise.all(locks.map((lock) => exists(join(root, lock))));
  return locks.filter((_, i) => found[i]);
}

/**
 * True when GitHub lacks `paths` as HEAD has them (an earlier run's commit whose push was
 * refused): they differ from `branch` on GitHub or, when GitHub has no such branch (before its
 * first push, or deleted after its pull request was merged, squashed or rebased), from `base`
 * there. Only `paths` are compared, since `base` may have moved on with other commits. A commit
 * this clone does not have counts as different.
 */
async function hasUnpublishedFiles(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  git: GitClient,
  input: { branch: string; base: string; paths: readonly string[] },
): Promise<boolean> {
  const onGitHub =
    (await git.remoteBranchSha(input.branch)) ?? (await git.remoteBranchSha(input.base));
  if (onGitHub === undefined) return true;
  const diff = await deps.runner.run("git", [
    "-C",
    deps.paths.root,
    "diff",
    "--quiet",
    onGitHub,
    "HEAD",
    "--",
    ...input.paths,
  ]);
  return diff.exitCode !== 0;
}

/**
 * The commit, push and pull request every OpsCrew pull request shares: writes `files` and stages
 * `paths`; when none of `paths` is staged, and GitHub has `paths` as the deploy branch this clone is on
 * has them, it stops there (no branch, push or pull request; the current branch's open pull
 * request is named, or else, on a deploy branch whose files are already on the base branch, how
 * to switch back). Otherwise it switches to `chosen.branch` and commits `paths` alone (changes the
 * user staged themselves stay staged, uncommitted), then (when
 * `push`) pushes and opens the pull request `title` with `body`, or adds to the open one, each
 * after its own approval. A refused push or pull request is not an error: the commit stays local
 * and the user is told how to continue. The checkout stays on the deploy branch; after opening the
 * pull request it says how to get back to the user's branch. `what` names the files in the
 * messages. The commit message, title and body are fixed, or come from `describe`: given this
 * commit's changed files for the commit message, and the pull request's (what the branch changes
 * since it left the base branch as this clone last fetched it) for its title and body. With
 * `describe`, an open pull request gets the new title and body after its own approval; when git
 * cannot tell what the branch changes, an open one keeps its text and a new one describes this
 * commit.
 */
export async function commitAndPropose(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: Pick<DeployPlan, "cicd" | "environment">;
    chosen: DeployBranch;
    files: readonly RenderedFile[];
    paths: readonly string[];
    what: string;
    push: boolean;
    phase?: PublishPhase;
  } & (Proposal | { describe: (changes: readonly PathChange[]) => Proposal }),
): Promise<PublishResult> {
  const { git, github, plan, chosen, paths } = input;
  const branch = chosen.branch;
  const base = workflowBranch(plan, github.defaultBranch);
  /** This commit's staged changes, for the commit message (and when the branch's diff fails). */
  let committed: PathChange[] = [];
  /** The text for `changes`: fixed, or from `describe`. */
  const textFor = (changes: readonly PathChange[]): Proposal =>
    "describe" in input ? input.describe(changes) : input;
  /**
   * The text for what the branch changes since it left the base branch (as this clone last
   * fetched it from GitHub, else this clone's own); `undefined`, with a warning, when git cannot
   * tell (no merge base, a shallow clone).
   */
  const branchText = async (): Promise<Proposal | undefined> => {
    if (!("describe" in input)) return input;
    const from = (await lastFetchedTip(git, base)) ?? base;
    let changes: PathChange[];
    try {
      // Every file of the branch, OpsCrew's earlier runs' too, not only this run's paths.
      changes = await changesOf(deps, [`${from}...HEAD`]);
    } catch (error) {
      deps.reporter.warn(
        deps.redactor.redact(
          `OpsCrew could not tell what ${branch} changes since it left ${base} (${(error as Error).message}).`,
        ),
      );
      return undefined;
    }
    return input.describe(changes);
  };
  const phase = input.phase !== undefined ? { phase: input.phase } : {};
  const current = await git.currentBranch();
  for (const file of input.files) {
    await writeFileAtomic(join(deps.paths.root, file.path), file.content, {
      mode: file.mode ?? 0o644,
    });
  }
  await git.add(paths);
  const staged = await git.hasStagedChanges(paths);
  const unpushed =
    !staged &&
    input.push &&
    current === branch &&
    (await hasUnpublishedFiles(deps, git, { branch, base, paths }));
  if (!staged && !unpushed) {
    const open = branch === current ? chosen.pullRequest?.url : undefined;
    deps.reporter.info(
      open !== undefined
        ? `${upperFirst(input.what)} did not change, so OpsCrew committed nothing. The pull request from earlier is still open: ${open}`
        : input.push && current !== base
          ? `${upperFirst(input.what)} did not change and are already on ${base} on GitHub, so OpsCrew committed nothing and opened no pull request. Your deploy pull request is merged: switch to ${base} and pull (\`git switch ${base} && git pull\`).`
          : `${upperFirst(input.what)} did not change, so OpsCrew committed nothing and opened no pull request.`,
    );
    return {
      branch: current,
      base,
      published: false,
      pushed: false,
      ...(open !== undefined ? { prUrl: open } : {}),
    };
  }
  if (current !== branch) {
    if (await git.branchExists(branch)) await git.checkout(branch);
    else await git.createBranch(branch);
  }
  let commit: string | undefined;
  if (staged) {
    if ("describe" in input) committed = await changesOf(deps, ["--cached"], paths);
    commit = await git.commit(textFor(committed).commitMessage, paths);
    await deps.audit.append({
      kind: "git",
      actor: "opscrew",
      action: "commit",
      ...phase,
      target: branch,
      detail: commit,
    });
    deps.reporter.success(`Committed ${input.what} on branch ${branch}.`);
  }
  const result: PublishResult = {
    branch,
    base,
    published: true,
    pushed: false,
    ...(commit ? { commit } : {}),
  };
  if (!input.push) {
    deps.reporter.info(
      `The files are committed on ${branch}. Push it and open a pull request into ${base} when you are ready.`,
    );
    return result;
  }

  const repo = `${github.owner}/${github.repo}`;
  const push = await deps.approvals.request({
    kind: "git-push",
    title: `Push branch ${branch} to ${repo}`,
    details: `Files:\n${paths.map((p) => `  ${p}`).join("\n")}`,
  });
  if (!push.approved) {
    deps.reporter.warn(
      `Not pushed. The commit stays on the local branch ${branch}; push it yourself and open a pull request into ${base}.`,
    );
    return result;
  }
  await git.push(branch, { setUpstream: true });
  result.pushed = true;
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "push",
    ...phase,
    target: `${repo}:${branch}`,
    decision: "approved",
  });

  const existing =
    chosen.pullRequest ?? (await github.api.findOpenPullRequest(github.owner, github.repo, branch));
  if (existing) {
    result.prUrl = existing.url;
    // Fixed text describes only this run's files, so only text built from the branch's whole
    // change replaces what the open pull request says.
    if (!("describe" in input)) {
      deps.reporter.info(`The pull request is already open: ${existing.url}`);
      return result;
    }
    const text = await branchText();
    if (text === undefined) {
      deps.reporter.warn(
        `Pushed to the open pull request ${existing.url}; its title and body stay as they were.`,
      );
      return result;
    }
    const { title, body } = text;
    const update = await deps.approvals.request({
      kind: "pull-request",
      title: `Update the open pull request ${existing.url} to "${title}"`,
      details: body,
    });
    if (!update.approved) {
      deps.reporter.warn(
        `Pushed to the open pull request ${existing.url}; its title and body stay as they were.`,
      );
      return result;
    }
    await github.api.updatePullRequest({
      owner: github.owner,
      repo: github.repo,
      number: existing.number,
      title,
      body,
    });
    await deps.audit.append({
      kind: "git",
      actor: "opscrew",
      action: "pull-request-update",
      ...phase,
      target: existing.url,
      decision: "approved",
    });
    deps.reporter.success(
      `Pushed to the open pull request ${existing.url} and updated its title and body.`,
    );
    return result;
  }
  // When git cannot tell what the branch changes, the text says what this commit changes.
  const { title, body } = (await branchText()) ?? textFor(committed);
  const pr = await deps.approvals.request({
    kind: "pull-request",
    title: `Open the pull request "${title}" into ${base}`,
    details: body,
  });
  if (!pr.approved) {
    deps.reporter.warn(
      `No pull request opened. Open one from ${branch} into ${base} when you are ready.`,
    );
    return result;
  }
  const opened = await github.api.createPullRequest({
    owner: github.owner,
    repo: github.repo,
    head: branch,
    base,
    title,
    body,
  });
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "pull-request",
    ...phase,
    target: opened.url,
    decision: "approved",
  });
  deps.reporter.success(`Opened ${opened.url}`);
  if (current !== branch) {
    deps.reporter.info(
      `Your checkout is on ${branch}, where these files are. After the pull request is merged, run \`git switch ${current} && git pull\` before you commit anything else.`,
    );
  }
  result.prUrl = opened.url;
  return result;
}
