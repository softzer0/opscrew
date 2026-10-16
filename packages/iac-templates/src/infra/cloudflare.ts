// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext } from "../types";
import { moduleBlock, output, sensitiveOutput, type VariableSpec } from "./hcl";

/** Team domain OpsCrew gives a Zero Trust organization it creates: `<zone>-opscrew.cloudflareaccess.com`. */
export function zeroTrustAuthDomain(zone: string): string {
  return `${zone.replaceAll(".", "-")}-opscrew.cloudflareaccess.com`;
}

/** The Cloudflare account the tunnels and Access belong to. */
export function accountId(ctx: RenderContext): string {
  const id = ctx.cloudflare?.accountId;
  if (!id) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A Cloudflare account id is required to render the Cloudflare Tunnel and Access for this plan.",
      {
        hint: "Check that your Cloudflare token can read the account that owns the domain's zone, then run the command again.",
      },
    );
  }
  return id;
}

/**
 * What a root module needs from the app's Cloudflare zone: `records` (the DNS module: the domain,
 * the proxy, `www.`, the TLS configuration rule and the WAF rule), `tunnel` (the app served through
 * a tunnel: the domain and the WAF rule) or `zone` (the zone id only).
 */
export type ZoneUse = "records" | "tunnel" | "zone";

/** The zone's root variables for `use`, in the order every root declares them. */
export function zoneVariables(use: ZoneUse): VariableSpec[] {
  const specs: VariableSpec[] = [];
  if (use !== "zone") {
    specs.push({ name: "domain", type: "string", description: "Hostname of the app." });
  }
  specs.push({ name: "cloudflare_zone_id", type: "string", description: "Cloudflare zone id." });
  if (use === "records") {
    specs.push(
      { name: "proxied", type: "bool", description: "Proxy traffic through Cloudflare." },
      { name: "www", type: "bool", description: "Also serve www.<domain>." },
      {
        name: "manage_config_rule",
        type: "bool",
        description: "Manage the TLS configuration rule.",
      },
    );
  }
  if (use !== "zone") {
    specs.push({
      name: "manage_waf_rules",
      type: "bool",
      description: "Manage the WAF custom rule.",
    });
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
  if (use !== "zone") values.domain = plan.dns.domain;
  values.cloudflare_zone_id = ctx.cloudflare?.zoneId ?? "";
  if (use === "records") {
    values.proxied = plan.dns.proxied;
    values.www = plan.dns.www;
    values.manage_config_rule = ctx.cloudflare?.manageConfigRule ?? false;
  }
  if (use !== "zone") {
    values.manage_waf_rules =
      (ctx.cloudflare?.manageWafRules ?? false) && plan.security.wafCustomRules;
  }
  return values;
}

/** `module "dns"` pointing the app's records at `ipv4` and `ipv6` (HCL expressions). */
export function dnsModule(ipv4: string, ipv6: string, ipv6Record?: string): string[] {
  return moduleBlock({
    name: "dns",
    source: "cloudflare-dns",
    args: [
      ["zone_id", "var.cloudflare_zone_id"],
      ["domain", "var.domain"],
      ["ipv4", ipv4],
      ["ipv6", ipv6],
      ...(ipv6Record === undefined ? [] : [["ipv6_record", ipv6Record] as const]),
      ["proxied", "var.proxied"],
      ["www", "var.www"],
      ["manage_config_rule", "var.manage_config_rule"],
      ["manage_waf_rules", "var.manage_waf_rules"],
    ],
  });
}

/**
 * `output "cloudflare_rulesets"` of a root with `module "dns"`: the ids of the zone entrypoint
 * rulesets the DNS module manages, by phase. OpsCrew manages a phase whose entrypoint carries its
 * name only when this output names that ruleset (another OpsCrew deployment in the zone holds it
 * otherwise).
 */
export const DNS_RULESETS_OUTPUT = [
  "# The zone's entrypoint rulesets this deployment manages, by phase: OpsCrew leaves the ones",
  "# another deployment holds alone.",
  ...output("cloudflare_rulesets", "module.dns.ruleset_ids"),
];

/** `output "cloudflare_rulesets"` of a root whose app is served through `module "tunnel"`. */
export const TUNNEL_RULESETS_OUTPUT = [
  "# The zone's entrypoint rulesets this deployment manages, by phase: OpsCrew leaves the ones",
  "# another deployment holds alone. Tunnel mode has no configuration rule.",
  'output "cloudflare_rulesets" {',
  "  value = {",
  "    http_config_settings         = null",
  "    http_request_firewall_custom = module.tunnel.waf_ruleset_id",
  "  }",
  "}",
  "",
];

/**
 * The arguments of a `cloudflare-tunnel` module call named `name` (an HCL expression); with
 * `wafHostnames` (an HCL list) the tunnel's WAF rule protects those hostnames.
 */
export function tunnelArguments(name: string, wafHostnames?: string): [string, string][] {
  return [
    ["account_id", "var.cloudflare_account_id"],
    ["zone_id", "var.cloudflare_zone_id"],
    ["name", name],
    ...(wafHostnames === undefined
      ? []
      : ([
          ["manage_waf_rules", "var.manage_waf_rules"],
          ["waf_hostnames", wafHostnames],
        ] as [string, string][])),
  ];
}

/** The arguments of `module "access"`, ending with the hostnames it protects (`hostnames`). */
export function accessArguments(hostnames: readonly [string, string][]): [string, string][] {
  return [
    ["account_id", "var.cloudflare_account_id"],
    ["app_name", "var.app_name"],
    ["create_organization", "var.create_zero_trust_organization"],
    ["organization_auth_domain", "var.zero_trust_auth_domain"],
    ...hostnames,
  ];
}

/** The variables of the account's Zero Trust organization that Access needs. */
export const ZERO_TRUST_VARIABLES: readonly VariableSpec[] = [
  {
    name: "create_zero_trust_organization",
    type: "bool",
    description:
      "Create the account's Zero Trust organization (only when the account has none, or this configuration created it).",
  },
  {
    name: "zero_trust_auth_domain",
    type: "string",
    description: "Team domain of the Zero Trust organization OpsCrew creates.",
    default: "null",
  },
];

/** The values of {@link ZERO_TRUST_VARIABLES}. */
export function zeroTrustTfvars(plan: DeployPlan, ctx: RenderContext): Record<string, unknown> {
  const create = ctx.cloudflare?.createZeroTrustOrganization ?? false;
  return {
    create_zero_trust_organization: create,
    ...(create && plan.dns.zone !== undefined
      ? { zero_trust_auth_domain: zeroTrustAuthDomain(plan.dns.zone) }
      : {}),
  };
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
