import { errorText, isUserFacingError, OpsCrewError } from "@opscrew/core";
import { portainerStackName, portainerTarget } from "@opscrew/iac-templates";
import { type DeployPlan, isServerlessProvider } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { localComponentStatus } from "../localhost/status";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import type { ProvisionServices } from "../provision/types";
import { runnerStatusLines } from "../runners";
import {
  localhostNotSupported,
  portainerClientFor,
  SshRemoteExec,
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
import { type ResourceReading, readResources, resourceLines } from "./resources";
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
  const remote =
    services.remote?.(address.ipv4) ??
    new SshRemoteExec({
      host: address.ipv4,
      keyFile: deps.paths.files.deployKey,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    });
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
}

/** `blocks` joined with an empty line between them, empty ones left out. */
function joinBlocks(...blocks: string[][]): string[] {
  return blocks
    .filter((block) => block.length > 0)
    .flatMap((block, i) => (i === 0 ? block : ["", ...block]));
}

/** The status lines of `reading`, redacted. */
function readingLines(deps: PhaseDeps, plan: DeployPlan, reading: ResourceReading): string[] {
  return resourceLines(plan, reading, deps.clock.now()).map((line) => deps.redactor.redact(line));
}

/**
 * What `status` shows of the plan's components (FR-1331): before a deploy was seen, the plan's
 * list; then each one and whether it runs ({@link readComponentStatus}) and the resource figures
 * ({@link readResources}, FR-1704), with the list and a note (redacted) instead when the
 * deployment cannot be read. `check` runs first and may stop the read the same way (the MCP
 * server's host-key check). A self-hosted runner's state follows (FR-1530), then the scheduled
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
    const resources = await readResources(deps, plan);
    report = { lines: joinBlocks(site.lines, readingLines(deps, plan, resources)), resources };
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
  if (!appDeployed(plan)) return { lines: componentStatusLines(plan, undefined) };
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
