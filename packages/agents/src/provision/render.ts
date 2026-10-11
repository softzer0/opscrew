import { GitClient } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import {
  type RenderContext,
  type RenderedFileKind,
  renderDeployment,
} from "@opscrew/iac-templates";
import { type DeployPlan, type Requirements, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { diffRenderedFiles, ensureDeployKey } from "../shared";
import { type CloudflareSetup, githubCoordinates, setupCloudflare } from "./credentials";
import type { ProvisionServices } from "./types";

export async function readRequirements(deps: PhaseDeps): Promise<Requirements | undefined> {
  try {
    return await readArtifact("requirements", deps.paths.files.requirements);
  } catch (error) {
    if ((error as { code?: string }).code === "ARTIFACT_MISSING") return undefined;
    throw error;
  }
}

/** The secret-free render context provision uses (shared with the read-only preview). */
export function deploymentRenderContext(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    requirements: Requirements | undefined;
    github: { owner: string; repo: string };
    deployPublicKey: string;
    cloudflare: CloudflareSetup | undefined;
  },
): RenderContext {
  const { plan, requirements, cloudflare } = input;
  return {
    opscrewVersion: deps.version,
    github: { owner: input.github.owner, repo: input.github.repo },
    deploySshPublicKey: input.deployPublicKey,
    projectId: deps.paths.projectId,
    ...(requirements?.contactEmail ? { acmeEmail: requirements.contactEmail } : {}),
    ...(cloudflare
      ? {
          cloudflare: {
            zoneId: cloudflare.zoneId,
            manageConfigRule: cloudflare.manageConfigRule,
            manageWafRules: cloudflare.manageWafRules,
            ...(cloudflare.ipRanges ? { ipRanges: cloudflare.ipRanges } : {}),
          },
        }
      : {}),
    ...(plan.deployment.serverIpv4 ? { serverIpv4: plan.deployment.serverIpv4 } : {}),
    ...(plan.deployment.serverIpv6 ? { serverIpv6: plan.deployment.serverIpv6 } : {}),
  };
}

export interface DeploymentPreview {
  plan: DeployPlan;
  files: { path: string; kind: RenderedFileKind }[];
  created: string[];
  changed: string[];
  unchanged: string[];
}

/**
 * The files `opscrew provision` would write, compared with the repository, without writing
 * anything to it or recording a phase. Needs the Cloudflare token when the plan uses Cloudflare
 * (the zone id is part of the rendered code). Creates the project's deploy key in the user's
 * OpsCrew home when it does not exist yet, so the preview matches the later provision exactly.
 */
export async function previewDeploymentFiles(
  deps: PhaseDeps,
  options: { services?: ProvisionServices } = {},
): Promise<DeploymentPreview> {
  let plan = await readArtifact("plan", deps.paths.files.plan);
  const requirements = await readRequirements(deps);
  const git = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  if (!(await git.isRepo())) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project is not a git repository.", {
      hint: "Run OpsCrew from a clone of your GitHub repository.",
    });
  }
  const github = await githubCoordinates(git);
  const cloudflare = await setupCloudflare(deps, plan, options.services ?? {});
  if (cloudflare) plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
  const deployKey = await ensureDeployKey(deps.paths);
  deps.redactor.addLiteral(deployKey.privateKeyOpenSsh, "deploy-key");
  const files = renderDeployment(
    plan,
    deploymentRenderContext(deps, {
      plan,
      requirements,
      github,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      cloudflare,
    }),
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  return {
    plan,
    files: files.map((f) => ({ path: f.path, kind: f.kind })),
    created: diff.created.map((f) => f.path),
    changed: diff.changed.map((f) => f.path),
    unchanged: diff.unchanged.map((f) => f.path),
  };
}
