/**
 * Provision's self-hosted monitoring (feature 020, plan.md 11.): after the private network's host
 * plans, the monitoring's host plans of each server, each shown and approved by its own hash, its
 * secrets passed only on apply.
 * - **On:** on each server with Postgres, the `grant` of OpsCrew's monitoring login; for a plan that
 *   sends to another environment's monitoring server, that server's interface for this network
 *   (over its owner's login); the stack on its server, rendered from every plan that sends to it;
 *   then Grafana Alloy on each of the environment's servers, with its destinations.
 * - **Off, or moved:** in reverse, Alloy back to Grafana Cloud alone where that is on (else
 *   removed), the stack and its data removed after the typed name, another environment's
 *   monitoring server left (the stack without this network, then its interface), and the login.
 *   A monitoring server of this plan's own goes with the infrastructure plan, by its typed name.
 */
import { join } from "node:path";
import {
  type AddonEnable,
  type HostPlan,
  hostPlanHash,
  MONITOR_LOGIN,
  planAddon,
  planGrant,
  planNetworkRemoval,
  readGrant,
} from "@opscrew/connector-ssh-host";
import { listText, OpsCrewError, upperFirst } from "@opscrew/core";
import {
  type AlloyDestinations,
  EDGE_PROJECT,
  edgeProxy,
  IMAGES,
  postgresOn,
  renderAddon,
  renderAlloyCompose,
  renderAlloyConfig,
  renderMonitoringStack,
  renderProxyCaddyfile,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  MONITORING_GRAFANA_PORT,
  type MonitoringSettings,
  monitoringOf,
  monitoringServerName,
  type PlanService,
  readOptionalArtifact,
} from "@opscrew/plan-schema";
import { readGrafanaToken } from "../addons/secrets";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { readOwnerPlan, senderPlans } from "../monitoring/repository";
import { monitoringOwner, networkHostPlan, networkRemovalSteps, publicEndpoints } from "../network";
import { currentOwner, joinedOn, otherServer } from "../network/owner";
import { planFile } from "../runners/words";
import {
  approveAndApplyHostPlan,
  type HostPlanOutcome,
  type HostPlanStep,
  hasDeployment,
  randomPassword,
  readServerAddresses,
  serverWords,
} from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import { appServers, extraCloudServers, targetOf } from "../shared/servers";
import { applyNetworkPlans, type NetworkServer } from "./network";
import {
  keepMonitoringValues,
  type MonitoringValues,
  monitoringPassword,
  monitoringValues,
} from "./secrets";
import { type ServerHostPlansInput, serverForNetwork } from "./servers";

/** What {@link monitoringHostPlans} needs: the servers as provision prepared them. */
export type MonitoringHostPlansInput = Pick<
  ServerHostPlansInput,
  "services" | "ownRun" | "extraOwn" | "planOnly" | "command" | "phase" | "app"
> & {
  /**
   * Only the plan with this hash is shown and applied, the others are left for a later run (a
   * move's script approves one plan per run).
   */
  only?: string;
  /**
   * Only these of the plan's servers are reached (default every one): a move sets up the new app
   * server (and the stack's server) before its window, and the others' Alloy after it.
   */
  servers?: readonly string[];
};

/** A server the monitoring's host plans reach, inspected now. */
interface Reached extends NetworkServer {
  /** The user's own: the add-ons run as root there, and its host record names their owners. */
  own: boolean;
}

/** One change, in the order applied: a host plan, another server's network plan, or local values. */
type Change =
  | { host: HostPlanStep }
  | { network: NetworkServer }
  /** Changes this computer's monitoring values, once the host plans before it are applied. */
  | { local: () => Promise<void> };

/** The monitoring server of another environment this one has an interface on. */
type Owner = NonNullable<MonitoringValues["owner"]>;

/** What every step of one run shares. */
interface Run {
  deps: PhaseDeps;
  plan: DeployPlan;
  input: MonitoringHostPlansInput;
  /** The plan's servers, `app` first. */
  servers: Reached[];
  /** The monitoring's values this computer kept before this run (`{}` for none). */
  kept: MonitoringValues;
  /** A rotation's new values: each is written by its steps even where the rest is in place. */
  rotating?: MonitoringRotation;
}

/** New values of the monitoring's credentials (`opscrew rotate monitoring`, feature 025). */
export interface MonitoringRotation {
  /** Grafana's new admin password: only the environment that runs the stack has one. */
  grafanaAdminPassword?: string;
  /** The new password of OpsCrew's monitoring login to Postgres. */
  postgresPassword?: string;
  /**
   * Marks the rotation begun (idempotent): awaited once the login's or the stack's plan is
   * approved, right before its apply.
   */
  begin?: () => Promise<void>;
}

/**
 * What the setup needs from this computer, read before any change: Grafana Cloud's token when the
 * app's server's Alloy sends there too; the Postgres monitoring login's password, the kept one or
 * one made for this run (in memory until Alloy, its last user, is applied); and for a plan that
 * sends to another environment's monitoring server, that environment's plan, paths and Grafana
 * password.
 */
interface SetupNeeds {
  token: string;
  postgresPassword: string;
  owner?: { plan: DeployPlan; paths: PhaseDeps["paths"]; server: string; password: string };
}

/**
 * The stack's private addresses (`renderMonitoringStack`'s), from the plan that owns it and the
 * plans that send to it, in that order: the stack's server's address on each plan's network.
 */
export function stackAddresses(owner: DeployPlan, senders: readonly DeployPlan[]): string[] {
  return [owner, ...senders].flatMap((plan) => {
    const self = plan.network?.members.find((m) => m.name === monitoringServerName(plan));
    return self === undefined ? [] : [self.address];
  });
}

/**
 * The monitoring's host plans in provision, after the private network's, each shown and approved
 * by its hash (with `planOnly` only shown and saved): what monitoring no longer needs goes first,
 * in reverse (Alloy, the stack with its data after the typed name, another environment's
 * monitoring server left, the Postgres login), then, with monitoring on, the order of plan.md 11.
 * (the Postgres login, the shared server's interface over its owner's login, the stack, Alloy on
 * each server), planned once the removals are applied. A plan whose server already runs it as
 * planned (inspection's facts; the login's state read on the server, with its password kept on
 * this computer) is in place and asks for no approval. Grafana's and the login's
 * passwords are generated once, kept with the generated values and passed only on apply; the
 * login's is kept once Alloy, its last user, is applied, so a refused or failed step leaves none
 * kept and the next run plans the same. A server
 * the deploy has not yet started the app on gets its Alloy and login at the next run: Alloy joins
 * the Docker networks the deploy creates. A plan without monitoring that never had it on this
 * computer reaches no server.
 * @throws OpsCrewError `PHASE_PRECONDITION` before any of these plans when a value they need is not
 * on this computer (the Grafana Cloud token, the shared stack's Grafana password).
 */
export async function monitoringHostPlans(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: MonitoringHostPlansInput,
): Promise<HostPlanOutcome[]> {
  const monitoring = monitoringOf(plan);
  const kept = await monitoringValues(deps);
  if (monitoring === undefined && kept === undefined) return [];
  if (input.planOnly && !(await serversKnown(deps, plan, input))) {
    deps.reporter.info(
      "The monitoring's host plans follow once every server exists: they need each server's address and what it runs. Applying the plans above shows them and asks for their approval.",
    );
    return [];
  }
  const servers: Reached[] = [];
  for (const name of appServers(plan)) {
    if (input.servers !== undefined && !input.servers.includes(name)) continue;
    servers.push(await reachServer(deps, input, plan, name));
  }
  const run: Run = { deps, plan, input, servers, kept: kept ?? {} };
  if (monitoring === undefined) return applyChanges(run, await removals(run));
  const needs = await setupNeeds(run, monitoring);
  const outcomes = await applyChanges(run, await removals(run));
  // Planned once the removals are applied: one may have changed a server the setup changes (the
  // stack of the monitoring server this environment re-joins on another interface).
  outcomes.push(...(await applyChanges(run, await setup(run, monitoring, needs))));
  if (!input.planOnly) await summary(run, monitoring);
  return outcomes;
}

/**
 * Leaves the monitoring server another environment owns that this computer recorded `plan` on
 * (its kept `owner`), as turning monitoring off does: the stack without this environment's
 * network, then its interface there, over the owner's login, each approved by its hash; then the
 * kept `owner` is forgotten. Nothing without one. `destroy`'s, before the servers go.
 */
export async function leaveMonitoringServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: MonitoringHostPlansInput,
): Promise<HostPlanOutcome[]> {
  const kept = (await monitoringValues(deps)) ?? {};
  if (kept.owner === undefined) return [];
  const run: Run = { deps, plan, input, servers: [], kept };
  return applyChanges(run, await leave(run, kept.owner));
}

/**
 * The host plans that give the running monitoring the new values `rotating` (`opscrew rotate
 * monitoring`, feature 025 plan.md 10.), each shown, approved by its hash and applied, the values
 * passed only on apply: with a new login password, on each server with Postgres its `grant` (the
 * password changed over the container's socket, `ALTER ROLE` as the PostgreSQL recipe does), then
 * Alloy there with its new data source; with a new Grafana password, the stack's plan, whose apply
 * sets it in the running Grafana first, then in the file Grafana reads at its first start. Nothing
 * else changes; this computer's values are the caller's to keep.
 * @throws OpsCrewError `PHASE_PRECONDITION` before any change when Postgres does not run yet on a
 * server (a deploy starts it), or Grafana Cloud's token is not on this computer.
 */
export async function monitoringRotationHostPlans(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: MonitoringHostPlansInput,
  rotating: MonitoringRotation,
): Promise<HostPlanOutcome[]> {
  const monitoring = monitoringOf(plan);
  if (monitoring === undefined) throw new Error("A rotation of the monitoring needs it on.");
  const servers: Reached[] = [];
  for (const name of appServers(plan)) servers.push(await reachServer(deps, input, plan, name));
  const kept = (await monitoringValues(deps)) ?? {};
  const run: Run = { deps, plan, input, servers, kept, rotating };
  const changes: Change[] = [];
  const { postgresPassword, grafanaAdminPassword } = rotating;
  if (postgresPassword !== undefined) {
    const withPostgres = servers.filter((server) => postgresOn(plan, server.name) !== undefined);
    const waiting = withPostgres.filter((server) => !ready(plan, server));
    if (waiting.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The app does not run on ${listText(waiting.map((s) => serverWords(s.name)))} yet, so OpsCrew can't change its monitoring login to Postgres there. Nothing was changed.`,
        {
          hint: `Let a deploy start the app there (push to ${plan.cicd.branch}), then run \`${input.command}\` again.`,
        },
      );
    }
    const cloud = withPostgres.some((server) => grafanaCloudOn(plan, server.name) !== undefined);
    const needs = { token: cloud ? await grafanaToken(run) : "", postgresPassword };
    for (const server of withPostgres) {
      const postgres = postgresOn(plan, server.name) as PlanService;
      changes.push({ host: await grantStep(run, server, postgres, postgresPassword) });
    }
    changes.push(...withPostgres.map((server) => ({ host: alloyStep(run, server, needs) })));
  }
  if (grafanaAdminPassword !== undefined) {
    if (monitoring.where.kind === "shared") {
      throw new Error("Grafana's password is rotated from the environment that runs the stack.");
    }
    changes.push(...(await stackChanges(run, monitoring, { token: "", postgresPassword: "" })));
  }
  return applyChanges(run, changes);
}

/**
 * {@link SetupNeeds}, read from this computer before any change.
 * @throws OpsCrewError `PHASE_PRECONDITION` when one is not on this computer.
 */
async function setupNeeds(run: Run, monitoring: MonitoringSettings): Promise<SetupNeeds> {
  const { deps, plan, servers } = run;
  const app = servers.find((server) => server.name === APP_SERVER);
  const cloud =
    app !== undefined && ready(plan, app) && grafanaCloudOn(plan, APP_SERVER) !== undefined;
  const token = cloud ? await grafanaToken(run) : "";
  const postgresPassword = run.kept.postgresPassword ?? randomPassword(32);
  deps.redactor.addLiteral(postgresPassword, "monitoring-password");
  const owner = monitoringOwner(deps.paths, plan);
  if (owner === undefined || monitoring.where.kind !== "shared") return { token, postgresPassword };
  const ownerPlan = await readOwnerPlan(
    deps,
    monitoring.where.owner,
    "OpsCrew applied none of the monitoring's host plans.",
  );
  const password = await ownerPassword(run, ownerPlan, owner.paths);
  return {
    token,
    postgresPassword,
    owner: { plan: ownerPlan, paths: owner.paths, server: owner.server, password },
  };
}

/** Applies `changes` in order; with `planOnly` the host plans are only shown. */
async function applyChanges(run: Run, changes: readonly Change[]): Promise<HostPlanOutcome[]> {
  const { deps, plan, input } = run;
  const outcomes: HostPlanOutcome[] = [];
  /** True when `input.only` names another plan than `hostPlan`'s: it is left for later. */
  const later = (hostPlan: HostPlan) =>
    input.only !== undefined && hostPlanHash(hostPlan) !== input.only;
  for (const change of changes) {
    if ("local" in change) {
      if (!input.planOnly) await change.local();
    } else if ("network" in change) {
      if (input.only !== undefined) {
        const { name, facts, sshPort, alone } = change.network;
        const endpoints = await publicEndpoints(deps, plan);
        const planned = networkHostPlan(
          plan,
          name,
          facts,
          { endpoints, sshPort, alone },
          input.command,
        );
        if (later(planned)) continue;
      }
      const applied = await applyNetworkPlans(deps, {
        plan,
        servers: [change.network],
        planOnly: input.planOnly,
        command: input.command,
        phase: input.phase,
      });
      outcomes.push(...applied.values());
    } else {
      if (later(change.host.plan)) continue;
      outcomes.push(await approveAndApplyHostPlan(deps, change.host));
    }
  }
  return outcomes;
}

/**
 * True when this computer knows the address of every server OpsCrew creates for the plan; the
 * app's server is known when it is reached as given (`input.app`: a move's new app server).
 */
async function serversKnown(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: MonitoringHostPlansInput,
): Promise<boolean> {
  const record = await readServerAddresses(deps.paths);
  const app =
    input.app !== undefined || plan.target.provider === "own" || record.deployment !== undefined;
  return app && extraCloudServers(plan).every((s) => record.servers?.[s.name] !== undefined);
}

/** True when the server `name` of `plan` is the user's own. */
function isOwn(plan: DeployPlan, name: string): boolean {
  return targetOf(plan, name)?.provider === "own";
}

/**
 * The server `name` of `plan`, inspected now, as the network's host plans reach it
 * (`serverForNetwork`): on the user's own, with the login provision prepared for this plan's
 * (`prepared`), else its admin login; on one OpsCrew created, the deploy user's shell, root through
 * Docker in the pinned image; the app's server as `input.app` says when given (a move's new app
 * server, with `prepared`). `deps.paths` are `plan`'s (another environment's for its monitoring
 * server).
 */
async function reachServer(
  deps: PhaseDeps,
  input: MonitoringHostPlansInput,
  plan: DeployPlan,
  name: string,
  prepared = true,
): Promise<Reached> {
  const { services, phase } = input;
  const runs = prepared
    ? {
        ownRun: input.ownRun,
        extraOwn: input.extraOwn,
        ...(input.app !== undefined ? { app: input.app } : {}),
      }
    : { ownRun: undefined, extraOwn: [] };
  const server = await serverForNetwork(deps, { plan, services, phase, ...runs }, name);
  return { ...server, own: isOwn(plan, name) };
}

/**
 * The Docker networks Alloy joins on `server` that are not there yet, which a deploy creates: the
 * edge's on the app's server behind Caddy, and the app's on Postgres's server (whose running
 * Postgres the monitoring login's `grant` also needs).
 */
function missingNetworks(plan: DeployPlan, server: Reached): string[] {
  const { containers } = server.facts;
  return [
    ...(server.name === APP_SERVER &&
    edgeProxy(plan) === "caddy" &&
    !containers.some((c) => c.project === EDGE_PROJECT)
      ? [EDGE_PROJECT]
      : []),
    ...(postgresOn(plan, server.name) !== undefined &&
    !containers.some((c) => c.project === plan.app.name && c.running)
      ? [`${plan.app.name}_internal`]
      : []),
  ];
}

/** True when the deploy started the app on `server`: Alloy's networks and Postgres are there. */
const ready = (plan: DeployPlan, server: Reached) => missingNetworks(plan, server).length === 0;

/** The parts of a host plan's step that say where it runs and how. */
function on(run: Run, server: Reached) {
  const { command, phase, planOnly } = run.input;
  const words = serverWords(server.name);
  return {
    remote: server.remote,
    apply: server.apply,
    verifyLogin: server.verifyLogin,
    server: words,
    planOf: words,
    command,
    phase,
    planOnly,
  };
}

/**
 * The Grafana Cloud token for Alloy on the app's server, from `OPSCREW_GRAFANA_CLOUD_TOKEN` or this
 * computer (registered with the redactor).
 */
async function grafanaToken(run: Run): Promise<string> {
  const { deps } = run;
  const token = deps.env.OPSCREW_GRAFANA_CLOUD_TOKEN?.trim() || (await readGrafanaToken(deps));
  if (token === undefined || token === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Grafana Alloy on the app's server also sends to Grafana Cloud, and the Grafana Cloud token is not on this computer, so OpsCrew applied none of the monitoring's host plans.",
      {
        hint: `Set OPSCREW_GRAFANA_CLOUD_TOKEN to your Grafana Cloud access policy token (metrics:write and logs:write only), then run \`${run.input.command}\` again.`,
      },
    );
  }
  deps.redactor.addLiteral(token, "grafana-cloud-token");
  return token;
}

/** Grafana Cloud's settings when it is on: Alloy on the app's server sends there too. */
function grafanaCloudOn(plan: DeployPlan, server: string) {
  const grafana = plan.observability?.grafanaCloud;
  return server === APP_SERVER && grafana?.enabled === true ? grafana : undefined;
}

/** The add-ons' folder kind on a server: the user's own runs them as root. */
const runAs = (server: Reached) => (server.own ? "root" : "login") as "root" | "login";

/**
 * What monitoring no longer needs, in reverse of its setup: with monitoring off, Alloy back to
 * Grafana Cloud alone (else removed) where it sends to the stack; the stack and its data on a
 * server of this plan it no longer runs on; another environment's monitoring server this one no
 * longer sends to (or sends to on another interface); with monitoring off, the Postgres login (when
 * this computer kept its password or the marker set before its grant), and then this computer's
 * monitoring values, the login's password or marker kept while a server the deploy has not started
 * the app on still has the login.
 */
async function removals(run: Run): Promise<Change[]> {
  const { deps, plan, servers, kept, input } = run;
  const monitoring = monitoringOf(plan);
  const changes: Change[] = [];
  if (monitoring === undefined) {
    for (const server of servers) {
      const alloy = server.facts.alloy;
      const ours = !server.own || server.facts.record?.addons?.alloy === plan.app.name;
      if (ours && alloy?.destinations.includes("monitoring") === true) {
        changes.push({ host: await alloyBack(run, server) });
      }
    }
  }
  const stack = monitoring?.where.kind === "shared" ? undefined : monitoringServerName(plan);
  for (const server of servers) {
    const here =
      server.facts.monitoring !== undefined &&
      (!server.own || server.facts.record?.addons?.monitoring === plan.app.name);
    if (here && server.name !== stack) changes.push({ host: stackRemoval(run, server) });
  }
  const current = currentOwner(plan);
  const old = kept.owner;
  const same =
    current !== undefined &&
    old?.plan === current.plan &&
    old.server === current.server &&
    old.interface === current.interface;
  if (old !== undefined && !same) changes.push(...(await leave(run, old)));
  if (monitoring !== undefined) return changes;
  const waiting: string[] = [];
  const login = kept.postgresPassword !== undefined || kept.login === true;
  for (const server of login ? servers : []) {
    const postgres = postgresOn(plan, server.name);
    if (postgres === undefined) continue;
    if (ready(plan, server)) changes.push({ host: await grantStep(run, server, postgres) });
    else waiting.push(`${postgres.name} on ${serverWords(server.name)}`);
  }
  if (waiting.length > 0) {
    deps.reporter.info(
      `OpsCrew removes its monitoring login from ${listText(waiting)} at the next \`${input.command}\`, once the app runs there again; until then this computer ${kept.postgresPassword === undefined ? "remembers that the login is there, to remove it then" : "keeps the login's password"}.`,
    );
  }
  changes.push({
    local: () =>
      // The login's password, or its marker, stays while a server still has the login.
      keepMonitoringValues(deps, ({ grafanaAdminPassword: _, owner: _owner, ...values }) =>
        waiting.length > 0 ? values : undefined,
      ),
  });
  return changes;
}

/** Alloy on `server` with monitoring off: Grafana Cloud's alone on the app's server, else removed. */
async function alloyBack(run: Run, server: Reached): Promise<HostPlanStep> {
  const { plan } = run;
  const words = serverWords(server.name);
  if (grafanaCloudOn(plan, server.name) !== undefined) {
    const token = await grafanaToken(run);
    const files = renderAddon(plan, "grafana-cloud").map((f) => [f.path, f.content] as const);
    return {
      ...on(run, server),
      plan: planAddon("alloy", {
        app: plan.app.name,
        runAs: runAs(server),
        facts: server.facts,
        enable: { files: Object.fromEntries(files) },
      }),
      title: `Send the logs and figures of ${words} to Grafana Cloud alone again (Grafana Alloy)`,
      upToDate: `Grafana Alloy on ${words} already sends to Grafana Cloud alone; nothing on it changes.`,
      secrets: async () => ({ grafanaCloudToken: token }),
      applying: `Pointing Grafana Alloy on ${words} at Grafana Cloud alone`,
    };
  }
  return {
    ...on(run, server),
    plan: planAddon("alloy", {
      app: plan.app.name,
      runAs: runAs(server),
      facts: server.facts,
      disable: {},
    }),
    title: `Remove Grafana Alloy from ${words}: self-hosted monitoring is off`,
    upToDate: `Grafana Alloy is no longer on ${words}; nothing on it changes.`,
    secrets: async () => ({}),
    applying: `Removing Grafana Alloy from ${words}`,
  };
}

/** The stack on `server` of this plan, where it no longer runs: removed with its data. */
function stackRemoval(run: Run, server: Reached): HostPlanStep {
  const { plan } = run;
  const words = serverWords(server.name);
  return {
    ...on(run, server),
    plan: planAddon("monitoring", {
      app: plan.app.name,
      runAs: runAs(server),
      facts: server.facts,
      disable: { removeData: true },
    }),
    title: `Remove the monitoring stack from ${words}, with the figures and logs it keeps`,
    upToDate: `The monitoring stack is no longer on ${words}; nothing on it changes.`,
    allowDestroy: true,
    intro: [
      `Self-hosted monitoring no longer runs on ${words}, so this plan removes its stack, and the figures and logs it kept are deleted with it. Approving it needs the app's name typed.`,
    ],
    secrets: async () => ({}),
    applying: `Removing the monitoring stack from ${words}`,
  };
}

/** The `docker` privilege's image on a server OpsCrew created; none on the user's own. */
const rootImageOf = (server: Reached) => (server.own ? undefined : IMAGES.caddy.ref);

/**
 * The `grant` of OpsCrew's monitoring login on `postgres` (on `server`) with `password`, or its
 * removal without one, in place when the server reads it so now (`readGrant`, audited) and, for
 * the login, this computer kept its password before this run; the password passed only on apply.
 */
async function grantStep(
  run: Run,
  server: Reached,
  postgres: PlanService,
  password?: string,
): Promise<HostPlanStep> {
  const { deps, plan, input } = run;
  const words = serverWords(server.name);
  const remove = password === undefined;
  const grant = {
    service: postgres.name,
    kind: "postgres",
    login: MONITOR_LOGIN,
    access: "monitor",
    remove,
  } as const;
  const app = plan.app.name;
  const privilege = server.facts.privilege;
  // A password made or rotated in this run reaches the login only through the step: never in place
  // then, and the server's check (which sees the login, never its password) does not skip it.
  const secretsChanged =
    !remove &&
    (run.kept.postgresPassword === undefined || run.rotating?.postgresPassword !== undefined);
  let inPlace = false;
  if (!secretsChanged) {
    inPlace = await readGrant(server.remote, { app, grant }, privilege, rootImageOf(server));
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: `read the monitoring login on ${postgres.name} (read-only)`,
      phase: input.phase,
      target: words,
      decision: "allow",
    });
  }
  return {
    ...on(run, server),
    plan: planGrant(server.facts, { app, grant, inPlace, secretsChanged }, input.command),
    title: remove
      ? `Remove OpsCrew's monitoring login from ${postgres.name} on ${words}`
      : `Let OpsCrew's monitoring read the statistics of ${postgres.name} on ${words}, with a login of its own`,
    upToDate: `OpsCrew's monitoring login on ${postgres.name} is as planned; nothing on ${words} changes.`,
    secrets: async () => {
      if (password === undefined) return {};
      await run.rotating?.begin?.();
      return { monitoringPostgresPassword: password };
    },
    applying: remove
      ? `Removing OpsCrew's monitoring login from ${postgres.name}`
      : `Setting up OpsCrew's monitoring login on ${postgres.name}`,
  };
}

/**
 * The stack's host plan on `server`, rendered from `owner`'s plan and `senders` (approved with the
 * owner's app name, which the host record names), Grafana's password from `password` on apply;
 * written even where the stack runs as planned when the run rotates it.
 */
function stackStep(
  run: Run,
  server: Reached,
  stack: { owner: DeployPlan; senders: readonly DeployPlan[]; where: string; title: string },
  password: () => Promise<string>,
): HostPlanStep {
  const files = renderMonitoringStack(stack.owner, stackAddresses(stack.owner, stack.senders));
  return {
    ...on(run, server),
    server: stack.where,
    planOf: stack.where,
    plan: planAddon("monitoring", {
      app: stack.owner.app.name,
      runAs: runAs(server),
      facts: server.facts,
      enable: { files: Object.fromEntries(files.map((f) => [f.path, f.content])) },
      secretsChanged: run.rotating?.grafanaAdminPassword !== undefined,
    }),
    title: stack.title,
    upToDate: `The monitoring stack on ${stack.where} is as planned; nothing on it changes.`,
    secrets: async () => {
      await run.rotating?.begin?.();
      return { grafanaAdminPassword: await password() };
    },
    applying: `Starting the monitoring stack on ${stack.where}`,
  };
}

/**
 * Grafana's admin password of the stack another environment owns, from its generated values on
 * this computer.
 */
async function ownerPassword(run: Run, ownerPlan: DeployPlan, paths: PhaseDeps["paths"]) {
  const password = (await monitoringValues({ paths, redactor: run.deps.redactor }))
    ?.grafanaAdminPassword;
  if (password !== undefined) return password;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The monitoring stack runs with Grafana's admin password of ${planFile(ownerPlan)}, which is not on this computer, so OpsCrew applied none of the monitoring's host plans.`,
    {
      hint: `Run \`${run.input.command}\` on the computer that set up monitoring for ${planFile(ownerPlan)}, or put its generated values back from the recovery copy (\`opscrew secrets restore\`).`,
    },
  );
}

/**
 * Leaving the monitoring server another environment owns (`old`): its stack without this
 * environment's network, then this network's interface there, over the owner's login. Nothing
 * when the owner no longer runs it, or its deployment was torn down (its server went with it).
 */
async function leave(run: Run, old: Owner): Promise<Change[]> {
  const { deps, plan, input } = run;
  const forget: Change = {
    local: () => keepMonitoringValues(deps, ({ owner: _, ...rest }) => rest),
  };
  const ownerPlan = await readOptionalArtifact("plan", join(deps.paths.root, old.plan));
  const where = ownerPlan === undefined ? undefined : monitoringOf(ownerPlan)?.where;
  if (
    ownerPlan === undefined ||
    !hasDeployment(ownerPlan) ||
    where?.kind !== "server" ||
    where.server !== old.server
  ) {
    deps.reporter.info(
      `${upperFirst(otherServer(old))} no longer runs the monitoring stack, so nothing of this environment is left to take off it.`,
    );
    return [forget];
  }
  const paths = appPaths(deps.paths, ownerPlan.app.key, ownerPlan.environment?.name);
  const server = await reachServer({ ...deps, paths }, input, ownerPlan, old.server, false);
  const password = await ownerPassword(run, ownerPlan, paths);
  const senders = (await senderPlans(deps, ownerPlan)).filter(
    (sender) => planFile(sender) !== planFile(plan) && joinedOn(sender, server.facts),
  );
  const words = otherServer(old);
  const removal = planNetworkRemoval(
    server.facts,
    { app: plan.app.name, ...networkRemovalSteps(old.interface, server.facts) },
    input.command,
  );
  return [
    {
      host: stackStep(
        run,
        server,
        {
          owner: ownerPlan,
          senders,
          where: words,
          title: `Stop receiving this environment's figures and logs on the monitoring stack of ${words}`,
        },
        async () => password,
      ),
    },
    {
      host: {
        ...on(run, server),
        server: words,
        planOf: words,
        plan: removal,
        title: `Take ${words} off this environment's private network`,
        upToDate: `${upperFirst(words)} is no longer on this environment's private network; nothing on it changes.`,
        secrets: async () => ({}),
        applying: `Taking ${words} off this environment's private network`,
      },
    },
    forget,
  ];
}

/**
 * Monitoring's setup, in the order of plan.md 11.: the Postgres login on each server with Postgres,
 * then the stack's server (for a shared one, first its interface for this network), then Alloy on
 * each of the environment's servers; a login password made for this run is kept after them, a
 * marker before the grants. A server the deploy has not yet started the app on is left for the next
 * run, and said.
 */
async function setup(
  run: Run,
  monitoring: MonitoringSettings,
  needs: SetupNeeds,
): Promise<Change[]> {
  const { deps, plan, servers, input } = run;
  const started = servers.filter((server) => ready(plan, server));
  const waiting = servers.filter((server) => !started.includes(server));
  if (waiting.length > 0) {
    const networks = [...new Set(waiting.flatMap((server) => missingNetworks(plan, server)))];
    deps.reporter.info(
      `OpsCrew sets up Grafana Alloy on ${listText(waiting.map((s) => serverWords(s.name)))} at the next \`${input.command}\`, once a deploy has started the app there: Alloy joins Docker networks the deploy creates (${listText(networks)}).`,
    );
  }
  const { postgresPassword } = needs;
  const grants: Change[] = [];
  for (const server of started) {
    const postgres = postgresOn(plan, server.name);
    if (postgres !== undefined) {
      grants.push({ host: await grantStep(run, server, postgres, postgresPassword) });
    }
  }
  // A password made in this run is kept once Alloy, its last user, runs with it; until then the
  // marker says the login may be there, so turning monitoring off still removes it.
  const made = grants.length > 0 && run.kept.postgresPassword === undefined;
  return [
    ...(made ? [{ local: () => keepMonitoringValues(deps, (v) => ({ ...v, login: true })) }] : []),
    ...grants,
    ...(await stackChanges(run, monitoring, needs)),
    ...started.map((server) => ({ host: alloyStep(run, server, needs) })),
    ...(made
      ? [
          {
            local: () =>
              keepMonitoringValues(deps, ({ login: _, ...v }) => ({ ...v, postgresPassword })),
          },
        ]
      : []),
  ];
}

/**
 * The stack's changes: on this plan's server, rendered from this plan and the environments whose
 * interface is there already; on another environment's (`shared`), first that server's interface
 * for this network over its owner's login (this computer keeps which one, to take it off again),
 * then its stack with this environment's network, approved with the owner's app name.
 */
async function stackChanges(
  run: Run,
  monitoring: MonitoringSettings,
  needs: SetupNeeds,
): Promise<Change[]> {
  const { deps, plan, input, servers } = run;
  const { where } = monitoring;
  if (where.kind !== "shared") {
    const server = servers.find((s) => s.name === monitoringServerName(plan)) as Reached;
    const words = serverWords(server.name);
    const senders = (await senderPlans(deps, plan)).filter((s) => joinedOn(s, server.facts));
    return [
      {
        host: stackStep(
          run,
          server,
          {
            owner: plan,
            senders,
            where: words,
            title: `Run the monitoring stack (Prometheus, Loki and Grafana) on ${words}`,
          },
          async () =>
            run.rotating?.grafanaAdminPassword ??
            (await monitoringPassword(deps, "grafanaAdminPassword")),
        ),
      },
    ];
  }
  const { owner } = needs;
  const current = currentOwner(plan);
  if (owner === undefined || current === undefined) throw new Error("A sender has its owner.");
  const { plan: ownerPlan, password } = owner;
  const server = await reachServer(
    { ...deps, paths: owner.paths },
    input,
    ownerPlan,
    owner.server,
    false,
  );
  const listed = await senderPlans(deps, ownerPlan);
  const senders = listed.flatMap((sender) =>
    planFile(sender) === planFile(plan) ? [plan] : joinedOn(sender, server.facts) ? [sender] : [],
  );
  if (!senders.includes(plan)) senders.push(plan);
  const words = otherServer(where.owner);
  return [
    { local: () => keepMonitoringValues(deps, (values) => ({ ...values, owner: current })) },
    { network: server },
    {
      host: stackStep(
        run,
        server,
        {
          owner: ownerPlan,
          senders,
          where: words,
          title: `Receive this environment's figures and logs on the monitoring stack of ${words}`,
        },
        async () => password,
      ),
    },
  ];
}

/**
 * Alloy's settings (`planAddon("alloy")`'s `enable`) on `server` of a plan with monitoring on: its
 * files sending to the stack (at the stack's server's private address, or `front` on that server
 * itself) and, on the app's server with Grafana Cloud on, to Grafana Cloud too; on Postgres's
 * server it reads Postgres with the monitoring login. Provision's and `addon enable|disable
 * grafana-cloud`'s, so Grafana Cloud never replaces the monitoring's Alloy.
 */
export function monitoringAlloy(plan: DeployPlan, server: string): AddonEnable<"alloy"> {
  const stack = monitoringServerName(plan) as string;
  const address =
    server === stack
      ? "front"
      : (plan.network?.members.find((m) => m.name === stack)?.address as string);
  const grafanaCloud = grafanaCloudOn(plan, server);
  const destinations: AlloyDestinations = {
    ...(grafanaCloud === undefined ? {} : { grafanaCloud }),
    monitoring: { address },
  };
  const postgres = postgresOn(plan, server);
  return {
    files: {
      "compose.yaml": renderAlloyCompose(plan, server, destinations),
      Caddyfile: renderProxyCaddyfile("grafana-cloud"),
      "config.alloy": renderAlloyConfig(plan, server, destinations),
    },
    server,
    destinations: [...(grafanaCloud === undefined ? [] : ["grafanaCloud" as const]), "monitoring"],
    ...(postgres === undefined ? {} : { postgresHost: postgres.name }),
  };
}

/**
 * Alloy on `server` ({@link monitoringAlloy}), in place when inspection shows it running as
 * planned; Grafana Cloud's token and the monitoring login's password go only on apply.
 */
function alloyStep(run: Run, server: Reached, needs: SetupNeeds): HostPlanStep {
  const { plan } = run;
  const grafanaCloud = grafanaCloudOn(plan, server.name);
  const postgres = postgresOn(plan, server.name);
  const words = serverWords(server.name);
  return {
    ...on(run, server),
    plan: planAddon("alloy", {
      app: plan.app.name,
      runAs: runAs(server),
      facts: server.facts,
      enable: monitoringAlloy(plan, server.name),
      // A login password made or rotated in this run reaches Alloy only through the step.
      secretsChanged:
        postgres !== undefined &&
        (run.kept.postgresPassword === undefined || run.rotating?.postgresPassword !== undefined),
    }),
    title: `Run Grafana Alloy on ${words}, sending its figures and logs to the monitoring stack${grafanaCloud === undefined ? "" : " and to Grafana Cloud"}`,
    upToDate: `Grafana Alloy on ${words} already runs as planned; nothing on it changes.`,
    secrets: async () => ({
      ...(grafanaCloud === undefined ? {} : { grafanaCloudToken: needs.token }),
      ...(postgres === undefined ? {} : { monitoringPostgresPassword: needs.postgresPassword }),
    }),
    applying: `Starting Grafana Alloy on ${words}`,
  };
}

/** Where Grafana is and how to open it, and where its password is kept. */
async function summary(run: Run, monitoring: MonitoringSettings): Promise<void> {
  const { deps, plan } = run;
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const { where } = monitoring;
  const stack = monitoringServerName(plan) as string;
  const owner = monitoringOwner(deps.paths, plan);
  const words = owner === undefined ? serverWords(stack) : otherServer(owner);
  const address = plan.network?.members.find((m) => m.name === stack)?.address;
  const devices = (plan.network?.devices.length ?? 0) > 0;
  const file = generatedValuesFile({ paths: owner?.paths ?? deps.paths });
  deps.reporter.info(
    [
      `Grafana shows the figures and logs on ${words}${address !== undefined && devices ? `, at http://${address}:${MONITORING_GRAFANA_PORT} from your devices on the private network` : ""}.`,
      `Run \`opscrew addon open monitoring${flag}\` to open it (through an SSH tunnel when this computer is not one of those devices).`,
      `Its admin password is kept with OpsCrew's generated values${where.kind === "shared" ? ` of ${where.owner.plan}` : ""} (${file}) and in the recovery copy.`,
    ].join(" "),
  );
}
