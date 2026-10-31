/**
 * The app's servers by name (feature 018): `app` and the extra servers in plan order, and the
 * login's shell on one of them.
 */
import type { RemoteExec } from "@opscrew/contracts";
import { APP_SERVER, type CloudProvider, type DeployPlan } from "@opscrew/plan-schema";
import type { ProvisionServices } from "../provision/types";
import type { EngineDeps } from "./engine";
import { type ServerLogin, serverLogin, serverRemote } from "./server-address";

/** The extra servers' names, in plan order; none for an app on one server. */
export function extraServers(plan: Pick<DeployPlan, "servers">): string[] {
  return (plan.servers ?? []).map((server) => server.name);
}

/** Every server of the app by name: `app` first, then the extra servers in plan order. */
export function appServers(plan: Pick<DeployPlan, "servers">): string[] {
  return [APP_SERVER, ...extraServers(plan)];
}

/** True when the app has extra servers: then every line about a server names it. */
export function hasExtraServers(plan: Pick<DeployPlan, "servers">): boolean {
  return (plan.servers ?? []).length > 0;
}

/** An extra server OpsCrew created: its module in the root and the name its provider shows. */
export interface ExtraCloudServer {
  /** Its name in the plan. */
  name: string;
  provider: CloudProvider;
  /** Its name at the provider, which the user types: `<app>-<name>`. */
  resource: string;
  /** Its module's address prefix: `module.server_<name>.`. */
  module: string;
  /** The provider's automatic backups are on. */
  backups: boolean;
}

/** The name of the extra cloud server `server` at its provider: `<app>-<server>`. */
export function cloudServerName(plan: Pick<DeployPlan, "app">, server: string): string {
  return `${plan.app.name}-${server}`;
}

/** The plan's extra servers OpsCrew created, in plan order. */
export function extraCloudServers(plan: Pick<DeployPlan, "app" | "servers">): ExtraCloudServer[] {
  return (plan.servers ?? []).flatMap(({ name, target }) =>
    target.provider === "own"
      ? []
      : [
          {
            name,
            provider: target.provider,
            resource: cloudServerName(plan, name),
            module: `module.server_${name}.`,
            backups: target.backups,
          },
        ],
  );
}

/** The providers of the plan's extra servers OpsCrew created, each once, other than `except`. */
export function extraCloudProviders(
  plan: Pick<DeployPlan, "app" | "servers">,
  except?: string,
): CloudProvider[] {
  const providers = new Set(extraCloudServers(plan).map((server) => server.provider));
  return [...providers].filter((provider) => provider !== except);
}

/** The login's shell on the server `name`: `serverRemote`, or `services.remote` (tests). */
export async function loginShell(
  deps: EngineDeps,
  plan: DeployPlan,
  name: string,
  services: Pick<ProvisionServices, "remote">,
  options: Parameters<typeof serverRemote>[3] = {},
): Promise<{ remote: RemoteExec; login: ServerLogin }> {
  const login = await serverLogin(deps, plan, name);
  const remote = services.remote?.(login.host) ?? (await serverRemote(deps, plan, name, options));
  return { remote, login };
}
