/**
 * `opscrew rotate deploy-key | check-key | preview-key` (plan.md 5., FR-2506): a new Ed25519 pair
 * made on this computer replaces the SSH key add-first: its public half added on every server the
 * key opens beside the old one, GitHub's secret replaced, the new key proven (a dispatched deploy,
 * the scheduled check, the preview server's check), and only then the old half removed. One plan
 * approved by its hash (`remote-exec`, as 024's restore); a failure before the removal leaves both
 * keys working, and running the command again goes on from where it stopped.
 */
import { posix } from "node:path";
import type { GitHubClient } from "@opscrew/connector-github";
import { keyFingerprint } from "@opscrew/connector-ssh-host";
import { canonicalJson, isUserFacingError, listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  CHECK_SECRETS,
  CHECK_WORKFLOW_FILE,
  DEPLOY_SECRETS,
  deploySecretName,
  deploySecretNamesFor,
  usesTunnel,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import {
  applyExtraOwnHostPlan,
  applyOwnHostPlan,
  prepareExtraOwnServer,
  prepareOwnServer,
} from "../provision/own";
import { secretsEnvironment } from "../provision/secrets";
import type { ProvisionServices } from "../provision/types";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { PlanRefusedError } from "../shared/approvals";
import { dispatchAndFollow } from "../shared/deploy-run";
import { type EngineFactory, infrastructureOutputs } from "../shared/engine";
import { codeOf } from "../shared/errors";
import { replaceDeployKeyObject } from "./infra";
import {
  bareKey,
  forgetPrevious,
  type KeyHalves,
  keyStage,
  moveIntoPlace,
  type SshKeyName,
} from "./keys-files";
import {
  addKeyScript,
  holderShell,
  type KeyHolder,
  type KeyRemote,
  keyHolders,
  keyLine,
  removeKeyScript,
  runKeyScript,
} from "./keys-servers";
import { assertValuesCurrent, recordRotation } from "./record";

export type { SshKeyName } from "./keys-files";

/** The repository whose secret holds the key and whose workflows prove it. */
export interface SshKeyGitHub {
  api: Pick<
    GitHubClient,
    "setActionsSecret" | "setEnvironmentSecret" | "dispatchWorkflow" | "waitForWorkflowRun"
  >;
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** The deploy keys a server the user owns gets through its setup host plan. */
export interface OwnHostPlanInput {
  /** The server's name in the plan: `app` or an extra server's. */
  server: string;
  /** The deploy key the plan authorizes: the new one. */
  deployKey: string;
  /** The old one, kept beside it (`planHost`'s `previousDeployKey`) until the new one proved itself. */
  previousDeployKey?: string;
}

/** What a key's rotation reaches besides this computer's files. */
export interface SshKeyServices {
  github: SshKeyGitHub;
  /**
   * Applies the setup host plan of the user's own server `input.server` (ADR 0011: shown,
   * approved by its own hash, applied) with exactly these deploy keys of the app (default:
   * {@link ownHostPlans}).
   */
  ownHostPlan?(input: OwnHostPlanInput): Promise<void>;
  /** Tests: the own servers' connection and host adapter for the default `ownHostPlan`. */
  provision?: ProvisionServices;
  /** Tests: the deploy user's shell at a host with a private key file (default ssh). */
  remote?: KeyRemote;
  /** Tests: the IaC engine that replaces the deploy key's copy at the provider. */
  engine?: EngineFactory;
}

/**
 * The setup host plan of a server of `plan` the user owns, with the deploy keys of a rotation
 * (`command` names it in stops and refusals): connected and inspected as provision does it (the
 * deploy key in place logs in), then planned with the tunnel's outputs from the state when the
 * plan uses a tunnel, shown, approved by its hash and applied (`host-apply`).
 */
export function ownHostPlans(
  deps: PhaseDeps,
  plan: DeployPlan,
  command: string,
  services: Pick<SshKeyServices, "provision" | "engine">,
): (input: OwnHostPlanInput) => Promise<void> {
  const provision = services.provision ?? {};
  const base = { plan, services: provision, phase: "provision" as const, command };
  return async ({ server, deployKey, previousDeployKey }) => {
    const keys = {
      deployPublicKey: deployKey,
      ...(previousDeployKey === undefined ? {} : { previousDeployKey }),
    };
    const deployKeyFile = deps.paths.files.deployKey;
    if (server !== APP_SERVER) {
      const run = await prepareExtraOwnServer(deps, {
        ...base,
        name: server,
        deployPublicKey: deployKey,
        deployKeyFile,
      });
      await applyExtraOwnHostPlan(deps, run, { ...base, ...keys });
      return;
    }
    const run = await prepareOwnServer(deps, {
      ...base,
      options: {},
      deployPublicKey: deployKey,
      deployKeyFile,
    });
    const engine = services.engine ?? provision.engine;
    const outputs = usesTunnel(plan)
      ? ((await infrastructureOutputs(deps, plan, engine === undefined ? {} : { engine })) ?? {})
      : {};
    await applyOwnHostPlan(deps, run, { ...base, outputs, ...keys });
  };
}

/** A finished rotation. */
export interface SshKeyRotation {
  /** The hash the rotation's last plan was approved by. */
  hash: string;
  /** The recovery copy, refreshed with the new key: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

const NAMES: Record<SshKeyName, string> = {
  "deploy-key": "deploy key",
  "check-key": "scheduled check's key",
  "preview-key": "preview key",
};

/** Where GitHub holds the key's private half. */
interface SecretPlace {
  name: string;
  environment?: string;
}

function secretPlace(plan: DeployPlan, which: SshKeyName): SecretPlace {
  if (which === "check-key") return { name: CHECK_SECRETS.sshKey };
  const environment = secretsEnvironment(plan);
  return {
    name: deploySecretName(plan, DEPLOY_SECRETS.sshKey),
    ...(environment === undefined ? {} : { environment }),
  };
}

/** `GitHub's secret X of owner/repo`, with its GitHub environment when it has one. */
function secretText(place: SecretPlace, repository: string): string {
  const where =
    place.environment === undefined ? "" : ` (in the GitHub environment ${place.environment})`;
  return `GitHub's secret ${place.name}${where} of ${repository}`;
}

/**
 * True when GitHub holds no copy of the deploy key: the deploy workflow does not read it (it runs
 * on the server itself and reaches no other server), so the key is only this computer's.
 */
function onlyHere(plan: DeployPlan, which: SshKeyName): boolean {
  return which === "deploy-key" && !deploySecretNamesFor(plan).includes(DEPLOY_SECRETS.sshKey);
}

/** Refuses, before anything is made, a key the environment does not have. */
function requireKey(deps: PhaseDeps, plan: DeployPlan, which: SshKeyName, again: string): void {
  const preview = plan.environment?.previews !== undefined;
  const refuse = (message: string, hint: string) =>
    new OpsCrewError("INVALID_INPUT", `${message} Nothing was changed.`, { hint });
  if (
    which === "check-key" &&
    (deps.paths.app !== undefined || deps.paths.environment !== "prod")
  ) {
    throw refuse(
      "The scheduled check's key is the repository's one key, kept with the first app's prod environment.",
      "Run `opscrew rotate check-key` without --app and --env.",
    );
  }
  if (which === "preview-key" && !preview) {
    throw refuse(
      `The ${deps.paths.environment} environment has no previews, so it has no preview key.`,
      "Name the preview environment with --env (`opscrew env list` shows it).",
    );
  }
  if (which === "deploy-key" && preview) {
    throw refuse(
      `GitHub holds the preview key in the preview environment ${deps.paths.environment}, not its deploy key, so no deploy can prove a new one.`,
      `Rotate the key GitHub holds there with \`${again.replace("deploy-key", "preview-key")}\`.`,
    );
  }
}

/** What the rotation does now, in the parts its hash binds. */
interface KeyPlan {
  which: SshKeyName;
  /** Which steps are left, for the text only: the hash is the same in both stages. */
  stage: "add" | "remove";
  newKey: string;
  oldKey: string;
  holders: readonly KeyHolder[];
  /** Absent when GitHub holds no copy ({@link onlyHere}). */
  secret: SecretPlace | undefined;
  /** `owner/repo`. */
  repository: string;
}

function planHash(deps: PhaseDeps, plan: DeployPlan, keyPlan: KeyPlan): string {
  return sha256Hex(
    canonicalJson({
      credential: keyPlan.which,
      environment: deps.paths.environment,
      app: plan.app.name,
      repository: keyPlan.repository,
      key: keyFingerprint(keyPlan.newKey),
      old: keyFingerprint(keyPlan.oldKey),
      servers: keyPlan.holders.map((holder) => ({
        environment: holder.deps.paths.environment,
        app: holder.plan.app.name,
        server: holder.server,
        via: holder.via,
      })),
      secret: keyPlan.secret ?? null,
    }),
  );
}

/** How the new key proves itself, in the plan's words. */
function proofText(plan: DeployPlan, which: SshKeyName): string {
  switch (which) {
    case "deploy-key":
      if (onlyHere(plan, which)) {
        return "This computer logs in to the server over SSH with the new key: the deploy runs on the server itself, so no deploy uses it.";
      }
      return `A deploy of ${plan.cicd.branch} is started and followed to its end: it reaches every server with the new key.`;
    case "check-key":
      return "Each server answers the check's fixed command over SSH with the new key, and a run of the scheduled check is started and followed to its end.";
    case "preview-key":
      return "The preview server answers its check (`list`) over SSH with the new key.";
  }
}

/** Where the new public half goes, in words. */
function serversText(holders: readonly KeyHolder[]): string {
  const ssh = holders.filter((holder) => holder.via === "ssh").map((holder) => holder.words);
  const own = holders.filter((holder) => holder.via === "host-plan").map((holder) => holder.words);
  return [
    ...(ssh.length > 0 ? [`${listText(ssh)} over SSH, in the deploy user's authorized_keys`] : []),
    ...(own.length > 0
      ? [
          `${listText(own)} through ${own.length === 1 ? "its" : "their"} host plan, approved by its own hash`,
        ]
      : []),
  ].join("; ");
}

/**
 * Asks the rotation's approval, bound to its hash (`remote-exec`; `--approve <hash>` in a script).
 * @throws PlanRefusedError when it is not given.
 */
async function approve(
  deps: PhaseDeps,
  plan: DeployPlan,
  keyPlan: KeyPlan,
  again: string,
): Promise<string> {
  const { which, holders, secret, repository } = keyPlan;
  const name = NAMES[which];
  const hash = planHash(deps, plan, keyPlan);
  const newKey = keyFingerprint(keyPlan.newKey);
  const oldKey = keyFingerprint(keyPlan.oldKey);
  const lines =
    keyPlan.stage === "add"
      ? [
          `A new Ed25519 key made on this computer (${newKey}) replaces the ${name} (${oldKey}) of ${deps.paths.environment}.`,
          `1. Its public half is added beside the old one, which keeps working: ${serversText(holders)}.`,
          secret === undefined
            ? "2. GitHub holds no copy of it: the deploy runs on the server itself."
            : `2. ${secretText(secret, repository)} is replaced with its private half, encrypted on this computer before upload and never shown.`,
          `3. ${proofText(plan, which)}`,
          "4. Only once that passed is the old key removed from each server, and the new one takes its place on this computer.",
          `If a step fails before the old key goes, both keys keep working, and \`${again}\` goes on from where it stopped.`,
        ]
      : [
          `The new ${name} (${newKey}) of ${deps.paths.environment} is in place and proved itself.`,
          `The old one (${oldKey}) is removed from ${serversText(holders)}.`,
        ];
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Replace the ${name} of ${deps.paths.environment}`,
    details: [...lines, `Rotation hash: ${hash}`].join("\n"),
    planHash: hash,
  });
  if (approval.approved) return hash;
  throw new PlanRefusedError({
    plan: `rotation of the ${name}`,
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    unchanged: "Nothing on the servers or in GitHub was changed.",
    hint: `Run \`${again}\` again when you are ready (in a script: --approve ${hash}).`,
  });
}

/** `error` with what stays true before the removal: both keys work, and how to go on. */
function bothKeysWork(error: unknown, again: string): unknown {
  if (!isUserFacingError(error)) return error;
  const said = error.message.replace(/\s+$/, "");
  return new OpsCrewError(
    codeOf(error),
    `${said} The old key still works beside the new one: nothing removed it.`,
    {
      hint: `${error.hint ? `${error.hint} ` : ""}Then run \`${again}\` again to go on.`,
      cause: error,
    },
  );
}

/** Replaces GitHub's secret of the key with `privateKey` (audited by name only). */
async function replaceSecret(
  deps: PhaseDeps,
  github: SshKeyGitHub,
  place: SecretPlace,
  privateKey: string,
): Promise<void> {
  const { api, owner, repo } = github;
  if (place.environment === undefined) {
    await api.setActionsSecret(owner, repo, place.name, privateKey);
  } else {
    await api.setEnvironmentSecret(owner, repo, place.environment, place.name, privateKey);
  }
  await deps.audit.append({
    kind: "secret-set",
    actor: "opscrew",
    action: `set secret ${place.name}${place.environment === undefined ? "" : ` in the environment ${place.environment}`}`,
    target: `${owner}/${repo}`,
    decision: "approved",
  });
}

/** Audits a change of a server's keys, without its address. */
function auditChange(deps: PhaseDeps, holder: KeyHolder, action: string): Promise<void> {
  return deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action,
    target: `${holder.deps.paths.environment} server ${holder.server}`,
    decision: "approved",
  });
}

/** Starts the scheduled check's workflow on the default branch and follows its run to success. */
async function checkRun(deps: PhaseDeps, github: SshKeyGitHub, again: string): Promise<void> {
  const { api, owner, repo, defaultBranch } = github;
  const started = await api.dispatchWorkflow(
    owner,
    repo,
    CHECK_WORKFLOW_FILE,
    defaultBranch,
    {},
    () =>
      deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "dispatch workflow",
        target: `${owner}/${repo}`,
        detail: `${CHECK_WORKFLOW_FILE} on ${defaultBranch}: the proof of the new check key`,
      }),
  );
  deps.reporter.step(`Waiting for the scheduled check's run (${started.url})`);
  const run = await api.waitForWorkflowRun(owner, repo, {
    workflowFile: CHECK_WORKFLOW_FILE,
    ref: defaultBranch,
    runId: started.runId,
  });
  if (run.conclusion === "success") return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `The scheduled check's run did not succeed (${run.conclusion ?? "no result"}): ${run.htmlUrl}.`,
    {
      hint: `Open the run to see which step failed and fix what it says, then run \`${again}\` again.`,
    },
  );
}

/**
 * Proves the new key before anything removes the old one: a deploy dispatched and followed (a
 * login on each server when the deploy does not use the key, {@link onlyHere}), the check's fixed
 * command on each server and a check run, or the preview server's `list`, each over SSH with the
 * new key (`nextFile`).
 */
async function prove(
  deps: PhaseDeps,
  plan: DeployPlan,
  which: SshKeyName,
  input: {
    holders: readonly KeyHolder[];
    nextFile: string;
    services: SshKeyServices;
    hash: string;
    again: string;
  },
): Promise<void> {
  const { holders, nextFile, services, again } = input;
  if (which === "deploy-key" && !onlyHere(plan, which)) {
    const workflowFile = posix.basename(plan.cicd.workflowPath);
    const { branch } = plan.cicd;
    deps.reporter.step(`Starting ${workflowFile} on ${branch}, which deploys with the new key`);
    const run = await dispatchAndFollow(deps, services.github, {
      workflowFile,
      ref: branch,
      inputs: {},
      target: deps.paths.environment,
      command: again,
      detail: `${workflowFile} on ${branch}: the proof of the new deploy key (rotation ${input.hash})`,
    });
    if (run.status === "deployed") return;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${deps.paths.environment}'s deploy run waits in GitHub for a required reviewer (${run.runUrl}), so the new deploy key has not proved itself yet.`,
      { hint: "Approve the run in GitHub and let it finish." },
    );
  }
  for (const holder of holders) {
    const shell = await holderShell(holder, nextFile, services.remote);
    // A restricted key's line runs only its forced command, whatever is asked: the check's fixed
    // read, or the preview command, which reads the request. The deploy key logs in.
    const result = await shell.run(which === "preview-key" ? "list" : "true", {
      timeoutMs: 60_000,
    });
    const answered =
      result.exitCode === 0 &&
      (which !== "preview-key" || /^opscrew-preview: listed /m.test(result.stdout));
    if (!answered) {
      const what = {
        "deploy-key": "a login",
        "check-key": "the check's command",
        "preview-key": "the preview server's check",
      }[which];
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `${holder.words} did not answer ${what} over SSH with the new ${NAMES[which]} (exit code ${result.exitCode}).`,
        { hint: "Check that the server is on and reachable (`opscrew status`)." },
      );
    }
  }
  if (which === "check-key") await checkRun(deps, services.github, again);
}

/**
 * Replaces the SSH key `which` of `plan`'s environment (`deps.paths`; the check key's with the
 * first app's prod) add-first, after the two-computer guard: the plan of the steps shown and
 * approved by its hash; the new public half added on every server it opens (over SSH as deploy
 * with the current deploy key, or on the user's own server the deploy key through its host plan
 * with both keys); GitHub's secret replaced, when it holds one; the new key proven; the new pair
 * moved into place; the old half removed (over SSH, or the host plan with the new key only); for
 * the deploy key, its copy at the provider replaced in its own approved plan
 * (`replaceDeployKeyObject`); the rotation recorded
 * (`recordRotation`) and the recovery copy refreshed. Run again after a failure, it goes on with
 * the same new pair: before the removal both keys work, and nothing removes the old key unless
 * the new one proved itself. No key material reaches any output: private halves are registered
 * with the redactor and go only to GitHub's secret API and the key files (0600).
 * @throws OpsCrewError `INVALID_INPUT` for a key the environment does not have,
 * `PHASE_PRECONDITION` without a server or the key on this computer, `APPROVAL_REFUSED` when the
 * plan is not approved, and the failed step's error, saying how to go on.
 */
export async function rotateSshKey(
  deps: PhaseDeps,
  plan: DeployPlan,
  which: SshKeyName,
  services: SshKeyServices,
): Promise<SshKeyRotation> {
  const { root, environment, app } = deps.paths;
  const again = `opscrew rotate ${which}${await commandFlags(root, environment, app)}`;
  requireKey(deps, plan, which, again);
  const ownHostPlan = services.ownHostPlan ?? ownHostPlans(deps, plan, again, services);
  await assertValuesCurrent(deps);
  const holders = await keyHolders(deps, plan, which);
  if (holders.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `No server of ${environment} opens with the ${NAMES[which]}, so there is nothing to replace. Nothing was changed.`,
      {
        hint: "Run `opscrew provision` first, or rotate another credential (`opscrew rotate` lists them).",
      },
    );
  }
  const name = NAMES[which];
  const repository = `${services.github.owner}/${services.github.repo}`;
  const secret = onlyHere(plan, which) ? undefined : secretPlace(plan, which);
  let stage = await keyStage(deps.paths, which, deps.redactor);
  let hash: string;
  if (stage.stage === "add") {
    const { current, next, nextFile } = stage;
    hash = await approve(
      deps,
      plan,
      {
        which,
        stage: "add",
        newKey: next.publicKeyOpenSsh,
        oldKey: current.publicKeyOpenSsh,
        holders,
        secret,
        repository,
      },
      again,
    );
    try {
      await addEverywhere(deps, which, {
        holders,
        current,
        next,
        repository,
        services,
        ownHostPlan,
      });
      if (secret !== undefined) {
        await replaceSecret(deps, services.github, secret, next.privateKeyOpenSsh);
      }
      await prove(deps, plan, which, { holders, nextFile, services, hash, again });
    } catch (error) {
      throw bothKeysWork(error, again);
    }
    await moveIntoPlace(deps.paths, which, current.publicKeyOpenSsh);
    stage = { stage: "remove", current: next, previousPublicKey: current.publicKeyOpenSsh };
  } else {
    hash = await approve(
      deps,
      plan,
      {
        which,
        stage: "remove",
        newKey: stage.current.publicKeyOpenSsh,
        oldKey: stage.previousPublicKey,
        holders,
        secret,
        repository,
      },
      again,
    );
  }
  try {
    await removeEverywhere(deps, which, { holders, stage, repository, services, ownHostPlan });
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    throw new OpsCrewError(
      codeOf(error),
      `${error.message.replace(/\s+$/, "")} The new ${name} is in place and works; the old one may still open the servers OpsCrew did not reach.`,
      {
        hint: `${error.hint ? `${error.hint} ` : ""}Then run \`${again}\` again to remove it.`,
        cause: error,
      },
    );
  }
  if (which === "deploy-key") {
    // The new key proved itself: the provider's copy, which only new servers get, follows it.
    try {
      await replaceDeployKeyObject(deps, plan, {
        publicKey: stage.current.publicKeyOpenSsh,
        again,
        ...(services.engine !== undefined ? { services: { engine: services.engine } } : {}),
      });
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      throw new OpsCrewError(
        codeOf(error),
        `${error.message.replace(/\s+$/, "")} The new ${name} is in place on every server and the old one is gone; only the provider's copy for new servers still holds the old one.`,
        {
          hint: `${error.hint ? `${error.hint} ` : ""}Then run \`${again}\` again to replace it.`,
          cause: error,
        },
      );
    }
  }
  await recordRotation(deps, [which]);
  await forgetPrevious(deps.paths, which);
  deps.reporter.success(
    `Replaced the ${name} of ${environment}: the new one (${keyFingerprint(stage.current.publicKeyOpenSsh)}) proved itself, and the old one is gone from every server.`,
  );
  return { hash, copy: await refreshRecoveryCopy(deps, plan) };
}

/** Adds the new public half on every holder, beside the old one. */
async function addEverywhere(
  deps: PhaseDeps,
  which: SshKeyName,
  input: {
    holders: readonly KeyHolder[];
    current: KeyHalves;
    next: KeyHalves;
    repository: string;
    services: SshKeyServices;
    ownHostPlan: (input: OwnHostPlanInput) => Promise<void>;
  },
): Promise<void> {
  const { current, next, repository, services } = input;
  const name = NAMES[which];
  for (const holder of input.holders) {
    deps.reporter.step(`Adding the new ${name} to ${holder.words}`);
    if (holder.via === "host-plan") {
      await input.ownHostPlan({
        server: holder.server,
        deployKey: next.publicKeyOpenSsh,
        previousDeployKey: current.publicKeyOpenSsh,
      });
      continue;
    }
    const shell = await holderShell(holder, holder.deps.paths.files.deployKey, services.remote);
    const line = keyLine(which, next.publicKeyOpenSsh, repository, holder.plan);
    await runKeyScript(holder, shell, addKeyScript(line), `add the new ${name}`);
    await auditChange(deps, holder, `add the new ${name} to the deploy user's authorized_keys`);
  }
}

/** Removes the old public half from every holder, where the new one is. */
async function removeEverywhere(
  deps: PhaseDeps,
  which: SshKeyName,
  input: {
    holders: readonly KeyHolder[];
    stage: Extract<Awaited<ReturnType<typeof keyStage>>, { stage: "remove" }>;
    repository: string;
    services: SshKeyServices;
    ownHostPlan: (input: OwnHostPlanInput) => Promise<void>;
  },
): Promise<void> {
  const { stage, repository, services } = input;
  const name = NAMES[which];
  const fresh = stage.current.publicKeyOpenSsh;
  for (const holder of input.holders) {
    deps.reporter.step(`Removing the old ${name} from ${holder.words}`);
    if (holder.via === "host-plan") {
      await input.ownHostPlan({ server: holder.server, deployKey: fresh });
      continue;
    }
    // The deploy key itself connects with its new pair now, which is in place.
    const shell = await holderShell(holder, holder.deps.paths.files.deployKey, services.remote);
    const script = removeKeyScript(
      bareKey(stage.previousPublicKey),
      keyLine(which, fresh, repository, holder.plan),
    );
    await runKeyScript(holder, shell, script, `remove the old ${name}`);
    await auditChange(
      deps,
      holder,
      `remove the old ${name} from the deploy user's authorized_keys`,
    );
  }
}
