/**
 * Taking over a server the infrastructure state lost (026 plan 4.3, FR-2607): an earlier apply
 * created it at the provider but stopped before recording it, so the next plan imports it with an
 * `import` block instead of buying another.
 */
import type { CloudProviderDefinition } from "@opscrew/contracts";
import { APP_SERVER, type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { RenderedFile } from "../types";
import { extraServerCalls } from "./servers";

/** A server of the plan that its root module imports from the provider. */
export interface ServerTakeover {
  /** `app`, or an extra server's name in the plan. */
  server: string;
  /** The server's id at its provider. */
  id: string;
}

/** A server OpsCrew creates in the root module: its module, its provider and its name there. */
interface CreatedServer {
  module: string;
  provider: CloudProviderDefinition;
  name: string;
}

function createdServer(plan: DeployPlan, server: string): CreatedServer | undefined {
  if (server === APP_SERVER) {
    const { provider } = plan.target;
    return isCloudProvider(provider)
      ? { module: "server", provider: cloudProvider(provider), name: plan.app.name }
      : undefined;
  }
  const extra = extraServerCalls(plan).find((call) => call.name === server);
  return extra === undefined
    ? undefined
    : { module: extra.module, provider: extra.provider, name: `${plan.app.name}-${server}` };
}

/**
 * The state address of the server `server` (`app` or an extra server's name) in the root module of
 * `plan` without a move, for example `module.server.hcloud_server.this` or
 * `module.server_db.digitalocean_droplet.this` (every server module names its server `this`);
 * `undefined` for a server OpsCrew does not create.
 */
export function serverResourceAddress(plan: DeployPlan, server: string): string | undefined {
  const created = createdServer(plan, server);
  return created === undefined ? undefined : addressOf(created);
}

function addressOf({ module, provider }: CreatedServer): string {
  return `module.${module}.${provider.terraform.serverResourceType}.this`;
}

/** Provider ids as OpsCrew's connectors give them: digits, letters and `-`, `_`, `.`, `:`. */
const SERVER_ID = /^[\w.:-]+$/;

/** The `import` block, with its comment, that takes over one server. */
function importBlock(plan: DeployPlan, { server, id }: ServerTakeover): string[] {
  const created = createdServer(plan, server);
  if (created === undefined) {
    throw new Error(`The plan creates no server "${server}", so there is none to take over.`);
  }
  if (!SERVER_ID.test(id)) {
    throw new Error(`"${id}" is not a server id OpsCrew can write into the infrastructure code.`);
  }
  const { provider, name } = created;
  return [
    `# ${provider.displayName}'s ${provider.serverNoun} ${name} (id ${id}) is taken over: an earlier apply`,
    "# created it but stopped before the state recorded it. Importing it changes nothing there.",
    "import {",
    `  to = ${addressOf(created)}`,
    `  id = "${id}"`,
    "}",
    "",
  ];
}

/** The root module's `main.tf` (under `plan.infra.dir`), where the `import` blocks go. */
export function rootMainFile(plan: Pick<DeployPlan, "infra">): string {
  return `${plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "")}/main.tf`;
}

/**
 * `files` with an `import` block per taken-over server added to the end of the root module's
 * `main.tf` ({@link rootMainFile}), so the plan records each server in the state instead of
 * creating another: plain HCL that OpenTofu and Terraform 1.6 and later both read, aimed at the
 * address {@link serverResourceAddress} names. Without takeovers, `files` as they are. Throws for a
 * server the plan does not create and for a root without `main.tf`.
 */
export function withServerImports(
  files: readonly RenderedFile[],
  plan: DeployPlan,
  takeovers: readonly ServerTakeover[],
): RenderedFile[] {
  if (takeovers.length === 0) return [...files];
  const blocks = takeovers.flatMap((takeover) => importBlock(plan, takeover));
  const main = rootMainFile(plan);
  if (!files.some((file) => file.path === main)) {
    throw new Error(`The rendered files have no ${main} to import the servers in.`);
  }
  return files.map((file) =>
    file.path === main ? { ...file, content: `${file.content}\n${blocks.join("\n")}` } : file,
  );
}
