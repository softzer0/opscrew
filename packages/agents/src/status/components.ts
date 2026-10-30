import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, upperFirst } from "@opscrew/core";
import { hostSettingsServices, serviceSpec } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";

/** A component of the plan that runs as containers: its Compose service and what it is. */
export interface PlannedComponent {
  /** The Compose service: `app`, a worker's name, `cron`, a service's name. */
  service: string;
  /** In words: `the web process`, `the worker`, `the cron jobs`, `MySQL`. */
  what: string;
}

/**
 * The plan's components that run as containers of the app's Compose project (FR-1331): the web
 * process, every enabled worker, the cron jobs when one is enabled, and every enabled service.
 */
export function plannedComponents(plan: DeployPlan): PlannedComponent[] {
  return [
    { service: "app", what: "the web process" },
    ...plan.processes.workers
      .filter((worker) => worker.enabled)
      .map((worker) => ({ service: worker.name, what: "the worker" })),
    ...(plan.processes.cron.some((job) => job.enabled)
      ? [{ service: "cron", what: "the cron jobs" }]
      : []),
    ...plan.services
      .filter((service) => service.enabled)
      .map((service) => ({ service: service.name, what: serviceSpec(service.kind).title })),
  ];
}

/**
 * The server a component runs on: a service's `server`, else the app's server (the web process,
 * workers and cron jobs always run there).
 */
export function componentServer(plan: DeployPlan, service: string): string {
  return plan.services.find((s) => s.name === service)?.server ?? APP_SERVER;
}

/** The planned components on `server`. */
function componentsOn(plan: DeployPlan, server: string): PlannedComponent[] {
  return plannedComponents(plan).filter((c) => componentServer(plan, c.service) === server);
}

/** True when the app has extra servers: then every line about a server names it. */
export function hasExtraServers(plan: Pick<DeployPlan, "servers">): boolean {
  return (plan.servers ?? []).length > 0;
}

/**
 * How a block about `server` names it: ` on server <name>` when the app has extra servers, else
 * nothing (one server needs no name).
 */
export function onServer(plan: Pick<DeployPlan, "servers">, server: string): string {
  return hasExtraServers(plan) ? ` on server ${server}` : "";
}

/** One container of the app's Compose project: its name and whether it runs. */
export interface AppContainer {
  name: string;
  running: boolean;
}

/**
 * The Compose service of the app's container `<app>-<service>-<n>`; undefined for another name and
 * for one-off containers (`docker compose run`).
 */
export function containerService(app: string, name: string): string | undefined {
  const service = new RegExp(`^${app}-(.+)-\\d+$`).exec(name)?.[1];
  return service === undefined || service.includes("-run-") ? undefined : service;
}

/**
 * Containers that run once and exit, so a stopped one is no fault: the release command and the
 * one-shot container that sets the host's kernel settings on a server OpsCrew created.
 */
export function oneShotServices(plan: DeployPlan): Set<string> {
  return new Set(["release", ...hostSettingsServices(plan)]);
}

/** A planned component and how many of its containers there are and run. */
export interface ComponentState extends PlannedComponent {
  containers: number;
  running: number;
}

/** Each planned component's containers, and the app's other services found on the server. */
export interface ComponentStatus {
  components: ComponentState[];
  /** The app's Compose services on the server that are no component of the plan, sorted. */
  others: string[];
}

/** One container of the app's Compose project, by its Compose service. */
export interface ServiceContainer {
  service: string;
  running: boolean;
}

/** The app's containers `containers` by their Compose service, one-off containers left out. */
export function serviceContainers(
  app: string,
  containers: readonly AppContainer[],
): ServiceContainer[] {
  return containers.flatMap(({ name, running }) => {
    const service = containerService(app, name);
    return service === undefined ? [] : [{ service, running }];
  });
}

/** How each of the plan's components on `server` runs in its app's containers `containers`. */
export function componentStatus(
  plan: DeployPlan,
  containers: readonly ServiceContainer[],
  server = APP_SERVER,
): ComponentStatus {
  const counts = new Map<string, { containers: number; running: number }>();
  for (const { service, ...container } of containers) {
    const count = counts.get(service) ?? { containers: 0, running: 0 };
    count.containers += 1;
    if (container.running) count.running += 1;
    counts.set(service, count);
  }
  const components = componentsOn(plan, server).map((component) => ({
    ...component,
    ...(counts.get(component.service) ?? { containers: 0, running: 0 }),
  }));
  const planned = new Set(components.map((component) => component.service));
  const oneShot = oneShotServices(plan);
  const others = [...counts.keys()]
    .filter((service) => !planned.has(service) && !oneShot.has(service))
    .sort();
  return { components, others };
}

/** Whether a component runs, in words. */
function stateText(state: ComponentState): string {
  if (state.containers === 0) return "no container";
  if (state.running === 0) return state.containers === 1 ? "stopped" : "all copies stopped";
  if (state.running < state.containers) {
    return `${state.running} of ${state.containers} copies running`;
  }
  return state.containers === 1 ? "running" : `running (${state.containers} copies)`;
}

/**
 * The status lines of the plan's components on `server` (FR-1331): each with whether it runs when
 * `status` was read from the server, and the app's services the plan no longer has there. With
 * extra servers, the heading names the server.
 */
export function componentStatusLines(
  plan: DeployPlan,
  status: ComponentStatus | undefined,
  server = APP_SERVER,
): string[] {
  const on = onServer(plan, server);
  if (status === undefined) {
    return [
      `Components${on} (from opscrew/plan.yaml):`,
      ...componentsOn(plan, server).map(
        (component) => `  ${upperFirst(component.what)} (${component.service})`,
      ),
    ];
  }
  return [
    `Components${on}:`,
    ...status.components.map(
      (state) => `  ${upperFirst(state.what)} (${state.service}): ${stateText(state)}`,
    ),
    ...status.others.map(
      (service) =>
        `  ${service}: on ${on === "" ? "the server" : `server ${server}`}, but no component in opscrew/plan.yaml ${on === "" ? "" : "there "}any more (the next deploy removes it)`,
    ),
  ];
}

/** A container name as Docker allows it. */
export const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The app's containers on a server, read over `remote` with `docker ps` (read-only): every
 * container of the app's Compose project `app`, running or not, except one-off ones.
 * @throws OpsCrewError `COMMAND_FAILED` when the command fails.
 */
export async function readAppContainers(remote: RemoteExec, app: string): Promise<AppContainer[]> {
  const result = await remote.run(
    `docker ps -a --filter label=com.docker.compose.project=${app} --filter label=com.docker.compose.oneoff=False --format '{{.Names}}|{{.State}}'`,
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read the app's containers on the server over SSH (exit code ${result.exitCode}).`,
      {
        hint: "Check that the server is on and that this computer reaches it as the deploy user with the project's deploy key (`opscrew status --ip` shows its address), then try again.",
      },
    );
  }
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const [name, state] = line.trim().split("|");
    return name !== undefined && CONTAINER_NAME.test(name)
      ? [{ name, running: state === "running" }]
      : [];
  });
}
