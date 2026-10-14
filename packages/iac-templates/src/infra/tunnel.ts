// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  PORTAINER_PORT,
  portainerHostname,
  sshHostname,
  TUNNEL_ORIGIN_PORT,
  tunnelMode,
  usesTunnel,
} from "../tunnel";
import type { RenderContext } from "../types";
import { alignedArguments, output, sensitiveOutput, type VariableSpec } from "./hcl";

/** What the Cloudflare Tunnel and Access add to a root module (own server or cloud server). */
export interface TunnelPieces {
  main: string[];
  variables: VariableSpec[];
  outputs: string[];
  tfvars: Record<string, unknown>;
  /** Vendored module directories. */
  modules: string[];
}

/** Team domain OpsCrew gives a Zero Trust organization it creates: `<zone>-opscrew.cloudflareaccess.com`. */
export function zeroTrustAuthDomain(zone: string): string {
  return `${zone.replaceAll(".", "-")}-opscrew.cloudflareaccess.com`;
}

function accountId(ctx: RenderContext): string {
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
 * The tunnel and Access modules for a plan that serves an own server through a tunnel or Portainer
 * on a subdomain; `undefined` when the plan needs neither (the root module is then unchanged).
 *
 * The connector runs on the server's host network, so every route points at `localhost`: the app
 * at Caddy's loopback port, SSH at sshd's port and Portainer at its loopback-only HTTPS port.
 */
export function tunnelPieces(plan: DeployPlan, ctx: RenderContext): TunnelPieces | undefined {
  if (!usesTunnel(plan)) return undefined;
  const tunnel = tunnelMode(plan);
  const ssh = sshHostname(plan); // throws first when tunnel mode has no Cloudflare domain
  const account = accountId(ctx);
  const portainer = portainerHostname(plan);
  const domain = plan.dns.domain;

  const app = `"http://localhost:${TUNNEL_ORIGIN_PORT}"`;
  const routes: string[] = [];
  const wafHostnames: string[] = [];
  if (tunnel && domain) {
    routes.push(`    { hostname = var.domain, service = ${app} },`);
    wafHostnames.push("var.domain");
    if (plan.dns.www) {
      routes.push(`    { hostname = "www.\${var.domain}", service = ${app} },`);
      wafHostnames.push('"www.${var.domain}"');
    }
  }
  if (ssh !== undefined) {
    routes.push(
      '    { hostname = var.ssh_hostname, service = "ssh://localhost:${var.ssh_port}" },',
    );
  }
  if (portainer !== undefined) {
    routes.push(
      `    { hostname = var.portainer_hostname, service = "https://localhost:${PORTAINER_PORT}", no_tls_verify = true },`,
    );
  }

  const tunnelArgs: [string, string][] = [
    ["account_id", "var.cloudflare_account_id"],
    ["zone_id", "var.cloudflare_zone_id"],
    ["name", '"opscrew-${var.app_name}"'],
  ];
  if (tunnel) {
    tunnelArgs.push(
      ["manage_waf_rules", "var.manage_waf_rules"],
      ["waf_hostnames", `[${wafHostnames.join(", ")}]`],
    );
  }
  const accessArgs: [string, string][] = [
    ["account_id", "var.cloudflare_account_id"],
    ["app_name", "var.app_name"],
    ["create_organization", "var.create_zero_trust_organization"],
    ["organization_auth_domain", "var.zero_trust_auth_domain"],
  ];
  if (ssh !== undefined) accessArgs.push(["ssh_hostname", "var.ssh_hostname"]);
  if (portainer !== undefined) {
    accessArgs.push(
      ["portainer_hostname", "var.portainer_hostname"],
      ["portainer_allowed_emails", "var.portainer_allowed_emails"],
      ["one_time_pin_identity_provider_id", "var.one_time_pin_identity_provider_id"],
    );
  }

  const main = [
    "# A Cloudflare Tunnel: the connector on the server dials out to Cloudflare, so these hostnames",
    "# need no open port. Its token is the sensitive output tunnel_token.",
    'module "tunnel" {',
    '  source = "../modules/cloudflare-tunnel"',
    "",
    ...alignedArguments(tunnelArgs),
    "",
    "  routes = [",
    ...routes,
    "  ]",
    "",
    "  # Every hostname gets its Access application before its route and DNS record, and loses it",
    "  # only after them, so nothing is reachable without Access in front of it.",
    "  depends_on = [module.access]",
    "}",
    "",
    "# Cloudflare Access in front of the tunnel's SSH and Portainer hostnames.",
    'module "access" {',
    '  source = "../modules/cloudflare-access"',
    "",
    ...alignedArguments(accessArgs),
    "}",
    "",
  ];

  const variables: VariableSpec[] = [
    {
      name: "cloudflare_account_id",
      type: "string",
      description: "Cloudflare account id (the tunnel and Access belong to it).",
    },
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
  // Access (SSH and Portainer alike) needs the account's Zero Trust organization.
  const create = ctx.cloudflare?.createZeroTrustOrganization ?? false;
  const tfvars: Record<string, unknown> = {
    cloudflare_account_id: account,
    create_zero_trust_organization: create,
  };
  if (create && plan.dns.zone !== undefined) {
    tfvars.zero_trust_auth_domain = zeroTrustAuthDomain(plan.dns.zone);
  }
  if (ssh !== undefined) {
    variables.push(
      {
        name: "ssh_hostname",
        type: "string",
        description: "Hostname the deploy workflow reaches SSH on, through the tunnel and Access.",
      },
      { name: "ssh_port", type: "number", description: "Port sshd listens on, on the server." },
    );
    tfvars.ssh_hostname = ssh;
    tfvars.ssh_port = ctx.sshPort ?? 22;
  }
  if (portainer !== undefined) {
    const existingPin = ctx.cloudflare?.oneTimePinIdentityProviderId;
    variables.push(
      {
        name: "portainer_hostname",
        type: "string",
        description: "Hostname Portainer is served on, behind Cloudflare Access.",
      },
      {
        name: "portainer_allowed_emails",
        type: "list(string)",
        description: "Email addresses Cloudflare Access lets through to Portainer.",
      },
      {
        name: "one_time_pin_identity_provider_id",
        type: "string",
        description:
          "Id of the account's existing one-time PIN login method; null makes OpsCrew create one.",
        default: "null",
      },
    );
    tfvars.portainer_hostname = portainer;
    tfvars.portainer_allowed_emails = plan.portainer?.allowedEmails ?? [];
    if (existingPin !== undefined) tfvars.one_time_pin_identity_provider_id = existingPin;
  }

  const outputs = [
    ...output("tunnel_id", "module.tunnel.tunnel_id"),
    "# The connector's token: it goes only into a root-only file on the server.",
    ...sensitiveOutput("tunnel_token", "module.tunnel.token"),
  ];
  if (ssh !== undefined) {
    outputs.push(
      ...output("ssh_hostname", "var.ssh_hostname"),
      "# The deploy workflow's Access service token: it goes only into the deploy secrets.",
      ...sensitiveOutput(
        "deploy_service_token_client_id",
        "module.access.ssh_service_token_client_id",
      ),
      ...sensitiveOutput(
        "deploy_service_token_client_secret",
        "module.access.ssh_service_token_client_secret",
      ),
    );
  }
  if (portainer !== undefined) {
    outputs.push(...output("portainer_url", '"https://${var.portainer_hostname}"'));
  }

  return {
    main,
    variables,
    outputs,
    tfvars,
    modules: ["cloudflare-tunnel", "cloudflare-access"],
  };
}
