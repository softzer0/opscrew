/**
 * `opscrew secure --close-public-ssh` and `--open-public-ssh` (feature 018, US4, FR-1815,
 * FR-1816): once the deploys run inside the private network and this computer is a device on it,
 * SSH can answer on the network only. Closing and opening are plans approved by their hashes: the
 * infrastructure plan for the cloud firewalls (with the workflow and the check rendered again and
 * delivered in the deploy-setup pull request, as provision does), and a `public-ssh` host plan per
 * server, under the host adapter's automatic undo of SSH and firewall changes.
 */
import { planPublicSsh } from "@opscrew/connector-ssh-host";
import { listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { type DeployPlan, networkInterface, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { readNetwork } from "../network";
import { runProvision } from "../provision/run";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";
import {
  approvalEntry,
  type HostPlanOutcome,
  readServerAddresses,
  reopenedPlan,
  serverLogin,
  serverRemote,
  TUNNEL_DOWN_HINT,
  writePlanIfChanged,
} from "../shared";
import { approveAndApplyHostPlan } from "../shared/host-plan";
import { handshakeText, notReadText } from "../status/network";
import { deviceServers, networkServer, requireServers, type VpnServices } from "../vpn/servers";

/** The phase the host plans are audited under. */
const PHASE = "secure";

/** The services of closing and opening public SSH; each defaults to the real one, fakes in tests. */
export interface PublicSshServices extends Pick<VpnServices, "remote" | "host" | "readWireGuard"> {
  /**
   * The infrastructure plan, the workflow and the check rendered again, and the deploy-setup pull
   * request (default `runProvision`).
   */
  provision?: (deps: PhaseDeps, options: ProvisionOptions) => Promise<ProvisionResult>;
}

/** The options of {@link closePublicSsh} and {@link openPublicSsh}. */
export interface PublicSshOptions {
  /** Every hash given with `--approve`: the infrastructure plan's and each host plan's. */
  approveHashes?: readonly string[];
  services?: PublicSshServices;
}

/** What closing or opening public SSH did. */
export interface PublicSshResult {
  /** Public SSH is open after this run, as `opscrew/plan.yaml` says. */
  open: boolean;
  /** Provision's outcome (the infrastructure plan's hash among it); none when it did not run. */
  provision?: ProvisionResult;
  /** The `public-ssh` host plans' hashes, one per server with a public address, `app` first. */
  hostPlanHashes: string[];
  /** True when this run changed a server's firewall. */
  hostApplied: boolean;
}

/** A condition of closing public SSH that is not met, and how to meet it. */
interface Missing {
  condition: string;
  fix: string;
}

/**
 * The conditions of closing public SSH that are not met (FR-1815): the environment's deploys run
 * on the server's own runner (or this computer's, when it is a device), this computer is a device
 * on the app's network, and its device's link had a handshake in the last three minutes on every
 * server with a public address (`readNetwork`).
 */
async function missingConditions(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: PublicSshServices,
): Promise<Missing[]> {
  const missing: Missing[] = [];
  const environment = deps.paths.environment;
  const runner = plan.environment?.runner ?? "github";
  if (runner !== "server" && runner !== "local") {
    missing.push({
      condition:
        runner === "github"
          ? "the deploys run on GitHub's machines, outside the private network, and reach the servers over public SSH"
          : "the deploys run on a runner machine outside the private network, and reach the servers over public SSH",
      fix: `Run them on the server's own runner: \`opscrew env set ${environment} --runner server\`, then \`opscrew provision\`.`,
    });
  }
  const device = (await readServerAddresses(deps.paths)).thisDevice;
  if (device === undefined || !plan.network?.devices.some((d) => d.name === device)) {
    missing.push({
      condition:
        "this computer is not a device on the app's private network, so OpsCrew could not reach the servers once public SSH is closed",
      fix: "Add it with `opscrew vpn add <name> --this-computer` and turn its WireGuard tunnel on.",
    });
    return missing;
  }
  deps.reporter.step("Reading this computer's tunnel on each server (read-only)");
  const links = await readNetwork(deps, plan, {
    ...(services.remote !== undefined ? { remote: services.remote } : {}),
    ...(services.readWireGuard !== undefined ? { readWireGuard: services.readWireGuard } : {}),
  });
  const stale = deviceServers(plan).flatMap((server) => {
    const link = links.find((l) => l.from === server && l.kind === "device" && l.to === device);
    if (link?.up === true) return [];
    if (link === undefined) return [`server ${server}: not on the network`];
    return [
      `server ${server}: ${link.reason !== undefined ? notReadText(link) : handshakeText(link)}`,
    ];
  });
  if (stale.length > 0) {
    missing.push({
      condition: `this computer's tunnel (device ${device}) had no handshake in the last 3 minutes with every server (${stale.join("; ")})`,
      fix: "Turn the WireGuard tunnel on (your WireGuard app, or `sudo wg show` in a terminal, lists it with a recent handshake) and check it with `opscrew vpn list`.",
    });
  }
  return missing;
}

/**
 * Proves, before anything changes, that SSH answers each server with a public address over the
 * private network (`closed`, the plan with public SSH closed): a new login running `true`, which
 * also pins each host key under the server's private address.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the servers that did not answer.
 */
async function requireNetworkSsh(deps: PhaseDeps, closed: DeployPlan): Promise<void> {
  const silent: string[] = [];
  for (const name of deviceServers(closed)) {
    const remote = await serverRemote(deps, closed, name, { fresh: true });
    const result = await remote.run("true", { timeoutMs: 30_000 }).catch(() => undefined);
    if (result?.exitCode !== 0) silent.push(`server ${name}`);
  }
  if (silent.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew could not log in to ${listText(silent)} over the app's private network, so closing public SSH would cut this computer off. Nothing was changed.`,
    {
      hint: `${TUNNEL_DOWN_HINT} If the tunnel is on, run \`opscrew provision\` first: it lets SSH in on the network's interface on each server.`,
    },
  );
}

/** `plan` with public SSH closed: the allow-list kept, then emptied on every server. */
function closedPlan(plan: DeployPlan): DeployPlan {
  const network = plan.network as NonNullable<DeployPlan["network"]>;
  if (network.publicSsh === false) return plan;
  return {
    ...plan,
    network: {
      ...network,
      publicSsh: false,
      publicSshAllowedCidrs: [...plan.security.sshAllowedCidrs],
    },
    security: { ...plan.security, sshAllowedCidrs: [] },
  };
}

/**
 * Provision, for the cloud firewalls, the workflow, the check and the deploy-setup pull request.
 * When it stops, its hint says how to finish (`then`).
 */
async function provisionStep(
  deps: PhaseDeps,
  options: PublicSshOptions,
  then: string,
): Promise<ProvisionResult> {
  const provision = options.services?.provision ?? runProvision;
  try {
    return await provision(deps, {
      ...(options.approveHashes !== undefined ? { approveHashes: options.approveHashes } : {}),
    });
  } catch (error) {
    if (!(error instanceof OpsCrewError)) throw error;
    throw new OpsCrewError(error.code, error.message, {
      hint: error.hint === undefined ? upperFirst(then) : `${error.hint} Then ${then}`,
      cause: error,
    });
  }
}

/**
 * Each server with a public address, `app` first: its `public-ssh` host plan (`planPublicSsh`),
 * reached and inspected over the private network (`closed`, the plan with public SSH closed), shown
 * with the server's name, approved by its own hash and applied under the automatic undo, whose new
 * login goes over the private network too. Closing removes the public rules for the port sshd
 * listens on; opening puts them back for `allowedCidrs`, which the approval's details name (never
 * its title, which is audited).
 */
async function publicSshPlans(
  deps: PhaseDeps,
  closed: DeployPlan,
  input: { open: boolean; allowedCidrs: string[]; command: string; services: PublicSshServices },
): Promise<HostPlanOutcome[]> {
  const network = closed.network as NonNullable<DeployPlan["network"]>;
  const outcomes: HostPlanOutcome[] = [];
  for (const name of deviceServers(closed)) {
    const member = network.members.find((m) => m.name === name);
    if (member === undefined) throw new Error(`Server "${name}" is not on the private network.`);
    const login = await serverLogin(deps, closed, name);
    const server = await networkServer(deps, closed, name, input.services);
    const hostPlan = planPublicSsh(
      server.facts,
      {
        app: closed.app.name,
        publicSsh: {
          open: input.open,
          interface: networkInterface(member),
          allowedCidrs: input.allowedCidrs,
          sshPort: server.sshPort,
          cloudServer: !login.own,
        },
      },
      input.command,
    );
    const { rootImage } = server;
    const where = `server ${name}`;
    outcomes.push(
      await approveAndApplyHostPlan(deps, {
        plan: hostPlan,
        remote: server.remote,
        apply: (remote, p, options) =>
          server.apply(remote, p, rootImage === undefined ? options : { ...options, rootImage }),
        verifyLogin: async () => {
          const fresh = await serverRemote(deps, closed, name, { fresh: true });
          const result = await fresh.run("true", { timeoutMs: 30_000 }).catch(() => undefined);
          return result?.exitCode === 0;
        },
        title: input.open
          ? `Open SSH on server ${name} again`
          : `Close public SSH on server ${name}`,
        ...(input.open
          ? {
              intro: [
                `OpsCrew opens SSH on server ${name} to ${listText(input.allowedCidrs)} again, the allow-list the plan held before public SSH closed.`,
              ],
            }
          : {}),
        server: where,
        planOf: where,
        upToDate: input.open
          ? `SSH is open on server ${name} already.`
          : `Public SSH is closed on server ${name} already.`,
        command: input.command,
        phase: PHASE,
        secrets: async () => ({}),
      }),
    );
  }
  return outcomes;
}

/** `plan` with the approvals of the host plans approved this run. */
function withApprovals(plan: DeployPlan, outcomes: readonly HostPlanOutcome[]): DeployPlan {
  const approvals = outcomes.flatMap((o) => (o.approval ? [approvalEntry(o.approval)] : []));
  return approvals.length === 0 ? plan : { ...plan, approvals: [...plan.approvals, ...approvals] };
}

/** The command as the user runs it again: `opscrew secure --close-public-ssh --env staging`. */
async function commandOf(deps: PhaseDeps, flag: "--close-public-ssh" | "--open-public-ssh") {
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  return `opscrew secure ${flag}${flags}`;
}

/** True when the app has a server OpsCrew created, whose cloud firewall provision changes. */
function hasCloudServer(plan: DeployPlan): boolean {
  return (
    plan.target.provider !== "own" ||
    (plan.servers ?? []).some((server) => server.target.provider !== "own")
  );
}

/**
 * `opscrew secure --close-public-ssh`: SSH answers only on the app's private network.
 * - Refuses before any change, with each condition that is not met and its fix: the deploys run
 *   on the server's own runner, this computer is a device on the network, and its device's link
 *   had a handshake in the last three minutes on every server with a public address.
 * - Proves, still before any change, that SSH answers each of them over the private network, and
 *   pins each host key under its private address.
 * - Writes `opscrew/plan.yaml` with `network.publicSsh: false` and `security.sshAllowedCidrs: []`,
 *   keeping the allow-list it held in `network.publicSshAllowedCidrs`.
 * - Runs provision: the infrastructure plan that closes SSH in the cloud firewalls, the workflow
 *   and the check rendered for the private network, in the deploy-setup pull request.
 * - Then each server's `public-ssh` host plan, over the private network, approved by its hash.
 *
 * Running it again after a stop continues where it stopped.
 */
export async function closePublicSsh(
  deps: PhaseDeps,
  options: PublicSshOptions = {},
): Promise<PublicSshResult> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);
  requireServers(plan);
  const command = await commandOf(deps, "--close-public-ssh");
  const missing = await missingConditions(deps, plan, services);
  if (missing.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew can't close public SSH yet: ${listText(missing.map((m) => m.condition))}. Nothing was changed.`,
      { hint: `${missing.map((m) => m.fix).join(" ")} Then run \`${command}\` again.` },
    );
  }
  const closed = closedPlan(plan);
  await requireNetworkSsh(deps, closed);
  await writePlanIfChanged(deps, closed);
  const provision = await provisionStep(
    deps,
    options,
    `run \`${command}\` again to finish closing.`,
  );
  const outcomes = await publicSshPlans(deps, closed, {
    open: false,
    allowedCidrs: [],
    command,
    services,
  });
  // Provision may have recorded its own approvals: the plan is read again before adding these.
  const current = await readArtifact("plan", deps.paths.files.plan);
  await writePlanIfChanged(deps, withApprovals(current, outcomes));
  deps.reporter.success(
    "Public SSH is closed: SSH answers only on the app's private network, and OpsCrew connects to the servers there.",
  );
  return {
    open: false,
    provision,
    hostPlanHashes: outcomes.map((o) => o.hash),
    hostApplied: outcomes.some((o) => o.applied),
  };
}

/**
 * `opscrew secure --open-public-ssh`: the reverse of {@link closePublicSsh}. Each server's
 * `public-ssh` host plan opens SSH again, over the private network, to the allow-list the plan
 * held before it closed (`reopenedPlan`); then `opscrew/plan.yaml` says public SSH is open with
 * that allow-list, and provision runs its infrastructure plan for the cloud firewalls and renders
 * the workflow and the check again, in the deploy-setup pull request. While the plan says public
 * SSH is open already, only provision runs, for an app with a cloud server (an earlier run may
 * have stopped before its cloud firewalls opened); nothing for one on the user's own servers.
 */
export async function openPublicSsh(
  deps: PhaseDeps,
  options: PublicSshOptions = {},
): Promise<PublicSshResult> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);
  requireServers(plan);
  const finish = "run `opscrew provision` to open SSH in the cloud firewalls.";
  if (plan.network?.publicSsh !== false) {
    if (!hasCloudServer(plan)) {
      deps.reporter.info("Public SSH is open already; nothing was changed.");
      return { open: true, hostPlanHashes: [], hostApplied: false };
    }
    deps.reporter.info(
      "Public SSH is open on the servers as opscrew/plan.yaml says; provision checks the cloud firewalls follow it.",
    );
    const provision = await provisionStep(deps, options, finish);
    return { open: true, provision, hostPlanHashes: [], hostApplied: false };
  }
  const command = await commandOf(deps, "--open-public-ssh");
  const open = reopenedPlan(plan);
  const outcomes = await publicSshPlans(deps, plan, {
    open: true,
    allowedCidrs: open.security.sshAllowedCidrs,
    command,
    services,
  });
  await writePlanIfChanged(deps, withApprovals(open, outcomes));
  const provision = await provisionStep(deps, options, finish);
  deps.reporter.success(
    `Public SSH is open again to ${listText(open.security.sshAllowedCidrs)}, as opscrew/plan.yaml says.`,
  );
  return {
    open: true,
    provision,
    hostPlanHashes: outcomes.map((o) => o.hash),
    hostApplied: outcomes.some((o) => o.applied),
  };
}
