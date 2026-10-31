import { BlockList, isIP } from "node:net";
import type { HostFacts } from "@opscrew/connector-ssh-host";
import type { RemoteExec, VpsProviderId } from "@opscrew/contracts";
import { normalizeHostName, OpsCrewError, type Redactor, readTextIfExists } from "@opscrew/core";
import { APP_SERVER, type DeployPlan, readOptionalArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { hasPublicAddress } from "../network/endpoints";

import { type EngineDeps, infrastructureOutputs, type OutputsOptions } from "./engine";
import { lastHostSetup, lastServerSetup } from "./host-plan";
import { ownServerKeyFile } from "./own-server";
import { SshRemoteExec, type SshRemoteExecOptions } from "./remote";
import {
  readServerAddresses,
  recordServerAddress,
  type ServerAddress,
  type SshLogin,
} from "./server-record";
import { keysFor, knownHostsName, writeKnownHost } from "./wait";

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
 * The public address of one of the app's servers: `app` (the default) or an extra server by name.
 *
 * The app's server: from OpsCrew's local state (`.opscrew/server.json`), else, for an applied
 * deployment whose infrastructure state is on this computer, from the OpenTofu/Terraform outputs
 * (`server_ipv4`, `server_ipv6`), which are then recorded in the local state. An extra server: from
 * the local state's `servers`. `undefined` when the server's address is not known here. Every
 * command that needs an address reads it here; it is never read from or written to
 * `opscrew/plan.yaml`.
 */
export async function serverAddress(
  deps: EngineDeps,
  plan: DeployPlan,
  options?: OutputsOptions,
): Promise<ServerAddress | undefined>;
export async function serverAddress(
  deps: EngineDeps,
  plan: DeployPlan,
  name: string,
  options?: OutputsOptions,
): Promise<ServerAddress | undefined>;
export async function serverAddress(
  deps: EngineDeps,
  plan: DeployPlan,
  nameOrOptions: string | OutputsOptions = APP_SERVER,
  outputsOptions: OutputsOptions = {},
): Promise<ServerAddress | undefined> {
  const name = typeof nameOrOptions === "string" ? nameOrOptions : APP_SERVER;
  const options = typeof nameOrOptions === "string" ? outputsOptions : nameOrOptions;
  const record = await readServerAddresses(deps.paths);
  if (name !== APP_SERVER) return record.servers?.[name];
  const local = record.deployment;
  if (local !== undefined) return local;
  if (!hasDeployment(plan)) return undefined;
  const outputs = await infrastructureOutputs(deps, plan, options);
  const address = outputs === undefined ? undefined : addressFromOutputs(outputs);
  if (address !== undefined) {
    await recordServerAddress(deps.paths, address).catch(() => undefined);
  }
  return address;
}

/** How OpsCrew logs in to one of the app's servers over SSH, at its public address. */
export interface ServerLogin {
  host: string;
  port: number;
  user: string;
  /** Absent when the SSH agent holds the key. */
  keyFile?: string;
  /** True for a server the user owns (its admin login), false for one OpsCrew created (`deploy`). */
  own: boolean;
}

const NOT_KNOWN_HERE =
  "Run the command on the computer that ran `opscrew provision` (it keeps the servers' addresses in .opscrew/server.json).";

/** The admin login of a server the user owns, with its key file. */
function ownLogin(deps: Pick<EngineDeps, "env">, login: SshLogin): ServerLogin {
  const keyFile = ownServerKeyFile(login, deps.env);
  return {
    host: login.host,
    port: login.port,
    user: login.user,
    ...(keyFile !== undefined ? { keyFile } : {}),
    own: true,
  };
}

/**
 * How OpsCrew logs in to the server `name` (`app` or an extra server) at its public address: a
 * server the user owns with its recorded admin login, one OpsCrew created as `deploy` with the
 * project's deploy key.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the login or address is not on this computer, or
 * the app's target has no server.
 */
export async function serverLogin(
  deps: EngineDeps,
  plan: DeployPlan,
  name: string,
): Promise<ServerLogin> {
  const record = await readServerAddresses(deps.paths);
  const deploy = (address: ServerAddress | undefined, where: string): ServerLogin => {
    if (address === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew does not know the address of ${where} on this computer.`,
        { hint: NOT_KNOWN_HERE },
      );
    }
    return {
      host: address.ipv4,
      port: 22,
      user: "deploy",
      keyFile: deps.paths.files.deployKey,
      own: false,
    };
  };
  if (name === APP_SERVER) {
    const provider = plan.target.provider;
    if (provider === "own") {
      if (record.own === undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "OpsCrew does not know how to log in to your server (app) on this computer.",
          { hint: "Run `opscrew interview` and answer the questions about your server." },
        );
      }
      return ownLogin(deps, record.own);
    }
    if (provider !== "hetzner" && provider !== "digitalocean") {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The app's target (${provider}) has no server for OpsCrew to log in to.`,
      );
    }
    return deploy(await serverAddress(deps, plan), "the app's server (app)");
  }
  const server = (plan.servers ?? []).find((s) => s.name === name);
  if (server === undefined) throw new Error(`The plan has no server named "${name}".`);
  if (server.target.provider === "own") {
    const login = record.ownServers?.[name];
    if (login === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew does not know how to log in to server ${name} on this computer.`,
        { hint: "Run `opscrew design` and give the server's address and SSH login." },
      );
    }
    return ownLogin(deps, login);
  }
  return deploy(record.servers?.[name], `server ${name}`);
}

/** What ssh prints when it could not reach the server at all (exit code 255). */
const SSH_UNREACHABLE =
  /connect to host|connection timed out|operation timed out|no route to host|network is unreachable|connection refused/i;

/** How to check this computer's WireGuard tunnel, for a connection over it that failed. */
export const TUNNEL_DOWN_HINT =
  "Check that the WireGuard tunnel is on: your WireGuard app, or `sudo wg show` in a terminal, should list it with a recent handshake. Turn it on, then run the command again.";

/** A connection over the private network that says when this computer's tunnel looks down. */
function throughTunnel(
  remote: RemoteExec,
  server: string,
  address: string,
  device: string,
): RemoteExec {
  return {
    host: remote.host,
    async run(command, options) {
      const result = await remote.run(command, options);
      if (result.exitCode === 255 && SSH_UNREACHABLE.test(result.stderr)) {
        throw new OpsCrewError(
          "COMMAND_FAILED",
          `OpsCrew could not reach server ${server} at its private address ${address}. Public SSH is closed, so OpsCrew connects over the app's private network, and this computer's tunnel (device ${device}) looks down.`,
          { hint: TUNNEL_DOWN_HINT },
        );
      }
      return result;
    },
  };
}

/** The valid ports of a host plan's ports text (`"22 2222"`, its `ufw` step's `sshPorts`). */
export function portList(value: string | number | boolean | undefined): number[] {
  return String(value ?? "")
    .split(" ")
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

/**
 * The port sshd listens on, for a connection that reaches it directly (the private network, the
 * server itself): of sshd's `ports`, the login's when it is one of them, else the lowest; the
 * login's when none is known. A router may forward another public port (2222) to sshd's (22).
 */
export function listeningSshPort(ports: readonly number[], loginPort: number): number {
  if (ports.length === 0 || ports.includes(loginPort)) return loginPort;
  return Math.min(...ports);
}

/**
 * {@link listeningSshPort} from what inspection found on the server: sshd's ports (`sshd -T`) and
 * the TCP ports sshd listens on.
 */
export function networkSshPort(
  facts: Pick<HostFacts, "sshd" | "listeners">,
  loginPort: number,
): number {
  const listening = facts.listeners
    .filter((listener) => listener.proto === "tcp" && listener.process === "sshd")
    .map((listener) => listener.port);
  return listeningSshPort([...(facts.sshd?.ports ?? []), ...listening], loginPort);
}

/**
 * The port sshd listens on on the server `name`, for a connection over the private network: on a
 * server the user owns from its last setup plan (the SSH ports inspection found there, as `secure`
 * reads them), on one OpsCrew created the login's (22).
 */
async function privateSshPort(
  deps: Pick<EngineDeps, "paths">,
  plan: DeployPlan,
  name: string,
  login: Pick<ServerLogin, "port" | "own">,
): Promise<number> {
  if (!login.own) return login.port;
  const setup =
    name === APP_SERVER ? await lastHostSetup(deps, plan) : await lastServerSetup(deps, name);
  const ports = setup?.steps.find((step) => step.id === "ufw")?.params.sshPorts;
  return listeningSshPort(portList(ports), login.port);
}

/** Where OpsCrew connects over SSH: an address and its port. */
export interface SshReach {
  host: string;
  port: number;
}

/**
 * Where OpsCrew reaches the server `name` over SSH once public SSH is closed
 * (`network.publicSsh: false`): its private address, on the port sshd listens on there.
 * `undefined` while public SSH is open, for a server without a public address (its SSH was never
 * public: OpsCrew keeps reaching it at its login's address), and for a server not on the network.
 */
export async function privateReach(
  deps: Pick<EngineDeps, "paths">,
  plan: DeployPlan,
  name: string,
  login: Pick<ServerLogin, "port" | "own">,
): Promise<SshReach | undefined> {
  if (plan.network?.publicSsh !== false || !hasPublicAddress(plan, name)) return undefined;
  const member = plan.network.members.find((m) => m.name === name);
  if (member === undefined) return undefined;
  return { host: member.address, port: await privateSshPort(deps, plan, name, login) };
}

/**
 * `plan` with public SSH open again (`network.publicSsh: true`), to the allow-list the plan held
 * before it closed (`network.publicSshAllowedCidrs`, which leaves the plan), else to
 * `security.sshAllowedCidrs`, and to everyone when that list is empty (as it is while closed).
 */
export function reopenedPlan(plan: DeployPlan): DeployPlan {
  if (plan.network === undefined) return plan;
  const { publicSshAllowedCidrs: kept, ...network } = plan.network;
  const cidrs = kept ?? plan.security.sshAllowedCidrs;
  return {
    ...plan,
    network: { ...network, publicSsh: true },
    security: {
      ...plan.security,
      sshAllowedCidrs: cidrs.length > 0 ? [...cidrs] : ["0.0.0.0/0", "::/0"],
    },
  };
}

/**
 * {@link privateReach} of a server the user owns (`app` or an extra server), with the project's
 * plan: for the connections that open with its login and confirm its host key. `undefined`
 * without a readable plan.
 */
export async function ownServerReach(
  deps: Pick<EngineDeps, "paths">,
  name: string,
  login: { port: number },
): Promise<SshReach | undefined> {
  const plan = await readOptionalArtifact("plan", deps.paths.files.plan).catch(() => undefined);
  return plan === undefined
    ? undefined
    : privateReach(deps, plan, name, { port: login.port, own: true });
}

/**
 * Pins the host key pinned for `from` under `to` too, in the project's known_hosts: the server
 * answers SSH on its private address with the same key.
 * @throws OpsCrewError `PHASE_PRECONDITION` when no key is pinned for `from`.
 */
async function pinPrivateName(file: string, from: string, to: string, server: string) {
  const keys = keysFor((await readTextIfExists(file)) ?? "", from).map((pinned) => {
    const [type = "", key = ""] = pinned.split(" ");
    return { type, key };
  });
  if (keys.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The SSH host key of server ${server} is not pinned on this computer, and public SSH is closed, so OpsCrew cannot check the server it connects to.`,
      {
        hint: "Run the command on the computer that set up the servers, or open public SSH there with `opscrew secure --open-public-ssh`.",
      },
    );
  }
  await writeKnownHost(file, to, keys);
}

/**
 * A shell on the server `name` (`app` or an extra server), with its {@link serverLogin} and the
 * host key pinned in the project's known_hosts. It connects to the public address, or, once
 * public SSH is closed, to the server's private address on the port sshd listens on there
 * ({@link privateReach}), with the same host key, pinned under that address as well. Then, when
 * this computer is a device on the network (`thisDevice`), a connection that fails says this
 * computer's tunnel looks down and how to check it. `options` are ssh's as other connections take
 * them: a new connection every time (`fresh`), keep-alive probes for long commands.
 */
export async function serverRemote(
  deps: EngineDeps,
  plan: DeployPlan,
  name: string,
  options: Pick<SshRemoteExecOptions, "fresh" | "keepAliveSeconds"> = {},
): Promise<RemoteExec> {
  const login = await serverLogin(deps, plan, name);
  return remoteAt(
    deps,
    plan,
    name,
    login,
    ({ host, port }) =>
      new SshRemoteExec({
        host,
        port,
        user: login.user,
        ...(login.keyFile !== undefined ? { keyFile: login.keyFile } : {}),
        knownHostsFile: deps.paths.files.knownHosts,
        runner: deps.runner,
        ...options,
      }),
  );
}

/**
 * The deploy user's shell on the app's server (the project's deploy key, the pinned host key),
 * whose deploy logs in at `login` (its public address and port): there, or once public SSH is
 * closed at its private address, as {@link serverRemote} connects. `options.remote` replaces ssh
 * in tests, given the address it connects to.
 */
export async function appServerShell(
  deps: Pick<EngineDeps, "paths" | "runner">,
  plan: DeployPlan,
  login: SshReach,
  options: { remote?: (host: string) => RemoteExec; keepAliveSeconds?: number } = {},
): Promise<RemoteExec> {
  const own = plan.target.provider === "own";
  return remoteAt(
    deps,
    plan,
    APP_SERVER,
    { ...login, own },
    ({ host, port }) =>
      options.remote?.(host) ??
      new SshRemoteExec({
        host,
        port,
        keyFile: deps.paths.files.deployKey,
        knownHostsFile: deps.paths.files.knownHosts,
        runner: deps.runner,
        ...(options.keepAliveSeconds !== undefined
          ? { keepAliveSeconds: options.keepAliveSeconds }
          : {}),
      }),
  );
}

/**
 * The shell `ssh` opens on the server `name` at `login`, or, once public SSH is closed, at its
 * private address ({@link privateReach}) with the host key pinned there too; then, when this
 * computer is a device on the network, a connection that fails says its tunnel looks down.
 */
async function remoteAt(
  deps: Pick<EngineDeps, "paths">,
  plan: DeployPlan,
  name: string,
  login: SshReach & Pick<ServerLogin, "own">,
  ssh: (at: SshReach) => RemoteExec,
): Promise<RemoteExec> {
  const reach = await privateReach(deps, plan, name, login);
  if (reach === undefined) return ssh(login);
  await pinPrivateName(
    deps.paths.files.knownHosts,
    knownHostsName(login.host, login.port),
    knownHostsName(reach.host, reach.port),
    name,
  );
  const remote = ssh(reach);
  const device = (await readServerAddresses(deps.paths)).thisDevice;
  return device === undefined ? remote : throughTunnel(remote, name, reach.host, device);
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
