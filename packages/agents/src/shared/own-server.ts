import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HostFacts, inspectHost } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { type OwnServerFacts, OwnServerFactsSchema, type OwnServerLogin } from "../providers";
import { SshRemoteExec } from "./remote";
import {
  type OwnServerConnection,
  readOwnServer,
  recordOwnServer,
  type ServerAddress,
} from "./server-address";
import {
  HOST_KEY_FINGERPRINT,
  knownHostsName,
  type ScannedHostKey,
  scanHostKeys,
  writeKnownHost,
} from "./wait";

/** What {@link connectOwnServer} needs from the phase. */
export type OwnServerDeps = Pick<
  PhaseDeps,
  "paths" | "runner" | "approvals" | "interactive" | "reporter" | "env"
>;

/** Options of {@link connectOwnServer}. */
export interface ConnectOwnServerOptions {
  /**
   * `--host-key SHA256:…`: the fingerprint the user checked on the server. Required on the first
   * connection when nobody can answer a prompt; when the server presents another key, nothing
   * connects. A fingerprint that differs from the pinned one replaces it (after a reinstall).
   */
  hostKey?: string;
  /** Builds the admin login's shell (tests); default: {@link SshRemoteExec} with the login. */
  remote?: (connection: OwnServerConnection) => RemoteExec;
  /** Home directory for `~/` key paths (default: `HOME`, `USERPROFILE`, then the OS's). */
  homeDir?: string;
}

/** A connection to the user's own server whose host key is confirmed and pinned. */
export interface OwnServerSession {
  /** The recorded connection (`.opscrew/server.json` → `own`), with the pinned host key. */
  connection: OwnServerConnection & { hostKey: string };
  /** The admin login's shell (root or passwordless sudo): pinned host key, keys only, no prompts. */
  remote: RemoteExec;
  /** The pinned host key. */
  hostKey: ScannedHostKey;
  /** The project's known_hosts file, which holds the pinned key. */
  knownHostsFile: string;
  /** True when this connection pinned the key (first use, or a new key named with `--host-key`). */
  pinned: boolean;
}

/** Plain-English stop when no login is recorded; never mentions an API token. */
export function ownServerNotSetUp(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew does not know how to reach your server on this computer: its address, SSH port, user and key are not recorded.",
    {
      hint: "Run `opscrew interview` and answer the questions about your server (address, SSH port, user, and your key file or `agent`). No API token is needed for your own server.",
    },
  );
}

/**
 * What to do about a damaged `.opscrew/server.json` on a project that deploys to the user's own
 * server. Never "delete it": the file holds the login and the confirmed host key.
 */
export const OWN_SERVER_DAMAGED_HINT =
  "Fix the JSON in .opscrew/server.json and run the command again. Keep the file: it holds how OpsCrew reaches your server and the host key you confirmed. If you cannot fix it, run `opscrew interview` again: it keeps the damaged file as .opscrew/server.json.damaged and records your server's login again, and OpsCrew asks you to confirm the server's host key at the next connection.";

/**
 * {@link readOwnServer} for a project on the user's own server: a damaged `.opscrew/server.json`
 * stops with `ARTIFACT_INVALID` and {@link OWN_SERVER_DAMAGED_HINT}.
 */
export async function readOwnServerRecord(
  paths: Pick<OwnServerDeps["paths"], "stateDir">,
): Promise<OwnServerConnection | undefined> {
  try {
    return await readOwnServer(paths);
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "ARTIFACT_INVALID") {
      throw new OpsCrewError("ARTIFACT_INVALID", error.message, {
        hint: OWN_SERVER_DAMAGED_HINT,
      });
    }
    throw error;
  }
}

/** The home directory `~/` key paths start from. */
function homeOf(env: Record<string, string | undefined>, override?: string): string {
  return override ?? (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
}

/** The private key file of a key login, with `~/` expanded; `undefined` for the SSH agent. */
export function ownServerKeyFile(
  connection: Pick<OwnServerConnection, "agent" | "keyPath">,
  env: Record<string, string | undefined>,
  homeDir?: string,
): string | undefined {
  if (connection.agent || connection.keyPath === undefined) return undefined;
  const path = connection.keyPath;
  return path.startsWith("~/") ? join(homeOf(env, homeDir), path.slice(2)) : path;
}

/** How the connector describes the login (for `vpsConnector("own", …, { ownLogin })`). */
export function ownServerLogin(connection: OwnServerConnection): OwnServerLogin {
  return {
    user: connection.user,
    port: connection.port,
    agent: connection.agent,
    ...(connection.keyPath !== undefined ? { keyPath: connection.keyPath } : {}),
  };
}

/** Stops with a plain message when the login's key file is not on this computer. */
export async function requireOwnServerKey(
  connection: OwnServerConnection,
  env: Record<string, string | undefined>,
  homeDir?: string,
): Promise<void> {
  const file = ownServerKeyFile(connection, env, homeDir);
  if (file === undefined) return;
  try {
    await access(file);
  } catch {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The SSH key ${connection.keyPath} that OpsCrew should log in to your server with is not on this computer.`,
      {
        hint: "Run `opscrew interview` again and give the path of your private key (or `agent` to use the key in your SSH agent), then try again. OpsCrew never asks for a password or passphrase.",
      },
    );
  }
}

/** The admin login's shell on the server: never reuses a connection, keeps long commands alive. */
function adminRemote(
  deps: Pick<OwnServerDeps, "runner" | "env">,
  connection: OwnServerConnection,
  knownHostsFile: string,
  homeDir?: string,
): RemoteExec {
  const keyFile = ownServerKeyFile(connection, deps.env, homeDir);
  return new SshRemoteExec({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    ...(keyFile !== undefined ? { keyFile } : {}),
    knownHostsFile,
    runner: deps.runner,
    fresh: true,
    keepAliveSeconds: 15,
  });
}

const CHECK_ON_SERVER =
  "Check the fingerprint on the server itself, for example in its provider's web console: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.";

function keyName(type: string): string {
  if (type === "ssh-ed25519") return "ED25519";
  if (type.startsWith("ecdsa-")) return "ECDSA";
  if (type === "ssh-rsa") return "RSA";
  return type;
}

function describeKey(key: ScannedHostKey): string {
  return `${key.fingerprint} (${keyName(key.type)})`;
}

/**
 * Connects to the server the user owns with the login recorded by the interview
 * (`.opscrew/server.json` → `own`: address, SSH port, user, key file or SSH agent; never a
 * password) and makes sure it is the right server (FR-903):
 *
 * - First connection: shows the host key's SHA-256 fingerprint and asks the user to confirm it
 *   (`remote-exec` approval), or takes the fingerprint given with `--host-key` (required when
 *   nobody can answer a prompt). The confirmed key is pinned in the project's known_hosts and in
 *   `own.hostKey`.
 * - Later connections: the server must present the pinned key; a different key stops everything
 *   with a plain warning and changes nothing. A new key named with `--host-key` (after the user
 *   reinstalled the server) replaces the pinned one.
 *
 * Returns the admin login's shell, which only ever talks to the pinned key.
 */
export async function connectOwnServer(
  deps: OwnServerDeps,
  options: ConnectOwnServerOptions = {},
): Promise<OwnServerSession> {
  const connection = await readOwnServerRecord(deps.paths);
  if (connection === undefined) throw ownServerNotSetUp();
  const given = options.hostKey?.trim();
  if (given !== undefined && !HOST_KEY_FINGERPRINT.test(given)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--host-key expects the server's SHA-256 host key fingerprint, such as SHA256: followed by 43 letters, digits, + or /.",
      { hint: `${CHECK_ON_SERVER} Pass the SHA256:… part it prints.` },
    );
  }
  await requireOwnServerKey(connection, deps.env, options.homeDir);

  const where = `${connection.host} (SSH port ${connection.port})`;
  const keys = await scanHostKeys({
    host: connection.host,
    port: connection.port,
    runner: deps.runner,
  });
  if (keys.length === 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not reach SSH on your server at ${where}, so it could not read the server's host key.`,
      {
        hint: "Check that the server is on and that this computer can reach it on that port. If the address or port is wrong, fix them with `opscrew interview`, then try again.",
      },
    );
  }

  const pinned = connection.hostKey;
  const wanted = given ?? pinned;
  let chosen: ScannedHostKey | undefined;
  if (wanted !== undefined) {
    chosen = keys.find((key) => key.fingerprint === wanted);
    if (chosen === undefined) {
      const presented = keys.map(describeKey).join(", ");
      if (given !== undefined) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `The server at ${where} presented the host key ${presented}, not the fingerprint you gave with --host-key (${given}). OpsCrew did not connect and changed nothing.`,
          {
            hint: `If you are sure this is your server, ${CHECK_ON_SERVER.charAt(0).toLowerCase()}${CHECK_ON_SERVER.slice(1)} Otherwise someone may be intercepting the connection.`,
          },
        );
      }
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The SSH host key of your server at ${where} changed since you confirmed it (confirmed: ${pinned}; now: ${presented}). OpsCrew stopped and changed nothing.`,
        {
          hint: `If you did not reinstall the server or change its SSH keys, someone may be intercepting the connection: check the server in its provider's console before going on. If you did, ${CHECK_ON_SERVER.charAt(0).toLowerCase()}${CHECK_ON_SERVER.slice(1)} Then run the command again with --host-key and the new fingerprint.`,
        },
      );
    }
    if (given !== undefined && pinned !== undefined && given !== pinned) {
      deps.reporter.warn(
        `Trusting the new SSH host key you named with --host-key (${given}) instead of the one confirmed earlier (${pinned}).`,
      );
    }
  } else {
    const first = keys[0] as ScannedHostKey;
    if (!deps.interactive) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `This is OpsCrew's first connection to your server at ${where}, and its SSH host key must be confirmed before OpsCrew trusts it. The server presents ${describeKey(first)}.`,
        {
          hint: `${CHECK_ON_SERVER} If it matches, run the command again with --host-key ${first.fingerprint}, or run it in a terminal to confirm it there.`,
        },
      );
    }
    // The title is audited: it names no address (the details, shown only in the terminal, do).
    const decision = await deps.approvals.request({
      kind: "remote-exec",
      title: "Trust the SSH host key of your server",
      details: [
        `This is OpsCrew's first connection to your server at ${where}. It presents this host key:`,
        `  ${describeKey(first)}`,
        ...(keys.length > 1
          ? ["Other keys it offers:", ...keys.slice(1).map((key) => `  ${describeKey(key)}`)]
          : []),
        CHECK_ON_SERVER,
        "Approve only if the fingerprints match. OpsCrew then pins the key, and a different key later stops every command.",
      ].join("\n"),
    });
    if (!decision.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        "You did not confirm the server's host key, so OpsCrew did not connect. Nothing was changed.",
        {
          hint: `${CHECK_ON_SERVER} Then run the command again and confirm it, or pass it with --host-key.`,
        },
      );
    }
    chosen = first;
  }

  const knownHostsFile = deps.paths.files.knownHosts;
  // Always (re)write the entry: the known_hosts file may be missing on this computer.
  await writeKnownHost(knownHostsFile, knownHostsName(connection.host, connection.port), [chosen]);
  const changed = chosen.fingerprint !== pinned;
  if (changed) await recordOwnServer(deps.paths, { ...connection, hostKey: chosen.fingerprint });
  const session = { ...connection, hostKey: chosen.fingerprint };
  return {
    connection: session,
    remote:
      options.remote?.(session) ?? adminRemote(deps, session, knownHostsFile, options.homeDir),
    hostKey: chosen,
    knownHostsFile,
    pinned: changed,
  };
}

/**
 * A function that opens NEW SSH connections (never a reused one: `ControlMaster=no`,
 * `ControlPath=none`) as the deploy user with the project's deploy key and as the user's own
 * admin login, and resolves true only when both log in. The host adapter calls it after an SSH or
 * firewall change and lets the server undo the change on its own otherwise.
 */
export function ownServerLoginCheck(
  deps: Pick<OwnServerDeps, "runner" | "env">,
  session: Pick<OwnServerSession, "connection" | "knownHostsFile">,
  options: { deployKeyFile: string; homeDir?: string },
): () => Promise<boolean> {
  const { connection, knownHostsFile } = session;
  const login = async (user: string, keyFile: string | undefined) => {
    const remote = new SshRemoteExec({
      host: connection.host,
      port: connection.port,
      user,
      ...(keyFile !== undefined ? { keyFile } : {}),
      knownHostsFile,
      runner: deps.runner,
      fresh: true,
    });
    try {
      return (await remote.run("true", { timeoutMs: 30_000 })).exitCode === 0;
    } catch {
      return false;
    }
  };
  return async () =>
    (await login("deploy", options.deployKeyFile)) &&
    (await login(connection.user, ownServerKeyFile(connection, deps.env, options.homeDir)));
}

/** What {@link inspectOwnServer} found. */
export interface InspectedOwnServer {
  /** Everything inspection read (host adapter facts). */
  facts: HostFacts;
  /** The facts design needs (architecture, CPUs, memory, free disk, OS). */
  server: OwnServerFacts;
}

const GIB = 1024 ** 3;

/** `x` GB with one decimal, rounded down (a server never seems bigger than it is). */
function gigabytes(bytes: number): number {
  return Math.floor((bytes / GIB) * 10) / 10;
}

/**
 * Design's view of the inspected server ({@link OwnServerFacts}): architecture, CPUs, memory and
 * free disk in GB (GiB, as providers label sizes) and the operating system's name.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the architecture is neither amd64 nor arm64.
 */
export function ownServerFacts(facts: HostFacts): OwnServerFacts {
  if (facts.arch !== "amd64" && facts.arch !== "arm64") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your server's processor architecture is ${facts.arch || facts.machine || "unknown"}; OpsCrew supports amd64 and arm64.`,
      { hint: "Use a 64-bit server (x86-64 or ARM64). On a Raspberry Pi, install the 64-bit OS." },
    );
  }
  const os = facts.os.prettyName.trim().slice(0, 100);
  return OwnServerFactsSchema.parse({
    arch: facts.arch,
    vcpus: Math.max(1, facts.cpus),
    memoryGb: gigabytes(facts.memoryBytes),
    diskFreeGb: gigabytes(facts.diskFreeBytes),
    ...(os !== "" ? { os } : {}),
  });
}

/**
 * Inspects the server through the host adapter (`inspectHost`: fixed, read-only commands; it never
 * changes anything) and maps the facts to design's {@link OwnServerFacts}. Callers connect first
 * with {@link connectOwnServer}.
 */
export async function inspectOwnServer(
  session: Pick<OwnServerSession, "remote">,
  options: { inspect?: (remote: RemoteExec) => Promise<HostFacts> } = {},
): Promise<InspectedOwnServer> {
  const facts = await (options.inspect ?? inspectHost)(session.remote);
  return { facts, server: ownServerFacts(facts) };
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function publicIpv4(value: string | undefined): string | undefined {
  if (value === undefined || !z.ipv4().safeParse(value).success) return undefined;
  return PRIVATE_V4.some((range) => range.test(value)) ? undefined : value;
}

function publicIpv6(value: string | undefined): string | undefined {
  if (value === undefined || !z.ipv6().safeParse(value).success) return undefined;
  const lower = value.toLowerCase();
  return lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) ? undefined : value;
}

/**
 * The public addresses DNS points to when the internet reaches the server directly: the ones
 * recorded earlier (`own.publicIpv4/6`), else the address OpsCrew connects to when it is a public
 * IP, else the public addresses inspection found on the server's interfaces. `undefined` without a
 * public IPv4 address. Local state only: never write them to committed files.
 */
export function ownServerPublicAddress(
  connection: Pick<OwnServerConnection, "host" | "publicIpv4" | "publicIpv6">,
  facts?: Pick<HostFacts, "addresses">,
): ServerAddress | undefined {
  const found = (family: "ipv4" | "ipv6") =>
    facts?.addresses.find((a) => a.family === family && a.public)?.address;
  const ipv4 = connection.publicIpv4 ?? publicIpv4(connection.host) ?? publicIpv4(found("ipv4"));
  if (ipv4 === undefined) return undefined;
  const ipv6 = connection.publicIpv6 ?? publicIpv6(connection.host) ?? publicIpv6(found("ipv6"));
  return { ipv4, ...(ipv6 !== undefined ? { ipv6 } : {}) };
}
