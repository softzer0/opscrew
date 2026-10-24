/**
 * `opscrew drift` for the server-less targets (feature 016, FR-1608), read-only. On Cloudflare's
 * hosting: the Worker's shell, its `workers.dev` and preview settings and its custom domains in the
 * IaC state against the live account, the custom domains against the plan's hostnames, and the
 * zone's shared rules (the `www` redirect). On GitHub Pages: the site's DNS records and GitHub's
 * verification record in their IaC states, and the Pages site against the plan.
 */
import { join } from "node:path";
import type { CloudflareClient } from "@opscrew/connector-cloudflare";
import { githubConnector, type PagesHealth, type PagesSite } from "@opscrew/connector-github";
import type { ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { exists, tfstateFile } from "@opscrew/core";
import { pagesVerificationRootDir } from "@opscrew/iac-templates";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { missing, setupCloudflare } from "../provision/credentials";
import { sharedCloudflareClient } from "../provision/shared-cloudflare";
import {
  gitClient,
  githubClientFromToken,
  githubCoordinates,
  pagesVerificationStateFile,
} from "../shared";
import { verifyHosts } from "../verify/checks";
import { cloudflareRulesDrift } from "./cloudflare-rules";
import { compareInfrastructure, driftEngine, finishDriftReport, inspectState } from "./infra";
import type { DriftOptions, DriftReport, SiteDifference } from "./types";

/**
 * Terraform creates the Worker's shell once and never updates it (`ignore_changes = all`): each
 * deploy uploads new code and settings with Wrangler, so an update of the script read back is the
 * deploys', never drift. Only its deletion is.
 */
const WORKER_SCRIPT = "cloudflare_workers_script";

/**
 * How the Worker's custom domains differ from the plan's hostnames: one gone (it no longer
 * answers there), or one the plan does not have (added outside OpsCrew).
 */
async function workerDomainDifferences(
  client: Pick<CloudflareClient, "listWorkerCustomDomains">,
  input: { accountId: string; worker: string; hostnames: readonly string[]; flag: string },
): Promise<SiteDifference[]> {
  const { worker, flag } = input;
  const domains = await client.listWorkerCustomDomains(input.accountId, worker);
  const listed = new Set(domains.map((domain) => domain.hostname.toLowerCase()));
  const planned = new Set(input.hostnames.map((hostname) => hostname.toLowerCase()));
  const missingDomains = input.hostnames.filter((hostname) => !listed.has(hostname.toLowerCase()));
  const extra = domains.filter((domain) => !planned.has(domain.hostname.toLowerCase()));
  return [
    ...missingDomains.map((hostname) => ({
      title: `${hostname} is no longer a custom domain of the Worker ${worker}`,
      detail: `It was removed or moved to another Worker outside OpsCrew, so the site does not answer there. \`opscrew provision${flag}\` sets it up again (it shows the infrastructure plan first).`,
    })),
    ...extra.map((domain) => ({
      title: `${domain.hostname} is a custom domain of the Worker ${worker} that the plan does not have`,
      detail: `It was added outside OpsCrew, so the site answers there too. \`opscrew provision${flag}\` leaves it alone: remove it in the Cloudflare dashboard (Workers & Pages → ${worker} → Settings → Domains & Routes) unless you want it.`,
    })),
  ];
}

/**
 * How the GitHub Pages site differs from the plan: Pages off, built from a branch, another custom
 * domain or none, or HTTPS not enforced although GitHub has issued the certificate. A certificate
 * GitHub has not issued yet is no difference: `note` says so.
 */
function pagesDifferences(
  site: PagesSite | undefined,
  health: PagesHealth | undefined,
  input: { domain: string; repository: string; flag: string },
): { differences: SiteDifference[]; note?: string } {
  const { domain, repository } = input;
  const provision = `\`opscrew provision${input.flag}\``;
  if (site === undefined) {
    return {
      differences: [
        {
          title: `GitHub Pages is off for ${repository}`,
          detail: `The DNS records of ${domain} still point at GitHub while no site claims the domain, so another GitHub Pages site could take it over. ${provision} turns Pages on again with ${domain} (it shows the Pages plan first).`,
        },
      ],
    };
  }
  const differences: SiteDifference[] = [];
  if (site.buildType !== "workflow") {
    differences.push({
      title: `The GitHub Pages site of ${repository} is built from a branch, not published by OpsCrew's deploy workflow`,
      detail: `${provision} switches it back to the workflow (it shows the Pages plan first); the site and its custom domain stay.`,
    });
  }
  if (site.cname?.toLowerCase() !== domain.toLowerCase()) {
    differences.push(
      site.cname === undefined
        ? {
            title: `The GitHub Pages site of ${repository} has no custom domain, not ${domain}`,
            detail: `The DNS records of ${domain} still point at GitHub while no site claims the domain, so another GitHub Pages site could take it over. ${provision} sets ${domain} again (it shows the Pages plan first).`,
          }
        : {
            title: `The GitHub Pages site of ${repository} has the custom domain ${site.cname}, not ${domain}`,
            detail: `No site claims ${domain} while its DNS records point at GitHub, so another GitHub Pages site could take it over. ${provision} sets ${domain} again (it shows the Pages plan first, and stops until no DNS record points ${site.cname} at GitHub).`,
          },
    );
    return { differences };
  }
  if (site.httpsEnforced) return { differences };
  if (health?.certificate === "issued") {
    differences.push({
      title: `HTTPS is not enforced for ${domain}`,
      detail: `GitHub has issued the certificate, but visitors who type http:// are not sent to https://. ${provision} enforces HTTPS (it shows the Pages plan first).`,
    });
    return { differences };
  }
  return {
    differences,
    note: `GitHub has not issued the certificate for ${domain} yet, so HTTPS is not enforced; ${provision} enforces it once GitHub has (\`opscrew verify${input.flag}\` shows when).`,
  };
}

/** The refresh-only drift without the Worker shell's updates ({@link WORKER_SCRIPT}). */
function withoutWorkerUpdates(drift: readonly ResourceDrift[]): ResourceDrift[] {
  return drift.filter((entry) => entry.type !== WORKER_SCRIPT || entry.action !== "update");
}

/** `opscrew drift` on Cloudflare's hosting (see the module's comment). */
async function workersDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  target: CloudflareWorkersDeployTarget,
  options: DriftOptions,
  flag: string,
): Promise<DriftReport> {
  const services = options.services ?? {};
  const statePath = tfstateFile(deps.paths);
  const stateKind = await inspectState(deps, statePath);
  deps.reporter.step("Checking your Cloudflare access");
  const cloudflare = await setupCloudflare(deps, plan, services, { foreignRecords: "report" });
  // The schema gives every plan on Cloudflare's hosting a domain on Cloudflare.
  if (cloudflare === undefined) throw new Error("A Cloudflare hosting plan without a domain.");
  const cloudflareRules = await cloudflareRulesDrift(deps, services);
  const { engine, env } = await driftEngine(deps, plan, options, stateKind);
  const compared = await compareInfrastructure(deps, {
    plan,
    engine,
    engineEnv: env,
    statePath,
    mirrored: {},
    changedFiles: [],
  });
  deps.reporter.step("Reading the Worker's custom domains at Cloudflare (nothing is changed)");
  const site = await workerDomainDifferences(sharedCloudflareClient(deps, services), {
    accountId: cloudflare.accountId,
    worker: target.worker,
    hostnames: verifyHosts(plan),
    flag,
  });
  return finishDriftReport(deps, plan, {
    drift: withoutWorkerUpdates(compared.drift),
    pending: compared.pending,
    files: { changed: [], created: [] },
    foreignDnsRecords: [],
    site,
    ...(cloudflareRules !== undefined ? { cloudflareRules } : {}),
    engine: engine.info,
    provider: "cloudflare-workers",
    notes: compared.notes,
  });
}

/** `opscrew drift` on GitHub Pages (see the module's comment). */
async function pagesDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DriftOptions,
  flag: string,
): Promise<DriftReport> {
  const services = options.services ?? {};
  // The schema gives every plan on GitHub Pages a domain on Cloudflare.
  const domain = plan.dns.domain as string;
  const statePath = tfstateFile(deps.paths);
  const stateKind = await inspectState(deps, statePath);
  deps.reporter.step("Checking your Cloudflare and GitHub access");
  await setupCloudflare(deps, plan, services, { foreignRecords: "report" });
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  const github = await githubClientFromToken(deps);
  if (github === undefined) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  const { engine, env } = await driftEngine(deps, plan, options, stateKind);
  const common = { plan, engine, engineEnv: env, mirrored: {}, changedFiles: [] };
  const records = await compareInfrastructure(deps, { ...common, statePath });
  let drift: ResourceDrift[] = records.drift;
  let pending: ResourceChange[] = records.pending;
  const notes = [...records.notes];
  // GitHub's verification record, in its own root and state, once provision created it.
  const verificationState = pagesVerificationStateFile(deps.paths);
  if (await exists(verificationState)) {
    const verification = await compareInfrastructure(deps, {
      ...common,
      statePath: verificationState,
      dir: join(deps.paths.root, pagesVerificationRootDir(plan)),
    });
    drift = [...drift, ...verification.drift];
    pending = [...pending, ...verification.pending];
    notes.push(...verification.notes);
  }
  deps.reporter.step("Reading the GitHub Pages site (nothing is changed)");
  const site = await github.getPages(owner, repo);
  const claims = site?.cname?.toLowerCase() === domain.toLowerCase();
  const health = claims ? await github.pagesHealth(owner, repo) : undefined;
  const pages = pagesDifferences(site, health, {
    domain,
    repository: `${owner}/${repo}`,
    flag,
  });
  if (pages.note !== undefined) notes.push(pages.note);
  return finishDriftReport(deps, plan, {
    drift,
    pending,
    files: { changed: [], created: [] },
    foreignDnsRecords: [],
    site: pages.differences,
    engine: engine.info,
    provider: "github-pages",
    notes,
  });
}

/**
 * `opscrew drift` for a site on Cloudflare's hosting or GitHub Pages (see the module's comment).
 * Read-only: its plans are written under `.opscrew/plans/drift-*.tfplan` without a sidecar and
 * deleted afterwards, as for servers. Each difference says what `opscrew provision` does about it.
 */
export async function siteDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DriftOptions,
): Promise<DriftReport> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  return plan.target.provider === "cloudflare-workers"
    ? workersDrift(deps, plan, plan.target, options, flag)
    : pagesDrift(deps, plan, options, flag);
}
