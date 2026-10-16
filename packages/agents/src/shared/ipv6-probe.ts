import { networkInterfaces } from "node:os";
import type { TcpConnect } from "@opscrew/secops";

/**
 * Whether this computer can probably reach IPv6 addresses: one of its interfaces has a global
 * IPv6 address (not loopback, link-local or unique-local).
 */
export async function hasIpv6Route(): Promise<boolean> {
  return Object.values(networkInterfaces()).some((list) =>
    (list ?? []).some(
      (address) =>
        address.family === "IPv6" &&
        !address.internal &&
        !/^(fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:|::1$)/i.test(address.address),
    ),
  );
}

/**
 * Whether port 443 answers on the server's IPv6 address, or `undefined` when this computer has no
 * IPv6 route to try it (`ipv6Route`, default {@link hasIpv6Route}). Behind OpsCrew's web filter it
 * must not answer: the site is published on IPv4 only.
 */
export async function ipv6HttpsAnswers(
  ipv6: string,
  connect: TcpConnect,
  timeoutMs: number,
  ipv6Route: () => Promise<boolean> = hasIpv6Route,
): Promise<boolean | undefined> {
  return (await ipv6Route()) ? connect(ipv6, 443, timeoutMs) : undefined;
}
