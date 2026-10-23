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
import { serverlessNotSupported } from "../shared";

/** What `opscrew provision` hands a server-less target's flow once its checks passed. */
export interface ServerlessProvisionInput {
  plan: DeployPlan;
  requirements: Requirements | undefined;
  git: GitClient;
  /** The saved infrastructure plans the `--approve` hashes name (applied instead of planning). */
  saved: SavedInfrastructureHashes;
}

/**
 * Provisions an app on Cloudflare's hosting: the Worker's shell and custom domains, the `www`
 * redirect, the deploy secrets and the deploy-setup pull request.
 * @throws OpsCrewError `PHASE_PRECONDITION` until T1608: not available yet.
 */
export async function provisionCloudflareWorkers(
  _deps: PhaseDeps,
  _options: ProvisionOptions,
  _input: ServerlessProvisionInput,
): Promise<ProvisionResult> {
  throw serverlessNotSupported("`opscrew provision`", "cloudflare-workers");
}

/**
 * Provisions a site on GitHub Pages: the Pages site and its custom domain, its DNS records and
 * GitHub's verification record, and the deploy-setup pull request.
 * @throws OpsCrewError `PHASE_PRECONDITION` until T1609: not available yet.
 */
export async function provisionGithubPages(
  _deps: PhaseDeps,
  _options: ProvisionOptions,
  _input: ServerlessProvisionInput,
): Promise<ProvisionResult> {
  throw serverlessNotSupported("`opscrew provision`", "github-pages");
}
