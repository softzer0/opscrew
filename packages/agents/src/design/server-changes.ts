import { join } from "node:path";
import type { VpsProviderId } from "@opscrew/contracts";
import { extraServerVariables } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type DeployProvider,
  type ExtraServer,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { providerProfile } from "../providers";
import { readValidJson } from "../shared/files";

/** Where a server runs and of what type. */
export interface ServerSize {
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
 * True when `previous` records a deployment that was applied and not destroyed: its servers exist.
 */
export function applied(previous: DeployPlan | undefined): previous is DeployPlan {
  return deployed(previous) && previous.deployment?.lastApplyAt !== undefined;
}

/** The app's server in `plan`, when OpsCrew creates it on `provider`. */
function cloudServerOf(plan: DeployPlan, provider: DeployProvider): ServerSize | undefined {
  const { target } = plan;
  if (target.provider !== provider) return undefined;
  if (target.provider !== "hetzner" && target.provider !== "digitalocean") return undefined;
  return { location: target.location, serverType: target.serverType };
}

/**
 * Where the app's server runs and its type, when an applied deployment ({@link applied}) has it on
 * `provider`, created by OpsCrew (another provider is only possible once it is destroyed).
 */
export function deployedAppServer(
  previous: DeployPlan | undefined,
  provider: DeployProvider,
): ServerSize | undefined {
  return applied(previous) ? cloudServerOf(previous, provider) : undefined;
}

/**
 * The change the next provision makes to the app's deployed (or planned) server: only one OpsCrew
 * creates, on the same provider.
 */
export function appServerChange(
  previous: DeployPlan | undefined,
  plan: Pick<DeployPlan, "target">,
): ServerChange | undefined {
  const after = plan.target;
  if (after.provider !== "hetzner" && after.provider !== "digitalocean") return undefined;
  if (!deployed(previous)) return undefined;
  const before = cloudServerOf(previous, after.provider);
  return before === undefined ? undefined : changeOf(before, after);
}

const TfvarsSchema = z.record(z.string(), z.unknown());

/**
 * The extra servers `names` OpsCrew created for the deployed app, by name: each one's location and
 * type as provision last rendered them, in the infrastructure root's `terraform.tfvars.json`. A
 * server the file does not hold is new.
 */
export async function deployedExtraServers(
  root: string,
  previous: DeployPlan | undefined,
  plan: Pick<DeployPlan, "infra">,
  names: readonly string[],
): Promise<Map<string, ServerSize>> {
  const servers = new Map<string, ServerSize>();
  if (!deployed(previous)) return servers;
  const tfvars = await readValidJson(
    join(root, plan.infra.dir, "terraform.tfvars.json"),
    TfvarsSchema,
  );
  if (tfvars === undefined) return servers;
  for (const name of names) {
    const variables = extraServerVariables(name);
    const location = tfvars[variables.location];
    const serverType = tfvars[variables.serverType];
    if (typeof location === "string" && typeof serverType === "string") {
      servers.set(name, { location, serverType });
    }
  }
  return servers;
}

/**
 * The changes the next provision makes to the deployed extra servers (`current`, from
 * {@link deployedExtraServers}) the plan's `servers` keep, by server name. Another provider shows
 * as another location, so it is a replace.
 */
export function extraServerChanges(
  current: ReadonlyMap<string, ServerSize>,
  servers: readonly ExtraServer[],
): Map<string, ServerChange> {
  const changes = new Map<string, ServerChange>();
  for (const { name, target } of servers) {
    const before = current.get(name);
    if (target.provider === "own" || before === undefined) continue;
    const change = changeOf(before, target);
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

/**
 * Why design keeps a deployed server's type instead of a smaller one it could use, whose disk is
 * smaller: neither provider can make a server's disk smaller. `Server app could use cx23 now, but
 * OpsCrew keeps cx33: Hetzner Cloud can't make a server's disk smaller.`
 */
export function keptTypeText(
  name: string,
  provider: VpsProviderId,
  smaller: string,
  kept: string,
): string {
  const profile = providerProfile(provider);
  return `Server ${name} could use ${smaller} now, but OpsCrew keeps ${kept}: ${profile.displayName} can't make a ${profile.serverNoun}'s disk smaller.`;
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
