/**
 * The hostname's DNS record when the domain is on Cloudflare (027 plan 2): an A record to the
 * hosting account's address, DNS only, through the `cloudflare-dns` module's hosting mode and the
 * infrastructure plan's approval (`iac-apply`), as every other target's records.
 */
import { join } from "node:path";
import { type RenderedFile, renderHostingDns } from "@opscrew/iac-templates";
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { CloudflareSetup } from "../provision/credentials";
import {
  findSavedPlan,
  type PlanAndApplyResult,
  planAndApply,
  ROTATION_PLAN_SUFFIX,
} from "../provision/plan-apply";
import { deploymentRenderContext } from "../provision/render";
import { provisionEngine } from "../provision/steps";
import type { ProvisionOptions } from "../provision/types";
import { approveAndWriteRenderedFiles } from "../shared";

/**
 * Writes the DNS root under `plan.infra.dir` (after the `repo-write` approval), then plans it and
 * applies it after the `iac-apply` approval bound to its hash (`--plan-only` saves the plan;
 * `--approve` with the hash of a saved one applies that). Answers the outcome and the files, which
 * the provision pull request commits.
 */
export async function applyHostingDns(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: {
    plan: DeployPlan;
    requirements: Requirements | undefined;
    github: { owner: string; repo: string };
    cloudflare: CloudflareSetup;
    address: string;
    command: string;
  },
): Promise<PlanAndApplyResult & { files: RenderedFile[] }> {
  const { plan, cloudflare, address, command } = input;
  const ctx = await deploymentRenderContext(deps, {
    plan,
    requirements: input.requirements,
    github: input.github,
    deployPublicKey: "",
    cloudflare,
  });
  const files = renderHostingDns(plan, ctx, address);
  await approveAndWriteRenderedFiles(deps, deps.paths.root, files, {
    what: "the hostname's DNS root",
    refused: "Nothing was written, and the hostname has no DNS record yet.",
  });
  const { engine, env } = await provisionEngine(deps, plan, options);
  const saved = await savedDnsPlan(deps, options.approveHashes ?? []);
  const result = await planAndApply(deps, {
    engine,
    env,
    dir: join(deps.paths.root, plan.infra.dir),
    deployPlan: plan,
    files,
    command,
    phase: "provision",
    costDelta: null,
    ...(options.planOnly === true ? { planOnly: true } : {}),
    ...(saved !== undefined ? { approvePlanHash: saved } : {}),
  });
  return { ...result, files };
}

/**
 * The saved infrastructure plan, not applied yet, that a hash given with `--approve` names (an
 * earlier `--plan-only` run's): applied instead of planning again. A hosting plan's hash names none.
 */
async function savedDnsPlan(
  deps: Pick<PhaseDeps, "paths">,
  hashes: readonly string[],
): Promise<string | undefined> {
  for (const hash of hashes) {
    const saved = await findSavedPlan(deps.paths.files.plansDir, hash);
    if (saved === undefined || saved.appliedAt !== undefined) continue;
    // A credential rotation's saved plan is only ever applied by that rotation.
    if (!saved.planFile.endsWith(ROTATION_PLAN_SUFFIX)) return hash;
  }
  return undefined;
}
