/**
 * Advise's readings (feature 021, plan.md "5."): what its rules read about one environment,
 * gathered once per run, read-only, the independent sources at once. Each source is optional: what
 * can't be read is listed in `notRead` in plain words, never with an address, a token or a secret,
 * and the rest goes on.
 */
import { type CloudflareClient, cloudflareConnector } from "@opscrew/connector-cloudflare";
import type { GitHubClient } from "@opscrew/connector-github";
import type { CheckResult, UserFacingError } from "@opscrew/contracts";
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { CHECK_LABEL } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  isServerlessProvider,
  type Requirements,
} from "@opscrew/plan-schema";
import { couldNotRun, HOST_CHECKS, ownServerHostChecks, runHostChecks } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { extraCatalogs } from "../design/run";
import { commandFlags } from "../environments/choice";
import { readEnvironmentRequirements } from "../environments/requirements";
import { providerProfile } from "../providers";
import { renderedServers } from "../provision/disk-guard";
import type { ProvisionServices } from "../provision/types";
import { ownServerHardening } from "../secure/own";
import { serverServiceChecks } from "../secure/services";
import {
  gitClient,
  githubClientFromToken,
  githubCoordinates,
  lastHostSetup,
  lastServerSetup,
} from "../shared";
import { appServers } from "../shared/servers";
import { type ResourceReading, readResources, readServerResources } from "../status/resources";
import { serverShell } from "../status/servers";
import { readHistory } from "./history";
import {
  type PriceList,
  type Readings,
  type ServerHistory,
  type ServerReadings,
  THRESHOLDS,
} from "./types";

/** GitHub's reads advise makes (a `GitHubClient`, or a fake in tests). */
export type AdviseGitHub = Pick<
  GitHubClient,
  "dependabotAlerts" | "dependabotPulls" | "issuesSince" | "tokenExpiry"
>;

/** What advise reads through besides `deps`: fakes in tests. */
export interface ReadingsOptions {
  /** The servers' shells by address, the user's own server and Portainer, as `status` reads them. */
  services?: Pick<ProvisionServices, "remote" | "own" | "portainer">;
  /** GitHub's reads (default: the client of the user's token; `null`: no token). */
  github?: AdviseGitHub | null;
  /** The Cloudflare token's check (default: `CLOUDFLARE_API_TOKEN`'s client; `null`: none set). */
  cloudflare?: Pick<CloudflareClient, "verifyToken"> | null;
}

/** One source's lines for the report: what was read, and what couldn't be, with why. */
interface Lines {
  checked: string[];
  notRead: string[];
}

/** A source's value, when it could be read, with its lines. */
type Read<T> = Lines & { value?: T };

const DAY_MS = 86_400_000;

/** What a user-facing error says, with its next step, redacted. */
function told(deps: Pick<PhaseDeps, "redactor">): (error: UserFacingError) => string {
  return (error) => deps.redactor.redact(errorText(error));
}

/**
 * `read`'s value with `what` checked; when it fails as OpsCrew tells users (a missing login, a
 * refusal, a server out of reach), `what` not read with `why` it failed (by default what the error
 * says, redacted). Anything else is a bug and stops the run.
 */
async function attempt<T>(
  deps: Pick<PhaseDeps, "redactor">,
  what: string,
  read: () => Promise<T>,
  why: (error: UserFacingError) => string = told(deps),
): Promise<Read<T>> {
  try {
    return { value: await read(), checked: [what], notRead: [] };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { checked: [], notRead: [`${what}: ${why(error)}`] };
  }
}

/**
 * Why a server couldn't be read, without the error's own text (it can name the server's address),
 * and the `command` that says more.
 */
function unreachable(command: string): (error: UserFacingError) => string {
  return (error) =>
    error.code === "PHASE_PRECONDITION"
      ? `this computer lacks the login or address OpsCrew needs (\`${command}\` says which)`
      : `OpsCrew could not reach it (\`${command}\` says why)`;
}

/** The figures of server `name` now, as `status` reads them. */
async function serverFigures(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: ReadingsOptions["services"],
): Promise<ResourceReading> {
  if (name === APP_SERVER) return readResources(deps, plan, { services });
  const { remote, login } = await serverShell(deps, plan, name, services);
  return readServerResources(deps, plan, name, remote, login.own);
}

/**
 * `secure`'s host checks on server `name` over its login's shell, as `secure` runs them there (on a
 * server the user owns, with what its last setup accepts), audited as `remote-exec` without the
 * address. The results leave out their target, which is the address.
 */
async function hostChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: ReadingsOptions["services"],
): Promise<CheckResult[]> {
  const { login, docker } = await serverShell(deps, plan, name, services);
  const setup = login.own
    ? await (name === APP_SERVER ? lastHostSetup(deps, plan) : lastServerSetup(deps, name))
    : undefined;
  const checks = login.own ? ownServerHostChecks(ownServerHardening(setup, login)) : HOST_CHECKS;
  deps.reporter.step(`Running secure's host checks on server ${name} (read-only)`);
  const results = await runHostChecks(docker, [...checks, ...serverServiceChecks(plan, name)]);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "run secure's host checks (read-only)",
    target: `server ${name}`,
    decision: "allow",
  });
  return results.map(({ target: _address, ...result }) => result);
}

/** True when OpsCrew reaches server `name` over SSH: not a Portainer, this computer or a site. */
function overSsh(plan: DeployPlan, name: string): boolean {
  const { provider } = plan.target;
  return (
    name !== APP_SERVER ||
    provider === "hetzner" ||
    provider === "digitalocean" ||
    provider === "own"
  );
}

/**
 * Server `name`'s figures now and `secure`'s host checks on it, at once; a host check whose
 * command could not run is not read (without its message, which can hold the address).
 */
async function readServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: ReadingsOptions["services"],
  flags: string,
): Promise<Lines & { now?: ResourceReading; checks?: CheckResult[] }> {
  const [figures, checked] = await Promise.all([
    attempt(
      deps,
      `server ${name}'s figures`,
      () => serverFigures(deps, plan, name, services),
      unreachable(`opscrew status${flags}`),
    ),
    overSsh(plan, name)
      ? attempt(
          deps,
          `secure's host checks on server ${name}`,
          () => hostChecks(deps, plan, name, services),
          unreachable(`opscrew secure${flags}`),
        )
      : Promise.resolve<Read<CheckResult[]>>({ checked: [], notRead: [] }),
  ]);
  const now = figures.value;
  const results = checked.value;
  return {
    ...(now === undefined ? {} : { now }),
    ...(results === undefined ? {} : { checks: results.filter((r) => !couldNotRun(r)) }),
    checked: [...figures.checked, ...checked.checked],
    notRead: [
      ...figures.notRead,
      ...(now?.unavailable ?? []).map((entry) => `server ${name}: ${entry}`),
      ...checked.notRead,
      ...(results ?? [])
        .filter(couldNotRun)
        .map((r) => `server ${name}'s host check "${r.title}": its command could not run`),
    ],
  };
}

/**
 * `plan` with each server OpsCrew created at the location and type provision last rendered for it
 * (`renderedServers`, as provision's disk guard reads them): the servers that run. The rules size
 * and price those, so a type `--apply` wrote that provision hasn't applied yet is a proposal the
 * plan already holds.
 */
async function asDeployed(deps: PhaseDeps, plan: DeployPlan): Promise<DeployPlan> {
  const rendered = await renderedServers(deps.paths.root, plan);
  const { target } = plan;
  const app = rendered.get(APP_SERVER);
  const servers = plan.servers?.map((server) => {
    const was = rendered.get(server.name);
    return was === undefined || server.target.provider === "own"
      ? server
      : { ...server, target: { ...server.target, ...was } };
  });
  return {
    ...plan,
    target:
      app !== undefined && (target.provider === "hetzner" || target.provider === "digitalocean")
        ? { ...target, ...app }
        : target,
    ...(servers === undefined ? {} : { servers }),
  };
}

/**
 * The price lists of each server OpsCrew created in `plan` (where it runs) and, for the cost rule's
 * comparison, of the other provider in the interview's region; the catalogue of each provider is
 * read once, live with its token or the dated static list (said in `notRead`).
 */
async function priceLists(
  deps: PhaseDeps,
  plan: DeployPlan,
  requirements: Requirements | undefined,
): Promise<Lines & { lists: PriceList[] }> {
  const warnings: string[] = [];
  const catalogFor = extraCatalogs(deps, undefined, (warning) => warnings.push(warning));
  const wanted = new Map<string, { provider: CloudProvider; location: string }>();
  const want = (provider: CloudProvider, location: string) =>
    wanted.set(`${provider} ${location}`, { provider, location });
  for (const { target } of [{ target: plan.target }, ...(plan.servers ?? [])]) {
    if (target.provider === "hetzner" || target.provider === "digitalocean") {
      want(target.provider, target.location);
    }
  }
  const { target } = plan;
  const region = requirements?.region;
  if ((target.provider === "hetzner" || target.provider === "digitalocean") && region) {
    const other = target.provider === "hetzner" ? "digitalocean" : "hetzner";
    for (const location of providerProfile(other).regionLocations[region]) want(other, location);
  }
  if (wanted.size > 0) deps.reporter.step("Reading the providers' prices (read-only)");
  const read = await Promise.all(
    [...wanted.values()].map(({ provider, location }) =>
      attempt(
        deps,
        `${providerProfile(provider).displayName}'s prices in ${location}`,
        async (): Promise<PriceList> => {
          const catalog = await catalogFor(provider, location);
          const [offers, extras] = await Promise.all([
            catalog.listOffers(location),
            catalog.extras(location),
          ]);
          return { provider, location, offers, extras };
        },
      ),
    ),
  );
  return {
    lists: read.flatMap((r) => (r.value === undefined ? [] : [r.value])),
    checked: read.flatMap((r) => r.checked),
    notRead: [
      ...[...new Set(warnings)]
        .sort()
        .map((warning) => deps.redactor.redact(`live prices: ${warning}`)),
      ...read.flatMap((r) => r.notRead),
    ],
  };
}

/** What GitHub tells advise: Dependabot, the token's expiry, the check's issues. */
type GitHubReadings = Pick<Readings, "check"> &
  Pick<Readings["upkeep"], "dependabot" | "pulls"> & { expiresAt?: string };

/**
 * Dependabot's alerts and pull requests, the GitHub token's expiry and, with the scheduled check
 * on, its issues opened since `since`, at once. A token without "Dependabot alerts: Read" is a
 * line in `notRead`, not a failure.
 */
async function readGitHub(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: ReadingsOptions["github"],
  since: string,
): Promise<Lines & GitHubReadings> {
  const checkOn = plan.observability?.check?.enabled === true;
  const what = listText([
    "Dependabot alerts",
    "Dependabot's open pull requests",
    "the GitHub token's expiry",
    ...(checkOn ? ["the scheduled check's issues"] : []),
  ]);
  const api = github === undefined ? await githubClientFromToken(deps) : github;
  if (api === null || api === undefined) {
    return {
      pulls: [],
      checked: [],
      notRead: [
        `${what}: no GitHub token is available (set GITHUB_TOKEN or run \`gh auth login\`)`,
      ],
    };
  }
  const where = await attempt(deps, what, () => githubCoordinates(gitClient(deps)));
  if (where.value === undefined) return { pulls: [], checked: [], notRead: where.notRead };
  const { owner, repo } = where.value;
  deps.reporter.step("Reading Dependabot's alerts and pull requests at GitHub (read-only)");
  const [alerts, pulls, expiry, issues] = await Promise.all([
    attempt(
      deps,
      "Dependabot alerts",
      () => api.dependabotAlerts(owner, repo),
      (error) =>
        error.code === "CREDENTIALS_INVALID"
          ? 'the GitHub token lacks the permission "Dependabot alerts: Read"; add it to the token to have them read'
          : told(deps)(error),
    ),
    attempt(deps, "Dependabot's open pull requests", () => api.dependabotPulls(owner, repo)),
    attempt(deps, "the GitHub token's expiry", () => api.tokenExpiry()),
    checkOn
      ? attempt(
          deps,
          `the scheduled check's issues of the last ${THRESHOLDS.historyDays} days`,
          () => api.issuesSince(owner, repo, CHECK_LABEL, since),
        )
      : Promise.resolve(undefined),
  ]);
  const sources = [alerts, pulls, expiry, ...(issues === undefined ? [] : [issues])];
  return {
    ...(alerts.value === undefined ? {} : { dependabot: alerts.value }),
    pulls: pulls.value ?? [],
    ...(expiry.value === undefined ? {} : { expiresAt: expiry.value }),
    ...(issues?.value === undefined ? {} : { check: issues.value }),
    checked: sources.flatMap((s) => s.checked),
    notRead: sources.flatMap((s) => s.notRead),
  };
}

/**
 * The Cloudflare token's expiry, when one is configured: Cloudflare's verify answer gives it when
 * one is set; an account-owned token, verified through the zone list, has none to read.
 */
async function readCloudflare(
  deps: PhaseDeps,
  cloudflare: ReadingsOptions["cloudflare"],
): Promise<Lines & { expiresAt?: string }> {
  const client = cloudflare === undefined ? cloudflareConnector(deps).client : cloudflare;
  if (client === null || client === undefined) return { checked: [], notRead: [] };
  const what = "the Cloudflare token's expiry";
  const read = await attempt(deps, what, () => client.verifyToken());
  const check = read.value;
  if (check === undefined) return read;
  if (!check.ok)
    return { checked: [], notRead: [`${what}: ${deps.redactor.redact(check.message)}`] };
  if (check.expiresOn !== undefined) return { ...read, expiresAt: check.expiresOn };
  if (check.identity === "account API token") {
    return {
      checked: [],
      notRead: [`${what}: Cloudflare gives none for an account-owned token`],
    };
  }
  return read;
}

/**
 * The 14 days of each server from the self-hosted stack, when monitoring is on; what a query
 * didn't answer is listed with the server's name.
 */
async function readServerHistory(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ReadingsOptions["services"],
  flags: string,
): Promise<Lines & { histories?: Record<string, ServerHistory> }> {
  const read = await attempt(
    deps,
    `the monitoring stack's ${THRESHOLDS.historyDays} days of figures`,
    () => readHistory(deps, plan, services),
    unreachable(`opscrew status${flags}`),
  );
  const histories = read.value;
  if (histories === undefined) return { checked: [], notRead: read.notRead };
  return {
    histories,
    checked: read.checked,
    notRead: Object.entries(histories).flatMap(([name, history]) =>
      (history.notRead ?? []).map((entry) => `server ${name}'s history: ${entry}`),
    ),
  };
}

/**
 * Everything advise's rules read about `plan`'s environment, read-only: per server its figures now
 * (as `status` reads them) and its 14 days from the self-hosted stack, `secure`'s host checks, the
 * plan (each server OpsCrew created as provision last rendered it), the interview's answers, the
 * providers' prices, Dependabot's alerts and pull requests, the GitHub and Cloudflare tokens' expiry
 * and the scheduled check's issues; with what was read (`checked`). Every remote command is fixed
 * and read-only, audited by its reader as `remote-exec`.
 */
export async function readAdvice(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ReadingsOptions = {},
): Promise<{ readings: Readings; checked: string[] }> {
  const at = deps.clock.now();
  const since = new Date(at.getTime() - THRESHOLDS.historyDays * DAY_MS).toISOString();
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const { services } = options;
  const names = isServerlessProvider(plan.target.provider) ? [] : appServers(plan);
  const requirementsRead = attempt(deps, "the interview's answers", () =>
    readEnvironmentRequirements(deps.paths),
  );
  const deployedRead = asDeployed(deps, plan);
  const [requirements, deployedPlan, prices, servers, history, github, cloudflare] =
    await Promise.all([
      requirementsRead,
      deployedRead,
      Promise.all([deployedRead, requirementsRead]).then(([view, answers]) =>
        priceLists(deps, view, answers.value),
      ),
      Promise.all(names.map((name) => readServer(deps, plan, name, services, flags))),
      readServerHistory(deps, plan, services, flags),
      readGitHub(deps, plan, options.github, since),
      readCloudflare(deps, options.cloudflare),
    ]);
  const read: Lines[] = [requirements, ...servers, history, prices, github, cloudflare];
  const tokens = [
    ...(github.expiresAt === undefined
      ? []
      : [{ service: "github" as const, expiresAt: github.expiresAt }]),
    ...(cloudflare.expiresAt === undefined
      ? []
      : [{ service: "cloudflare" as const, expiresAt: cloudflare.expiresAt }]),
  ];
  const readings: Readings = {
    at: at.toISOString(),
    servers: Object.fromEntries(
      names.flatMap((name, i): [string, ServerReadings][] => {
        const now = servers[i]?.now;
        const past = history.histories?.[name];
        return now === undefined
          ? []
          : [[name, past === undefined ? { now } : { now, history: past }]];
      }),
    ),
    plan: deployedPlan,
    ...(requirements.value === undefined ? {} : { requirements: requirements.value }),
    prices: prices.lists,
    upkeep: {
      ...(github.dependabot === undefined ? {} : { dependabot: github.dependabot }),
      pulls: github.pulls,
      tokens,
      hostChecks: Object.fromEntries(
        names.flatMap((name, i) => {
          const checks = servers[i]?.checks;
          return checks === undefined ? [] : [[name, checks]];
        }),
      ),
    },
    ...(github.check === undefined ? {} : { check: github.check }),
    notRead: read.flatMap((r) => r.notRead),
    flags,
  };
  return { readings, checked: ["the plan", ...read.flatMap((r) => r.checked)] };
}
