// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import { portainerTarget } from "../providers";
import type { RenderContext } from "../types";
import {
  accessArguments,
  accountId,
  DEPLOY_TOKEN_OUTPUTS,
  tunnelArguments,
  zoneTfvars,
  zoneVariables,
} from "./cloudflare";
import {
  APP_NAME_VARIABLE,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  moduleBlock,
  output,
  ROOT_HEADER,
  type RootFiles,
  sensitiveOutput,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";

/** Where the app's stack connector sends the app's hostnames: Caddy on the stack's network. */
const APP_ORIGIN = '"http://caddy:80"';

/** The only request paths the tunnel serves on Portainer's hostname (a regular expression). */
export const PORTAINER_WEBHOOK_PATH = "^/api/stacks/webhooks/";

/** What the root module contains for the plan. */
interface Shape {
  /** `module "tunnel"`: the app's tunnel (web mode `tunnel`). */
  appTunnel: boolean;
  /** `module "portainer_tunnel"` and `module "access"`: the webhook behind Access. */
  webhook: boolean;
}

function shape(plan: DeployPlan): Shape {
  const target = portainerTarget(plan.target);
  const cloudflare = usesCloudflare(plan);
  return {
    appTunnel: cloudflare && target.web.mode === "tunnel",
    webhook: cloudflare && target.redeploy === "cloudflare",
  };
}

/**
 * Hostname the deploy workflow reaches Portainer's webhook on through Cloudflare Access, in
 * redeploy mode `cloudflare`: `portainer-<app>.<zone>`, directly under the zone so Cloudflare's
 * Universal SSL certificate covers it. `undefined` for other plans. Throws when the plan has no
 * Cloudflare zone yet.
 */
export function portainerWebhookHostname(plan: DeployPlan): string | undefined {
  const { target, dns } = plan;
  if (target.provider !== "portainer" || target.redeploy !== "cloudflare") return undefined;
  if (dns.provider !== "cloudflare" || dns.domain === undefined || dns.zone === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Redeploys through Cloudflare reach Portainer on a hostname in your Cloudflare zone, and this plan has none.",
      {
        hint: 'Add a domain whose DNS is on Cloudflare with `opscrew design` (or `opscrew domain`), or choose the redeploy mode "updater", then run `opscrew provision` again.',
      },
    );
  }
  return `portainer-${plan.app.name}.${dns.zone}`;
}

function mainTf(plan: DeployPlan, s: Shape): string {
  const lines = [
    ROOT_HEADER,
    "",
    ...CLOUDFLARE_PROVIDER_BLOCK,
    "# Your existing Portainer: OpsCrew creates no server and changes nothing on the host, and the",
    "# app's own DNS records stay yours. This configuration has only Cloudflare Tunnels: the one",
    "# that serves the app, or the one that lets the deploy workflow reach Portainer's webhook",
    "# behind Cloudflare Access, or both.",
  ];
  if (s.webhook) {
    lines.push(
      "#",
      "# Portainer's address is never committed: OpsCrew passes it from its local state",
      "# (.opscrew/server.json) as TF_VAR_portainer_origin.",
    );
  }
  lines.push("");
  if (s.appTunnel) {
    const www = plan.dns.www;
    lines.push(
      ...moduleBlock({
        comment: [
          "# A Cloudflare Tunnel for the app: the cloudflared service of the app's stack dials out to",
          "# Cloudflare and reaches Caddy on the stack's network, so the host opens no port. Its token is",
          "# the sensitive output tunnel_token.",
        ],
        name: "tunnel",
        source: "cloudflare-tunnel",
        args: tunnelArguments('"opscrew-${var.app_name}"'),
        body: [
          "  routes = [",
          `    { hostname = var.domain, service = ${APP_ORIGIN} },`,
          ...(www ? [`    { hostname = "www.\${var.domain}", service = ${APP_ORIGIN} },`] : []),
          "  ]",
        ],
      }),
    );
  }
  if (s.webhook) {
    lines.push(
      ...moduleBlock({
        comment: [
          "# A tunnel for Portainer's webhook: its connector runs as its own stack in Portainer and",
          "# reaches Portainer at TF_VAR_portainer_origin (Portainer's own certificate is self-signed, so",
          "# the connector does not check it). It serves only the webhook paths; every other path gets a",
          "# 404. Its token is the sensitive output portainer_tunnel_token.",
        ],
        name: "portainer_tunnel",
        source: "cloudflare-tunnel",
        args: tunnelArguments('"opscrew-${var.app_name}-portainer"'),
        body: [
          "  routes = [",
          "    {",
          "      hostname      = var.portainer_hostname",
          `      path          = ${JSON.stringify(PORTAINER_WEBHOOK_PATH)}`,
          "      service       = var.portainer_origin",
          "      no_tls_verify = true",
          "    },",
          "  ]",
          "",
          "  # Portainer's hostname gets its Access application before its route and DNS record, and",
          "  # loses it only after them, so the webhook is never reachable without Access in front of it.",
          "  depends_on = [module.access]",
        ],
      }),
      ...moduleBlock({
        comment: [
          "# Cloudflare Access in front of Portainer's whole hostname: a Service Auth policy that lets only",
          "# the deploy workflow's service token through (the module's service-token hostname).",
        ],
        name: "access",
        source: "cloudflare-access",
        args: accessArguments([
          ["service_hostname", "var.portainer_hostname"],
          ["service_label", '"Portainer webhook"'],
        ]),
      }),
    );
  }
  return lines.join("\n");
}

function variables(s: Shape): VariableSpec[] {
  const specs: VariableSpec[] = [
    APP_NAME_VARIABLE,
    ...zoneVariables(s.appTunnel ? "domain" : "zone"),
    {
      name: "cloudflare_account_id",
      type: "string",
      description: "Cloudflare account id (the tunnels and Access belong to it).",
    },
  ];
  if (s.webhook) {
    specs.push(
      {
        name: "portainer_hostname",
        type: "string",
        description:
          "Hostname the deploy workflow reaches Portainer's webhook on, behind Cloudflare Access.",
      },
      {
        name: "portainer_origin",
        type: "string",
        description:
          "Portainer's address as the tunnel connector reaches it, for example https://192.168.1.10:9443. OpsCrew passes it as TF_VAR_portainer_origin from .opscrew/server.json; it is never written to a committed file.",
        // The engines never show Portainer's address in a plan.
        sensitive: true,
      },
    );
  }
  return specs;
}

function outputsTf(s: Shape): string {
  const lines = [ROOT_HEADER, ""];
  if (s.appTunnel) {
    lines.push(
      ...output("url", '"https://${var.domain}"'),
      ...output("tunnel_id", "module.tunnel.tunnel_id"),
      "# The app stack's connector token: it goes only into the stack's environment in Portainer.",
      ...sensitiveOutput("tunnel_token", "module.tunnel.token"),
    );
  }
  if (s.webhook) {
    lines.push(
      ...output("portainer_hostname", "var.portainer_hostname"),
      ...output("portainer_tunnel_id", "module.portainer_tunnel.tunnel_id"),
      "# The webhook connector's token: it goes only into its stack's environment in Portainer.",
      ...sensitiveOutput("portainer_tunnel_token", "module.portainer_tunnel.token"),
      ...DEPLOY_TOKEN_OUTPUTS,
    );
  }
  return lines.join("\n");
}

function tfvars(plan: DeployPlan, ctx: RenderContext, s: Shape): Record<string, unknown> {
  // Never Portainer's address: it reaches the engine only as TF_VAR_portainer_origin.
  return {
    app_name: plan.app.name,
    ...zoneTfvars(plan, ctx, s.appTunnel ? "domain" : "zone"),
    cloudflare_account_id: accountId(ctx),
    ...(s.webhook ? { portainer_hostname: portainerWebhookHostname(plan) } : {}),
  };
}

/**
 * The root module of a Portainer target, or `undefined` when the plan needs none. OpsCrew creates
 * no server, changes nothing on the host and creates no DNS record for web modes `proxy` and
 * `caddy` (those work with any DNS; `opscrew provision` says which record to create). Web mode
 * `tunnel` gets `module "tunnel"` to Caddy in the app's stack (outputs `url`, `tunnel_id`,
 * `tunnel_token`). Redeploy mode `cloudflare` gets
 * `module "portainer_tunnel"` (Portainer's hostname, only the webhook paths, to the sensitive
 * variable `portainer_origin` supplied as `TF_VAR_portainer_origin`) and `module "access"` with a
 * Service Auth policy for the deploy workflow's service token (outputs `portainer_hostname`,
 * `portainer_tunnel_id`, `portainer_tunnel_token`, `deploy_service_token_client_id` and
 * `deploy_service_token_client_secret`, the tokens sensitive).
 */
export function portainerRoot(plan: DeployPlan, ctx: RenderContext): RootFiles | undefined {
  const s = shape(plan);
  if (!s.appTunnel && !s.webhook) return undefined;
  if (!ctx.cloudflare?.zoneId) {
    throw new Error(
      "A Cloudflare zone id is required to render the Cloudflare Tunnel for this plan.",
    );
  }
  return {
    versions: versionsTf([CLOUDFLARE_PROVIDER]),
    main: mainTf(plan, s),
    variables: variablesTf(variables(s)),
    outputs: outputsTf(s),
    tfvars: tfvars(plan, ctx, s),
    modules: ["cloudflare-tunnel", ...(s.webhook ? ["cloudflare-access"] : [])],
  };
}
