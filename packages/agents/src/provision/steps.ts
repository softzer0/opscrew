import { posix } from "node:path";
import type { GitClient } from "@opscrew/connector-github";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel } from "@opscrew/iac-engine";
import { checkEnvironmentKey } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { workflowBranch } from "../environments/branches";
import { commandFlags } from "../environments/choice";
import {
  type PlanApproval,
  type ProjectEngine,
  projectEngine,
  writePlanIfChanged,
} from "../shared";
import {
  type DeployPause,
  pinnedText,
  readableDeployPause,
  rotationWindowText,
} from "../shared/deploy-pause";
import type { CloudflareSetup, GitHubSetup } from "./credentials";
import type { DependabotStep } from "./dependabot";
import type { PlanAndApplyResult } from "./plan-apply";
import {
  chooseDeployBranch,
  type DeployBranch,
  localDeployBranch,
  type PublishResult,
  previewsNext,
  publishDeploySetup,
  type RecoveryCopy,
} from "./publish";
import { withCloudflareZone } from "./render";
import { deploySecretsStoredFor } from "./secrets";
import type { ProvisionOptions } from "./types";

/** The phases that run the provision flow. */
export type ProvisionPhase = Extract<PhaseName, "provision" | "dns">;

/** The saved infrastructure plans the `--approve` hashes name. */
export interface SavedInfrastructureHashes {
  /** The main plan to apply instead of planning again (never a removal plan). */
  apply?: string;
  /** The saved removal plan of an earlier setup (an own server's switch, Portainer's Cloudflare). */
  removal?: string;
  /** The saved plan of the `storage` root (the app's bucket). */
  storage?: string;
  /** The saved plan of the `backups` root (the off-server copies' bucket). */
  backups?: string;
}

/**
 * The branch the deployment files go on, picked (and checked to start from the latest
 * `plan.cicd.branch`) before anything changes; `undefined` when the run commits nothing.
 */
export async function deployBranchFor(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    phase: ProvisionPhase;
    commits: boolean;
    push: boolean;
  },
): Promise<DeployBranch | undefined> {
  const { git, plan, phase } = input;
  if (!input.commits) return undefined;
  return input.push
    ? chooseDeployBranch(deps, git, input.github, plan, phase)
    : {
        branch: await localDeployBranch(
          git,
          workflowBranch(plan, input.github.defaultBranch),
          plan.app.key,
          phase,
        ),
      };
}

/**
 * The plan with the zone Cloudflare named for the domain. Names the schema can only check against
 * the zone (a `www.` alias or a Portainer subdomain beyond Cloudflare's free certificate) stop
 * the run here, before anything is rendered, planned or changed.
 */
export function withLearnedZone(
  deps: Pick<PhaseDeps, "redactor">,
  plan: DeployPlan,
  cloudflare: CloudflareSetup | undefined,
  command: string,
): { plan: DeployPlan; zoneLearned: boolean } {
  if (cloudflare === undefined || plan.dns.zone === cloudflare.zoneName) {
    return { plan, zoneLearned: false };
  }
  const learned = withCloudflareZone(plan, cloudflare);
  const parsed = DeployPlanSchema.safeParse(learned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "plan";
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      deps.redactor.redact(
        `opscrew/plan.yaml cannot be provisioned in the Cloudflare zone ${cloudflare.zoneName}: ${field} ${issue?.message ?? "is not valid"}. Nothing was changed.`,
      ),
      { hint: `Fix the field shown above in opscrew/plan.yaml, then run \`${command}\` again.` },
    );
  }
  return { plan: learned, zoneLearned: true };
}

/** The project's engine and environment ({@link projectEngine}), saying which engine is used. */
export async function provisionEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: Pick<ProvisionOptions, "engine" | "services">,
): Promise<ProjectEngine> {
  const setup = await projectEngine(deps, plan, {
    preference: options.engine,
    services: options.services,
  });
  deps.reporter.info(`Using ${engineLabel(setup.engine.info.name)} ${setup.engine.info.version}.`);
  if (plan.infra.stateEncryption && setup.engine.info.name !== "tofu") {
    deps.reporter.warn(
      "Terraform cannot encrypt its state; .opscrew/tfstate stays unencrypted on this computer. Keep it private (it is git-ignored).",
    );
  }
  return setup;
}

/**
 * The root module's current outputs: the apply's (or, when it changed nothing, the state's as
 * `planAndApply` read them), else, after `--plan-only`, read from the state (`{}` when that fails).
 */
export async function currentOutputs(
  iac: Pick<PlanAndApplyResult, "outputs">,
  engine: IacEngine,
  dir: string,
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (Object.keys(iac.outputs).length > 0) return iac.outputs;
  return engine.output(dir, { env }).catch(() => ({}));
}

/** Sensitive root-module outputs (the tunnel and Access tokens): never returned or printed. */
const SENSITIVE_OUTPUTS = new Set([
  "tunnel_token",
  "portainer_tunnel_token",
  "deploy_service_token_client_id",
  "deploy_service_token_client_secret",
]);

/** The outputs without the sensitive ones, for the result (callers print or forward it). */
export function publicOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).filter(([name]) => !SENSITIVE_OUTPUTS.has(name)),
  );
}

/**
 * `opscrew/plan.yaml` after this run, for `record(otherApplied)`: the approvals (`approvals` is
 * read when called, so later ones count), the domain URL, the infrastructure apply (`iac`) and,
 * with `otherApplied`, a change on the server or in Portainer. A new deployment after
 * `opscrew destroy` is no longer destroyed. `updatedAt` is left to `writePlanIfChanged`.
 */
export function deploymentRecord(
  deps: Pick<PhaseDeps, "clock">,
  input: {
    plan: DeployPlan;
    url: string | undefined;
    iac: Pick<PlanAndApplyResult, "planHash" | "applied">;
    approvals: readonly PlanApproval[];
  },
): (otherApplied: boolean) => DeployPlan {
  const now = deps.clock.now().toISOString();
  const { plan, url, iac, approvals } = input;
  const { destroyedAt: _destroyedAt, url: _url, ...previous } = plan.deployment;
  return (otherApplied) => ({
    ...plan,
    approvals: [...plan.approvals, ...approvals],
    deployment: {
      ...previous,
      ...(url ? { url } : {}),
      ...(iac.planHash && iac.applied ? { lastPlanHash: iac.planHash } : {}),
      ...(iac.applied || otherApplied ? { lastApplyAt: now } : {}),
    },
  });
}

/**
 * Whether GitHub Actions has the deploy secrets after this run: stored now (`store`, its approval
 * asked by `save`), or else stored for `where` by an earlier run from this computer, where the
 * `plan`'s environment keeps them; a warning says when they are not, because a deploy would then
 * fail. `noun` names what they are for.
 */
export async function deploySecretsStep(
  deps: PhaseDeps,
  input: {
    store: boolean;
    save: () => Promise<void>;
    plan: DeployPlan;
    where: { host: string; owner: string; repo: string };
    noun: "server" | "app";
  },
): Promise<boolean> {
  if (input.store) {
    await input.save();
    return true;
  }
  const stored = await deploySecretsStoredFor(deps, input.plan, input.where);
  if (!stored) {
    deps.reporter.warn(
      `The deploy secrets are not stored in GitHub Actions for this ${input.noun} yet, so a deploy would fail. Before merging the pull request, run \`opscrew provision\` in a terminal in the project directory to store them.`,
    );
  }
  return stored;
}

/**
 * Writes `opscrew/plan.yaml` (when it changed), then commits `files` and the plan on
 * the deploy branch (with the recovery copy when this computer's files changed), pushes it and
 * opens the pull request (each after its own approval).
 */
export async function publishDeployment(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    files: readonly string[];
    push: boolean;
    secretsStored: boolean;
    phase: ProvisionPhase;
    branch: DeployBranch | undefined;
    /** Dependabot's configuration (`deploySetupDependabot`), for the pull request's body. */
    dependabot: DependabotStep | undefined;
    /** What the recovery copy's first key needs (`ProvisionOptions.recovery`). */
    recovery?: ProvisionOptions["recovery"];
    /** The recovery copy this run already brought up to date (`recoveryCopyFiles`). */
    recoveryCopy?: RecoveryCopy;
  },
): Promise<{ plan: DeployPlan; published: PublishResult }> {
  await writePlanIfChanged(deps, input.plan);
  const published = await publishDeploySetup(deps, {
    git: input.git,
    github: input.github,
    plan: input.plan,
    paths: [...input.files, toPosixRelative(deps.paths.root, deps.paths.files.plan)],
    push: input.push,
    secretsStored: input.secretsStored,
    phase: input.phase,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.dependabot !== undefined ? { dependabot: input.dependabot } : {}),
    ...(input.recovery !== undefined ? { recovery: input.recovery } : {}),
    ...(input.recoveryCopy !== undefined ? { recoveryCopy: input.recoveryCopy } : {}),
  });
  return { plan: input.plan, published };
}

/**
 * What deploys the app once the secrets are stored: merging the deploy pull request (or the
 * branch this run published). When nothing was published and no pull request is open (the files
 * are already on `published.base`) and the secrets were stored again in this run (`storedNow`),
 * how a changed value reaches the running app; else `undefined`.
 */
export function mergeDeploysNote(
  plan: Pick<DeployPlan, "cicd">,
  published: PublishResult,
  storedNow: boolean,
): string | undefined {
  const { base } = published;
  if (published.prUrl) return `Merging ${published.prUrl} deploys the app.`;
  if (published.published) {
    return published.branch !== base
      ? `Merging ${published.branch} into ${base} deploys the app.`
      : undefined;
  }
  return storedNow
    ? `OpsCrew stored the deploy secrets in GitHub Actions again. If you changed a value, the running app gets it on its next deploy: run ${posix.basename(plan.cicd.workflowPath)} on ${base} in GitHub Actions, or push a commit.`
    : undefined;
}

/**
 * {@link mergeDeploysNote} for a preview environment, which never deploys by itself: what the next
 * pull request gets once the preview workflow is merged (or already is, when nothing was
 * published and no pull request is open).
 */
export function previewsMergeNote(plan: DeployPlan, published: PublishResult): string {
  const { base, branch, prUrl } = published;
  if (prUrl) return `Once ${prUrl} is merged, ${previewsNext(plan)}.`;
  if (published.published && branch !== base) {
    return `Once ${branch} is merged into ${base}, ${previewsNext(plan)}.`;
  }
  return `Previews are set up: ${previewsNext(plan)}.`;
}

/**
 * Said beside {@link mergeDeploysNote} while a rollback pins the environment (`pause`, ADR 0023):
 * what this run merges deploys only once its deploys resume, with `--deploy`, or for a promoted
 * environment with `opscrew promote` after resuming; while a credential rotation pauses them, only
 * once it ends; `undefined` otherwise.
 */
export async function pausedMergeNote(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: DeployPlan,
  pause: DeployPause | undefined,
): Promise<string | undefined> {
  if (pause?.reason === "rotation") {
    const flags = await commandFlags(deps.paths.root, deps.paths.environment, plan.app.key);
    return `The deploys of ${checkEnvironmentKey(plan)} are paused since ${pause.since} for ${await rotationWindowText(deps, flags, pause.hash)}. The merged files deploy only once it ends.`;
  }
  if (pause?.reason !== "rollback") return undefined;
  const environment = deps.paths.environment;
  const resume = `opscrew rollback${await commandFlags(deps.paths.root, environment, plan.app.key)} --resume`;
  const deploys =
    plan.environment?.deploySource.from === "promote"
      ? `\`${resume}\`, then \`opscrew promote --to ${environment}\``
      : `\`${resume} --deploy\``;
  return `The deploys of ${checkEnvironmentKey(plan)} are paused since ${pause.since}: ${pinnedText(pause)}. The merged files deploy only after ${deploys}.`;
}

/**
 * Reports {@link pausedMergeNote} for the environment's pause in GitHub, read without asking the
 * token for a new permission ({@link readableDeployPause}); nothing when no rollback or rotation
 * holds it.
 */
export async function reportPausedMerge(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "redactor">,
  plan: DeployPlan,
  github: Parameters<typeof readableDeployPause>[0],
): Promise<void> {
  const note = await pausedMergeNote(deps, plan, await readableDeployPause(github, plan));
  if (note !== undefined) deps.reporter.info(note);
}
