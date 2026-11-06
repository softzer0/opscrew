import {
  APP_SERVER,
  type CloudDeployTarget,
  type DeployPlan,
  type DeployTarget,
  isCloudProvider,
  type OwnDeployTarget,
  type PortainerDeployTarget,
} from "@opscrew/plan-schema";
import { MODULE_FILES } from "../generated/modules";
import { webOnlyFromCloudflare } from "../predicates";
import {
  cloudTarget,
  PROVIDER_TEXT,
  type ProviderText,
  type VariablePrefix,
  wrongTarget,
} from "../providers";
import type { InfraLayout, LayoutSide, RenderContext, RenderedFile, ServerModule } from "../types";
import {
  dnsModule,
  previewsCertificatePack,
  serverZoneUse,
  zoneTfvars,
  zoneVariables,
} from "./cloudflare";
import {
  APP_NAME_VARIABLE,
  besideInfraDir,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  moduleBlock,
  output,
  type RootFiles,
  rootHeader,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";
import { ownRoot } from "./own";
import { managesPortainerRecords, portainerRoot } from "./portainer";
import { siteRootModule } from "./serverless";
import {
  addressVariables,
  borrowedShared,
  checkKeyArgument,
  type ExtraServerCall,
  extraServerCalls,
  extraServerModules,
  extraServersOutput,
  keyTfvars,
  keyVariables,
  previousWireguardArgument,
  providerBlock,
  type SharedLayout,
  serverTfvars,
  serverVariables,
  sharedMoves,
  wireguardArgument,
} from "./servers";
import { type TunnelPieces, tunnelPieces } from "./tunnel";

export { MOVE_LAYOUTS, type MoveLayoutName, moveLayout } from "./layouts";
export {
  managesPortainerRecords,
  PORTAINER_WEBHOOK_PATH,
  portainerWebhookHostname,
} from "./portainer";
export {
  pagesVerificationRootDir,
  renderPagesVerification,
  verificationRecordName,
} from "./serverless";
export { appServerVariables, extraServerVariables } from "./servers";
export {
  type BucketProvider,
  PREVIOUS_BUCKET_PROFILE,
  type ProviderBucket,
  providerBucket,
  renderStorage,
  storageRootDir,
} from "./storage";

const OPEN_TO_ALL = ["0.0.0.0/0", "::/0"];

/** Added to `main.tf` below the header while a move is in progress (a layout is given). */
function moveNote(to: "provider" | "server"): string {
  return [
    `# A move to another ${to} is in progress: \`opscrew retarget\` manages these files until the`,
    "# move is finished (`opscrew retarget --finish`) or aborted (`opscrew retarget --abort`).",
  ].join("\n");
}

/** CIDRs allowed to reach ports 80/443: Cloudflare's ranges when proxied and restricted. */
function httpAllowedCidrs(plan: DeployPlan, ctx: RenderContext): string[] {
  const ranges = ctx.cloudflareRanges;
  if (webOnlyFromCloudflare(plan) && ranges && ranges.length > 0) return [...ranges];
  return OPEN_TO_ALL;
}

/** A server module call of the root module: a side OpsCrew creates. */
interface ServerCall {
  kind: "module";
  slot: ServerModule;
  target: CloudDeployTarget;
  /** Prefix of the server's own root variables (`location`, `server_type`, …). */
  prefix: VariablePrefix;
  provider: ProviderText;
}

/**
 * A side OpsCrew does not create during a move (a server the user owns, a Portainer
 * environment): the address the DNS records point at, `var.<prefix>server_ipv4`/`_ipv6`.
 */
interface AddressCall {
  kind: "address";
  slot: ServerModule;
  prefix: "" | "previous_";
  target: OwnDeployTarget | PortainerDeployTarget;
}

/** What the root module contains, resolved from `ctx.layout` (or the plan's target). */
interface RootShape {
  /** Every side: the `server` slot first, then `server_previous`. */
  sides: (ServerCall | AddressCall)[];
  /** The sides that are server modules. */
  servers: ServerCall[];
  /** The sides that are addresses. */
  addresses: AddressCall[];
  /** The side the DNS module and the `server_*` outputs follow. */
  live: ServerCall | AddressCall;
  moved?: { from: ServerModule; to: ServerModule };
  /** The plan's extra cloud servers, `module "server_<name>"` each. */
  extras: ExtraServerCall[];
  /** Providers whose requirement, provider block and module are rendered, in the given order. */
  providers: ProviderText[];
  /** True while a move is in progress (a layout was given). */
  moving: boolean;
  /** Which server modules hold the deploy key and app tag the extra servers use. */
  shared: SharedLayout;
}

/** The HCL expressions of a side's addresses. */
function addressesOf(side: ServerCall | AddressCall): { ipv4: string; ipv6: string } {
  return side.kind === "module"
    ? { ipv4: `module.${side.slot}.ipv4_address`, ipv6: `module.${side.slot}.ipv6_address` }
    : { ipv4: `var.${side.prefix}server_ipv4`, ipv6: `var.${side.prefix}server_ipv6` };
}

/**
 * Resolves the root module's layout. Without `ctx.layout` this is `module "server"` for
 * `plan.target` and its provider; the plan's extra cloud servers and their providers come after.
 * Without a layout only servers OpsCrew creates have this root: throws for a plan for any other
 * target, and for layouts the engines would reject.
 */
function rootShape(plan: DeployPlan, ctx: RenderContext): RootShape {
  const layout = ctx.layout ?? plainLayout(plan);
  const call = (slot: ServerModule, side: LayoutSide | undefined): (ServerCall | AddressCall)[] => {
    if (side === undefined) return [];
    const prefix = slot === "server" ? "" : "previous_";
    if (side.provider === "own" || side.provider === "portainer") {
      return [{ kind: "address", slot, prefix, target: side }];
    }
    return [{ kind: "module", slot, target: side, prefix, provider: PROVIDER_TEXT[side.provider] }];
  };
  const sides = [...call("server", layout.server), ...call("server_previous", layout.previous)];
  const servers = sides.filter((side): side is ServerCall => side.kind === "module");
  const addresses = sides.filter((side): side is AddressCall => side.kind === "address");
  const live = sides.find((side) => side.slot === layout.live);
  if (!live) {
    throw new Error(
      `The infrastructure layout points DNS at module "${layout.live}", which it does not render.`,
    );
  }
  const { moved } = layout;
  if (moved) {
    const declared = new Set(servers.map((s) => s.slot));
    if (moved.from === moved.to || declared.has(moved.from) || !declared.has(moved.to)) {
      throw new Error(
        `The infrastructure layout cannot move module.${moved.from} to module.${moved.to}: a moved block needs the destination module and no module at the source address.`,
      );
    }
  }
  const [first, second] = servers;
  if (second !== undefined && first?.target.provider === second.target.provider) {
    // Both modules name their resources after the app; on one provider they would collide.
    throw new Error(
      `The infrastructure layout renders two ${first.target.provider} servers; a move needs two different providers.`,
    );
  }
  const extras = extraServerCalls(plan);
  const providers = [...new Set([...layout.providers, ...extras.map((e) => e.target.provider)])];
  for (const { target: server } of servers) {
    if (!providers.includes(server.provider)) {
      throw new Error(
        `The infrastructure layout renders a ${server.provider} server but does not list the ${server.provider} provider.`,
      );
    }
  }
  const moving = ctx.layout !== undefined;
  const slotProvider = (slot: ServerModule) =>
    servers.find((server) => server.slot === slot)?.target.provider;
  const finishing = moving && layout.previous === undefined && moved === undefined;
  const server = slotProvider("server");
  return {
    sides,
    servers,
    addresses,
    live,
    moved,
    extras,
    providers: providers.map((provider) => PROVIDER_TEXT[provider]),
    moving,
    shared: {
      server,
      previous: slotProvider("server_previous"),
      bothSides: moving && layout.previous !== undefined,
      finishing,
      // Every layout of a move renders the old cloud side's provider.
      leaving: finishing ? layout.providers.find((provider) => provider !== server) : undefined,
    },
  };
}

/** The layout of a root without a move: `plan.target` as `module "server"`. */
function plainLayout(plan: DeployPlan): InfraLayout {
  const target = cloudTarget(plan.target);
  return { server: target, live: "server", providers: [target.provider] };
}

/**
 * True for a server the user owns behind OpsCrew's web filter: it publishes the site on IPv4 only,
 * so its records have no AAAA record (as in its own root).
 */
const ipv4Only = (plan: DeployPlan, side: Pick<DeployTarget, "provider">): boolean =>
  side.provider === "own" && webOnlyFromCloudflare(plan);

/**
 * Whether the app's AAAA record exists while a move's DNS records point at `side` (the live side
 * of a layout), whose address has IPv6 or not (`ipv6`): always for a server OpsCrew creates, never
 * for a server the user owns behind OpsCrew's web filter, otherwise when the address has IPv6. The
 * other side never matters, so a switch between sides that differ creates or deletes the record.
 */
export function moveAaaaRecord(plan: DeployPlan, side: DeployTarget, ipv6: boolean): boolean {
  if (isCloudProvider(side.provider)) return true;
  return !ipv4Only(plan, side) && ipv6;
}

/**
 * The DNS module's `ipv6_record`, which follows the live side ({@link moveAaaaRecord}): none for a
 * server module (the module's default, on), `false` behind the web filter of a server the user
 * owns, else whether the address has IPv6.
 */
function ipv6Record(plan: DeployPlan, live: ServerCall | AddressCall): string | undefined {
  if (live.kind === "module") return undefined;
  if (ipv4Only(plan, live.target)) return "false";
  return `${addressesOf(live).ipv6} != null`;
}

/**
 * The `import` blocks adopting the app's DNS records into `module "dns"` (`ctx.adoptRecords`),
 * for a Portainer side whose records are still the user's. Throws when such a side has no ids:
 * the DNS module would otherwise create the records a second time.
 */
function adoptingImports(shape: RootShape, ctx: RenderContext): string[] {
  const ids = ctx.adoptRecords;
  if (ids === undefined) {
    const users = shape.addresses.some(
      ({ target }) => target.provider === "portainer" && !managesPortainerRecords(target),
    );
    if (users) {
      throw wrongTarget(
        "The app's DNS records on Cloudflare are still yours (the Portainer target's web.records is not true), and OpsCrew has no ids to adopt them, so it did not render records that would duplicate them.",
      );
    }
    return [];
  }
  const block = (to: string, id: string) => [
    "import {",
    `  to = module.dns.cloudflare_dns_record.${to}`,
    `  id = "${ctx.cloudflare?.zoneId}/${id}"`,
    "}",
    "",
  ];
  return [
    "# The app's DNS records were yours: OpsCrew adopts them into the DNS module, so that the move",
    "# switches them in place. Importing a record changes nothing in Cloudflare.",
    ...block("a", ids.a),
    ...(ids.aaaa === undefined ? [] : block("aaaa[0]", ids.aaaa)),
    ...(ids.www === undefined ? [] : block("www[0]", ids.www)),
  ];
}

function mainTf(
  plan: DeployPlan,
  shape: RootShape,
  ctx: RenderContext,
  pieces: TunnelPieces | undefined,
  checkKey: boolean,
): string {
  const lines = [rootHeader(plan), ""];
  if (shape.moving) lines.push(moveNote(shape.addresses.length > 0 ? "server" : "provider"), "");
  for (const provider of shape.providers) lines.push(...providerBlock(provider));
  const zone = serverZoneUse(plan);
  if (zone !== undefined) lines.push(...CLOUDFLARE_PROVIDER_BLOCK);
  const borrowed = borrowedShared(shape.extras, shape.shared);
  for (const server of shape.servers) {
    const previous = server.slot === "server_previous";
    // The old app server: `server_previous`, or `server` again while an abort renames it back.
    const old = previous || shape.moved?.to === "server";
    const shared = previous ? undefined : borrowed;
    lines.push(
      ...moduleBlock({
        comment: previous
          ? [
              `# The previous ${server.provider.serverNoun}, kept until the move is finished or aborted.`,
            ]
          : [],
        name: server.slot,
        source: server.provider.module,
        args: [
          ...server.provider.moduleArguments({
            prefix: server.prefix,
            ...(shared?.appTag === undefined ? {} : { appTag: shared.appTag }),
          }),
          ...(old ? previousWireguardArgument(plan) : wireguardArgument(plan, APP_SERVER)),
          ...(shared === undefined ? [] : [["ssh_key_id", shared.sshKeyId] as const]),
          ...checkKeyArgument(checkKey && !previous),
        ],
      }),
    );
  }
  lines.push(...extraServerModules(plan, shape.extras, shape.shared, checkKey));
  lines.push(...sharedMoves(shape.extras, shape.shared));
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
  if (zone !== undefined) {
    const { ipv4, ipv6 } = addressesOf(shape.live);
    lines.push(...dnsModule(zone, ipv4, ipv6, ipv6Record(plan, shape.live)));
    lines.push(...adoptingImports(shape, ctx));
  }
  lines.push(...(previewsCertificatePack(plan)?.main ?? []));
  if (pieces) lines.push(...pieces.main);
  return lines.join("\n");
}

/** Whether the root holds servers OpsCrew creates: the deploy key and SSH networks are theirs. */
const hasModules = (shape: RootShape) => shape.servers.length + shape.extras.length > 0;

function variables(
  plan: DeployPlan,
  shape: RootShape,
  pieces: TunnelPieces | undefined,
  checkKey: boolean,
): VariableSpec[] {
  const base: VariableSpec[] = [
    APP_NAME_VARIABLE,
    ...shape.sides.flatMap((side) => {
      const previous = side.slot === "server_previous";
      if (side.kind === "module") return serverVariables(side, previous ? "previous" : undefined);
      const noun = side.target.provider === "own" ? "server" : "Portainer environment";
      return addressVariables(side.prefix, `${previous ? "the previous" : "your"} ${noun}`);
    }),
    ...shape.extras.flatMap((extra) => serverVariables(extra, extra.name)),
    ...(hasModules(shape) ? keyVariables(checkKey) : []),
    ...(shape.servers.length > 0
      ? [
          {
            name: "http_allowed_cidrs",
            type: "list(string)",
            description: "Networks allowed to reach ports 80 and 443.",
          },
        ]
      : []),
  ];
  const zone = serverZoneUse(plan);
  if (zone === undefined) return base;
  return [...base, ...zoneVariables(zone), ...(pieces?.variables ?? [])];
}

/**
 * `output "servers"`: every server module's addresses and id, keyed by the server's provider; none
 * without a server module. During a move OpsCrew tells the server being replaced from the new one
 * by provider, whichever module holds each and whichever layout was applied last; the addresses of
 * the other sides are its own (`.opscrew/server.json`).
 */
function serversOutput(shape: RootShape): string[] {
  if (shape.servers.length === 0) return [];
  return [
    "# Every server by provider. During a move to another provider, OpsCrew tells the server being",
    "# replaced from the new one by their providers.",
    'output "servers" {',
    "  value = {",
    ...shape.servers.flatMap(({ slot, target }) => [
      `    ${target.provider} = {`,
      `      ipv4 = module.${slot}.ipv4_address`,
      `      ipv6 = module.${slot}.ipv6_address`,
      `      id   = module.${slot}.server_id`,
      "    }",
    ]),
    "  }",
    "}",
    "",
  ];
}

function outputsTf(plan: DeployPlan, shape: RootShape, pieces: TunnelPieces | undefined): string {
  const { live } = shape;
  const { ipv4, ipv6 } = addressesOf(live);
  // A preview environment serves no address of its own: its url is the server's.
  const url = serverZoneUse(plan) === "records" ? "module.dns.url" : `"http://\${${ipv4}}"`;
  return [
    rootHeader(plan),
    "",
    ...output("server_ipv4", ipv4),
    ...output("server_ipv6", ipv6),
    // Only a server OpsCrew creates has an id and a name.
    ...(live.kind === "module"
      ? [
          ...output("server_id", `module.${live.slot}.server_id`),
          ...output("server_name", `module.${live.slot}.server_name`),
        ]
      : []),
    ...output("url", url),
    ...serversOutput(shape),
    ...extraServersOutput(shape.extras),
    ...(previewsCertificatePack(plan)?.outputs ?? []),
    ...(pieces?.outputs ?? []),
  ].join("\n");
}

/**
 * The root module of servers OpsCrew creates: `plan.target` as `module "server"`, or the sides
 * of `ctx.layout` during a move.
 */
function cloudRoot(plan: DeployPlan, ctx: RenderContext): RootFiles {
  const shape = rootShape(plan, ctx);
  const pieces = tunnelPieces(plan, ctx);
  const values: Record<string, unknown> = { app_name: plan.app.name };
  for (const { prefix, target } of [...shape.servers, ...shape.extras]) {
    Object.assign(values, serverTfvars(prefix, target));
  }
  if (hasModules(shape)) Object.assign(values, keyTfvars(plan, ctx));
  if (shape.servers.length > 0) values.http_allowed_cidrs = httpAllowedCidrs(plan, ctx);
  const checkKey = ctx.checkKeyLine !== undefined;
  const zone = serverZoneUse(plan);
  return {
    versions: versionsTf(plan, [
      ...shape.providers.map((provider) => provider.terraformProvider),
      ...(zone !== undefined ? [CLOUDFLARE_PROVIDER] : []),
    ]),
    main: mainTf(plan, shape, ctx, pieces, checkKey),
    variables: variablesTf(plan, variables(plan, shape, pieces, checkKey)),
    outputs: outputsTf(plan, shape, pieces),
    tfvars: {
      ...values,
      ...(zone !== undefined ? zoneTfvars(plan, ctx, zone) : {}),
      ...(pieces?.tfvars ?? {}),
    },
    modules: [
      ...shape.providers.map((provider) => provider.module),
      ...(zone !== undefined ? ["cloudflare-dns"] : []),
      ...(pieces?.modules ?? []),
    ],
  };
}

/**
 * The root module for the plan: a Portainer target's (none when it needs neither a Cloudflare
 * Tunnel nor its records), a server the user owns, Cloudflare's hosting, GitHub Pages, or servers
 * OpsCrew creates (with a move layout, always this one).
 */
function rootModule(plan: DeployPlan, ctx: RenderContext): RootFiles | undefined {
  if (ctx.layout === undefined) {
    const { target } = plan;
    if (target.provider === "portainer") return portainerRoot(plan, ctx);
    if (target.provider === "own") return ownRoot(plan, ctx);
    const site = siteRootModule(plan, ctx);
    if (site !== undefined) return site;
  }
  return cloudRoot(plan, ctx);
}

/**
 * Non-secret variable values, written as `terraform.tfvars.json`. `delete_protection` and
 * `previous_delete_protection` are left out on purpose: they keep their default (on), and
 * `opscrew destroy` or `opscrew retarget --finish` lift them with `-var …=false` without editing
 * committed files. DigitalOcean has no delete protection, so its servers have no such variable.
 * With `ctx.layout`, each server module's target is written under its own variables (`previous_*`
 * for `module "server_previous"`). For a server the user owns or a Portainer environment, the
 * addresses are never written: the CLI supplies `server_ipv4`/`server_ipv6` (and
 * `previous_server_ipv4`/`previous_server_ipv6` in a move) as `TF_VAR_*`. A Portainer target
 * never writes Portainer's address (`TF_VAR_portainer_origin`) and has `{}` when it has no root
 * module.
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
 * Each extra cloud server of the plan (`plan.servers`) is `module "server_<name>"`, named
 * `<app>-<name>`, with no web ports and the private network's port. On the app server's provider
 * it gets `module "server"`'s deploy key (and DigitalOcean app tag); on another provider the root
 * creates them once for every extra server there. `extra_servers` maps each name to
 * `{ ipv4, ipv6, id, name }`.
 * With `plan.network`, the app's server module gets the network's port too. An app on a server
 * the user owns gets the same extra server modules in its own root.
 *
 * With `ctx.layout` (a move) it renders the layout's sides: a cloud side as its server module
 * (`module "server"`, `module "server_previous"`), a server the user owns or a Portainer
 * environment as the address variables of its slot (`server_ipv4`/`server_ipv6`,
 * `previous_server_ipv4`/`previous_server_ipv6`, supplied as `TF_VAR_*` and never written to
 * `terraform.tfvars.json`). It renders the layout's `moved` block, every listed provider's
 * requirement, provider block and vendored module, and DNS and the `server_*` outputs from the
 * live side (no `server_id`/`server_name` for an address; `servers` lists only server modules).
 * The deploy key, SSH and web networks are declared only with a server module. The DNS module's
 * AAAA record follows the live side ({@link moveAaaaRecord}), so the switch updates the records in
 * place, and creates or deletes the AAAA record only when the two sides differ. A Portainer side whose records are still the
 * user's needs `ctx.adoptRecords`, which adds `import` blocks adopting them into `module "dns"`.
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
 * For a Portainer target (`target.provider === "portainer"`) the root module has Cloudflare
 * Tunnels: the app's for web mode `tunnel`, and in redeploy mode `cloudflare` one and Access for
 * Portainer's webhook hostname (Portainer's address from `TF_VAR_portainer_origin`). OpsCrew
 * creates no DNS record for web modes `proxy` and `caddy`, except in web mode `caddy` with
 * `records` (`module "dns"` to the environment's public address, `TF_VAR_server_ipv4` and
 * `TF_VAR_server_ipv6`, output `url`); a plan that needs none of these renders no files at all.
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
 *
 * While a site moves between the two (`ctx.siteMove`), the root holds the Worker as a shell
 * without custom domains (`custom_domains = false`) beside GitHub Pages' records, which wait for
 * the Worker's changes (`depends_on`); `url` follows the records.
 *
 * A preview environment's root (`environment.previews`: a zone, no domain) gets its server as
 * usual, its web ports open to Cloudflare only, and, in place of the app's records, `module "dns"`
 * with the previews' wildcard `*.${var.preview_domain}` through Cloudflare's proxy, without `www.`
 * or CAA; its `url` output is the server's address. With `previews.domain` below `dns.zone` it
 * also orders `cloudflare_certificate_pack.previews` (output `previews_certificate_pack_id`). On
 * a server the user owns, or another environment's (`previews.server`), it is an own target's
 * root: DNS only, the wildcard to `server_ipv4`/`server_ipv6` from `TF_VAR_*`.
 */
export function renderInfra(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  const portainer = ctx.layout === undefined && plan.target.provider === "portainer";
  if (!portainer && serverZoneUse(plan) !== undefined && !ctx.cloudflare?.zoneId) {
    throw new Error("A Cloudflare zone id is required to render DNS for this plan.");
  }
  const root = rootModule(plan, ctx);
  if (root === undefined) return [];
  const dir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const modulesDir = besideInfraDir(plan, "modules");
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
