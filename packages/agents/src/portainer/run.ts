import { join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import {
  applyHostPlan,
  type HostPlan,
  hostPlanHash,
  PORTAINER_DIR,
  planPortainer,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, IacEngine, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, writeFileAtomic } from "@opscrew/core";
import { type EnginePreference, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import {
  portainerHostname,
  renderPortainerCompose,
  renderTunnelConnectorCompose,
  usesTunnel,
} from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { githubCoordinates, setupCloudflare } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import {
  applyOwnHostPlan,
  describeHostPlan,
  ensurePortainerPassword,
  hostPlanFile,
  type OwnServerRun,
  ownEngineEnv,
  prepareOwnServer,
} from "../provision/own";
import { findSavedPlan, planAndApply, REMOVAL_PLAN_SUFFIX } from "../provision/plan-apply";
import {
  committedTfvars,
  deploymentFiles,
  deploymentRenderContext,
  type OwnRenderInput,
  readRequirements,
} from "../provision/render";
import type { HostAdapterApi, ProvisionServices } from "../provision/types";
import { cloudflareZeroTrust, createZeroTrustOrganization } from "../provision/zero-trust";
import {
  describeDiff,
  diffRenderedFiles,
  ensureDeployKey,
  ensureStatePassphrase,
  hasDeployment,
  hidesServerAddress,
  infrastructureOutputs,
  readServerAddresses,
  SshRemoteExec,
  writeRenderedFiles,
} from "../shared";
import {
  type AccessLoginMethodsApi,
  cloudflareAccessLoginMethods,
  oneTimePinIdentityProvider,
} from "./access";
import {
  CLOUD_PORTAINER_DIR,
  CLOUD_TUNNEL_DIR,
  PORTAINER_VERSION,
  type PortainerEnableRequest,
  portainerSettings,
  withPortainer,
} from "./settings";
import { describePortainerStatus, type PortainerStatus, portainerStatusOf } from "./status";

/** Collaborators of the Portainer commands; each defaults to the real implementation. */
export interface PortainerServices extends ProvisionServices {
  /** Hetzner/DigitalOcean: the deploy user's shell (default: SSH with the deploy key). */
  deployRemote?: (host: string) => RemoteExec;
  /** Hetzner/DigitalOcean: the host adapter's apply (default `applyHostPlan`). */
  applyHost?: HostAdapterApi["apply"];
  /** The account's Access login methods (default: Cloudflare's API). */
  accessLoginMethods?: AccessLoginMethodsApi;
}

/** Options shared by `opscrew portainer enable` and `disable`. */
export interface PortainerRunOptions {
  /** Save and show the plans with their hashes; change nothing. */
  planOnly?: boolean;
  /**
   * Every hash given with `--approve`. A saved infrastructure plan among them is applied instead
   * of planning again; host plan hashes are granted by the approval handler.
   */
  approvePlanHashes?: readonly string[];
  /** `--host-key SHA256:…` for the first connection to the user's own server. */
  hostKey?: string;
  /** Overrides `plan.infra.engine`. */
  engine?: EnginePreference;
  services?: PortainerServices;
}

export interface PortainerEnableOptions extends PortainerEnableRequest, PortainerRunOptions {}

export interface PortainerDisableOptions extends PortainerRunOptions {
  /**
   * Also delete Portainer's data (its `portainer_data` volume). Asked as a separate approval with
   * `allowDestroy` that needs the app's name typed to confirm.
   */
  deleteData?: boolean;
}

/** What an enable or disable run did. Never holds the password or a token. */
export interface PortainerResult {
  /** The infrastructure plan's hash (tunnel and Access), when the change needed one. */
  planHash?: string;
  /** True when this run applied the infrastructure plan. */
  applied: boolean;
  /** The host plan's hash (`.opscrew/plans/host-<hash>.json`). */
  hostPlanHash?: string;
  /** True when this run changed the server. */
  hostApplied: boolean;
  /** The hash of the host plan that deletes Portainer's data (disable with `deleteData`). */
  dataPlanHash?: string;
  /** Repository files this run wrote (commit them, or let `opscrew provision` publish them). */
  files: string[];
  status: PortainerStatus;
}

type Command = "enable" | "disable";

interface Change {
  command: Command;
  before: DeployPlan;
  after: DeployPlan;
  deleteData: boolean;
}

function noDeployment(command: Command): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `There is no deployment to ${command === "enable" ? "add Portainer to" : "remove Portainer from"} yet. Nothing was changed.`,
    { hint: "Run `opscrew provision` first." },
  );
}

/** The saved infrastructure plan among the `--approve` hashes (never a removal plan). */
async function savedInfrastructureHash(
  deps: PhaseDeps,
  plan: DeployPlan,
  hashes: readonly string[],
): Promise<string | undefined> {
  const applied = plan.deployment.lastPlanHash?.toLowerCase();
  for (const hash of hashes) {
    if (hash.toLowerCase() === applied) continue;
    const saved = await findSavedPlan(deps.paths.files.plansDir, hash);
    if (saved !== undefined && !saved.planFile.endsWith(REMOVAL_PLAN_SUFFIX)) return hash;
  }
  return undefined;
}

function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The engine and its environment, as provision sets them up (state encryption with OpenTofu). */
async function engineFor(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: PortainerRunOptions,
): Promise<{ engine: IacEngine; env: Record<string, string | undefined> }> {
  const services = options.services ?? {};
  const preference = options.engine ?? plan.infra.engine;
  const engine = services.engine
    ? await services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  const env: Record<string, string | undefined> = { ...deps.env };
  if (plan.infra.stateEncryption && engine.info.name === "tofu") {
    const passphrase = await ensureStatePassphrase(deps.paths);
    deps.redactor.addLiteral(passphrase, "state-passphrase");
    env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
  }
  return { engine, env };
}

/**
 * Renders the deployment files for the changed plan (the runbook's Portainer section, and the
 * tunnel and Access modules for a subdomain) with the same inputs provision uses, plus the
 * decisions this change makes: whether this configuration creates the Zero Trust organization and
 * which one-time PIN login method Portainer's Access application uses. Writes the changed files
 * after a `repo-write` approval (not when a saved plan is applied: its run wrote them).
 */
async function renderChange(
  deps: PhaseDeps,
  change: Change,
  input: {
    ownRun?: OwnServerRun;
    deployPublicKey: string;
    write: boolean;
    services: PortainerServices;
  },
): Promise<{ plan: DeployPlan; files: ReturnType<typeof deploymentFiles>; written: string[] }> {
  const root = deps.paths.root;
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
  const github = await githubCoordinates(git);
  let plan = change.after;
  const cloudflare = await setupCloudflare(deps, plan, input.services);
  if (cloudflare) plan = { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } };
  const previous = await committedTfvars(root, plan);
  const own: OwnRenderInput = input.ownRun ? { sshPort: input.ownRun.sshPort } : {};
  if (usesTunnel(plan) && cloudflare?.accountId !== undefined) {
    own.createZeroTrustOrganization = await createZeroTrustOrganization({
      api: input.services.own?.zeroTrust ?? cloudflareZeroTrust(deps),
      accountId: cloudflare.accountId,
      zone: cloudflare.zoneName,
      previous: previous?.create_zero_trust_organization === true,
    });
    if (portainerHostname(plan) !== undefined) {
      const pin = await oneTimePinIdentityProvider({
        previous,
        accountId: cloudflare.accountId,
        api: input.services.accessLoginMethods ?? cloudflareAccessLoginMethods(deps),
      });
      if (pin !== undefined) own.oneTimePinIdentityProviderId = pin;
    }
  }
  const server =
    plan.target.provider === "own" || hidesServerAddress(plan)
      ? undefined
      : (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  const ctx = deploymentRenderContext(deps, {
    plan,
    requirements: await readRequirements(deps),
    github,
    deployPublicKey: input.deployPublicKey,
    cloudflare,
    server,
    own,
  });
  const files = deploymentFiles(plan, ctx);
  const written: string[] = [];
  if (input.write) {
    const diff = await diffRenderedFiles(root, files);
    const toWrite = [...diff.created, ...diff.changed];
    if (toWrite.length > 0) {
      const approval = await deps.approvals.request({
        kind: "repo-write",
        title: `Write the deployment files for Portainer to the repository (${describeDiff(diff)})`,
        details: [
          ...diff.created.map((f) => `  new      ${f.path}`),
          ...diff.changed.map((f) => `  changed  ${f.path}`),
        ].join("\n"),
      });
      if (!approval.approved) {
        throw new OpsCrewError("APPROVAL_REFUSED", "Nothing was written and nothing was changed.");
      }
      await writeRenderedFiles(root, toWrite);
      written.push(...toWrite.map((f) => f.path));
      deps.reporter.success(`Wrote ${describeDiff(diff)}.`);
    }
  }
  return { plan, files, written };
}

/** Records the run's approvals and applies in `opscrew/plan.yaml` (informational copies). */
function recorded(
  deps: PhaseDeps,
  plan: DeployPlan,
  approvals: { record: ApprovalRecord; kind: "iac-apply" | "host-apply" }[],
  applied: { iacHash?: string; any: boolean },
): DeployPlan {
  const now = deps.clock.now().toISOString();
  return {
    ...plan,
    updatedAt: now,
    approvals: [
      ...plan.approvals,
      ...approvals.map(({ record, kind }) => ({
        planHash: record.planHash as string,
        approver: record.approver,
        at: record.decidedAt,
        kind,
      })),
    ],
    deployment: {
      ...plan.deployment,
      ...(applied.iacHash !== undefined ? { lastPlanHash: applied.iacHash } : {}),
      ...(applied.any ? { lastApplyAt: now } : {}),
    },
  };
}

/**
 * Saves, shows, approves (`host-apply`, by its hash) and applies a host plan of add-on steps
 * (Portainer, its tunnel connector, or the deletion of Portainer's data) through the host
 * adapter, which refuses any other plan. Secrets are read only after the approval and go only to
 * the adapter. Every step is audited by the plan's hash. With `planOnly` it stops after showing.
 */
async function applyAddonPlan(
  deps: PhaseDeps,
  input: {
    plan: HostPlan;
    remote: RemoteExec;
    apply: HostAdapterApi["apply"];
    verifyLogin: () => Promise<boolean>;
    title: string;
    allowDestroy: boolean;
    planOnly: boolean;
    secrets: () => Promise<{ tunnelToken?: string; portainerPassword?: string }>;
    command: string;
  },
): Promise<{ hash: string; applied: boolean; approval?: ApprovalRecord }> {
  const { plan } = input;
  const hash = hostPlanHash(plan);
  await writeFileAtomic(hostPlanFile(deps.paths, hash), `${JSON.stringify(plan, null, 2)}\n`);
  const details = describeHostPlan(plan, hash);
  deps.reporter.info(details);
  if (input.planOnly) {
    deps.reporter.info(`Saved the host plan (hash ${hash}); nothing on the server was changed.`);
    return { hash, applied: false };
  }
  const approval = await deps.approvals.request({
    kind: "host-apply",
    title: input.title,
    details,
    planHash: hash,
    ...(input.allowDestroy ? { allowDestroy: true, confirmPhrase: plan.app } : {}),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The host plan was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing on the server was changed.`,
      { hint: `To apply it later without prompts, run: ${input.command} --approve ${hash}` },
    );
  }
  await deps.approvals.assertApprovedHostPlan(hash, { allowDestroy: input.allowDestroy });
  const secrets = await input.secrets();
  const changeIds = plan.steps.filter((step) => step.state === "change").map((step) => step.id);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "host apply started",
    phase: "provision",
    target: hash,
    decision: "approved",
    detail: `steps to change: ${changeIds.join(", ")}`,
  });
  let result: Awaited<ReturnType<HostAdapterApi["apply"]>>;
  try {
    result = await input.apply(input.remote, plan, {
      approvedHash: hash,
      secrets,
      verifyLogin: input.verifyLogin,
      ...(/^[0-9A-Za-z.+-]{1,64}$/.test(deps.version) ? { version: deps.version } : {}),
      now: () => deps.clock.now(),
    });
  } catch (error) {
    const reported = (error as { applied?: unknown } | null)?.applied;
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "host apply failed",
      phase: "provision",
      target: hash,
      decision: "refused",
      detail: Array.isArray(reported)
        ? `steps applied before the failure: ${reported.filter((id) => changeIds.includes(id)).join(", ") || "none"}`
        : "the host adapter did not report which steps were applied before the failure",
    });
    throw error;
  }
  for (const id of result.applied) {
    const step = plan.steps.find((item) => item.id === id);
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: `host step ${id}`,
      phase: "provision",
      target: hash,
      decision: "approved",
      ...(step !== undefined ? { detail: step.title } : {}),
    });
  }
  return { hash, applied: result.applied.length > 0, approval };
}

/**
 * The shared enable/disable flow: render (own servers always, others when a subdomain is
 * involved) → infrastructure plan, policies, `iac-apply` approval and apply when a tunnel is
 * involved → host plan, `host-apply` approval and apply → (disable with `deleteData`) the data
 * deletion's own approval with the typed app name → `opscrew/plan.yaml` updated.
 */
async function runChange(
  deps: PhaseDeps,
  change: Change,
  options: PortainerRunOptions,
): Promise<PortainerResult> {
  const services = options.services ?? {};
  const planOnly = options.planOnly === true;
  const command = `opscrew portainer ${change.command}`;
  const own = change.before.target.provider === "own";
  const subdomainInvolved =
    portainerHostname(change.before) !== undefined || portainerHostname(change.after) !== undefined;
  const tunnelInvolved = usesTunnel(change.before) || usesTunnel(change.after);
  const approvals: { record: ApprovalRecord; kind: "iac-apply" | "host-apply" }[] = [];

  const deployKey = await ensureDeployKey(deps.paths);
  deps.redactor.addLiteral(deployKey.privateKeyOpenSsh, "deploy-key");
  const approveHash = await savedInfrastructureHash(
    deps,
    change.before,
    options.approvePlanHashes ?? [],
  );

  // A server the user owns: connect (pinned host key), inspect read-only, stop on blockers.
  let ownRun: OwnServerRun | undefined;
  if (own) {
    ownRun = await prepareOwnServer(deps, {
      plan: change.after,
      options: options.hostKey !== undefined ? { hostKey: options.hostKey } : {},
      services,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      deployKeyFile: deployKey.privateKeyFile,
    });
  }
  // Hetzner/DigitalOcean: the deploy user's shell; enabling needs Docker 28 (checked read-only).
  let cloudRemote: RemoteExec | undefined;
  if (!own) {
    cloudRemote = await deployRemote(deps, services);
    if (change.command === "enable") await requireDocker28(deps, cloudRemote);
  }

  // Render: only a subdomain (added, changed or removed) changes the infrastructure code. The
  // runbook's Portainer section follows with the next `opscrew verify`, which writes the runbook.
  let plan = change.after;
  let files: ReturnType<typeof deploymentFiles> = [];
  const written: string[] = [];
  if (subdomainInvolved) {
    const rendered = await renderChange(deps, change, {
      ...(ownRun !== undefined ? { ownRun } : {}),
      deployPublicKey: deployKey.publicKeyOpenSsh,
      write: approveHash === undefined,
      services,
    });
    plan = rendered.plan;
    files = rendered.files;
    written.push(...rendered.written);
  }
  await writeArtifact("plan", deps.paths.files.plan, plan);

  // Infrastructure: the tunnel and Access (or their removal), through the IaC engine.
  let outputs: Record<string, unknown> = {};
  let planHash: string | undefined;
  let iacApplied = false;
  if (tunnelInvolved) {
    const { engine, env } = await engineFor(deps, plan, options);
    if (ownRun) {
      await ownEngineEnv(deps, ownRun, env, () =>
        infrastructureOutputs(deps, plan, { engine: async () => engine, engineEnv: env }),
      );
    }
    const result = await planAndApply(deps, {
      engine,
      dir: join(deps.paths.root, plan.infra.dir),
      env,
      deployPlan: plan,
      files,
      command,
      phase: "provision",
      costDelta: null,
      approvalTitle:
        change.command === "enable" && portainerHostname(plan) !== undefined
          ? `Serve Portainer on ${portainerHostname(plan)} behind Cloudflare Access (Cloudflare Tunnel and Access)`
          : "Apply the Cloudflare Tunnel and Access changes for Portainer",
      ...(approveHash !== undefined ? { approvePlanHash: approveHash } : {}),
      ...(planOnly ? { planOnly: true } : {}),
    });
    planHash = result.planHash;
    iacApplied = result.applied;
    if (result.approval) approvals.push({ record: result.approval, kind: "iac-apply" });
    const pending = (result.plan?.changes.length ?? 0) > 0 && !result.applied;
    if (planOnly && pending) {
      deps.reporter.info(
        `The host plan follows once this infrastructure plan is applied (\`${command} --approve ${planHash}\`), because it needs the Cloudflare Tunnel.`,
      );
      return {
        ...(planHash !== undefined ? { planHash } : {}),
        applied: false,
        hostApplied: false,
        files: written,
        status: await portainerStatusOf(deps, plan),
      };
    }
    outputs =
      Object.keys(result.outputs).length > 0
        ? result.outputs
        : await engine.output(join(deps.paths.root, plan.infra.dir), { env }).catch(() => ({}));
  }

  // The server: a host plan on the user's own server, or the deploy user's add-on steps.
  let hostPlanHashValue: string | undefined;
  let hostApplied = false;
  let dataPlanHash: string | undefined;
  if (ownRun) {
    const host = await applyOwnHostPlan(deps, ownRun, {
      plan,
      outputs,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      planOnly,
      phase: "provision",
    });
    hostPlanHashValue = host.hash;
    hostApplied = host.applied;
    if (host.approval) approvals.push({ record: host.approval, kind: "host-apply" });
    if (change.deleteData) {
      const data = await applyAddonPlan(deps, {
        plan: planPortainer({
          app: plan.app.name,
          dir: PORTAINER_DIR,
          runAs: "root",
          disable: { deleteData: true },
        }),
        remote: ownRun.session.remote,
        apply: ownRun.host.apply,
        verifyLogin: ownRun.verifyLogin,
        title: `Delete Portainer's data on your server (its admin account and settings)`,
        allowDestroy: true,
        planOnly,
        secrets: async () => ({}),
        command,
      });
      dataPlanHash = data.hash;
      hostApplied ||= data.applied;
      if (data.approval) approvals.push({ record: data.approval, kind: "host-apply" });
    }
  } else {
    const result = await cloudHostChange(deps, change, {
      plan,
      outputs,
      services,
      remote: cloudRemote as RemoteExec,
      planOnly,
      command,
    });
    hostPlanHashValue = result.hash;
    hostApplied = result.applied;
    if (result.approval) approvals.push({ record: result.approval, kind: "host-apply" });
  }

  if (!planOnly) {
    plan = recorded(deps, plan, approvals, {
      ...(iacApplied && planHash !== undefined ? { iacHash: planHash } : {}),
      any: iacApplied || hostApplied,
    });
    await writeArtifact("plan", deps.paths.files.plan, plan);
  }
  const status = await portainerStatusOf(deps, plan);
  if (!planOnly) {
    if (change.command === "enable") {
      deps.reporter.success("Portainer is on.");
      deps.reporter.info(describePortainerStatus(status));
    } else {
      deps.reporter.success(
        change.deleteData
          ? "Portainer is off and its data is deleted."
          : "Portainer is off; its data stays on the server (`opscrew portainer disable --delete-data` deletes it).",
      );
    }
  }
  const changedFiles = [...written, "opscrew/plan.yaml"];
  deps.reporter.info(
    `Commit ${changedFiles.join(", ")} so the repository describes the deployment (the next \`opscrew provision\` also publishes them in its pull request).`,
  );
  return {
    ...(planHash !== undefined ? { planHash } : {}),
    applied: iacApplied,
    ...(hostPlanHashValue !== undefined ? { hostPlanHash: hostPlanHashValue } : {}),
    hostApplied,
    ...(dataPlanHash !== undefined ? { dataPlanHash } : {}),
    files: written,
    status,
  };
}

/**
 * Hetzner and DigitalOcean: the deploy user's shell on the server, over the deploy key and the
 * pinned host key (the address from this computer's local state).
 */
async function deployRemote(deps: PhaseDeps, services: PortainerServices): Promise<RemoteExec> {
  const address = (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This computer does not know the server's address, so OpsCrew cannot reach it. Nothing was changed.",
      { hint: "Run `opscrew provision` here first; it records the address." },
    );
  }
  return (
    services.deployRemote?.(address.ipv4) ??
    new SshRemoteExec({
      host: address.ipv4,
      keyFile: deps.paths.files.deployKey,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    })
  );
}

/** Docker Engine 28.0.0 keeps ports published on 127.0.0.1 unreachable from the local network. */
const MIN_DOCKER_MAJOR = 28;

/**
 * Read-only, before anything changes: Portainer needs Docker Engine 28 or newer on Hetzner and
 * DigitalOcean servers. Before 28, ports published on 127.0.0.1 are reachable from layer-2
 * neighbours (moby/moby#49325), so Portainer's local-only port would not be local. Servers the user
 * owns already get Docker 28 or newer through the host plan.
 */
async function requireDocker28(deps: PhaseDeps, remote: RemoteExec): Promise<void> {
  let version = "";
  try {
    const result = await remote.run("docker version --format '{{.Server.Version}}'", {
      timeoutMs: 60_000,
    });
    if (result.exitCode === 0) version = result.stdout.trim().split(/\s+/)[0] ?? "";
  } catch {
    version = "";
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read Docker version (read-only)",
    phase: "provision",
    target: "server",
    decision: "allow",
    ...(version !== "" ? { detail: `Docker ${version}` } : {}),
  });
  const match = /^(\d+)\.\d+/.exec(version);
  if (match === null) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not read the Docker version on the server as the deploy user, so it did not set up Portainer. Nothing was changed.",
      {
        hint: "Check that the server is reachable over SSH and that Docker is running (`docker version` as the deploy user), then run the command again.",
      },
    );
  }
  if (Number(match[1]) < MIN_DOCKER_MAJOR) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This server runs Docker ${deps.redactor.redact(version.slice(0, 40))}; Portainer needs Docker 28 or newer, which keeps its local-only port truly local. Nothing was changed.`,
      {
        hint: "Upgrade Docker (OpsCrew-created servers get it from Docker's repository from now on), then run the command again.",
      },
    );
  }
}

/**
 * Hetzner and DigitalOcean: Portainer (and, for a subdomain, its tunnel connector) runs as the
 * deploy user in its home directory (the deploy user is in the docker group; no root needed),
 * over the deploy key and the pinned host key.
 */
async function cloudHostChange(
  deps: PhaseDeps,
  change: Change,
  input: {
    plan: DeployPlan;
    outputs: Record<string, unknown>;
    services: PortainerServices;
    remote: RemoteExec;
    planOnly: boolean;
    command: string;
  },
): Promise<{ hash: string; applied: boolean; approval?: ApprovalRecord }> {
  const { plan, outputs, remote } = input;
  const enabling = change.command === "enable";
  let connector: Parameters<typeof planPortainer>[0]["connector"];
  let tunnelToken: string | undefined;
  if (enabling && portainerHostname(plan) !== undefined) {
    const tunnelId = stringOutput(outputs, "tunnel_id");
    tunnelToken = stringOutput(outputs, "tunnel_token");
    if (tunnelToken !== undefined) deps.redactor.addLiteral(tunnelToken, "tunnel-token");
    if (tunnelId === undefined || tunnelToken === undefined) {
      throw new OpsCrewError(
        "ENGINE_FAILED",
        "The infrastructure state has no Cloudflare Tunnel id or token, so OpsCrew cannot start the tunnel connector for Portainer's subdomain.",
        { hint: `Run \`${input.command}\` again; it plans what is missing.` },
      );
    }
    connector = {
      dir: CLOUD_TUNNEL_DIR,
      compose: renderTunnelConnectorCompose(plan).content,
      tunnelId,
      needsToken: true,
    };
  } else if (portainerHostname(change.before) !== undefined) {
    connector = { dir: CLOUD_TUNNEL_DIR, remove: true };
  }
  const hostPlan = planPortainer({
    app: plan.app.name,
    dir: CLOUD_PORTAINER_DIR,
    runAs: "login",
    ...(enabling
      ? {
          enable: {
            version: plan.portainer?.version ?? PORTAINER_VERSION,
            compose: {
              initial: renderPortainerCompose(plan, { initialAdmin: true }).content,
              final: renderPortainerCompose(plan, { initialAdmin: false }).content,
            },
            needsPassword: true,
          },
        }
      : { disable: { deleteData: change.deleteData } }),
    ...(connector !== undefined ? { connector } : {}),
  });
  return applyAddonPlan(deps, {
    plan: hostPlan,
    remote,
    apply: input.services.applyHost ?? applyHostPlan,
    // Add-on steps never touch SSH or the firewall, so the adapter never needs a login check.
    verifyLogin: async () => true,
    title: enabling
      ? "Run Portainer on the server as the deploy user"
      : change.deleteData
        ? "Remove Portainer and delete its data on the server"
        : "Remove Portainer from the server (its data stays)",
    allowDestroy: !enabling && change.deleteData,
    planOnly: input.planOnly,
    secrets: async () => ({
      ...(tunnelToken !== undefined ? { tunnelToken } : {}),
      ...(enabling ? { portainerPassword: await ensurePortainerPassword(deps) } : {}),
    }),
    command: input.command,
  });
}

/**
 * `opscrew portainer enable [--subdomain <host> --allow-email <email>…]`: turns Portainer CE on
 * for the project on any target, pinned to {@link PORTAINER_VERSION}, listening only on the
 * server itself. Its admin password is generated on this computer
 * (`~/.opscrew/projects/<id>/portainer_password`, 0600), supplied only at apply and never
 * printed. On a server the user owns it is a host-plan step (`host-apply`); on Hetzner and
 * DigitalOcean it runs as the deploy user. The subdomain opt-in also plans the Cloudflare Tunnel
 * and Access (`iac-apply`) and needs the app's Cloudflare domain and at least one email address.
 */
export async function portainerEnable(
  deps: PhaseDeps,
  options: PortainerEnableOptions = {},
): Promise<PortainerResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  requireNoMoveInProgress(before);
  if (!hasDeployment(before)) throw noDeployment("enable");
  let zone = before.dns.zone;
  if (options.subdomain !== undefined && zone === undefined) {
    // A bare label (`portainer`) needs the zone; the Cloudflare check learns it.
    zone = (await setupCloudflare(deps, before, options.services ?? {}))?.zoneName;
  }
  const settings = portainerSettings(before, options, zone);
  const after = withPortainer(
    zone === undefined ? before : { ...before, dns: { ...before.dns, zone } },
    settings,
  );
  return runChange(deps, { command: "enable", before, after, deleteData: false }, options);
}

/**
 * `opscrew portainer disable [--delete-data]`: removes Portainer (and the tunnel and Access of a
 * subdomain) behind the same approvals. Its data stays unless `deleteData` is set; deleting it is
 * a separate approval that needs the app's name typed to confirm.
 */
export async function portainerDisable(
  deps: PhaseDeps,
  options: PortainerDisableOptions = {},
): Promise<PortainerResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  requireNoMoveInProgress(before);
  if (!hasDeployment(before)) throw noDeployment("disable");
  const deleteData = options.deleteData === true;
  if (!before.portainer?.enabled && !deleteData) {
    deps.reporter.info("Portainer is already off for this project; nothing to do.");
    return {
      applied: false,
      hostApplied: false,
      files: [],
      status: await portainerStatusOf(deps, before),
    };
  }
  const after = withPortainer(before, undefined);
  return runChange(deps, { command: "disable", before, after, deleteData }, options);
}
