import { CLOUDFLARE_TOKEN_PAGE, CLOUDFLARE_TOKEN_PERMISSIONS } from "@opscrew/connector-cloudflare";
import type { RegisteredDomain } from "@opscrew/contracts";
import {
  type DeployPlan,
  type Requirements,
  readOptionalArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { hasDeployment } from "../shared";
import { toIsoDateTime } from "./common";

/** The project's requirements and plan, when present (validated). */
export interface ProjectFiles {
  plan?: DeployPlan;
  requirements?: Requirements;
}

/** Reads `opscrew/plan.yaml` and `opscrew/requirements.yaml`; an invalid file stops the run. */
export async function readProjectFiles(deps: PhaseDeps): Promise<ProjectFiles> {
  return {
    plan: await readOptionalArtifact("plan", deps.paths.files.plan),
    requirements: await readOptionalArtifact("requirements", deps.paths.files.requirements),
  };
}

/** The domain the project currently uses: the plan's, else the requirements'. */
function currentDomain(files: ProjectFiles): string | undefined {
  if (files.plan !== undefined) return files.plan.dns.domain;
  return files.requirements?.domain;
}

/** The registrable domain the project's DNS lives in: the plan's zone, else its domain. */
export function registeredName(files: ProjectFiles): string | undefined {
  if (files.plan !== undefined) return files.plan.dns.zone ?? files.plan.dns.domain;
  return files.requirements?.dnsProvider === "cloudflare" ? files.requirements.domain : undefined;
}

/** True when `host` is the bought domain or a name inside it (`app.shopapp.com`). */
export function insideDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** How recording a bought domain changes the project files. */
export interface ProjectChanges {
  /** Hostname the app will be served at: the bought domain or the plan's name inside it. */
  hostname: string;
  /** Another domain the project uses today, which recording replaces. */
  replaces?: string;
  /** Plain-English lines for an approval, one per changed file or setting (without `replaces`). */
  lines: string[];
}

/** What recording `domain` changes in `opscrew/plan.yaml` and `opscrew/requirements.yaml`. */
export function projectChanges(files: ProjectFiles, domain: string): ProjectChanges {
  const current = currentDomain(files);
  const inside = current !== undefined && insideDomain(current, domain);
  const hostname = inside ? current : domain;
  const replaces = current !== undefined && !inside ? current : undefined;
  const lines: string[] = [];
  const plan = files.plan;
  if (plan !== undefined) {
    lines.push(
      `opscrew/plan.yaml: the app is served at ${hostname} through Cloudflare (dns.provider cloudflare, dns.domain ${hostname}, dns.zone ${domain}) and dns.registration records the registration.`,
    );
    const switching = plan.dns.provider !== "cloudflare" || plan.dns.domain !== hostname;
    const proxy = switching && !plan.dns.proxied;
    const ports = switching && plan.security.httpAllowedFrom !== "cloudflare";
    if (proxy || ports) {
      const changes = [
        ...(proxy ? ["dns.proxied becomes true (traffic goes through Cloudflare's proxy)"] : []),
        ...(ports
          ? ["security.httpAllowedFrom becomes cloudflare (web ports accept only Cloudflare)"]
          : []),
      ];
      lines.push(
        `opscrew/plan.yaml: ${changes.join(" and ")}; this takes effect on the next \`opscrew dns\` or \`opscrew provision\`.`,
      );
    }
  }
  if (files.requirements !== undefined) {
    lines.push(`opscrew/requirements.yaml: domain ${hostname}, dnsProvider cloudflare.`);
  }
  return { hostname, replaces, lines };
}

/**
 * The approval lines about the project files after the `step` (`purchase`, `switch`): what
 * recording `domain` changes, and that OpsCrew asks first when it replaces another domain.
 */
export function projectLines(files: ProjectFiles, domain: string, step: string): string[] {
  const changes = projectChanges(files, domain);
  const lines: string[] = [];
  if (changes.replaces !== undefined) {
    lines.push(
      `The project uses ${changes.replaces} today; after the ${step} OpsCrew asks before it records ${domain} instead:`,
    );
  } else if (changes.lines.length > 0) {
    lines.push(`After the ${step}, OpsCrew records the domain in the project files:`);
  }
  lines.push(...changes.lines.map((line) => `  ${line}`));
  return lines;
}

/** How the domain came to the user, for {@link approveDomainSwitch}. */
export interface SwitchWording {
  /** What happened: `OpsCrew bought x.com`, `x.com now uses Cloudflare DNS`. */
  done: string;
  /** What stays when the user refuses: `stays bought`, `stays on Cloudflare`. */
  stays: string;
}

/** Asks (`repo-write`) before `domain` replaces another domain in the project files. */
export async function approveDomainSwitch(
  deps: PhaseDeps,
  files: ProjectFiles,
  domain: string,
  changes: ProjectChanges,
  wording: SwitchWording,
): Promise<boolean> {
  const current = changes.replaces ?? "";
  const file = files.plan !== undefined ? "opscrew/plan.yaml" : "opscrew/requirements.yaml";
  const decision = await deps.approvals.request({
    kind: "repo-write",
    title: `Use ${domain} instead of ${current} in ${file}`,
    details: [
      `${wording.done}, but the project serves the app at ${current}.`,
      ...changes.lines,
      `The DNS records of ${current} stay until \`opscrew dns\` or \`opscrew provision\` updates them.`,
      `Refuse to keep ${current}; ${domain} ${wording.stays} and you can switch later with \`opscrew dns --domain ${domain}\`.`,
    ].join("\n"),
  });
  return decision.approved;
}

export interface RecordOptions {
  /** The registered domain (the zone). */
  domain: string;
  /** Hostname the app is served at: the bought domain or a name inside it. */
  hostname: string;
  info: RegisteredDomain;
  dnssec: boolean;
}

/**
 * Records the bought domain: requirements (`domain`, `dnsProvider: cloudflare`) and the plan
 * (`dns.provider`, `dns.domain`, `dns.zone`, `dns.registration`). Moving the plan to a new
 * hostname also turns on the Cloudflare proxy and limits web ports to Cloudflare, as
 * `opscrew dns --domain` does, so a later `opscrew dns` sets it up the same way.
 */
export async function recordDomain(
  deps: PhaseDeps,
  files: ProjectFiles,
  options: RecordOptions,
): Promise<{ plan: boolean; requirements: boolean }> {
  const { domain, hostname, info } = options;
  if (files.plan !== undefined) {
    const plan = files.plan;
    const switching = plan.dns.provider !== "cloudflare" || plan.dns.domain !== hostname;
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      updatedAt: deps.clock.now().toISOString(),
      dns: {
        ...plan.dns,
        provider: "cloudflare",
        domain: hostname,
        zone: domain,
        ...(switching ? { proxied: true } : {}),
        registration: registrationOf(info, options.dnssec),
      },
      security: switching ? { ...plan.security, httpAllowedFrom: "cloudflare" } : plan.security,
    });
  }
  if (files.requirements !== undefined)
    await recordRequirements(deps, files.requirements, hostname);
  return { plan: files.plan !== undefined, requirements: files.requirements !== undefined };
}

/** Points `opscrew/requirements.yaml` at `hostname` on Cloudflare DNS. */
export async function recordRequirements(
  deps: PhaseDeps,
  requirements: Requirements,
  hostname: string,
): Promise<void> {
  await writeArtifact("requirements", deps.paths.files.requirements, {
    ...requirements,
    domain: hostname,
    dnsProvider: "cloudflare",
  });
}

type Registration = NonNullable<DeployPlan["dns"]["registration"]>;

/** `plan.dns.registration` from the registrar's details. */
function registrationOf(info: RegisteredDomain, dnssec: boolean): Registration {
  return {
    registrar: info.registrar,
    registeredAt: toIsoDateTime(info.createdAt),
    expiresAt: toIsoDateTime(info.expiresAt),
    autoRenew: info.autoRenew,
    privacy: info.privacy ?? true,
    dnssec,
  };
}

/**
 * Whether the plan lacks a registration it should have: it serves the app through Cloudflare at
 * `registered` or a name inside it, and records no `dns.registration` (for example because the
 * domain was bought before the plan existed).
 */
export function registrationMissing(plan: DeployPlan | undefined, registered: string): boolean {
  if (plan === undefined || plan.dns.registration !== undefined) return false;
  if (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined) return false;
  return insideDomain(plan.dns.domain, registered);
}

/**
 * Fills `plan.dns.registration` (and `dns.zone` when absent) for a domain registered on the
 * account; the caller asks for the `repo-write` approval first.
 */
export async function recordRegistration(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { domain: string; info: RegisteredDomain; dnssec: boolean },
): Promise<void> {
  await writeArtifact("plan", deps.paths.files.plan, {
    ...plan,
    updatedAt: deps.clock.now().toISOString(),
    dns: {
      ...plan.dns,
      zone: plan.dns.zone ?? options.domain,
      registration: registrationOf(options.info, options.dnssec),
    },
  });
}

/** Updates `plan.dns.registration.autoRenew` (and dates) when the plan records a registration. */
export async function syncPlanRegistration(
  deps: PhaseDeps,
  plan: DeployPlan | undefined,
  info: RegisteredDomain,
): Promise<boolean> {
  const registration = plan?.dns.registration;
  if (plan === undefined || registration === undefined) return false;
  const expiresAt = toIsoDateTime(info.expiresAt) ?? registration.expiresAt;
  if (registration.autoRenew === info.autoRenew && registration.expiresAt === expiresAt) {
    return false;
  }
  await writeArtifact("plan", deps.paths.files.plan, {
    ...plan,
    updatedAt: deps.clock.now().toISOString(),
    dns: {
      ...plan.dns,
      registration: { ...registration, autoRenew: info.autoRenew, expiresAt },
    },
  });
  return true;
}

/** True when the plan's server is running (created and not destroyed). */
function isDeployed(plan: DeployPlan | undefined): boolean {
  return plan !== undefined && hasDeployment(plan);
}

/** What the project does next once the domain is set up. */
export interface NextStepOptions {
  domain: string;
  hostname: string;
  /** Another domain the project keeps (the user refused to replace it). */
  keptDomain?: string;
  /** What is true of `domain` even so: `stays on Cloudflare DNS`. */
  stays: string;
}

/**
 * The project's next step after the domain is set up (from the project files), with what a token
 * limited to some zones needs. Warns first when the project keeps another domain.
 */
export function nextProjectStep(
  deps: PhaseDeps,
  files: ProjectFiles,
  options: NextStepOptions,
): string {
  const { domain, hostname, keptDomain } = options;
  if (keptDomain !== undefined) {
    deps.reporter.warn(
      `${files.plan === undefined ? "opscrew/requirements.yaml" : "The plan"} still uses ${keptDomain}. ${domain} ${options.stays}.`,
    );
  }
  return `${projectStep(files, domain, hostname, keptDomain)} ${zoneTokenNote(domain)}`;
}

function projectStep(
  files: ProjectFiles,
  domain: string,
  hostname: string,
  keptDomain: string | undefined,
): string {
  if (keptDomain !== undefined) {
    return `To serve the app at ${domain} later, run \`opscrew dns --domain ${domain}\`. It shows the change and asks before applying it.`;
  }
  if (isDeployed(files.plan)) {
    return `Run \`opscrew dns\` to point ${hostname} at your server. It shows the change and asks before applying it.`;
  }
  if (files.plan !== undefined) {
    return `Run \`opscrew provision\` to deploy the app at https://${hostname}.`;
  }
  if (files.requirements !== undefined) {
    return `Run \`opscrew design\` to plan the deployment for ${hostname}.`;
  }
  return `Run \`opscrew interview\` and give ${domain} as the domain, then \`opscrew design\`.`;
}

/**
 * A token limited to the zones that existed before does not cover this (possibly new) zone; said
 * within the project's next step, before the user runs it.
 */
function zoneTokenNote(domain: string): string {
  return `If your Cloudflare token is limited to specific zones, first add the zone ${domain} to it at ${CLOUDFLARE_TOKEN_PAGE} (or set it to all zones of the account): \`opscrew dns\` and \`opscrew provision\` need the token's zone permissions (${CLOUDFLARE_TOKEN_PERMISSIONS.join(", ")}) on ${domain} too.`;
}
