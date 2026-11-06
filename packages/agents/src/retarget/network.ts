/**
 * A move of an app with a private network (feature 023, plan.md "7."): only its app server moves.
 * - **start:** the old `app` member is kept in `retarget.from.member`, and a new `app` member is
 *   written (a new address, a new key made on this computer);
 * - **step `created`:** a host plan on the new app server, each extra server and the monitoring
 *   server another environment owns adds the new member, each approved by its hash, while the old
 *   one stays a peer (`previous`);
 * - **step `deployed`:** the monitoring's host plans for the new app server (the stack with
 *   `where: app`, Alloy sending to the stack wherever it runs);
 * - **`--finish`:** the old member leaves; **`--abort`:** the new one does, and the old one is
 *   `app` again.
 */
import {
  applyHostPlan,
  type HostPlan,
  hostPlanHash,
  inspectHost,
  otherActiveApps,
} from "@opscrew/connector-ssh-host";
import { OpsCrewError, plural } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  monitoringOf,
  type Network,
  type NetworkMember,
  networkInterface,
  readArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  moveAppMember,
  type NetworkHostFacts,
  networkHostPlan,
  PREVIOUS_MEMBER,
  publicEndpoints,
} from "../network";
import { monitoringOwner } from "../network/owner";
import { monitoringHostPlans } from "../provision/monitoring";
import type { NetworkServer } from "../provision/network";
import { serverForNetwork } from "../provision/servers";
import { approveAndApplyHostPlan, boundHostAdapter, readValidJson } from "../shared";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import { connectAndInspectOwnServer } from "../shared/own-server";
import { networkSshPort } from "../shared/server-address";
import { extraServers } from "../shared/servers";
import { oldSideTarget } from "./layouts";
import type { MoveServer } from "./removal";
import { oldServer } from "./servers";
import { auditMove, type MoveSession, moveOf, newServer, remoteFor } from "./session";
import { sideTarget, sideWords } from "./sides";
import { pendingStop } from "./steps";
import type { RetargetResult } from "./types";

/** What a move's start writes of the private network. */
export interface StartedNetwork {
  /** The network with the new `app` member. */
  network: Network;
  /** The old app server's member (`retarget.from.member`), which leaves at `--finish`. */
  member: NetworkMember;
  /** The new member's private key, for the generated values once the move is recorded. */
  privateKey: string;
}

/**
 * The network of a move's start: the `app` member replaced by a new one (`moveAppMember`, with the
 * new side's `facts` when it is the user's own server), the old one returned as `member`.
 */
export function startNetwork(network: Network, facts?: NetworkHostFacts): StartedNetwork {
  const member = network.members.find((m) => m.name === APP_SERVER);
  if (member === undefined) throw new Error("The private network has no app member.");
  const fresh = moveAppMember(network, facts);
  return {
    network: {
      ...network,
      members: network.members.map((m) => (m.name === APP_SERVER ? fresh.member : m)),
    },
    member,
    privateKey: fresh.privateKey,
  };
}

/** The network as it was before the move: the old app server's member as `app` again. */
export function networkBeforeMove(plan: DeployPlan): Network | undefined {
  const member = plan.retarget?.from.member;
  if (plan.network === undefined || member === undefined) return plan.network;
  return {
    ...plan.network,
    members: plan.network.members.map((m) => (m.name === APP_SERVER ? member : m)),
  };
}

/** The generated values' network keys, by member. */
async function networkKeys(deps: Pick<PhaseDeps, "paths">): Promise<Record<string, string>> {
  return (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.network ?? {};
}

/**
 * Records the new `app` member's private key in the generated values once the move is recorded,
 * keeping the old app server's key as `previous` until the move ends.
 */
export async function recordMoveKey(
  deps: Pick<PhaseDeps, "paths">,
  privateKey: string,
): Promise<void> {
  const { app } = await networkKeys(deps);
  await recordGeneratedEntries(deps, "network", {
    [APP_SERVER]: privateKey,
    ...(app !== undefined ? { [PREVIOUS_MEMBER]: app } : {}),
  });
}

/**
 * The generated values' keys when the move ends: after `--finish` the old app server's key goes;
 * after `--abort` it is `app`'s again.
 */
export async function endMoveKey(
  deps: Pick<PhaseDeps, "paths">,
  ended: "finished" | "aborted",
): Promise<void> {
  const previous = (await networkKeys(deps))[PREVIOUS_MEMBER];
  if (previous === undefined) return;
  await recordGeneratedEntries(deps, "network", {
    [PREVIOUS_MEMBER]: undefined,
    ...(ended === "aborted" ? { [APP_SERVER]: previous } : {}),
  });
}

/**
 * One side's app server as the network's and the monitoring's host plans reach it, inspected
 * read-only now: on the user's own its admin login (`own` for the new side, `fromOwn` for the old
 * one), on one OpsCrew created the deploy user's shell at the move's address of that side, root
 * through Docker in the pinned Caddy image.
 */
export async function sideServer(session: MoveSession, which: MoveServer): Promise<NetworkServer> {
  const { deps, services, plan } = session;
  const target = sideTarget(session, which);
  const words = sideWords(target, which);
  // The network's steps change no SSH setting the host adapter guards.
  const verifyLogin = async () => true;
  if (target.provider === "own") {
    const own = services.own ?? {};
    const adapter = boundHostAdapter(own.host);
    const { session: ssh, facts } = await connectAndInspectOwnServer(deps, {
      services: { ...own, host: adapter },
      phase: "retarget",
      login: which === "new" ? "own" : "fromOwn",
      detail: "for the private network",
    });
    return {
      name: APP_SERVER,
      remote: ssh.remote,
      facts,
      apply: adapter.apply,
      verifyLogin,
      sshPort: networkSshPort(facts, ssh.connection.port),
      alone: otherActiveApps(facts.apps, plan.app.name).length === 0,
    };
  }
  const address = which === "new" ? newServer(session) : oldServer(session);
  const remote = remoteFor(deps, services, session.deployKey.privateKeyFile, address.ipv4);
  const host = services.serverHost ?? { inspect: inspectHost, apply: applyHostPlan };
  const rootImage = IMAGES.caddy.ref;
  deps.reporter.step(`Inspecting ${words} (read-only)`);
  const facts = await host.inspect(remote, { rootImage });
  await auditMove(session, {
    kind: "remote-exec",
    action: "inspect host as deploy (read-only)",
    target: words,
    decision: "allow",
  });
  return {
    name: APP_SERVER,
    remote,
    facts,
    apply: (shell, applied, options) => host.apply(shell, applied, { ...options, rootImage }),
    verifyLogin,
    sshPort: networkSshPort(facts, 22),
    alone: true,
  };
}

/**
 * The network's other servers than the app's, as their host plans reach them: each extra server,
 * and the monitoring server another environment owns, with that environment's login.
 */
async function otherServers(session: MoveSession, plan: DeployPlan): Promise<NetworkServer[]> {
  const { deps } = session;
  const reach = {
    services: session.services,
    phase: "retarget",
    ownRun: undefined,
    extraOwn: [],
  } as const;
  const servers: NetworkServer[] = [];
  for (const name of extraServers(plan)) {
    servers.push(await serverForNetwork(deps, { ...reach, plan }, name));
  }
  const owner = monitoringOwner(deps.paths, plan);
  if (owner !== undefined) {
    const ownerPlan = await readArtifact("plan", owner.paths.files.plan);
    servers.push(
      await serverForNetwork(
        { ...deps, paths: owner.paths },
        { ...reach, plan: ownerPlan },
        owner.server,
      ),
    );
  }
  return servers;
}

/**
 * Each server's private network host plan for `plan` with `endpoints` (`networkHostPlan`), in
 * `servers`' order, shown with the server's name and approved by its own hash. A server gets its
 * private key only when it lacks it or holds another. A script stops at the first plan with
 * changes that `--approve` does not name, with its hash; `beforeChange` runs before a plan with
 * changes is asked for.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before that server's plan is shown, when it needs its
 * key and this computer does not have it.
 */
async function applyNetworkPlans(
  session: MoveSession,
  plan: DeployPlan,
  servers: readonly NetworkServer[],
  endpoints: Readonly<Record<string, string>>,
  beforeChange?: () => Promise<void>,
): Promise<RetargetResult | undefined> {
  const { deps, command } = session;
  const keys = await networkKeys(deps);
  for (const server of servers) {
    const { name, facts } = server;
    const member = plan.network?.members.find((m) => m.name === name);
    if (member === undefined) throw new Error(`Server "${name}" is not on the private network.`);
    const hostPlan: HostPlan = networkHostPlan(
      plan,
      name,
      facts,
      { endpoints, sshPort: server.sshPort, alone: server.alone },
      command,
    );
    const held = facts.network?.interfaces.find((i) => i.name === networkInterface(member));
    const holds = held?.publicKey === member.publicKey;
    const key = holds ? undefined : keys[name];
    if (!holds && key === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Server ${name} needs its private network key, and this computer does not have it. Nothing on server ${name} was changed.`,
        {
          hint: "Put OpsCrew's generated values back from your recovery copy (`opscrew secrets restore`) or from the computer that started the move, then run the command again.",
        },
      );
    }
    if (key !== undefined) deps.redactor.addLiteral(key, "network-key");
    const hash = hostPlanHash(hostPlan);
    const changes = hostPlan.steps.filter((s) => s.state === "change").length;
    // A script without `--approve` naming this plan only sees it; one naming it uses it up here.
    const shownOnly = changes > 0 && !deps.interactive && session.approve !== hash;
    if (changes > 0 && !shownOnly) {
      if (session.approve === hash) session.approve = undefined;
      await beforeChange?.();
    }
    await approveAndApplyHostPlan(deps, {
      plan: hostPlan,
      remote: server.remote,
      apply: server.apply,
      verifyLogin: server.verifyLogin,
      title: `Apply the private network's host plan to server ${name} (${plural(changes, "change")})`,
      server: `server ${name}`,
      planOf: `server ${name}`,
      upToDate: `The private network on server ${name} is as planned; nothing on it changes.`,
      command,
      phase: "retarget",
      planOnly: shownOnly,
      secrets: async () => (key === undefined ? {} : { wireguardKey: key }),
      applying: `Changing the private network on server ${name}`,
    });
    if (shownOnly) return pendingStop(session, hash);
  }
  return undefined;
}

/**
 * Step `created` of a move with a private network, before the new side's deploy: the new app
 * server joins it (its key passed on standard input), and each extra server and the monitoring
 * server another environment owns adds it as a peer, the old app server staying one.
 */
export async function joinMoveNetwork(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  if (plan.network === undefined) return undefined;
  const endpoints = await publicEndpoints(deps, plan);
  const servers = [await sideServer(session, "new"), ...(await otherServers(session, plan))];
  return applyNetworkPlans(session, plan, servers, endpoints);
}

/**
 * `--finish`, before the old side goes: each extra server and the monitoring server another
 * environment owns drops the old app server as a peer.
 */
export async function leaveMoveNetwork(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  if (plan.network === undefined || plan.retarget?.from.member === undefined) return undefined;
  // The move without the old app server's member.
  const left = structuredClone(plan);
  delete left.retarget?.from.member;
  const endpoints = await publicEndpoints(deps, left);
  return applyNetworkPlans(session, left, await otherServers(session, left), endpoints);
}

/**
 * `--abort`, the reverse of {@link joinMoveNetwork} and of the monitoring's host plans: each
 * extra server and the monitoring server another environment owns has the old app server as `app`
 * again, without the new one, and with monitoring on the app's server their Alloy sends to the
 * old app server's stack again. `beforeChange` runs before a plan with changes is asked for.
 */
export async function undoMoveNetwork(
  session: MoveSession,
  beforeChange: () => Promise<void>,
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const network = networkBeforeMove(plan);
  if (network === undefined || move.from.member === undefined) return undefined;
  const { retarget: _undone, ...rest } = plan;
  const before: DeployPlan = { ...rest, target: oldSideTarget(move), network };
  // The old app server's endpoint is `app`'s again.
  const {
    [PREVIOUS_MEMBER]: old,
    [APP_SERVER]: _new,
    ...endpoints
  } = await publicEndpoints(deps, plan);
  const stop = await applyNetworkPlans(
    session,
    before,
    await otherServers(session, before),
    old === undefined ? endpoints : { ...endpoints, [APP_SERVER]: old },
    beforeChange,
  );
  if (stop !== undefined) return stop;
  if (monitoringOf(before)?.where.kind !== "app") return undefined;
  return moveMonitoring(session, before, await sideServer(session, "old"), beforeChange);
}

/**
 * The monitoring's host plans of `plan` (provision's, `monitoringHostPlans`) with the app's server
 * reached as `app` says, each shown and approved by its hash. A script stops at the first plan
 * with changes that `--approve` does not name, with its hash (a later one then stops the run with
 * its own hash, as provision's do). `beforeChange` runs before any is asked for: they are planned
 * first only to know whether one changes something.
 */
export async function moveMonitoring(
  session: MoveSession,
  plan: DeployPlan,
  app: NetworkServer,
  beforeChange?: () => Promise<void>,
): Promise<RetargetResult | undefined> {
  const { deps } = session;
  if (monitoringOf(plan) === undefined) return undefined;
  const input = {
    services: session.services,
    ownRun: undefined,
    extraOwn: [],
    command: session.command,
    phase: "retarget",
    app,
  } as const;
  if (deps.interactive && beforeChange === undefined) {
    await monitoringHostPlans(deps, plan, { ...input, planOnly: false });
    return undefined;
  }
  const shown = await monitoringHostPlans(deps, plan, { ...input, planOnly: true });
  const next = shown.find((outcome) => outcome.plan.steps.some((s) => s.state === "change"));
  if (next === undefined) return undefined;
  if (!deps.interactive) {
    if (session.approve !== next.hash) return pendingStop(session, next.hash);
    session.approve = undefined;
  }
  await beforeChange?.();
  await monitoringHostPlans(deps, plan, { ...input, planOnly: false });
  return undefined;
}
