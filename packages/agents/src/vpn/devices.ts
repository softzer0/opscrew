/**
 * `opscrew vpn add` and `opscrew vpn remove` (feature 018, US3, FR-1813): a device's key and
 * configuration, made on this computer, and its peer on every server with a public address, added
 * or removed through each server's private network host plan, approved by its hash.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listText, OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { APP_SERVER, type DeployPlan, DeviceNameSchema, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import {
  allocateNetwork,
  deviceConfig,
  nextDeviceAddress,
  publicEndpoints,
  serverNetworkInputs,
  type WireGuardKeyPair,
  x25519KeyPair,
} from "../network";
import { applyNetworkPlans, type NetworkServer } from "../provision/network";
import {
  approvalEntry,
  type HostPlanOutcome,
  readServerAddresses,
  updateServerAddresses,
  writePlanIfChanged,
} from "../shared";
import { recordGeneratedEntries } from "../shared/app-secrets";
import {
  deviceServers,
  networkServer,
  requireServers,
  VPN_PHASE,
  type VpnServices,
} from "./servers";

/** `opscrew vpn add <name>`'s flags. */
export interface VpnAddOptions {
  /** `--this-computer`: this computer is the device (the server record's `thisDevice`). */
  thisComputer?: boolean;
  /** `--qr`: return the configuration's text for a QR code. */
  qr?: boolean;
  /** `--again`: a new key and configuration for a device already on the network. */
  again?: boolean;
  services?: VpnServices;
}

/** What `opscrew vpn add` did. */
export interface VpnAddResult {
  device: string;
  /** The device's private address. */
  address: string;
  /** The device's configuration file ({@link deviceConfigFile}). */
  file: string;
  /** True when this run made the device's key and wrote its configuration. */
  written: boolean;
  /**
   * With `--qr`, when this run made the key: the configuration's text for the QR code. It holds the
   * device's private key: show it only as a QR code, never print or log it.
   */
  qr?: string;
  /** The hashes of the host plans shown, one per server with a public address. */
  hostPlanHashes: string[];
  /** True when this run changed a server. */
  applied: boolean;
}

/** `opscrew vpn remove <name>`'s options. */
export interface VpnRemoveOptions {
  services?: VpnServices;
}

/** What `opscrew vpn remove` did. */
export interface VpnRemoveResult {
  device: string;
  hostPlanHashes: string[];
  applied: boolean;
}

/**
 * Where a device's configuration is written: `<the project's OpsCrew folder>/vpn/<env>-<device>.conf`,
 * so two repositories' apps of the same name never share one.
 */
export function deviceConfigFile(
  paths: Pick<ProjectPaths, "projectHomeDir" | "environment">,
  device: string,
): string {
  return join(paths.projectHomeDir, "vpn", `${paths.environment}-${device}.conf`);
}

/**
 * The dashboards the app's server publishes on its private address for the devices, each with the
 * command that applies its files again: Beszel's with `addon enable beszel`, Portainer's with
 * `portainer enable` on a cloud server and the next `provision` on the user's own.
 */
function dashboardCommands(plan: DeployPlan, flag: string): { name: string; command: string }[] {
  return serverNetworkInputs(plan, APP_SERVER, true).published.flatMap((entry) => {
    if (entry.dashboard !== true) return [];
    if (entry.service === "beszel") {
      return [{ name: "Beszel's dashboard", command: `opscrew addon enable beszel${flag}` }];
    }
    const command =
      plan.target.provider === "own"
        ? `opscrew provision${flag}`
        : `opscrew portainer enable${flag}`;
    return [{ name: "Portainer's web UI", command }];
  });
}

/** The device's name, checked. */
function deviceName(name: string): string {
  const parsed = DeviceNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${name}" can't be a device's name: it ${parsed.error.issues[0]?.message ?? "is not valid"}. Nothing was changed.`,
      { hint: 'Name the device with lower-case letters, digits and hyphens, such as "laptop".' },
    );
  }
  return parsed.data;
}

/**
 * Stops when changing the device `device` would cut this computer off its servers: it is this
 * computer's device and public SSH is closed, so every connection to the servers goes through its
 * tunnel.
 */
async function requireNotThisTunnel(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  device: string,
  change: string,
): Promise<void> {
  if (plan.network?.publicSsh !== false) return;
  if ((await readServerAddresses(deps.paths)).thisDevice !== device) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Device ${device} is this computer, and public SSH is closed, so OpsCrew reaches the servers only through its tunnel: ${change} would cut this computer off them. Nothing was changed.`,
    {
      hint: "Open public SSH first with `opscrew secure --open-public-ssh`, or run this command from another device on the network.",
    },
  );
}

/** The app's servers a device peers with, each inspected now; refused when there is none. */
async function reachableServers(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: VpnServices,
): Promise<NetworkServer[]> {
  const names = deviceServers(plan);
  if (names.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The app's server has no public address (it is reached through a Cloudflare Tunnel) and the app has no other server, so a device's WireGuard tunnel has no server to connect to. Nothing was changed.",
      {
        hint: "Devices connect to a server the internet reaches. If it can reach yours, answer so in `opscrew interview`, then run `opscrew design` and `opscrew provision`, and add the device again.",
      },
    );
  }
  const servers: NetworkServer[] = [];
  for (const name of names) servers.push(await networkServer(deps, plan, name, services));
  return servers;
}

/** `plan` with the approvals of the host plans the user approved this run. */
export function withApprovals(plan: DeployPlan, outcomes: Iterable<HostPlanOutcome>): DeployPlan {
  const approvals = [...outcomes].flatMap((o) => (o.approval ? [approvalEntry(o.approval)] : []));
  return approvals.length === 0 ? plan : { ...plan, approvals: [...plan.approvals, ...approvals] };
}

/** Writes a device's configuration, readable only by the user (0600, in a folder of 0700). */
async function writeDeviceConfig(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, text);
}

/** `app 10.200.4.1, data 10.200.4.2`: the servers a device reaches, with their private addresses. */
function serverAddressesText(plan: DeployPlan, servers: readonly string[]): string {
  const members = plan.network?.members ?? [];
  return servers
    .map((name) => `${name} ${members.find((m) => m.name === name)?.address ?? ""}`)
    .join(", ");
}

/**
 * `opscrew vpn add <name>`: adds the device to the app's private network.
 * - A single-server app without a network gets one (its range, the `app` member and its key, kept
 *   with the generated values).
 * - A new device (or one given `again`) gets a key pair from the key maker: its public key and
 *   next free address go into `network.devices` in `opscrew/plan.yaml`, and its configuration
 *   (`deviceConfig`, a peer for each server with a public address) is written to
 *   {@link deviceConfigFile} (0600) before the plan. The private key is in that file only, and, with `qr`, in the
 *   returned text for the QR code.
 * - Then each server with a public address gets the peer through its private network host plan,
 *   shown and approved by its own hash (provision's `applyNetworkPlans`). The plan is written
 *   before them, so a run whose plans were refused is finished by running the command again with
 *   `--approve` and the hashes (the same key, the same plans), without a new key.
 * - `thisComputer` records the device as this computer once every server has it.
 * @throws OpsCrewError before any change: no server with a public address, the device is this
 * computer's while public SSH is closed (`again`), or a server's address is not on this computer.
 */
export async function vpnAdd(
  deps: PhaseDeps,
  name: string,
  options: VpnAddOptions = {},
): Promise<VpnAddResult> {
  const device = deviceName(name);
  const services = options.services ?? {};
  let plan = await readArtifact("plan", deps.paths.files.plan);
  requireServers(plan);
  const existing = plan.network?.devices.find((d) => d.name === device);
  const fresh = existing === undefined || options.again === true;
  if (existing !== undefined && options.again === true) {
    await requireNotThisTunnel(deps, plan, device, "a new key for it");
  }
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  // Running it again with `--approve` must plan the same: never `--again` (a new key) or `--qr`.
  const command = `opscrew vpn add ${device}${flag}${options.thisComputer === true ? " --this-computer" : ""}`;
  const servers = await reachableServers(deps, plan, services);
  const endpoints = await publicEndpoints(deps, plan);
  const keys = services.keys ?? x25519KeyPair;
  const created = plan.network === undefined;
  if (plan.network === undefined) {
    const facts = Object.fromEntries(servers.map((server) => [server.name, server.facts]));
    const allocated = allocateNetwork(plan, facts, keys);
    await recordGeneratedEntries(deps, "network", allocated.privateKeys);
    plan = { ...plan, network: allocated.network };
  }
  const file = deviceConfigFile(deps.paths, device);
  const first = (plan.network?.devices.length ?? 0) === 0;
  let pair: WireGuardKeyPair | undefined;
  let config: string | undefined;
  if (fresh) {
    const network = plan.network as NonNullable<DeployPlan["network"]>;
    pair = keys();
    deps.redactor.addLiteral(pair.privateKey, "device-key");
    const entry = {
      name: device,
      address: existing?.address ?? nextDeviceAddress(network),
      publicKey: pair.publicKey,
      addedAt: existing?.addedAt ?? deps.clock.now().toISOString(),
    };
    const devices =
      existing === undefined
        ? [...network.devices, entry]
        : network.devices.map((d) => (d.name === device ? entry : d));
    plan = { ...plan, network: { ...network, devices } };
    // The key's only copy goes into its file before the plan names the device.
    config = deviceConfig(plan, device, pair.privateKey, endpoints);
    await writeDeviceConfig(file, config);
    await writePlanIfChanged(deps, plan);
    deps.reporter.success(
      `Made device ${device}'s key and wrote its WireGuard configuration to ${file}, which only you can read. OpsCrew keeps no other copy of its key.`,
    );
  }
  const outcomes = await applyNetworkPlans(deps, {
    plan,
    servers,
    command,
    phase: VPN_PHASE,
  });
  plan = withApprovals(plan, outcomes.values());
  await writePlanIfChanged(deps, plan);
  if (options.thisComputer === true) {
    await updateServerAddresses(deps.paths, (current) => ({ ...current, thisDevice: device }));
  }
  const address = plan.network?.devices.find((d) => d.name === device)?.address ?? "";
  const names = servers.map((server) => server.name);
  if (fresh) {
    deps.reporter.info(
      `Import the configuration into the WireGuard app${options.qr === true ? " (or scan the QR code)" : ""} and turn the tunnel on: device ${device} (${address}) then reaches SSH on ${serverAddressesText(plan, names)}.`,
    );
  } else {
    deps.reporter.info(
      `Device ${device} (${address}) is on ${listText(names.map((n) => `server ${n}`))}. Its configuration is the one written when it was added (${file}); OpsCrew keeps no copy of its key${options.qr === true ? ", so it can't show it as a QR code again" : ""}. For a new configuration, run \`opscrew vpn add ${device}${flag} --again\`.`,
    );
  }
  const dashboards = first ? dashboardCommands(plan, flag) : [];
  if (dashboards.length > 0) {
    const commands = dashboards.map((d) => `\`${d.command}\``);
    deps.reporter.info(
      `${listText(dashboards.map((d) => d.name))} ${dashboards.length === 1 ? "goes" : "go"} on the app's server's private address for your devices once applied again: run ${listText(commands)}.`,
    );
  }
  if (created && plan.target.provider !== "own") {
    deps.reporter.info(
      `The app's cloud firewall doesn't let the private network's port (UDP ${plan.network?.members[0]?.port}) in yet: run \`opscrew provision${flag}\`, which shows the infrastructure plan that opens it, before turning the tunnel on.`,
    );
  }
  return {
    device,
    address,
    file,
    written: fresh,
    ...(options.qr === true && config !== undefined ? { qr: config } : {}),
    hostPlanHashes: [...outcomes.values()].map((o) => o.hash),
    applied: [...outcomes.values()].some((o) => o.applied),
  };
}

/**
 * `opscrew vpn remove <name>`: takes the device off every server with a public address, through
 * each server's private network host plan approved by its own hash, then out of
 * `opscrew/plan.yaml` (and out of the server record's `thisDevice` when it was this computer).
 * @throws OpsCrewError before any change: the device is not on the network, it still has access
 * to a database or cache (revoke it first), or it is this computer's while public SSH is closed.
 */
export async function vpnRemove(
  deps: PhaseDeps,
  name: string,
  options: VpnRemoveOptions = {},
): Promise<VpnRemoveResult> {
  const device = deviceName(name);
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const network = plan.network;
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  if (network === undefined || !network.devices.some((d) => d.name === device)) {
    const known = network?.devices.map((d) => d.name) ?? [];
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Device ${device} is not on the app's private network. Nothing was changed.`,
      {
        hint:
          known.length > 0
            ? `Its devices are ${listText(known)} (\`opscrew vpn list${flag}\`).`
            : "The app's private network has no devices.",
      },
    );
  }
  const granted = network.grants.filter((g) => g.device === device).map((g) => g.service);
  if (granted.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Device ${device} still has its own login to ${listText(granted)}. Nothing was changed.`,
      {
        hint: `Revoke it first (${granted.map((s) => `\`opscrew vpn revoke ${device} ${s}${flag}\``).join(", ")}), then remove the device.`,
      },
    );
  }
  await requireNotThisTunnel(deps, plan, device, "removing it");
  requireServers(plan);
  const servers = await reachableServers(deps, plan, options.services ?? {});
  const after: DeployPlan = {
    ...plan,
    network: { ...network, devices: network.devices.filter((d) => d.name !== device) },
  };
  const outcomes = await applyNetworkPlans(deps, {
    plan: after,
    servers,
    command: `opscrew vpn remove ${device}${flag}`,
    phase: VPN_PHASE,
  });
  await writePlanIfChanged(deps, withApprovals(after, outcomes.values()));
  if ((await readServerAddresses(deps.paths)).thisDevice === device) {
    await updateServerAddresses(deps.paths, ({ thisDevice: _gone, ...rest }) => rest);
  }
  deps.reporter.success(
    `Device ${device} is off the app's private network: no server accepts its tunnel any more.`,
  );
  return {
    device,
    hostPlanHashes: [...outcomes.values()].map((o) => o.hash),
    applied: [...outcomes.values()].some((o) => o.applied),
  };
}
