import { join } from "node:path";
import { extraServerVariables } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import { readValidJson } from "../shared/files";

/** Where a server runs and of what type. */
interface ServerSize {
  location: string;
  serverType: string;
}

/**
 * What the next provision does to a deployed server OpsCrew created: `replace` it (another
 * location or provider: a new server, the old one deleted with its data) or `resize` it (another
 * type, same location).
 */
export interface ServerChange {
  kind: "replace" | "resize";
  before: ServerSize;
  after: ServerSize;
}

/** True when `previous` records a deployment that was applied (or planned) and not destroyed. */
function deployed(previous: DeployPlan | undefined): previous is DeployPlan {
  const deployment = previous?.deployment;
  if (deployment === undefined || deployment.destroyedAt !== undefined) return false;
  return deployment.lastApplyAt !== undefined || deployment.lastPlanHash !== undefined;
}

/** `before` to `after`: a replace for another location, a resize for another type, else none. */
function changeOf(before: ServerSize, after: ServerSize): ServerChange | undefined {
  const sizes = {
    before: { location: before.location, serverType: before.serverType },
    after: { location: after.location, serverType: after.serverType },
  };
  if (before.location !== after.location) return { kind: "replace", ...sizes };
  if (before.serverType !== after.serverType) return { kind: "resize", ...sizes };
  return undefined;
}

/**
 * The change the next provision makes to the app's deployed server: only one OpsCrew creates, on
 * the same provider (another provider is only possible once the deployment is destroyed).
 */
export function appServerChange(
  previous: DeployPlan | undefined,
  plan: Pick<DeployPlan, "target">,
): ServerChange | undefined {
  if (!deployed(previous)) return undefined;
  const before = previous.target;
  const after = plan.target;
  if (before.provider !== after.provider) return undefined;
  if (before.provider !== "hetzner" && before.provider !== "digitalocean") return undefined;
  if (after.provider !== "hetzner" && after.provider !== "digitalocean") return undefined;
  return changeOf(before, after);
}

const TfvarsSchema = z.record(z.string(), z.unknown());

/**
 * The changes the next provision makes to the extra servers OpsCrew created for the deployed app,
 * by server name: each one's location and type as provision last rendered them, in the
 * infrastructure root's `terraform.tfvars.json`, against the plan's. A server the file does not
 * hold is new. Another provider shows as another location, so it is a replace.
 */
export async function extraServerChanges(
  root: string,
  previous: DeployPlan | undefined,
  plan: Pick<DeployPlan, "servers" | "infra">,
): Promise<Map<string, ServerChange>> {
  const changes = new Map<string, ServerChange>();
  if (!deployed(previous)) return changes;
  const tfvars = await readValidJson(
    join(root, plan.infra.dir, "terraform.tfvars.json"),
    TfvarsSchema,
  );
  if (tfvars === undefined) return changes;
  for (const { name, target } of plan.servers ?? []) {
    if (target.provider === "own") continue;
    const names = extraServerVariables(name);
    const location = tfvars[names.location];
    const serverType = tfvars[names.serverType];
    if (typeof location !== "string" || typeof serverType !== "string") continue;
    const change = changeOf({ location, serverType }, target);
    if (change !== undefined) changes.set(name, change);
  }
  return changes;
}

/** The warning for an extra server's change: a replace loses its data, a resize stops it a while. */
export function extraServerChangeWarning(name: string, change: ServerChange): string {
  const { before, after } = change;
  if (change.kind === "resize") {
    return `The plan changes server ${name}'s type from ${before.serverType} to ${after.serverType}, so the next \`opscrew provision\` will resize it. Its services are offline while it restarts.`;
  }
  return `Server ${name} already runs in ${before.location} (${before.serverType}). The plan puts it in ${after.location} (${after.serverType}), so the next \`opscrew provision\` will replace it: it creates a new one and deletes the old one together with the data on it. Back up its data first, or set its location back to ${before.location} (servers[].target.location) to keep the server.`;
}

/** The servers the next provision replaces: the app's (`app`) and the extra ones by name. */
export function replacedServers(
  app: ServerChange | undefined,
  extra: ReadonlyMap<string, ServerChange>,
): Set<string> {
  const replaced = new Set<string>();
  if (app?.kind === "replace") replaced.add(APP_SERVER);
  for (const [name, change] of extra) if (change.kind === "replace") replaced.add(name);
  return replaced;
}
