import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { type AddonKind, BESZEL_PORT, beszelHostname } from "@opscrew/iac-templates";
import { type DeployPlan, onOneServer } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { TunnelledChangeServices } from "../portainer/change";
import { serverEndpoint } from "../portainer/status";
import { appMemoryLimits } from "../shared/memory";
import { SshRemoteExec } from "../shared/remote";
import { dashboardOnNetwork } from "../vpn/dashboards";
import { BESZEL_EMAIL } from "./secrets";
import { ADDON_NAMES, ADDON_PHASE } from "./settings";

/** Where Beszel's dashboard answers on this computer while `opscrew addon open beszel` runs. */
export const BESZEL_LOCAL_URL = `http://localhost:${BESZEL_PORT}`;

/** One of the add-on's containers on the server, as `opscrew addon status` read it. */
export interface AddonContainer {
  name: string;
  running: boolean;
  /** Docker's memory use against the limit (`12.5MiB / 128MiB`), while it runs. */
  memory?: string;
}

/** What `opscrew addon status` shows of one add-on. Never a secret. */
export interface AddonState {
  kind: AddonKind;
  enabled: boolean;
  version?: string;
  /** The memory limits of its containers together, in MB. */
  memoryMb?: number;
  /** Beszel: `hub` (its dashboard on the server) or `agent` (connected to the user's hub). */
  mode?: "hub" | "agent";
  /** Beszel's dashboard at its subdomain, behind Cloudflare Access. */
  url?: string;
  allowedEmails?: string[];
  /** Beszel's agent mode: the user's hub. */
  hubUrl?: string;
  /** Beszel's hub mode: the login email, and where its password is on this computer. */
  email?: string;
  secretsFile?: string;
  secretsFileExists?: boolean;
  /** Grafana Cloud: where the stack receives metrics and logs, and the share of lines sent. */
  metricsUrl?: string;
  logsUrl?: string;
  logSampling?: number;
  /** Read from the server by {@link addonStatus}; absent when not read. */
  containers?: AddonContainer[];
}

/** Both add-ons' states. */
export interface AddonStatus {
  addons: AddonState[];
}

/** The add-ons' states from the plan and this computer only (nothing is contacted). */
export async function addonStatusOf(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<AddonStatus> {
  const limits = appMemoryLimits(plan);
  const limit = (name: string) => limits.find((item) => item.name === name)?.memoryMb;
  const beszel = plan.observability?.beszel;
  const grafana = plan.observability?.grafanaCloud;
  const secretsFile = deps.paths.files.beszelSecrets;
  const hostname = beszelHostname(plan);
  const beszelState: AddonState = beszel?.enabled
    ? {
        kind: "beszel",
        enabled: true,
        version: beszel.version,
        memoryMb: limit("Beszel") as number,
        mode: beszel.mode,
        ...(hostname !== undefined
          ? { url: `https://${hostname}`, allowedEmails: [...(beszel.allowedEmails ?? [])] }
          : {}),
        ...(beszel.mode === "agent"
          ? { hubUrl: beszel.hubUrl as string }
          : {
              email: BESZEL_EMAIL,
              secretsFile,
              secretsFileExists: await exists(secretsFile),
            }),
      }
    : { kind: "beszel", enabled: false };
  const grafanaState: AddonState =
    grafana?.enabled && grafana.metrics !== undefined && grafana.logs !== undefined
      ? {
          kind: "grafana-cloud",
          enabled: true,
          version: grafana.version,
          memoryMb: limit("Grafana Alloy") as number,
          metricsUrl: grafana.metrics.url,
          logsUrl: grafana.logs.url,
          logSampling: grafana.logSampling,
        }
      : { kind: "grafana-cloud", enabled: false };
  return { addons: [beszelState, grafanaState] };
}

/** How to open the add-on, and what runs, in plain words; never a secret. */
export function describeAddonStatus(state: AddonState, app?: string): string {
  const name = ADDON_NAMES[state.kind];
  if (!state.enabled) {
    return `${name} is off. Turn it on with \`opscrew addon enable ${state.kind}\`.`;
  }
  const lines: string[] = [];
  if (state.kind === "beszel") {
    if (state.mode === "agent") {
      lines.push(
        `Beszel ${state.version}: its agent runs on the server (${state.memoryMb} MB) and reports to your hub. Open your hub at ${state.hubUrl}.`,
      );
    } else {
      lines.push(
        `Beszel ${state.version}: its dashboard and agent run on the server (${state.memoryMb} MB); the dashboard listens only on the server itself.`,
        `To open it, run \`opscrew addon open beszel\` and keep it running, then open ${BESZEL_LOCAL_URL} and log in as ${state.email}.`,
        state.secretsFileExists === true
          ? `The password is the "password" in ${state.secretsFile} (on this computer only).`
          : `The password would be in ${state.secretsFile}, which is not on this computer: copy it from the computer that turned Beszel on.`,
      );
      if (state.url !== undefined) {
        lines.push(
          `It is also served on ${state.url} behind Cloudflare Access, for ${(state.allowedEmails ?? []).join(", ")} (a one-time PIN goes to that address; Beszel's own login still applies).`,
        );
      }
    }
  } else {
    lines.push(
      `Grafana Cloud: Grafana Alloy ${state.version} runs on the server (${state.memoryMb} MB) and sends the app's logs (masked${state.logSampling !== undefined && state.logSampling < 100 ? `, ${state.logSampling}% of the lines` : ""}) to ${state.logsUrl} and the server's metrics to ${state.metricsUrl}.`,
      `Open your Grafana Cloud stack to search them${app !== undefined ? ` (the logs are labelled app="${app}")` : ""}.`,
    );
  }
  for (const container of state.containers ?? []) {
    lines.push(
      `  ${container.name}: ${container.running ? "running" : "stopped"}${container.memory !== undefined ? `, memory ${container.memory}` : ""}`,
    );
  }
  if (state.containers?.length === 0) lines.push("  No container of it runs on the server.");
  return lines.join("\n");
}

/**
 * The deploy user's shell on the app's server (a cloud server's address, or the own server's login
 * address and SSH port), with the project's deploy key and the pinned host key.
 */
export async function deployUserShell(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  plan: DeployPlan,
  services: Pick<TunnelledChangeServices, "deployRemote">,
): Promise<RemoteExec> {
  const server = await serverEndpoint(deps, plan);
  if (server === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This computer does not know the server's address, so OpsCrew cannot reach it. Nothing was changed.",
      {
        hint: "Run the command on the computer that ran `opscrew provision` (it keeps the address).",
      },
    );
  }
  return (
    services.deployRemote?.(server.host) ??
    new SshRemoteExec({
      host: server.host,
      ...(server.port !== 22 ? { port: server.port } : {}),
      keyFile: deps.paths.files.deployKey,
      knownHostsFile: deps.paths.files.knownHosts,
      runner: deps.runner,
    })
  );
}

/** The add-ons' Compose projects, by kind. */
const PROJECTS: Readonly<Record<AddonKind, string>> = {
  beszel: "opscrew-beszel",
  "grafana-cloud": "opscrew-alloy",
};

/**
 * The read-only command of the add-ons' containers: each project's containers with their state,
 * then the memory use of the running containers. Fixed text only.
 */
export const ADDON_CONTAINERS_COMMAND = `for p in ${Object.values(PROJECTS).join(" ")}; do docker ps -a --filter label=com.docker.compose.project=$p --format '{{.Names}}|{{.State}}'; done; docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}'`;

const CONTAINER = /^(opscrew-(?:beszel|alloy)-[a-z]+-\d+)\|([a-z]+)$/;
const MEMORY =
  /^(opscrew-(?:beszel|alloy)-[a-z]+-\d+)\|([0-9.]+ ?[KMGT]?i?B \/ [0-9.]+ ?[KMGT]?i?B)$/;

/** The add-ons' containers on the server, by kind, from {@link ADDON_CONTAINERS_COMMAND}'s output. */
export function parseAddonContainers(stdout: string): Record<AddonKind, AddonContainer[]> {
  const memory = new Map<string, string>();
  const states: [string, boolean][] = [];
  for (const line of stdout.split(/\r?\n/).map((text) => text.trim())) {
    const used = MEMORY.exec(line);
    if (used !== null) {
      memory.set(used[1] as string, used[2] as string);
      continue;
    }
    const state = CONTAINER.exec(line);
    if (state !== null) states.push([state[1] as string, state[2] === "running"]);
  }
  const of = (kind: AddonKind) =>
    states
      .filter(([name]) => name.startsWith(`${PROJECTS[kind]}-`))
      .map(([name, running]) => {
        const used = memory.get(name);
        return { name, running, ...(running && used !== undefined ? { memory: used } : {}) };
      });
  return { beszel: of("beszel"), "grafana-cloud": of("grafana-cloud") };
}

/**
 * `opscrew addon status`: whether each add-on is on, its containers' state and memory (read from
 * the server as the deploy user, read-only, when one is on), and how to open it. Never a secret.
 */
export async function addonStatus(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { services?: Pick<TunnelledChangeServices, "deployRemote"> } = {},
): Promise<AddonStatus> {
  const status = await addonStatusOf(deps, plan);
  if (!onOneServer(plan.target.provider)) {
    deps.reporter.info(
      "Beszel and Grafana Cloud run only on a server OpsCrew deploys to (a cloud server or your own); this app has neither. `opscrew logs` and `opscrew status` show its lines and figures.",
    );
    return status;
  }
  if (status.addons.some((state) => state.enabled)) {
    const remote = await deployUserShell(deps, plan, options.services ?? {});
    deps.reporter.step("Reading the add-ons' containers on the server (read-only)");
    const result = await remote.run(ADDON_CONTAINERS_COMMAND, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `OpsCrew could not read the add-ons' containers on the server over SSH (exit code ${result.exitCode}).`,
        {
          hint: "Check that the server is on and that this computer reaches it as the deploy user with the project's deploy key, then try again.",
        },
      );
    }
    await deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "read the Beszel and Grafana Alloy containers (read-only)",
      phase: ADDON_PHASE,
      target: "server",
      decision: "allow",
    });
    const found = parseAddonContainers(result.stdout);
    for (const state of status.addons) {
      if (state.enabled) state.containers = found[state.kind];
    }
  }
  for (const state of status.addons) {
    deps.reporter.info(describeAddonStatus(state, plan.app.name));
  }
  return status;
}

/** The SSH arguments of the tunnel to Beszel's dashboard, as Portainer's status command builds it. */
function tunnelArgs(
  deps: Pick<PhaseDeps, "paths">,
  server: { host: string; port: number },
): string[] {
  const { deployKey, knownHosts } = deps.paths.files;
  return [
    ...(server.port === 22 ? [] : ["-p", String(server.port)]),
    "-i",
    deployKey,
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-N",
    "-L",
    `${BESZEL_PORT}:127.0.0.1:${BESZEL_PORT}`,
    `deploy@${server.host}`,
  ];
}

/**
 * `opscrew addon open beszel`: runs the SSH tunnel to Beszel's dashboard
 * (`ssh -N -L 8090:127.0.0.1:8090 deploy@…`, with the deploy key and the pinned host key) until it
 * is stopped (`signal`), after saying the local address and where the password is. Only Beszel's
 * dashboard on the server opens this way. When this computer is a device on the app's private
 * network and the dashboard is published there, it says that address and port instead, and opens
 * no tunnel.
 */
export async function addonOpen(
  deps: PhaseDeps,
  plan: DeployPlan,
  kind: AddonKind,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (kind === "grafana-cloud") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Grafana Cloud's dashboards are in your Grafana Cloud stack, not on the server, so there is nothing to open here.",
      { hint: "Open your Grafana Cloud stack in your browser." },
    );
  }
  const beszel = plan.observability?.beszel;
  if (!beszel?.enabled) {
    throw new OpsCrewError("PHASE_PRECONDITION", "Beszel is off for this app.", {
      hint: "Turn it on with `opscrew addon enable beszel`.",
    });
  }
  if (beszel.mode === "agent") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Only Beszel's agent runs on this server; its dashboard is your hub at ${beszel.hubUrl}.`,
      { hint: `Open ${beszel.hubUrl} in your browser.` },
    );
  }
  const file = deps.paths.files.beszelSecrets;
  const login = `Log in as ${BESZEL_EMAIL}; the password is the "password" in ${file} (on this computer only).`;
  // This computer on the app's private network opens the dashboard there, with no SSH tunnel.
  const onNetwork = await dashboardOnNetwork(deps, plan, "beszel");
  if (onNetwork !== undefined) {
    deps.reporter.info(
      [
        `This computer is device ${onNetwork.device} on the app's private network: with its WireGuard tunnel on, Beszel's dashboard is at http://${onNetwork.address}:${onNetwork.port}, with no SSH tunnel.`,
        login,
      ].join("\n"),
    );
    return;
  }
  const server = await serverEndpoint(deps, plan);
  if (server === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This computer does not know the server's address, so OpsCrew cannot open the tunnel.",
      {
        hint: "Run the command on the computer that ran `opscrew provision` (it keeps the address).",
      },
    );
  }
  deps.reporter.info(
    [
      `Beszel's dashboard is at ${BESZEL_LOCAL_URL} while this runs (stop it with Ctrl+C).`,
      login,
    ].join("\n"),
  );
  // Stopped (Ctrl+C) ends it quietly, whether the runner then rejects or resolves.
  const stopped = () => options.signal?.aborted === true;
  let result: CommandResult;
  try {
    result = await deps.runner.run("ssh", tunnelArgs(deps, server), {
      timeoutMs: Number.POSITIVE_INFINITY,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (stopped()) return;
    throw error;
  }
  if (stopped()) return;
  if (result.exitCode !== 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The SSH tunnel to Beszel's dashboard stopped (exit code ${result.exitCode}).`,
      {
        hint: `Check that the server is on and that port ${BESZEL_PORT} on this computer is free, then run \`opscrew addon open beszel\` again.`,
      },
    );
  }
}
