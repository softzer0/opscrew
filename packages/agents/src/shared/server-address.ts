import { BlockList, isIP } from "node:net";
import type { VpsProviderId } from "@opscrew/contracts";
import { normalizeHostName, type Redactor } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import { type EngineDeps, infrastructureOutputs, type OutputsOptions } from "./engine";
import { readServerAddresses, recordServerAddress, type ServerAddress } from "./server-record";

/**
 * True when `a` and `b` are the same IP address, however each is written (`2001:DB8:0::1` is
 * `2001:db8::1`); false when either is not an IP address or they are of different families.
 */
export function sameIp(a: string, b: string): boolean {
  const family = isIP(a);
  if (family === 0 || isIP(b) !== family) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  const list = new BlockList();
  list.addAddress(a, type);
  return list.check(b, type);
}

/** `{ ipv4, ipv6 }` when `ipv4` is a valid address (an invalid `ipv6` is left out). */
function addressOf(ipv4: unknown, ipv6: unknown): ServerAddress | undefined {
  const v4 = z.ipv4().safeParse(ipv4);
  if (!v4.success) return undefined;
  const v6 = z.ipv6().safeParse(ipv6);
  return { ipv4: v4.data, ...(v6.success ? { ipv6: v6.data } : {}) };
}

/**
 * The address of the server that receives the traffic, from the root-module outputs
 * `server_ipv4` / `server_ipv6`, when valid.
 */
export function addressFromOutputs(outputs: Record<string, unknown>): ServerAddress | undefined {
  return addressOf(outputs.server_ipv4, outputs.server_ipv6);
}

const ServersOutputSchema = z.record(
  z.string(),
  z.looseObject({ ipv4: z.unknown().optional(), ipv6: z.unknown().optional() }),
);

/**
 * The address of `provider`'s server from the root-module output `servers` (every server keyed by
 * its provider, whichever module holds it), when valid. A move always goes to another provider,
 * so this tells the server being replaced from the new one without guessing.
 */
export function serverOfProvider(
  outputs: Record<string, unknown>,
  provider: VpsProviderId,
): ServerAddress | undefined {
  const servers = ServersOutputSchema.safeParse(outputs.servers);
  if (!servers.success) return undefined;
  const entry = servers.data[provider];
  return entry === undefined ? undefined : addressOf(entry.ipv4, entry.ipv6);
}

/** True when the plan records an applied deployment that was not destroyed since. */
export function hasDeployment(plan: Pick<DeployPlan, "deployment">): boolean {
  return plan.deployment.lastApplyAt !== undefined && plan.deployment.destroyedAt === undefined;
}

/**
 * The address of the server that receives the app's traffic: from OpsCrew's local state
 * (`.opscrew/server.json`), else, for an applied deployment whose infrastructure state is on this
 * computer, from the OpenTofu/Terraform outputs (`server_ipv4`, `server_ipv6`), which are then
 * recorded in the local state. `undefined` when no server is known. Every command that needs the
 * address reads it here; it is never read from or written to `opscrew/plan.yaml`.
 */
export async function serverAddress(
  deps: EngineDeps,
  plan: DeployPlan,
  options: OutputsOptions = {},
): Promise<ServerAddress | undefined> {
  const local = (await readServerAddresses(deps.paths)).deployment;
  if (local !== undefined) return local;
  if (!hasDeployment(plan)) return undefined;
  const outputs = await infrastructureOutputs(deps, plan, options);
  const address = outputs === undefined ? undefined : addressFromOutputs(outputs);
  if (address !== undefined) {
    await recordServerAddress(deps.paths, address).catch(() => undefined);
  }
  return address;
}

/**
 * True when the app's domain is served through Cloudflare's proxy: the server's address must then
 * stay out of every committed file (plan, runbook, reports), or anyone could go around Cloudflare.
 */
export function hidesServerAddress(plan: Pick<DeployPlan, "dns">): boolean {
  return plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined && plan.dns.proxied;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with every occurrence of the addresses replaced by `replacement` (default "the server"),
 * for files that are committed while the address must stay private.
 */
export function withoutServerAddress(
  text: string,
  addresses: readonly (ServerAddress | undefined)[],
  replacement = "the server",
): string {
  let out = text;
  for (const address of addresses) {
    if (address === undefined) continue;
    out = out.replace(
      new RegExp(`(?<![\\d.])${escapeRegExp(address.ipv4)}(?![\\d])`, "g"),
      replacement,
    );
    if (address.ipv6 !== undefined) {
      out = out.replace(
        new RegExp(`(?<![0-9a-f:])${escapeRegExp(address.ipv6)}(?![0-9a-f:])`, "gi"),
        replacement,
      );
    }
  }
  return out;
}

/**
 * The names under which an address given as a URL can appear in text, longest first and each
 * once (ignoring case): the URL as given, its origin, its host with the port, and its host name,
 * each also without a trailing dot, and an IPv6 address also without brackets. None for a URL
 * that cannot be parsed. Register them with `Redactor.addName` or replace them with core's
 * `replaceNames`; callers leave out what may be shown (this computer, the app's own domain).
 */
export function addressNames(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const hostname = parsed.hostname.replace(/\.$/, "");
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  const bare = /^\[(.+)\]$/.exec(hostname)?.[1];
  const names = [
    url,
    parsed.origin,
    parsed.host,
    `${hostname}${port}`,
    parsed.hostname,
    hostname,
    ...(bare !== undefined ? [bare] : []),
  ];
  const seen = new Set<string>();
  return names
    .map((name) => name.trim())
    .filter((name) => {
      const key = name.toLowerCase();
      if (name === "" || name === "null" || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.length - a.length);
}

/**
 * Host names that mean "this computer" (also from a container on it); never hidden alone, they
 * are not Portainer's address to anyone else and are too common.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"]);
/** The product's own name: every message names it, so a host called that is not hidden alone. */
const PRODUCT_NAME = "portainer";

/**
 * The names under which Portainer's address can appear in text (`addressNames`): the URL as given
 * and its origin always, its host and host name forms only when it is not this computer. A host
 * name that is just `portainer` is left out alone (every message names Portainer; with the port it
 * is still listed). Invalid addresses give none (the interview refuses them with its own message).
 */
export function portainerAddressNames(url: string): string[] {
  const names = addressNames(url);
  if (names.length === 0) return [];
  const local = LOOPBACK.has(new URL(url).hostname.replace(/\.$/, ""));
  return names.filter(
    (name) => name.includes("://") || (!local && normalizeHostName(name) !== PRODUCT_NAME),
  );
}

/**
 * Registers Portainer's address ({@link portainerAddressNames}) with `redactor` as names: masked
 * ignoring case and only where they stand alone, so no output, tool result or audit entry shows
 * the address, while words that contain the host name (`opscrew-shop-portainer-tunnel`,
 * `portainer.url`) stay intact.
 */
export function hidePortainerAddress(redactor: Pick<Redactor, "addName">, url: string): void {
  for (const name of portainerAddressNames(url)) redactor.addName(name, "portainer-address");
}

/**
 * `url` when it names a domain; `undefined` for a URL on an IP address, which must not be
 * committed (`deployment.url` in `opscrew/plan.yaml` only holds domain URLs).
 */
export function committableUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
  return z.ipv4().safeParse(host).success || z.ipv6().safeParse(host).success ? undefined : url;
}

/** `203.0.113.10` or `203.0.113.10 (IPv6 2001:db8::10)`, for terminal output. */
export function formatServerAddress(address: ServerAddress): string {
  return address.ipv6 === undefined ? address.ipv4 : `${address.ipv4} (IPv6 ${address.ipv6})`;
}
