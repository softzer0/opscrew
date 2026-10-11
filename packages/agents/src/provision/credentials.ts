import {
  type CloudflareDnsRecord,
  cloudflareConnector,
  type EntrypointRulesetStatus,
  OPSCREW_MANAGED_COMMENT,
} from "@opscrew/connector-cloudflare";
import {
  type GitClient,
  GitHubClient,
  githubConnector,
  parseGitHubRepo,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import { hetznerConnector } from "@opscrew/connector-hetzner";
import type { CredentialRequirement } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { CloudflareApi, GitHubApi, ProvisionServices } from "./types";

/** Cloudflare facts the render context needs. */
export interface CloudflareSetup {
  zoneId: string;
  zoneName: string;
  manageConfigRule: boolean;
  manageWafRules: boolean;
  ipRanges?: { ipv4: string[]; ipv6: string[] };
}

export interface GitHubSetup {
  api: GitHubApi;
  owner: string;
  repo: string;
  defaultBranch: string;
}

function missing(service: string, requirement: CredentialRequirement): OpsCrewError {
  return new OpsCrewError(
    "CREDENTIALS_MISSING",
    `No ${service} token found: set ${requirement.envVars.join(" or ")}.`,
    {
      hint: `${requirement.description} It needs: ${requirement.scopes.join(", ")}. Create one at ${requirement.createUrl}`,
    },
  );
}

function invalid(service: string, message: string, requirement: CredentialRequirement) {
  return new OpsCrewError("CREDENTIALS_INVALID", `${service}: ${message}`, {
    hint: `The token needs: ${requirement.scopes.join(", ")}. Create one at ${requirement.createUrl}`,
  });
}

/** Stops unless `HCLOUD_TOKEN` is set and works. */
export async function checkHetzner(deps: PhaseDeps, services: ProvisionServices): Promise<void> {
  const connector = hetznerConnector({
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
  const hetzner = services.hetzner ?? {
    configured: connector.client !== undefined,
    verify: () => connector.verifyCredentials(),
  };
  if (!hetzner.configured) throw missing("Hetzner Cloud", connector.credentials);
  const check = await hetzner.verify();
  if (!check.ok) throw invalid("Hetzner Cloud", check.message, connector.credentials);
}

/** Record types that clash with (or split traffic away from) OpsCrew's A/AAAA/CNAME records. */
const CLASHING_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);

/** Canonical form of an address so `2001:DB8:0::1` matches `2001:db8::1`. */
function canonicalAddress(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text.includes(":")) return text;
  try {
    return new URL(`http://[${text}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return text;
  }
}

/**
 * A, AAAA and CNAME records at the app's hostnames that OpsCrew did not create: no OpsCrew comment
 * and not pointing at the server OpsCrew already deployed. Doubles as the DNS-read permission check.
 */
async function foreignDnsRecords(
  api: CloudflareApi,
  zoneId: string,
  plan: DeployPlan,
  hosts: readonly string[],
): Promise<CloudflareDnsRecord[]> {
  const known = new Set(
    [plan.deployment.serverIpv4, plan.deployment.serverIpv6]
      .filter((ip): ip is string => ip !== undefined && ip !== "")
      .map(canonicalAddress),
  );
  const foreign: CloudflareDnsRecord[] = [];
  for (const host of hosts) {
    for (const record of await api.listDnsRecords(zoneId, { name: host })) {
      if (!CLASHING_RECORD_TYPES.has(record.type.toUpperCase())) continue;
      if (record.comment?.trim() === OPSCREW_MANAGED_COMMENT) continue;
      if (known.has(canonicalAddress(record.content))) continue;
      foreign.push(record);
    }
  }
  return foreign;
}

/**
 * Whether OpsCrew may manage a rule phase: only when the zone has no entrypoint ruleset for it or
 * the entrypoint is OpsCrew's own (from an earlier apply). Warns, in plain English, otherwise.
 */
function mayManagePhase(
  deps: PhaseDeps,
  status: EntrypointRulesetStatus,
  text: { theirs: string; empty: string; fallback: string },
  zoneId: string,
): boolean {
  if (!status.exists || status.ownedByOpsCrew) return true;
  if (status.ruleCount > 0) {
    deps.reporter.warn(text.theirs);
    return false;
  }
  const api = status.id ? ` (or the API: DELETE /zones/${zoneId}/rulesets/${status.id})` : "";
  deps.reporter.warn(
    `${text.empty} Cloudflare allows only one per zone, and OpsCrew did not create this one. To let OpsCrew manage it, delete the empty ruleset in the Cloudflare dashboard${api} and run OpsCrew again; ${text.fallback}`,
  );
  return false;
}

/**
 * Cloudflare checks for a plan with a Cloudflare domain: token, zone, existing DNS records at the
 * app's hostnames (stops when records OpsCrew did not create are there), which rule phases OpsCrew
 * may manage (never a phase the user owns; always its own) and the edge IP ranges when proxied.
 */
export async function setupCloudflare(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ProvisionServices,
): Promise<CloudflareSetup | undefined> {
  if (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined) return undefined;
  const connector = cloudflareConnector({
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
  const requirement = connector.credentials;
  const api: CloudflareApi | null =
    services.cloudflare === undefined ? (connector.client ?? null) : services.cloudflare;
  if (api === null) throw missing("Cloudflare", requirement);

  const check = await api.verifyToken();
  if (!check.ok) throw invalid("Cloudflare", check.message, requirement);
  const domain = plan.dns.domain;
  try {
    const zone = await api.findZone(domain);
    if (!zone) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `Cloudflare: no zone for ${domain} is visible to this token.`,
        {
          hint: `Add the domain to Cloudflare (and point its nameservers there), or give the token access to that zone with: ${requirement.scopes.join(", ")}.`,
        },
      );
    }
    const hosts = plan.dns.www ? [domain, `www.${domain}`] : [domain];
    const foreign = await foreignDnsRecords(api, zone.id, plan, hosts);
    if (foreign.length > 0) {
      const lines = foreign.map((r) => `  ${r.type} ${r.name} ${r.content}`);
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        deps.redactor.redact(
          [
            `Cloudflare already has DNS records for ${hosts.join(" and ")} that OpsCrew did not create:`,
            ...lines,
            "Adding the app's records next to them would fail after the server is created, or split visitors between the old host and the new one. Nothing was created.",
          ].join("\n"),
        ),
        {
          hint: "Delete these records in the Cloudflare dashboard (DNS → Records) if they belong to a host you no longer use, or pick another hostname with `opscrew dns --domain <hostname>`, then run OpsCrew again.",
        },
      );
    }

    const [configStatus, wafStatus] = await Promise.all([
      api.inspectEntrypointRuleset(zone.id, "http_config_settings"),
      api.inspectEntrypointRuleset(zone.id, "http_request_firewall_custom"),
    ]);
    const tlsYourself = `set SSL/TLS to "Full (strict)" for ${domain} yourself.`;
    const manageConfigRule = mayManagePhase(
      deps,
      configStatus,
      {
        theirs: `The ${zone.name} zone already has its own configuration rules, so OpsCrew will not add the TLS (Full strict) rule. Set SSL/TLS to "Full (strict)" for ${domain} yourself.`,
        empty: `The ${zone.name} zone has an empty configuration ruleset, so OpsCrew cannot add its TLS (Full strict) rule.`,
        fallback: `otherwise ${tlsYourself}`,
      },
      zone.id,
    );
    const manageWafRules =
      plan.security.wafCustomRules &&
      mayManagePhase(
        deps,
        wafStatus,
        {
          theirs: `The ${zone.name} zone already has its own WAF custom rules, so OpsCrew will not add its probe-blocking rules.`,
          empty: `The ${zone.name} zone has an empty WAF custom ruleset, so OpsCrew cannot add its probe-blocking rules.`,
          fallback: "otherwise the site runs without them.",
        },
        zone.id,
      );
    const setup: CloudflareSetup = {
      zoneId: zone.id,
      zoneName: zone.name,
      manageConfigRule,
      manageWafRules,
    };
    if (plan.dns.proxied && plan.security.httpAllowedFrom === "cloudflare") {
      setup.ipRanges = await api.getIpRanges();
    }
    return setup;
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "CREDENTIALS_INVALID") {
      throw new OpsCrewError("CREDENTIALS_INVALID", error.message, {
        hint: `The Cloudflare token needs: ${requirement.scopes.join(", ")}. Create one at ${requirement.createUrl}`,
      });
    }
    throw error;
  }
}

/** `owner`/`repo` of the `origin` remote; stops when there is no GitHub remote. */
export async function githubCoordinates(git: GitClient): Promise<{ owner: string; repo: string }> {
  const remote = await git.remoteUrl("origin");
  const coordinates = remote ? parseGitHubRepo(remote) : undefined;
  if (!coordinates) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This repository has no GitHub remote named origin, so there is nowhere to build and deploy from.",
      {
        hint: "Create the repository on GitHub, run `git remote add origin https://github.com/<owner>/<repo>.git`, push, then try again.",
      },
    );
  }
  return coordinates;
}

/** GitHub token, repository from the `origin` remote, push access and default branch. */
export async function setupGitHub(
  deps: PhaseDeps,
  git: GitClient,
  services: ProvisionServices,
): Promise<GitHubSetup> {
  const coordinates = await githubCoordinates(git);
  const requirement = githubConnector({ token: undefined, fetch: deps.fetch }).credentials;
  let api: GitHubApi | null | undefined = services.github;
  if (api === undefined) {
    const token = await resolveGitHubToken(deps.env, deps.runner);
    if (token) deps.redactor.addLiteral(token, "github-token");
    api = token ? new GitHubClient({ token, fetch: deps.fetch, version: deps.version }) : null;
  }
  if (api === null) throw missing("GitHub", requirement);
  const repo = await api.getRepo(coordinates.owner, coordinates.repo);
  if (!repo.canPush) {
    throw invalid(
      "GitHub",
      `the token cannot push to ${coordinates.owner}/${coordinates.repo}.`,
      requirement,
    );
  }
  return { api, ...coordinates, defaultBranch: repo.defaultBranch };
}
