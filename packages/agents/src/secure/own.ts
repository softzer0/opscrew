import type { DeployPlan } from "@opscrew/plan-schema";
import type { OwnServerHardening } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { lastHostSetup, passwordLoginChoice } from "../drift/host";
import { readOwnServerRecord } from "../provision";
import { readServerAddresses } from "../shared";

/** How `opscrew secure` checks a server the user owns. Local state only; never committed. */
export interface OwnSecureTarget {
  /** The address OpsCrew logs in to (the recorded login's host) and its SSH port. */
  sshHost: string;
  sshPort: number;
  /** Where the outside probes go: the public address in public mode, the login's host in tunnel mode. */
  probeHost: string;
  /** Public mode: the server's public IPv6 address, when known (probed in web-filter mode). */
  probeIpv6?: string;
  access: "public" | "tunnel";
  /** What the host checks accept on this server (SSH ports, root login, the password choice). */
  hardening: OwnServerHardening;
  /** Every address and host name of the server, which the committed report must not contain. */
  hidden: string[];
}

function ports(value: string | number | boolean | undefined): number[] {
  return String(value ?? "")
    .split(" ")
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

/**
 * What `opscrew secure` needs for a server the user owns, from OpsCrew's local state: the recorded
 * login and addresses, and the last applied setup host plan (sshd's real ports, whether root keeps
 * key-only logins because the user connects as root, and whether the user chose to keep password
 * logins). Without that plan: the login's port, root login only for a root login, no password
 * choice. `undefined` when this computer does not know how to reach the server.
 */
export async function ownSecureTarget(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<OwnSecureTarget | undefined> {
  if (plan.target.provider !== "own") return undefined;
  const connection = await readOwnServerRecord(deps.paths);
  if (connection === undefined) return undefined;
  const setup = await lastHostSetup(deps, plan);
  const step = (id: string) => setup?.steps.find((item) => item.id === id)?.params;
  // sshd's real ports on the server, as the applied setup plan found them (the port the user logs
  // in on may be forwarded, for example 2222 on a router to 22); the login's port only without one.
  const planned = ports(step("ufw")?.sshPorts ?? step("fail2ban")?.sshPorts);
  const sshPorts = [...new Set(planned.length > 0 ? planned : [connection.port])].sort(
    (a, b) => a - b,
  );
  const permitRootLogin = step("sshd")?.permitRootLogin;
  const rootLogin =
    permitRootLogin === undefined
      ? connection.user === "root"
      : permitRootLogin === "prohibit-password";
  const deployment = (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  const access = plan.target.access;
  const publicIpv4 = deployment?.ipv4 ?? connection.publicIpv4;
  const publicIpv6 = deployment?.ipv6 ?? connection.publicIpv6;
  const hidden = [
    connection.host,
    connection.publicIpv4,
    connection.publicIpv6,
    deployment?.ipv4,
    deployment?.ipv6,
  ].filter((value): value is string => value !== undefined && value !== "");
  return {
    sshHost: connection.host,
    sshPort: connection.port,
    probeHost: access === "public" ? (publicIpv4 ?? connection.host) : connection.host,
    ...(access === "public" && publicIpv6 !== undefined ? { probeIpv6: publicIpv6 } : {}),
    access,
    hardening: {
      sshPorts,
      rootLogin,
      passwordsKept: passwordLoginChoice(setup) === "keep",
    },
    hidden: [...new Set(hidden)],
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text` with every address and host name of `hidden` replaced by "your server", for the committed
 * security report of a server the user owns (FR-902).
 */
export function withoutOwnServer(text: string, hidden: readonly string[]): string {
  let out = text;
  for (const name of [...hidden].sort((a, b) => b.length - a.length)) {
    out = out.replace(
      new RegExp(`(?<![0-9A-Za-z.:-])${escapeRegExp(name)}(?![0-9A-Za-z:-]|\\.[0-9A-Za-z])`, "gi"),
      "your server",
    );
  }
  return out;
}
