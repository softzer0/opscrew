import { errorText, isUserFacingError, OpsCrewError } from "@opscrew/core";
import { portainerStackName, portainerTarget, publishedOnNetwork } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  isServerlessProvider,
  type Network,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { localComponentStatus } from "../localhost/status";
import type { NetworkLink, ReadNetworkServices } from "../network";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import type { ProvisionServices } from "../provision/types";
import { runnerStatusLines } from "../runners";
import {
  appServerShell,
  localhostNotSupported,
  portainerClientFor,
  serverAddress,
  serverlessNotSupported,
} from "../shared";
import { connectAndInspectOwnServer } from "../shared/own-server";
import { type CheckState, checkStateReport } from "./check-state";
import {
  type AppContainer,
  type ComponentStatus,
  componentStatus,
  componentStatusLines,
  plannedComponents,
  readAppContainers,
  type ServiceContainer,
  serviceContainers,
} from "./components";
import { networkStatusLines, type UnpublishedPort } from "./network";
import {
  type ResourceReading,
  readResources,
  readServerResources,
  resourceLines,
} from "./resources";
import {
  appServers,
  extraServers,
  readLinks,
  readPublishedPorts,
  serverShell,
  unpublishedOnNetwork,
} from "./servers";
import { siteStatusReport } from "./site";

/** Options of {@link readServerContainers} and {@link readComponentStatus}. */
export interface ComponentStatusOptions {
  /** A server the user owns: `--host-key SHA256:…` for the first connection from this computer. */
  hostKey?: string;
  /**
   * The deploy user's shell on a server OpsCrew created, own-server and Portainer fakes, and
   * Cloudflare's clients for a site on its hosting, and GitHub's client for the scheduled check's
   * state (tests). On a server the user owns, `remote` is the deploy user's shell, which reads the
   * resource figures.
   */
  services?: Pick<
    ProvisionServices,
    "remote" | "own" | "portainer" | "runnerGitHub" | "cloudflare" | "sharedCloudflare" | "github"
  >;
  /** The private network's WireGuard read (tests; default the host adapter's). */
  network?: ReadNetworkServices;
}

/**
 * True when the app was deployed and the deployment still exists: the deploy workflow ran and
 * `opscrew verify` saw it, so the server holds the app's containers.
 */
export function appDeployed(plan: Pick<DeployPlan, "deployment">): boolean {
  return plan.deployment.firstDeployAt !== undefined && plan.deployment.destroyedAt === undefined;
}

/**
 * The app's containers on its server, read-only (FR-1331): on a server the user owns through the
 * host adapter's inspection, with the pinned host key; on a server OpsCrew created with `docker ps`
 * as the deploy user, with the project's deploy key and the pinned host key, at the address
 * OpsCrew keeps on this computer. Audited without the address.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server's address is not known here, or when
 * the deployment is in the user's Portainer (no server to log in to).
 */
export async function readServerContainers(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions = {},
): Promise<AppContainer[]> {
  const app = plan.app.name;
  const services = options.services ?? {};
  if (plan.target.provider === "portainer") {
    throw new Error("A Portainer deployment has no server for OpsCrew to log in to.");
  }
  if (plan.target.provider === "localhost") {
    throw localhostNotSupported("Reading the app's containers");
  }
  if (isServerlessProvider(plan.target.provider)) {
    throw serverlessNotSupported("Reading the app's containers", plan.target.provider);
  }
  if (plan.target.provider === "own") {
    const { facts } = await connectAndInspectOwnServer(deps, {
      hostKey: options.hostKey,
      services: services.own,
      detail: "the app's components",
    });
    return facts.containers
      .filter((container) => container.project === app)
      .map(({ name, running }) => ({ name, running }));
  }
  const address = await serverAddress(deps, plan);
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not know the server's address on this computer, so it could not read the app's containers.",
      {
        hint: "Run the command on the computer that ran `opscrew provision` (the address is kept there, in .opscrew/server.json).",
      },
    );
  }
  const remote = await appServerShell(
    deps,
    plan,
    { host: address.ipv4, port: 22 },
    services.remote !== undefined ? { remote: services.remote } : {},
  );
  deps.reporter.step("Reading the app's containers on the server (read-only)");
  const containers = await readAppContainers(remote, app);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the app's containers (read-only)",
    target: "server",
    decision: "allow",
  });
  return containers;
}

/**
 * The containers of the app's stack in the user's Portainer that are components of the plan, by
 * their Compose service, read through Portainer's API with the confirmed certificate and
 * `PORTAINER_API_KEY` (listing containers needs an administrator's token). The stack's own parts
 * (the release command, the setup one-shots, Caddy, the tunnel connector) are left out. Audited
 * without Portainer's address.
 */
async function readStackContainers(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ComponentStatusOptions["services"],
): Promise<ServiceContainer[]> {
  const client = portainerClientFor(deps, {
    connection: await requirePortainerConnection(deps, plan),
    token: requirePortainerToken(deps),
    client: services?.portainer?.client,
  });
  deps.reporter.step("Reading the app's containers in your Portainer (read-only)");
  const stack = portainerStackName(plan);
  const planned = new Set(plannedComponents(plan).map((component) => component.service));
  const containers = await client.listContainers(portainerTarget(plan.target).environmentId);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "list the app's containers (read-only)",
    target: "portainer",
    decision: "allow",
  });
  return containers.flatMap(({ project, service, running }) =>
    project === stack && service !== undefined && planned.has(service)
      ? [{ service, running }]
      : [],
  );
}

/** What {@link componentStatusReport} read, with its lines. */
export interface ComponentStatusReport {
  lines: string[];
  status?: ComponentStatus;
  /** The resource figures, once the app was deployed and its components could be read. */
  resources?: ResourceReading;
  /** The scheduled check's state, when the plan has it on and GitHub could be read. */
  check?: CheckState;
  /** With a private network (feature 018): every server, `app` first, as it was read. */
  servers?: ServerStatus[];
  /** The private network's links, read now. */
  links?: NetworkLink[];
  /** The network's devices, by name and address only. */
  devices?: { name: string; address: string }[];
  /** Which device may reach which service, and how. */
  grants?: Network["grants"];
}

/** One of the app's servers as `status` read it (feature 018). */
export interface ServerStatus {
  /** `app` or an extra server's name. */
  name: string;
  /** Its components and whether each runs; absent when it could not be read. */
  status?: ComponentStatus;
  /** Its figures; absent when they could not be read. */
  resources?: ResourceReading;
  /** What it should publish on its private address and does not. */
  unpublished: Omit<UnpublishedPort, "server">[];
}

/** `blocks` joined with an empty line between them, empty ones left out. */
function joinBlocks(...blocks: string[][]): string[] {
  return blocks
    .filter((block) => block.length > 0)
    .flatMap((block, i) => (i === 0 ? block : ["", ...block]));
}

/** The status lines of `reading` (of `server`, default the app's), redacted. */
function readingLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  reading: ResourceReading,
  server = APP_SERVER,
): string[] {
  return resourceLines(plan, reading, deps.clock.now(), server).map((line) =>
    deps.redactor.redact(line),
  );
}

/**
 * What `status` shows of the plan's components (FR-1331): before a deploy was seen, the plan's
 * list; then each one and whether it runs ({@link readComponentStatus}) and the resource figures
 * ({@link readResources}, FR-1704), with the list and a note (redacted) instead when the
 * deployment cannot be read. `check` runs first and may stop the read the same way (the MCP
 * server's host-key check). With extra servers (feature 018, FR-1811), each server's components
 * and figures follow under its name, and with a private network its section
 * (`networkStatusLines`). A self-hosted runner's state follows (FR-1530), then the scheduled
 * check's state and open alerts when the plan has it on (FR-1708). A site on Cloudflare's hosting
 * or GitHub Pages has no components: its running version, custom domains or Pages site instead
 * (`siteStatusReport`), and the figures it cannot give.
 */
export async function componentStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions & { check?: () => Promise<void> } = {},
): Promise<ComponentStatusReport> {
  let report: Omit<ComponentStatusReport, "check">;
  if (isServerlessProvider(plan.target.provider)) {
    const site = await siteStatusReport(
      deps,
      plan,
      options.services ? { services: options.services } : {},
    );
    try {
      const resources = await readResources(
        deps,
        plan,
        options.services ? { services: options.services } : {},
      );
      report = { lines: joinBlocks(site.lines, readingLines(deps, plan, resources)), resources };
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      const note = `OpsCrew could not read the resource figures. ${errorText(error)}`;
      report = { lines: joinBlocks(site.lines, [deps.redactor.redact(note)]) };
    }
  } else {
    const components = await componentsReport(deps, plan, options);
    const runner = await runnerStatusLines(deps, plan, options.services?.runnerGitHub);
    report = { ...components, lines: joinBlocks(components.lines, runner) };
  }
  const state = await checkStateReport(deps, plan, options.services?.github);
  return {
    ...report,
    lines: joinBlocks(report.lines, state.lines),
    ...(state.check !== undefined ? { check: state.check } : {}),
  };
}

/** {@link componentStatusReport} without the runner and the check. */
async function componentsReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions & { check?: () => Promise<void> },
): Promise<Omit<ComponentStatusReport, "check">> {
  if (!appDeployed(plan)) {
    return {
      lines: joinBlocks(
        ...appServers(plan).map((server) => componentStatusLines(plan, undefined, server)),
      ),
    };
  }
  const app = await appServerReport(deps, plan, options);
  const network = plan.network;
  if (network === undefined) return app;
  const extras: { reading: ServerStatus; lines: string[] }[] = [];
  for (const name of extraServers(plan)) {
    extras.push(await extraServerReport(deps, plan, name, options));
  }
  const ports = await appServerPorts(deps, plan, options);
  const servers: ServerStatus[] = [
    {
      name: APP_SERVER,
      ...(app.status !== undefined ? { status: app.status } : {}),
      ...(app.resources !== undefined ? { resources: app.resources } : {}),
      unpublished: ports.unpublished,
    },
    ...extras.map((extra) => extra.reading),
  ];
  const links = await readLinks(deps, plan, options.services, options.network);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const unpublished = servers.flatMap((server) =>
    server.unpublished.map((port) => ({ server: server.name, ...port })),
  );
  const section = [...networkStatusLines(plan, links, unpublished, flag), ...ports.note];
  return {
    ...app,
    lines: joinBlocks(
      app.lines,
      ...extras.map((extra) => extra.lines),
      section.map((line) => deps.redactor.redact(line)),
    ),
    servers,
    links,
    devices: network.devices.map(({ name, address }) => ({ name, address })),
    grants: network.grants,
  };
}

/**
 * The extra server `name`'s components and figures (FR-1811), and what it should publish on its
 * private address and does not, read over its shell as `deploy` (or the admin login of a server
 * the user owns), read-only; a note under its components when it cannot be read.
 */
async function extraServerReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  options: ComponentStatusOptions,
): Promise<{ reading: ServerStatus; lines: string[] }> {
  const app = plan.app.name;
  try {
    const { remote, login, docker } = await serverShell(deps, plan, name, options.services);
    deps.reporter.step(`Reading the app's containers on server ${name} (read-only)`);
    const containers = await readAppContainers(docker, app);
    const published = await readPublishedPorts(docker, app);
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "read the app's containers (read-only)",
      target: `server ${name}`,
      decision: "allow",
    });
    const status = componentStatus(plan, serviceContainers(app, containers), name);
    const reading: ServerStatus = {
      name,
      status,
      unpublished: unpublishedOnNetwork(plan, name, published),
    };
    const lines = componentStatusLines(plan, status, name);
    try {
      const resources = await readServerResources(deps, plan, name, remote, login.own);
      return {
        reading: { ...reading, resources },
        lines: joinBlocks(lines, readingLines(deps, plan, resources, name)),
      };
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      const note = `OpsCrew could not read the resource figures of server ${name}. ${errorText(error)}`;
      return { reading, lines: joinBlocks(lines, [deps.redactor.redact(note)]) };
    }
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    // A command that failed on the server gets this server's next step; a missing login its own.
    const why =
      error.code === "COMMAND_FAILED"
        ? `${error.message} Check that server ${name} is on and that this computer reaches it over SSH, then run \`opscrew status\` again.`
        : errorText(error);
    return {
      reading: { name, unpublished: [] },
      lines: [
        ...componentStatusLines(plan, undefined, name),
        deps.redactor.redact(`OpsCrew could not read server ${name}. ${why}`),
      ],
    };
  }
}

/**
 * What the app's server should publish on its private address (the services a device was granted)
 * and does not, read over its shell; nothing to read without such a service, and a note when it
 * cannot be read.
 */
async function appServerPorts(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions,
): Promise<{ unpublished: ServerStatus["unpublished"]; note: string[] }> {
  if (publishedOnNetwork(plan, APP_SERVER).length === 0) return { unpublished: [], note: [] };
  try {
    const { docker } = await serverShell(deps, plan, APP_SERVER, options.services);
    const published = await readPublishedPorts(docker, plan.app.name);
    return { unpublished: unpublishedOnNetwork(plan, APP_SERVER, published), note: [] };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return {
      unpublished: [],
      note: [
        `  OpsCrew could not read the ports server ${APP_SERVER} publishes on the private network. ${errorText(error)}`,
      ],
    };
  }
}

/** The app's server's components and figures, as `status` read them before extra servers. */
async function appServerReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions & { check?: () => Promise<void> },
): Promise<Omit<ComponentStatusReport, "check">> {
  const { check, ...read } = options;
  let status: ComponentStatus;
  try {
    await check?.();
    status = await readComponentStatus(deps, plan, read);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return {
      lines: [
        ...componentStatusLines(plan, undefined),
        deps.redactor.redact(`OpsCrew could not check whether they run. ${errorText(error)}`),
      ],
    };
  }
  const lines = componentStatusLines(plan, status);
  try {
    const resources = await readResources(deps, plan, read);
    return { lines: joinBlocks(lines, readingLines(deps, plan, resources)), status, resources };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    const note = `OpsCrew could not read the resource figures. ${errorText(error)}`;
    return { lines: joinBlocks(lines, [deps.redactor.redact(note)]), status };
  }
}

/**
 * Each of the plan's components and whether it runs (FR-1331): on a server, from its containers
 * ({@link readServerContainers}); in the user's Portainer, from the app's stack through its API;
 * on this computer, from the app's Compose project in its Docker.
 */
export async function readComponentStatus(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions = {},
): Promise<ComponentStatus> {
  if (plan.target.provider === "portainer") {
    return componentStatus(plan, await readStackContainers(deps, plan, options.services));
  }
  if (plan.target.provider === "localhost") return localComponentStatus(deps, plan);
  const containers = await readServerContainers(deps, plan, options);
  return componentStatus(plan, serviceContainers(plan.app.name, containers));
}
