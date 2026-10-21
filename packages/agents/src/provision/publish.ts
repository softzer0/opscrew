import { join } from "node:path";
import type { GitClient, PullRequest } from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, upperFirst, writeFileAtomic } from "@opscrew/core";
import { portainerTarget, type RenderedFile } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { planProvider, providerProfile } from "../providers";
import {
  COPY_PATH,
  keyHandoverNote,
  type RefreshRecoveryOptions,
  refreshRecoveryCopy,
} from "../secrets";
import { type GitHubSetup, portainerCloudflare } from "./credentials";
import { type DependabotStep, dependabotPullRequestLines } from "./dependabot";

/** Branch holding the generated deployment files. */
export const DEPLOY_SETUP_BRANCH = "opscrew/deploy-setup";

/** The review checklist item of every deploy-setup pull request about the workflow's actions. */
const PINNED_ACTIONS_CHECK = "- [ ] The workflow only uses pinned, first-party actions.";

/** The pull request's line for the recovery copy, when it is in the pull request. */
const RECOVERY_COPY_LINE = `- \`${COPY_PATH}\`: the encrypted recovery copy of what OpsCrew keeps on your computer for this app (its generated secrets, the deploy key, the infrastructure state and its records). Only your age key opens it; the names of the files in it are readable. \`opscrew secrets restore\` rebuilds them on another computer.`;

export interface PublishResult {
  /** The branch holding the files: the current one when nothing was committed. */
  branch: string;
  /** This run's commit, when it committed anything. */
  commit?: string;
  prUrl?: string;
  pushed: boolean;
}

/**
 * The pull request's next step: merging it deploys the app to `where` once the deploy secrets are
 * stored; while OpsCrew has no record of them (`secretsStored` false), first `opscrew provision` in
 * a terminal. `ready` says what is set up already.
 */
function nextStepLines(secretsStored: boolean | undefined, ready: string, where: string): string[] {
  return secretsStored === false
    ? [
        `${ready}, but OpsCrew has no record of storing the deploy secrets in GitHub Actions, so a deploy would fail.`,
        `**Before merging, run \`opscrew provision\` in a terminal in the project directory.** It finds nothing to change, asks for the production environment values and stores the secrets. After that, merging this pull request deploys the app to ${where}. When the first deploy finishes, run \`opscrew verify\`.`,
      ]
    : [
        `${ready} and the deploy secrets are stored in GitHub Actions. **Merging this pull request deploys the app to ${where}.** After the first deploy finishes, run \`opscrew verify\`.`,
      ];
}

/** What the deploy-setup pull request's body says beyond the plan. */
interface DeploySetupBodyOptions {
  /** Whether the deploy secrets are known to be stored (default true). */
  secretsStored?: boolean;
  /** Dependabot's configuration: added in this pull request, or the user's and what it lacks. */
  dependabot?: DependabotStep;
  /** Whether the recovery copy (`opscrew/secrets.sops.json`) is in the pull request. */
  recoveryCopy?: boolean;
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
  if (plan.target.provider === "portainer") return portainerPullRequestBody(plan, version, options);
  const profile = providerProfile(planProvider(plan));
  const own = plan.target.provider === "own";
  const tunnel = plan.target.provider === "own" && plan.target.access === "tunnel";
  const host = plan.dns.domain ?? (own ? "your server" : `the ${profile.serverNoun}`);
  const ready = own ? "Your server is prepared" : "The server is already running";
  const infra = own
    ? tunnel
      ? "the Cloudflare Tunnel that serves the app, its DNS records and the Cloudflare Access application GitHub Actions deploys through (works with OpenTofu and Terraform). OpsCrew never creates, reinstalls or deletes your server itself."
      : `${plan.dns.provider === "cloudflare" ? "the Cloudflare DNS records that point the domain at your server" : "the outputs that describe your server"} (works with OpenTofu and Terraform). OpsCrew never creates, reinstalls or deletes your server itself.`
    : `infrastructure code for the ${profile.displayName} ${profile.serverNoun}${plan.dns.provider === "cloudflare" ? " and the Cloudflare DNS records" : ""} (works with OpenTofu and Terraform).`;
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`opscrew/plan.yaml\` for **${plan.app.name}**:`,
    "",
    `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: ${infra}`,
    tunnel
      ? "- `opscrew/runtime/`: Docker Compose and Caddy configuration for the server, and the Cloudflare Tunnel connector (`cloudflared/compose.yaml`; its token is only on the server)."
      : "- `opscrew/runtime/`: Docker Compose and Caddy configuration for the server.",
    `- \`${plan.cicd.workflowPath}\`: builds the image, pushes it to GitHub Container Registry and deploys it on every push to \`${plan.cicd.branch}\`, rolling back when the health check fails.`,
    "- `opscrew/plan.yaml`: the deployment plan. The server's IP address is not in the repository; `opscrew status` shows it on the computer that ran `opscrew provision`.",
    ...(options.recoveryCopy === true ? [RECOVERY_COPY_LINE] : []),
    ...dependabotPullRequestLines(options.dependabot),
    "",
    ...nextStepLines(options.secretsStored, ready, host),
    ...(own
      ? [
          "",
          "OpsCrew cannot turn on backups or snapshots on your own server; backups are your responsibility.",
        ]
      : []),
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
 * template and the `opscrew-deploy` branch it is written to, how new versions reach Portainer, the
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
  return [
    `This pull request adds the deployment setup that OpsCrew generated from \`opscrew/plan.yaml\` for **${plan.app.name}**, which runs as stacks in your Portainer:`,
    "",
    ...(roots.length > 0
      ? [
          `- \`${plan.infra.dir}/\` and \`opscrew/infra/modules/\`: ${roots.join(", and ")} (works with OpenTofu and Terraform).`,
        ]
      : []),
    `- \`opscrew/runtime/compose.yaml\`: the app's stack in your Portainer (the app, its release command and the services it needs). The deploy workflow fills in each new image and writes the file to the \`opscrew-deploy\` branch, which Portainer deploys. The values of its variables live only in the stack's environment in Portainer.`,
    `- \`${plan.cicd.workflowPath}\`: builds the image, pushes it to GitHub Container Registry and writes it to the \`opscrew-deploy\` branch on every push to \`${plan.cicd.branch}\`; ${redeploy}. It checks the site and writes the previous version back when the health check fails.`,
    "- `opscrew/plan.yaml`: the deployment plan. Portainer's address is not in the repository; it stays on the computer that ran `opscrew provision`.",
    ...(options.recoveryCopy === true ? [RECOVERY_COPY_LINE] : []),
    ...dependabotPullRequestLines(options.dependabot),
    "",
    ...nextStepLines(options.secretsStored, "The app's stacks are set up in your Portainer", where),
    ...(dns !== undefined ? ["", dns] : []),
    "",
    PORTAINER_HOST_NOTE,
    PORTAINER_BACKUPS_NOTE,
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

/** {@link DEPLOY_SETUP_BRANCH}, then `-2`, `-3`, … */
function deployBranchName(i: number): string {
  return i === 1 ? DEPLOY_SETUP_BRANCH : `${DEPLOY_SETUP_BRANCH}-${i}`;
}

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
  /** `plan.cicd.branch`: the branch the pull request goes into (usually `main`). */
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
 * `plan.cicd.branch`, so the pull request never carries old or already-merged changes again: a new
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
 * The branch for the deployment files chosen without reaching GitHub: the first of
 * {@link DEPLOY_SETUP_BRANCH}, `-2`, … that is the current branch or does not exist in this clone,
 * so a stale local branch (its pull request merged long ago) is never committed on. Like
 * {@link chooseDeployBranch} it stops with `PHASE_PRECONDITION` unless the files start from
 * `plan.cicd.branch`, here judged by what this clone last fetched (`origin/<branch>`).
 */
export async function localDeployBranch(
  git: GitClient,
  plan: Pick<DeployPlan, "cicd">,
  phase: PublishPhase = "provision",
): Promise<string> {
  const current = await git.currentBranch();
  const check: BaseCheck = { phase, base: plan.cicd.branch, current };
  for (let i = 1; i <= 100; i++) {
    const branch = deployBranchName(i);
    if (branch === current || !(await git.branchExists(branch))) {
      const baseTip = await lastFetchedTip(git, check.base);
      await requireLatestBase(git, check, { branch, baseTip });
      return branch;
    }
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `There are already 100 ${DEPLOY_SETUP_BRANCH} branches in this clone, so OpsCrew did not create another one.`,
    {
      hint: `Delete the old ones with \`git branch -D ${DEPLOY_SETUP_BRANCH}-<n>\`, then try again.`,
    },
  );
}

/**
 * Picks the branch for the deployment files before anything changes, so the push never collides
 * with a branch an earlier run left on GitHub: {@link DEPLOY_SETUP_BRANCH}, or the next free
 * `-2`, `-3`, …. A branch on GitHub whose pull request is merged or closed is skipped (never
 * pushed to), and so is a branch only this clone has unless it is the current branch (a stale
 * local branch is never committed on). One with an open pull request is added to when this clone
 * is on that branch and the push is a fast-forward (its head is in this clone's branch, so OpsCrew
 * pushed it from here); otherwise this throws `PHASE_PRECONDITION` naming the pull request, and
 * nothing is force-pushed. Any other branch must start from the latest `plan.cicd.branch` as
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
  plan: Pick<DeployPlan, "cicd">,
  phase: PublishPhase = "provision",
): Promise<DeployBranch> {
  const command = `opscrew ${phase}`;
  const current = await git.currentBranch();
  const check: BaseCheck = { phase, base: plan.cicd.branch, current };
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
  if (baseTip === null) return { branch: await localDeployBranch(git, plan, phase) };
  for (let i = 1; i <= 100; i++) {
    const branch = deployBranchName(i);
    const sha = await remoteSha(branch);
    if (sha === null) return { branch: await localDeployBranch(git, plan, phase) };
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
  throw branchStop(phase, `there are already 100 ${DEPLOY_SETUP_BRANCH} branches on GitHub`, {
    rerun: "Delete the old ones on GitHub, then try again.",
    retarget: `Delete the old ones on GitHub, then ${PUBLISH_BY_HAND}`,
  });
}

/**
 * The recovery copy's files for the pull request when this computer's files changed since the
 * last copy ({@link refreshRecoveryCopy}, which asks GitHub whether the repository is private only
 * before the copy's first commit), saying where the first key and the folder copy were written, or
 * why there is no copy.
 */
async function recoveryCopyFiles(
  deps: PhaseDeps,
  input: {
    github: GitHubSetup;
    plan: DeployPlan;
    recovery?: Pick<RefreshRecoveryOptions, "recipient" | "keyOut" | "backup">;
  },
): Promise<RenderedFile[]> {
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
  return result.changed ? result.repositoryFiles : [];
}

/**
 * Commits the generated files and the plan on the deploy branch (`input.branch`, chosen with
 * {@link chooseDeployBranch} before anything changed; when absent it is chosen here, or with
 * {@link localDeployBranch} without a push), with the recovery copy's files when this computer's
 * files changed since the last copy, then (when `push`) pushes it and opens a pull request into the
 * deploy branch, each after its own approval. A refused push or pull request is not an error: the
 * commit stays local and the user is told how to continue. When nothing changed and nothing waits
 * to be pushed, it commits, pushes and opens nothing ({@link commitAndPropose}).
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
  },
): Promise<PublishResult> {
  const { git, github, plan } = input;
  const phase = input.phase ?? "provision";
  const chosen =
    input.branch ??
    (input.push
      ? await chooseDeployBranch(deps, git, github, plan, phase)
      : { branch: await localDeployBranch(git, plan, phase) });
  const recovery = await recoveryCopyFiles(deps, input);
  const paths = [...input.paths, ...recovery.map((file) => file.path)];
  const body = deploySetupPullRequestBody(plan, deps.version, {
    secretsStored: input.secretsStored !== false,
    ...(input.dependabot !== undefined ? { dependabot: input.dependabot } : {}),
    recoveryCopy: recovery.some((file) => file.path === COPY_PATH),
  });
  return commitAndPropose(deps, {
    git,
    github,
    plan,
    chosen,
    files: recovery,
    paths,
    commitMessage: `chore(opscrew): deployment infrastructure for ${plan.app.name}\n\nGenerated by OpsCrew ${deps.version} from opscrew/plan.yaml.`,
    what: "the deployment files",
    title: `OpsCrew: deployment infrastructure for ${plan.app.name}`,
    body,
    push: input.push,
    phase,
  });
}

/**
 * True when the deploy branch this clone is on has commits GitHub lacks (an earlier run's commit
 * whose push was refused): HEAD is not in the branch on GitHub, or, before its first push, not in
 * `base` there.
 */
async function hasUnpushedCommits(git: GitClient, branch: string, base: string): Promise<boolean> {
  const pushed = (await git.remoteBranchSha(branch)) ?? (await git.remoteBranchSha(base));
  return pushed === undefined || !(await git.isAncestor("HEAD", pushed));
}

/**
 * The commit, push and pull request every OpsCrew pull request shares: writes `files` and stages
 * `paths`; when nothing is staged, and the deploy branch this clone is on has no commits GitHub
 * lacks, it stops there (no branch, push or pull request, and the current branch's open pull
 * request is named). Otherwise it switches to `chosen.branch`, commits what is staged, then (when
 * `push`) pushes and opens the pull request `title` with `body`, or adds to the open one, each
 * after its own approval. A refused push or pull request is not an error: the commit stays local
 * and the user is told how to continue. `what` names the files in the messages.
 */
export async function commitAndPropose(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: Pick<DeployPlan, "cicd">;
    chosen: DeployBranch;
    files: readonly RenderedFile[];
    paths: readonly string[];
    commitMessage: string;
    what: string;
    title: string;
    body: string;
    push: boolean;
    phase?: PublishPhase;
  },
): Promise<PublishResult> {
  const { git, github, plan, chosen, paths, title, body } = input;
  const branch = chosen.branch;
  const phase = input.phase !== undefined ? { phase: input.phase } : {};
  const current = await git.currentBranch();
  for (const file of input.files) {
    await writeFileAtomic(join(deps.paths.root, file.path), file.content, {
      mode: file.mode ?? 0o644,
    });
  }
  await git.add(paths);
  const staged = (await git.status()).some((e) => e.code[0] !== " " && e.code[0] !== "?");
  const unpushed =
    !staged &&
    input.push &&
    current === branch &&
    (await hasUnpushedCommits(git, branch, plan.cicd.branch));
  if (!staged && !unpushed) {
    deps.reporter.info(
      `${upperFirst(input.what)} did not change, so OpsCrew committed nothing and opened no pull request.`,
    );
    return {
      branch: current,
      pushed: false,
      ...(chosen.pullRequest !== undefined && branch === current
        ? { prUrl: chosen.pullRequest.url }
        : {}),
    };
  }
  if (current !== branch) {
    if (await git.branchExists(branch)) await git.checkout(branch);
    else await git.createBranch(branch);
  }
  let commit: string | undefined;
  if (staged) {
    commit = await git.commit(input.commitMessage);
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
  const result: PublishResult = { branch, pushed: false, ...(commit ? { commit } : {}) };
  if (!input.push) {
    deps.reporter.info(
      `The files are committed on ${branch}. Push it and open a pull request into ${plan.cicd.branch} when you are ready.`,
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
      `Not pushed. The commit stays on the local branch ${branch}; push it yourself and open a pull request into ${plan.cicd.branch}.`,
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
    deps.reporter.info(`The pull request is already open: ${existing.url}`);
    result.prUrl = existing.url;
    return result;
  }
  const pr = await deps.approvals.request({
    kind: "pull-request",
    title: `Open the pull request "${title}" into ${plan.cicd.branch}`,
    details: body,
  });
  if (!pr.approved) {
    deps.reporter.warn(
      `No pull request opened. Open one from ${branch} into ${plan.cicd.branch} when you are ready.`,
    );
    return result;
  }
  const opened = await github.api.createPullRequest({
    owner: github.owner,
    repo: github.repo,
    head: branch,
    base: plan.cicd.branch,
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
  result.prUrl = opened.url;
  return result;
}
