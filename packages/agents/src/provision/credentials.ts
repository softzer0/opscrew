import { cloudflareConnector } from "@opscrew/connector-cloudflare";
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

/**
 * Cloudflare checks for a plan with a Cloudflare domain: token, zone, which rule phases OpsCrew may
 * manage (never a phase the zone already uses) and the edge IP ranges when the site is proxied.
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
    const [hasConfigRules, hasWafRules] = await Promise.all([
      api.hasEntrypointRuleset(zone.id, "http_config_settings"),
      api.hasEntrypointRuleset(zone.id, "http_request_firewall_custom"),
    ]);
    if (hasConfigRules) {
      deps.reporter.warn(
        `The ${zone.name} zone already has its own configuration rules, so OpsCrew will not add the TLS (Full strict) rule. Set SSL/TLS to "Full (strict)" for ${domain} yourself.`,
      );
    }
    if (hasWafRules && plan.security.wafCustomRules) {
      deps.reporter.warn(
        `The ${zone.name} zone already has its own WAF custom rules, so OpsCrew will not add its probe-blocking rules.`,
      );
    }
    const setup: CloudflareSetup = {
      zoneId: zone.id,
      zoneName: zone.name,
      manageConfigRule: !hasConfigRules,
      manageWafRules: plan.security.wafCustomRules && !hasWafRules,
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
