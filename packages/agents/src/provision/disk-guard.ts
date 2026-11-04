import type { ComputeCatalog } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { appServerVariables } from "@opscrew/iac-templates";
import { APP_SERVER, type CloudProvider, type DeployPlan } from "@opscrew/plan-schema";
import {
  applied,
  appServerChange,
  deployedExtraServers,
  extraServerChanges,
  type ServerChange,
} from "../design/server-changes";
import { providerProfile } from "../providers";
import { planFile } from "../runners";
import { committedTfvars } from "./render";

/** What {@link requireNoSmallerDisk} needs. */
export interface DiskGuardInput {
  root: string;
  plan: DeployPlan;
  /** The provider's catalogue, live or static (design's `resolveCatalog`), for `location`. */
  catalogFor: (provider: CloudProvider, location: string) => Promise<ComputeCatalog>;
  /** The command the hint names, for example `opscrew provision`. */
  command: string;
}

/** A deployed server the plan gives another type in the same location. */
interface Resize {
  name: string;
  provider: CloudProvider;
  change: ServerChange;
}

/**
 * The deployed servers (the app's and the extra ones) the plan resizes. The app's deployed server
 * is as provision last rendered it: its location and type in the committed
 * `terraform.tfvars.json` stand in for the plan before the edit.
 */
async function resizes(root: string, plan: DeployPlan): Promise<Resize[]> {
  const found: Resize[] = [];
  const { target } = plan;
  if (target.provider === "hetzner" || target.provider === "digitalocean") {
    const tfvars = await committedTfvars(root, plan);
    const names = appServerVariables();
    const location = tfvars?.[names.location];
    const serverType = tfvars?.[names.serverType];
    if (typeof location === "string" && typeof serverType === "string") {
      const last = { ...plan, target: { ...target, location, serverType } };
      const app = appServerChange(last, plan);
      if (app?.kind === "resize") {
        found.push({ name: APP_SERVER, provider: target.provider, change: app });
      }
    }
  }
  const servers = plan.servers ?? [];
  const current = await deployedExtraServers(
    root,
    plan,
    plan,
    servers.map((s) => s.name),
  );
  const changes = extraServerChanges(current, servers);
  for (const { name, target } of servers) {
    const change = changes.get(name);
    // Only cloud servers have changes; the check narrows the provider's type.
    if (change?.kind === "resize" && target.provider !== "own") {
      found.push({ name, provider: target.provider, change });
    }
  }
  return found;
}

/**
 * Refuses, before any change, a plan that moves a deployed Hetzner Cloud server or DigitalOcean
 * Droplet (the app's or an extra one) to a type with a smaller disk: neither provider can make a
 * disk smaller, and Hetzner Cloud refuses only after it has switched the server off, leaving it
 * off. Disks come from the provider's catalogue (a type's disk, wherever it is sold); a type it
 * doesn't list is a warning, returned. A new server, a replaced one (another location) and a
 * larger or equal disk pass. Known gaps: a first apply that failed after creating a server leaves
 * no `lastApplyAt`, so its servers aren't checked, and neither is a type a `--plan-only` run from
 * before this check already wrote into `terraform.tfvars.json`.
 *
 * @throws OpsCrewError `INVALID_INPUT` naming each server, its two types and their disks.
 */
export async function requireNoSmallerDisk(input: DiskGuardInput): Promise<string[]> {
  const { root, plan, catalogFor, command } = input;
  if (!applied(plan)) return [];
  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const { name, provider, change } of await resizes(root, plan)) {
    const { before, after } = change;
    const profile = providerProfile(provider);
    const noun = profile.serverNoun;
    // Measured at Hetzner (research R5, S1): it switches the server off before it refuses.
    const switchedOff =
      provider === "hetzner" ? `, and the attempt would leave the ${noun} switched off` : "";
    const shrinks = `${profile.displayName} can't make a ${noun}'s disk smaller${switchedOff}`;
    // A type's disk is the type's own: look it up wherever the type is still sold.
    const offers = await (await catalogFor(provider, before.location)).listOffers();
    const diskOf = (type: string) => offers.find((o) => o.id === type)?.diskGb;
    const from = diskOf(before.serverType);
    const to = diskOf(after.serverType);
    if (from === undefined || to === undefined) {
      const missing = [before.serverType, after.serverType].filter(
        (type) => diskOf(type) === undefined,
      );
      warnings.push(
        `${profile.displayName}'s catalogue doesn't list ${missing.join(" or ")}, so OpsCrew couldn't check that ${noun} ${name}'s new type has at least the disk of ${before.serverType}. ${shrinks}: check the type before you approve.`,
      );
      continue;
    }
    if (to < from) {
      refusals.push(
        `Server ${name} can't move from ${before.serverType} (${from} GB disk) to ${after.serverType} (${to} GB): ${shrinks}. Set its serverType back to ${before.serverType}, or pick a type with at least ${from} GB of disk.`,
      );
    }
  }
  if (refusals.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", `${refusals.join(" ")} Nothing was changed.`, {
      hint: `Edit ${planFile(plan)}, then run \`${command}\` again.`,
    });
  }
  return warnings;
}
