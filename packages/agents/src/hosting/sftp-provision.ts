/**
 * `opscrew provision` for an app on an SFTP-only host (027 plan 10, ADR 0030 D6): one hosting plan,
 * approved by its hash (`hosting-apply`) and applied over SFTP, makes the app's folder with the
 * placeholder release and `current`, the files that load its settings, the settings, and GitHub
 * Actions' SSH key (its private half and the host's reach as the deploy environment's secrets);
 * then the deploy workflow goes into the provision pull request. The hostname, its document root,
 * its certificate and any database are the user's, in the host's panel.
 */
import { OpsCrewError } from "@opscrew/core";
import { detectPhpNeeds } from "@opscrew/detect";
import {
  HOSTING_PHP_VERSIONS,
  renderEnvPhp,
  renderSftpPhpLines,
  SFTP_DEPLOY_SECRETS,
  sftpUrl,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { setupGitHub } from "../provision/credentials";
import { buildAppEnvironment } from "../provision/secrets";
import { deployBranchFor, deploymentRecord } from "../provision/steps";
import type { ProvisionOptions, ProvisionResult, ProvisionServices } from "../provision/types";
import { approvalEntry, type Ed25519KeyPair, writePlanIfChanged } from "../shared";
import { valuesDigest } from "./apply";
import { hostingPlanStep, publishHostingWorkflow, storeHostingSecrets } from "./common";
import { constraintAllows } from "./php";
import { hostingPlanFile } from "./plan";
import type { HostingProvisionInput } from "./provision";
import { environmentOf, type FileContents, hostingTarget, hostnameOf } from "./provision-plans";
import { recordObject } from "./record";
import { reachSftpHost } from "./sftp";
import {
  applySftpPlan,
  buildSftpPlan,
  describeSftpPlan,
  sftpPlanHash,
  sftpPlanTitle,
} from "./sftp-plan";

/** Collaborators a test replaces. */
export interface SftpProvisionServices {
  /** A new Ed25519 pair for GitHub Actions' key (default: a new pair from Node). */
  newKeyPair?: (comment: string) => Ed25519KeyPair;
}

/**
 * The PHP version a release is built with: the plan's, else the newest OpsCrew builds with that
 * the app's `composer.json` allows. OpsCrew can't read the host's PHP over SFTP.
 */
async function phpVersion(deps: PhaseDeps, plan: DeployPlan): Promise<string> {
  const set = hostingTarget(plan).php?.version;
  if (set !== undefined) return set;
  const needs = await detectPhpNeeds(deps.paths.root, plan.app.buildContext);
  const version = [...HOSTING_PHP_VERSIONS].reverse().find((v) => constraintAllows(needs.php, v));
  if (version === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's composer.json allows PHP ${needs.php}, and OpsCrew builds releases with PHP ${HOSTING_PHP_VERSIONS.join(", ")} only. Nothing was changed.`,
      { hint: "Allow one of those versions in composer.json, then run `opscrew provision` again." },
    );
  }
  return version;
}

/**
 * Provisions an app on an SFTP-only host (see the module's comment), in this order:
 * 1. the checks, before any change: a static site or a PHP app with no release command, the host
 *    the interview recorded with its confirmed key, and GitHub;
 * 2. the PHP version the releases are built with (the plan's, else the newest the app allows),
 *    and the app's values (a PHP app's);
 * 3. the hosting plan, shown, saved, approved by its hash and applied over SFTP (with `--plan-only`
 *    shown and saved only); the key's private half goes to GitHub at its step, after the
 *    `github-secrets` approval;
 * 4. where the host doesn't show `~/.ssh/authorized_keys`, the key's line for the user to add in
 *    the host's panel, and provision stops; a run after the user added it continues;
 * 5. the deploy workflow in the provision pull request.
 */
export async function provisionSftp(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: HostingProvisionInput,
  sftpServices: SftpProvisionServices = {},
): Promise<ProvisionResult> {
  const services: ProvisionServices = options.services ?? {};
  const planOnly = options.planOnly === true;
  let plan = input.plan;
  const target = hostingTarget(plan);
  const hostname = hostnameOf(plan);
  const environment = environmentOf(plan);
  const command = `opscrew provision${await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app)}`;

  // 1. The checks.
  if (plan.app.releaseCommand !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "An SFTP-only host runs no release command, so OpsCrew can't deploy an app that needs one there. Nothing was changed.",
      {
        hint: "Remove app.releaseCommand from opscrew/plan.yaml if the app runs without it, or choose a hosting account with a panel or a server target with `opscrew interview`.",
      },
    );
  }
  deps.reporter.step("Checking your SFTP host and GitHub access");
  const reach = await reachSftpHost(deps, plan);
  const github = await setupGitHub(deps, input.git, services);
  const deployBranch = await deployBranchFor(deps, {
    git: input.git,
    github,
    plan,
    phase: "provision",
    commits: !planOnly,
    push: options.push !== false,
  });

  // 2. The PHP version and the app's values.
  const contents: FileContents = new Map();
  let values: { values: Record<string, string>; generated: string[]; digest: string } | undefined;
  if (target.app === "php") {
    const version = await phpVersion(deps, plan);
    if (target.php?.version !== version) {
      plan = { ...plan, target: { ...target, php: { version, via: "account" } } };
      deps.reporter.info(
        `PHP: releases are built with PHP ${version}, the newest the app allows. OpsCrew can't read your host's PHP over SFTP: set the hostname's PHP to ${version} in your host's panel, or set target.php.version in opscrew/plan.yaml to the version it runs.`,
      );
    }
    const built = await buildAppEnvironment(deps, plan, services);
    values = {
      values: built.values.app,
      generated: Object.keys(built.generated.env ?? {}).sort(),
      digest: valuesDigest(built.values.app),
    };
    const lines = renderSftpPhpLines(`${reach.phpFolder}/shared/env.php`);
    contents.set("shared/env.php", renderEnvPhp(Object.keys(values.values).sort()));
    contents.set("shared/env.htaccess", lines.htaccess);
    contents.set("shared/env.user.ini", lines.userIni);
  }
  const { documentRoot } = reach;

  // 3. The hosting plan.
  const sftpPlan = await buildSftpPlan({
    header: { account: reach.account, environment, hostname, folder: reach.folder, documentRoot },
    files: reach.files,
    record: reach.record,
    webRoot: target.webRoot,
    contents,
    values,
  });
  const hash = sftpPlanHash(sftpPlan);
  const outcome = await hostingPlanStep(deps, {
    plan: sftpPlan,
    hash,
    details: describeSftpPlan(sftpPlan, hash),
    title: sftpPlanTitle(sftpPlan),
    file: hostingPlanFile(deps.paths, environment, "sftp"),
    which: "the hosting plan",
    place: "SFTP host",
    changing: "SFTP host",
    auditLabel: "sftp",
    planOnly,
    command,
    apply: (approvedHash) =>
      applySftpPlan(sftpPlan, {
        files: reach.files,
        contents,
        ...(values !== undefined ? { values: values.values } : {}),
        redactor: deps.redactor,
        made: async (object) => {
          await recordObject(deps.paths, object);
        },
        keyComment: `opscrew-${reach.name}`,
        ...(sftpServices.newKeyPair !== undefined ? { newKeyPair: sftpServices.newKeyPair } : {}),
        storeKey: async (privateKey) => {
          plan = await storeHostingSecrets(deps, github, plan, {
            command,
            planOnly,
            secrets: {
              [SFTP_DEPLOY_SECRETS.url]: sftpUrl(reach.sftp, reach.folder),
              [SFTP_DEPLOY_SECRETS.privateKey]: privateKey,
              [SFTP_DEPLOY_SECRETS.knownHosts]: reach.knownHosts,
            },
            about: `Where the SFTP host is, the app's folder there, its host key, and the SSH key GitHub Actions uploads the releases with, which can change every file of the SFTP user ${reach.account}.`,
            refusedState: "Nothing on the SFTP host was changed by it.",
          });
        },
        approvedHash,
      }),
  });
  // As a panel account's: the plan's hash, so the CLI and the MCP tool name the --approve to run.
  if (planOnly) {
    return {
      applied: false,
      outputs: {},
      ...(sftpPlan.steps.length > 0 ? { hostingPlanHashes: [hash] } : {}),
    };
  }

  // 4. The key, in the host's panel; the host is set up either way.
  const approvals = outcome === undefined ? [] : [approvalEntry(outcome.approval)];
  plan = deploymentRecord(deps, {
    plan,
    url: `https://${hostname}`,
    iac: { applied: false },
    approvals,
  })((outcome?.applied.length ?? 0) > 0);
  if (outcome?.keyLine !== undefined) {
    await writePlanIfChanged(deps, plan);
    deps.reporter.warn(
      [
        "Your host doesn't show ~/.ssh/authorized_keys over SFTP, so add GitHub Actions' key to the SFTP user's keys in your host's panel yourself:",
        `  ${outcome.keyLine}`,
        `Then run \`${command}\` again: it writes the deploy workflow.`,
      ].join("\n"),
    );
    return { applied: true, outputs: {} };
  }

  // 5. The workflow and the pull request.
  const published = await publishHostingWorkflow(deps, options, {
    plan,
    requirements: input.requirements,
    git: input.git,
    github,
    cloudflare: undefined,
    branch: deployBranch,
    files: [],
    refused:
      "The SFTP host is set up, but the workflow wasn't written, so nothing deploys yet. Run `opscrew provision` again to write it.",
  });
  deps.reporter.info(
    `In your host's panel, point ${hostname} at ${documentRoot} and give it a certificate: each deploy checks that the hostname serves the new release, and switches back when it doesn't.`,
  );
  if (published.prUrl) {
    deps.reporter.info(
      `Merging ${published.prUrl} deploys the app: GitHub Actions builds each release, uploads it over SFTP and switches ${hostname} to it.`,
    );
  }
  return published;
}
