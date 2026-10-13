import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { renderDeployment } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultTcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import {
  addressFromOutputs,
  committableUrl,
  describeDiff,
  diffRenderedFiles,
  ensureDeployKey,
  ensureStatePassphrase,
  hasDeployment,
  hidesServerAddress,
  pinHostKey,
  providerConsole,
  recordServerAddress,
  SshRemoteExec,
  serverAddress,
  waitForCloudInit,
  waitForPort,
  writeRenderedFiles,
} from "../shared";
import { checkProvider, setupCloudflare, setupGitHub } from "./credentials";
import { requireNoMoveInProgress } from "./guard";
import { planAndApply } from "./plan-apply";
import { chooseDeployBranch, localDeployBranch, publishDeploySetup } from "./publish";
import { deploymentRenderContext, readRequirements } from "./render";
import {
  buildAppEnvironment,
  deploySecrets,
  deploySecretsStoredFor,
  setDeploySecrets,
} from "./secrets";
import type { ProvisionOptions, ProvisionResult } from "./types";

const SSH_WAIT_MS = 5 * 60_000;
const CLOUD_INIT_WAIT_MS = 8 * 60_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * After a failed apply: the apply may have replaced the server before it stopped, so the address
 * in `.opscrew/server.json` is refreshed from the state's outputs. Best effort: when they cannot be
 * read (or name no server) the record stays as it was, and the apply's own error is what the user
 * sees either way.
 */
async function refreshServerAddress(
  deps: PhaseDeps,
  engine: IacEngine,
  dir: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  try {
    const address = addressFromOutputs(await engine.output(dir, { env }));
    if (address !== undefined) await recordServerAddress(deps.paths, address);
  } catch {
    // Keep the record; the failed apply is reported.
  }
}

function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function requireDockerfile(deps: PhaseDeps, git: GitClient, plan: DeployPlan) {
  const dockerfile = join(plan.app.buildContext, plan.app.dockerfile).replace(/\\/g, "/");
  const tracked = await deps.runner.run("git", [
    "-C",
    deps.paths.root,
    "ls-files",
    "--",
    dockerfile,
  ]);
  if (!(await exists(join(deps.paths.root, dockerfile))) || tracked.stdout.trim() === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${dockerfile} is not committed on ${await git.currentBranch()}, so GitHub Actions has nothing to build.`,
      {
        hint: "Run `opscrew adapt`, merge its pull request, check out the updated branch, then run `opscrew provision` again.",
      },
    );
  }
}

/** Quotes a path for a copy-pasteable shell command. */
function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/** Extra inputs a phase passes to the shared flow. */
export interface PhaseFlowExtras {
  /** Plain-English warnings added to the infrastructure (`iac-apply`) approval details. */
  approvalNotes?: readonly string[];
  /**
   * The plan to deploy when the phase changed it in memory (`opscrew dns`); it is written to
   * `opscrew/plan.yaml` by {@link PhaseFlowExtras.ready}, after the branch checks passed.
   */
  plan?: DeployPlan;
  /**
   * Runs once the preconditions and branch checks passed, before anything is written or applied
   * (`opscrew dns` saves its plan change here, so a stop leaves the repository as it was).
   */
  ready?: () => Promise<void>;
  /**
   * Whether the server's address was public before this run (the deployment was served without
   * Cloudflare's proxy). Default: judged from the committed `terraform.tfvars.json`.
   */
  addressWasPublic?: boolean;
}

/**
 * Said once when a running deployment that was served without Cloudflare's proxy goes behind it:
 * the proxy hides the address from now on, but it may already be known.
 */
export const ADDRESS_MAY_BE_PUBLIC_NOTE =
  "The server's address may already be public: the app was served without Cloudflare's proxy, so earlier DNS records, the runbook or reports in the git history can show it. The proxy hides it from now on, but only a new server gets a fresh, private address (for example `opscrew retarget` to another provider, or `opscrew destroy` and `opscrew provision` again).";

/**
 * True when the committed `terraform.tfvars.json` (the files of the last run) has the domain
 * without Cloudflare's proxy, or no domain (served on the server's address); `false` when the file
 * is missing or unreadable (nothing is known).
 */
async function tfvarsShowPublicAddress(root: string, plan: DeployPlan): Promise<boolean> {
  try {
    const text = await readFile(join(root, plan.infra.dir, "terraform.tfvars.json"), "utf8");
    const values = JSON.parse(text) as unknown;
    return (
      typeof values === "object" &&
      values !== null &&
      !("proxied" in values && values.proxied === true)
    );
  } catch {
    return false;
  }
}

/**
 * Provision and DNS share this flow: credentials → engine, deploy key and state encryption →
 * render (approved write) → plan, policies, approval, apply → record the deployment → wait for the
 * server and pin its host key → deploy secrets → commit, push and pull request.
 */
async function provisionFlow(
  deps: PhaseDeps,
  options: ProvisionOptions,
  phase: Extract<PhaseName, "provision" | "dns">,
  extras: PhaseFlowExtras,
): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const root = deps.paths.root;
  let plan = extras.plan ?? (await readArtifact("plan", deps.paths.files.plan));
  const requirements = await readRequirements(deps);

  // 1–2. Preconditions and credentials
  const git = new GitClient({
    cwd: root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  if (!(await git.isRepo())) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project is not a git repository.", {
      hint: "Run OpsCrew from a clone of your GitHub repository.",
    });
  }
  await requireDockerfile(deps, git, plan);
  const profile = providerProfile(planProvider(plan));
  deps.reporter.step(`Checking your ${profile.displayName}, Cloudflare and GitHub access`);
  await checkProvider(deps, profile.id, services);
  const cloudflare = await setupCloudflare(deps, plan, services);
  const github = await setupGitHub(deps, git, services);
  // The branch for the deployment files, picked (and checked to start from the latest
  // `plan.cicd.branch`) before anything changes; `--plan-only` commits nothing.
  const commits = !(options.planOnly && options.approvePlanHash === undefined);
  const deployBranch = !commits
    ? undefined
    : options.push !== false
      ? await chooseDeployBranch(deps, git, github, plan, phase)
      : { branch: await localDeployBranch(git, plan, phase) };
  await extras.ready?.();
  const addressWasPublic = extras.addressWasPublic ?? (await tfvarsShowPublicAddress(root, plan));
  if (addressWasPublic && hasDeployment(plan) && hidesServerAddress(plan)) {
    deps.reporter.warn(ADDRESS_MAY_BE_PUBLIC_NOTE);
  }
  const zoneLearned = cloudflare !== undefined && plan.dns.zone !== cloudflare.zoneName;
  if (cloudflare && zoneLearned) {
    plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
  }

  // 3. Engine, deploy key, state encryption
  const preference = options.engine ?? plan.infra.engine;
  const engine = services.engine
    ? await services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  deps.reporter.info(`Using ${engineLabel(engine.info.name)} ${engine.info.version}.`);
  const deployKey = await ensureDeployKey(deps.paths);
  deps.redactor.addLiteral(deployKey.privateKeyOpenSsh, "deploy-key");
  if (deployKey.created) deps.reporter.info("Created a dedicated SSH deploy key for this project.");
  const engineEnv: Record<string, string | undefined> = { ...deps.env };
  if (plan.infra.stateEncryption) {
    if (engine.info.name === "tofu") {
      const passphrase = await ensureStatePassphrase(deps.paths);
      deps.redactor.addLiteral(passphrase, "state-passphrase");
      engineEnv.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
    } else {
      deps.reporter.warn(
        "Terraform cannot encrypt its state; .opscrew/tfstate stays unencrypted on this computer. Keep it private (it is git-ignored).",
      );
    }
  }

  // 4. Render (skipped when applying a saved plan: its files were written by the --plan-only run)
  const knownServer = hidesServerAddress(plan)
    ? undefined
    : await serverAddress(deps, plan, { engine: async () => engine, engineEnv });
  const ctx = deploymentRenderContext(deps, {
    plan,
    requirements,
    github,
    deployPublicKey: deployKey.publicKeyOpenSsh,
    cloudflare,
    server: knownServer,
  });
  const files = renderDeployment(plan, ctx);
  if (options.approvePlanHash === undefined) {
    const diff = await diffRenderedFiles(root, files);
    const toWrite = [...diff.created, ...diff.changed];
    if (toWrite.length > 0) {
      const approval = await deps.approvals.request({
        kind: "repo-write",
        title: `Write the deployment files to the repository (${describeDiff(diff)})`,
        details: [
          ...diff.created.map((f) => `  new      ${f.path}`),
          ...diff.changed.map((f) => `  changed  ${f.path}`),
        ].join("\n"),
      });
      if (!approval.approved) {
        throw new OpsCrewError("APPROVAL_REFUSED", "Nothing was written and nothing was created.");
      }
      await writeRenderedFiles(root, toWrite);
      deps.reporter.success(`Wrote ${describeDiff(diff)}.`);
    }
  }

  // 5. Plan → policies → approval → apply
  const dir = join(root, plan.infra.dir);
  let applied: Awaited<ReturnType<typeof planAndApply>>;
  try {
    applied = await planAndApply(deps, {
      engine,
      dir,
      env: engineEnv,
      deployPlan: plan,
      files,
      command: `opscrew ${phase}`,
      phase,
      ...(extras.approvalNotes ? { approvalNotes: extras.approvalNotes } : {}),
      ...(options.approvePlanHash !== undefined
        ? { approvePlanHash: options.approvePlanHash }
        : {}),
      ...(options.planOnly ? { planOnly: true } : {}),
    });
  } catch (error) {
    if (isUserFacingError(error) && error.code === "ENGINE_FAILED") {
      await refreshServerAddress(deps, engine, dir, engineEnv);
    }
    throw error;
  }
  if (options.planOnly && options.approvePlanHash === undefined) {
    if (zoneLearned) await writeArtifact("plan", deps.paths.files.plan, plan);
    return {
      ...(applied.planHash ? { planHash: applied.planHash } : {}),
      applied: false,
      outputs: {},
    };
  }

  // 6. Record the deployment: the server's address in the local state (never in the repository),
  // the apply and the domain URL in the plan.
  const now = deps.clock.now().toISOString();
  const address =
    addressFromOutputs(applied.outputs) ??
    (await serverAddress(deps, plan, { engine: async () => engine, engineEnv }));
  if (address === undefined) {
    throw new OpsCrewError("ENGINE_FAILED", "The server's address is unknown after the apply.", {
      hint: "Run `opscrew provision` again; it reads the address from the infrastructure state.",
    });
  }
  await recordServerAddress(deps.paths, address);
  const ipv4 = address.ipv4;
  // Without a domain the output is `http://<server IP>`, which is not committed.
  const outputUrl = stringOutput(applied.outputs, "url");
  const url = outputUrl === undefined ? plan.deployment.url : committableUrl(outputUrl);
  // A new deployment after `opscrew destroy` is no longer destroyed.
  const { destroyedAt: _destroyedAt, url: _url, ...previousDeployment } = plan.deployment;
  plan = {
    ...plan,
    updatedAt: now,
    approvals: applied.approval
      ? [
          ...plan.approvals,
          {
            planHash: applied.approval.planHash ?? (applied.planHash as string),
            approver: applied.approval.approver,
            at: applied.approval.decidedAt,
            kind: "iac-apply",
          },
        ]
      : plan.approvals,
    deployment: {
      ...previousDeployment,
      ...(url ? { url } : {}),
      ...(applied.planHash && applied.applied ? { lastPlanHash: applied.planHash } : {}),
      ...(applied.applied ? { lastApplyAt: now } : {}),
    },
  };
  await writeArtifact("plan", deps.paths.files.plan, plan);

  // 7. Wait for the server and pin its SSH host key
  const sleep = services.sleep;
  const clockMs = services.now;
  const waits = { ...(sleep ? { sleep } : {}), ...(clockMs ? { now: clockMs } : {}) };
  deps.reporter.step(`Waiting for the server at ${ipv4} to accept SSH`);
  const sshOpen = await waitForPort(ipv4, 22, {
    timeoutMs: SSH_WAIT_MS,
    intervalMs: 5_000,
    connect: services.tcpConnect ?? defaultTcpConnect,
    ...waits,
  });
  if (!sshOpen) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `The server at ${ipv4} did not open SSH within 5 minutes.`,
      {
        hint: `Check the ${profile.serverNoun} in the ${providerConsole(profile)}, then run \`opscrew ${phase}\` again; it continues where it stopped.`,
      },
    );
  }
  const pinned = await pinHostKey({
    host: ipv4,
    console: providerConsole(profile),
    knownHostsFile: deps.paths.files.knownHosts,
    runner: deps.runner,
    confirmChangedKey: async ({ host, previous, current }) => {
      const decision = await deps.approvals.request({
        kind: "remote-exec",
        title: `Trust the new SSH host key of ${host}`,
        details: [
          "The server's SSH host key is different from the one OpsCrew pinned earlier.",
          "Only accept this if you rebuilt or replaced the server yourself.",
          "Pinned:",
          ...previous.map((line) => `  ${line}`),
          "Now:",
          ...current.map((line) => `  ${line}`),
        ].join("\n"),
      });
      return decision.approved;
    },
  });
  const remote =
    services.remote?.(ipv4) ??
    new SshRemoteExec({
      host: ipv4,
      keyFile: deployKey.privateKeyFile,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    });
  deps.reporter.step("Waiting for the server to finish its first-boot setup (up to 8 minutes)");
  const ready = await waitForCloudInit(remote, {
    timeoutMs: CLOUD_INIT_WAIT_MS,
    intervalMs: 10_000,
    ...waits,
  });
  if (!ready) {
    const check = `ssh -i ${quotePath(deployKey.privateKeyFile)} -o UserKnownHostsFile=${quotePath(deps.paths.files.knownHosts)} deploy@${ipv4} cloud-init status --long`;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      "The server did not finish its first-boot setup within 8 minutes.",
      {
        hint: `Check what it is still doing (or what failed) with \`${check}\`, then run \`opscrew ${phase}\` again; it continues where it stopped.`,
      },
    );
  }
  deps.reporter.success(`The server at ${ipv4} is ready.`);

  // 8–9. Production environment and GitHub Actions secrets
  let secretsStored = false;
  if (options.secrets !== false) {
    const environment = await buildAppEnvironment(deps, plan, services);
    await setDeploySecrets(
      deps,
      github,
      deploySecrets({
        host: ipv4,
        privateKey: deployKey.privateKeyOpenSsh,
        knownHosts: pinned.knownHostsLines,
        environment,
      }),
      environment.names,
      phase,
    );
    secretsStored = true;
  } else {
    secretsStored = await deploySecretsStoredFor(deps, {
      host: ipv4,
      owner: github.owner,
      repo: github.repo,
    });
    if (!secretsStored) {
      deps.reporter.warn(
        "The deploy secrets are not stored in GitHub Actions for this server yet, so a deploy would fail. Before merging the pull request, run `opscrew provision` in a terminal in the project directory to store them.",
      );
    }
  }

  // 10. Commit, push and open the pull request
  plan = { ...plan, deployment: { ...plan.deployment, lastCompletedPhase: "provision" } };
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const published = await publishDeploySetup(deps, {
    git,
    github,
    plan,
    paths: [...files.map((f) => f.path), toPosixRelative(root, deps.paths.files.plan)],
    push: options.push !== false,
    secretsStored,
    phase,
    ...(deployBranch === undefined ? {} : { branch: deployBranch }),
  });
  if (secretsStored) {
    deps.reporter.info(
      published.prUrl
        ? `Merging ${published.prUrl} deploys the app.`
        : `Merging ${published.branch} into ${plan.cicd.branch} deploys the app.`,
    );
  }
  return {
    ...(applied.planHash ? { planHash: applied.planHash } : {}),
    applied: applied.applied,
    outputs: applied.outputs,
    branch: published.branch,
    ...(published.prUrl ? { prUrl: published.prUrl } : {}),
  };
}

/** Runs the shared flow and records the phase outcome (`ok`, or `failed` with the reason). */
export async function runPhaseFlow(
  deps: PhaseDeps,
  phase: Extract<PhaseName, "provision" | "dns">,
  options: ProvisionOptions,
  extras: PhaseFlowExtras = {},
): Promise<ProvisionResult> {
  try {
    const result = await provisionFlow(deps, options, phase, extras);
    if (!(options.planOnly && options.approvePlanHash === undefined)) {
      await deps.state.markPhase(
        phase,
        "ok",
        result.prUrl ? `deployment files in ${result.prUrl}` : `applied: ${result.applied}`,
      );
    }
    return result;
  } catch (error) {
    const reason = isUserFacingError(error) ? error.message : "unexpected error";
    await deps.state
      .markPhase(phase, "failed", deps.redactor.redact(reason))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * `opscrew provision`: creates the hardened server on the plan's provider (Hetzner Cloud or
 * DigitalOcean, and Cloudflare DNS when planned) through
 * plan → policies → approval → apply, waits for it, stores the deploy secrets in GitHub Actions and
 * opens a pull request with the generated files. Safe to re-run: it plans only what is missing and
 * reuses the deploy key, state passphrase, pinned host key and generated passwords. Stops with
 * `PHASE_PRECONDITION` before doing anything while `opscrew retarget` is moving the deployment.
 */
export async function runProvision(
  deps: PhaseDeps,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  // An unreadable plan is reported by the flow itself (and recorded as a failed phase).
  const plan = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
  if (plan !== undefined) requireNoMoveInProgress(plan);
  return runPhaseFlow(deps, "provision", options);
}
