import { access, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HostFacts, inspectHost, isPublicAddress } from "@opscrew/connector-ssh-host";
import type { CommandResult, PhaseName, RemoteExec } from "@opscrew/contracts";
import { errorMessage, OpsCrewError, upperFirst } from "@opscrew/core";
import { APP_SERVER } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  type OwnServerFacts,
  OwnServerFactsSchema,
  type OwnServerLogin,
  sshKeyWords,
} from "../providers";
import type { OwnServerServices } from "../provision/types";
import { SshRemoteExec } from "./remote";
import { ownServerReach, type SshReach, TUNNEL_DOWN_HINT } from "./server-address";
import {
  type OwnServerConnection,
  readOwnServer,
  recordOwnServer,
  type ServerAddress,
  type SshLogin,
  updateServerAddresses,
} from "./server-record";
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
  "paths" | "runner" | "approvals" | "interactive" | "reporter" | "env" | "redactor"
>;

/** Options of {@link connectOwnServer}. */
export interface ConnectOwnServerOptions {
  /**
   * `--host-key SHA256:…`: the fingerprint the user checked on the server. Required on the first
   * connection when nobody can answer a prompt; when the server presents another key, nothing
   * connects. A fingerprint that differs from the pinned one replaces it (after a reinstall).
   */
  hostKey?: string | undefined;
  /**
   * The admin login's shell (default: {@link SshRemoteExec} with the login) and the home directory
   * for `~/` key paths (default: `HOME`, `USERPROFILE`, then the OS's); fakes in tests.
   */
  services?: Pick<OwnServerServices, "remote" | "homeDir"> | undefined;
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
  /** Where OpsCrew connects when it is not the login's address: the server's private address. */
  reach?: SshReach;
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

/** How the messages of {@link connectPinnedLogin} name the machine and the fix for its login. */
export interface LoginWords {
  /** The machine: `your server`, `the runner machine home`. */
  noun: string;
  /** The command that records the login again, in backticks: `` `opscrew interview` ``. */
  fix: string;
  /** What to do when the login's key file is missing: a sentence. */
  missingKey: string;
}

/** The words for the user's own server, whose login the interview records. */
const OWN_SERVER_WORDS: LoginWords = {
  noun: "your server",
  fix: "`opscrew interview`",
  missingKey:
    "Run `opscrew interview` again and give the path of your private key (or `agent` to use the key in your SSH agent), then try again.",
};

/** Stops with a plain message when the login's key file is not on this computer. */
export async function requireOwnServerKey(
  connection: Pick<OwnServerConnection, "agent" | "keyPath">,
  env: Record<string, string | undefined>,
  homeDir?: string,
  words: Pick<LoginWords, "noun" | "missingKey"> = OWN_SERVER_WORDS,
): Promise<void> {
  const file = ownServerKeyFile(connection, env, homeDir);
  if (file === undefined) return;
  try {
    await access(file);
  } catch {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The SSH key ${connection.keyPath} that OpsCrew should log in to ${words.noun} with is not on this computer.`,
      {
        hint: `${words.missingKey} OpsCrew never asks for a password or passphrase.`,
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

/** How the user reads the host key's fingerprint on the server, after "Check" or "check". */
const ON_SERVER =
  "the fingerprint on the server itself, for example in its provider's web console: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.";
const CHECK_ON_SERVER = `Check ${ON_SERVER}`;

/** Why OpsCrew connects at a private address: before {@link TUNNEL_DOWN_HINT}. */
const OVER_TUNNEL =
  "Public SSH is closed, so OpsCrew connects over the app's private network, through this computer's WireGuard tunnel.";

/** What to do when the server presents another host key than the one the user confirmed. */
const CHANGED_KEY_HINT = `If you did not reinstall the server or change its SSH keys, someone may be intercepting the connection: check the server in its provider's console before going on. If you did, check ${ON_SERVER} Then run the command again with --host-key and the new fingerprint.`;

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
 * password) and makes sure it is the right server (FR-903), through {@link connectPinnedLogin}:
 * the confirmed key is pinned in the project's known_hosts and in `own.hostKey`.
 */
export async function connectOwnServer(
  deps: OwnServerDeps,
  options: ConnectOwnServerOptions = {},
): Promise<OwnServerSession> {
  const connection = await readOwnServerRecord(deps.paths);
  if (connection === undefined) throw ownServerNotSetUp();
  const reach = await ownServerReach(deps, APP_SERVER, connection);
  return connectPinnedLogin(
    deps,
    {
      connection,
      knownHostsFile: deps.paths.files.knownHosts,
      pin: (hostKey) => recordOwnServer(deps.paths, { ...connection, hostKey }),
      words: OWN_SERVER_WORDS,
      ...(reach !== undefined ? { reach } : {}),
    },
    options,
  );
}

/** A machine of the user's that OpsCrew logs in to with their own SSH key ({@link connectPinnedLogin}). */
export interface PinnedLogin {
  /** The recorded login, with the host key confirmed earlier (none before the first connection). */
  connection: OwnServerConnection;
  /** The known_hosts file the pinned key is written to. */
  knownHostsFile: string;
  /** Records the host key this connection confirmed with the login. */
  pin(hostKey: string): Promise<void>;
  words: LoginWords;
  /**
   * Where to connect instead of the login's address and port: the server's private address once
   * public SSH is closed (`ownServerReach`). The confirmed host key is pinned under it too.
   */
  reach?: SshReach;
}

/**
 * Connects to a machine of the user's (their own server, a runner machine) with their recorded
 * login (address, SSH port, user, key file or SSH agent; never a password) and makes sure it is the
 * right machine (FR-903):
 *
 * - First connection: shows the host key's SHA-256 fingerprint and asks the user to confirm it
 *   (`remote-exec` approval), or takes the fingerprint given with `--host-key` (required when
 *   nobody can answer a prompt). The confirmed key is written to `knownHostsFile` and recorded
 *   with `pin`.
 * - Later connections: the machine must present the pinned key; a different key stops everything
 *   with a plain warning and changes nothing. A new key named with `--host-key` (after the user
 *   reinstalled the machine) replaces the pinned one.
 *
 * Then it logs in once (`true`) as the admin login: a host key ssh refuses stops like a changed
 * key, a refused login names the user and key (and `ssh-add` for a key with a passphrase), and an
 * unreachable machine says so; in each case the earlier known_hosts comes back and nothing is
 * recorded. A key this connection pinned is said. Returns the admin login's shell, which only ever
 * talks to the pinned key.
 */
export async function connectPinnedLogin(
  deps: Omit<OwnServerDeps, "paths">,
  login: PinnedLogin,
  options: ConnectOwnServerOptions = {},
): Promise<OwnServerSession> {
  const homeDir = options.services?.homeDir;
  const { connection, knownHostsFile, words } = login;
  const { noun, fix } = words;
  const given = options.hostKey?.trim();
  if (given !== undefined && !HOST_KEY_FINGERPRINT.test(given)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "--host-key expects the server's SHA-256 host key fingerprint, such as SHA256: followed by 43 letters, digits, + or /.",
      { hint: `${CHECK_ON_SERVER} Pass the SHA256:… part it prints.` },
    );
  }
  await requireOwnServerKey(connection, deps.env, homeDir, words);

  const at = login.reach ?? connection;
  const where = `${at.host} (SSH port ${at.port})`;
  const keys = await scanHostKeys({ host: at.host, port: at.port, runner: deps.runner });
  if (keys.length === 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not reach SSH on ${noun} at ${where}, so it could not read its host key.`,
      {
        hint:
          login.reach !== undefined
            ? `${OVER_TUNNEL} ${TUNNEL_DOWN_HINT}`
            : `Check that ${noun} is on and that this computer can reach it on that port. If the address or port is wrong, fix them with ${fix}, then try again.`,
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
            hint: `If you are sure this is your server, check ${ON_SERVER} Otherwise someone may be intercepting the connection.`,
          },
        );
      }
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The SSH host key of ${noun} at ${where} changed since you confirmed it (confirmed: ${pinned}; now: ${presented}). OpsCrew stopped and changed nothing.`,
        {
          hint: CHANGED_KEY_HINT,
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
        `This is OpsCrew's first connection to ${noun} at ${where}, and its SSH host key must be confirmed before OpsCrew trusts it. The server presents ${describeKey(first)}.`,
        {
          hint: `${CHECK_ON_SERVER} If it matches, run the command again with --host-key ${first.fingerprint}, or run it in a terminal to confirm it there.`,
        },
      );
    }
    // The title is audited: it names no address (the details, shown only in the terminal, do).
    const decision = await deps.approvals.request({
      kind: "remote-exec",
      title: `Trust the SSH host key of ${noun}`,
      details: [
        `This is OpsCrew's first connection to ${noun} at ${where}. It presents this host key:`,
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

  const before = await readFile(knownHostsFile, "utf8").catch(() => undefined);
  // Always (re)write the entry: the known_hosts file may be missing on this computer.
  await writeKnownHost(knownHostsFile, knownHostsName(at.host, at.port), [chosen]);
  const session = { ...connection, hostKey: chosen.fingerprint };
  const target = { ...session, host: at.host, port: at.port };
  const remote =
    options.services?.remote?.(target) ?? adminRemote(deps, target, knownHostsFile, homeDir);
  try {
    await testLogin(deps, remote, target, { where, words, tunnel: login.reach !== undefined });
  } catch (error) {
    // Nothing changes when the login does not work: the earlier known_hosts comes back.
    if (before === undefined) await rm(knownHostsFile, { force: true });
    else await writeFile(knownHostsFile, before, { mode: 0o644 });
    throw error;
  }
  const changed = chosen.fingerprint !== pinned;
  if (changed) {
    await login.pin(chosen.fingerprint);
    deps.reporter.success(`Pinned ${noun}'s SSH host key ${chosen.fingerprint}.`);
  }
  return {
    connection: session,
    remote,
    hostKey: chosen,
    knownHostsFile,
    pinned: changed,
    ...(login.reach !== undefined ? { reach: login.reach } : {}),
  };
}

/**
 * Inspects the user's own server (or `machine`, another machine of theirs) read-only through the
 * host adapter of `services` (default `inspectHost`: fixed commands that change nothing) and audits
 * it without the address: `detail` says for what, `phase` when the command has one.
 */
export async function inspectOwnHost(
  deps: Pick<PhaseDeps, "reporter" | "audit">,
  session: Pick<OwnServerSession, "remote">,
  options: {
    services?: Pick<OwnServerServices, "host"> | undefined;
    phase?: PhaseName;
    detail?: string;
    /** Another machine than the user's own server: its words, and its audit target (no address). */
    machine?: { noun: string; target: string };
  },
): Promise<HostFacts> {
  deps.reporter.step(`Inspecting ${options.machine?.noun ?? "your server"} (read-only)`);
  const host = options.services?.host;
  const facts = host ? await host.inspect(session.remote) : await inspectHost(session.remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "inspect host (read-only)",
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
    target: options.machine?.target ?? "own server",
    decision: "allow",
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  });
  return facts;
}

/**
 * Connects to the extra server `name` the user owns with its `login` (`.opscrew/server.json` →
 * `ownServers`, or the one design just asked for), once public SSH is closed at its private
 * address: the first connection confirms and pins its host key, which is recorded with the login.
 * Then inspects it read-only through the host adapter of `services` (default `inspectHost`),
 * audited under `phase`.
 */
export async function connectExtraServer(
  deps: OwnServerDeps & Pick<PhaseDeps, "audit">,
  name: string,
  login: SshLogin,
  options: {
    services: Pick<OwnServerServices, "remote" | "homeDir" | "host"> | undefined;
    phase: PhaseName;
  },
): Promise<{ session: OwnServerSession; facts: HostFacts }> {
  const reach = await ownServerReach(deps, name, login);
  const session = await connectPinnedLogin(
    deps,
    {
      connection: login,
      knownHostsFile: deps.paths.files.knownHosts,
      pin: async (hostKey) => {
        await updateServerAddresses(deps.paths, (current) => ({
          ...current,
          ownServers: { ...current.ownServers, [name]: { ...login, hostKey } },
        }));
      },
      words: {
        noun: `server ${name}`,
        fix: `\`opscrew design\` (remove ownServers.${name} from .opscrew/server.json first, so it asks again)`,
        missingKey: `Remove ownServers.${name} from .opscrew/server.json and run \`opscrew design\` again, giving the path of your private key (or \`agent\`).`,
      },
      ...(reach !== undefined ? { reach } : {}),
    },
    { services: options.services },
  );
  const facts = await inspectOwnHost(deps, session, {
    services: options.services,
    phase: options.phase,
    machine: { noun: `server ${name}`, target: `own server ${name}` },
  });
  return { session, facts };
}

/**
 * "Connecting to your server": {@link connectOwnServer} (the pinned host key, the login checked),
 * then {@link inspectOwnHost}.
 */
export async function connectAndInspectOwnServer(
  deps: OwnServerDeps & Pick<PhaseDeps, "audit">,
  options: Pick<ConnectOwnServerOptions, "hostKey"> & {
    services?: Pick<OwnServerServices, "remote" | "homeDir" | "host"> | undefined;
    phase?: PhaseName;
    detail?: string;
  },
): Promise<{ session: OwnServerSession; facts: HostFacts }> {
  deps.reporter.step("Connecting to your server");
  const session = await connectOwnServer(deps, options);
  return { session, facts: await inspectOwnHost(deps, session, options) };
}

/** ssh's own words about a failed login: its last lines, redacted, for a hint. */
function sshSaid(deps: Pick<OwnServerDeps, "redactor">, stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("**") && !/^@+$/.test(line));
  const text = deps.redactor.redact(lines.slice(-3).join(" / ")).slice(0, 400);
  return text === "" ? "" : ` (ssh said: ${text})`;
}

const HOST_KEY_FAILED = /host key verification failed|remote host identification has changed/i;
const LOGIN_REFUSED = /permission denied|too many authentication failures/i;
const UNREACHABLE =
  /connection refused|timed out|no route to host|could not resolve|name or service not known|network is unreachable|connection closed|connection reset|kex_exchange_identification/i;

/**
 * Logs in once as the admin login (`true`, 30 seconds) and turns a failure into plain words: a
 * host key ssh refuses (the changed-key stop), a refused login (naming the user and key, and
 * `ssh-add` for a key with a passphrase), or a server that cannot be reached.
 */
async function testLogin(
  deps: Pick<OwnServerDeps, "redactor">,
  remote: RemoteExec,
  connection: OwnServerConnection & { hostKey: string },
  { where, words, tunnel }: { where: string; words: LoginWords; tunnel: boolean },
): Promise<void> {
  const { noun, fix } = words;
  const unreachable = (detail: string) =>
    new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not reach SSH on ${noun} at ${where}. Nothing was changed.`,
      {
        hint: tunnel
          ? `${OVER_TUNNEL} ${TUNNEL_DOWN_HINT}${detail}`
          : `Check that ${noun} is on and that this computer can reach it on that port (a firewall or router may block it). If the address or port is wrong, fix them with ${fix}, then try again.${detail}`,
      },
    );
  let result: CommandResult;
  try {
    result = await remote.run("true", { timeoutMs: 30_000 });
  } catch (error) {
    throw unreachable(sshSaid(deps, errorMessage(error)));
  }
  if (result.exitCode === 0) return;
  const detail = sshSaid(deps, result.stderr);
  if (HOST_KEY_FAILED.test(result.stderr)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The SSH host key of ${noun} at ${where} is not the one you confirmed (${connection.hostKey}), so ssh refused to log in. OpsCrew stopped and changed nothing.`,
      {
        hint: `${CHANGED_KEY_HINT}${detail}`,
      },
    );
  }
  if (LOGIN_REFUSED.test(result.stderr)) {
    const add =
      connection.agent || connection.keyPath === undefined
        ? "Make sure your SSH agent holds the key (`ssh-add -l` lists them; `ssh-add <your key file>` adds one, also a key with a passphrase)."
        : `If the key has a passphrase, add it to your SSH agent first (\`ssh-add ${connection.keyPath}\`): OpsCrew never asks for a passphrase.`;
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `${upperFirst(noun)} at ${where} refused the login as ${connection.user} with ${sshKeyWords(connection)}. Nothing was changed.`,
      {
        hint: `Check that ${connection.user} may log in with this key (its public key must be in that user's ~/.ssh/authorized_keys on ${noun}). ${add} If the user or key is wrong, fix them with ${fix}.${detail}`,
      },
    );
  }
  if (result.timedOut === true || UNREACHABLE.test(result.stderr)) throw unreachable(detail);
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `The test login to ${noun} at ${where} as ${connection.user} failed (exit code ${result.exitCode}). Nothing was changed.`,
    {
      hint: `Try \`ssh -p ${connection.port} ${connection.user}@${connection.host} true\` yourself to see what goes wrong, fix it, then run the command again.${detail}`,
    },
  );
}

/**
 * A function that opens NEW SSH connections (never a reused one: `ControlMaster=no`,
 * `ControlPath=none`) as the deploy user with the project's deploy key and as the user's own
 * admin login, and resolves true only when both log in. Without `deployKeyFile` (a runner machine,
 * where deploy has no SSH key) only the admin login is checked. The host adapter calls it after an
 * SSH or firewall change and lets the server undo the change on its own otherwise.
 */
export function ownServerLoginCheck(
  deps: Pick<OwnServerDeps, "runner" | "env">,
  session: Pick<OwnServerSession, "connection" | "knownHostsFile" | "reach">,
  options: { deployKeyFile?: string; homeDir?: string },
): () => Promise<boolean> {
  const { connection, knownHostsFile } = session;
  const at = session.reach ?? connection;
  const login = async (user: string, keyFile: string | undefined) => {
    const remote = new SshRemoteExec({
      host: at.host,
      port: at.port,
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
    (options.deployKeyFile === undefined || (await login("deploy", options.deployKeyFile))) &&
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

/** `value` when it is a public address of the family (`isPublicAddress`, as inspection judges it). */
function publicAddress(value: string | undefined, family: "ipv4" | "ipv6"): string | undefined {
  if (value === undefined || !(family === "ipv4" ? z.ipv4() : z.ipv6()).safeParse(value).success) {
    return undefined;
  }
  return isPublicAddress(value) ? value : undefined;
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
  const ipv4 =
    connection.publicIpv4 ??
    publicAddress(connection.host, "ipv4") ??
    publicAddress(found("ipv4"), "ipv4");
  if (ipv4 === undefined) return undefined;
  const ipv6 =
    connection.publicIpv6 ??
    publicAddress(connection.host, "ipv6") ??
    publicAddress(found("ipv6"), "ipv6");
  return { ipv4, ...(ipv6 !== undefined ? { ipv6 } : {}) };
}
