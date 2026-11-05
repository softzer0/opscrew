// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import type { RenderContext } from "../types";
import { moduleBlock, sensitiveOutput, type VariableSpec } from "./hcl";

/** The Cloudflare account the tunnels, Access, R2 buckets and Workers belong to. */
export function accountId(ctx: RenderContext): string {
  const id = ctx.cloudflare?.accountId;
  if (!id) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A Cloudflare account id is required to render the Cloudflare Tunnel, Access, R2 bucket or Worker of this plan.",
      {
        hint: "Check that your Cloudflare token can read the account that owns the domain's zone, then run the command again.",
      },
    );
  }
  return id;
}

/**
 * What a root module needs from the app's Cloudflare zone: `records` (the DNS module: the domain,
 * the proxy and `www.`), `previews` (the DNS module: a preview environment's wildcard record under
 * its base name), `domain` (the domain: an app served through a tunnel, or on a server-less target)
 * or `zone` (the zone id only).
 */
export type ZoneUse = "records" | "previews" | "domain" | "zone";

/**
 * The records a server's root module points at the server: a preview environment's wildcard
 * (`previews`: `environment.previews`, whose plan has a zone and no domain), the app's domain on
 * Cloudflare (`records`), or none.
 */
export function serverZoneUse(plan: DeployPlan): "records" | "previews" | undefined {
  if (plan.environment?.previews !== undefined) return "previews";
  return usesCloudflare(plan) ? "records" : undefined;
}

/** The `www` root variable. */
export const WWW_VARIABLE: VariableSpec = {
  name: "www",
  type: "bool",
  description: "Also serve www.<domain>.",
};

/** The zone's root variables for `use`, in the order every root declares them. */
export function zoneVariables(use: ZoneUse): VariableSpec[] {
  const specs: VariableSpec[] = [];
  if (use === "previews") {
    specs.push({
      name: "preview_domain",
      type: "string",
      description: "Base name of the previews: each one is pr-<number>.<base>.",
    });
  } else if (use !== "zone") {
    specs.push({ name: "domain", type: "string", description: "Hostname of the app." });
  }
  specs.push({ name: "cloudflare_zone_id", type: "string", description: "Cloudflare zone id." });
  if (use === "records") {
    specs.push(
      { name: "proxied", type: "bool", description: "Proxy traffic through Cloudflare." },
      WWW_VARIABLE,
      {
        name: "caa_issuers",
        type: "list(string)",
        description: "Certificate authorities named in CAA records at the domain (DNS only).",
      },
    );
  }
  return specs;
}

/** The values of {@link zoneVariables} for `use`. */
export function zoneTfvars(
  plan: DeployPlan,
  ctx: RenderContext,
  use: ZoneUse,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (use === "previews") values.preview_domain = plan.environment?.previews?.domain;
  else if (use !== "zone") values.domain = plan.dns.domain;
  values.cloudflare_zone_id = ctx.cloudflare?.zoneId ?? "";
  if (use === "records") {
    values.proxied = plan.dns.proxied;
    values.www = plan.dns.www;
    values.caa_issuers = caaIssuers(plan);
  }
  return values;
}

/**
 * The authorities each edge gets certificates from (research R4): Caddy falls back to ZeroSSL,
 * which issues under Sectigo's CAA name.
 */
export const CAA_ISSUERS = {
  caddy: ["letsencrypt.org", "sectigo.com"],
  nginx: ["letsencrypt.org"],
};

/**
 * The CAA issuers of the app's domain, from the plan's edge. None for an app on the zone apex (or
 * a zone not yet known), since CAA there would bind every name in the zone (FR-1430).
 */
function caaIssuers(plan: DeployPlan): string[] {
  const { dns, target } = plan;
  if (dns.zone === undefined || dns.domain === dns.zone || !("edge" in target)) return [];
  return CAA_ISSUERS[target.edge];
}

/**
 * `module "dns"` pointing the records of `use` at `ipv4` and `ipv6` (HCL expressions): the app's
 * domain with its proxy, `www.` and CAA settings, or a preview environment's wildcard `*.<base>`,
 * DNS only, without `www.` or CAA (the preview server's Caddy gets each preview's certificate).
 */
export function dnsModule(
  use: "records" | "previews",
  ipv4: string,
  ipv6: string,
  ipv6Record?: string,
): string[] {
  const previews = use === "previews";
  return moduleBlock({
    comment: previews
      ? ["# The previews' wildcard record, DNS only: each preview is pr-<number>.<base>."]
      : [],
    name: "dns",
    source: "cloudflare-dns",
    args: [
      ["zone_id", "var.cloudflare_zone_id"],
      ["domain", previews ? '"*.${var.preview_domain}"' : "var.domain"],
      ["ipv4", ipv4],
      ["ipv6", ipv6],
      ...(ipv6Record === undefined ? [] : [["ipv6_record", ipv6Record] as const]),
      ["proxied", previews ? "false" : "var.proxied"],
      ["www", previews ? "false" : "var.www"],
      ["caa_issuers", previews ? "[]" : "var.caa_issuers"],
    ],
  });
}

/** The arguments of a `cloudflare-tunnel` module call named `name` (an HCL expression). */
export function tunnelArguments(name: string): [string, string][] {
  return [
    ["account_id", "var.cloudflare_account_id"],
    ["zone_id", "var.cloudflare_zone_id"],
    ["name", name],
  ];
}

/** The arguments of `module "access"`, ending with the hostnames it protects (`hostnames`). */
export function accessArguments(hostnames: readonly [string, string][]): [string, string][] {
  return [["account_id", "var.cloudflare_account_id"], ["app_name", "var.app_name"], ...hostnames];
}

/** The outputs of the deploy workflow's Access service token (both sensitive). */
export const DEPLOY_TOKEN_OUTPUTS = [
  "# The deploy workflow's Access service token: it goes only into the deploy secrets.",
  ...sensitiveOutput("deploy_service_token_client_id", "module.access.ssh_service_token_client_id"),
  ...sensitiveOutput(
    "deploy_service_token_client_secret",
    "module.access.ssh_service_token_client_secret",
  ),
];
