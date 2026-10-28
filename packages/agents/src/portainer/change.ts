import { join } from "node:path";
import type { AddonConnector } from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { EnginePreference } from "@opscrew/iac-engine";
import { keepNewerPins, renderTunnelConnectorCompose, usesTunnel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { builderBranch } from "../environments/branches";
import { type CloudflareSetup, setupCloudflare } from "../provision/credentials";
import { type OwnServerRun, ownEngineEnv, prepareOwnServer } from "../provision/own";
import { findSavedPlan, planAndApply, REMOVAL_PLAN_SUFFIX } from "../provision/plan-apply";
import {
  deploymentFiles,
  deploymentRenderContext,
  type OwnRenderInput,
  readRequirements,
  withCloudflareZone,
} from "../provision/render";
import { applySharedCloudflare, planSharedCloudflare } from "../provision/shared-cloudflare";
import { currentOutputs } from "../provision/steps";
import type { ProvisionServices } from "../provision/types";
import {
  approvalEntry,
  approveAndWriteRenderedFiles,
  committedText,
  diffRenderedFiles,
  ensureDeployKey,
  githubCoordinates,
  type HostAdapterApi,
  hidesServerAddress,
  infrastructureOutputs,
  PlanRefusedError,
  projectEngine,
  readServerAddresses,
  requireGitRepo,
  SshRemoteExec,
  stringOutput,
  writePlanIfChanged,
} from "../shared";
import { connectorFirst, type HostChangeResult, tunnelChange } from "../shared/tunnel-connections";
import { optionsDiffer } from "./pending";
import { CLOUD_TUNNEL_DIR } from "./settings";

/**
 * The flow Portainer's web UI and the add-ons share (`opscrew portainer`, `opscrew addon`): a
 * change on the server that may serve a web UI on a subdomain through the app's Cloudflare Tunnel
 * and Access.
 */

/** Collaborators of a tunnelled change; each defaults to the real implementation. */
export interface TunnelledChangeServices extends ProvisionServices {
  /** Hetzner/DigitalOcean: the deploy user's shell (default: SSH with the deploy key). */
  deployRemote?: (host: string) => RemoteExec;
  /** Hetzner/DigitalOcean: the host adapter's apply (default `applyHostPlan`). */
  applyHost?: HostAdapterApi["apply"];
}

/** Options every tunnelled change takes. */
export interface TunnelledChangeOptions {
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
  services?: TunnelledChangeServices;
}

/** What the host change gets: where it runs, the plan and the infrastructure's outputs. */
export interface HostChangeInput {
  /** A server the user owns: its connection, inspected facts and host adapter. */
  ownRun?: OwnServerRun;
  /** Hetzner/DigitalOcean: the deploy user's shell. */
  remote?: RemoteExec;
  plan: DeployPlan;
  outputs: Record<string, unknown>;
  deployPublicKey: string;
  planOnly: boolean;
  /** Told the host plan's hash as soon as it is shown. */
  shown: (hash: string) => void;
}

/** A change on the server that may involve the app's Cloudflare Tunnel and Access. */
export interface TunnelledChange extends TunnelledChangeOptions {
  /** The command that applies it later, for example `opscrew portainer enable`. */
  command: string;
  phase: "portainer" | "provision";
  /** What changes, in words: `Portainer`, `Beszel`. */
  what: string;
  enabling: boolean;
  before: DeployPlan;
  after: DeployPlan;
  /** The subdomain of the web UI this change is about, in a plan (`portainerHostname`). */
  hostname: (plan: DeployPlan) => string | undefined;
  /**
   * Only the subdomain involves the tunnel (the add-ons): the infrastructure is planned only when
   * it is added, changed or removed. Default: whenever either plan uses a tunnel (Portainer's host
   * plan on an own server runs the connector then, and needs the tunnel's outputs).
   */
  tunnelOnlyForSubdomain?: boolean;
  /** The infrastructure plan's approval title. */
  infrastructureTitle: string;
  /** Read-only checks once the server is reached, before anything changes. */
  preflight?: (target: { ownRun?: OwnServerRun; remote?: RemoteExec }) => Promise<void>;
  /** The change on the server: its host plan shown, approved by its hash and applied. */
  hostChange: (input: HostChangeInput) => Promise<HostChangeResult>;
  /** A further host change once the first is done (Portainer's data deletion on an own server). */
  afterHost?: (input: {
    ownRun?: OwnServerRun;
    plan: DeployPlan;
    planOnly: boolean;
  }) => Promise<HostChangeResult | undefined>;
  /** Saves what was planned, so `--approve` without options applies exactly it. */
  planned: (plan: DeployPlan) => Promise<void>;
}

/** What a tunnelled change did. Never holds a secret. */
export interface TunnelledChangeResult {
  /** The infrastructure plan's hash (tunnel and Access), when the change needed one. */
  planHash?: string;
  /** The Cloudflare plan's hash of OpsCrew's shared resources, when it has changes. */
  cloudflarePlanHash?: string;
  /** True when this run applied the infrastructure plan. */
  applied: boolean;
  /** The host plan's hash (`.opscrew/plans/host-<hash>.json`). */
  hostPlanHash?: string;
  /** True when this run changed the server. */
  hostApplied: boolean;
  /** The hash of the further host change ({@link TunnelledChange.afterHost}). */
  afterHostPlanHash?: string;
  /** Repository files this run wrote. */
  files: string[];
  /** `opscrew/plan.yaml` as written once the change is done; absent when it is not done yet. */
  plan?: DeployPlan;
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
 * Renders the deployment files for the changed plan (the runbook's section, and the tunnel and
 * Access modules for a subdomain) with the same inputs provision uses, plus the id of the one-time
 * PIN login the Access application uses (from the Cloudflare plan applied first). Writes the
 * changed files after a `repo-write` approval (not when a saved plan is applied: its run wrote
 * them).
 */
async function renderChange(
  deps: PhaseDeps,
  change: Pick<TunnelledChange, "after" | "what">,
  input: {
    ownRun?: OwnServerRun;
    deployPublicKey: string;
    write: boolean;
    cloudflare: CloudflareSetup | undefined;
    oneTimePinId: string | undefined;
  },
): Promise<{ plan: DeployPlan; files: ReturnType<typeof deploymentFiles>; written: string[] }> {
  const root = deps.paths.root;
  const git = await requireGitRepo(deps);
  const github = await githubCoordinates(git);
  const { cloudflare } = input;
  const plan = withCloudflareZone(change.after, cloudflare);
  const own: OwnRenderInput = {
    ...(input.ownRun ? { sshPort: input.ownRun.sshPort } : {}),
    ...(input.oneTimePinId !== undefined
      ? { oneTimePinIdentityProviderId: input.oneTimePinId }
      : {}),
  };
  const server =
    plan.target.provider === "own" || hidesServerAddress(plan)
      ? undefined
      : (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  const ctx = await deploymentRenderContext(deps, {
    plan,
    builderBranch: await builderBranch(deps.paths, plan),
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
    what: `the deployment files for ${change.what}`,
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
    approvals: [...plan.approvals, ...approvals.map(approvalEntry)],
    deployment: {
      ...plan.deployment,
      ...(applied.iacHash !== undefined ? { lastPlanHash: applied.iacHash } : {}),
      ...(applied.any ? { lastApplyAt: now } : {}),
    },
  };
}

/**
 * Runs a tunnelled change: with a subdomain involved, the Cloudflare plan of OpsCrew's shared
 * resources (`cloudflare-apply` by its hash) → render (when a subdomain is involved) →
 * infrastructure plan, policies, `iac-apply` approval and apply when a tunnel is involved → host
 * plan, `host-apply` approval and apply → the further host change (`afterHost`) →
 * `opscrew/plan.yaml` updated. When the infrastructure plan deletes the tunnel, both plans are
 * approved first, then the host plan (which removes the connector) is applied, then OpsCrew waits
 * until Cloudflare reports no active connections for the tunnel, and only then applies the
 * infrastructure plan. A change not done yet (planned only, or waiting for an approval) calls
 * `planned` and returns no `plan`.
 */
export async function runTunnelledChange(
  deps: PhaseDeps,
  change: TunnelledChange,
): Promise<TunnelledChangeResult> {
  const services = change.services ?? {};
  const planOnly = change.planOnly === true;
  const { command, phase, what } = change;
  const own = change.before.target.provider === "own";
  const subdomainInvolved =
    change.hostname(change.before) !== undefined || change.hostname(change.after) !== undefined;
  const tunnelInvolved =
    change.tunnelOnlyForSubdomain === true
      ? subdomainInvolved
      : usesTunnel(change.before) || usesTunnel(change.after);
  const approvals: ApprovalRecord[] = [];

  const deployKey = await ensureDeployKey(deps.paths, deps.redactor);
  const approveHash = await savedInfrastructureHash(
    deps,
    change.before,
    change.approvePlanHashes ?? [],
  );

  // A server the user owns: connect (pinned host key), inspect read-only, stop on blockers.
  let ownRun: OwnServerRun | undefined;
  if (own) {
    ownRun = await prepareOwnServer(deps, {
      plan: change.after,
      options: {
        ...(change.hostKey !== undefined ? { hostKey: change.hostKey } : {}),
        ...(change.planOnly === true ? { planOnly: true } : {}),
      },
      services,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      deployKeyFile: deployKey.privateKeyFile,
      phase,
      command,
    });
  }
  // Hetzner/DigitalOcean: the deploy user's shell.
  let cloudRemote: RemoteExec | undefined;
  if (!own) cloudRemote = await deployRemote(deps, services);
  await change.preflight?.({
    ...(ownRun !== undefined ? { ownRun } : {}),
    ...(cloudRemote !== undefined ? { remote: cloudRemote } : {}),
  });

  // OpsCrew's shared Cloudflare change (only a subdomain involves Cloudflare) before anything
  // changes: the account's Zero Trust organization and one-time PIN login for the Access
  // application, and the app's hostnames in OpsCrew's rules; shown, approved by its hash, applied
  // and recorded.
  const cloudflare = subdomainInvolved
    ? await setupCloudflare(deps, change.after, services)
    : undefined;
  let oneTimePinId: string | undefined;
  let cloudflareHash: { cloudflarePlanHash?: string } = {};
  const sharedPlans =
    cloudflare === undefined
      ? undefined
      : await planSharedCloudflare(deps, { services, plan: change.after, cloudflare, command });
  if (sharedPlans !== undefined) {
    const shared = await applySharedCloudflare(deps, sharedPlans, {
      app: change.after.app.name,
      planOnly,
      command,
      phase,
    });
    approvals.push(...shared.approvals);
    oneTimePinId = shared.oneTimePinId;
    const { cloudflarePlanHash } = shared.fields;
    if (cloudflarePlanHash !== undefined) cloudflareHash = { cloudflarePlanHash };
    if (shared.infrastructureWaits) {
      // `--approve <its hash>` without options then applies exactly this change.
      await change.planned(change.after);
      return { ...cloudflareHash, applied: false, hostApplied: false, files: [] };
    }
  }

  // Render: only a subdomain (added, changed or removed) changes the infrastructure code. The
  // runbook's section follows with the next `opscrew verify`, which writes the runbook.
  let plan = change.after;
  let files: ReturnType<typeof deploymentFiles> = [];
  const written: string[] = [];
  if (subdomainInvolved) {
    const rendered = await renderChange(deps, change, {
      ...(ownRun !== undefined ? { ownRun } : {}),
      deployPublicKey: deployKey.publicKeyOpenSsh,
      write: approveHash === undefined,
      cloudflare,
      oneTimePinId,
    });
    plan = rendered.plan;
    files = rendered.files;
    written.push(...rendered.written);
  }
  // `opscrew/plan.yaml` changes only once the change is on the server (see the end).
  const planned = (): Promise<void> => change.planned(plan);

  // The change on the server. It normally follows the infrastructure apply (it may need the
  // tunnel's id); when the infrastructure plan deletes the tunnel it goes first, because Cloudflare
  // refuses to delete a tunnel whose connector still runs. `hostHash` names its plan as soon as it
  // is shown; a refusal says to approve it later with this command, which finishes the change.
  let hostHash: string | undefined;
  const shown = (hash: string) => {
    hostHash = hash;
  };
  const hostChange = (
    outputs: Record<string, unknown>,
    hostPlanOnly: boolean,
  ): Promise<HostChangeResult> =>
    change.hostChange({
      ...(ownRun !== undefined ? { ownRun } : {}),
      ...(cloudRemote !== undefined ? { remote: cloudRemote } : {}),
      plan,
      outputs,
      deployPublicKey: deployKey.publicKeyOpenSsh,
      planOnly: hostPlanOnly,
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
      ...(change.engine !== undefined ? { preference: change.engine } : {}),
      services,
    });
    // Applying a plan that deletes the tunnel: the server first, then the wait, then the deletion.
    const first = connectorFirst(deps, {
      command,
      app: plan.app.name,
      where: ownRun ? "on your server" : "on the server",
      hostChange: () => hostChange({}, false),
      hostHash: () => hostHash,
      done: connectorGone(what),
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
        phase,
        costDelta: null,
        approvalTitle: change.infrastructureTitle,
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
        ...cloudflareHash,
        applied: false,
        ...(shownFirst !== undefined ? { hostPlanHash: shownFirst.hash } : {}),
        hostApplied: false,
        files: written,
      };
    }
    outputs = await currentOutputs(result, inner, join(deps.paths.root, plan.infra.dir), env);
  }

  // The server (unless its change went first, before the tunnel's deletion).
  let hostPlanHashValue: string | undefined;
  let hostApplied = false;
  let afterHostPlanHash: string | undefined;
  try {
    const host = early ?? (await hostChange(outputs, planOnly));
    hostPlanHashValue = host.hash;
    hostApplied = host.applied;
    if (host.approval) approvals.push(host.approval);
    const further = await change.afterHost?.({
      ...(ownRun !== undefined ? { ownRun } : {}),
      plan,
      planOnly,
    });
    if (further !== undefined) {
      afterHostPlanHash = further.hash;
      hostApplied ||= further.applied;
      if (further.approval) approvals.push(further.approval);
    }
  } catch (error) {
    // The server did not get the change: plan.yaml keeps the earlier settings, and only an
    // infrastructure apply that already happened is recorded (so its hash is not applied again).
    if (iacApplied && planHash !== undefined) {
      await writePlanIfChanged(
        deps,
        recorded(deps, change.before, approvals, { iacHash: planHash, any: true }),
      );
      // `--approve <host plan hash>` without options then finishes exactly this change.
      await planned();
      throw halfDone(deps, error, {
        command,
        what,
        enabling: change.enabling,
        hostname: change.hostname(plan) ?? change.hostname(change.before),
        ...(hostHash !== undefined ? { hostHash } : {}),
        written,
      });
    }
    // A host plan was shown: `--approve <its hash>` without options applies exactly this change.
    if (hostHash !== undefined) await planned();
    throw error;
  }

  const fields = {
    ...(planHash !== undefined ? { planHash } : {}),
    ...cloudflareHash,
    ...(hostPlanHashValue !== undefined ? { hostPlanHash: hostPlanHashValue } : {}),
    ...(afterHostPlanHash !== undefined ? { afterHostPlanHash } : {}),
  };
  if (planOnly) {
    await planned();
    return { ...fields, applied: false, hostApplied: false, files: written };
  }
  // The change is on the server now: plan.yaml describes it, with the approvals and applies.
  plan = recorded(deps, plan, approvals, {
    ...(iacApplied && planHash !== undefined ? { iacHash: planHash } : {}),
    any: iacApplied || hostApplied,
  });
  await writePlanIfChanged(deps, plan);
  return { ...fields, applied: iacApplied, hostApplied, files: written, plan };
}

/** Said when the server's change went first and the tunnel's deletion did not follow (yet). */
function connectorGone(what: string): string {
  return `The change on the server is applied (its Cloudflare Tunnel connector is removed); the Cloudflare Tunnel and Access for ${what} are still there.`;
}

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
    what: string;
    enabling: boolean;
    hostname: string | undefined;
    hostHash?: string;
    written: readonly string[];
  },
): unknown {
  if (!(error instanceof OpsCrewError)) return error;
  const where = input.hostname !== undefined ? ` for ${input.hostname}` : "";
  const state = input.enabling
    ? `${input.what} on the server is not`
    : `${input.what} is still on the server`;
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
export async function deployRemote(
  deps: PhaseDeps,
  services: Pick<TunnelledChangeServices, "deployRemote">,
): Promise<RemoteExec> {
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

/** Add-on steps never touch SSH or the firewall, so the adapter never needs a login check. */
export const NO_LOGIN_CHECK = async () => true;

/**
 * Hetzner and DigitalOcean: the Cloudflare Tunnel connector that serves `whose` subdomain
 * (`Portainer's`, `Beszel's`), run as the deploy user in {@link CLOUD_TUNNEL_DIR} with the newer
 * pins of its committed Compose file, and its token from the infrastructure's outputs (registered
 * with the redactor; it goes to the server on stdin only).
 */
export async function cloudTunnelConnector(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: DeployPlan,
  outputs: Record<string, unknown>,
  input: { command: string; whose: string },
): Promise<{ connector: AddonConnector; tunnelToken: string }> {
  const tunnelId = stringOutput(outputs, "tunnel_id");
  const tunnelToken = stringOutput(outputs, "tunnel_token");
  if (tunnelToken !== undefined) deps.redactor.addLiteral(tunnelToken, "tunnel-token");
  if (tunnelId === undefined || tunnelToken === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The infrastructure state has no Cloudflare Tunnel id or token, so OpsCrew cannot start the tunnel connector for ${input.whose} subdomain.`,
      { hint: `Run \`${input.command}\` again; it plans what is missing.` },
    );
  }
  const rendered = renderTunnelConnectorCompose(plan);
  return {
    connector: {
      dir: CLOUD_TUNNEL_DIR,
      compose: keepNewerPins(
        await committedText(deps.paths.root, [rendered.path]),
        rendered.content,
      ),
      tunnelId,
      needsToken: true,
    },
    tunnelToken,
  };
}
