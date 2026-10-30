import type { DeployPlan } from "@opscrew/plan-schema";
import { KEEPALIVE_SECONDS, wireGuardEndpoint } from "./steps";

/**
 * The text of a device's WireGuard configuration (`.conf`): its private key and address, and a
 * peer for each server with a public address in `endpoints` (by server name, `publicEndpoints`),
 * which admits only that server's `/32` and keeps the link up every 25 seconds. A server without a
 * public address gets no peer. The text holds the device's private key: it is written only into
 * the device's own file, never shown or logged.
 * @throws Error when the plan has no network or the device is not on it.
 */
export function deviceConfig(
  plan: Pick<DeployPlan, "app" | "network">,
  device: string,
  privateKey: string,
  endpoints: Readonly<Record<string, string>>,
): string {
  const entry = plan.network?.devices.find((d) => d.name === device);
  if (plan.network === undefined || entry === undefined) {
    throw new Error(`Device "${device}" is not on the plan's private network.`);
  }
  const peers = plan.network.members.flatMap((member) => {
    const host = endpoints[member.name];
    if (host === undefined) return [];
    return [
      "",
      "[Peer]",
      `# ${member.name}`,
      `PublicKey = ${member.publicKey}`,
      `Endpoint = ${wireGuardEndpoint(host, member.port)}`,
      `AllowedIPs = ${member.address}/32`,
      `PersistentKeepalive = ${KEEPALIVE_SECONDS}`,
    ];
  });
  return [
    `# OpsCrew: ${plan.app.name}'s private network, device ${device}`,
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${entry.address}/32`,
    ...peers,
    "",
  ].join("\n");
}
