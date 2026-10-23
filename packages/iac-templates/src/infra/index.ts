import type { CloudDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import { MODULE_FILES } from "../generated/modules";
import { usesCloudflare, webOnlyFromCloudflare } from "../predicates";
import { cloudTarget, PROVIDER_TEXT, type ProviderText, type VariablePrefix } from "../providers";
import type { RenderContext, RenderedFile, ServerModule } from "../types";
import { dnsModule, zoneTfvars, zoneVariables } from "./cloudflare";
import {
  APP_NAME_VARIABLE,
  alignedArguments,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  output,
  ROOT_HEADER,
  type RootFiles,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import { ownRoot } from "./own";
import { portainerRoot } from "./portainer";
import { pagesRoot, workersRoot } from "./serverless";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

export { MOVE_LAYOUTS, type MoveLayoutName, moveLayout } from "./layouts";
export { PORTAINER_WEBHOOK_PATH, portainerWebhookHostname } from "./portainer";
export { pagesVerificationRootDir, renderPagesVerification } from "./serverless";
export {
  type BucketProvider,
  type ProviderBucket,
  providerBucket,
  renderStorage,
  storageRootDir,
} from "./storage";

const OPEN_TO_ALL = ["0.0.0.0/0", "::/0"];

/** Added to `main.tf` below the header while a move is in progress (a layout is given). */
const MOVE_NOTE = [
  "# A move to another provider is in progress: `opscrew retarget` manages these files until the",
  "# move is finished (`opscrew retarget --finish`) or aborted (`opscrew retarget --abort`).",
].join("\n");

/** CIDRs allowed to reach ports 80/443: Cloudflare's ranges when proxied and restricted. */
function httpAllowedCidrs(plan: DeployPlan, ctx: RenderContext): string[] {
  const ranges = ctx.cloudflareRanges;
  if (webOnlyFromCloudflare(plan) && ranges && ranges.length > 0) return [...ranges];
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

/**
 * Resolves the root module's layout. Without `ctx.layout` this is `module "server"` for
 * `plan.target` and its provider only. Only servers OpsCrew creates have a cloud root: throws for
 * a plan for any other target, and for layouts the engines would reject.
 */
function rootShape(plan: DeployPlan, ctx: RenderContext): RootShape {
  const target = cloudTarget(plan.target);
  const layout = ctx.layout ?? { server: target, live: "server", providers: [target.provider] };
  const servers: ServerCall[] = [];
  const call = (module: ServerModule, server: CloudDeployTarget, prefix: VariablePrefix) =>
    servers.push({ module, target: server, prefix, provider: PROVIDER_TEXT[server.provider] });
  if (layout.server) call("server", layout.server, "");
  if (layout.previous) call("server_previous", layout.previous, "previous_");
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
  for (const { target: server } of servers) {
    if (!providers.includes(server.provider)) {
      throw new Error(
        `The infrastructure layout renders a ${server.provider} server but does not list the ${server.provider} provider.`,
      );
    }
  }
  return {
    servers,
    live,
    moved,
    providers: providers.map((provider) => PROVIDER_TEXT[provider]),
    moving: ctx.layout !== undefined,
  };
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
    lines.push(...dnsModule(`module.${live}.ipv4_address`, `module.${live}.ipv6_address`));
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
    APP_NAME_VARIABLE,
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
  return [...base, ...zoneVariables("records"), ...(pieces?.variables ?? [])];
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

/**
 * The root module of servers OpsCrew creates: `plan.target` as `module "server"`, or the servers
 * of `ctx.layout` during a move.
 */
function cloudRoot(plan: DeployPlan, ctx: RenderContext): RootFiles {
  const shape = rootShape(plan, ctx);
  const pieces = tunnelPieces(plan, ctx);
  const values: Record<string, unknown> = { app_name: plan.app.name };
  for (const { prefix, target } of shape.servers) {
    values[`${prefix}location`] = target.location;
    values[`${prefix}server_type`] = target.serverType;
    values[`${prefix}image`] = target.image;
    values[`${prefix}backups`] = target.backups;
  }
  values.deploy_ssh_public_key = ctx.deploySshPublicKey.trim();
  values.ssh_allowed_cidrs = plan.security.sshAllowedCidrs;
  values.http_allowed_cidrs = httpAllowedCidrs(plan, ctx);
  return {
    versions: versionsTf([
      ...shape.providers.map((provider) => provider.terraformProvider),
      ...(usesCloudflare(plan) ? [CLOUDFLARE_PROVIDER] : []),
    ]),
    main: mainTf(plan, shape, pieces),
    variables: variablesTf(variables(plan, shape, pieces)),
    outputs: outputsTf(plan, shape, pieces),
    tfvars: {
      ...values,
      ...(usesCloudflare(plan) ? zoneTfvars(plan, ctx, "records") : {}),
      ...(pieces?.tfvars ?? {}),
    },
    modules: [
      ...shape.providers.map((provider) => provider.module),
      ...(usesCloudflare(plan) ? ["cloudflare-dns"] : []),
      ...(pieces?.modules ?? []),
    ],
  };
}

/**
 * The root module for the plan: a Portainer target's (none when it needs no Cloudflare Tunnel), a
 * server the user owns, Cloudflare's hosting, GitHub Pages, or servers OpsCrew creates (with a move
 * layout, always this one).
 */
function rootModule(plan: DeployPlan, ctx: RenderContext): RootFiles | undefined {
  if (ctx.layout === undefined) {
    const { target } = plan;
    if (target.provider === "portainer") return portainerRoot(plan, ctx);
    if (target.provider === "own") return ownRoot(plan, ctx);
    if (target.provider === "cloudflare-workers") return workersRoot(plan, target, ctx);
    if (target.provider === "github-pages") return pagesRoot(plan, ctx);
  }
  return cloudRoot(plan, ctx);
}

/**
 * Non-secret variable values, written as `terraform.tfvars.json`. `delete_protection` and
 * `previous_delete_protection` are left out on purpose: they keep their default (on), and
 * `opscrew destroy` or `opscrew retarget --finish` lift them with `-var …=false` without editing
 * committed files. DigitalOcean has no delete protection, so its servers have no such variable.
 * With `ctx.layout`, each server module's target is written under its own variables (`previous_*`
 * for `module "server_previous"`). For a server the user owns, the server's addresses are never
 * written: the CLI supplies `server_ipv4`/`server_ipv6` as `TF_VAR_*`. A Portainer target never
 * writes Portainer's address (`TF_VAR_portainer_origin`) and has `{}` when it has no root module.
 */
export function tfvars(plan: DeployPlan, ctx: RenderContext): Record<string, unknown> {
  return rootModule(plan, ctx)?.tfvars ?? {};
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
 *
 * For a Portainer target (`target.provider === "portainer"`) the root module has only Cloudflare
 * Tunnels: the app's for web mode `tunnel`, and in redeploy mode `cloudflare` one and Access for
 * Portainer's webhook hostname (Portainer's address from `TF_VAR_portainer_origin`). OpsCrew
 * creates no DNS record for web modes `proxy` and `caddy`, so a plan that needs neither tunnel
 * renders no files at all. Only servers OpsCrew creates move: a move layout for a server the user
 * owns, a Portainer target or a server-less target throws.
 *
 * On Cloudflare's hosting (`cloudflare-workers`) the root module has only `module "worker"`
 * (`cloudflare-workers`): the Worker's shell, its `workers.dev` and preview switches, and one
 * custom domain per hostname (the domain, and `www.` when on); output `url`. Needs
 * `ctx.cloudflare.accountId`.
 *
 * On GitHub Pages (`github-pages`) the root module has only `module "dns"`, the `cloudflare-dns`
 * module's GitHub Pages mode (`cloudflare-dns/github-pages`), DNS only: an apex domain's A and AAAA
 * records, or a subdomain's CNAME, to GitHub Pages, and `www.` when on; output `url`. GitHub's
 * domain verification record is in a root of its own ({@link renderPagesVerification}).
 */
export function renderInfra(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  const portainer = ctx.layout === undefined && plan.target.provider === "portainer";
  if (!portainer && usesCloudflare(plan) && !ctx.cloudflare?.zoneId) {
    throw new Error("A Cloudflare zone id is required to render DNS for this plan.");
  }
  const root = rootModule(plan, ctx);
  if (root === undefined) return [];
  const dir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const modulesDir = `${dir.slice(0, dir.lastIndexOf("/") + 1)}modules`;
  const files: RenderedFile[] = [
    { path: `${dir}/versions.tf`, content: root.versions, kind: "infra" },
    { path: `${dir}/main.tf`, content: root.main, kind: "infra" },
    { path: `${dir}/variables.tf`, content: root.variables, kind: "infra" },
    { path: `${dir}/outputs.tf`, content: root.outputs, kind: "infra" },
    {
      path: `${dir}/terraform.tfvars.json`,
      content: `${JSON.stringify(root.tfvars, null, 2)}\n`,
      kind: "infra",
    },
  ];
  for (const [path, content] of Object.entries(MODULE_FILES).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // A module's own files only: the GitHub Pages mode of `cloudflare-dns` is a folder inside it.
    if (root.modules.includes(path.slice(0, path.lastIndexOf("/")))) {
      files.push({ path: `${modulesDir}/${path}`, content, kind: "infra" });
    }
  }
  return files;
}
