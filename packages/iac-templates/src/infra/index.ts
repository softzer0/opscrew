import { OpsCrewError } from "@opscrew/core";
import type { CloudDeployTarget, DeployPlan, DeployTarget } from "@opscrew/plan-schema";
import { MODULE_FILES } from "../generated/modules";
import { type ProviderText, providerText, type VariablePrefix } from "../providers";
import type { InfraLayout, RenderContext, RenderedFile, ServerModule } from "../types";
import {
  alignedArguments,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  output,
  ROOT_HEADER,
  usesCloudflare,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import { ownRoot } from "./own";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

export { zeroTrustAuthDomain } from "./tunnel";

const OPEN_TO_ALL = ["0.0.0.0/0", "::/0"];

/** Added to `main.tf` below the header while a move is in progress (a layout is given). */
const MOVE_NOTE = [
  "# A move to another provider is in progress: `opscrew retarget` manages these files until the",
  "# move is finished (`opscrew retarget --finish`) or aborted (`opscrew retarget --abort`).",
].join("\n");

/** Directory of the vendored modules, next to the root module directory. */
export function modulesDirFor(infraDir: string): string {
  const parts = infraDir.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  parts.pop();
  return [...parts, "modules"].join("/");
}

/** CIDRs allowed to reach ports 80/443: Cloudflare's ranges when proxied and restricted. */
export function httpAllowedCidrs(plan: DeployPlan, ctx: RenderContext): string[] {
  const ranges = ctx.cloudflare?.ipRanges;
  if (
    usesCloudflare(plan) &&
    plan.dns.proxied &&
    plan.security.httpAllowedFrom === "cloudflare" &&
    ranges
  ) {
    const all = [...ranges.ipv4, ...ranges.ipv6];
    if (all.length > 0) return all;
  }
  return OPEN_TO_ALL;
}

/** A server module call of the root module. */
interface ServerCall {
  module: ServerModule;
  target: CloudDeployTarget;
  /** Prefix of the server's own root variables (`location`, `server_type`, …). */
  prefix: VariablePrefix;
  provider: ProviderText;
}

/** What the root module contains, resolved from `ctx.layout` (or the plan's target). */
interface RootShape {
  /** `module "server"` first, then `module "server_previous"`. */
  servers: ServerCall[];
  /** The server the DNS module and the `server_*` outputs follow. */
  live: ServerCall;
  moved?: { from: ServerModule; to: ServerModule };
  /** Providers whose requirement, provider block and module are rendered, in the given order. */
  providers: ProviderText[];
  /** True while a move is in progress (a layout was given). */
  moving: boolean;
}

/** Moves are only between OpsCrew-created servers; the plan schema refuses the rest too. */
function noOwnServerMove(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Moving an app to or from a server you already own is not available.",
    {
      hint: "Deploy to your own server with a fresh `opscrew design` and `opscrew provision` instead of `opscrew retarget`.",
    },
  );
}

/** A server module's target: OpsCrew creates it (a server of a cloud root module). */
function serverTarget(target: DeployTarget): CloudDeployTarget {
  if (target.provider === "own") throw noOwnServerMove();
  return target;
}

/**
 * Resolves the root module's layout. Without `ctx.layout` this is `module "server"` for
 * `plan.target` and its provider only. Throws for layouts the engines would reject.
 */
function rootShape(plan: DeployPlan, ctx: RenderContext): RootShape {
  const layout: InfraLayout = ctx.layout ?? {
    server: plan.target,
    live: "server",
    providers: [plan.target.provider],
  };
  if (layout.providers.includes("own")) throw noOwnServerMove();
  const servers: ServerCall[] = [];
  if (layout.server) {
    const target = serverTarget(layout.server);
    servers.push({ module: "server", target, prefix: "", provider: providerText(target) });
  }
  if (layout.previous) {
    const target = serverTarget(layout.previous);
    servers.push({
      module: "server_previous",
      target,
      prefix: "previous_",
      provider: providerText(target),
    });
  }
  if (servers.length === 0) {
    throw new Error("The infrastructure layout has no server module to render.");
  }
  const live = servers.find((s) => s.module === layout.live);
  if (!live) {
    throw new Error(
      `The infrastructure layout points DNS at module "${layout.live}", which it does not render.`,
    );
  }
  const { moved } = layout;
  if (moved) {
    const declared = new Set(servers.map((s) => s.module));
    if (moved.from === moved.to || declared.has(moved.from) || !declared.has(moved.to)) {
      throw new Error(
        `The infrastructure layout cannot move module.${moved.from} to module.${moved.to}: a moved block needs the destination module and no module at the source address.`,
      );
    }
  }
  if (layout.server && layout.previous?.provider === layout.server.provider) {
    // Both modules name their resources after the app; on one provider they would collide.
    throw new Error(
      `The infrastructure layout renders two ${layout.server.provider} servers; a move needs two different providers.`,
    );
  }
  const providers = [...new Set(layout.providers)];
  for (const { target } of servers) {
    if (!providers.includes(target.provider)) {
      throw new Error(
        `The infrastructure layout renders a ${target.provider} server but does not list the ${target.provider} provider.`,
      );
    }
  }
  return {
    servers,
    live,
    moved,
    providers: providers.map((provider) => providerText({ provider })),
    moving: ctx.layout !== undefined,
  };
}

function cloudVersionsTf(plan: DeployPlan, shape: RootShape): string {
  return versionsTf([
    ...shape.providers.map((provider) => provider.terraformProvider),
    ...(usesCloudflare(plan) ? [CLOUDFLARE_PROVIDER] : []),
  ]);
}

function mainTf(plan: DeployPlan, shape: RootShape, pieces: TunnelPieces | undefined): string {
  const lines = [ROOT_HEADER, ""];
  if (shape.moving) lines.push(MOVE_NOTE, "");
  for (const provider of shape.providers) {
    lines.push(
      `# Token from the ${provider.tokenVar} environment variable (never stored in files or state).`,
      `provider "${provider.terraformProvider.name}" {}`,
      "",
    );
  }
  if (usesCloudflare(plan)) lines.push(...CLOUDFLARE_PROVIDER_BLOCK);
  for (const server of shape.servers) {
    if (server.module === "server_previous") {
      lines.push(
        `# The previous ${server.provider.serverNoun}, kept until the move is finished or aborted.`,
      );
    }
    lines.push(
      `module "${server.module}" {`,
      `  source = "../modules/${server.provider.module}"`,
      "",
      ...alignedArguments(server.provider.moduleArguments(server.prefix)),
      "}",
      "",
    );
  }
  if (shape.moved) {
    const { from, to } = shape.moved;
    lines.push(
      `# Renames module.${from} to module.${to} in the state; nothing changes in the cloud.`,
      "moved {",
      `  from = module.${from}`,
      `  to   = module.${to}`,
      "}",
      "",
    );
  }
  if (usesCloudflare(plan)) {
    const live = shape.live.module;
    lines.push(
      'module "dns" {',
      '  source = "../modules/cloudflare-dns"',
      "",
      "  zone_id            = var.cloudflare_zone_id",
      "  domain             = var.domain",
      `  ipv4               = module.${live}.ipv4_address`,
      `  ipv6               = module.${live}.ipv6_address`,
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
 * A server's own variables: `location`, `server_type`, `image`, `backups` and, for Hetzner,
 * `delete_protection`; prefixed with `previous_` for `module "server_previous"`.
 */
function serverVariables({ prefix, provider }: ServerCall): VariableSpec[] {
  const previous = prefix === "previous_";
  const describe = (text: string) =>
    previous ? `${text.replace(/\.$/, "")} of the previous ${provider.serverNoun}.` : text;
  const specs: VariableSpec[] = [
    { name: "location", type: "string", description: describe(provider.descriptions.location) },
    {
      name: "server_type",
      type: "string",
      description: describe(provider.descriptions.serverType),
    },
    { name: "image", type: "string", description: describe("Operating system image.") },
    { name: "backups", type: "bool", description: describe(provider.descriptions.backups) },
  ];
  if (provider.deleteProtection) {
    specs.push({
      name: "delete_protection",
      type: "bool",
      description: previous
        ? "Protect the previous server against accidental deletion and rebuilds; `opscrew retarget --finish` passes false."
        : "Protect the server against accidental deletion and rebuilds; `opscrew destroy` passes false.",
      default: "true",
    });
  }
  return specs.map((spec) => ({ ...spec, name: `${prefix}${spec.name}` }));
}

function variables(
  plan: DeployPlan,
  shape: RootShape,
  pieces: TunnelPieces | undefined,
): VariableSpec[] {
  const base: VariableSpec[] = [
    { name: "app_name", type: "string", description: "App name, used for resource names." },
    ...shape.servers.flatMap(serverVariables),
    {
      name: "deploy_ssh_public_key",
      type: "string",
      description: "Public half of the deploy key.",
    },
    {
      name: "ssh_allowed_cidrs",
      type: "list(string)",
      description: "Networks allowed to reach SSH.",
    },
    {
      name: "http_allowed_cidrs",
      type: "list(string)",
      description: "Networks allowed to reach ports 80 and 443.",
    },
  ];
  if (!usesCloudflare(plan)) return base;
  return [
    ...base,
    { name: "domain", type: "string", description: "Hostname of the app." },
    { name: "cloudflare_zone_id", type: "string", description: "Cloudflare zone id." },
    { name: "proxied", type: "bool", description: "Proxy traffic through Cloudflare." },
    { name: "www", type: "bool", description: "Also serve www.<domain>." },
    { name: "manage_config_rule", type: "bool", description: "Manage the TLS configuration rule." },
    { name: "manage_waf_rules", type: "bool", description: "Manage the WAF custom rule." },
    ...(pieces?.variables ?? []),
  ];
}

/**
 * `output "servers"`: every server module's addresses and id, keyed by the server's provider. A
 * move always goes to another provider, so OpsCrew tells the old server from the new one by
 * provider, whichever module holds each and whichever layout was applied last.
 */
function serversOutput(shape: RootShape): string[] {
  return [
    "# Every server by provider. During a move to another provider, OpsCrew tells the server being",
    "# replaced from the new one by their providers.",
    'output "servers" {',
    "  value = {",
    ...shape.servers.flatMap(({ module, target }) => [
      `    ${target.provider} = {`,
      `      ipv4 = module.${module}.ipv4_address`,
      `      ipv6 = module.${module}.ipv6_address`,
      `      id   = module.${module}.server_id`,
      "    }",
    ]),
    "  }",
    "}",
    "",
  ];
}

function outputsTf(plan: DeployPlan, shape: RootShape, pieces: TunnelPieces | undefined): string {
  const live = shape.live.module;
  const url = usesCloudflare(plan) ? "module.dns.url" : `"http://\${module.${live}.ipv4_address}"`;
  return [
    ROOT_HEADER,
    "",
    ...output("server_ipv4", `module.${live}.ipv4_address`),
    ...output("server_ipv6", `module.${live}.ipv6_address`),
    ...output("server_id", `module.${live}.server_id`),
    ...output("server_name", `module.${live}.server_name`),
    ...output("url", url),
    ...serversOutput(shape),
    ...(pieces?.outputs ?? []),
  ].join("\n");
}

/** A server the user owns and no move layout: the own-server root module. */
function isOwnRoot(plan: DeployPlan, ctx: RenderContext): boolean {
  return plan.target.provider === "own" && ctx.layout === undefined;
}

/**
 * Non-secret variable values, written as `terraform.tfvars.json`. `delete_protection` and
 * `previous_delete_protection` are left out on purpose: they keep their default (on), and
 * `opscrew destroy` or `opscrew retarget --finish` lift them with `-var …=false` without editing
 * committed files. DigitalOcean has no delete protection, so its servers have no such variable.
 * With `ctx.layout`, each server module's target is written under its own variables (`previous_*`
 * for `module "server_previous"`). For a server the user owns, the server's addresses are never
 * written: the CLI supplies `server_ipv4`/`server_ipv6` as `TF_VAR_*`.
 */
export function tfvars(plan: DeployPlan, ctx: RenderContext): Record<string, unknown> {
  if (isOwnRoot(plan, ctx)) return ownRoot(plan, ctx).tfvars;
  const values: Record<string, unknown> = { app_name: plan.app.name };
  for (const { prefix, target } of rootShape(plan, ctx).servers) {
    values[`${prefix}location`] = target.location;
    values[`${prefix}server_type`] = target.serverType;
    values[`${prefix}image`] = target.image;
    values[`${prefix}backups`] = target.backups;
  }
  values.deploy_ssh_public_key = ctx.deploySshPublicKey.trim();
  values.ssh_allowed_cidrs = plan.security.sshAllowedCidrs;
  values.http_allowed_cidrs = httpAllowedCidrs(plan, ctx);
  if (usesCloudflare(plan)) {
    values.domain = plan.dns.domain;
    values.cloudflare_zone_id = ctx.cloudflare?.zoneId ?? "";
    values.proxied = plan.dns.proxied;
    values.www = plan.dns.www;
    values.manage_config_rule = ctx.cloudflare?.manageConfigRule ?? false;
    values.manage_waf_rules =
      (ctx.cloudflare?.manageWafRules ?? false) && plan.security.wafCustomRules;
  }
  return { ...values, ...(tunnelPieces(plan, ctx)?.tfvars ?? {}) };
}

/** The root-module files and the vendored copies of `modules` under `plan.infra.dir`. */
function rootFiles(
  plan: DeployPlan,
  root: { versions: string; main: string; variables: string; outputs: string },
  values: Record<string, unknown>,
  modules: readonly string[],
): RenderedFile[] {
  const dir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const modulesDir = modulesDirFor(dir);
  const files: RenderedFile[] = [
    { path: `${dir}/versions.tf`, content: root.versions, kind: "infra" },
    { path: `${dir}/main.tf`, content: root.main, kind: "infra" },
    { path: `${dir}/variables.tf`, content: root.variables, kind: "infra" },
    { path: `${dir}/outputs.tf`, content: root.outputs, kind: "infra" },
    {
      path: `${dir}/terraform.tfvars.json`,
      content: `${JSON.stringify(values, null, 2)}\n`,
      kind: "infra",
    },
  ];
  for (const [path, content] of Object.entries(MODULE_FILES).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (modules.some((m) => path.startsWith(`${m}/`))) {
      files.push({ path: `${modulesDir}/${path}`, content, kind: "infra" });
    }
  }
  return files;
}

/**
 * The root module (`versions.tf`, `main.tf`, `variables.tf`, `outputs.tf`,
 * `terraform.tfvars.json`) under `plan.infra.dir`, plus vendored copies of the modules it uses
 * under the sibling `modules/` directory. Deterministic; contains no secrets. The `server_*` and
 * `url` outputs follow the server that receives the traffic; `servers` lists every server by
 * provider.
 *
 * With `ctx.layout` (a move to another provider) it renders the layout's server modules
 * (`module "server"`, `module "server_previous"`), its `moved` block, every listed provider's
 * requirement, provider block and vendored module, and DNS and the `server_*` outputs from the
 * live module.
 *
 * A Portainer subdomain adds `module "tunnel"` (`cloudflare-tunnel`) and `module "access"`
 * (`cloudflare-access`) with the outputs `tunnel_id`, `tunnel_token` (sensitive) and
 * `portainer_url`.
 *
 * For a server the user owns (`target.provider === "own"`) the root module has no server
 * resources:
 * - public mode: `module "dns"` points at the variables `server_ipv4`/`server_ipv6`, which the CLI
 *   supplies as `TF_VAR_server_ipv4`/`TF_VAR_server_ipv6` from `.opscrew/server.json` (never in
 *   `terraform.tfvars.json`); outputs `server_ipv4`, `server_ipv6`, `url` and
 *   `servers = { own = { ipv4, ipv6 } }` (no `server_id`/`server_name`: there is no server
 *   resource).
 * - tunnel mode: no DNS module and no address variables; `module "tunnel"` serves the app, its
 *   `www.` alias and `ssh_hostname`, and `module "access"` puts a Service Auth policy in front of
 *   SSH; outputs `url`, `tunnel_id`, `tunnel_token` (sensitive), `ssh_hostname`,
 *   `deploy_service_token_client_id` and `deploy_service_token_client_secret` (sensitive), plus
 *   `portainer_url` with a Portainer subdomain.
 */
export function renderInfra(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  if (usesCloudflare(plan) && !ctx.cloudflare?.zoneId) {
    throw new Error("A Cloudflare zone id is required to render DNS for this plan.");
  }
  if (isOwnRoot(plan, ctx)) {
    const root = ownRoot(plan, ctx);
    return rootFiles(plan, root, root.tfvars, root.modules);
  }
  const shape = rootShape(plan, ctx);
  const pieces = tunnelPieces(plan, ctx);
  return rootFiles(
    plan,
    {
      versions: cloudVersionsTf(plan, shape),
      main: mainTf(plan, shape, pieces),
      variables: variablesTf(variables(plan, shape, pieces)),
      outputs: outputsTf(plan, shape, pieces),
    },
    tfvars(plan, ctx),
    [
      ...shape.providers.map((provider) => provider.module),
      ...(usesCloudflare(plan) ? ["cloudflare-dns"] : []),
      ...(pieces?.modules ?? []),
    ],
  );
}
