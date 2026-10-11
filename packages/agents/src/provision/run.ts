import { access } from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { renderDeployment } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { defaultTcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import {
  describeDiff,
  diffRenderedFiles,
  ensureDeployKey,
  ensureStatePassphrase,
  pinHostKey,
  SshRemoteExec,
  waitForCloudInit,
  waitForPort,
  writeRenderedFiles,
} from "../shared";
import { checkHetzner, setupCloudflare, setupGitHub } from "./credentials";
import { planAndApply } from "./plan-apply";
import { publishDeploySetup } from "./publish";
import { deploymentRenderContext, readRequirements } from "./render";
import { buildAppEnvironment, deploySecrets, setDeploySecrets } from "./secrets";
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

/**
 * Provision and DNS share this flow: credentials → engine, deploy key and state encryption →
 * render (approved write) → plan, policies, approval, apply → record the deployment → wait for the
 * server and pin its host key → deploy secrets → commit, push and pull request.
 */
async function provisionFlow(deps: PhaseDeps, options: ProvisionOptions): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const root = deps.paths.root;
  let plan = await readArtifact("plan", deps.paths.files.plan);
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
  deps.reporter.step("Checking your Hetzner, Cloudflare and GitHub access");
  await checkHetzner(deps, services);
  const cloudflare = await setupCloudflare(deps, plan, services);
  const github = await setupGitHub(deps, git, services);
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
  const ctx = deploymentRenderContext(deps, {
    plan,
    requirements,
    github,
    deployPublicKey: deployKey.publicKeyOpenSsh,
    cloudflare,
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
  const applied = await planAndApply(deps, {
    engine,
    dir: join(root, plan.infra.dir),
    env: engineEnv,
    deployPlan: plan,
    files,
    ...(options.approvePlanHash !== undefined ? { approvePlanHash: options.approvePlanHash } : {}),
    ...(options.planOnly ? { planOnly: true } : {}),
  });
  if (options.planOnly && options.approvePlanHash === undefined) {
    if (zoneLearned) await writeArtifact("plan", deps.paths.files.plan, plan);
    return {
      ...(applied.planHash ? { planHash: applied.planHash } : {}),
      applied: false,
      outputs: {},
    };
  }

  // 6. Record the deployment in the plan
  const now = deps.clock.now().toISOString();
  const ipv4 = stringOutput(applied.outputs, "server_ipv4") ?? plan.deployment.serverIpv4;
  const ipv6 = stringOutput(applied.outputs, "server_ipv6") ?? plan.deployment.serverIpv6;
  const url = stringOutput(applied.outputs, "url") ?? plan.deployment.url;
  if (!ipv4) {
    throw new OpsCrewError("ENGINE_FAILED", "The server's address is unknown after the apply.", {
      hint: "Run `opscrew provision` again; it reads the address from the infrastructure state.",
    });
  }
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
      ...plan.deployment,
      serverIpv4: ipv4,
      ...(ipv6 ? { serverIpv6: ipv6 } : {}),
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
        hint: "Check the server in the Hetzner console, then run `opscrew provision` again; it continues where it stopped.",
      },
    );
  }
  const pinned = await pinHostKey({
    host: ipv4,
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
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      "The server did not finish its first-boot setup within 8 minutes.",
      {
        hint: "Run `opscrew provision` again in a few minutes; it continues where it stopped.",
      },
    );
  }
  deps.reporter.success(`The server at ${ipv4} is ready.`);

  // 8–9. Production environment and GitHub Actions secrets
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
    );
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
  });
  deps.reporter.info(
    published.prUrl
      ? `Next: merge ${published.prUrl} to deploy, then run \`opscrew verify\`.`
      : "Next: push the branch and merge it to deploy, then run `opscrew verify`.",
  );
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
): Promise<ProvisionResult> {
  try {
    const result = await provisionFlow(deps, options);
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
 * `opscrew provision`: creates the hardened Hetzner server (and Cloudflare DNS when planned) through
 * plan → policies → approval → apply, waits for it, stores the deploy secrets in GitHub Actions and
 * opens a pull request with the generated files. Safe to re-run: it plans only what is missing and
 * reuses the deploy key, state passphrase, pinned host key and generated passwords.
 */
export function runProvision(
  deps: PhaseDeps,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  return runPhaseFlow(deps, "provision", options);
}
