/**
 * Rotations through the IaC engine and the Cloudflare connector (025 plan.md 8., US8, FR-2511):
 * `access-token` by a plan replacing the token's resource (`-replace`), then the deploy's secrets;
 * `tunnel-token` by the Tunnel's secret changed in place (research R11), then the state's copy of
 * the token and the connectors; `state-passphrase` by a plan with no changes for every state the
 * passphrase encrypts, each applied with the current passphrase as OpenTofu's fallback, which
 * rewrites it under the new one (research R10), then the file; and, once a deploy-key rotation's
 * new key proved itself, the deploy key's object at the provider ({@link replaceDeployKeyObject}).
 * Every change is shown and approved by its hash first. No token or passphrase reaches any output:
 * each is registered with the redactor before anything prints.
 *
 * The infrastructure plans go through {@link planRotation} rather than provision's `planAndApply`:
 * a rotation's plan may change only what the rotation names, which is checked before its approval;
 * the passphrase's plan has no changes and must still be applied; and the token's state refresh is
 * refresh-only. As provision's, each plan is saved with its sidecar before its approval: a
 * script's refusal names its hash, and the next run given `--approve <hash>` (with `--confirm
 * <app>` for a replacement) applies that saved plan instead of planning again, which the engine
 * refuses once the state changed. A finished rotation removes its saved plans.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import type { IacEngine, ResourceChange } from "@opscrew/contracts";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  readTextIfExists,
  sha256Hex,
  tfstateFile,
  toPosixRelative,
  upperFirst,
} from "@opscrew/core";
import {
  type EnginePreference,
  engineLabel,
  hashFile,
  type StateKeyName,
  stateKeyName,
  tofuEncryptionEnv,
} from "@opscrew/iac-engine";
import {
  backupsRootDir,
  DEPLOY_PAUSED_VARIABLE,
  PORTAINER_DEPLOY_SECRETS,
  pagesVerificationRootDir,
  providerBucket,
  storageRootDir,
  TUNNEL_DEPLOY_SECRETS,
  tunnelMode,
  usesTunnel,
} from "@opscrew/iac-templates";
import { type DeployPlan, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { blockingPolicyFailures, evaluatePlanPolicies } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { requireNoOtherPause, withDeploysPausedUntilDone } from "../move/deploys";
import { cloudflareTokenMissing, type GitHubSetup } from "../provision/credentials";
import { ownEngineEnv, ownTarget } from "../provision/own";
import {
  describePlan,
  findSavedPlan,
  lastLines,
  ROTATION_PLAN_SUFFIX,
  savedPlanOf,
  writePlanSidecar,
} from "../provision/plan-apply";
import { maskSensitivePlanJson } from "../provision/plan-json";
import { setPortainerOrigin } from "../provision/portainer";
import { deploySecretPlace, setSecretAt } from "../provision/secrets";
import {
  backupsEngineEnv,
  backupsStateFile,
  requireOffsiteKey,
  requireStorageKey,
  storageEngineEnv,
  storageStateFile,
} from "../provision/storage";
import type { ProvisionServices, SavedPlan } from "../provision/types";
import { discardSaved } from "../retarget/plans";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { PlanRefusedError, requestApproval } from "../shared/approvals";
import {
  chooseEngine,
  type EngineFactory,
  hasState,
  infrastructureOutputs,
  type ProjectEngine,
  pagesVerificationStateFile,
  projectEngine,
  stringOutput,
} from "../shared/engine";
import { continued } from "../shared/errors";
import { readValidJson } from "../shared/files";
import {
  adoptNextStatePassphrase,
  keepNextStatePassphrase,
  newStatePassphrase,
  nextStatePassphraseFile,
  readSecretFile,
  statePassphraseFile,
} from "../shared/secret-files";
import { setPortainerRecordsAddress } from "../shared/server-address";
import { readPortainerConnection } from "../shared/server-record";
import type { VpnServices } from "../vpn/servers";
import {
  portainerTunnelConnectors,
  type RotatedTunnel,
  serverTunnelConnectors,
  type TunnelConnectors,
  type TunnelModule,
} from "./infra-connectors";
import { assertValuesCurrent, credentialsRecordFile, recordRotation } from "./record";

/** The engine a rotation plans with. */
export interface RotationEngineOptions {
  /** `--engine`; default `plan.infra.engine`. */
  preference?: EnginePreference;
  /** Tests: the engine. */
  services?: { engine?: EngineFactory };
  /**
   * Every `--approve <hash>` of the run: a saved plan of this rotation among them (an earlier
   * run's, refused in a script) is applied instead of planning again.
   */
  approveHashes?: readonly string[];
}

/** A finished rotation. */
export interface InfraRotation {
  /** The hash its plan was approved by; absent when no plan was needed. */
  hash?: string;
  /** The recovery copy, refreshed: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/** The Access service token the deploy reaches the server (or Portainer's webhook) through. */
const ACCESS_TOKEN = "module.access.cloudflare_zero_trust_access_service_token.ssh[0]";

/** The Access policy that lets exactly that token through. */
const ACCESS_POLICY = "module.access.cloudflare_zero_trust_access_policy.ssh[0]";

/** The provider objects of the deploy key, which a server gets only when it is created. */
const DEPLOY_KEY_TYPES: ReadonlySet<string> = new Set(["hcloud_ssh_key", "digitalocean_ssh_key"]);

/** The root module's output with each tunnel's id. */
const TUNNEL_ID_OUTPUTS: Readonly<Record<TunnelModule, string>> = {
  tunnel: "tunnel_id",
  portainer_tunnel: "portainer_tunnel_id",
};

/** A tunnel in words. */
const TUNNEL_WORDS: Readonly<Record<TunnelModule, string>> = {
  tunnel: "the app's tunnel",
  portainer_tunnel: "the tunnel in front of Portainer's webhook",
};

/**
 * The Access service token's resource in `plan`'s root module: an own server's in tunnel mode, or
 * the one in front of a Portainer's webhook (redeploy `cloudflare`); none otherwise.
 */
export function accessTokenAddress(plan: DeployPlan): string | undefined {
  const webhook = plan.target.provider === "portainer" && plan.target.redeploy === "cloudflare";
  return tunnelMode(plan) || webhook ? ACCESS_TOKEN : undefined;
}

/**
 * The tunnels of `plan`'s root module: the app's (tunnel mode, Portainer or Beszel on a subdomain,
 * a Portainer's web mode `tunnel`) and the one in front of a Portainer's webhook.
 */
export function tunnelModules(plan: DeployPlan): TunnelModule[] {
  if (plan.target.provider !== "portainer") return usesTunnel(plan) ? ["tunnel"] : [];
  return [
    ...(plan.target.web.mode === "tunnel" ? (["tunnel"] as const) : []),
    ...(plan.target.redeploy === "cloudflare" ? (["portainer_tunnel"] as const) : []),
  ];
}

/**
 * The variables the root module of `plan` gets only from OpsCrew's local records, set in `env`,
 * never a file: an own server's address (`TF_VAR_server_ipv4`/`_ipv6`), and Portainer's address
 * (`TF_VAR_portainer_origin`, never from this computer's environment) with the records' address.
 * `env` already holds the state's `TF_ENCRYPTION`.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no record of the Portainer.
 */
async function rootVariables(
  deps: PhaseDeps,
  plan: DeployPlan,
  setup: ProjectEngine,
  again: string,
): Promise<void> {
  const { env } = setup;
  if (plan.target.provider === "own") {
    await ownEngineEnv(deps, { target: ownTarget(plan) }, env, () =>
      infrastructureOutputs(deps, plan, { engine: async () => setup.engine, engineEnv: env }),
    );
    return;
  }
  if (plan.target.provider !== "portainer") return;
  delete env.TF_VAR_portainer_origin;
  const connection = await readPortainerConnection(deps.paths);
  if (connection === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer has no record of how OpsCrew reaches your Portainer (${toPosixRelative(deps.paths.root, join(deps.paths.stateDir, "server.json"))}), so OpsCrew can't plan its Cloudflare resources. Nothing was changed.`,
      {
        hint: `Bring OpsCrew's files from your recovery copy (\`opscrew secrets restore\`) or run the command on the computer that set up the app, then run \`${again}\` again.`,
      },
    );
  }
  setPortainerOrigin(deps.redactor, env, connection.url);
  await setPortainerRecordsAddress(deps.paths, plan, env);
}

/**
 * The project's engine for the state that is there (its passphrase only read), with the root
 * module's variables of {@link rootVariables}.
 */
async function rotationEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RotationEngineOptions,
  again: string,
): Promise<ProjectEngine> {
  const setup = await projectEngine(deps, plan, {
    ...(options.preference !== undefined ? { preference: options.preference } : {}),
    ...(options.services !== undefined ? { services: options.services } : {}),
    passphrase: { requiredBy: again },
  });
  await rootVariables(deps, plan, setup, again);
  return setup;
}

/** What {@link planRotation} plans. */
interface RotationPlanInput {
  engine: IacEngine;
  env: Record<string, string | undefined>;
  /** The root module (default: the environment's) and its state. */
  root?: { dir: string; statePath: string };
  /** The resources replaced (`-replace`); each must be. */
  replace?: readonly string[];
  /** Only refresh the state (`-refresh-only`). */
  refreshOnly?: true;
  /** Input variables that differ from `terraform.tfvars.json` (no secret). */
  vars?: Record<string, string>;
  /** True for a change the rotation makes besides its replacements; any other stops the plan. */
  allowed: (change: ResourceChange) => boolean;
  /** Names the rotation's plan files ({@link rotationPlanSuffix}). */
  label: string;
  /** `--approve` hashes: one naming a saved plan of `label` is taken instead of a new plan. */
  approveHashes?: readonly string[];
  /** `opscrew rotate <name> [flags]`. */
  again: string;
}

/**
 * The end of a rotation's plan file's name, `<stamp>-<label>-rotation.tfplan`: no other command's
 * saved-plan lookup takes it ({@link ROTATION_PLAN_SUFFIX}).
 */
function rotationPlanSuffix(label: string): string {
  return `-${label}${ROTATION_PLAN_SUFFIX}`;
}

/**
 * Removes every saved plan of `label` (each plan file and its sidecar), once its rotation applied
 * one: none of them can be applied any more.
 */
async function discardRotationPlans(plansDir: string, label: string): Promise<void> {
  const suffix = rotationPlanSuffix(label);
  const names = await readdir(plansDir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.endsWith(suffix) || name.endsWith(`${suffix}.json`)) {
      await rm(join(plansDir, name), { force: true });
    }
  }
}

/**
 * The saved plan of `input.label` that one of `input.approveHashes` names, if any, once it was
 * made with this run's engine and its file still has that hash.
 * @throws OpsCrewError `PLAN_HASH_MISMATCH` when it was made with the other engine, when its file
 * is missing or changed (the plan is removed), or when its sidecar is damaged.
 */
async function approvedRotationPlan(
  plansDir: string,
  input: Pick<RotationPlanInput, "engine" | "label" | "approveHashes" | "again">,
): Promise<SavedPlan | undefined> {
  for (const hash of input.approveHashes ?? []) {
    const retry = `Run \`${input.again}\` again without --approve ${hash}: it plans again, and you approve the new plan's hash.`;
    const saved = await findSavedPlan(plansDir, hash, { hint: retry });
    if (saved === undefined || !saved.planFile.endsWith(rotationPlanSuffix(input.label))) continue;
    const engine = input.engine.info.name;
    if (saved.engine.name !== engine) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The saved plan with the hash ${saved.planHash} was made with ${engineLabel(saved.engine.name)}, but this run uses ${engineLabel(engine)}, so OpsCrew will not apply it. Nothing was changed.`,
        {
          hint: `Run \`${input.again}\` again with --engine ${saved.engine.name}, or without --approve ${hash} to plan again.`,
        },
      );
    }
    if ((await hashFile(saved.planFile).catch(() => "")) !== saved.planHash) {
      await discardSaved(saved.planFile);
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The saved plan with the hash ${saved.planHash} is missing or changed after it was saved, so OpsCrew will not apply it. Nothing was changed.`,
        { hint: retry },
      );
    }
    return saved;
  }
  return undefined;
}

/** `module.x.y (update)`, for the refusal that lists the other changes. */
function changeText(change: Pick<ResourceChange, "action" | "address">): string {
  return `${change.address} (${change.action})`;
}

/**
 * A root module planned for a rotation (after `init` against its state), its sensitive values
 * masked and its policies checked, then saved with its sidecar (as provision's plans, masked) for
 * a script's next run; or, when `input.approveHashes` names a saved plan of the rotation (an
 * earlier run's, checked like this one before it was saved), that plan, its file's hash checked.
 * Stops, its plan file removed, with the next step when a replaced resource is not in the state
 * yet (the engine refuses to plan it), when the plan changes anything the rotation does not
 * (`allowed`) or renames resources, when a refresh-only plan finds a managed resource changed
 * outside OpsCrew, or when a policy blocks it.
 * @throws OpsCrewError `PHASE_PRECONDITION` for those stops; `PLAN_HASH_MISMATCH` for a saved
 * plan that changed; `ENGINE_FAILED` from the engine.
 */
async function planRotation(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: RotationPlanInput,
): Promise<SavedPlan> {
  const { engine, env, again } = input;
  const { dir, statePath } = input.root ?? {
    dir: join(deps.paths.root, plan.infra.dir),
    statePath: tfstateFile(deps.paths),
  };
  const { plansDir } = deps.paths.files;
  await mkdir(plansDir, { recursive: true });
  const approved = await approvedRotationPlan(plansDir, input);
  deps.reporter.step(
    approved === undefined
      ? `Planning the rotation's change in ${toPosixRelative(deps.paths.root, dir)}`
      : `Taking the saved plan ${approved.planHash} an earlier run made`,
  );
  await engine.init(dir, { env, backendConfig: { path: statePath } });
  // The sidecar's paths pass through the redactor: the root is this run's.
  if (approved !== undefined) return { ...approved, dir };
  // A new plan supersedes the earlier ones: an older hash makes a new plan too.
  await discardRotationPlans(plansDir, input.label);
  const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
  const planFile = join(plansDir, `${stamp}${rotationPlanSuffix(input.label)}`);
  const { root, environment, app } = deps.paths;
  const provision = `opscrew provision${await commandFlags(root, environment, app)}`;
  const replace = input.replace ?? [];
  let summary: Awaited<ReturnType<IacEngine["plan"]>>;
  try {
    summary = await engine.plan(dir, planFile, {
      env,
      ...(input.vars !== undefined ? { vars: input.vars } : {}),
      ...(replace.length > 0 ? { replace } : {}),
      ...(input.refreshOnly === true ? { refreshOnly: true } : {}),
    });
  } catch (error) {
    // The engine plans nothing for an address the state lacks, and discards the plan.
    if (
      replace.length === 0 ||
      !(error instanceof OpsCrewError) ||
      error.code !== "INVALID_INPUT"
    ) {
      throw error;
    }
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The infrastructure state of ${environment} has no ${listText(replace)} to replace yet. Nothing was changed.`,
      {
        hint: `Run \`${provision}\`, which creates it, then run \`${again}\` again.`,
        cause: error,
      },
    );
  }
  const planJson = maskSensitivePlanJson(summary.planJson);
  const saved = savedPlanOf({ ...summary, planJson }, evaluatePlanPolicies(planJson, plan));
  const stop = async (message: string, hint: string): Promise<never> => {
    await rm(planFile, { force: true });
    throw new OpsCrewError("PHASE_PRECONDITION", `${message} Nothing was changed.`, { hint });
  };
  const replaced = new Set(replace);
  const others = saved.changes.filter((c) => !replaced.has(c.address) && !input.allowed(c));
  const moves = saved.moves ?? [];
  // A refresh-only apply would accept every change made outside OpsCrew into the state, where
  // `opscrew drift` no longer sees it (managed resources only: data sources are read anew).
  const drift = input.refreshOnly === true ? (summary.drift ?? []) : [];
  if (others.length > 0 || moves.length > 0 || drift.length > 0) {
    const listed = [
      ...others.map(changeText),
      ...moves.map((move) => `${move.from} (renamed to ${move.to})`),
      ...drift.map((entry) => `${entry.address} (changed outside OpsCrew)`),
    ];
    await stop(
      `The infrastructure plan of ${environment} has changes besides the rotation's (${listText(listed.slice(0, 5))}${listed.length > 5 ? ", …" : ""}), so OpsCrew applied none of it.`,
      `Run \`${provision}\` to review and apply them first, then run \`${again}\` again.`,
    );
  }
  const blocking = blockingPolicyFailures(saved.policy);
  if (blocking.length > 0) {
    await stop(
      `The rotation's plan fails ${blocking.length} security ${blocking.length === 1 ? "policy" : "policies"}: ${blocking.map((p) => p.title).join("; ")}.`,
      blocking.map((p) => p.message).join(" "),
    );
  }
  await writePlanSidecar(deps.redactor, saved);
  return saved;
}

/** What the approval of a rotation's plan says around the plan itself. */
interface RotationText {
  title: string;
  /** What the rotation does, before the plan. */
  intro: readonly string[];
  /** What follows the apply, after the plan. */
  after: readonly string[];
  /** What a refusal calls the plan. */
  noun: string;
  /** What a refusal says stays as it was (default: nothing was changed). */
  unchanged?: string;
  /** A script's refusal also offers `<again> --undo`, which steps back from the rotation. */
  undo?: true;
  again: string;
}

/**
 * Asks the approval of `saved`, bound to its hash (`iac-apply`; a replacement needs the app's name
 * typed), and checks it is the one recorded. A script's refusal keeps the saved plan and names its
 * hash for the next run; a terminal's removes it (the next run asks again with a new plan).
 * @throws PlanRefusedError when it is not given.
 */
async function approveRotationPlan(
  deps: PhaseDeps,
  plan: DeployPlan,
  saved: SavedPlan,
  text: RotationText,
): Promise<void> {
  const confirm = saved.hasDestroy ? plan.app.name : undefined;
  const approval = await deps.approvals.request({
    kind: "iac-apply",
    title: text.title,
    details: [
      ...text.intro,
      "",
      describePlan(saved, plan, { costUnchanged: true }),
      "",
      ...text.after,
    ].join("\n"),
    planHash: saved.planHash,
    policy: saved.policy,
    ...(confirm !== undefined ? { allowDestroy: true, confirmPhrase: confirm } : {}),
  });
  if (!approval.approved) {
    if (deps.interactive) await discardSaved(saved.planFile);
    const confirmFlag = confirm === undefined ? "" : ` --confirm ${confirm}`;
    throw new PlanRefusedError({
      plan: text.noun,
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      unchanged: text.unchanged ?? "Nothing was changed.",
      hint: deps.interactive
        ? `Run \`${text.again}\` again when you are ready${confirm === undefined ? "" : ` (the plan replaces resources, so you type ${confirm} to approve it)`}.`
        : `To apply this saved plan in a script, run \`${text.again}\` again with the flags you gave (each --approve <hash> too) and --approve ${saved.planHash}${confirmFlag} added.${text.undo === true ? ` To step back instead, run \`${text.again} --undo\`.` : ""}`,
    });
  }
  await deps.approvals.assertApprovedPlan(saved.planHash, { allowDestroy: saved.hasDestroy });
}

/**
 * Applies exactly the approved `saved` (`what` in the audit entry) and returns the root's outputs.
 * Applied or not, the plan is spent (an apply that failed half-way changed the state): it is
 * removed, and once applied every other saved plan of `label` too.
 * @throws OpsCrewError `PLAN_HASH_MISMATCH` when the engine finds the saved plan stale (the state
 * changed since it was made), `ENGINE_FAILED` with the redacted log's last lines when the apply
 * fails otherwise.
 */
async function applyRotationPlan(
  deps: PhaseDeps,
  setup: Pick<ProjectEngine, "engine" | "env">,
  saved: SavedPlan,
  input: { what: string; label: string; again: string },
): Promise<Record<string, unknown>> {
  deps.reporter.step("Applying the rotation's infrastructure plan");
  const result = await setup.engine.apply(
    saved.dir,
    saved.planFile,
    { approvedPlanHash: saved.planHash, allowDestroy: saved.hasDestroy },
    { env: setup.env },
  );
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "apply",
    target: saved.planHash,
    decision: result.ok ? "approved" : "refused",
    detail: `${input.what}: ${result.ok ? "apply finished" : "apply failed"}`,
  });
  if (result.ok) {
    await discardRotationPlans(deps.paths.files.plansDir, input.label);
    return result.outputs;
  }
  await discardSaved(saved.planFile);
  const log = deps.redactor.redact(result.log);
  if (/Saved plan is stale/i.test(log)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The saved plan with the hash ${saved.planHash} no longer fits the infrastructure state, which changed after the plan was made, so OpsCrew applied none of it.`,
      {
        hint: `Run \`${input.again}\` again without --approve ${saved.planHash}: it plans again from the state as it is now, and you approve the new plan's hash.`,
      },
    );
  }
  throw new OpsCrewError(
    "ENGINE_FAILED",
    `Applying the rotation's plan failed:\n${lastLines(log)}`,
    {
      hint: `Fix the cause shown above, then run \`${input.again}\` again; it plans again.`,
    },
  );
}

/** What {@link rotateAccessToken} reaches besides the engine. */
export interface AccessTokenServices extends RotationEngineOptions {
  /** The repository: its deploy pause and runs, and the token's secrets. */
  github: Pick<GitHubSetup, "api" | "owner" | "repo">;
  /** Tests: the wait for a running deploy. */
  sleep?: ProvisionServices["sleep"];
  now?: ProvisionServices["now"];
}

/**
 * The key the Access token's rotation pauses the deploys under: the same for every run of it in
 * the environment, so a run after a failure goes on under its own pause.
 */
function pauseKey(deps: PhaseDeps, plan: DeployPlan): string {
  return sha256Hex(
    canonicalJson({
      rotation: "access-token",
      environment: deps.paths.environment,
      app: plan.app.name,
    }),
  );
}

/**
 * The new Access service token from the apply's outputs as the deploy secrets that hold it (an own
 * server's tunnel SSH, or a Portainer's webhook), registered with the redactor.
 * @throws OpsCrewError `ENGINE_FAILED` when the outputs lack it.
 */
function accessSecrets(
  deps: PhaseDeps,
  plan: DeployPlan,
  outputs: Record<string, unknown>,
  again: string,
): Record<string, string> {
  const id = stringOutput(outputs, "deploy_service_token_client_id");
  const secret = stringOutput(outputs, "deploy_service_token_client_secret");
  if (id !== undefined) deps.redactor.addLiteral(id, "service-token-id");
  if (secret !== undefined) deps.redactor.addLiteral(secret, "service-token-secret");
  if (id === undefined || secret === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      "The apply finished, but the infrastructure state has no Access service token, so OpsCrew could not give the deploy the new one.",
      { hint: `Run \`${again}\` again; it replaces the token once more.` },
    );
  }
  const names =
    plan.target.provider === "portainer"
      ? {
          id: PORTAINER_DEPLOY_SECRETS.accessClientId,
          secret: PORTAINER_DEPLOY_SECRETS.accessClientSecret,
        }
      : {
          id: TUNNEL_DEPLOY_SECRETS.serviceTokenId,
          secret: TUNNEL_DEPLOY_SECRETS.serviceTokenSecret,
        };
  return { [names.id]: id, [names.secret]: secret };
}

/**
 * Rotates the Cloudflare Access service token of `plan`'s environment (`deps.paths`): after the
 * two-computer guard and while nothing else pauses the deploys, an infrastructure plan replacing
 * the token's resource ({@link accessTokenAddress}; with the Access policy that names it, nothing
 * else) shown with its policies and approved by its hash with the app's name typed (in a script,
 * an earlier run's saved plan that `services.approveHashes` names); then, with the
 * app's deploys paused (kept paused when a step fails, resumed by the run that finishes), the apply
 * and the deploy secrets that hold the token. Then the rotation is recorded and the recovery copy,
 * which holds the state, refreshed.
 * @throws OpsCrewError `INVALID_INPUT` when the environment has no such token, `PHASE_PRECONDITION`
 * for the refusals, `APPROVAL_REFUSED`, and the failed step's error.
 */
export async function rotateAccessToken(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: AccessTokenServices,
): Promise<InfraRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const again = `opscrew rotate access-token${flags}`;
  const address = accessTokenAddress(plan);
  if (address === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${environment} has no Cloudflare Access service token: its deploy reaches no server or webhook through Access. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  await assertValuesCurrent(deps);
  const key = pauseKey(deps, plan);
  await requireNoOtherPause(deps, services.github, plan, { own: key, again, flags });
  const setup = await rotationEngine(deps, plan, services, again);
  const saved = await planRotation(deps, plan, {
    ...setup,
    replace: [address],
    label: "access-token",
    ...(services.approveHashes !== undefined ? { approveHashes: services.approveHashes } : {}),
    // The deploy's Access policy names the token by its id, so it is updated in place; its
    // application names the policy, whose id stays. Nothing else follows the replacement.
    allowed: (change) => change.address === ACCESS_POLICY && change.action === "update",
    again,
  });
  const record = toPosixRelative(root, credentialsRecordFile(deps.paths));
  const reaches = plan.target.provider === "portainer" ? "Portainer's webhook" : "the server";
  await approveRotationPlan(deps, plan, saved, {
    title: `Replace the Cloudflare Access service token of ${environment}`,
    intro: [
      `A new Cloudflare Access service token replaces the one the deploy of ${environment} reaches ${reaches} through; neither is ever shown.`,
      "The old token stops working as soon as the new one is made, so the app's deploys are paused in GitHub (the repository variable OPSCREW_DEPLOY_PAUSED) from before the apply until the deploy's GitHub secrets hold the new token. The app keeps answering.",
    ],
    after: [
      `Then the deploy's GitHub secrets get the new token (encrypted on this computer before upload), the deploys resume, ${record} records the rotation and the recovery copy, which holds the infrastructure state, is refreshed.`,
    ],
    noun: "infrastructure plan of the rotation of the Cloudflare Access service token",
    again,
  });
  await withDeploysPausedUntilDone(
    deps,
    services.github,
    plan,
    services,
    { command: again, hash: key },
    async () => {
      try {
        const outputs = await applyRotationPlan(deps, setup, saved, {
          what: "rotate access-token",
          label: "access-token",
          again,
        });
        deps.reporter.step("Giving the deploy's GitHub secrets the new Access token");
        const secrets = accessSecrets(deps, plan, outputs, again);
        for (const [unprefixed, value] of Object.entries(secrets)) {
          await setSecretAt(deps, services.github, deploySecretPlace(plan, unprefixed), value);
        }
      } catch (error) {
        throw continued(error, {
          said: `The app's deploys stay paused (${DEPLOY_PAUSED_VARIABLE}) until \`${again}\` finishes.`,
          fallback: "Fix what it names. ",
          next: `Running \`${again}\` again replaces the token once more and resumes the deploys.`,
        });
      }
    },
  );
  await recordRotation(deps, ["access-token"]);
  deps.reporter.success(
    `Replaced the Cloudflare Access service token of ${environment}: the old one no longer works.`,
  );
  return { hash: saved.planHash, copy: await refreshRecoveryCopy(deps, plan) };
}

/** What {@link rotateTunnelToken} reaches besides the engine. */
export interface TunnelTokenServices extends RotationEngineOptions {
  /**
   * Tests: the connectors (default: the user's Portainer's stacks, `portainerTunnelConnectors`, or
   * the app's server's, `serverTunnelConnectors`).
   */
  connectors?: TunnelConnectors;
  /** Tests: the app's server's shell and host adapter for its connector's host plan. */
  server?: Pick<VpnServices, "remote" | "host">;
  /** Tests: the user's Portainer and GitHub, for the stacks (provision's services). */
  provision?: ProvisionServices;
  /** Tests: Cloudflare's API (default: the client with `CLOUDFLARE_API_TOKEN`). */
  cloudflare?: Pick<CloudflareClient, "rotateTunnelSecret">;
}

/** The account the root module's Cloudflare resources live in, from `terraform.tfvars.json`. */
const AccountTfvarsSchema = z.looseObject({ cloudflare_account_id: z.string().min(1) });

/**
 * Rotates the Cloudflare Tunnel tokens of `plan`'s environment (`deps.paths`, research R11), with
 * no replacement: after the two-computer guard, a new secret for each tunnel
 * ({@link tunnelModules}; 32 random bytes, never kept) and the rotation's plan shown and approved
 * by its hash (`cloudflare-apply`). Then Cloudflare takes each new secret in place, which changes
 * the tunnel's token while its running connectors stay connected; a refresh-only plan, approved by
 * its own hash, records the new tokens in the state (provision hands the state's token to the
 * connectors); and the connectors restart with it (on a server, its connector's host plan; in the
 * user's Portainer, one stack plan; each approved by its own hash, whose setup must hold no other
 * changes, checked before anything changes: `serverTunnelConnectors`,
 * `portainerTunnelConnectors`). Then the
 * rotation is recorded and the recovery copy refreshed. A run after a failure starts over with
 * new secrets under the same rotation hash (it binds the tunnels, never a secret), the running
 * connectors keeping the tunnels up meanwhile; in the user's Portainer, once the state holds the
 * new token, `opscrew provision` finishes it too. Refused, before anything changes, without a
 * terminal: its later plans are made from the token Cloudflare returns, so no script can name them.
 * @throws OpsCrewError `INVALID_INPUT` without a tunnel, `PHASE_PRECONDITION` without the state or
 * its tunnels, `CREDENTIALS_MISSING` without the Cloudflare token, `APPROVAL_REFUSED`, and the
 * failed step's error.
 */
export async function rotateTunnelToken(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: TunnelTokenServices,
): Promise<InfraRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const again = `opscrew rotate tunnel-token${flags}`;
  const modules = tunnelModules(plan);
  if (modules.length === 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${environment} has no Cloudflare Tunnel, so it has no tunnel token. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  // Its later plans (the state's refresh, the connectors') are made from the token Cloudflare
  // returns, so no script can name their hashes in advance.
  if (!deps.interactive) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Rotating the Cloudflare Tunnel token asks several approvals in turn, each of a plan made from the step before, so it runs only in a terminal. Nothing was changed.",
      { hint: `Run \`${again}\` in a terminal.` },
    );
  }
  await assertValuesCurrent(deps);
  const connectors =
    services.connectors ??
    (plan.target.provider === "portainer"
      ? portainerTunnelConnectors(deps, plan, {
          command: again,
          ...(services.provision !== undefined ? { services: services.provision } : {}),
        })
      : serverTunnelConnectors(deps, plan, {
          command: again,
          ...(services.server !== undefined ? { services: services.server } : {}),
        }));
  const provision = `opscrew provision${flags}`;
  const notHere = (what: string) =>
    new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer has no ${what} of ${environment}, so OpsCrew can't tell which tunnel to change. Nothing was changed.`,
      {
        hint: `Run \`${provision}\` on this computer (or bring OpsCrew's files from your recovery copy with \`opscrew secrets restore${flags}\`), then run \`${again}\` again.`,
      },
    );
  if (!(await hasState(deps.paths))) throw notHere("infrastructure state");
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (services.cloudflare === undefined && !token) throw cloudflareTokenMissing(deps);
  if (token) deps.redactor.addLiteral(token, "cloudflare-token");
  const setup = await rotationEngine(deps, plan, services, again);
  const outputs =
    (await infrastructureOutputs(deps, plan, {
      engine: async () => setup.engine,
      engineEnv: setup.env,
    })) ?? {};
  const tfvars = await readValidJson(
    join(root, plan.infra.dir, "terraform.tfvars.json"),
    AccountTfvarsSchema,
  );
  if (tfvars === undefined) throw notHere("Cloudflare account in terraform.tfvars.json");
  const account = tfvars.cloudflare_account_id;
  const tunnels = modules.map((module) => {
    const tunnelId = stringOutput(outputs, TUNNEL_ID_OUTPUTS[module]);
    if (tunnelId === undefined) throw notHere(`tunnel in the infrastructure state (${module})`);
    const secret = randomBytes(32).toString("base64");
    deps.redactor.addLiteral(secret, "tunnel-secret");
    return { module, tunnelId, secret };
  });
  // The rotation and the tunnels: the same for a run again after a refusal or a failure.
  const hash = sha256Hex(
    canonicalJson({
      rotation: "tunnel-token",
      environment,
      app: plan.app.name,
      account,
      tunnels: tunnels.map((t) => ({ module: t.module, id: t.tunnelId })),
    }),
  );
  // Before anything changes: the connectors' setup holds no changes of its own.
  await connectors.check();
  const record = toPosixRelative(root, credentialsRecordFile(deps.paths));
  const which = listText(tunnels.map((t) => TUNNEL_WORDS[t.module]));
  const restarts =
    plan.target.provider === "portainer"
      ? "3. The connectors' stacks in your Portainer get the new token through one stack plan, approved by its own hash. Portainer recreates each connector, so what each tunnel serves pauses for that restart, a few seconds."
      : "3. The connector restarts with the new token through its host plan, approved by its own hash. With one connector, what the tunnel serves pauses for that restart, a few seconds; with two, not at all.";
  await requestApproval(deps, {
    kind: "cloudflare-apply",
    title: `Change the Cloudflare Tunnel token of ${environment}`,
    details: [
      `A new secret made on this computer replaces the secret of ${which} in Cloudflare, which changes the tunnel's token; neither is ever shown. The tunnel stays as it is: no replacement.`,
      "1. Cloudflare takes the new secret through its API. The connectors running now stay connected and the tunnel keeps serving; only a connector that starts from then on needs the new token.",
      "2. The infrastructure state records the new token: a refresh-only plan, shown and approved by its own hash, that changes nothing in the cloud.",
      restarts,
      `4. ${record} records the rotation and the recovery copy is refreshed.`,
      `If a step fails, the running connectors keep the tunnel up, and \`${again}\` starts over with a new secret.`,
      `Rotation hash: ${hash}`,
    ].join("\n"),
    hash,
    // It runs only in a terminal: no `--approve`.
    refused: {
      plan: "rotation of the Cloudflare Tunnel token",
      unchanged: "Nothing was changed.",
      again,
      scripted: false,
    },
  });
  const cloudflare =
    services.cloudflare ??
    new CloudflareClient({
      token: token as string,
      fetch: deps.fetch,
      version: deps.version,
      redactor: deps.redactor,
    });
  const rotated: RotatedTunnel[] = [];
  let recorded = false;
  try {
    for (const tunnel of tunnels) {
      deps.reporter.step(`Giving ${TUNNEL_WORDS[tunnel.module]} a new secret in Cloudflare`);
      const next = await cloudflare.rotateTunnelSecret(account, tunnel.tunnelId, tunnel.secret);
      deps.redactor.addLiteral(next, "tunnel-token");
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "change the Cloudflare Tunnel's secret",
        target: `${environment} ${tunnel.module}`,
        decision: "approved",
        detail: `rotation ${hash}`,
      });
      rotated.push({ module: tunnel.module, tunnelId: tunnel.tunnelId, token: next });
    }
    const saved = await planRotation(deps, plan, {
      ...setup,
      refreshOnly: true,
      label: "tunnel-token",
      allowed: () => false,
      again,
    });
    await approveRotationPlan(deps, plan, saved, {
      title: `Record the new Cloudflare Tunnel token of ${environment} in the infrastructure state`,
      intro: [
        "Cloudflare holds the tunnel's new token. This refresh-only plan writes it into the infrastructure state, which provision hands to the connectors; nothing in the cloud changes.",
      ],
      after: ["Then the connectors restart with the new token."],
      noun: "refresh-only plan of the Cloudflare Tunnel token",
      unchanged: "The infrastructure state still holds the old token.",
      again,
    });
    await applyRotationPlan(deps, setup, saved, {
      what: "rotate tunnel-token",
      label: "tunnel-token",
      again,
    });
    recorded = true;
    deps.reporter.step(`Restarting the connectors of ${which} with the new token`);
    await connectors.restart(rotated);
  } catch (error) {
    if (rotated.length === 0) throw error;
    // The state holds the new token once refreshed: provision gives it to Portainer's stacks
    // (their values follow the state), while a server's connector runs on as it is.
    throw continued(error, {
      said: "Cloudflare holds the tunnel's new secret; the connectors that run keep the tunnel up with the old token.",
      fallback: "Fix what it names. ",
      next:
        recorded && plan.target.provider === "portainer"
          ? `Then run \`${provision}\`: it gives the stacks the new token the infrastructure state holds.`
          : `Then run \`${again}\` again: it gives the tunnel another new secret and goes on.`,
    });
  }
  await recordRotation(deps, ["tunnel-token"]);
  deps.reporter.success(
    `Changed the Cloudflare Tunnel token of ${environment}: the connectors run with the new one, and the old one can no longer start a connector.`,
  );
  return { hash, copy: await refreshRecoveryCopy(deps, plan) };
}

/** True when `passphrase` alone, under the key name `name`, opens the state at `statePath`. */
async function opensState(
  deps: PhaseDeps,
  engine: IacEngine,
  statePath: string,
  passphrase: string,
  name: StateKeyName,
): Promise<boolean> {
  const env = { ...deps.env, TF_ENCRYPTION: tofuEncryptionEnv(passphrase, { name }) };
  return engine.stateResources(statePath, { env }).then(
    () => true,
    () => false,
  );
}

/** The key name of the state at `statePath`; `undefined` without a state or with a blank one. */
async function stateName(statePath: string): Promise<StateKeyName | undefined> {
  const text = await readTextIfExists(statePath);
  return text === undefined || text.trim() === "" ? undefined : stateKeyName(text);
}

/** A state the passphrase encrypts, with the root module it belongs to. */
interface PassphraseRoot {
  /** In the approval's words: `the infrastructure state`. */
  noun: string;
  /** Names its plan files: `state-passphrase-<label>`. */
  label: string;
  dir: string;
  statePath: string;
  /** The engine's environment for the root, given its `TF_ENCRYPTION`. */
  env: (encryption: string) => Promise<Record<string, string | undefined>>;
}

/**
 * Every state of the environment the passphrase encrypts that holds something, each with its root
 * module and the environment its plan needs: the environment's own, the app's bucket's
 * (`storage.tfstate`, its key), the off-server copies' bucket's (`backups.tfstate`, its key) and
 * GitHub's verification record's.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a bucket's state whose bucket the plan no longer
 * has; `CREDENTIALS_MISSING` without a bucket's key.
 */
async function passphraseRoots(
  deps: PhaseDeps,
  plan: DeployPlan,
  engine: IacEngine,
  again: string,
): Promise<PassphraseRoot[]> {
  const { root } = deps.paths;
  const held = async (statePath: string) => (await stateName(statePath)) !== undefined;
  const without = (statePath: string, what: string) =>
    new OpsCrewError(
      "PHASE_PRECONDITION",
      `${toPosixRelative(root, statePath)} is encrypted with the state passphrase, but ${plan.app.name}'s plan has no ${what} any more, so OpsCrew can't rewrite it under a new one. Nothing was changed.`,
      {
        hint: `Put the ${what} back in the plan, or move that file out of the project if it holds nothing, then run \`${again}\` again.`,
      },
    );
  const roots: PassphraseRoot[] = [];
  const main = tfstateFile(deps.paths);
  if (await held(main)) {
    roots.push({
      noun: "the infrastructure state",
      label: "infra",
      dir: join(root, plan.infra.dir),
      statePath: main,
      env: async (encryption) => {
        const env = { ...deps.env, TF_ENCRYPTION: encryption };
        await rootVariables(deps, plan, { engine, env }, again);
        return env;
      },
    });
  }
  const storage = storageStateFile(deps.paths);
  if (await held(storage)) {
    const bucket = providerBucket(plan);
    if (bucket === undefined) throw without(storage, "bucket");
    const key =
      bucket.provider === "r2"
        ? undefined
        : await requireStorageKey(deps, plan, {}, { command: again, asks: false });
    roots.push({
      noun: "the app's bucket's state",
      label: "storage",
      dir: join(root, storageRootDir(plan)),
      statePath: storage,
      env: async (encryption) =>
        storageEngineEnv({ ...deps.env, TF_ENCRYPTION: encryption }, plan, key),
    });
  }
  const backups = backupsStateFile(deps.paths);
  if (await held(backups)) {
    const offsite = snapshotOffsiteOf(plan);
    if (offsite === undefined) throw without(backups, "off-server copy");
    const key =
      offsite.provider === "r2"
        ? undefined
        : await requireOffsiteKey(deps, plan, {}, { command: again });
    roots.push({
      noun: "the off-server copies' bucket's state",
      label: "backups",
      dir: join(root, backupsRootDir(plan)),
      statePath: backups,
      env: async (encryption) =>
        backupsEngineEnv({ ...deps.env, TF_ENCRYPTION: encryption }, plan, key),
    });
  }
  const verification = pagesVerificationStateFile(deps.paths);
  if (await held(verification)) {
    roots.push({
      noun: "the state of GitHub's verification record",
      label: "verification",
      dir: join(root, pagesVerificationRootDir(plan)),
      statePath: verification,
      env: async (encryption) => ({ ...deps.env, TF_ENCRYPTION: encryption }),
    });
  }
  return roots;
}

/**
 * `--undo` of an unfinished state-passphrase rotation: once every state still opens with the
 * current passphrase (each checked before anything is removed), the new passphrase
 * (`state_passphrase.next`) and the rotation's saved plans are removed, and the other commands
 * work again. The current passphrase stays as it is.
 * @throws OpsCrewError `PHASE_PRECONDITION` when no rotation is unfinished, or when a state was
 * already rewritten with the new passphrase (the rotation only goes forward from there).
 */
async function undoStatePassphrase(
  deps: PhaseDeps,
  input: {
    engine: IacEngine;
    roots: readonly PassphraseRoot[];
    current: string;
    kept: string | undefined;
    again: string;
  },
): Promise<void> {
  const { engine, roots, current, again } = input;
  const { root, environment } = deps.paths;
  if (input.kept === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `No rotation of the state passphrase is unfinished in ${environment}, so there is nothing to undo. Nothing was changed.`,
    );
  }
  for (const each of roots) {
    const name = (await stateName(each.statePath)) as StateKeyName;
    if (!(await opensState(deps, engine, each.statePath, current, name))) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${upperFirst(each.noun)} (${toPosixRelative(root, each.statePath)}) is already encrypted with the new passphrase, and the rotation only goes forward from there, so OpsCrew can't undo it. Nothing was changed.`,
        { hint: `Run \`${again}\` again to finish it.` },
      );
    }
  }
  for (const each of roots) {
    await discardRotationPlans(deps.paths.files.plansDir, `state-passphrase-${each.label}`);
  }
  await rm(nextStatePassphraseFile(deps.paths).file, { force: true });
  deps.reporter.success(
    `Stepped back from the rotation of the state passphrase of ${environment}: no state was rewritten, the new passphrase and its saved plans are gone, and the current one stays in ${deps.paths.files.statePassphrase}.`,
  );
}

/**
 * Rotates the state passphrase of `plan`'s environment (`deps.paths`), with OpenTofu, across every
 * state it encrypts ({@link passphraseRoots}): after the two-computer guard and once every bucket
 * key is at hand, each state that the new passphrase does not open yet gets a plan with the new
 * one and the current one as the fallback (`TF_ENCRYPTION`, under the key name the state has:
 * `stateKeyName`), a plan that must change nothing, shown and approved by its own hash, then
 * applied, which rewrites that state under the new one; in a script, a plan approved by
 * `options.approveHashes` is an earlier run's saved one. The new passphrase is kept on this
 * computer (`state_passphrase.next`, 0600) before the first apply (in a script, before the first
 * approval: the saved plan is encrypted with it and waits for the next run), and replaces the
 * current one only once every state opens with it alone. A run after a failure goes on with it, skipping the
 * states already rewritten. Without any state, nothing is encrypted with it yet: the new one
 * replaces it at once. Then the rotation is recorded and the recovery copy, which holds the states
 * and the passphrase, refreshed. Refused, before anything is made, when the plan does not encrypt
 * its state, with Terraform, and when this computer has no passphrase. With `options.undo`, it
 * steps back from an unfinished rotation instead ({@link undoStatePassphrase}).
 * @throws OpsCrewError `INVALID_INPUT`, `PHASE_PRECONDITION` for the refusals, `APPROVAL_REFUSED`,
 * `ENGINE_FAILED` when an apply fails or a state does not open with the new passphrase after it.
 */
export async function rotateStatePassphrase(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RotationEngineOptions & {
    /** `--undo`: step back from an unfinished rotation no state was rewritten by. */
    undo?: true;
  } = {},
): Promise<InfraRotation> {
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const again = `opscrew rotate state-passphrase${flags}`;
  const file = deps.paths.files.statePassphrase;
  if (!plan.infra.stateEncryption) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${plan.app.name}'s infrastructure state in ${environment} is not encrypted (infra.stateEncryption is off in its plan), so it has no passphrase to rotate. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  const engine = await chooseEngine(
    deps,
    options.preference ?? plan.infra.engine,
    options.services?.engine,
  );
  if (engine.info.name !== "tofu") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Only OpenTofu encrypts the infrastructure state, and this run uses Terraform. Nothing was changed.",
      { hint: `Run \`${again} --engine tofu\`.` },
    );
  }
  await assertValuesCurrent(deps);
  const current = await readSecretFile(statePassphraseFile(deps.paths));
  if (current === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer has no state passphrase of ${environment} (${file}), so there is none to rotate here. Nothing was changed.`,
      {
        hint: `Bring it from your recovery copy (\`opscrew secrets restore${flags}\`) or run the command on the computer that set up the app.`,
      },
    );
  }
  deps.redactor.addLiteral(current, "state-passphrase");
  const roots = await passphraseRoots(deps, plan, engine, again);
  // An unfinished rotation's new passphrase, which some states may already be encrypted with.
  const kept = await readSecretFile(nextStatePassphraseFile(deps.paths));
  if (options.undo === true) {
    await undoStatePassphrase(deps, { engine, roots, current, kept, again });
    return { copy: { changed: false } };
  }
  const next = kept ?? newStatePassphrase();
  deps.redactor.addLiteral(next, "state-passphrase");
  let hash: string | undefined;
  if (next !== current) {
    const pending: { root: PassphraseRoot; name: StateKeyName }[] = [];
    for (const each of roots) {
      const name = (await stateName(each.statePath)) as StateKeyName;
      const done =
        kept !== undefined && (await opensState(deps, engine, each.statePath, next, name));
      if (!done) pending.push({ root: each, name });
    }
    const record = toPosixRelative(root, credentialsRecordFile(deps.paths));
    const states = listText(roots.map((each) => toPosixRelative(root, each.statePath)));
    // Kept before anything that stays is encrypted with it, so no state or saved plan ever holds a
    // key this computer lacks: in a terminal once the first plan is approved; in a script once the
    // first plan passed its checks, as it waits for the next run's `--approve`.
    let held = kept !== undefined;
    const keep = async () => {
      if (held) return;
      await keepNextStatePassphrase(deps.paths, next);
      held = true;
    };
    // No state rewritten yet, by this run or an earlier one: `--undo` can still step back.
    const untouched = (i: number) => i === 0 && pending.length === roots.length;
    for (const [i, { root: each, name }] of pending.entries()) {
      const setup: ProjectEngine = {
        engine,
        env: await each.env(tofuEncryptionEnv(next, { name, previous: current })),
      };
      const label = `state-passphrase-${each.label}`;
      const saved = await planRotation(deps, plan, {
        ...setup,
        root: { dir: each.dir, statePath: each.statePath },
        label,
        ...(options.approveHashes !== undefined ? { approveHashes: options.approveHashes } : {}),
        allowed: () => false,
        again,
      });
      if (!deps.interactive) await keep();
      // What a refusal says stays as it was: nothing (default) before the new passphrase is kept.
      let refusal: Pick<RotationText, "unchanged" | "undo"> = {};
      if (!untouched(i)) {
        refusal = {
          unchanged:
            "The states rewritten so far are encrypted with the new passphrase, which stays on this computer beside the current one until every state is.",
        };
      } else if (held) {
        refusal = {
          unchanged:
            "No state was changed. The new passphrase waits on this computer beside the current one, and until the rotation finishes or is undone, the commands that read the states stop.",
          undo: true,
        };
      }
      const count = pending.length === 1 ? "" : ` (${i + 1} of ${pending.length})`;
      await approveRotationPlan(deps, plan, saved, {
        title: `Rewrite ${each.noun} of ${environment} under a new passphrase${count}`,
        intro: [
          `A new state passphrase made on this computer replaces the current one of ${environment} (${file}); neither is ever shown. It encrypts ${states}, each rewritten by its own plan, approved by its own hash.`,
          `OpenTofu reads ${each.noun} (${toPosixRelative(root, each.statePath)}) with the current passphrase and writes it with the new one in this apply. The plan changes nothing in the cloud.`,
        ],
        after: [
          `Once every state opens with the new passphrase alone, it replaces the current one in ${file}; ${record} records the rotation and the recovery copy, which holds the states and the passphrase, is refreshed.`,
          `If a step fails, both passphrases stay on this computer and \`${again}\` goes on from there.`,
        ],
        noun: `plan rewriting ${each.noun} under a new passphrase`,
        ...refusal,
        again,
      });
      await keep();
      await applyRotationPlan(deps, setup, saved, {
        what: "rotate state-passphrase",
        label,
        again,
      });
      hash = saved.planHash;
    }
    for (const each of roots) {
      const name = await stateName(each.statePath);
      if (name === undefined || !(await opensState(deps, engine, each.statePath, next, name))) {
        throw new OpsCrewError(
          "ENGINE_FAILED",
          `${upperFirst(each.noun)} (${toPosixRelative(root, each.statePath)}) does not open with the new passphrase alone, so OpsCrew kept both passphrases on this computer (${file} and ${nextStatePassphraseFile(deps.paths).file}).`,
          { hint: `Run \`${again}\` again; it plans with both and finishes.` },
        );
      }
    }
  }
  await adoptNextStatePassphrase(deps.paths, next);
  await recordRotation(deps, ["state-passphrase"]);
  deps.reporter.success(
    roots.length === 0
      ? `Replaced the state passphrase of ${environment} in ${file}: no infrastructure state was encrypted with it yet.`
      : `Rotated the state passphrase of ${environment}: every state is encrypted with the new one, kept in ${file}, and the old one no longer opens them.`,
  );
  return { ...(hash !== undefined ? { hash } : {}), copy: await refreshRecoveryCopy(deps, plan) };
}

/**
 * Once a deploy-key rotation's new key proved itself (`rotateSshKey`): the deploy key's objects at
 * the provider (`hcloud_ssh_key.deploy`, `digitalocean_ssh_key.deploy`, which only a server
 * created from then on gets) replaced with the new public half `publicKey`, in a plan of their own
 * approved by its hash with the app's name typed (in a script, an earlier run's saved plan that
 * `input.approveHashes` names), so the next provision plans no replacement; the
 * servers keep their keys (`ssh_keys` is in `ignore_changes`). Nothing else may change. Then it
 * says to run `opscrew provision`, which writes the new key into the committed
 * `terraform.tfvars.json` (other plans would put the old one back until then). Returns the
 * plan's hash; `undefined` when the environment has no server OpsCrew created, when its state is
 * not on this computer (the next provision there replaces them), or when the objects already hold
 * the new key.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the plan changes anything else,
 * `APPROVAL_REFUSED`, `ENGINE_FAILED`.
 */
export async function replaceDeployKeyObject(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: RotationEngineOptions & {
    publicKey: string;
    /** The rotation's command, named in hints. */
    again: string;
  },
): Promise<string | undefined> {
  const cloud = plan.target.provider === "hetzner" || plan.target.provider === "digitalocean";
  const extra = (plan.servers ?? []).some(
    (server) => server.target.provider === "hetzner" || server.target.provider === "digitalocean",
  );
  if ((!cloud && !extra) || !(await hasState(deps.paths))) return undefined;
  const { again } = input;
  const setup = await rotationEngine(deps, plan, input, again);
  const saved = await planRotation(deps, plan, {
    ...setup,
    vars: { deploy_ssh_public_key: input.publicKey.trim() },
    allowed: (change) => DEPLOY_KEY_TYPES.has(change.type) && change.action === "replace",
    label: "deploy-key",
    ...(input.approveHashes !== undefined ? { approveHashes: input.approveHashes } : {}),
    again,
  });
  if (saved.changes.length === 0) {
    await discardSaved(saved.planFile);
    return undefined;
  }
  await approveRotationPlan(deps, plan, saved, {
    title: `Replace the deploy key's copy at the provider for ${deps.paths.environment}`,
    intro: [
      "The provider keeps a copy of the deploy key's public half, which only servers created from now on get. This plan replaces it with the new key's, so the next provision plans no replacement.",
      "The servers keep their keys: OpsCrew already gave them the new one.",
    ],
    after: [],
    noun: "infrastructure plan of the deploy key's copy at the provider",
    again,
  });
  await applyRotationPlan(deps, setup, saved, {
    what: "replace the deploy key's object",
    label: "deploy-key",
    again,
  });
  const { root, environment, app } = deps.paths;
  deps.reporter.success(
    `Replaced the deploy key's copy at the provider. Run \`opscrew provision${await commandFlags(root, environment, app)}\` next: it writes the new key into the committed terraform.tfvars.json, and until then OpsCrew's other infrastructure plans of ${environment} would put the old one back, so they stop.`,
  );
  return saved.planHash;
}
