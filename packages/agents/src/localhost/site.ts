import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { type LocalhostSite, localhostHostname } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  environmentsOf,
  type LocalhostDeployTarget,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { environmentPaths } from "../environments/paths";
import { readValidJson } from "../shared";

/**
 * The app's hostname on this computer (FR-1505): `<app>.localhost`, or `<env>.<app>.localhost`
 * (`prod.<app>.localhost` for prod) when another of the app's environments runs on this computer
 * too, so the two never share an address.
 */
export async function localSite(paths: ProjectPaths, plan: DeployPlan): Promise<LocalhostSite> {
  let beside = false;
  for (const name of await environmentsOf(paths.root)) {
    if (name === paths.environment) continue;
    const other = await readOptionalArtifact("plan", environmentPaths(paths, name).files.plan);
    if (other?.target.provider === "localhost") beside = true;
  }
  return { hostname: localhostHostname(plan, beside) };
}

/** `<environment's state>/localhost.json`: the hostname the last deploy on this computer served. */
function servedFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "localhost.json");
}

const ServedSchema = z.strictObject({ hostname: z.string().min(1) });

/** Records the hostname a deploy on this computer now serves the app at. */
export async function recordServedSite(
  paths: Pick<ProjectPaths, "stateDir">,
  site: LocalhostSite,
): Promise<void> {
  await writeFileAtomic(servedFile(paths), `${JSON.stringify({ hostname: site.hostname })}\n`);
}

/** Forgets the served hostname, once the app no longer runs on this computer. */
export async function forgetServedSite(paths: Pick<ProjectPaths, "stateDir">): Promise<void> {
  await rm(servedFile(paths), { force: true });
}

/**
 * The hostname the app is served at on this computer: the last deploy's, else the one the plan
 * gives now ({@link localSite}, which a later localhost environment of the app can change until
 * provision serves it).
 */
export async function servedSite(paths: ProjectPaths, plan: DeployPlan): Promise<LocalhostSite> {
  const served = await readValidJson(servedFile(paths), ServedSchema);
  return served ?? localSite(paths, plan);
}

/** The app's address on this computer: `https://<hostname>`, with the port when it is not 443. */
export function localAddress(site: LocalhostSite, target: LocalhostDeployTarget): string {
  const port = target.ports.https === 443 ? "" : `:${target.ports.https}`;
  return `https://${site.hostname}${port}`;
}

/** The plan's localhost target; any other target here is a bug in OpsCrew. */
export function localTarget(plan: DeployPlan): LocalhostDeployTarget {
  if (plan.target.provider !== "localhost") {
    throw new Error("This step is for an app on this computer (the localhost target) only.");
  }
  return plan.target;
}
