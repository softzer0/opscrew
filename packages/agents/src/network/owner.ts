import type { HostFacts } from "@opscrew/connector-ssh-host";
import { OpsCrewError, type ProjectPaths, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, monitoringOf, networkInterface } from "@opscrew/plan-schema";

/**
 * Where an environment's plan is kept: `opscrew/[apps/<key>/][environments/<name>/]plan.yaml`,
 * each key and name lower-case letters, digits and hyphens (never `..`).
 */
const PLAN_FILE =
  /^opscrew\/(?:apps\/([a-z][a-z0-9-]*)\/)?(?:environments\/([a-z][a-z0-9-]*)\/)?plan\.yaml$/;

/** The environment that owns the monitoring server a plan sends to. */
export interface MonitoringOwner {
  /** The owner's plan file (`where.owner.plan`), such as `opscrew/plan.yaml`. */
  plan: string;
  /** The monitoring server's name in the owner's plan (`where.owner.server`). */
  server: string;
  /** The owner's paths: its plan file, and this computer's record of its servers and logins. */
  paths: ProjectPaths;
}

/**
 * The environment that owns the monitoring server `plan` sends to (`where.kind` "shared"), from
 * its plan file (`where.owner.plan`), beside `paths`: the same repository and OpsCrew home.
 * `undefined` for every other plan.
 * @throws OpsCrewError `INVALID_INPUT` when `where.owner.plan` is not an environment's plan file as
 * OpsCrew writes it (prod's is `opscrew/plan.yaml`, never `opscrew/environments/prod/plan.yaml`).
 */
export function monitoringOwner(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  plan: Pick<DeployPlan, "observability">,
): MonitoringOwner | undefined {
  const where = monitoringOf(plan)?.where;
  if (where?.kind !== "shared") return undefined;
  const match = PLAN_FILE.exec(where.owner.plan);
  if (match === null || match[2] === "prod") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `observability.monitoring.where.owner.plan is ${where.owner.plan}, which is not the plan file of one of the repository's environments, such as opscrew/plan.yaml.`,
      {
        hint: "Set it to the plan file of the environment whose server runs the monitoring stack, then run the command again.",
      },
    );
  }
  const [, app, environment] = match;
  return {
    ...where.owner,
    paths: resolveProjectPaths(paths.root, {
      env: { OPSCREW_HOME: paths.homeDir },
      ...(app === undefined ? {} : { app }),
      ...(environment === undefined ? {} : { environment }),
    }),
  };
}

/** `server <name> of <plan file>`: another environment's server, as OpsCrew names it. */
export function otherServer(owner: { plan: string; server: string }): string {
  return `server ${owner.server} of ${owner.plan}`;
}

/**
 * The monitoring server another environment owns that `plan` sends to, with this network's
 * interface there; `undefined` for every other plan, and before its network has that server.
 */
export function currentOwner(
  plan: Pick<DeployPlan, "observability" | "network">,
): { plan: string; server: string; interface: string } | undefined {
  const where = monitoringOf(plan)?.where;
  if (where?.kind !== "shared") return undefined;
  const member = plan.network?.members.find((m) => m.name === where.owner.server);
  return member === undefined ? undefined : { ...where.owner, interface: networkInterface(member) };
}

/** True when the sender `sender`'s interface is on the stack's server (its `facts`). */
export function joinedOn(
  sender: Pick<DeployPlan, "observability" | "network">,
  facts: Pick<HostFacts, "wireguardInterfaces">,
): boolean {
  const owner = currentOwner(sender);
  return owner !== undefined && facts.wireguardInterfaces.includes(owner.interface);
}
