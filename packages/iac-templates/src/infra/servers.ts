import type { CloudProviderDefinition, VariablePrefix } from "@opscrew/contracts";
import type { CloudProvider, DeployPlan } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { RenderContext } from "../types";
import { moduleBlock, type VariableSpec } from "./hcl";

/** A cloud server's settings the root module passes to its module. */
interface ServerSettings {
  provider: CloudProvider;
  location: string;
  serverType: string;
  image?: string | undefined;
  backups: boolean;
}

/** An extra cloud server of the plan (`plan.servers`), rendered as `module "server_<name>"`. */
export interface ExtraServerCall {
  name: string;
  module: string;
  prefix: VariablePrefix;
  target: ServerSettings;
  provider: CloudProviderDefinition;
}

/** The prefix of an extra server's own root variables: `<name>_`. */
function extraServerPrefix(name: string): VariablePrefix {
  return `${name}_`;
}

/**
 * The root module's variables that hold the extra server `name`'s location and server type, as
 * `terraform.tfvars.json` holds them once provision rendered the server.
 */
export function extraServerVariables(name: string): { location: string; serverType: string } {
  return serverVariableNames(extraServerPrefix(name));
}

/** The root module's variables that hold the app server's location and server type (no prefix). */
export function appServerVariables(): { location: string; serverType: string } {
  return serverVariableNames("");
}

/** The names {@link serverTfvars} writes a server's location and server type under. */
function serverVariableNames(prefix: VariablePrefix): { location: string; serverType: string } {
  return { location: `${prefix}location`, serverType: `${prefix}server_type` };
}

/** The plan's extra servers OpsCrew creates, in plan order; servers the user owns have none. */
export function extraServerCalls(plan: DeployPlan): ExtraServerCall[] {
  return (plan.servers ?? []).flatMap(({ name, target }) =>
    target.provider === "own"
      ? []
      : [
          {
            name,
            module: `server_${name}`,
            prefix: extraServerPrefix(name),
            target,
            provider: cloudProvider(target.provider),
          },
        ],
  );
}

/** `provider "<name>" {}` with where its credentials come from, followed by a blank line. */
export function providerBlock({ terraform }: CloudProviderDefinition): string[] {
  return [`# ${terraform.credentialsComment}`, `provider "${terraform.provider.name}" {}`, ""];
}

/** The root variable and module argument of the scheduled check's key line. */
const CHECK_KEY_LINE = "check_key_line";

/** `check_key_line = var.check_key_line` when the root has the scheduled check's key. */
export function checkKeyArgument(checkKey: boolean): (readonly [string, string])[] {
  return checkKey ? [[CHECK_KEY_LINE, `var.${CHECK_KEY_LINE}`]] : [];
}

/** `wireguard_port = <port>` for a member of the plan's private network; none without one. */
export function wireguardArgument(plan: DeployPlan, member: string): (readonly [string, string])[] {
  const port = plan.network?.members.find((m) => m.name === member)?.port;
  return port === undefined ? [] : [["wireguard_port", String(port)]];
}

/**
 * `wireguard_port = <port>` for the old app server during a move: its member of the private
 * network until `--finish` (`retarget.from.member`); none without one.
 */
export function previousWireguardArgument(plan: DeployPlan): (readonly [string, string])[] {
  const port = plan.retarget?.from.member?.port;
  return port === undefined ? [] : [["wireguard_port", String(port)]];
}

/**
 * A server's own variables: `location`, `server_type`, `image`, `backups` and, when its module
 * has the switch, `delete_protection`, under its prefix. `label` names the server in the descriptions:
 * `previous` for `module "server_previous"`, an extra server's name, none for the app's server.
 */
export function serverVariables(
  { prefix, provider }: { prefix: VariablePrefix; provider: CloudProviderDefinition },
  label?: string,
): VariableSpec[] {
  const { descriptions, deleteProtectionVariable } = provider.terraform;
  const describe = (text: string) =>
    label === undefined
      ? text
      : `${text.replace(/\.$/, "")} of the ${label} ${provider.serverNoun}.`;
  const specs: VariableSpec[] = [
    { name: "location", type: "string", description: describe(descriptions.location) },
    {
      name: "server_type",
      type: "string",
      description: describe(descriptions.serverType),
    },
    { name: "image", type: "string", description: describe("Operating system image.") },
    { name: "backups", type: "bool", description: describe(descriptions.backups) },
  ];
  if (deleteProtectionVariable) {
    specs.push({
      name: "delete_protection",
      type: "bool",
      description:
        label === "previous"
          ? "Protect the previous server against accidental deletion and rebuilds; `opscrew retarget --finish` passes false."
          : `Protect the ${label === undefined ? "" : `${label} `}server against accidental deletion and rebuilds; \`opscrew destroy\` passes false.`,
      default: "true",
    });
  }
  return specs.map((spec) => ({ ...spec, name: `${prefix}${spec.name}` }));
}

/**
 * The variables of a server OpsCrew does not create, which the DNS records point at:
 * `<prefix>server_ipv4` and `<prefix>server_ipv6` (null without IPv6). The CLI passes them as
 * `TF_VAR_*` from `.opscrew/server.json`; they are never written to a committed file. `what`
 * names the server in the descriptions, for example `your server`.
 */
export function addressVariables(prefix: "" | "previous_", what: string): VariableSpec[] {
  const passed = (name: string) =>
    `OpsCrew passes it as TF_VAR_${name} from .opscrew/server.json; it is never written to a committed file.`;
  return [
    {
      name: `${prefix}server_ipv4`,
      type: "string",
      description: `Public IPv4 address of ${what}. ${passed(`${prefix}server_ipv4`)}`,
    },
    {
      name: `${prefix}server_ipv6`,
      type: "string",
      description: `Public IPv6 address of ${what}, or null when it has none (no AAAA record). ${passed(`${prefix}server_ipv6`)}`,
      default: "null",
    },
  ];
}

/** A server's own variable values (`delete_protection` keeps its default). */
export function serverTfvars(
  prefix: VariablePrefix,
  target: ServerSettings,
): Record<string, unknown> {
  const names = serverVariableNames(prefix);
  return {
    [names.location]: target.location,
    [names.serverType]: target.serverType,
    [`${prefix}image`]: target.image,
    [`${prefix}backups`]: target.backups,
  };
}

/** The deploy key, the scheduled check's key line (when given) and the SSH CIDRs every server shares. */
export function keyVariables(checkKey: boolean): VariableSpec[] {
  return [
    {
      name: "deploy_ssh_public_key",
      type: "string",
      description: "Public half of the deploy key.",
    },
    ...(checkKey
      ? [
          {
            name: CHECK_KEY_LINE,
            type: "string",
            description:
              "The scheduled check's line for the deploy user's authorized_keys (its key, restricted to OpsCrew's read-only command for the disk and the scheduled snapshots), written at a new server's first boot.",
          },
        ]
      : []),
    {
      name: "ssh_allowed_cidrs",
      type: "list(string)",
      description: "Networks allowed to reach SSH.",
    },
  ];
}

/** The values of {@link keyVariables}. */
export function keyTfvars(plan: DeployPlan, ctx: RenderContext): Record<string, unknown> {
  return {
    deploy_ssh_public_key: ctx.deploySshPublicKey.trim(),
    ...(ctx.checkKeyLine === undefined ? {} : { [CHECK_KEY_LINE]: ctx.checkKeyLine }),
    ssh_allowed_cidrs: plan.security.sshAllowedCidrs,
  };
}

/**
 * Which server modules the root holds, for where the extra servers get the deploy key (and
 * DigitalOcean's app tag) from. Without a move only `server` is set.
 */
export interface SharedLayout {
  /** The provider of `module "server"`, when it is a server module. */
  server?: CloudProvider | undefined;
  /** The provider of `module "server_previous"`, when it is a server module. */
  previous?: CloudProvider | undefined;
  /**
   * A move before `--finish` (both sides in the root): `module "server"` is the new server, which
   * holds no key or tag of its own while extra servers on its provider use the root's.
   */
  bothSides: boolean;
  /** The layout of `--finish`: the old side has gone and the root becomes the final one. */
  finishing: boolean;
  /** At `--finish`, the old side's cloud provider, whose server module goes. */
  leaving?: CloudProvider | undefined;
}

/**
 * The resources a provider's deploy key and app tag are, in the root and in a server module: the
 * addresses of the resources its `extraShared` creates.
 */
function sharedResources(provider: CloudProvider): string[] {
  return cloudProvider(provider).terraform.extraShared.resources.flatMap((line) => {
    const resource = /^resource "(\w+)" "(\w+)" \{$/.exec(line);
    return resource ? [`${resource[1]}.${resource[2]}`] : [];
  });
}

/** The deploy key and DigitalOcean's app tag a server module holds, for extra servers beside it. */
function moduleShared(module: "server" | "server_previous") {
  return { sshKeyId: `module.${module}.ssh_key_id`, appTag: `module.${module}.app_tag_name` };
}

/**
 * Where the extra servers on `provider` get the deploy key and app tag: the server module on it
 * that holds them (`server_previous` during a move, `server` otherwise), else the root, which
 * also holds them for the new `module "server"` while a move has both sides.
 */
function sharedSource(
  layout: SharedLayout,
  provider: CloudProvider,
): "server" | "server_previous" | "root" {
  if (provider === layout.previous) return "server_previous";
  if (provider === layout.server && !layout.bothSides) return "server";
  return "root";
}

/**
 * The arguments that give `module "server"` the root's deploy key and app tag: during a move with
 * both sides, when extra servers on its provider use them (both providers refuse the same key
 * twice, and a DigitalOcean tag is deleted from every Droplet with it). None otherwise.
 */
export function borrowedShared(
  calls: readonly ExtraServerCall[],
  layout: SharedLayout,
): { sshKeyId: string; appTag?: string } | undefined {
  const provider = layout.server;
  if (!layout.bothSides || !calls.some((call) => call.target.provider === provider)) {
    return undefined;
  }
  return provider === undefined ? undefined : cloudProvider(provider).terraform.extraShared;
}

/**
 * The `moved` blocks of `--finish` for the deploy key and app tag the extra servers keep using:
 * the old server module's go to the root (the extra servers on its provider use the root's from
 * now on), and the root's go to the new `module "server"` (which holds them from now on). Nothing
 * is deleted from under the extra servers.
 */
export function sharedMoves(calls: readonly ExtraServerCall[], layout: SharedLayout): string[] {
  if (!layout.finishing) return [];
  const used = (provider: CloudProvider | undefined) =>
    provider !== undefined && calls.some((call) => call.target.provider === provider);
  const moved = (from: string, to: string) => [
    "moved {",
    `  from = ${from}`,
    `  to   = ${to}`,
    "}",
  ];
  const lines: string[] = [];
  if (used(layout.leaving)) {
    lines.push(
      "# The old server's deploy key (and app tag) stay for the extra servers on its provider.",
      ...sharedResources(layout.leaving as CloudProvider).flatMap((resource) =>
        moved(`module.server_previous.${resource}[0]`, resource),
      ),
      "",
    );
  }
  if (used(layout.server)) {
    lines.push(
      "# The new server holds the deploy key (and app tag) the extra servers on its provider use.",
      ...sharedResources(layout.server as CloudProvider).flatMap((resource) =>
        moved(resource, `module.server.${resource}[0]`),
      ),
      "",
    );
  }
  return lines;
}

/**
 * The extra servers' module blocks: named `<app>-<name>`, no web traffic, the network's port.
 * Each gets the deploy key and DigitalOcean app tag where {@link sharedSource} says; on a provider
 * no server module holds them the root creates both once, before the modules, so removing or
 * reordering an extra server never deletes or moves them.
 */
export function extraServerModules(
  plan: DeployPlan,
  calls: readonly ExtraServerCall[],
  layout: SharedLayout,
  checkKey: boolean,
): string[] {
  const roots = new Set(
    calls
      .filter((call) => sharedSource(layout, call.target.provider) === "root")
      .map((call) => call.provider),
  );
  return [
    ...[...roots].flatMap((provider) => provider.terraform.extraShared.resources),
    ...calls.flatMap((call) => {
      const source = sharedSource(layout, call.target.provider);
      const shared = source === "root" ? call.provider.terraform.extraShared : moduleShared(source);
      return moduleBlock({
        comment: [
          `# The ${call.name} ${call.provider.serverNoun}: no web traffic, only its services on the private network.`,
        ],
        name: call.module,
        source: call.provider.terraform.module.name,
        args: [
          ...call.provider.terraform.moduleArguments({
            prefix: call.prefix,
            extra: call.name,
            ...(shared.appTag === undefined ? {} : { appTag: shared.appTag }),
          }),
          ["web", "false"],
          ...wireguardArgument(plan, call.name),
          ["ssh_key_id", shared.sshKeyId],
          ...checkKeyArgument(checkKey),
        ],
      });
    }),
  ];
}

/** `output "extra_servers"`: each extra server's addresses, id and name; none without one. */
export function extraServersOutput(calls: readonly ExtraServerCall[]): string[] {
  if (calls.length === 0) return [];
  return [
    "# The app's extra servers (the plan's servers) by name.",
    'output "extra_servers" {',
    "  value = {",
    ...calls.flatMap(({ name, module }) => [
      `    ${name} = {`,
      `      ipv4 = module.${module}.ipv4_address`,
      `      ipv6 = module.${module}.ipv6_address`,
      `      id   = module.${module}.server_id`,
      `      name = module.${module}.server_name`,
      "    }",
    ]),
    "  }",
    "}",
    "",
  ];
}
