import { readFile } from "node:fs/promises";
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

/**
 * The secret-free render context provision uses (shared with the read-only preview). It never
 * carries the server's address: the rendered files are committed.
 */
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
  const { requirements, cloudflare } = input;
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
  };
}

/** The deploy key's public half: created once when allowed, otherwise read (never invented). */
async function deployPublicKeyFor(deps: PhaseDeps, create: boolean): Promise<string> {
  if (create) {
    const key = await ensureDeployKey(deps.paths);
    deps.redactor.addLiteral(key.privateKeyOpenSsh, "deploy-key");
    return key.publicKeyOpenSsh;
  }
  const existing = (await readFile(deps.paths.files.deployKeyPub, "utf8").catch(() => ""))?.trim();
  if (!existing) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The project's deploy key is not on this computer, so OpsCrew cannot render the files it would compare. Nothing was checked.",
      {
        hint: `Copy the deploy key files from the computer that ran \`opscrew provision\` to ${deps.paths.files.deployKey} and ${deps.paths.files.deployKeyPub}, then try again.`,
      },
    );
  }
  return existing;
}

export interface DeploymentPreview {
  plan: DeployPlan;
  /** DNS records at the app's hostnames OpsCrew did not create (only with `foreignRecords: "report"`). */
  foreignDnsRecords?: { type: string; name: string; content: string }[];
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
  options: {
    services?: ProvisionServices;
    foreignRecords?: "stop" | "report";
    /** Create the project's deploy key when it is missing (default true; drift passes false). */
    createDeployKey?: boolean;
  } = {},
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
  const cloudflare = await setupCloudflare(deps, plan, options.services ?? {}, {
    foreignRecords: options.foreignRecords ?? "stop",
  });
  if (cloudflare) plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
  const deployPublicKey = await deployPublicKeyFor(deps, options.createDeployKey !== false);
  const files = renderDeployment(
    plan,
    deploymentRenderContext(deps, { plan, requirements, github, deployPublicKey, cloudflare }),
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  return {
    plan,
    ...(cloudflare?.foreignRecords ? { foreignDnsRecords: cloudflare.foreignRecords } : {}),
    files: files.map((f) => ({ path: f.path, kind: f.kind })),
    created: diff.created.map((f) => f.path),
    changed: diff.changed.map((f) => f.path),
    unchanged: diff.unchanged.map((f) => f.path),
  };
}
