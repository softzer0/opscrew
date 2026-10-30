import type { RemoteExec } from "@opscrew/contracts";
import { IMAGES } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, networkInterface } from "@opscrew/plan-schema";
import type { EngineDeps } from "../shared/engine";
import { serverLogin, serverRemote } from "../shared/server-address";
import { hasPublicAddress } from "./endpoints";

/** How the host adapter becomes root to read WireGuard: as root, through sudo, or through Docker. */
export type WireGuardPrivilege = "root" | "sudo" | "docker";

/** One peer of a WireGuard interface, as `wg show <if> dump` lists it. */
export interface WireGuardPeerState {
  publicKey: string;
  endpoint?: string;
  /** Absent when the peer never completed a handshake. */
  latestHandshake?: Date;
  allowedIps: string[];
}

/** Reads a server's WireGuard interface (the host adapter's `readWireGuard`). */
export type WireGuardReader = (
  remote: RemoteExec,
  iface: string,
  privilege: WireGuardPrivilege,
  options: { rootImage: string },
) => Promise<WireGuardPeerState[]>;

/** A link of the private network, seen from the server `from`. */
export interface NetworkLink {
  /** The server whose interface was read. */
  from: string;
  /** Another server, or a device. */
  to: string;
  up: boolean;
  /** Seconds since the last handshake; absent when there was none. */
  handshakeAgeSeconds?: number;
  /** The average round trip of three pings from the app's server, in milliseconds. */
  roundTripMs?: number;
  /** Why the link is down when that is known: `unreachable`, `from` could not be reached or read. */
  reason?: "unreachable";
}

/** The services {@link readNetwork} uses. */
export interface ReadNetworkServices {
  readWireGuard: WireGuardReader;
  /** The shell on a server (default `serverRemote`); fakes in tests. */
  remote?: (server: string) => Promise<RemoteExec>;
}

/** WireGuard drops a session whose last handshake is older than this (`REJECT_AFTER_TIME`). */
const HANDSHAKE_FRESH_SECONDS = 180;

/** The average round trip `ping -c 3 -q` printed (iputils and busybox); none without a reply. */
function roundTrip(stdout: string): number | undefined {
  const received = Number(/(\d+)\s+(?:packets\s+)?received/.exec(stdout)?.[1] ?? 0);
  const average = /=\s*[\d.]+\/([\d.]+)\//.exec(stdout)?.[1];
  return received > 0 && average !== undefined ? Math.round(Number(average) * 10) / 10 : undefined;
}

/**
 * The state of the private network's links: each server's WireGuard interface read through its
 * shell, after the app's server pinged every other server's private address (`ping -c 3 -q`) for
 * the round trip. A link is up when its last handshake is under three minutes old: every link
 * between servers keeps itself alive every 25 seconds, and a device's does while it is on. Servers
 * OpsCrew created are read through Docker (as `deploy`); the user's own as root or through sudo.
 * A server that cannot be reached or read throws nothing: its links are down, with the reason
 * `unreachable`. Reads only.
 */
export async function readNetwork(
  deps: EngineDeps,
  plan: DeployPlan,
  services: ReadNetworkServices,
): Promise<NetworkLink[]> {
  const network = plan.network;
  if (network === undefined) return [];
  const remoteOf = services.remote ?? ((server: string) => serverRemote(deps, plan, server));
  /** The pings' round trips by server; `undefined` when the app's server could not be reached. */
  const ping = async (app: RemoteExec) => {
    const pings = new Map<string, number | undefined>();
    for (const member of network.members) {
      if (member.name === APP_SERVER) continue;
      const result = await app.run(`ping -c 3 -q ${member.address}`, { timeoutMs: 30_000 });
      // 255 is ssh's own failure: ping itself exits 0, 1 (no reply) or 2.
      if (result.exitCode === 255) return undefined;
      pings.set(member.name, roundTrip(result.stdout));
    }
    return pings;
  };
  const app = await remoteOf(APP_SERVER).catch(() => undefined);
  const pings = app === undefined ? undefined : await ping(app).catch(() => undefined);
  /** The server's WireGuard peers; `undefined` when the server could not be reached or read. */
  const read = async (member: (typeof network.members)[number]) => {
    if (member.name === APP_SERVER && (app === undefined || pings === undefined)) return undefined;
    try {
      const login = await serverLogin(deps, plan, member.name);
      const privilege: WireGuardPrivilege = !login.own
        ? "docker"
        : login.user === "root"
          ? "root"
          : "sudo";
      const remote =
        member.name === APP_SERVER && app !== undefined ? app : await remoteOf(member.name);
      return await services.readWireGuard(remote, networkInterface(member), privilege, {
        rootImage: IMAGES.caddy.ref,
      });
    } catch {
      return undefined;
    }
  };
  const now = deps.clock.now().getTime();
  const links: NetworkLink[] = [];
  for (const member of network.members) {
    const peers = await read(member);
    const expected = [
      ...network.members.filter((m) => m.name !== member.name).map((m) => ({ ...m, server: true })),
      ...(hasPublicAddress(plan, member.name) ? network.devices : []).map((d) => ({
        ...d,
        server: false,
      })),
    ];
    for (const peer of expected) {
      if (peers === undefined) {
        links.push({ from: member.name, to: peer.name, up: false, reason: "unreachable" });
        continue;
      }
      const handshake = peers.find((p) => p.publicKey === peer.publicKey)?.latestHandshake;
      const age =
        handshake === undefined
          ? undefined
          : Math.max(0, Math.floor((now - handshake.getTime()) / 1000));
      const roundTripMs =
        member.name === APP_SERVER && peer.server ? pings?.get(peer.name) : undefined;
      links.push({
        from: member.name,
        to: peer.name,
        up: age !== undefined && age < HANDSHAKE_FRESH_SECONDS,
        ...(age !== undefined ? { handshakeAgeSeconds: age } : {}),
        ...(roundTripMs !== undefined ? { roundTripMs } : {}),
      });
    }
  }
  return links;
}
