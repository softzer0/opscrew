// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { webFilterMode } from "../runtime";
import { tunnelMode } from "../tunnel";
import type { RenderContext } from "../types";
import {
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  output,
  ROOT_HEADER,
  usesCloudflare,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

/** Root-module files of an own server, without the vendored modules. */
export interface OwnRoot {
  versions: string;
  main: string;
  variables: string;
  outputs: string;
  tfvars: Record<string, unknown>;
  /** Vendored module directories the root uses. */
  modules: string[];
}

const OWN_NOTE = [
  "# A server you already own: OpsCrew neither creates nor deletes it, so this configuration has no",
  "# server resources, only what Cloudflare needs to send traffic to it.",
];

const ADDRESS_NOTE = [
  "# The server's addresses are never committed: OpsCrew passes them from its local state",
  "# (.opscrew/server.json) as TF_VAR_server_ipv4 and TF_VAR_server_ipv6 when it runs the engine.",
];

function variables(plan: DeployPlan, pieces: TunnelPieces | undefined): VariableSpec[] {
  const specs: VariableSpec[] = [
    { name: "app_name", type: "string", description: "App name, used for resource names." },
  ];
  const tunnel = tunnelMode(plan);
  if (!tunnel) {
    specs.push(
      {
        name: "server_ipv4",
        type: "string",
        description:
          "Public IPv4 address of your server. OpsCrew passes it as TF_VAR_server_ipv4 from .opscrew/server.json; it is never written to a committed file.",
      },
      {
        name: "server_ipv6",
        type: "string",
        description:
          "Public IPv6 address of your server, or null when it has none (no AAAA record). OpsCrew passes it as TF_VAR_server_ipv6 from .opscrew/server.json; it is never written to a committed file.",
        default: "null",
      },
    );
  }
  if (usesCloudflare(plan)) {
    specs.push(
      { name: "domain", type: "string", description: "Hostname of the app." },
      { name: "cloudflare_zone_id", type: "string", description: "Cloudflare zone id." },
    );
    if (!tunnel) {
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
    specs.push({
      name: "manage_waf_rules",
      type: "bool",
      description: "Manage the WAF custom rule.",
    });
  }
  return [...specs, ...(pieces?.variables ?? [])];
}

function mainTf(plan: DeployPlan, pieces: TunnelPieces | undefined): string {
  const lines = [ROOT_HEADER, ""];
  if (usesCloudflare(plan)) lines.push(...CLOUDFLARE_PROVIDER_BLOCK);
  lines.push(...OWN_NOTE);
  if (!tunnelMode(plan)) lines.push("#", ...ADDRESS_NOTE);
  lines.push("");
  if (usesCloudflare(plan) && !tunnelMode(plan)) {
    lines.push(
      'module "dns" {',
      '  source = "../modules/cloudflare-dns"',
      "",
      "  zone_id            = var.cloudflare_zone_id",
      "  domain             = var.domain",
      "  ipv4               = var.server_ipv4",
      "  ipv6               = var.server_ipv6",
      // Behind OpsCrew's web filter the site is published on IPv4 only: no AAAA record.
      webFilterMode(plan)
        ? "  ipv6_record        = false"
        : "  ipv6_record        = var.server_ipv6 != null",
      "  proxied            = var.proxied",
      "  www                = var.www",
      "  manage_config_rule = var.manage_config_rule",
      "  manage_waf_rules   = var.manage_waf_rules",
      "}",
      "",
    );
  }
  if (pieces) lines.push(...pieces.main);
  return lines.join("\n");
}

/**
 * `output "cloudflare_rulesets"`: the ids of the zone entrypoint rulesets the DNS module manages,
 * by phase. OpsCrew manages a phase whose entrypoint carries its name only when this output names
 * that ruleset (another OpsCrew deployment in the zone holds it otherwise). Rendered wherever the
 * root has `module "dns"`.
 */
export const RULESETS_OUTPUT = [
  "# The zone's entrypoint rulesets this deployment manages, by phase: OpsCrew leaves the ones",
  "# another deployment holds alone.",
  ...output("cloudflare_rulesets", "module.dns.ruleset_ids"),
];

function outputsTf(plan: DeployPlan, pieces: TunnelPieces | undefined): string {
  const lines = [ROOT_HEADER, ""];
  if (tunnelMode(plan)) {
    lines.push(...output("url", '"https://${var.domain}"'));
  } else {
    lines.push(
      ...output("server_ipv4", "var.server_ipv4"),
      ...output("server_ipv6", "var.server_ipv6"),
      ...output("url", usesCloudflare(plan) ? "module.dns.url" : '"http://${var.server_ipv4}"'),
      "# Same shape as on OpsCrew-created servers, keyed by provider; an own server has no id.",
      'output "servers" {',
      "  value = {",
      "    own = {",
      "      ipv4 = var.server_ipv4",
      "      ipv6 = var.server_ipv6",
      "    }",
      "  }",
      "}",
      "",
    );
    if (usesCloudflare(plan)) lines.push(...RULESETS_OUTPUT);
  }
  if (pieces) lines.push(...pieces.outputs);
  return lines.join("\n");
}

function tfvars(
  plan: DeployPlan,
  ctx: RenderContext,
  pieces: TunnelPieces | undefined,
): Record<string, unknown> {
  // Never the server's addresses: they reach the engine only as TF_VAR_* (FR-902).
  const values: Record<string, unknown> = { app_name: plan.app.name };
  if (usesCloudflare(plan)) {
    values.domain = plan.dns.domain;
    values.cloudflare_zone_id = ctx.cloudflare?.zoneId ?? "";
    if (!tunnelMode(plan)) {
      values.proxied = plan.dns.proxied;
      values.www = plan.dns.www;
      values.manage_config_rule = ctx.cloudflare?.manageConfigRule ?? false;
    }
    values.manage_waf_rules =
      (ctx.cloudflare?.manageWafRules ?? false) && plan.security.wafCustomRules;
  }
  return { ...values, ...(pieces?.tfvars ?? {}) };
}

/**
 * The root module of a server the user owns: no server resources. Public mode points the DNS
 * module at the `server_ipv4`/`server_ipv6` variables, which the CLI supplies as `TF_VAR_*`
 * and which never appear in `terraform.tfvars.json`. Tunnel mode serves the app, SSH (and Portainer
 * when opted in) through a Cloudflare Tunnel behind Access instead of DNS records to an address.
 */
export function ownRoot(plan: DeployPlan, ctx: RenderContext): OwnRoot {
  const pieces = tunnelPieces(plan, ctx);
  const cloudflare = usesCloudflare(plan);
  return {
    versions: versionsTf(cloudflare ? [CLOUDFLARE_PROVIDER] : []),
    main: mainTf(plan, pieces),
    variables: variablesTf(variables(plan, pieces)),
    outputs: outputsTf(plan, pieces),
    tfvars: tfvars(plan, ctx, pieces),
    modules: [
      ...(cloudflare && !tunnelMode(plan) ? ["cloudflare-dns"] : []),
      ...(pieces?.modules ?? []),
    ],
  };
}
