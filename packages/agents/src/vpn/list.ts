/**
 * `opscrew vpn list` (feature 018, US3 #3): the devices on the app's private network, each with its
 * address and its last handshake on each server, read-only.
 */
import { readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { type NetworkLink, readNetwork } from "../network";
import { readServerAddresses } from "../shared/server-record";
import { handshakeText, notReadText } from "../status/network";
import type { VpnServices } from "./servers";

/** A device's link with one server. */
export interface VpnDeviceLink {
  server: string;
  up: boolean;
  /** Seconds since its last handshake on that server; absent when there was none. */
  handshakeAgeSeconds?: number;
  /** Why the server's side was not read (`readNetwork`'s reasons). */
  reason?: NetworkLink["reason"];
}

/** One device on the network, as `opscrew vpn list` shows it. Never a key. */
export interface VpnDevice {
  name: string;
  address: string;
  addedAt: string;
  /** True for this computer's device (`thisDevice`). */
  thisComputer: boolean;
  /** Its link with each server with a public address. */
  links: VpnDeviceLink[];
  /**
   * The servers it does not connect to while it is connected to another: its configuration was
   * most likely written before they joined the network.
   */
  missing: string[];
}

/** What `opscrew vpn list` found. */
export interface VpnListResult {
  devices: VpnDevice[];
}

/** One link of a device in words: `server app: up, last handshake 5 seconds ago`. */
function linkText(link: NetworkLink): string {
  if (link.reason !== undefined) return `server ${link.from}: not read (${notReadText(link)})`;
  return `server ${link.from}: ${link.up ? "up" : "down"}, ${handshakeText(link)}`;
}

/**
 * `opscrew vpn list`: each device on the app's private network with its address and its last
 * handshake on each server with a public address (`readNetwork`, read-only). A device connected to
 * some servers but not to others is listed with those it lacks, and how to get a configuration
 * with every server (`vpn add <name> --again`).
 */
export async function vpnList(
  deps: PhaseDeps,
  options: { services?: Pick<VpnServices, "remote" | "readWireGuard"> } = {},
): Promise<VpnListResult> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const network = plan.network;
  if (network === undefined || network.devices.length === 0) {
    deps.reporter.info(
      `No device is on the app's private network. Add one with \`opscrew vpn add <name>${flag}\`.`,
    );
    return { devices: [] };
  }
  const services = options.services ?? {};
  deps.reporter.step("Reading the private network on each server (read-only)");
  const links = await readNetwork(deps, plan, services);
  const thisDevice = (await readServerAddresses(deps.paths)).thisDevice;
  const lines = [`Devices on the app's private network (${network.range}):`];
  const devices = network.devices.map((device): VpnDevice => {
    const own = links.filter((link) => link.to === device.name);
    const connected = own.some((link) => link.up);
    const missing = connected
      ? own.filter((link) => !link.up && link.reason === undefined).map((link) => link.from)
      : [];
    const thisComputer = device.name === thisDevice;
    lines.push(
      `  ${device.name} (${device.address})${thisComputer ? ", this computer" : ""}, added ${device.addedAt.slice(0, 10)}`,
      ...own.map((link) => `    ${linkText(link)}`),
    );
    if (missing.length > 0) {
      lines.push(
        `    It is connected, but not to ${missing.map((s) => `server ${s}`).join(" or ")}: its configuration was most likely written before ${missing.length === 1 ? "that server" : "those servers"} joined. Run \`opscrew vpn add ${device.name}${flag} --again\` for a new configuration with every server.`,
      );
    }
    return {
      name: device.name,
      address: device.address,
      addedAt: device.addedAt,
      thisComputer,
      links: own.map((link) => ({
        server: link.from,
        up: link.up,
        ...(link.handshakeAgeSeconds !== undefined
          ? { handshakeAgeSeconds: link.handshakeAgeSeconds }
          : {}),
        ...(link.reason !== undefined ? { reason: link.reason } : {}),
      })),
      missing,
    };
  });
  deps.reporter.info(lines.join("\n"));
  return { devices };
}
