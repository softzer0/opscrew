/**
 * `opscrew rotate network` and `opscrew rotate device:<name>` (025 plan.md 7., US5, FR-2508): new
 * WireGuard keys for the app's private network. `network` gives every server a new key: one plan
 * approved by its hash, then each server's private network host plan (ADR 0011, approved by its own
 * hash, all shown and approved before any applies, then applied back to back) replaces its key
 * file and syncs the others' new public keys in one `wg syncconf`; every
 * device gets a new key pair and configuration, written on this computer, since OpsCrew keeps no
 * copy of a device's key. `device:<name>` is `opscrew vpn add <name> --again`. No private key is
 * ever shown, logged or audited: each reaches its server on the host plan's standard input, or its
 * device's configuration file (0600).
 */
import { readFile, stat } from "node:fs/promises";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  sha256Hex,
  toPosixRelative,
  upperFirst,
} from "@opscrew/core";
import { type DeployPlan, type Network, networkInterface } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import {
  applyNetworkPlansTogether,
  deviceConfig,
  publicEndpoints,
  x25519KeyPair,
} from "../network";
import { requireNoCloudflareMove } from "../provision/guard";
import type { NetworkServer } from "../provision/network";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { outcomeSummary, withApprovals, writePlanIfChanged } from "../shared";
import { recordGeneratedEntries } from "../shared/app-secrets";
import { requestApproval } from "../shared/approvals";
import { appServers } from "../shared/servers";
import { deviceConfigFile, type VpnAddResult, vpnAdd, writeDeviceConfig } from "../vpn/devices";
import { sharedMonitoringServer } from "../vpn/monitoring";
import {
  deviceServers,
  networkServer,
  requireServers,
  VPN_PHASE,
  type VpnServices,
} from "../vpn/servers";
import {
  assertValuesCurrent,
  credentialsRecordFile,
  readCredentialsRecord,
  recordRotation,
} from "./record";

/** What a rotation of the private network's keys or a device's reaches besides this computer. */
export interface NetworkRotationOptions {
  /** `--qr`: each device's new configuration's text too, for a QR code. */
  qr?: boolean;
  services?: VpnServices;
}

/** A device's new configuration, written by a rotation of the network's keys. */
export interface RotatedDevice {
  device: string;
  /** Its configuration file (0600): it holds the device's new private key. */
  file: string;
  /** With `qr`, when this run wrote it: its text. It holds the private key: show it only as a QR code. */
  qr?: string;
}

/** A finished rotation of the private network's keys. */
export interface NetworkRotation {
  /** The hash its plan was approved by; absent when the run went on with one that had stopped. */
  hash?: string;
  /** Every device's new configuration, in the plan's order (none when nothing was rotated). */
  devices: RotatedDevice[];
  /** The hashes of the servers' host plans shown. */
  hostPlanHashes: string[];
  /** True when this run changed a server. */
  applied: boolean;
  /** The recovery copy, refreshed with the servers' new keys: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/** A finished rotation of a device's key: `opscrew vpn add --again`'s result. */
export interface DeviceRotation extends VpnAddResult {
  /** Unchanged: the recovery copy holds no device key. */
  copy: RefreshRecoveryResult;
}

/**
 * The plan's private network.
 * @throws OpsCrewError `INVALID_INPUT` when the app has none.
 */
function requireNetwork(plan: DeployPlan, flags: string): Network {
  if (plan.network !== undefined) return plan.network;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${plan.app.name} has no private network, so it has no WireGuard key to rotate. Nothing was changed.`,
    { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
  );
}

/**
 * Refuses, before any change, while the app moves to another server (its old app server is a peer
 * the plan has no member for), and while public SSH is closed: OpsCrew then reaches the servers
 * through the private network, which their new keys would cut halfway.
 */
function requireReachable(plan: DeployPlan, network: Network): void {
  if (plan.retarget !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The app is moving to another server, and its old app server is on the private network until the move ends, so OpsCrew does not change the network's keys now. Nothing was changed.",
      {
        hint: "Finish the move first (`opscrew retarget --finish`, or `opscrew retarget --abort`), then rotate the network's keys.",
      },
    );
  }
  if (network.publicSsh !== false) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "Public SSH is closed, so OpsCrew reaches the servers only through the private network, and their new keys would cut this computer off them halfway. Nothing was changed.",
    {
      hint: "Open public SSH first (`opscrew secure --open-public-ssh`), rotate the network's keys, then close it again with `opscrew secure --close-public-ssh`.",
    },
  );
}

/** A server on the network, inspected now, and how the plan names it. */
interface MemberServer {
  server: NetworkServer;
  /** `server data`, or `server monitoring of opscrew/plan.yaml` for another environment's. */
  words: string;
}

/**
 * Every server on the network, inspected now (read-only): the app's servers, `app` first, then
 * the monitoring server another environment owns once it has this network's interface.
 */
async function memberServers(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: VpnServices,
): Promise<MemberServer[]> {
  const servers: MemberServer[] = [];
  for (const name of appServers(plan)) {
    servers.push({
      server: await networkServer(deps, plan, name, services),
      words: `server ${name}`,
    });
  }
  const monitoring = await sharedMonitoringServer(deps, plan, services);
  return monitoring === undefined
    ? servers
    : [...servers, { server: monitoring.server, words: monitoring.words }];
}

/** The interface `server` has for the network, as inspection read it. */
function heldInterface(network: Network, server: NetworkServer) {
  const member = network.members.find((m) => m.name === server.name);
  if (member === undefined) return undefined;
  const iface = networkInterface(member);
  return server.facts.network?.interfaces.find((i) => i.name === iface);
}

/** The public key the plan names for `server`. */
function plannedKey(network: Network, server: NetworkServer): string | undefined {
  return network.members.find((m) => m.name === server.name)?.publicKey;
}

/** The SHA-256 the rotation's approval is bound to: the network as it is, its servers and devices. */
function networkRotationHash(deps: Pick<PhaseDeps, "paths">, plan: DeployPlan, network: Network) {
  return sha256Hex(
    canonicalJson({
      rotation: "network",
      environment: deps.paths.environment,
      app: plan.app.name,
      range: network.range,
      members: network.members.map((m) => ({ name: m.name, publicKey: m.publicKey })),
      devices: network.devices.map((d) => ({ name: d.name, publicKey: d.publicKey })),
    }),
  );
}

/**
 * Asks the rotation's approval, bound to its hash (`remote-exec`, as the other rotations; `--approve
 * <hash>` in a script), listing every server and device and what changes for each.
 * @throws PlanRefusedError when it is not given.
 */
async function approveNetworkRotation(
  deps: PhaseDeps,
  network: Network,
  servers: readonly MemberServer[],
  hash: string,
  again: string,
): Promise<void> {
  const { environment } = deps.paths;
  const names = servers.map((member) => member.words);
  const devices = network.devices.map(
    (d) => `${d.name} (${toPosixRelative(deps.paths.root, deviceConfigFile(deps.paths, d.name))})`,
  );
  const record = toPosixRelative(deps.paths.root, credentialsRecordFile(deps.paths));
  const steps = [
    ...(devices.length === 0
      ? []
      : [
          `Each device gets a new key pair and a new WireGuard configuration with the servers' new keys, written on this computer for only you to read: ${listText(devices)}.`,
        ]),
    `Each server's private network host plan is shown and approved by its own hash, all of them before any is applied (${listText(names)}); then they are applied one right after the other, each replacing its server's key file and giving WireGuard its new key with the others' new public keys${devices.length === 0 ? "" : " and the devices'"} in one change (wg syncconf). If one is not approved, none is applied.`,
    `${record} records the rotation, and the recovery copy is refreshed.`,
  ].map((line, i) => `${i + 1}. ${line}`);
  const lines = [
    `New WireGuard keys made on this computer replace those of ${environment}'s private network; no private key is ever shown.`,
    ...steps,
    ...(servers.length > 1
      ? [
          "Between two servers' applies, the link between them is down for the seconds the next apply takes (the app does not reach a service on the other server meanwhile), then comes up again with a new handshake.",
        ]
      : []),
    ...(devices.length > 0
      ? [
          "Each device's old configuration works until its servers change; then import its new one into the WireGuard app.",
        ]
      : []),
    `If a step stops, \`${again}\` goes on with the same keys.`,
    `Rotation hash: ${hash}`,
  ];
  await requestApproval(deps, {
    title: `Rotate the private network's keys of ${environment}`,
    details: lines.join("\n"),
    hash,
    refused: {
      plan: "rotation of the private network's keys",
      unchanged: "Nothing on this computer or the servers was changed.",
      again,
    },
  });
}

/**
 * New key pairs for every server and device of `network` from `keys`, each private key registered
 * with the redactor: each device's configuration written first (its key's only copy), then the
 * servers' private keys kept with the generated values, then the plan with the new public keys.
 * Returns the plan and the devices' files.
 */
async function newNetworkKeys(
  deps: PhaseDeps,
  plan: DeployPlan,
  network: Network,
  input: { keys: NonNullable<VpnServices["keys"]>; endpoints: Record<string, string>; qr: boolean },
): Promise<{ plan: DeployPlan; devices: RotatedDevice[] }> {
  const fresh = (label: "network-key" | "device-key") => {
    const pair = input.keys();
    deps.redactor.addLiteral(pair.privateKey, label);
    return pair;
  };
  const privateKeys: Record<string, string> = {};
  const members = network.members.map((member) => {
    const pair = fresh("network-key");
    privateKeys[member.name] = pair.privateKey;
    return { ...member, publicKey: pair.publicKey };
  });
  const devicePairs = network.devices.map((device) => ({ device, pair: fresh("device-key") }));
  const next: DeployPlan = {
    ...plan,
    network: {
      ...network,
      members,
      devices: devicePairs.map(({ device, pair }) => ({ ...device, publicKey: pair.publicKey })),
    },
  };
  const devices: RotatedDevice[] = [];
  for (const { device, pair } of devicePairs) {
    const file = deviceConfigFile(deps.paths, device.name);
    const text = deviceConfig(next, device.name, pair.privateKey, input.endpoints);
    await writeDeviceConfig(file, text);
    devices.push({ device: device.name, file, ...(input.qr ? { qr: text } : {}) });
  }
  await recordGeneratedEntries(deps, "network", privateKeys);
  await writePlanIfChanged(deps, next);
  return { plan: next, devices };
}

/**
 * The devices' configurations a rotation of the network's keys that stopped wrote, read back with
 * `qr`: only when the network has devices and each one's file on this computer is newer than the
 * network's last recorded rotation (`undefined` otherwise: the plan's keys and the servers' differ
 * for another reason, and no configuration of this computer is new).
 */
async function stoppedRotationDevices(
  deps: PhaseDeps,
  network: Network,
  qr: boolean,
): Promise<RotatedDevice[] | undefined> {
  if (network.devices.length === 0) return undefined;
  const entry = (await readCredentialsRecord(deps)).environments[deps.paths.environment]?.network;
  const last = Date.parse(entry?.rotatedAt ?? entry?.madeAt ?? "1970-01-01T00:00:00.000Z");
  const devices: RotatedDevice[] = [];
  for (const device of network.devices) {
    const file = deviceConfigFile(deps.paths, device.name);
    const written = await stat(file).catch(() => undefined);
    if (written === undefined || written.mtimeMs <= last) return undefined;
    devices.push({
      device: device.name,
      file,
      ...(qr ? { qr: await readFile(file, "utf8") } : {}),
    });
  }
  return devices;
}

/**
 * Rotates the WireGuard keys of `plan`'s private network (`deps.paths`' environment): refused
 * before any change for an app without one, during a move, while public SSH is closed, by the
 * two-computer guard, and while a server has no interface for it yet (each server is inspected,
 * read-only). The plan of every server and device, approved by its hash; then new key pairs:
 * each device's configuration written ({@link deviceConfigFile}, 0600), the servers' private keys
 * kept with the generated values and the new public keys in `opscrew/plan.yaml`, before any server
 * changes; then each server's private network host plan (`applyNetworkPlansTogether`: each
 * approved by its own hash, all before any applies, then applied back to back; none when one is
 * refused), which replaces its key file and syncs the peers' new keys in one change; then the
 * rotation is recorded (`network` and each `device:<name>`) and the recovery copy refreshed.
 * A run that finds a server's interface on another key than the plan's makes no new plan and no
 * new keys, and only applies the host plans: it finishes a rotation that stopped when every
 * device's configuration on this computer is newer than the network's last recorded rotation (then
 * recorded, `qr` reading them back), and otherwise brings the servers back in line with the plan,
 * recording nothing.
 * @throws OpsCrewError `INVALID_INPUT`, `PHASE_PRECONDITION` for the refusals, `APPROVAL_REFUSED`,
 * and a host plan's error, after which running it again goes on.
 */
export async function rotateNetwork(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: NetworkRotationOptions = {},
): Promise<NetworkRotation> {
  requireNoCloudflareMove(plan);
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const again = `opscrew rotate network${flags}`;
  const network = requireNetwork(plan, flags);
  requireServers(plan);
  requireReachable(plan, network);
  await assertValuesCurrent(deps);
  const services = options.services ?? {};
  const members = await memberServers(deps, plan, services);
  const servers = members.map((member) => member.server);
  const held = (server: NetworkServer) => heldInterface(network, server)?.publicKey ?? undefined;
  const unset = members.filter((member) => held(member.server) === undefined);
  if (unset.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The private network is not set up on ${listText(unset.map((m) => m.words))} yet (or OpsCrew could not read it there), so OpsCrew can't change its keys. Nothing was changed.`,
      {
        hint: `Run \`opscrew provision${flags}\`, which sets it up, then run \`${again}\` again.`,
      },
    );
  }
  const behind = members.filter(
    (member) => held(member.server) !== plannedKey(network, member.server),
  );
  let hash: string | undefined;
  let next = plan;
  /** The devices' new configurations; `undefined` when the run only brings the servers in line. */
  let devices: RotatedDevice[] | undefined;
  if (behind.length > 0) {
    devices = await stoppedRotationDevices(deps, network, options.qr === true);
    const which = `${upperFirst(listText(behind.map((m) => m.words)))} ${behind.length === 1 ? "does" : "do"} not have the key the plan names yet`;
    deps.reporter.info(
      devices === undefined
        ? `${which}, so OpsCrew applies the plan's keys there, with no new ones.`
        : `${which}: a rotation of the network's keys stopped before it finished, so OpsCrew goes on with the keys already made.`,
    );
  } else {
    const endpoints = await publicEndpoints(deps, plan);
    hash = networkRotationHash(deps, plan, network);
    await approveNetworkRotation(deps, network, members, hash, again);
    const made = await newNetworkKeys(deps, plan, network, {
      keys: services.keys ?? x25519KeyPair,
      endpoints,
      qr: options.qr === true,
    });
    next = made.plan;
    devices = made.devices;
    if (devices.length > 0) {
      deps.reporter.success(
        `Made the new keys and wrote each device's new WireGuard configuration, which only you can read: ${listText(devices.map((d) => `${d.device} (${d.file})`))}. OpsCrew keeps no other copy of a device's key.`,
      );
    }
  }
  const outcomes = await applyNetworkPlansTogether(deps, {
    plan: next,
    servers,
    command: again,
    phase: VPN_PHASE,
  });
  await writePlanIfChanged(deps, withApprovals(next, outcomes.values()));
  if (hash === undefined && devices === undefined) {
    deps.reporter.success(
      `The private network's servers of ${environment} are back in line with the plan's keys; no key was rotated.`,
    );
    return {
      devices: [],
      ...outcomeSummary(outcomes.values()),
      copy: await refreshRecoveryCopy(deps, plan),
    };
  }
  const rotated = devices ?? [];
  await recordRotation(deps, ["network", ...rotated.map((d) => `device:${d.device}`)]);
  deps.reporter.success(
    `Rotated the private network's keys of ${environment}: every server has its new key, and the links between them are up again within seconds.`,
  );
  if (rotated.length > 0) {
    const files = listText(rotated.map((d) => `${d.device} (${d.file})`));
    deps.reporter.info(
      hash === undefined
        ? `Import each device's new configuration, written when the rotation began, into its WireGuard app if you have not yet: ${files}.`
        : `Import each device's new configuration into its WireGuard app and turn its tunnel on again; its old one no longer works: ${files}.`,
    );
  }
  return {
    ...(hash === undefined ? {} : { hash }),
    devices: rotated,
    ...outcomeSummary(outcomes.values()),
    copy: await refreshRecoveryCopy(deps, plan),
  };
}

/**
 * True when a rotation of `device`'s key stopped before every server took it: a server with a
 * public address whose interface lacks the device's key as the plan names it (inspected now).
 */
async function deviceRotationStopped(
  deps: PhaseDeps,
  plan: DeployPlan,
  device: Network["devices"][number],
  services: VpnServices,
): Promise<boolean> {
  const network = plan.network as Network;
  for (const name of deviceServers(plan)) {
    const server = await networkServer(deps, plan, name, services);
    const peers = heldInterface(network, server)?.peers;
    if (peers !== undefined && !peers.includes(device.publicKey)) return true;
  }
  return false;
}

/**
 * Rotates the WireGuard key of the device `device` of `plan`'s private network, after the
 * two-computer guard: `opscrew vpn add <device> --again` (a new key pair and configuration, its
 * peer replaced on every server with a public address through each one's host plan, approved by
 * its own hash), whose refused plans name `opscrew rotate device:<name> --approve <hash>`. When a
 * server with a public address lacks the device's key as the plan names it (a rotation that
 * stopped), `vpn add` goes on with that key instead of making another. Then the rotation is
 * recorded (`device:<name>`). The recovery copy holds no device key, so nothing of it changes.
 * @throws OpsCrewError `INVALID_INPUT` for a device not on the network, and `vpnAdd`'s.
 */
export async function rotateDevice(
  deps: PhaseDeps,
  plan: DeployPlan,
  device: string,
  options: NetworkRotationOptions = {},
): Promise<DeviceRotation> {
  requireNoCloudflareMove(plan);
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const entry = plan.network?.devices.find((d) => d.name === device);
  if (entry === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Device ${device} is not on ${plan.app.name}'s private network, so it has no key to rotate. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  await assertValuesCurrent(deps);
  const services = options.services ?? {};
  const stopped = await deviceRotationStopped(deps, plan, entry, services);
  if (stopped) {
    deps.reporter.info(
      `A rotation of device ${device}'s key stopped before every server had it, so OpsCrew goes on with that key.`,
    );
  }
  const added = await vpnAdd(deps, device, {
    again: !stopped,
    command: `opscrew rotate device:${device}${flags}`,
    ...(options.qr === true ? { qr: true } : {}),
    services,
  });
  await recordRotation(deps, [`device:${device}`]);
  deps.reporter.info(`Device ${device}'s old configuration no longer works.`);
  return { ...added, copy: { changed: false } };
}
