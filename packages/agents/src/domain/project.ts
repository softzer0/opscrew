import type { RegisteredDomain } from "@opscrew/contracts";
import {
  type ArtifactKind,
  type ArtifactOf,
  type DeployPlan,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { toIsoDateTime } from "./common";

/** The project's requirements and plan, when present (validated). */
export interface ProjectFiles {
  plan?: DeployPlan;
  requirements?: Requirements;
}

async function readOptional<K extends ArtifactKind>(
  kind: K,
  file: string,
): Promise<ArtifactOf<K> | undefined> {
  try {
    return await readArtifact(kind, file);
  } catch (error) {
    if ((error as { code?: string }).code === "ARTIFACT_MISSING") return undefined;
    throw error;
  }
}

/** Reads `opscrew/plan.yaml` and `opscrew/requirements.yaml`; an invalid file stops the run. */
export async function readProjectFiles(deps: PhaseDeps): Promise<ProjectFiles> {
  const files: ProjectFiles = {};
  const plan = await readOptional("plan", deps.paths.files.plan);
  const requirements = await readOptional("requirements", deps.paths.files.requirements);
  if (plan !== undefined) files.plan = plan;
  if (requirements !== undefined) files.requirements = requirements;
  return files;
}

/** The domain the project currently uses: the plan's, else the requirements'. */
export function currentDomain(files: ProjectFiles): string | undefined {
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
  return { hostname, ...(replaces === undefined ? {} : { replaces }), lines };
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
  const recorded = { plan: false, requirements: false };
  if (files.plan !== undefined) {
    const plan = files.plan;
    const switching = plan.dns.provider !== "cloudflare" || plan.dns.domain !== hostname;
    const next: DeployPlan = {
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
    };
    await writeArtifact("plan", deps.paths.files.plan, next);
    recorded.plan = true;
  }
  if (files.requirements !== undefined) {
    await writeArtifact("requirements", deps.paths.files.requirements, {
      ...files.requirements,
      domain: hostname,
      dnsProvider: "cloudflare",
    });
    recorded.requirements = true;
  }
  return recorded;
}

type Registration = NonNullable<DeployPlan["dns"]["registration"]>;

/** `plan.dns.registration` from the registrar's details. */
function registrationOf(info: RegisteredDomain, dnssec: boolean): Registration {
  const registeredAt = toIsoDateTime(info.createdAt);
  const expiresAt = toIsoDateTime(info.expiresAt);
  return {
    registrar: info.registrar,
    ...(registeredAt === undefined ? {} : { registeredAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
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
      registration: {
        ...registration,
        autoRenew: info.autoRenew,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    },
  });
  return true;
}

/** True when the plan's server is running (created and not destroyed). */
export function isDeployed(plan: DeployPlan | undefined): boolean {
  return (
    plan !== undefined &&
    plan.deployment.serverIpv4 !== undefined &&
    plan.deployment.destroyedAt === undefined
  );
}
