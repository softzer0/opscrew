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
  type RootFiles,
  rootHeader,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import {
  type ExtraServerCall,
  extraServerCalls,
  extraServerModules,
  extraServersOutput,
  keyTfvars,
  keyVariables,
  providerBlock,
  serverTfvars,
  serverVariables,
} from "./servers";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

const OWN_NOTE = [
  "# A server you already own: OpsCrew neither creates nor deletes it, so this configuration has no",
  "# server resources, only what Cloudflare needs to send traffic to it.",
];

const OWN_NOTE_WITH_EXTRAS = [
  "# The app's server is one you already own: OpsCrew neither creates nor deletes it. The app's",
  "# extra servers below are ones OpsCrew creates.",
];

const ADDRESS_NOTE = [
  "# The server's addresses are never committed: OpsCrew passes them from its local state",
  "# (.opscrew/server.json) as TF_VAR_server_ipv4 and TF_VAR_server_ipv6 when it runs the engine.",
];

function variables(
  plan: DeployPlan,
  pieces: TunnelPieces | undefined,
  extras: readonly ExtraServerCall[],
  checkKey: boolean,
): VariableSpec[] {
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
  if (extras.length > 0) {
    specs.push(
      ...extras.flatMap((extra) => serverVariables(extra, extra.name)),
      ...keyVariables(checkKey),
    );
  }
  if (usesCloudflare(plan)) specs.push(...zoneVariables(tunnel ? "domain" : "records"));
  return [...specs, ...(pieces?.variables ?? [])];
}

function mainTf(
  plan: DeployPlan,
  pieces: TunnelPieces | undefined,
  extras: readonly ExtraServerCall[],
  checkKey: boolean,
): string {
  const lines = [rootHeader(plan), ""];
  for (const provider of new Set(extras.map((extra) => extra.provider))) {
    lines.push(...providerBlock(provider));
  }
  if (usesCloudflare(plan)) lines.push(...CLOUDFLARE_PROVIDER_BLOCK);
  lines.push(...(extras.length > 0 ? OWN_NOTE_WITH_EXTRAS : OWN_NOTE));
  if (!tunnelMode(plan)) lines.push("#", ...ADDRESS_NOTE);
  lines.push("");
  lines.push(...extraServerModules(plan, extras, undefined, checkKey));
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

function outputsTf(
  plan: DeployPlan,
  pieces: TunnelPieces | undefined,
  extras: readonly ExtraServerCall[],
): string {
  const lines = [rootHeader(plan), ""];
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
  lines.push(...extraServersOutput(extras));
  if (pieces) lines.push(...pieces.outputs);
  return lines.join("\n");
}

/**
 * The root module of a server the user owns: no resources for that server. Public mode points the
 * DNS module at the `server_ipv4`/`server_ipv6` variables, which the CLI supplies as `TF_VAR_*`
 * and which never appear in `terraform.tfvars.json` (FR-902). Tunnel mode serves the app, SSH (and
 * Portainer when opted in) through a Cloudflare Tunnel behind Access instead of DNS records to an
 * address. The plan's extra cloud servers are `module "server_<name>"` each, with the
 * `extra_servers` output.
 */
export function ownRoot(plan: DeployPlan, ctx: RenderContext): RootFiles {
  const pieces = tunnelPieces(plan, ctx);
  const cloudflare = usesCloudflare(plan);
  const tunnel = tunnelMode(plan);
  const extras = extraServerCalls(plan);
  const providers = [...new Set(extras.map((extra) => extra.provider))];
  const checkKey = ctx.checkKeyLine !== undefined;
  return {
    versions: versionsTf(plan, [
      ...providers.map((provider) => provider.terraformProvider),
      ...(cloudflare ? [CLOUDFLARE_PROVIDER] : []),
    ]),
    main: mainTf(plan, pieces, extras, checkKey),
    variables: variablesTf(plan, variables(plan, pieces, extras, checkKey)),
    outputs: outputsTf(plan, pieces, extras),
    tfvars: {
      app_name: plan.app.name,
      ...Object.assign({}, ...extras.map((extra) => serverTfvars(extra.prefix, extra.target))),
      ...(extras.length > 0 ? keyTfvars(plan, ctx) : {}),
      ...(cloudflare ? zoneTfvars(plan, ctx, tunnel ? "domain" : "records") : {}),
      ...(pieces?.tfvars ?? {}),
    },
    modules: [
      ...providers.map((provider) => provider.module),
      ...(cloudflare && !tunnel ? ["cloudflare-dns"] : []),
      ...(pieces?.modules ?? []),
    ],
  };
}
