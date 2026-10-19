// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext } from "../types";
import { moduleBlock, sensitiveOutput, type VariableSpec } from "./hcl";

/** The Cloudflare account the tunnels, Access and R2 buckets belong to. */
export function accountId(ctx: RenderContext): string {
  const id = ctx.cloudflare?.accountId;
  if (!id) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A Cloudflare account id is required to render the Cloudflare Tunnel, Access or R2 bucket of this plan.",
      {
        hint: "Check that your Cloudflare token can read the account that owns the domain's zone, then run the command again.",
      },
    );
  }
  return id;
}

/**
 * What a root module needs from the app's Cloudflare zone: `records` (the DNS module: the domain,
 * the proxy and `www.`), `tunnel` (the app served through a tunnel: the domain) or `zone` (the zone
 * id only).
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
  if (use !== "zone") values.domain = plan.dns.domain;
  values.cloudflare_zone_id = ctx.cloudflare?.zoneId ?? "";
  if (use === "records") {
    values.proxied = plan.dns.proxied;
    values.www = plan.dns.www;
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
