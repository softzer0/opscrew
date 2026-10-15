import { access } from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import type { ApprovalRecord, IacEngine, PhaseName } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { portainerHostname, usesTunnel } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { defaultTcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { cloudflareAccessLoginMethods, oneTimePinIdentityProvider } from "../portainer/access";
import { cloudConnectorRemoval } from "../portainer/run";
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
  infrastructureOutputs,
  pinHostKey,
  providerConsole,
  recordOwnServer,
  recordServerAddress,
  type ServerAddress,
  SshRemoteExec,
  serverAddress,
  waitForCloudInit,
  waitForPort,
  writeRenderedFiles,
} from "../shared";
import { connectorFirst, deletesTunnel, type HostChangeResult } from "../shared/tunnel-connections";
import { type CloudflareSetup, checkProvider, setupCloudflare, setupGitHub } from "./credentials";
import { requireNoMoveInProgress } from "./guard";
import {
  applyOwnHostPlan,
  type OwnHostResult,
  type OwnServerRun,
  ownConnectorFirst,
  ownDeployTarget,
  ownEngineEnv,
  prepareOwnServer,
  removeOldAccessMode,
} from "./own";
import { findSavedPlan, planAndApply, REMOVAL_PLAN_SUFFIX } from "./plan-apply";
import { chooseDeployBranch, localDeployBranch, publishDeploySetup } from "./publish";
import {
  committedTfvars,
  deploymentFiles,
  deploymentRenderContext,
  type OwnRenderInput,
  readRequirements,
} from "./render";
import {
  buildAppEnvironment,
  deploySecrets,
  deploySecretsStoredFor,
  setDeploySecrets,
} from "./secrets";
import type { ProvisionOptions, ProvisionResult, ProvisionServices, SavedPlan } from "./types";
import { cloudflareZeroTrust, createZeroTrustOrganization } from "./zero-trust";

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

/** Sensitive root-module outputs (the tunnel and Access tokens): never returned or printed. */
const SENSITIVE_OUTPUTS = new Set([
  "tunnel_token",
  "deploy_service_token_client_id",
  "deploy_service_token_client_secret",
]);

/** The outputs without the sensitive ones, for the result (callers print or forward it). */
function publicOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).filter(([name]) => !SENSITIVE_OUTPUTS.has(name)),
  );
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
  const values = await committedTfvars(root, plan);
  return values !== undefined && !("proxied" in values && values.proxied === true);
}

/** The saved infrastructure plans the `--approve` hashes name. */
interface SavedInfrastructureHashes {
  /** The main plan to apply instead of planning again (never a removal plan). */
  apply?: string;
  /** A server the user owns: the saved removal plan of a switch between public and tunnel mode. */
  removal?: string;
}

/**
 * The saved infrastructure plans the `--approve` hashes name. Servers OpsCrew creates have one
 * plan, so the main plan is the first hash given. A server the user owns has more (infrastructure,
 * host and, during a switch between public and tunnel mode, the removal of the old setup): the
 * main plan is the hash whose saved plan exists, is not a removal and was not applied yet (a script
 * that names both hashes again after the infrastructure was applied plans afresh, which finds
 * nothing to change); a saved removal plan is kept apart and only ever applied as the removal; the
 * host plan's hash is granted by the approval handler.
 */
async function savedInfrastructureHashes(
  deps: PhaseDeps,
  options: ProvisionOptions,
  plan: DeployPlan,
): Promise<SavedInfrastructureHashes> {
  const hashes = [
    ...(options.approvePlanHash !== undefined ? [options.approvePlanHash] : []),
    ...(options.approvePlanHashes ?? []),
  ];
  if (plan.target.provider !== "own") return hashes[0] === undefined ? {} : { apply: hashes[0] };
  const applied = plan.deployment.lastPlanHash?.toLowerCase();
  const found: SavedInfrastructureHashes = {};
  for (const hash of hashes) {
    if (hash.toLowerCase() === applied) continue;
    const saved = await findSavedPlan(deps.paths.files.plansDir, hash);
    if (saved === undefined) continue;
    if (saved.planFile.endsWith(REMOVAL_PLAN_SUFFIX)) found.removal ??= hash;
    else found.apply ??= hash;
  }
  return found;
}

/**
 * The Cloudflare Access render inputs of any plan with a tunnel and Access (an own server in
 * tunnel mode, or a Portainer subdomain on any target): whether this configuration creates the
 * account's Zero Trust organization (read from Cloudflare, keeping the one an earlier run created)
 * and, with a Portainer subdomain, which one-time PIN login method its Access application uses
 * (the one the last render named; unset when the state holds OpsCrew's own; else the account's
 * existing one). Without them a re-run would plan to delete the organization or to create a
 * second PIN login method. `undefined` when the plan has no tunnel.
 *
 * The lookup of login methods is `services.accessLoginMethods` (default: Cloudflare's API).
 */
async function accessRenderInput(
  deps: PhaseDeps,
  services: ProvisionServices,
  plan: DeployPlan,
  cloudflare: CloudflareSetup | undefined,
): Promise<OwnRenderInput | undefined> {
  if (!usesTunnel(plan) || cloudflare?.accountId === undefined) return undefined;
  const previous = await committedTfvars(deps.paths.root, plan);
  const input: OwnRenderInput = {
    createZeroTrustOrganization: await createZeroTrustOrganization({
      api: services.own?.zeroTrust ?? cloudflareZeroTrust(deps),
      accountId: cloudflare.accountId,
      zone: cloudflare.zoneName,
      previous: previous?.create_zero_trust_organization === true,
    }),
  };
  if (portainerHostname(plan) !== undefined) {
    const pin = await oneTimePinIdentityProvider({
      previous,
      accountId: cloudflare.accountId,
      api: services.accessLoginMethods ?? cloudflareAccessLoginMethods(deps),
    });
    if (pin !== undefined) input.oneTimePinIdentityProviderId = pin;
  }
  return input;
}

/** True when the infrastructure plan creates, replaces or deletes the Cloudflare Tunnel itself. */
function changesTunnel(saved: SavedPlan | undefined): boolean {
  return (saved?.changes ?? []).some(
    (change) => change.type === "cloudflare_zero_trust_tunnel_cloudflared",
  );
}

/** An approval as `opscrew/plan.yaml` keeps it (informational; the approval store is authoritative). */
function planApproval(record: ApprovalRecord, kind: "iac-apply" | "host-apply") {
  return {
    planHash: record.planHash as string,
    approver: record.approver,
    at: record.decidedAt,
    kind,
  };
}

/**
 * Provision and DNS share this flow: credentials → engine, deploy key and state encryption →
 * render (approved write) → plan, policies, approval, apply → record the deployment → wait for the
 * server and pin its host key → deploy secrets → commit, push and pull request.
 *
 * A server the user owns (`target.provider: own`) differs after the credentials: connect and
 * confirm its host key, inspect it read-only and stop on blocking findings before any change; the
 * address reaches the engine only as `TF_VAR_*`; a switch between public and tunnel mode first
 * removes the old records (an apply of its own); after the infrastructure apply the host plan is
 * saved, shown, approved by its hash and applied; then the address is recorded and the deploy
 * secrets (with the tunnel's service token) are stored.
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
  const ownServer = plan.target.provider === "own";

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
  deps.reporter.step(
    ownServer
      ? "Checking the login to your server, Cloudflare and GitHub access"
      : `Checking your ${profile.displayName}, Cloudflare and GitHub access`,
  );
  await checkProvider(deps, profile.id, services);
  const cloudflare = await setupCloudflare(deps, plan, services);
  const github = await setupGitHub(deps, git, services);
  // The saved infrastructure plans the `--approve` hashes name (applied instead of planning again).
  const saved = await savedInfrastructureHashes(deps, options, plan);
  const approveHash = saved.apply;
  // The branch for the deployment files, picked (and checked to start from the latest
  // `plan.cicd.branch`) before anything changes; `--plan-only` commits nothing.
  const commits = !(options.planOnly && approveHash === undefined);
  const deployBranch = !commits
    ? undefined
    : options.push !== false
      ? await chooseDeployBranch(deps, git, github, plan, phase)
      : { branch: await localDeployBranch(git, plan, phase) };
  await extras.ready?.();
  // The note's advice (a new server for a fresh address) is for servers OpsCrew creates.
  const addressWasPublic =
    !ownServer && (extras.addressWasPublic ?? (await tfvarsShowPublicAddress(root, plan)));
  if (addressWasPublic && hasDeployment(plan) && hidesServerAddress(plan)) {
    deps.reporter.warn(ADDRESS_MAY_BE_PUBLIC_NOTE);
  }
  const zoneLearned = cloudflare !== undefined && plan.dns.zone !== cloudflare.zoneName;
  if (cloudflare && zoneLearned) {
    plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
    requireValidWithZone(deps, plan);
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
  const dir = join(root, plan.infra.dir);
  const approvals: { planHash: string; approver: string; at: string; kind: string }[] = [];

  // 3b. A server the user owns: connect and confirm its host key, inspect it (read-only) and stop
  // on blocking findings before anything changes; its address reaches the engine only as TF_VAR_*.
  let ownRun: OwnServerRun | undefined;
  let ownRender: OwnRenderInput | undefined;
  /** The host plan applied before a mode switch's removal deleted the tunnel. */
  let earlyHost: HostChangeResult | undefined;
  if (ownServer) {
    ownRun = await prepareOwnServer(deps, {
      plan,
      options,
      services,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      deployKeyFile: deployKey.privateKeyFile,
    });
    await ownEngineEnv(deps, ownRun, engineEnv, () =>
      infrastructureOutputs(deps, plan, { engine: async () => engine, engineEnv }),
    );
    ownRender = { sshPort: ownRun.sshPort };
    // Switching between public and tunnel mode: the old records go first, in an apply of their own.
    // Only a saved removal plan is applied as the removal (never the new setup's plan). When it
    // deletes the tunnel, the server's change (without the connector) goes before it.
    const removal = await removeOldAccessMode(deps, {
      engine,
      dir,
      env: engineEnv,
      plan,
      ...(saved.removal !== undefined ? { approvePlanHash: saved.removal } : {}),
      ...(options.planOnly ? { planOnly: true } : {}),
      phase,
      host: {
        run: ownRun,
        deployPublicKey: deployKey.publicKeyOpenSsh,
        ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
      },
    });
    earlyHost = removal?.host;
    if (removal === undefined && saved.removal !== undefined) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The plan ${saved.removal} you approved removes the current setup before a switch between public and tunnel mode, but no switch is pending, so OpsCrew did not apply it. Nothing was changed.`,
        {
          hint: `Run \`opscrew ${phase} --plan-only\`, review the plan and approve the new hash.`,
        },
      );
    }
    if (removal !== undefined) {
      const pending = (removal.plan?.changes.length ?? 0) > 0 && !removal.applied;
      if (options.planOnly && pending) {
        const first = removal.host;
        deps.reporter.info(
          first !== undefined
            ? `After this removal and the host plan are applied (\`opscrew ${phase} --approve ${removal.planHash} --approve ${first.hash}\`, typing the app name to confirm; the host plan goes first, because Cloudflare deletes the tunnel only after its connector on your server has stopped), run \`opscrew ${phase}\` again for the plan of the new setup.`
            : `After this removal is applied (\`opscrew ${phase} --approve ${removal.planHash}\`, typing the app name to confirm), run \`opscrew ${phase}\` again for the plan of the new setup.`,
        );
        return {
          ...(removal.planHash ? { planHash: removal.planHash } : {}),
          ...(first !== undefined ? { hostPlanHash: first.hash } : {}),
          applied: false,
          outputs: {},
        };
      }
      if (removal.approval) approvals.push(planApproval(removal.approval, "iac-apply"));
      if (removal.host?.approval) approvals.push(planApproval(removal.host.approval, "host-apply"));
    }
  }

  // 4. Render (skipped when applying a saved plan: its files were written by the --plan-only run)
  // Cloudflare Access settings for any plan with a tunnel (own servers, Portainer subdomains).
  const access = await accessRenderInput(deps, services, plan, cloudflare);
  if (access !== undefined) ownRender = { ...ownRender, ...access };
  const knownServer =
    hidesServerAddress(plan) || ownServer
      ? undefined
      : await serverAddress(deps, plan, { engine: async () => engine, engineEnv });
  const ctx = deploymentRenderContext(deps, {
    plan,
    requirements,
    github,
    deployPublicKey: deployKey.publicKeyOpenSsh,
    cloudflare,
    server: knownServer,
    ...(ownRender !== undefined ? { own: ownRender } : {}),
  });
  const files = deploymentFiles(plan, ctx);
  if (approveHash === undefined) {
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

  // 5. Plan → policies → approval → apply. A plan that deletes the tunnel (for example when
  // plan.yaml no longer has a Portainer subdomain) is applied only after the connector on the
  // server is removed (its own host-apply approval) and Cloudflare reports no active connections.
  const command = `opscrew ${phase}`;
  const cloudShown: { hostHash?: string } = {};
  const cloudConnector = (planOnly: boolean) =>
    cloudConnectorRemoval(deps, { plan, services, command, planOnly, shown: cloudShown });
  const first = ownRun
    ? ownConnectorFirst(deps, {
        run: ownRun,
        plan,
        deployPublicKey: deployKey.publicKeyOpenSsh,
        ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
        phase,
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
        done: "The change on your server is applied (its Cloudflare Tunnel connector is removed); the Cloudflare Tunnel this plan deletes is still there.",
        ...(extras.approvalNotes ? { notes: extras.approvalNotes } : {}),
      })
    : connectorFirst(deps, {
        command,
        app: plan.app.name,
        where: "the server",
        hostChange: () => cloudConnector(false),
        hostHash: () => cloudShown.hostHash,
        done: "The Cloudflare Tunnel connector is removed from the server; the Cloudflare Tunnel this plan deletes is still there.",
        ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
        ...(extras.approvalNotes ? { notes: extras.approvalNotes } : {}),
      });
  let applied: Awaited<ReturnType<typeof planAndApply>>;
  try {
    applied = await planAndApply(deps, {
      engine,
      dir,
      env: engineEnv,
      deployPlan: plan,
      files,
      command,
      phase,
      ...first.hooks,
      ...(approveHash !== undefined ? { approvePlanHash: approveHash } : {}),
      ...(options.planOnly ? { planOnly: true } : {}),
    });
  } catch (error) {
    if (!ownServer && isUserFacingError(error) && error.code === "ENGINE_FAILED") {
      await refreshServerAddress(deps, engine, dir, engineEnv);
    }
    throw first.stopped(error);
  }
  if (applied.approval) approvals.push(planApproval(applied.approval, "iac-apply"));
  if (first.host !== undefined) {
    earlyHost ??= first.host;
    if (first.host.approval) approvals.push(planApproval(first.host.approval, "host-apply"));
  }
  if (options.planOnly && approveHash === undefined) {
    let hostPlanHash: string | undefined;
    const pending = (applied.plan?.changes.length ?? 0) > 0;
    if (!ownRun && pending && deletesTunnel(applied.plan?.changes ?? [])) {
      // The connector's removal goes before this plan: show it now, so both can be approved.
      hostPlanHash = (await cloudConnector(true)).hash;
      deps.reporter.info(
        `Approve both plans to apply them (\`${command} --approve ${applied.planHash} --approve ${hostPlanHash}\`, typing ${plan.app.name} to confirm): the change on the server goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`,
      );
    }
    if (ownRun) {
      // The host plan can be shown now unless it needs a tunnel the plan has yet to create.
      const outputs =
        Object.keys(applied.outputs).length > 0
          ? applied.outputs
          : await engine.output(dir, { env: engineEnv }).catch(() => ({}));
      const tunnelKnown =
        !usesTunnel(plan) ||
        (stringOutput(outputs, "tunnel_id") !== undefined && !changesTunnel(applied.plan));
      if (tunnelKnown) {
        const host = await applyOwnHostPlan(deps, ownRun, {
          plan,
          outputs,
          deployPublicKey: deployKey.publicKeyOpenSsh,
          ...(options.passwordLogins !== undefined
            ? { passwordLogins: options.passwordLogins }
            : {}),
          planOnly: true,
          phase,
        });
        hostPlanHash = host.hash;
      } else {
        deps.reporter.info(
          "The host plan for your server follows once this infrastructure plan is applied, because it needs the Cloudflare Tunnel's id. Applying it shows the host plan and asks for its approval separately (in scripts: run with `--approve` and this hash, then again with `--approve` and the host plan's hash).",
        );
      }
    }
    if (zoneLearned) await writeArtifact("plan", deps.paths.files.plan, plan);
    return {
      ...(applied.planHash ? { planHash: applied.planHash } : {}),
      ...(hostPlanHash !== undefined ? { hostPlanHash } : {}),
      applied: false,
      outputs: {},
    };
  }

  // 6. Record the deployment: the server's address in the local state (never in the repository),
  // the apply and the domain URL in the plan.
  const now = deps.clock.now().toISOString();
  let address: ServerAddress | undefined;
  if (ownRun) {
    // Right after the infrastructure apply, as for cloud servers: the DNS records now point at this
    // address (none in tunnel mode), and a later switch's removal plan needs it.
    address = ownRun.address;
    await recordServerAddress(deps.paths, address);
    const connection = ownRun.session.connection;
    if (
      address !== undefined &&
      (connection.publicIpv4 !== address.ipv4 || connection.publicIpv6 !== address.ipv6)
    ) {
      const { publicIpv4: _v4, publicIpv6: _v6, ...rest } = connection;
      await recordOwnServer(deps.paths, {
        ...rest,
        publicIpv4: address.ipv4,
        ...(address.ipv6 !== undefined ? { publicIpv6: address.ipv6 } : {}),
      });
    }
  } else {
    address =
      addressFromOutputs(applied.outputs) ??
      (await serverAddress(deps, plan, { engine: async () => engine, engineEnv }));
    if (address === undefined) {
      throw new OpsCrewError("ENGINE_FAILED", "The server's address is unknown after the apply.", {
        hint: "Run `opscrew provision` again; it reads the address from the infrastructure state.",
      });
    }
    await recordServerAddress(deps.paths, address);
  }
  // Without a domain the output is `http://<server IP>`, which is not committed.
  const outputUrl = stringOutput(applied.outputs, "url");
  const url = outputUrl === undefined ? plan.deployment.url : committableUrl(outputUrl);
  // A new deployment after `opscrew destroy` is no longer destroyed.
  const { destroyedAt: _destroyedAt, url: _url, ...previousDeployment } = plan.deployment;
  const before = plan;
  /** The plan with this run's approvals and applies (a host apply counts as an apply too). */
  const record = (hostApplied: boolean): DeployPlan => ({
    ...before,
    updatedAt: now,
    approvals: [...before.approvals, ...approvals],
    deployment: {
      ...previousDeployment,
      ...(url ? { url } : {}),
      ...(applied.planHash && applied.applied ? { lastPlanHash: applied.planHash } : {}),
      ...(applied.applied || hostApplied ? { lastApplyAt: now } : {}),
    },
  });
  plan = record(false);
  await writeArtifact("plan", deps.paths.files.plan, plan);

  let secretsTarget: {
    host: string;
    knownHosts: string;
    tunnel?: { serviceTokenId: string; serviceTokenSecret: string };
  };
  let host: OwnHostResult | undefined;
  if (ownRun) {
    // 7 (own server). Host plan → policy → host-apply approval by its hash → apply.
    const outputs =
      Object.keys(applied.outputs).length > 0
        ? applied.outputs
        : await engine.output(dir, { env: engineEnv }).catch(() => ({}));
    host = await applyOwnHostPlan(deps, ownRun, {
      plan,
      outputs,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
      phase,
    });
    if (host.approval) approvals.push(planApproval(host.approval, "host-apply"));
    // The server changed before the removal already when that deleted the tunnel.
    if (earlyHost?.applied === true && !host.applied) host = { ...host, applied: true };
    plan = record(host.applied);
    await writeArtifact("plan", deps.paths.files.plan, plan);
    secretsTarget = ownDeployTarget(deps, ownRun, { plan, outputs });
  } else {
    const ipv4 = (address as ServerAddress).ipv4;
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
      confirmChangedKey: async ({ host: changedHost, previous, current }) => {
        const decision = await deps.approvals.request({
          kind: "remote-exec",
          title: `Trust the new SSH host key of ${changedHost}`,
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
    secretsTarget = { host: ipv4, knownHosts: pinned.knownHostsLines };
  }

  // 8–9. Production environment and GitHub Actions secrets
  let secretsStored = false;
  if (options.secrets !== false) {
    // Without a domain, host lists (`ALLOWED_HOSTS`) hold the address recorded in local state.
    const environment = await buildAppEnvironment(deps, plan, services, address?.ipv4);
    await setDeploySecrets(
      deps,
      github,
      deploySecrets({
        host: secretsTarget.host,
        privateKey: deployKey.privateKeyOpenSsh,
        knownHosts: secretsTarget.knownHosts,
        environment,
        ...(secretsTarget.tunnel !== undefined ? { tunnel: secretsTarget.tunnel } : {}),
      }),
      environment.names,
      phase,
    );
    secretsStored = true;
  } else {
    secretsStored = await deploySecretsStoredFor(deps, {
      host: secretsTarget.host,
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
    ...(host !== undefined ? { hostPlanHash: host.hash, hostApplied: host.applied } : {}),
    outputs: publicOutputs(applied.outputs),
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
 *
 * On a server the user already owns (`target.provider: own`) it never creates or deletes the
 * server: it confirms and pins the host key (`hostKey` in scripts), inspects the server, plans
 * Cloudflare's records (or tunnel and Access) as infrastructure and the server's preparation as a
 * host plan, applies each only after an approval bound to its hash (two `--approve` hashes in
 * scripts), then stores the deploy secrets and opens the pull request.
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

/**
 * Checks the plan again once Cloudflare named its zone: names the schema can only check against
 * the zone (a `www.` alias or a Portainer subdomain beyond Cloudflare's free certificate) stop
 * provision before anything is rendered, planned or changed.
 */
function requireValidWithZone(deps: PhaseDeps, plan: DeployPlan): void {
  const parsed = DeployPlanSchema.safeParse(plan);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "plan";
  throw new OpsCrewError(
    "ARTIFACT_INVALID",
    deps.redactor.redact(
      `opscrew/plan.yaml cannot be provisioned in the Cloudflare zone ${plan.dns.zone}: ${field} ${issue?.message ?? "is not valid"}. Nothing was changed.`,
    ),
    { hint: "Fix the field shown above in opscrew/plan.yaml, then run `opscrew provision` again." },
  );
}
