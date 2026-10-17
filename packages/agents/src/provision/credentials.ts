import {
  type CloudflareDnsRecord,
  cloudflareConnector,
  type EntrypointRulesetStatus,
  OPSCREW_MANAGED_COMMENT,
} from "@opscrew/connector-cloudflare";
import { type GitClient, githubConnector } from "@opscrew/connector-github";
import type { CredentialRequirement, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  portainerHostname,
  portainerWebhookHostname,
  tunnelMode,
  usesTunnel,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { cloudflareTokenHint } from "../domain/common";
import { type ProviderProfile, providerProfile, vpsConnector } from "../providers";
import {
  githubClientFromToken,
  githubCoordinates,
  hasState,
  infrastructureOutputs,
  readServerAddresses,
  serverAddress,
} from "../shared";
import {
  ownServerLogin,
  ownServerNotSetUp,
  readOwnServerRecord,
  requireOwnServerKey,
} from "../shared/own-server";
import type { CloudflareApi, GitHubApi, ProvisionServices } from "./types";
import { tunnelTokenPermissions } from "./zero-trust";

/** Cloudflare facts the render context needs. */
export interface CloudflareSetup {
  zoneId: string;
  zoneName: string;
  manageConfigRule: boolean;
  manageWafRules: boolean;
  ipRanges?: { ipv4: string[]; ipv6: string[] };
  /**
   * The account that holds the zone. Always known when the plan has a Cloudflare Tunnel (an own
   * server in tunnel mode, or a Portainer subdomain): tunnels and Access belong to the account.
   */
  accountId?: string;
  /**
   * A/AAAA/CNAME records at the app's hostnames that OpsCrew did not create; only collected when
   * `setupCloudflare` runs with `foreignRecords: "report"` (otherwise they stop the run).
   */
  foreignRecords?: { type: string; name: string; content: string }[];
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

/** What a token needs, in words: `the Read & Write permission` or `these scopes (…, …)`. */
export function neededScopes(requirement: Pick<CredentialRequirement, "scopes">): string {
  return requirement.scopes.length === 1
    ? `the ${requirement.scopes[0]} permission`
    : `these scopes (${requirement.scopes.join(", ")})`;
}

/**
 * The token was rejected. The connector's message often names the service and the scopes and
 * links the token page already; the message and hint add only what it does not say.
 */
function invalid(service: string, message: string, requirement: CredentialRequirement) {
  const brand = service.split(" ")[0] ?? service;
  const text = message.includes(brand) ? message : `${service}: ${message}`;
  const scopesSaid = requirement.scopes.every((scope) => message.includes(scope));
  const create = message.includes(requirement.createUrl)
    ? "Replace the token as described"
    : `Create a new one at ${requirement.createUrl}`;
  return new OpsCrewError("CREDENTIALS_INVALID", text, {
    hint: `${scopesSaid ? "" : `The token needs ${neededScopes(requirement)}. `}${create}, then try again.`,
  });
}

/** The token works, but the account cannot be used yet (locked, or its email is not verified). */
function accountBlocked(profile: ProviderProfile, message: string) {
  return new OpsCrewError(
    "CREDENTIALS_INVALID",
    `The ${profile.displayName} API token works, but the account cannot be used yet. ${message}`,
    {
      hint: `Resolve this on your ${profile.displayName} account page (${profile.accountUrl}), then try again.`,
    },
  );
}

/**
 * How OpsCrew reaches a server the user owns, for hints: never an API token, always the SSH login
 * from the interview and the host key.
 */
export const OWN_SERVER_CONNECT_HINT =
  "No API token is needed for your own server: OpsCrew connects over SSH with the login from `opscrew interview` (the server's address, SSH port, user, and your key file or `agent` for the SSH agent; never a password) and asks you to confirm the server's host key on the first connection (`--host-key SHA256:…` in scripts). Run `opscrew interview` to fix the login, then try again.";

/**
 * A server the user owns: its SSH login must be recorded (`.opscrew/server.json` → `own`) and its
 * key file on this computer. The connection and the host key are checked when OpsCrew connects.
 */
async function checkOwnServer(
  deps: PhaseDeps,
  services: Pick<ProvisionServices, "provider" | "own">,
): Promise<void> {
  if (services.provider !== undefined) {
    const result = await services.provider.verify();
    if (result.ok) return;
    throw new OpsCrewError("PHASE_PRECONDITION", result.message, {
      hint: OWN_SERVER_CONNECT_HINT,
    });
  }
  const connection = await readOwnServerRecord(deps.paths);
  if (connection === undefined) throw ownServerNotSetUp();
  await requireOwnServerKey(connection, deps.env, services.own?.homeDir);
  const check = await vpsConnector("own", deps, {
    ownLogin: ownServerLogin(connection),
  }).verifyCredentials();
  if (!check.ok) {
    throw new OpsCrewError("PHASE_PRECONDITION", check.message, { hint: OWN_SERVER_CONNECT_HINT });
  }
}

/**
 * Stops unless the provider's token (for example `HCLOUD_TOKEN`) is set and works. A server the
 * user owns has no token: its SSH login must be recorded instead, and the hints say how to
 * connect (interview answers, host key), never to replace a token.
 */
export async function checkProvider(
  deps: PhaseDeps,
  provider: VpsProviderId,
  services: Pick<ProvisionServices, "provider" | "own">,
): Promise<void> {
  if (provider === "own") return checkOwnServer(deps, services);
  const connector = vpsConnector(provider, deps);
  const profile = providerProfile(provider);
  const check = services.provider ?? {
    configured: connector.configured,
    verify: () => connector.verifyCredentials(),
  };
  if (!check.configured) throw missing(profile.displayName, connector.credentials);
  const result = await check.verify();
  if (result.ok) return;
  if (result.identity !== undefined) throw accountBlocked(profile, result.message);
  throw invalid(profile.displayName, result.message, connector.credentials);
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
 * The addresses of the servers OpsCrew deployed for this project (from its local state): the one
 * that receives traffic and, during a move, both servers.
 */
async function knownServers(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const local = await readServerAddresses(deps.paths);
  return [await serverAddress(deps, plan), local.retarget?.from, local.retarget?.next].flatMap(
    (address) => (address === undefined ? [] : [address.ipv4, address.ipv6 ?? ""]),
  );
}

/**
 * A, AAAA and CNAME records at the app's hostnames that OpsCrew did not create: no OpsCrew comment
 * and not pointing at a server OpsCrew already deployed. Doubles as the DNS-read permission check.
 */
async function foreignDnsRecords(
  api: CloudflareApi,
  zoneId: string,
  servers: readonly string[],
  hosts: readonly string[],
): Promise<CloudflareDnsRecord[]> {
  const known = new Set(servers.filter((ip) => ip !== "").map(canonicalAddress));
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

/** The zone entrypoint phases OpsCrew's DNS module manages. */
type RulePhase = "http_config_settings" | "http_request_firewall_custom";

/** The names OpsCrew's modules give their entrypoint rulesets, by phase. */
const OPSCREW_RULESET_NAME: Record<RulePhase, string> = {
  http_config_settings: "OpsCrew configuration rules",
  http_request_firewall_custom: "OpsCrew custom rules",
};

/**
 * The root-module output `cloudflare_rulesets` (`module.dns.ruleset_ids`, or the tunnel's WAF
 * ruleset in tunnel mode): an id or null per phase.
 */
const RulesetIdsSchema = z.looseObject({
  http_config_settings: z.string().nullable().optional(),
  http_request_firewall_custom: z.string().nullable().optional(),
});

/**
 * Which of the zone's OpsCrew-named entrypoint rulesets this project's state holds:
 * - `fresh`: no state file, an empty one, a state without outputs (nothing deployed), or outputs of
 *   a root without a `cloudflare_rulesets` output (no Cloudflare domain): none;
 * - `ids`: the ids by phase.
 */
type HeldRulesets =
  | { kind: "fresh" }
  | { kind: "ids"; ids: Partial<Record<RulePhase, string | null>> };

/**
 * Reads which entrypoint rulesets this project's state holds, from the root-module outputs (read
 * with the engine, decrypted with the project's passphrase; no provider credentials). Stops when
 * a state exists but its outputs cannot be read: skipping a phase then could plan to delete the
 * project's own ruleset.
 */
async function heldRulesets(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "engine">,
  zone: string,
): Promise<HeldRulesets> {
  if (!(await hasState(deps.paths))) return { kind: "fresh" };
  const outputs = await infrastructureOutputs(
    deps,
    plan,
    services.engine !== undefined ? { engine: services.engine } : {},
  );
  const unreadable = () =>
    new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${zone} zone has rules named by OpsCrew, and OpsCrew could not read this project's infrastructure state (.opscrew/tfstate) to tell whether this deployment created them. Nothing was changed.`,
      {
        hint: "Check that OpenTofu or Terraform runs on this computer and that .opscrew/tfstate and the state passphrase OpsCrew keeps for this project are this project's (copy them back from the computer that deployed it if they are not), then run OpsCrew again.",
      },
    );
  if (outputs === undefined) throw unreadable();
  // Only a root with a Cloudflare domain has the output, and only such a root holds a ruleset.
  if (!("cloudflare_rulesets" in outputs)) return { kind: "fresh" };
  const ids = RulesetIdsSchema.safeParse(outputs.cloudflare_rulesets);
  if (!ids.success) throw unreadable();
  return { kind: "ids", ids: ids.data };
}

/**
 * Whether OpsCrew may manage a rule phase: only when the zone has no entrypoint ruleset for it or
 * this project's state holds it (by id; OpsCrew's name alone is not enough). An OpsCrew-named
 * ruleset the project does not hold belongs to another OpsCrew deployment (or one whose state is
 * gone) and is left alone like the user's own. Warns, in plain English, whenever it skips.
 */
async function mayManagePhase(
  deps: PhaseDeps,
  phase: RulePhase,
  status: EntrypointRulesetStatus,
  text: { theirs: string; empty: string; fallback: string; skipped: string; domain: string },
  zoneId: string,
  held: () => Promise<HeldRulesets>,
): Promise<boolean> {
  if (!status.exists) return true;
  if (status.ownedByOpsCrew) {
    const state = await held();
    if (state.kind === "ids" && status.id !== undefined && state.ids[phase] === status.id) {
      return true;
    }
    const name = OPSCREW_RULESET_NAME[phase];
    const api = status.id ? ` (or the API: DELETE /zones/${zoneId}/rulesets/${status.id})` : "";
    deps.reporter.warn(
      `Another OpsCrew deployment (or one whose state is gone) holds ${text.skipped} If no other OpsCrew app uses this zone, delete the ruleset "${name}" in the Cloudflare dashboard${api} and run OpsCrew again: it then adds these rules for ${text.domain}.`,
    );
    return false;
  }
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
 * The tunnel's other hostnames in the zone: the SSH hostname in tunnel mode (`ssh-<app>.<zone>`)
 * and Portainer's subdomain when opted in. Their records must not exist unless OpsCrew made them.
 */
function tunnelHosts(plan: DeployPlan, zone: string): string[] {
  const portainer = portainerHostname(plan);
  return [
    ...(tunnelMode(plan) ? [`ssh-${plan.app.name}.${zone}`] : []),
    ...(portainer !== undefined ? [portainer] : []),
  ];
}

/**
 * The plain stop when `CLOUDFLARE_API_TOKEN` is needed and not set, with the token's permissions
 * (the user's Portainer: removing an earlier setup's tunnels and Access).
 */
export function cloudflareTokenMissing(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
): OpsCrewError {
  const requirement = cloudflareConnector(deps).credentials;
  const error = missing("Cloudflare", requirement);
  return new OpsCrewError(error.code, `${error.message} Nothing was changed.`, {
    hint: cloudflareTokenHint(tunnelTokenPermissions(), "Then try again."),
  });
}

/**
 * What the Cloudflare root of the user's Portainer holds: the app's tunnel (web mode `tunnel`)
 * and the tunnel and Access in front of Portainer's webhook (redeploy mode `cloudflare`), each
 * only with a domain on Cloudflare. `undefined` for any other target. Without either, a Portainer
 * plan has no Cloudflare resources: OpsCrew creates no DNS record for web modes `proxy` and
 * `caddy` (the user does).
 */
export function portainerCloudflare(
  plan: Pick<DeployPlan, "target" | "dns">,
): { appTunnel: boolean; webhook: boolean } | undefined {
  const { target, dns } = plan;
  if (target.provider !== "portainer") return undefined;
  const cloudflare = dns.provider === "cloudflare" && dns.domain !== undefined;
  return {
    appTunnel: cloudflare && target.web.mode === "tunnel",
    webhook: cloudflare && target.redeploy === "cloudflare",
  };
}

/**
 * The account that holds the zone, which owns the tunnel and Access: the one Cloudflare names
 * with the zone, else the token's only account.
 */
async function tunnelAccount(
  api: CloudflareApi,
  zone: { name: string; accountId?: string },
): Promise<string> {
  if (zone.accountId !== undefined && zone.accountId !== "") return zone.accountId;
  const accounts = await api.listAccounts();
  const only = accounts.length === 1 ? accounts[0] : undefined;
  if (only !== undefined) return only.id;
  throw new OpsCrewError(
    "CREDENTIALS_INVALID",
    `Cloudflare did not say which account holds ${zone.name}, and the token ${accounts.length === 0 ? "sees no account" : "sees several accounts"}, so OpsCrew cannot tell where to create the Cloudflare Tunnel.`,
    {
      hint: `Create a token for the account that holds ${zone.name} with ${tunnelTokenPermissions()}, set CLOUDFLARE_API_TOKEN to it, then run the command again.`,
    },
  );
}

/**
 * Cloudflare checks for a plan with a Cloudflare domain: token, zone, existing DNS records at the
 * app's hostnames (and the tunnel's SSH and Portainer hostnames; stops when records OpsCrew did
 * not create are there), which rule phases OpsCrew may manage (never a phase the user or another
 * OpsCrew deployment holds; always the rulesets this project's state holds, by id), the edge IP
 * ranges when proxied, and the zone's account when the plan has a Cloudflare Tunnel.
 *
 * The user's Portainer ({@link portainerCloudflare}) needs Cloudflare only for its tunnels:
 * `undefined` without them. The app's hostnames are checked only in web mode `tunnel` (in `proxy`
 * and `caddy` mode the user's own record there is expected), the webhook's hostname
 * (`portainer-<app>.<zone>`) in redeploy mode `cloudflare`; the account is always read; the
 * configuration-rule phase is never used, and the WAF phase only with the app's tunnel.
 */
export async function setupCloudflare(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ProvisionServices,
  options: { foreignRecords?: "stop" | "report" } = {},
): Promise<CloudflareSetup | undefined> {
  if (plan.dns.provider !== "cloudflare" || plan.dns.domain === undefined) return undefined;
  const portainer = portainerCloudflare(plan);
  if (portainer !== undefined && !portainer.appTunnel && !portainer.webhook) return undefined;
  /** A Cloudflare Tunnel is part of the plan, so the token needs the tunnel permissions. */
  const tunnels = usesTunnel(plan) || portainer !== undefined;
  const connector = cloudflareConnector(deps);
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
    const appHosts = plan.dns.www ? [domain, `www.${domain}`] : [domain];
    const hosts =
      portainer === undefined
        ? [...appHosts, ...tunnelHosts(plan, zone.name)]
        : [
            ...(portainer.appTunnel ? appHosts : []),
            ...(portainer.webhook
              ? [portainerWebhookHostname({ ...plan, dns: { ...plan.dns, zone: zone.name } })]
              : []),
          ].filter((host): host is string => host !== undefined);
    // The user's Portainer has no server whose records OpsCrew could have made.
    const servers = portainer === undefined ? await knownServers(deps, plan) : [];
    const foreign = await foreignDnsRecords(api, zone.id, servers, hosts);
    const reportForeign = options.foreignRecords === "report";
    if (foreign.length > 0 && !reportForeign) {
      const lines = foreign.map((r) => `  ${r.type} ${r.name} ${r.content}`);
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        deps.redactor.redact(
          [
            `Cloudflare already has DNS records for ${hosts.join(" and ")} that OpsCrew did not create:`,
            ...lines,
            portainer === undefined
              ? "Adding the app's records next to them would fail after the server is created, or split visitors between the old host and the new one. Nothing was created."
              : "The Cloudflare Tunnel's records there would fail next to them, or split visitors between the old host and the new one. Nothing was created.",
          ].join("\n"),
        ),
        {
          hint: "Delete these records in the Cloudflare dashboard (DNS → Records) if they belong to a host you no longer use, or pick another hostname with `opscrew dns --domain <hostname>`, then run OpsCrew again.",
        },
      );
    }

    // Tunnel mode renders no configuration rule (the tunnel carries TLS), so OpsCrew neither
    // inspects nor decides that phase; nor does the user's Portainer, whose WAF rules come only
    // with the app's tunnel.
    const usesConfigRule = !tunnelMode(plan) && portainer === undefined;
    const usesWafRules = portainer === undefined || portainer.appTunnel;
    const [configStatus, wafStatus] = await Promise.all([
      usesConfigRule ? api.inspectEntrypointRuleset(zone.id, "http_config_settings") : undefined,
      usesWafRules
        ? api.inspectEntrypointRuleset(zone.id, "http_request_firewall_custom")
        : undefined,
    ]);
    const tlsYourself = `set SSL/TLS to "Full (strict)" for ${domain} yourself.`;
    // Read once, and only when the zone has an OpsCrew-named ruleset.
    let held: Promise<HeldRulesets> | undefined;
    const heldOnce = () => {
      held ??= heldRulesets(deps, plan, services, zone.name);
      return held;
    };
    const manageConfigRule =
      configStatus !== undefined &&
      (await mayManagePhase(
        deps,
        "http_config_settings",
        configStatus,
        {
          theirs: `The ${zone.name} zone already has its own configuration rules, so OpsCrew will not add the TLS (Full strict) rule. Set SSL/TLS to "Full (strict)" for ${domain} yourself.`,
          empty: `The ${zone.name} zone has an empty configuration ruleset, so OpsCrew cannot add its TLS (Full strict) rule.`,
          fallback: `otherwise ${tlsYourself}`,
          domain,
          skipped: `the ${zone.name} zone's configuration rules, so OpsCrew will not add the TLS (Full strict) rule for ${domain}; ${tlsYourself}`,
        },
        zone.id,
        heldOnce,
      ));
    const manageWafRules =
      plan.security.wafCustomRules &&
      wafStatus !== undefined &&
      (await mayManagePhase(
        deps,
        "http_request_firewall_custom",
        wafStatus,
        {
          theirs: `The ${zone.name} zone already has its own WAF custom rules, so OpsCrew will not add its probe-blocking rules.`,
          empty: `The ${zone.name} zone has an empty WAF custom ruleset, so OpsCrew cannot add its probe-blocking rules.`,
          fallback: "otherwise the site runs without them.",
          domain,
          skipped: `the ${zone.name} zone's WAF custom rules, so OpsCrew will not add its probe-blocking rules for ${domain}; the site runs without them.`,
        },
        zone.id,
        heldOnce,
      ));
    const accountId = tunnels ? await tunnelAccount(api, zone) : zone.accountId;
    const setup: CloudflareSetup = {
      zoneId: zone.id,
      zoneName: zone.name,
      manageConfigRule,
      manageWafRules,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(reportForeign && foreign.length > 0
        ? {
            foreignRecords: foreign.map((r) => ({
              type: r.type,
              name: r.name,
              content: deps.redactor.redact(r.content),
            })),
          }
        : {}),
    };
    // The user's Portainer has no firewall to fill with Cloudflare's ranges.
    if (
      portainer === undefined &&
      plan.dns.proxied &&
      plan.security.httpAllowedFrom === "cloudflare"
    ) {
      setup.ipRanges = await api.getIpRanges();
    }
    return setup;
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "CREDENTIALS_INVALID") {
      const needs = tunnels ? tunnelTokenPermissions() : requirement.scopes.join(", ");
      throw new OpsCrewError("CREDENTIALS_INVALID", error.message, {
        hint: `The Cloudflare token needs: ${needs}. Create one at ${requirement.createUrl}`,
      });
    }
    throw error;
  }
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
  if (api === undefined) api = (await githubClientFromToken(deps)) ?? null;
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
