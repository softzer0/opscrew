// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import { tunnelMode, webFilterMode } from "../tunnel";
import type { RenderContext } from "../types";
import { dnsModule, zoneTfvars, zoneVariables } from "./cloudflare";
import {
  APP_NAME_VARIABLE,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  output,
  ROOT_HEADER,
  type RootFiles,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

const OWN_NOTE = [
  "# A server you already own: OpsCrew neither creates nor deletes it, so this configuration has no",
  "# server resources, only what Cloudflare needs to send traffic to it.",
];

const ADDRESS_NOTE = [
  "# The server's addresses are never committed: OpsCrew passes them from its local state",
  "# (.opscrew/server.json) as TF_VAR_server_ipv4 and TF_VAR_server_ipv6 when it runs the engine.",
];

function variables(plan: DeployPlan, pieces: TunnelPieces | undefined): VariableSpec[] {
  const specs: VariableSpec[] = [APP_NAME_VARIABLE];
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
  if (usesCloudflare(plan)) specs.push(...zoneVariables(tunnel ? "tunnel" : "records"));
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
      ...dnsModule(
        "var.server_ipv4",
        "var.server_ipv6",
        // Behind OpsCrew's web filter the site is published on IPv4 only: no AAAA record.
        webFilterMode(plan) ? "false" : "var.server_ipv6 != null",
      ),
    );
  }
  if (pieces) lines.push(...pieces.main);
  return lines.join("\n");
}

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
  }
  if (pieces) lines.push(...pieces.outputs);
  return lines.join("\n");
}

/**
 * The root module of a server the user owns: no server resources. Public mode points the DNS
 * module at the `server_ipv4`/`server_ipv6` variables, which the CLI supplies as `TF_VAR_*`
 * and which never appear in `terraform.tfvars.json` (FR-902). Tunnel mode serves the app, SSH (and
 * Portainer when opted in) through a Cloudflare Tunnel behind Access instead of DNS records to an
 * address.
 */
export function ownRoot(plan: DeployPlan, ctx: RenderContext): RootFiles {
  const pieces = tunnelPieces(plan, ctx);
  const cloudflare = usesCloudflare(plan);
  const tunnel = tunnelMode(plan);
  return {
    versions: versionsTf(cloudflare ? [CLOUDFLARE_PROVIDER] : []),
    main: mainTf(plan, pieces),
    variables: variablesTf(variables(plan, pieces)),
    outputs: outputsTf(plan, pieces),
    tfvars: {
      app_name: plan.app.name,
      ...(cloudflare ? zoneTfvars(plan, ctx, tunnel ? "tunnel" : "records") : {}),
      ...(pieces?.tfvars ?? {}),
    },
    modules: [...(cloudflare && !tunnel ? ["cloudflare-dns"] : []), ...(pieces?.modules ?? [])],
  };
}
