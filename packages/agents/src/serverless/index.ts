/**
 * Provision for the server-less targets (feature 016): Cloudflare's hosting (T1608) and GitHub
 * Pages (T1609). `opscrew provision` dispatches here after its repository checks, before anything
 * that needs a server or an image (a Dockerfile, a deploy key, SSH).
 */
import type { GitClient } from "@opscrew/connector-github";
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { SavedInfrastructureHashes } from "../provision/steps";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";
import { provisionPages } from "./pages/provision";

/** What `opscrew provision` hands a server-less target's flow once its checks passed. */
export interface ServerlessProvisionInput {
  plan: DeployPlan;
  requirements: Requirements | undefined;
  git: GitClient;
  /** The saved infrastructure plans the `--approve` hashes name (applied instead of planning). */
  saved: SavedInfrastructureHashes;
}

export { provisionCloudflareWorkers } from "./cloudflare/provision";

/**
 * Provisions a site on GitHub Pages: the Pages site and its custom domain (a Pages plan approved
 * by its hash, `pages-apply`), then its DNS records and GitHub's verification record (`iac-apply`,
 * one plan per root), and the deploy-setup pull request (see `provisionPages`).
 */
export function provisionGithubPages(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: ServerlessProvisionInput,
): Promise<ProvisionResult> {
  return provisionPages(deps, options, input);
}
