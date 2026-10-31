import type { CloudProvider, DeployPlan } from "@opscrew/plan-schema";
import { PROVIDER_TEXT, type ProviderText, type VariablePrefix } from "../providers";
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
  provider: ProviderText;
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
  return { location: `${name}_location`, serverType: `${name}_server_type` };
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
            provider: PROVIDER_TEXT[target.provider],
          },
        ],
  );
}

/** `provider "<name>" {}` with where its token comes from, followed by a blank line. */
export function providerBlock(provider: ProviderText): string[] {
  return [
    `# Token from the ${provider.tokenVar} environment variable (never stored in files or state).`,
    `provider "${provider.terraformProvider.name}" {}`,
    "",
  ];
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
 * A server's own variables: `location`, `server_type`, `image`, `backups` and, for Hetzner,
 * `delete_protection`, under its prefix. `label` names the server in the descriptions:
 * `previous` for `module "server_previous"`, an extra server's name, none for the app's server.
 */
export function serverVariables(
  { prefix, provider }: { prefix: VariablePrefix; provider: ProviderText },
  label?: string,
): VariableSpec[] {
  const describe = (text: string) =>
    label === undefined
      ? text
      : `${text.replace(/\.$/, "")} of the ${label} ${provider.serverNoun}.`;
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
      description:
        label === "previous"
          ? "Protect the previous server against accidental deletion and rebuilds; `opscrew retarget --finish` passes false."
          : `Protect the ${label === undefined ? "" : `${label} `}server against accidental deletion and rebuilds; \`opscrew destroy\` passes false.`,
      default: "true",
    });
  }
  return specs.map((spec) => ({ ...spec, name: `${prefix}${spec.name}` }));
}

/** A server's own variable values (`delete_protection` keeps its default). */
export function serverTfvars(
  prefix: VariablePrefix,
  target: ServerSettings,
): Record<string, unknown> {
  return {
    [`${prefix}location`]: target.location,
    [`${prefix}server_type`]: target.serverType,
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
              "The scheduled check's line for the deploy user's authorized_keys (its key, restricted to df), written at a new server's first boot.",
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

/** The deploy key (and DigitalOcean app tag) `module "server"` holds, for extra servers beside it. */
const APP_SERVER_SHARED = {
  sshKeyId: "module.server.ssh_key_id",
  appTag: "module.server.app_tag_name",
};

/**
 * The extra servers' module blocks: named `<app>-<name>`, no web traffic, the network's port.
 * On `appProvider` (the provider of `module "server"`) they get its deploy key and DigitalOcean app
 * tag; on any other provider the root creates both once, before the modules, so removing or
 * reordering an extra server never deletes or moves them.
 */
export function extraServerModules(
  plan: DeployPlan,
  calls: readonly ExtraServerCall[],
  appProvider: CloudProvider | undefined,
  checkKey: boolean,
): string[] {
  const others = new Set(
    calls.filter((call) => call.target.provider !== appProvider).map((call) => call.provider),
  );
  return [
    ...[...others].flatMap((provider) => provider.extraShared.resources),
    ...calls.flatMap((call) => {
      const shared =
        call.target.provider === appProvider ? APP_SERVER_SHARED : call.provider.extraShared;
      return moduleBlock({
        comment: [
          `# The ${call.name} ${call.provider.serverNoun}: no web traffic, only its services on the private network.`,
        ],
        name: call.module,
        source: call.provider.module,
        args: [
          ...call.provider.moduleArguments({
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
