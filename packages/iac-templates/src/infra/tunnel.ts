// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
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
import { accessArguments, accountId, DEPLOY_TOKEN_OUTPUTS, tunnelArguments } from "./cloudflare";
import { moduleBlock, output, sensitiveOutput, type VariableSpec } from "./hcl";

/** What the Cloudflare Tunnel and Access add to a root module (own server or cloud server). */
export interface TunnelPieces {
  main: string[];
  variables: VariableSpec[];
  outputs: string[];
  tfvars: Record<string, unknown>;
  /** Vendored module directories. */
  modules: string[];
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
  if (tunnel && domain) {
    routes.push(`    { hostname = var.domain, service = ${app} },`);
    if (plan.dns.www) {
      routes.push(`    { hostname = "www.\${var.domain}", service = ${app} },`);
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

  const accessHostnames: [string, string][] = [];
  if (ssh !== undefined) accessHostnames.push(["service_hostname", "var.ssh_hostname"]);
  if (portainer !== undefined) {
    accessHostnames.push(
      ["portainer_hostname", "var.portainer_hostname"],
      ["portainer_allowed_emails", "var.portainer_allowed_emails"],
      ["one_time_pin_identity_provider_id", "var.one_time_pin_identity_provider_id"],
    );
  }

  const main = [
    ...moduleBlock({
      comment: [
        "# A Cloudflare Tunnel: the connector on the server dials out to Cloudflare, so these hostnames",
        "# need no open port. Its token is the sensitive output tunnel_token.",
      ],
      name: "tunnel",
      source: "cloudflare-tunnel",
      args: tunnelArguments('"opscrew-${var.app_name}"'),
      body: [
        "  routes = [",
        ...routes,
        "  ]",
        "",
        "  # Every hostname gets its Access application before its route and DNS record, and loses it",
        "  # only after them, so nothing is reachable without Access in front of it.",
        "  depends_on = [module.access]",
      ],
    }),
    ...moduleBlock({
      comment: ["# Cloudflare Access in front of the tunnel's SSH and Portainer hostnames."],
      name: "access",
      source: "cloudflare-access",
      args: accessArguments(accessHostnames),
    }),
  ];

  const variables: VariableSpec[] = [
    {
      name: "cloudflare_account_id",
      type: "string",
      description: "Cloudflare account id (the tunnel and Access belong to it).",
    },
  ];
  const tfvars: Record<string, unknown> = { cloudflare_account_id: account };
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
    const pin = ctx.cloudflare?.oneTimePinIdentityProviderId;
    if (pin === undefined) {
      throw new Error(
        "The account's one-time PIN login method id is required to render Portainer's Cloudflare Access.",
      );
    }
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
        description: "Id of the account's one-time PIN login method, Portainer's login.",
      },
    );
    tfvars.portainer_hostname = portainer;
    tfvars.portainer_allowed_emails = plan.portainer?.allowedEmails ?? [];
    tfvars.one_time_pin_identity_provider_id = pin;
  }

  const outputs = [
    ...output("tunnel_id", "module.tunnel.tunnel_id"),
    "# The connector's token: it goes only into a root-only file on the server.",
    ...sensitiveOutput("tunnel_token", "module.tunnel.token"),
  ];
  if (ssh !== undefined) {
    outputs.push(...output("ssh_hostname", "var.ssh_hostname"), ...DEPLOY_TOKEN_OUTPUTS);
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
