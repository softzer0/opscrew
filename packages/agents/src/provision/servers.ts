/**
 * The app's extra servers in provision (feature 018, ADR 0022): the cloud servers the IaC plan
 * creates and deletes, their addresses on this computer, their readiness and the deploy's reach of
 * them, and where each service runs once a deploy succeeded.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { otherActiveApps } from "@opscrew/connector-ssh-host";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { listText, OpsCrewError, readTextIfExists, tfstateFile } from "@opscrew/core";
import { APP_SERVER, type DeployPlan, serverOfService } from "@opscrew/plan-schema";
import { z } from "zod";
import type { CheckKey } from "../check/key";
import type { PhaseDeps } from "../context";
import { designMove } from "../design/moves";
import { deletionSession, liftProtection } from "../destroy/deletion";
import { providerProfile } from "../providers";
import {
  continuesHint,
  type HostPlanOutcome,
  hasDeployment,
  readServerAddresses,
  readyNewServer,
  type ServerAddress,
  serverWords,
  updateServerAddresses,
} from "../shared";
import { inspectOwnHost } from "../shared/own-server";
import { networkSshPort } from "../shared/server-address";
import type { ServerAddresses } from "../shared/server-record";
import {
  appServers,
  cloudServerName,
  extraCloudServers,
  extraServers,
  hasExtraServers,
  loginShell,
} from "../shared/servers";
import { networkServer } from "../vpn/servers";
import { applyNetworkPlans, type NetworkServer } from "./network";
import {
  addExtraServerCheckKey,
  applyExtraOwnHostPlan,
  type ExtraOwnServerRun,
  type OwnServerRun,
  removeExtraOwnServer,
} from "./own";
import type { ServerReach } from "./secrets";
import type { ProvisionServices, SavedPlan } from "./types";

/** The root module's `extra_servers` output: each extra cloud server's addresses, by name. */
const ExtraServersOutputSchema = z.record(
  z.string(),
  z.looseObject({ ipv4: z.ipv4(), ipv6: z.union([z.ipv6(), z.literal("")]).optional() }),
);

/**
 * The addresses of the extra cloud servers in the state, by name, from the root module's
 * `extra_servers` output; none when it has none or it is not valid.
 */
export function extraServerOutputs(
  outputs: Record<string, unknown>,
): Record<string, ServerAddress> {
  const parsed = ExtraServersOutputSchema.safeParse(outputs.extra_servers);
  if (!parsed.success) return {};
  return Object.fromEntries(
    Object.entries(parsed.data).map(([name, { ipv4, ipv6 }]) => [
      name,
      { ipv4, ...(ipv6 ? { ipv6 } : {}) },
    ]),
  );
}

/**
 * Records the extra cloud servers' addresses from the outputs after an apply in this computer's
 * server record (`servers`), which keeps the addresses of the extra servers the user owns as design
 * wrote them: a server the state no longer has is forgotten. Nothing is written for a plan that has
 * and had no extra server.
 */
export async function recordExtraServers(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "servers">,
  outputs: Record<string, unknown>,
): Promise<void> {
  const created = extraServerOutputs(outputs);
  const record = await readServerAddresses(deps.paths);
  if (!hasExtraServers(plan) && record.servers === undefined) return;
  await updateServerAddresses(deps.paths, ({ servers: current, ...rest }) => {
    const own = new Set(Object.keys(rest.ownServers ?? {}));
    const servers = {
      ...Object.fromEntries(Object.entries(current ?? {}).filter(([name]) => own.has(name))),
      ...created,
    };
    return Object.keys(servers).length > 0 ? { ...rest, servers } : rest;
  });
}

/**
 * Waits for each extra cloud server to accept SSH and finish its first boot, and pins its host
 * key, as provision does for the app's server (`readyNewServer`). Returns how the deploy reaches
 * each: its address and its known hosts lines.
 * @throws OpsCrewError `PHASE_PRECONDITION` when a server's address is not on this computer.
 */
export async function readyExtraServers(
  deps: PhaseDeps,
  input: { plan: DeployPlan; keyFile: string; command: string; services: ProvisionServices },
): Promise<ServerReach[]> {
  const addresses = (await readServerAddresses(deps.paths)).servers ?? {};
  const reach: ServerReach[] = [];
  for (const { name, provider } of extraCloudServers(input.plan)) {
    const address = addresses[name];
    if (address === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The address of server ${name} is not in the infrastructure state's outputs.`,
        { hint: `Run \`${input.command}\` again; it plans what is missing.` },
      );
    }
    const pinned = await readyNewServer(deps, {
      host: address.ipv4,
      server: `server ${name}`,
      profile: providerProfile(provider),
      keyFile: input.keyFile,
      again: continuesHint(input.command),
      services: input.services,
    });
    reach.push({ name, host: address.ipv4, knownHosts: pinned.knownHostsLines });
  }
  return reach;
}

/**
 * The extra cloud servers the state holds (its `extra_servers` output, `outputs`) that the plan no
 * longer lists: the next infrastructure plan deletes them.
 */
export function removedCloudServers(
  plan: Pick<DeployPlan, "app" | "servers">,
  outputs: Record<string, unknown> | undefined,
): string[] {
  const kept = new Set(extraCloudServers(plan).map((server) => server.name));
  return Object.keys(extraServerOutputs(outputs ?? {})).filter((name) => !kept.has(name));
}

/** The root's own resources an extra server at another provider shares; they go with the last. */
const SHARED_EXTRA =
  /^(?:hcloud_ssh_key\.deploy|digitalocean_ssh_key\.deploy|digitalocean_tag\.app)$/;

/** The extra server whose module holds the resource at `address`: `module.server_<name>.…`. */
function extraServerOf(address: string): string | undefined {
  return /^module\.server_([a-z][a-z0-9-]*)\./.exec(address)?.[1];
}

/**
 * What the deletions of an infrastructure plan remove: the extra servers the plan no longer lists
 * (their modules, and the deploy key and tag an extra server at another provider shares, which go
 * with its last server), and whether anything else is deleted or replaced.
 */
function deletions(
  plan: Pick<DeployPlan, "servers">,
  saved: Pick<SavedPlan, "changes">,
): { removed: string[]; others: boolean } {
  const kept = new Set((plan.servers ?? []).map((server) => server.name));
  const removed = new Set<string>();
  let shared = false;
  let others = false;
  for (const change of saved.changes) {
    if (change.action !== "delete" && change.action !== "replace") continue;
    const server = extraServerOf(change.address);
    if (server !== undefined && !kept.has(server) && change.action === "delete") {
      removed.add(server);
    } else if (SHARED_EXTRA.test(change.address) && change.action === "delete") {
      shared = true;
    } else {
      others = true;
    }
  }
  return { removed: [...removed], others: others || (shared && removed.size === 0) };
}

/**
 * The name typed to approve an infrastructure plan that deletes: with extra servers the plan no
 * longer lists, their names at the provider (`<app>-<name>`), as `destroy` asks for a server's, and
 * the app's name too when the plan also deletes or replaces anything else; otherwise the app's
 * name.
 */
export function removalConfirmPhrase(plan: DeployPlan, saved: Pick<SavedPlan, "changes">): string {
  const { removed, others } = deletions(plan, saved);
  if (removed.length === 0) return plan.app.name;
  return [...(others ? [plan.app.name] : []), ...removed.map((s) => cloudServerName(plan, s))].join(
    " ",
  );
}

/** The approval's notes for an infrastructure plan that deletes extra servers the plan dropped. */
export function removalNotes(plan: DeployPlan, saved: Pick<SavedPlan, "changes">): string[] {
  return deletions(plan, saved).removed.map(
    (server) =>
      `Server ${server} is no longer in servers in opscrew/plan.yaml, so this plan deletes it (${cloudServerName(plan, server)}) with everything on it.`,
  );
}

/**
 * Before the infrastructure plan that deletes the removed extra Hetzner servers (`removed`), their
 * delete protection is lifted as `destroy` lifts it: a plan of the root as the last run left it
 * (it still declares `<name>_delete_protection`), with `-var <name>_delete_protection=false`,
 * which may change nothing but that protection, shown and approved by its hash. A server whose
 * variable is gone from the root (lifted by an earlier run) or that has no delete protection
 * (DigitalOcean) needs none. A run that applies nothing (`planOnly`) stops instead, since the
 * deletion plan it saved could not be applied while the protection is on.
 */
export async function liftRemovedProtection(
  deps: PhaseDeps,
  input: {
    engine: IacEngine;
    env: Record<string, string | undefined>;
    dir: string;
    plan: DeployPlan;
    removed: readonly string[];
    planOnly: boolean;
    command: string;
    phase: PhaseName;
  },
): Promise<void> {
  const variables = (await readTextIfExists(join(input.dir, "variables.tf"))) ?? "";
  const protectedServers = input.removed.filter((server) =>
    variables.includes(`variable "${server}_delete_protection"`),
  );
  if (protectedServers.length === 0) return;
  if (input.planOnly) {
    const one = protectedServers.length === 1;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${one ? "Server" : "Servers"} ${listText(protectedServers)} ${one ? "is" : "are"} no longer in servers, so the next plan deletes ${one ? "it" : "them"}, and ${one ? "its" : "their"} delete protection is lifted first, which a --plan-only run cannot do. Nothing was changed.`,
      {
        hint: `Run \`${input.command}\` without --plan-only: it shows each plan and asks for its approval.`,
      },
    );
  }
  const { engine, env, dir } = input;
  await mkdir(deps.paths.files.plansDir, { recursive: true });
  await engine.init(dir, { env, backendConfig: { path: tfstateFile(deps.paths) } });
  const session = deletionSession(
    {
      deps,
      provider: "hetzner",
      app: input.plan.app.name,
      command: input.command,
      what: "removal",
      phase: input.phase,
    },
    { engine, env, dir },
  );
  await liftProtection(session, {
    vars: Object.fromEntries(protectedServers.map((s) => [`${s}_delete_protection`, "false"])),
    names: protectedServers.map((server) => cloudServerName(input.plan, server)),
    serverInState: true,
    mismatchHint: `Run \`${input.command}\` again once the infrastructure matches its files, or put the server back in servers.`,
  });
}

/**
 * Stops before any change when the plan places a service of the deployed app on another server
 * than where it runs (`deployment.placement`, or the app's server without one) and no move takes
 * it there (`plan.move`): design's own check (`designMove`), whose move copies the data in a
 * maintenance window. Its refusals (a kind whose data can't move yet, a second move) stop too.
 */
export function requireDesignedPlacement(plan: DeployPlan, command: string): void {
  const designed = designMove(plan, plan, plan.move);
  if (designed.move === undefined || plan.move !== undefined) return;
  const { service, from, to } = designed.move;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `opscrew/plan.yaml places ${service} on ${serverWords(to)}, but it runs on ${serverWords(from)}, and only a move that design plans takes its data there. Nothing was changed.`,
    {
      hint: `Run \`opscrew design\`: it plans the move and shows its maintenance window. Then run \`${command}\` again.`,
    },
  );
}

/**
 * The extra servers the user owns that the plan no longer lists: this computer still has their
 * logins (`record.ownServers`).
 */
export function removedOwnServers(
  plan: Pick<DeployPlan, "servers">,
  record: Pick<ServerAddresses, "ownServers">,
): string[] {
  const listed = new Set(extraServers(plan));
  return Object.keys(record.ownServers ?? {}).filter((name) => !listed.has(name));
}

/** `one` for a single server, else `many`: `it` or `them`, `its` or `their`. */
function pronoun(servers: readonly string[], one: string, many: string): string {
  return servers.length === 1 ? one : many;
}

/**
 * Stops before any change when the plan no longer lists an extra server the user owns (this
 * computer still has its login) while public SSH is closed (`network.publicSsh: false`): OpsCrew
 * reaches it only over the private network, at the address the plan no longer holds, and taking
 * the app off it removes its private network, and with it SSH there. Opening public SSH first,
 * with the server still in the plan, lets the removal reach it at its public address.
 */
export async function requirePublicSshForRemoval(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  command: string,
): Promise<void> {
  if (plan.network?.publicSsh !== false) return;
  const removed = removedOwnServers(plan, await readServerAddresses(deps.paths));
  if (removed.length === 0) return;
  const which = listText(removed.map((name) => `server ${name}`));
  const them = pronoun(removed, "it", "them");
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `opscrew/plan.yaml no longer lists ${which}, but public SSH is closed, so OpsCrew could not reach ${them} to take the app off. Nothing was changed.`,
    {
      hint: `Put ${which} back in opscrew/plan.yaml as ${pronoun(removed, "it was", "they were")} (with ${pronoun(removed, "its", "their")} network members), run \`opscrew secure --open-public-ssh\`, then remove ${them} again and run \`${command}\`.`,
    },
  );
}

/** What {@link serverHostPlans} needs. */
export interface ServerHostPlansInput {
  plan: DeployPlan;
  services: ProvisionServices;
  /** The app's server when the user owns it, as provision prepared it. */
  ownRun: OwnServerRun | undefined;
  /** The app's server the user owns has setup changes still to apply (`planOnly`). */
  appPending: boolean;
  /** The extra servers the user owns, prepared before any change. */
  extraOwn: readonly ExtraOwnServerRun[];
  /** The extra servers the user owns that the plan no longer lists. */
  removedOwn: readonly string[];
  deployPublicKey: string;
  deployKeyFile: string;
  passwordLogins?: "off" | "keep";
  /** The scheduled check's key (the repository's `repository`), when the check reads disks. */
  checkKey: CheckKey | undefined;
  repository: string;
  planOnly: boolean;
  command: string;
  phase: Extract<PhaseName, "provision" | "dns">;
}

/**
 * The host plans of the app's servers once the infrastructure is applied, each shown with its
 * server's name and approved by its own hash: the undo host plans of each extra server the user
 * owns that the plan no longer lists, each extra own server's setup (`provision/own.ts`'s, per
 * server) and, with the scheduled check's key, its `check-key` step, then, with a private network,
 * each server's network plan, `app` first ({@link applyNetworkPlans}). With `planOnly` they are
 * only shown and saved, the network's once every server exists and has nothing left to set up.
 * Returns the outcomes in that order.
 */
export async function serverHostPlans(
  deps: PhaseDeps,
  input: ServerHostPlansInput,
): Promise<HostPlanOutcome[]> {
  const { plan, planOnly } = input;
  const run = { planOnly, command: input.command, phase: input.phase };
  const outcomes: HostPlanOutcome[] = [];
  for (const name of input.removedOwn) {
    outcomes.push(
      ...(await removeExtraOwnServer(deps, {
        ...run,
        plan,
        name,
        services: input.services,
        deployKeyFile: input.deployKeyFile,
      })),
    );
  }
  let pending = input.appPending;
  for (const server of input.extraOwn) {
    const outcome = await applyExtraOwnHostPlan(deps, server, {
      ...run,
      plan,
      deployPublicKey: input.deployPublicKey,
      ...(input.passwordLogins !== undefined ? { passwordLogins: input.passwordLogins } : {}),
    });
    if (outcome === undefined) continue;
    outcomes.push(outcome);
    if (planOnly && outcome.plan.steps.some((step) => step.state === "change")) pending = true;
    if (input.checkKey === undefined) continue;
    const checkKey = await addExtraServerCheckKey(deps, server, {
      ...run,
      plan,
      key: input.checkKey,
      repository: input.repository,
    });
    if (checkKey !== undefined) outcomes.push(checkKey);
  }
  if (plan.network === undefined) return outcomes;
  if (planOnly && (pending || !(await serversExist(deps, plan)))) {
    deps.reporter.info(
      "The private network's host plans follow once every server exists and is set up: they need each server's address and what it runs. Applying the plans above shows them and asks for their approval (in scripts: run with `--approve` and these hashes, then again with `--approve` and theirs).",
    );
    return outcomes;
  }
  const servers: NetworkServer[] = [];
  for (const name of appServers(plan)) servers.push(await serverForNetwork(deps, input, name));
  const network = await applyNetworkPlans(deps, {
    plan,
    servers,
    ...run,
  });
  return [...outcomes, ...network.values()];
}

/** True when this computer knows the address of every server OpsCrew creates for the plan. */
async function serversExist(deps: PhaseDeps, plan: DeployPlan): Promise<boolean> {
  const record = await readServerAddresses(deps.paths);
  const app = plan.target.provider === "own" || record.deployment !== undefined;
  return (
    app && extraCloudServers(plan).every((server) => record.servers?.[server.name] !== undefined)
  );
}

/**
 * How the network's host plan reaches the server `name`, as drift reads it, with the port sshd
 * listens on there (`networkSshPort`): on the user's own (the app's or an extra one) its admin
 * login as provision prepared it, with what inspection finds there now, alone when no other
 * OpsCrew app is active there; on one OpsCrew created the deploy user's shell (`services.remote`,
 * else `serverRemote`), as `opscrew vpn` reaches it (`networkServer`).
 */
async function serverForNetwork(
  deps: PhaseDeps,
  input: Pick<ServerHostPlansInput, "plan" | "services" | "ownRun" | "extraOwn" | "phase">,
  name: string,
): Promise<NetworkServer> {
  const own =
    name === APP_SERVER ? input.ownRun : input.extraOwn.find((server) => server.name === name);
  if (own !== undefined) {
    const facts = await inspectOwnHost(deps, own.session, {
      services: { host: own.host },
      phase: input.phase,
      machine: { noun: `server ${name}`, target: `own server ${name}` },
    });
    return {
      name,
      remote: own.session.remote,
      facts,
      apply: own.host.apply,
      verifyLogin: own.verifyLogin,
      sshPort: networkSshPort(facts, own.session.connection.port),
      alone: otherActiveApps(facts.apps, input.plan.app.name).length === 0,
    };
  }
  const { remote } = await loginShell(deps, input.plan, name, input.services);
  const services = { remote: async () => remote, host: input.services.serverHost };
  return networkServer(deps, input.plan, name, services, input.phase);
}

/**
 * `plan` with `deployment.placement`, where each enabled service runs (`app` or its server), once
 * the deployment exists (`hasDeployment`) and no move is under way: the deploy this run sets up
 * starts each service there, and until it has, nothing runs anywhere to move. Design and
 * {@link requireDesignedPlacement} compare it with `services[].server` to find a move. A plan that
 * has and had no extra server is returned as it is.
 */
export function withPlacement(plan: DeployPlan): DeployPlan {
  const { deployment } = plan;
  if (plan.move !== undefined || !hasDeployment(plan)) return plan;
  if ((plan.servers ?? []).length === 0 && deployment.placement === undefined) return plan;
  const placement = Object.fromEntries(
    plan.services
      .filter((service) => service.enabled)
      .map((service) => [service.name, serverOfService(plan, service.name)]),
  );
  const current = deployment.placement ?? {};
  const same =
    Object.keys(current).length === Object.keys(placement).length &&
    Object.entries(placement).every(([service, server]) => current[service] === server);
  return same ? plan : { ...plan, deployment: { ...deployment, placement } };
}
