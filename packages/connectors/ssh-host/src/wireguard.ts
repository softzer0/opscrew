/**
 * `readWireGuard`: the peers of one of OpsCrew's WireGuard interfaces as the server sees them
 * (`wg show <if> dump`, read through the login's way to root). Read-only.
 *
 * The dump's first line is the interface's own and holds its private key, and each peer's line
 * holds its preshared key. The script keeps only the peers' public key, endpoint, allowed IPs and
 * latest handshake, so no key but public ones ever leaves the server.
 */
import type { RemoteExec } from "@opscrew/contracts";
import { z } from "zod";
import { requireNetworkInterface, WireGuardKeySchema } from "./network";
import { linesOf } from "./parse";
import { type HostPrivilege, readAsRoot, readFailure } from "./privilege";
import { APT_FUNCTIONS, buildScript } from "./shell";

/** A peer of the interface, as the server last saw it. */
export interface WireGuardPeer {
  publicKey: string;
  /** Where its packets last came from; absent until it was heard from or given one. */
  endpoint?: string;
  /** Absent when it never completed a handshake. */
  latestHandshake?: Date;
  allowedIps: string[];
}

/** The read-only script: the peers' lines of `wg show <if> dump`, without any private key. */
export function readWireGuardScript(iface: string): string {
  return buildScript(
    "wireguard.read",
    { IFACE: iface },
    `${APT_FUNCTIONS}
command -v wg >/dev/null 2>&1 || fail 'WireGuard (wg) is not installed on the server.'
dump=$(wg show "$IFACE" dump) || fail "OpsCrew's WireGuard interface $IFACE is not up on the server."
# The first line is the interface's own, with its private key; a peer's second field is its
# preshared key. Only each peer's public key, endpoint, allowed IPs and latest handshake leave.
printf '%s\\n' "$dump" | sed 1d | cut -f 1,3,4,5`,
  );
}

/** A peer's line: public key, endpoint, allowed IPs, latest handshake (Unix seconds, 0: never). */
const PeerLineSchema = z.tuple([
  WireGuardKeySchema,
  z.string().min(1),
  z.string().min(1),
  z.string().regex(/^\d{1,12}$/),
]);

/** The peers from the script's output; a line that does not fit is left out. */
export function parseWireGuardPeers(text: string): WireGuardPeer[] {
  return linesOf(text).flatMap((line) => {
    const parsed = PeerLineSchema.safeParse(line.split("\t"));
    if (!parsed.success) return [];
    const [publicKey, endpoint, allowedIps, handshake] = parsed.data;
    const seconds = Number(handshake);
    return [
      {
        publicKey,
        ...(endpoint === "(none)" ? {} : { endpoint }),
        ...(seconds === 0 ? {} : { latestHandshake: new Date(seconds * 1000) }),
        allowedIps: allowedIps === "(none)" ? [] : allowedIps.split(","),
      },
    ];
  });
}

/**
 * The peers of OpsCrew's WireGuard interface `iface` on the server (`wg show <if> dump`), read as
 * root the way `privilege` says; `rootImage` is the `docker` privilege's image (as
 * `ApplyOptions.rootImage`). Throws COMMAND_FAILED when the server cannot be reached or the
 * interface is not up.
 */
export async function readWireGuard(
  remote: RemoteExec,
  iface: string,
  privilege: HostPrivilege,
  rootImage?: string,
): Promise<WireGuardPeer[]> {
  requireNetworkInterface(iface);
  const result = await readAsRoot(
    remote,
    privilege,
    rootImage,
    readWireGuardScript(iface),
    "OpsCrew could not read the private network on the server.",
  );
  if (result.exitCode !== 0) {
    throw readFailure(
      result,
      `OpsCrew could not read ${iface} on the server.`,
      "Run opscrew provision to set the private network up again.",
    );
  }
  return parseWireGuardPeers(result.stdout);
}
