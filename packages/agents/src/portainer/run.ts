import { join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import {
  applyHostPlan,
  type HostPlan,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  planPortainer,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, RemoteExec } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import type { EnginePreference } from "@opscrew/iac-engine";
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
  type OwnServerRun,
  ownEngineEnv,
  portainerPasswordFile,
  portainerPasswordToSend,
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
import { currentOutputs } from "../provision/steps";
import type { ProvisionServices } from "../provision/types";
import { cloudflareZeroTrust, createZeroTrustOrganization } from "../provision/zero-trust";
import {
  approvalEntry,
  approveAndApplyHostPlan,
  approveAndWriteRenderedFiles,
  diffRenderedFiles,
  ensureDeployKey,
  exists,
  type HostAdapterApi,
  type HostPlanOutcome,
  hasDeployment,
  hidesServerAddress,
  infrastructureOutputs,
  oneTimePinIdentityProvider,
  PlanRefusedError,
  projectEngine,
  readServerAddresses,
  SshRemoteExec,
  stringOutput,
} from "../shared";
import { connectorFirst, type HostChangeResult, tunnelChange } from "../shared/tunnel-connections";
import {
  clearPendingPortainer,
  optionsDiffer,
  readPendingPortainer,
  sameSettings,
  savePendingPortainer,
} from "./pending";
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
    const zeroTrust = input.services.zeroTrust ?? cloudflareZeroTrust(deps);
    own.createZeroTrustOrganization = await createZeroTrustOrganization({
      api: zeroTrust,
      accountId: cloudflare.accountId,
      zone: cloudflare.zoneName,
      previous: previous?.create_zero_trust_organization === true,
    });
    if (portainerHostname(plan) !== undefined) {
      const pin = await oneTimePinIdentityProvider({
        previous,
        accountId: cloudflare.accountId,
        api: zeroTrust,
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
  if (!input.write) {
    // Applying a saved plan: the files its --plan-only run wrote must be what these options render.
    const diff = await diffRenderedFiles(root, files);
    if (diff.created.length + diff.changed.length > 0) throw optionsDiffer();
    return { plan, files, written: [] };
  }
  const written = await approveAndWriteRenderedFiles(deps, root, files, {
    what: "the deployment files for Portainer",
    refused: "Nothing was written and nothing was changed.",
  });
  return { plan, files, written: written.map((file) => file.path) };
}

/** Records the run's approvals and applies in `opscrew/plan.yaml` (informational copies). */
function recorded(
  deps: PhaseDeps,
  plan: DeployPlan,
  approvals: readonly ApprovalRecord[],
  applied: { iacHash?: string; any: boolean },
): DeployPlan {
  const now = deps.clock.now().toISOString();
  return {
    ...plan,
    updatedAt: now,
    approvals: [...plan.approvals, ...approvals.map(approvalEntry)],
    deployment: {
      ...plan.deployment,
      ...(applied.iacHash !== undefined ? { lastPlanHash: applied.iacHash } : {}),
      ...(applied.any ? { lastApplyAt: now } : {}),
    },
  };
}

/**
 * The shared enable/disable flow: render (own servers always, others when a subdomain is
 * involved) → infrastructure plan, policies, `iac-apply` approval and apply when a tunnel is
 * involved → host plan, `host-apply` approval and apply → (disable with `deleteData`) the data
 * deletion's own approval with the typed app name → `opscrew/plan.yaml` updated. When the
 * infrastructure plan deletes the tunnel, both plans are approved first, then the host plan (which
 * removes the connector) is applied, then OpsCrew waits until Cloudflare reports no active
 * connections for the tunnel, and only then applies the infrastructure plan.
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
  const approvals: ApprovalRecord[] = [];

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
      phase: "portainer",
      command,
    });
  }
  // Hetzner/DigitalOcean: the deploy user's shell; enabling needs Docker 28 and looks for
  // Portainer's data (both read-only).
  let cloudRemote: RemoteExec | undefined;
  let cloudFacts: CloudFacts | undefined;
  if (!own) {
    cloudRemote = await deployRemote(deps, services);
    if (change.command === "enable") cloudFacts = await cloudPreflight(deps, cloudRemote);
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
  // `opscrew/plan.yaml` changes only once the change is on the server (see the end).
  const planned = async (): Promise<void> =>
    savePendingPortainer(deps.paths, {
      command: change.command,
      settings: plan.portainer ?? null,
      deleteData: change.deleteData,
    });

  // The change on the server: the host plan provision applies on the user's own server, now with
  // Portainer as the plan describes it, or the deploy user's add-on steps. It normally follows the
  // infrastructure apply (it may need the tunnel's id); when the infrastructure plan deletes the
  // tunnel it goes first, because Cloudflare refuses to delete a tunnel whose connector still runs.
  // `hostHash` names its plan as soon as it is shown; a refusal says to approve it later with this
  // command, which finishes the change.
  let hostHash: string | undefined;
  const shown = (hash: string) => {
    hostHash = hash;
  };
  const hostChange = (
    outputs: Record<string, unknown>,
    hostPlanOnly: boolean,
  ): Promise<HostChangeResult> =>
    ownRun
      ? applyOwnHostPlan(deps, ownRun, {
          plan,
          outputs,
          deployPublicKey: deployKey.publicKeyOpenSsh,
          planOnly: hostPlanOnly,
          phase: "portainer",
          command,
          upToDate:
            change.command === "enable"
              ? "Portainer already runs on your server as planned; nothing on it changes."
              : "Portainer is no longer on your server; nothing on it changes.",
          shown,
        })
      : cloudHostChange(deps, change, {
          plan,
          outputs,
          services,
          remote: cloudRemote as RemoteExec,
          facts: cloudFacts,
          planOnly: hostPlanOnly,
          command,
          shown,
        });
  /** The host change that went before the tunnel's deletion (see {@link hostChange}). */
  let early: HostChangeResult | undefined;

  // Infrastructure: the tunnel and Access (or their removal), through the IaC engine.
  let outputs: Record<string, unknown> = {};
  let planHash: string | undefined;
  let iacApplied = false;
  if (tunnelInvolved) {
    const { engine: inner, env } = await projectEngine(deps, plan, {
      ...(options.engine !== undefined ? { preference: options.engine } : {}),
      services,
    });
    // Applying a plan that deletes the tunnel: the server first, then the wait, then the deletion.
    const first = connectorFirst(deps, {
      command,
      app: plan.app.name,
      where: ownRun ? "on your server" : "on the server",
      hostChange: () => hostChange({}, false),
      hostHash: () => hostHash,
      done: CONNECTOR_GONE,
      ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
    });
    if (ownRun) {
      await ownEngineEnv(deps, ownRun, env, () =>
        infrastructureOutputs(deps, plan, { engine: async () => inner, engineEnv: env }),
      );
    }
    let result: Awaited<ReturnType<typeof planAndApply>>;
    try {
      result = await planAndApply(deps, {
        engine: inner,
        ...first.hooks,
        dir: join(deps.paths.root, plan.infra.dir),
        env,
        deployPlan: plan,
        files,
        command,
        phase: "portainer",
        costDelta: null,
        approvalTitle:
          change.command === "enable" && portainerHostname(plan) !== undefined
            ? `Serve Portainer on ${portainerHostname(plan)} behind Cloudflare Access (Cloudflare Tunnel and Access)`
            : "Apply the Cloudflare Tunnel and Access changes for Portainer",
        ...(approveHash !== undefined ? { approvePlanHash: approveHash } : {}),
        ...(planOnly ? { planOnly: true } : {}),
      });
    } catch (error) {
      // `--approve <infrastructure plan hash>` without options then applies exactly this change.
      await planned();
      throw infrastructureStopped(deps, first.stopped(error), written);
    }
    early = first.host;
    planHash = result.planHash;
    iacApplied = result.applied;
    if (result.approval) approvals.push(result.approval);
    const pending = (result.plan?.changes.length ?? 0) > 0 && !result.applied;
    if (planOnly && pending) {
      await planned();
      // A plan that deletes the tunnel is applied after the host plan: both are shown now.
      const shownFirst = tunnelChange(result.plan?.changes ?? [], "delete")
        ? await hostChange({}, true)
        : undefined;
      deps.reporter.info(
        shownFirst !== undefined
          ? `Approve both plans to apply them (\`${command} --approve ${planHash} --approve ${shownFirst.hash}\`, typing ${plan.app.name} to confirm): the change on ${ownRun ? "your server" : "the server"} goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`
          : `The host plan follows once this infrastructure plan is applied (\`${command} --approve ${planHash}\`), because it needs the Cloudflare Tunnel.`,
      );
      return {
        ...(planHash !== undefined ? { planHash } : {}),
        applied: false,
        ...(shownFirst !== undefined ? { hostPlanHash: shownFirst.hash } : {}),
        hostApplied: false,
        files: written,
        status: await portainerStatusOf(deps, change.before),
      };
    }
    outputs = await currentOutputs(result, inner, join(deps.paths.root, plan.infra.dir), env);
  }

  // The server (unless its change went first, before the tunnel's deletion).
  let hostPlanHashValue: string | undefined;
  let hostApplied = false;
  let dataPlanHash: string | undefined;
  try {
    const host = early ?? (await hostChange(outputs, planOnly));
    hostPlanHashValue = host.hash;
    hostApplied = host.applied;
    if (host.approval) approvals.push(host.approval);
    if (ownRun && change.deleteData) {
      const data = await approveAndApplyHostPlan(deps, {
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
        server: "your server",
        upToDate: "Portainer's data is no longer on your server; nothing on it changes.",
        command,
        phase: "portainer",
        allowDestroy: true,
        planOnly,
        secrets: async () => ({}),
      });
      dataPlanHash = data.hash;
      hostApplied ||= data.applied;
      if (data.approval) approvals.push(data.approval);
    }
  } catch (error) {
    // The server did not get the change: plan.yaml keeps the earlier settings, and only an
    // infrastructure apply that already happened is recorded (so its hash is not applied again).
    if (iacApplied && planHash !== undefined) {
      await writeArtifact(
        "plan",
        deps.paths.files.plan,
        recorded(deps, change.before, approvals, { iacHash: planHash, any: true }),
      );
      // `--approve <host plan hash>` without options then finishes exactly this change.
      await planned();
      throw halfDone(deps, error, {
        command,
        enabling: change.command === "enable",
        hostname: portainerHostname(plan) ?? portainerHostname(change.before),
        ...(hostHash !== undefined ? { hostHash } : {}),
        written,
      });
    }
    // A host plan was shown: `--approve <its hash>` without options applies exactly this change.
    if (hostHash !== undefined) await planned();
    throw error;
  }

  if (planOnly) {
    await planned();
    return {
      ...(planHash !== undefined ? { planHash } : {}),
      applied: false,
      ...(hostPlanHashValue !== undefined ? { hostPlanHash: hostPlanHashValue } : {}),
      hostApplied: false,
      ...(dataPlanHash !== undefined ? { dataPlanHash } : {}),
      files: written,
      status: await portainerStatusOf(deps, change.before),
    };
  }
  // The change is on the server now: plan.yaml describes it, with the approvals and applies.
  plan = recorded(deps, plan, approvals, {
    ...(iacApplied && planHash !== undefined ? { iacHash: planHash } : {}),
    any: iacApplied || hostApplied,
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await clearPendingPortainer(deps.paths);
  const status = await portainerStatusOf(deps, plan);
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

/** Said when the server's change went first and the tunnel's deletion did not follow (yet). */
const CONNECTOR_GONE =
  "The change on the server is applied (its Cloudflare Tunnel connector is removed); the Cloudflare Tunnel and Access for Portainer are still there.";

/**
 * The error of an infrastructure plan that was refused or failed after this run wrote repository
 * files: it lists them. A refusal (of the infrastructure plan, or of the host plan that goes before
 * a tunnel's deletion) changed nothing in Cloudflare or on the server and says so once, after the
 * files; a failed apply keeps the engine's own words about what happened.
 */
function infrastructureStopped(
  deps: Pick<PhaseDeps, "redactor">,
  error: unknown,
  written: readonly string[],
): unknown {
  if (!(error instanceof OpsCrewError) || written.length === 0) return error;
  const files = `The repository files were written (${written.join(", ")})`;
  if (error instanceof PlanRefusedError) {
    const unchanged = `${files}; nothing in Cloudflare or on the server changed.`;
    return new PlanRefusedError({ ...error.refusal, unchanged }, error);
  }
  return new OpsCrewError(error.code, deps.redactor.redact(`${error.message}\n${files}.`), {
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    cause: error,
  });
}

/**
 * The error of a host step that stopped after the Cloudflare changes were applied: it says what
 * is applied and what is not, how to finish (`--approve <host plan hash>`) or undo it, and which
 * repository files were written. Redacted; never an address or a secret.
 */
function halfDone(
  deps: Pick<PhaseDeps, "redactor">,
  error: unknown,
  input: {
    command: string;
    enabling: boolean;
    hostname: string | undefined;
    hostHash?: string;
    written: readonly string[];
  },
): unknown {
  if (!(error instanceof OpsCrewError)) return error;
  const where = input.hostname !== undefined ? ` for ${input.hostname}` : "";
  const state = input.enabling
    ? "Portainer on the server is not"
    : "Portainer is still on the server";
  const files =
    input.written.length > 0
      ? ` Files written to the repository: ${input.written.join(", ")}.`
      : "";
  const finish =
    input.hostHash !== undefined
      ? `Run \`${input.command} --approve ${input.hostHash}\` to finish`
      : `Run \`${input.command}\` again to finish`;
  return new OpsCrewError(
    error.code,
    deps.redactor.redact(
      `${error.message} The Cloudflare changes${where} (tunnel, Access, DNS) are applied; ${state}.${files}`,
    ),
    {
      hint: deps.redactor.redact(
        `${finish}, or \`opscrew provision\` to ${input.enabling ? "remove them" : "put them back"}.`,
      ),
      cause: error,
    },
  );
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

/**
 * Read-only, before anything changes: Portainer needs Docker Engine 28 or newer on Hetzner and
 * DigitalOcean servers. Before 28, ports published on 127.0.0.1 are reachable from layer-2
 * neighbours (moby/moby#49325), so Portainer's local-only port would not be local. Servers the user
 * owns already get Docker 28 or newer through the host plan.
 */
async function cloudPreflight(deps: PhaseDeps, remote: RemoteExec): Promise<CloudFacts> {
  await requireDocker28(deps, remote);
  return { dataVolume: await portainerDataExists(deps, remote) };
}

/** What the read-only checks found on a Hetzner or DigitalOcean server. */
interface CloudFacts {
  /** Portainer's data volume exists: its admin account was created by an earlier run. */
  dataVolume: boolean;
}

/** Portainer's data volume (Compose project `opscrew-portainer`, volume `portainer_data`). */
const PORTAINER_DATA_VOLUME = "opscrew-portainer_portainer_data";

/**
 * Read-only: whether Portainer's data volume is on the server (as the deploy user). A failure
 * other than "no such volume" stops, so OpsCrew never guesses whether an admin account exists.
 */
async function portainerDataExists(deps: PhaseDeps, remote: RemoteExec): Promise<boolean> {
  let result: Awaited<ReturnType<RemoteExec["run"]>> | undefined;
  try {
    result = await remote.run(
      `docker volume inspect --format '{{.Name}}' ${PORTAINER_DATA_VOLUME}`,
      { timeoutMs: 60_000 },
    );
  } catch {
    result = undefined;
  }
  const exists = result?.exitCode === 0;
  if (!exists && !/no such volume/i.test(result?.stderr ?? "")) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "OpsCrew could not check whether Portainer's data is already on the server, so it did not set up Portainer. Nothing was changed.",
      {
        hint: "Check that the server is reachable over SSH and that Docker is running, then run the command again.",
      },
    );
  }
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "look for Portainer's data volume (read-only)",
    phase: "portainer",
    target: "server",
    decision: "allow",
    detail: exists ? "present" : "absent",
  });
  return exists;
}

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
    phase: "portainer",
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
      `This server runs Docker ${deps.redactor.redact(version.slice(0, 40))}; Portainer needs Docker ${MIN_DOCKER_MAJOR} or newer, which keeps its local-only port truly local. Nothing was changed.`,
      {
        hint: "Upgrade Docker (OpsCrew-created servers get it from Docker's repository from now on), then run the command again.",
      },
    );
  }
}

/**
 * Hetzner and DigitalOcean: the deploy user's add-on plan, with Portainer on (pinned to the plan's
 * version; `needsPassword` when it has no admin account yet) or off, and the tunnel connector of
 * its subdomain when there is one to run or remove.
 */
function cloudPortainerPlan(
  plan: DeployPlan,
  portainer: { enabled: true; needsPassword: boolean } | { enabled: false; deleteData: boolean },
  connector?: Parameters<typeof planPortainer>[0]["connector"],
): HostPlan {
  return planPortainer({
    app: plan.app.name,
    dir: CLOUD_PORTAINER_DIR,
    runAs: "login",
    ...(portainer.enabled
      ? {
          enable: {
            version: plan.portainer?.version ?? PORTAINER_VERSION,
            compose: {
              initial: renderPortainerCompose(plan, { initialAdmin: true }).content,
              final: renderPortainerCompose(plan, { initialAdmin: false }).content,
            },
            needsPassword: portainer.needsPassword,
          },
        }
      : { disable: { deleteData: portainer.deleteData } }),
    ...(connector !== undefined ? { connector } : {}),
  });
}

/** Add-on steps never touch SSH or the firewall, so the adapter never needs a login check. */
const NO_LOGIN_CHECK = async () => true;

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
    /** From {@link cloudPreflight} (enable only). */
    facts: CloudFacts | undefined;
    planOnly: boolean;
    command: string;
    /** Told the host plan's hash as soon as it is shown. */
    shown: (hash: string) => void;
  },
): Promise<HostPlanOutcome> {
  const { plan, outputs } = input;
  const enabling = change.command === "enable";
  // With Portainer's data on the server a password is not required (an admin may exist); the
  // local one is still sent when it is here, so an admin missing after a stopped first start is made.
  const needsPassword = enabling && input.facts?.dataVolume !== true;
  if (enabling && !needsPassword) {
    const file = portainerPasswordFile(deps.paths);
    if (!(await exists(file))) {
      deps.reporter.warn(
        `Portainer's data is already on the server, so its admin account keeps the password it was created with, and that password is not on this computer (${file}). Copy the file from the computer that turned Portainer on, or run \`opscrew portainer disable --delete-data\` and then \`opscrew portainer enable\` again for a new admin account.`,
      );
    }
  }
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
  return approveAndApplyHostPlan(deps, {
    plan: cloudPortainerPlan(
      plan,
      enabling
        ? { enabled: true, needsPassword }
        : { enabled: false, deleteData: change.deleteData },
      connector,
    ),
    remote: input.remote,
    apply: input.services.applyHost ?? applyHostPlan,
    verifyLogin: NO_LOGIN_CHECK,
    server: "the server",
    title: enabling
      ? "Run Portainer on the server as the deploy user"
      : change.deleteData
        ? "Remove Portainer and delete its data on the server"
        : "Remove Portainer from the server (its data stays)",
    upToDate: enabling
      ? "Portainer already runs on the server as planned; nothing on it changes."
      : change.deleteData
        ? "Portainer and its data are no longer on the server; nothing on it changes."
        : "Portainer is no longer on the server; nothing on it changes.",
    command: input.command,
    phase: "portainer",
    allowDestroy: !enabling && change.deleteData,
    planOnly: input.planOnly,
    secrets: async () => {
      // Required only without data; sent whenever it is on this computer (see portainerPasswordToSend).
      const portainerPassword = enabling
        ? await portainerPasswordToSend(deps, needsPassword)
        : undefined;
      return {
        ...(tunnelToken !== undefined ? { tunnelToken } : {}),
        ...(portainerPassword !== undefined ? { portainerPassword } : {}),
      };
    },
    shown: input.shown,
  });
}

/**
 * Hetzner and DigitalOcean: the deploy user's add-on plan that removes the Cloudflare Tunnel
 * connector of a Portainer subdomain the plan no longer has, keeping Portainer as the plan
 * describes it (on and local only, or off with its data kept). It goes before a plan that deletes
 * the tunnel (`opscrew provision`), with its own `host-apply` approval by its hash; with
 * `planOnly` it is only shown and saved. `shown` gets its hash as soon as it is shown.
 */
export async function cloudConnectorRemoval(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    services: PortainerServices;
    command: string;
    planOnly: boolean;
    shown: (hash: string) => void;
  },
): Promise<HostChangeResult> {
  const { plan, services } = input;
  const remote = await deployRemote(deps, services);
  const enabled = plan.portainer?.enabled === true;
  return approveAndApplyHostPlan(deps, {
    plan: cloudPortainerPlan(
      plan,
      // Portainer runs already: its admin account exists.
      enabled ? { enabled: true, needsPassword: false } : { enabled: false, deleteData: false },
      { dir: CLOUD_TUNNEL_DIR, remove: true },
    ),
    remote,
    apply: services.applyHost ?? applyHostPlan,
    verifyLogin: NO_LOGIN_CHECK,
    server: "the server",
    title:
      "Remove the Cloudflare Tunnel connector from the server (Portainer's subdomain is no longer planned)",
    upToDate: "The Cloudflare Tunnel connector is no longer on the server; nothing on it changes.",
    command: input.command,
    phase: "provision",
    planOnly: input.planOnly,
    secrets: async () => {
      const portainerPassword = enabled ? await portainerPasswordToSend(deps, false) : undefined;
      return portainerPassword !== undefined ? { portainerPassword } : {};
    },
    shown: input.shown,
  });
}

/**
 * Runs an enable or disable and records the `portainer` phase: `ok` with `summary` once the change
 * went through (a `--plan-only` run records nothing), `failed` with the reason when it stopped.
 */
async function recordedPhase(
  deps: PhaseDeps,
  planOnly: boolean,
  summary: "Portainer on" | "Portainer off",
  run: () => Promise<PortainerResult>,
): Promise<PortainerResult> {
  try {
    const result = await run();
    if (!planOnly) await deps.state.markPhase("portainer", "ok", summary);
    return result;
  } catch (error) {
    await deps.state.markPhase(
      "portainer",
      "failed",
      isUserFacingError(error) ? deps.redactor.redact(error.message) : undefined,
    );
    throw error;
  }
}

/**
 * `opscrew portainer enable [--subdomain <host> --allow-email <email>…]`: turns Portainer CE on
 * for the project on any target, pinned to {@link PORTAINER_VERSION}, listening only on the
 * server itself. Its admin password is generated on this computer
 * (`~/.opscrew/projects/<id>/portainer_password`, 0600), supplied only at apply and never
 * printed. On a server the user owns it is a host-plan step (`host-apply`); on Hetzner and
 * DigitalOcean it runs as the deploy user. The subdomain opt-in also plans the Cloudflare Tunnel
 * and Access (`iac-apply`) and needs the app's Cloudflare domain and at least one email address.
 * Records the `portainer` phase.
 */
export function portainerEnable(
  deps: PhaseDeps,
  options: PortainerEnableOptions = {},
): Promise<PortainerResult> {
  return recordedPhase(deps, options.planOnly === true, "Portainer on", () =>
    enable(deps, options),
  );
}

/**
 * `opscrew portainer disable [--delete-data]`: removes Portainer (and the tunnel and Access of a
 * subdomain) behind the same approvals. Its data stays unless `deleteData` is set; deleting it is
 * a separate approval that needs the app's name typed to confirm. Records the `portainer` phase.
 */
export function portainerDisable(
  deps: PhaseDeps,
  options: PortainerDisableOptions = {},
): Promise<PortainerResult> {
  return recordedPhase(deps, options.planOnly === true, "Portainer off", () =>
    disable(deps, options),
  );
}

async function enable(deps: PhaseDeps, options: PortainerEnableOptions): Promise<PortainerResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  requireNoMoveInProgress(before);
  if (!hasDeployment(before)) throw noDeployment("enable");
  const approving = (options.approvePlanHashes ?? []).length > 0;
  const pending = approving ? await readPendingPortainer(deps.paths) : undefined;
  if (pending !== undefined && pending.command !== "enable") throw optionsDiffer();
  const flags = options.subdomain !== undefined || (options.allowEmails ?? []).length > 0;
  const fromPending = pending?.settings != null && !flags ? pending.settings : undefined;
  let zone = before.dns.zone;
  if ((options.subdomain !== undefined || fromPending?.hostname !== undefined) && !zone) {
    // A subdomain needs the zone (a bare label like `portainer` too); the Cloudflare check learns it.
    zone = (await setupCloudflare(deps, before, options.services ?? {}))?.zoneName;
  }
  const base = zone === undefined ? before : { ...before, dns: { ...before.dns, zone } };
  // `--approve` without options applies exactly the settings the --plan-only run planned; other
  // options than those are refused.
  const after = withPortainer(base, fromPending ?? portainerSettings(before, options, zone));
  if (pending !== undefined && !sameSettings(pending.settings, after.portainer ?? null)) {
    throw optionsDiffer();
  }
  return runChange(deps, { command: "enable", before, after, deleteData: false }, options);
}

async function disable(
  deps: PhaseDeps,
  options: PortainerDisableOptions,
): Promise<PortainerResult> {
  const before = await readArtifact("plan", deps.paths.files.plan);
  requireNoMoveInProgress(before);
  if (!hasDeployment(before)) throw noDeployment("disable");
  const approving = (options.approvePlanHashes ?? []).length > 0;
  const pending = approving ? await readPendingPortainer(deps.paths) : undefined;
  if (pending !== undefined) {
    if (pending.command !== "disable") throw optionsDiffer();
    if (options.deleteData !== undefined && options.deleteData !== pending.deleteData) {
      throw optionsDiffer();
    }
  }
  const deleteData = pending?.deleteData ?? options.deleteData === true;
  // With `--approve` the planned removal runs even then: it changes nothing when Portainer is gone.
  if (!before.portainer?.enabled && !deleteData && !approving) {
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
