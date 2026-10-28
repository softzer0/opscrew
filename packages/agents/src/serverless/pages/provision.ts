import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import { githubConnector, type PagesHealth } from "@opscrew/connector-github";
import { listText, OpsCrewError, type ProjectPaths } from "@opscrew/core";
import {
  pagesVerificationRootDir,
  renderPagesVerification,
  wrongTarget,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { appFlag } from "../../apps/choice";
import { deploySetupCheck, provisionCheck, resumeCheck } from "../../check/provision";
import type { PhaseDeps } from "../../context";
import { missing, setupCloudflare, setupGitHub } from "../../provision/credentials";
import { deploySetupDependabot } from "../../provision/dependabot";
import { findSavedPlan, planAndApply } from "../../provision/plan-apply";
import { deploymentFiles, deploymentRenderContext } from "../../provision/render";
import {
  deployBranchFor,
  deploymentRecord,
  mergeDeploysNote,
  provisionEngine,
  publicOutputs,
  publishDeployment,
  withLearnedZone,
} from "../../provision/steps";
import type { ProvisionOptions, ProvisionResult } from "../../provision/types";
import {
  approvalEntry,
  approveAndWriteRenderedFiles,
  githubClientFromToken,
  type PlanApproval,
  PlanRefusedError,
  pagesVerificationStateFile,
  readValidJson,
  writePlanIfChanged,
} from "../../shared";
import type { ServerlessProvisionInput } from "../index";
import { storeSiteSecrets } from "../shared";
import {
  pagesHostnames,
  requireCaaAllowsLetsEncrypt,
  requirePagesAllowed,
  requirePagesHostnames,
  requireReplacedDomainReleased,
} from "./checks";
import {
  claimsDomain,
  PagesPlanSchema,
  type PagesStep,
  pagesPlanFile,
  pagesState,
  planPages,
} from "./plan";
import { pagesPlanStep } from "./step";
import { pagesVerificationValue, verificationPage, verifyStepNote } from "./verification";

/** The ending of the verification root's saved plans, which tells them from the site's own. */
const VERIFICATION_PLAN_SUFFIX = "-pages-verification.tfplan";

/**
 * The saved, not yet applied infrastructure plans the `--approve` hashes name, by root: the site's
 * DNS records (`dns`) and GitHub's verification record (`verification`). A hash that names no saved
 * infrastructure plan (the Pages plan's) is left to the approval handler.
 */
async function savedRoots(
  paths: Pick<ProjectPaths, "files">,
  hashes: readonly string[],
): Promise<{ dns?: string; verification?: string }> {
  const found: { dns?: string; verification?: string } = {};
  for (const hash of hashes) {
    const saved = await findSavedPlan(paths.files.plansDir, hash);
    if (saved === undefined || saved.appliedAt !== undefined) continue;
    if (saved.planFile.endsWith(VERIFICATION_PLAN_SUFFIX)) found.verification ??= hash;
    else found.dns ??= hash;
  }
  return found;
}

/** How long GitHub may take to issue a certificate: after that, the domain is saved again. */
const CERTIFICATE_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * True when an applied Pages plan of this app (a `pages-apply` approval in the plan, read from
 * its saved file) saved the custom domain `cname` again in the last day: GitHub then has its
 * request for the certificate, and saving it once more would only start that over. After a day
 * without a certificate, the next run saves it again.
 */
async function domainSavedAgain(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  plan: DeployPlan,
  cname: string,
): Promise<boolean> {
  const since = deps.clock.now().getTime() - CERTIFICATE_WAIT_MS;
  for (const approval of plan.approvals) {
    if (approval.kind !== "pages-apply" || Date.parse(approval.at) <= since) continue;
    const saved = await readValidJson(
      pagesPlanFile(deps.paths, approval.planHash),
      PagesPlanSchema,
    );
    const again = saved?.steps.some(
      (step) =>
        step.kind === "save-domain-again" && step.cname.toLowerCase() === cname.toLowerCase(),
    );
    if (again === true) return true;
  }
  return false;
}

/**
 * `work`, whose refusal says what this run applied before it (`done`) instead of "Nothing was
 * changed", when it applied something.
 */
async function afterChanges<T>(work: () => Promise<T>, done: readonly string[]): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof PlanRefusedError) || done.length === 0) throw error;
    throw new PlanRefusedError(
      {
        ...error.refusal,
        unchanged: `OpsCrew applied ${listText(done)} in this run; nothing else was changed.`,
      },
      error,
    );
  }
}

/** What is left for HTTPS after this run, in a sentence; `undefined` once it is enforced. */
function httpsNote(input: {
  domain: string;
  command: string;
  applied: readonly PagesStep["kind"][];
  enforced: boolean;
  health: PagesHealth | undefined;
}): string | undefined {
  const { domain, command, applied, health } = input;
  if (applied.includes("enforce-https")) {
    return `HTTPS is enforced for ${domain}: GitHub redirects http:// to https://.`;
  }
  if (input.enforced) return undefined;
  if (applied.includes("save-domain-again")) {
    return `GitHub is issuing the certificate for ${domain} now, which usually takes a minute or two. Run \`${command}\` again in a few minutes: it enforces HTTPS once the certificate is there (\`opscrew verify\` shows when).`;
  }
  if (health?.dns === "error" || health?.certificate === "error") {
    return `GitHub reports a problem with the DNS records of ${domain} or its certificate (a record proxied by Cloudflare or a CAA record can cause it), so it cannot serve the site over HTTPS yet. \`opscrew verify\` shows what it finds; once that is fixed, run \`${command}\` again.`;
  }
  if (health?.dns === "ok") {
    return `GitHub has not issued the certificate for ${domain} yet; that can take up to 24 hours. \`opscrew verify\` shows when it is there; then run \`${command}\` to enforce HTTPS. If it still has not come a day after OpsCrew saved the domain again, run \`${command}\` once more: it saves the domain again, which leaves it with no site claiming it for about a second (verifying the domain in your GitHub settings removes that gap).`;
  }
  return `GitHub checks the DNS records of ${domain} next, which can take an hour or more; until then the site answers over HTTP only. Then run \`${command}\` again: it asks GitHub for the site's certificate and enforces HTTPS once GitHub has issued it (\`opscrew verify\` shows when).`;
}

/**
 * `opscrew provision` for a site on GitHub Pages (plan.md "9."), in the takeover-safe order:
 *
 * 1. The checks, before any change: the GitHub and Cloudflare tokens, the repository's plan
 *    (`pagesAllowed`), the site's hostnames (no record proxied by Cloudflare and none the site does
 *    not get), CAA records that keep GitHub from Let's Encrypt, the deploy branch, and the value
 *    of GitHub's verification record (`--pages-verification`, the verification root's committed
 *    values, or a prompt).
 * 2. The Pages plan (`pages-apply`): the site published by the workflow and its custom domain,
 *    set before any DNS record points at GitHub; once GitHub sees the records valid, the domain
 *    saved again so GitHub requests the certificate; once it is issued, HTTPS enforced.
 * 3. The files: the site's DNS root, the verification root, the workflow and Dependabot's
 *    configuration (`repo-write`).
 * 4. The infrastructure plans (`iac-apply`), one per root: the site's DNS records, then the
 *    verification record, whose state is {@link pagesVerificationStateFile}.
 * 5. The record in the plan, the app's values for its build (`github-secrets`), and the workflow
 *    pull request; then the manual Verify step with its page, and what is left for HTTPS.
 *
 * With `--plan-only` it shows and saves every plan and changes nothing.
 */
export async function provisionPages(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: ServerlessProvisionInput,
): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const planOnly = options.planOnly === true;
  let plan = input.plan;
  if (plan.target.provider !== "github-pages") {
    throw wrongTarget("This step only applies to a site on GitHub Pages.");
  }
  const domain = plan.dns.domain;
  if (domain === undefined) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      "The plan has no domain, and a site on GitHub Pages needs one on Cloudflare.",
      { hint: "Run `opscrew interview` and `opscrew design` again." },
    );
  }
  const command = `opscrew provision${await appFlag(deps.paths.root, plan.app.key)}`;
  const root = deps.paths.root;

  // 1. The checks, before any change.
  deps.reporter.step("Checking your Cloudflare and GitHub access");
  const github = await setupGitHub(deps, input.git, services);
  const { owner, repo } = github;
  const cloudflare = await setupCloudflare(deps, plan, services);
  const api = services.cloudflare ?? cloudflareConnector(deps).client;
  if (cloudflare === undefined || !api) {
    throw missing("Cloudflare", cloudflareConnector(deps).credentials);
  }
  const pages = await githubClientFromToken(deps);
  if (pages === undefined) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  await requirePagesAllowed(deps, pages, github);
  const learned = withLearnedZone(deps, plan, cloudflare, command);
  plan = learned.plan;
  const checks = {
    api,
    zoneId: cloudflare.zoneId,
    zone: cloudflare.zoneName,
    hostnames: pagesHostnames({ domain, www: plan.dns.www }),
    command,
  };
  await requirePagesHostnames(deps, { ...checks, owner });
  await requireCaaAllowsLetsEncrypt(deps, checks);
  const page = verificationPage(owner, (await github.api.account(owner)).type);
  const verification = await pagesVerificationValue(deps, {
    plan,
    domain,
    page,
    given: options.pagesVerification,
    ask: services.askPagesVerification,
    command,
  });
  // Not `input.saved`: that names one infrastructure plan, and this target has two roots.
  const saved = await savedRoots(deps.paths, options.approveHashes ?? []);
  const deployBranch = await deployBranchFor(deps, {
    git: input.git,
    github,
    plan,
    phase: "provision",
    commits: !planOnly,
    push: options.push !== false,
  });

  // 2. The Pages plan: GitHub's health check only once the site claims the domain.
  const site = await pages.getPages(owner, repo);
  const before = pagesState(site);
  const health = claimsDomain(before, domain) ? await pages.pagesHealth(owner, repo) : undefined;
  const pagesPlan = planPages({
    owner,
    repo,
    site,
    cname: domain,
    ...(health !== undefined ? { health } : {}),
    savedAgain: await domainSavedAgain(deps, plan, domain),
  });
  // Another domain is replaced only once no record points it at GitHub Pages any more.
  for (const step of pagesPlan.steps) {
    if (step.kind === "set-domain" && step.replaces !== undefined) {
      await requireReplacedDomainReleased(deps, { api, replaced: step.replaces, owner, command });
    }
  }
  const pagesStep = await pagesPlanStep(deps, {
    api: pages,
    plan: pagesPlan,
    planOnly,
    command,
    app: plan.app.name,
  });
  const done: string[] = [];
  if (pagesStep.approval !== undefined) {
    // Recorded at once: a later run must know the domain was saved again.
    plan = { ...plan, approvals: [...plan.approvals, approvalEntry(pagesStep.approval)] };
    await writePlanIfChanged(deps, plan);
    done.push(`the Pages plan ${pagesStep.hash}`);
  }

  // 3. The files.
  const ctx = await deploymentRenderContext(deps, {
    plan,
    requirements: input.requirements,
    github,
    deployPublicKey: "",
    cloudflare,
  });
  // Applying a saved plan keeps the infrastructure code the --plan-only run wrote, which that plan
  // was made from.
  const writes = saved.dns === undefined && saved.verification === undefined;
  const dependabot = await deploySetupDependabot(deps, plan, { writes });
  const siteFiles = deploymentFiles(plan, ctx);
  const verificationFiles = renderPagesVerification(plan, ctx, verification);
  // The scheduled check's files, rendered from every app's and environment's plan.
  const check = await deploySetupCheck(deps, plan, github);
  const files = [
    ...siteFiles,
    ...verificationFiles,
    ...(dependabot?.action === "write" ? [dependabot.file] : []),
    ...check.files,
  ];
  await approveAndWriteRenderedFiles(
    deps,
    root,
    writes ? files : files.filter((file) => file.kind !== "infra"),
    done.length === 0
      ? {}
      : {
          refused: `OpsCrew applied ${listText(done)}; it wrote no files and created no DNS records. Run \`${command}\` again to finish.`,
        },
  );

  // 4. The infrastructure plans: the site's DNS records, then GitHub's verification record.
  const { engine, env } = await provisionEngine(deps, plan, options);
  const common = {
    engine,
    env,
    deployPlan: plan,
    command,
    phase: "provision" as const,
    costDelta: null,
    ...(planOnly ? { planOnly: true } : {}),
  };
  const dns = await afterChanges(
    () =>
      planAndApply(deps, {
        ...common,
        dir: join(root, plan.infra.dir),
        files: siteFiles,
        approvalTitle: `Apply the infrastructure plan on Cloudflare: the DNS records of ${domain} for GitHub Pages`,
        ...(saved.dns !== undefined ? { approvePlanHash: saved.dns } : {}),
      }),
    done,
  );
  if (dns.applied) done.push("the DNS records");
  const record = await afterChanges(
    () =>
      planAndApply(deps, {
        ...common,
        dir: join(root, pagesVerificationRootDir(plan)),
        files: verificationFiles,
        statePath: pagesVerificationStateFile(deps.paths),
        planSuffix: VERIFICATION_PLAN_SUFFIX,
        planNoun: "plan of GitHub's verification record",
        approvalTitle: `Apply the infrastructure plan on Cloudflare: GitHub's domain verification record for ${domain}`,
        ...(saved.verification !== undefined ? { approvePlanHash: saved.verification } : {}),
      }),
    done,
  );
  const hashes = {
    ...(dns.planHash !== undefined ? { planHash: dns.planHash } : {}),
    ...(pagesStep.plan.steps.length > 0 ? { pagesPlanHash: pagesStep.hash } : {}),
    ...(record.plan !== undefined && record.plan.changes.length > 0 && record.planHash
      ? { pagesVerificationPlanHash: record.planHash }
      : {}),
  };
  if (planOnly) {
    if (learned.zoneLearned) await writePlanIfChanged(deps, plan);
    return { ...hashes, applied: false, outputs: {} };
  }

  // 5. The record, the app's values for its build, the pull request, and what is left.
  const approvals: PlanApproval[] = [dns.approval, record.approval].flatMap((approval) =>
    approval === undefined ? [] : [approvalEntry(approval)],
  );
  plan = deploymentRecord(deps, { plan, url: `https://${domain}`, iac: dns, approvals })(
    pagesStep.applied.length > 0 || record.applied,
  );
  await writePlanIfChanged(deps, plan);
  // A site without values has no deploy secrets.
  const secretsStored =
    plan.app.env.length === 0 ||
    (await storeSiteSecrets(deps, {
      github,
      plan,
      services,
      store: options.secrets !== false,
      done: "The GitHub Pages site and its DNS records are set up; its build gets none of the app's values yet.",
    }));
  // The scheduled check's secrets: only the webhook's here, with no server to read.
  await provisionCheck(deps, {
    plan,
    github,
    storeSecrets: options.secrets !== false,
    services,
    command,
    phase: "provision",
  });
  const published = await publishDeployment(deps, {
    git: input.git,
    github,
    plan,
    files: [...files.map((file) => file.path), ...check.removed],
    push: options.push !== false,
    secretsStored,
    phase: "provision",
    branch: deployBranch,
    dependabot,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  });
  const merge = mergeDeploysNote(published.plan, published.published, options.secrets !== false);
  if (secretsStored && merge !== undefined) deps.reporter.info(merge);
  // The site is set up again: a pause of its check (a teardown) ends.
  await resumeCheck(deps, github, plan, { command, phase: "provision" });
  if (record.applied) deps.reporter.info(verifyStepNote({ owner, domain, page }));
  const https = httpsNote({
    domain,
    command,
    applied: pagesStep.applied,
    enforced: before.enabled && before.httpsEnforced,
    health,
  });
  if (https !== undefined) deps.reporter.info(https);
  return {
    ...hashes,
    applied: dns.applied || record.applied,
    outputs: publicOutputs(dns.outputs),
    branch: published.published.branch,
    base: published.published.base,
    ...(published.published.prUrl ? { prUrl: published.published.prUrl } : {}),
    published: published.published.published,
    pushed: published.published.pushed,
  };
}
