/**
 * `drift` across an app's servers (feature 018, US2 #4, FR-1811): each server's private network
 * (its `network` and `network-filter` host steps) and each extra server's Compose file, env files
 * and containers, compared with what OpsCrew sets up now. Every difference names its server, and
 * never its address. Read-only.
 */
import {
  type HostFacts,
  type HostStep,
  inspectHost,
  otherActiveApps,
  planNetwork,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { errorText, isUserFacingError, sha256Hex } from "@opscrew/core";
import {
  IMAGES,
  keepNewerPins,
  renderServerCompose,
  serviceEnvSecret,
  serviceSpec,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, servicesOn } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { networkSteps, publicEndpoints, serverNetworkInputs } from "../network";
import type { ProvisionServices } from "../provision/types";
import { committedText } from "../shared";
import { appServers, serverShell } from "../status/servers";
import {
  AREA_TITLES,
  containerDifferences,
  type ExpectedRuntimeFiles,
  type HostDifference,
  runtimeFileDetails,
} from "./host";

/** What {@link serversDrift} reads the servers with (fakes in tests). */
export interface ServersDriftOptions {
  /** The shell on a server by its address (default `serverRemote`). */
  services?: Pick<ProvisionServices, "remote">;
  /** Inspects a server read-only (default ssh-host's `inspectHost`). */
  inspect?: (remote: RemoteExec, options: { rootImage?: string }) => Promise<HostFacts>;
}

/** True when OpsCrew created the server `name` (`app` or an extra one): its login is `deploy`. */
function cloudServer(plan: DeployPlan, name: string): boolean {
  if (name === APP_SERVER) return plan.target.provider !== "own";
  return plan.servers?.find((server) => server.name === name)?.target.provider !== "own";
}

/** What differs in the `network` or `network-filter` step on a server, from its facts. */
function networkDetail(facts: HostFacts, step: HostStep): string {
  const iface = String(step.params.interface);
  if (step.id === "network") {
    const found = facts.network?.interfaces.find((item) => item.name === iface);
    return found === undefined
      ? `The WireGuard interface ${iface} is missing, so this server is not on the private network.`
      : `The WireGuard interface ${iface} differs from the plan: its configuration, key, peers, unit or firewall rules were changed, or the plan changed since the last provision.`;
  }
  const filter = facts.network?.filters.find((item) => item.name === iface);
  return filter === undefined || !filter.jump
    ? `The private network's filter on ${iface} is missing, so any address that reaches the network can open the ports published on it.`
    : `The private network's filter on ${iface} differs from the plan: its rules, unit or Docker's drop-in were changed, or the plan's grants changed since the last provision.`;
}

/**
 * The private network's host steps on the server `name`, as provision plans them from the same
 * plan and facts (`networkSteps` with the endpoints, the ports published on its private address
 * and its SSH port), each one not in place as a difference, and what blocks them as found.
 */
function networkDifferences(
  plan: DeployPlan,
  name: string,
  facts: HostFacts,
  input: { endpoints: Readonly<Record<string, string>>; sshPort: number },
): HostDifference[] {
  const network = plan.network;
  if (network === undefined || !network.members.some((m) => m.name === name)) return [];
  const alone = cloudServer(plan, name) || otherActiveApps(facts.apps, plan.app.name).length === 0;
  const { published, localPorts } = serverNetworkInputs(plan, name, alone);
  const steps = networkSteps(plan, name, {
    endpoints: input.endpoints,
    wireguardInterfaces: facts.wireguardInterfaces,
    published,
    sshPort: input.sshPort,
  });
  const hostPlan = planNetwork(
    facts,
    { app: plan.app.name, network: { ...steps.network, localPorts }, filter: steps.filter },
    "opscrew provision",
  );
  return [
    ...hostPlan.steps
      .filter((step) => step.state === "change")
      .map((step) => ({
        area: step.id,
        title: AREA_TITLES[step.id],
        detail: networkDetail(facts, step),
        restoredByProvision: true,
      })),
    ...hostPlan.findings.map((finding) => ({
      area: "server" as const,
      title: "What OpsCrew found",
      detail: `${finding.message} ${finding.hint}`,
      restoredByProvision: false,
    })),
  ];
}

/**
 * The extra server `name`'s runtime files and containers: its Compose file (as
 * `renderServerCompose` renders it now, keeping the newer pins of its committed copy), its
 * services' env files (present, deploy's, not readable by others) and its services' containers.
 */
async function extraServerFiles(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  facts: HostFacts,
): Promise<HostDifference[]> {
  const compose = renderServerCompose(plan, name);
  const committed = await committedText(deps.paths.root, [compose.path]);
  const expected: ExpectedRuntimeFiles = {
    rendered: { "compose.yaml": sha256Hex(keepNewerPins(committed, compose.content)) },
    sitePath: "",
    serviceEnvFiles: Object.fromEntries(
      servicesOn(plan, name)
        .filter((service) => serviceSpec(service.kind).secrets.length > 0)
        .map((service) => [
          `${service.name}.env`,
          { title: serviceSpec(service.kind).title, secret: serviceEnvSecret(service.name) },
        ]),
    ),
  };
  // Only the files the deploy writes on an extra server: its Compose file and its env files.
  const wanted = new Set(["compose.yaml", ...Object.keys(expected.serviceEnvFiles)]);
  const own = { ...facts, runtimeFiles: facts.runtimeFiles.filter((f) => wanted.has(f.name)) };
  const deployed = plan.deployment.firstDeployAt !== undefined;
  const app = plan.app.name;
  return [
    ...runtimeFileDetails(own, app, expected, deployed).map((detail) => ({
      area: "app" as const,
      title: "OpsCrew's runtime files of the app",
      detail,
      restoredByProvision: false,
    })),
    ...containerDifferences(
      plan,
      facts.containers.filter((container) => container.project === app),
      deployed,
      name,
    ),
  ];
}

/**
 * How each of the app's servers differs from what OpsCrew sets up, for a plan with a private
 * network: every server's `network` and `network-filter` steps (inspected read-only, as root the
 * way the host adapter becomes root, through Docker on the servers OpsCrew created), and each
 * extra server's Compose file, env files and containers. With extra servers each difference's
 * title names its server. A server OpsCrew cannot reach adds a note to `notes` and the rest of
 * the report stands. None without a network.
 */
export async function serversDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  notes: string[],
  options: ServersDriftOptions = {},
): Promise<HostDifference[]> {
  if (plan.network === undefined) return [];
  const inspect = options.inspect ?? inspectHost;
  let endpoints: Record<string, string>;
  try {
    endpoints = await publicEndpoints(deps, plan);
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    notes.push(`OpsCrew could not compare the app's servers. ${errorText(error)}`);
    return [];
  }
  const named = (plan.servers ?? []).length > 0;
  const differences: HostDifference[] = [];
  for (const name of appServers(plan)) {
    try {
      const shell = await serverShell(deps, plan, name, options.services ?? {});
      deps.reporter.step(`Comparing server ${name} with what OpsCrew set up`);
      const facts = await inspect(
        shell.remote,
        cloudServer(plan, name) ? { rootImage: IMAGES.caddy.ref } : {},
      );
      if (facts.network === null) {
        notes.push(
          `OpsCrew could not read the private network's state on server ${name} (its login does not become root without a password), so its WireGuard interface and filter were not compared.`,
        );
      }
      const found = [
        ...(facts.network === null
          ? []
          : networkDifferences(plan, name, facts, { endpoints, sshPort: shell.login.port })),
        ...(name === APP_SERVER ? [] : await extraServerFiles(deps, plan, name, facts)),
      ];
      differences.push(
        ...found.map((item) =>
          named ? { ...item, title: `Server ${name}: ${item.title}` } : item,
        ),
      );
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      notes.push(`OpsCrew could not compare server ${name}. ${errorText(error)}`);
    }
  }
  return differences;
}
