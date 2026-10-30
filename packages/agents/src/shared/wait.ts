import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRunner, RemoteExec } from "@opscrew/contracts";
import { durationText, OpsCrewError, readTextIfExists, realSleep } from "@opscrew/core";
import { defaultTcpConnect, type TcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import type { ProviderProfile } from "../providers";
import type { ProvisionServices } from "../provision/types";
import { providerConsole } from "./provider-text";
import { SshRemoteExec } from "./remote";

type Sleep = (ms: number) => Promise<void>;

/** How long to poll and how often; tests inject `sleep` and `now` (monotonic milliseconds). */
export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: Sleep;
  now?: () => number;
}

/**
 * Calls `check` until it returns something other than `undefined` and returns that, or returns
 * `undefined` once `timeoutMs` passed. `check` runs at once and every `intervalMs` (never sleeping
 * past the deadline), and once more when the time is up.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  options: WaitOptions,
): Promise<T | undefined> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (now() >= deadline) return undefined;
    await sleep(Math.max(1, Math.min(options.intervalMs, deadline - now())));
  }
}

/** Polls until `host:port` accepts TCP connections. Resolves false on timeout. */
export async function waitForPort(
  host: string,
  port: number,
  options: WaitOptions & { connect: TcpConnect },
): Promise<boolean> {
  const open = await pollUntil(
    async () =>
      (await options.connect(host, port, Math.min(5000, options.intervalMs))) ? true : undefined,
    options,
  );
  return open === true;
}

/** Polls the server until cloud-init wrote `/var/lib/opscrew-ready`. Connection errors are retried. */
export async function waitForCloudInit(remote: RemoteExec, options: WaitOptions): Promise<boolean> {
  const ready = await pollUntil(async () => {
    try {
      const result = await remote.run(
        "test -f /var/lib/opscrew-ready && echo ready || echo waiting",
        { timeoutMs: 20_000 },
      );
      return result.exitCode === 0 && result.stdout.trim() === "ready" ? true : undefined;
    } catch {
      return undefined; // The server may still be booting; try again.
    }
  }, options);
  return ready === true;
}

/** `host keytype key` lines from `ssh-keyscan`, without comments. */
export function parseKeyscan(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => line.split(/\s+/).length >= 3);
}

/** The `type key` of each key known_hosts text pins for `host` (a {@link knownHostsName}). */
export function keysFor(knownHosts: string, host: string): string[] {
  return parseKeyscan(knownHosts)
    .filter((line) => (line.split(/\s+/)[0] ?? "").split(",").includes(host))
    .map((line) => line.split(/\s+/).slice(1, 3).join(" "));
}

export interface PinHostKeyOptions {
  host: string;
  knownHostsFile: string;
  runner: CommandRunner;
  /** Provider console named in hints (see `providerConsole`); default "your cloud provider's console". */
  console?: string;
  /** Asked when the pinned key differs; refusal (or no handler) throws. */
  confirmChangedKey?: (details: {
    host: string;
    previous: string[];
    current: string[];
  }) => Promise<boolean>;
}

export interface PinnedHostKey {
  /** The known_hosts line(s) for this host, ready for the deploy secret. */
  knownHostsLines: string;
  changed: boolean;
  created: boolean;
}

/**
 * Records the server's Ed25519 host key in OpsCrew's own known_hosts file (trust on first use,
 * right after OpsCrew created the server). A key that differs from the pinned one is only replaced
 * after explicit confirmation.
 */
export async function pinHostKey(options: PinHostKeyOptions): Promise<PinnedHostKey> {
  const scan = await options.runner.run(
    "ssh-keyscan",
    ["-T", "10", "-t", "ed25519", options.host],
    {
      timeoutMs: 30_000,
    },
  );
  const lines = parseKeyscan(scan.stdout);
  if (lines.length === 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not read the SSH host key of ${options.host}.`,
      {
        hint: "The server may still be starting; run `opscrew provision` again in a minute.",
      },
    );
  }
  const existing = (await readTextIfExists(options.knownHostsFile)) ?? "";
  const previous = keysFor(existing, options.host);
  const current = lines.map((line) => line.split(/\s+/).slice(1, 3).join(" "));
  const same = previous.length > 0 && current.every((key) => previous.includes(key));
  if (same) {
    return { knownHostsLines: `${lines.join("\n")}\n`, changed: false, created: false };
  }
  if (previous.length > 0) {
    const approved =
      (await options.confirmChangedKey?.({ host: options.host, previous, current })) ?? false;
    if (!approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The SSH host key of ${options.host} changed since OpsCrew pinned it.`,
        {
          hint: `If you did not rebuild the server, someone may be intercepting the connection. Check in ${options.console ? `the ${options.console}` : "your cloud provider's console"} before continuing.`,
        },
      );
    }
  }
  const others = parseKeyscan(existing).filter(
    (line) => !(line.split(/\s+/)[0] ?? "").split(",").includes(options.host),
  );
  await writeFile(options.knownHostsFile, `${[...others, ...lines].join("\n")}\n`, { mode: 0o644 });
  return {
    knownHostsLines: `${lines.join("\n")}\n`,
    changed: previous.length > 0,
    created: previous.length === 0,
  };
}

/**
 * Asks (`remote-exec` approval) whether to trust the new SSH host key of a server OpsCrew pinned
 * earlier, showing both keys: only right after the user rebuilt or replaced the server.
 */
export function confirmChangedHostKey(
  deps: Pick<PhaseDeps, "approvals">,
): NonNullable<PinHostKeyOptions["confirmChangedKey"]> {
  return async ({ host, previous, current }) => {
    const decision = await deps.approvals.request({
      kind: "remote-exec",
      title: `Trust the new SSH host key of ${host}`,
      details: [
        "The server's SSH host key is different from the one OpsCrew pinned earlier.",
        "Only accept this if you rebuilt or replaced the server yourself.",
        "Pinned:",
        ...previous.map((line) => `  ${line}`),
        "Now:",
        ...current.map((line) => `  ${line}`),
      ].join("\n"),
    });
    return decision.approved;
  };
}

/** How long a server OpsCrew created may take to accept SSH, and how often it is tried. */
const SSH_WAIT_MS = 5 * 60_000;
const SSH_INTERVAL_MS = 5_000;
/** How long its first-boot setup (cloud-init) may take, and how often it is checked. */
const CLOUD_INIT_WAIT_MS = 8 * 60_000;
const CLOUD_INIT_INTERVAL_MS = 10_000;

/** `run \`<command>\` again; it continues where it stopped.`: the end of a hint after a stop. */
export function continuesHint(command: string): string {
  return `run \`${command}\` again; it continues where it stopped.`;
}

/** The next step after an apply failed that deleted nothing, telling the user to run `command`. */
export function nothingDeletedHint(command: string): string {
  return `Fix the cause shown above, then run \`${command}\` again. Nothing was deleted.`;
}

/** Quotes a path for a copy-pasteable shell command. */
function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/**
 * Makes a server OpsCrew just created ready to use: waits until `host` accepts SSH, pins its SSH
 * host key (a changed key only after {@link confirmChangedHostKey}) and waits until its first-boot
 * setup (cloud-init) is done, through the deploy user's shell (`services.remote`, else SSH with
 * `keyFile`). `server` names it in the messages (`server`, `new Droplet`); a stop says what to
 * check and then `again` ({@link continuesHint}). Returns the pinned key.
 */
export async function readyNewServer(
  deps: Pick<PhaseDeps, "reporter" | "approvals" | "paths" | "runner">,
  input: {
    host: string;
    server: string;
    profile: Pick<ProviderProfile, "serverNoun" | "displayName" | "consoleUrl">;
    keyFile: string;
    again: string;
    services: Pick<ProvisionServices, "tcpConnect" | "remote" | "sleep" | "now">;
  },
): Promise<PinnedHostKey> {
  const { host, server, profile, services } = input;
  const knownHostsFile = deps.paths.files.knownHosts;
  const waits = {
    ...(services.sleep ? { sleep: services.sleep } : {}),
    ...(services.now ? { now: services.now } : {}),
  };
  deps.reporter.step(`Waiting for the ${server} at ${host} to accept SSH`);
  const open = await waitForPort(host, 22, {
    timeoutMs: SSH_WAIT_MS,
    intervalMs: SSH_INTERVAL_MS,
    connect: services.tcpConnect ?? defaultTcpConnect,
    ...waits,
  });
  if (!open) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `The ${server} at ${host} did not open SSH within ${durationText(SSH_WAIT_MS)}.`,
      {
        hint: `Check the ${profile.serverNoun} in the ${providerConsole(profile)}, then ${input.again}`,
      },
    );
  }
  const pinned = await pinHostKey({
    host,
    console: providerConsole(profile),
    knownHostsFile,
    runner: deps.runner,
    confirmChangedKey: confirmChangedHostKey(deps),
  });
  const remote =
    services.remote?.(host) ??
    new SshRemoteExec({ host, keyFile: input.keyFile, knownHostsFile, runner: deps.runner });
  deps.reporter.step(
    `Waiting for the ${server} to finish its first-boot setup (up to ${durationText(CLOUD_INIT_WAIT_MS)})`,
  );
  const ready = await waitForCloudInit(remote, {
    timeoutMs: CLOUD_INIT_WAIT_MS,
    intervalMs: CLOUD_INIT_INTERVAL_MS,
    ...waits,
  });
  if (!ready) {
    const check = `ssh -i ${quotePath(input.keyFile)} -o UserKnownHostsFile=${quotePath(knownHostsFile)} deploy@${host} cloud-init status --long`;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `The ${server} at ${host} did not finish its first-boot setup within ${durationText(CLOUD_INIT_WAIT_MS)}.`,
      { hint: `Check what it is doing with \`${check}\`, then ${input.again}` },
    );
  }
  deps.reporter.success(`The ${server} at ${host} is ready.`);
  return pinned;
}

/** A host key the server presented: its type (`ssh-ed25519`), base64 key and fingerprint. */
export interface ScannedHostKey {
  type: string;
  key: string;
  /** `SHA256:` and the unpadded base64 SHA-256 of the key, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

/** A pinned host key fingerprint: `SHA256:` and 43 base64 characters. */
export const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * The SHA-256 fingerprint of an SSH public key (the base64 field of a key line), written as
 * OpenSSH prints it: `SHA256:` and the unpadded base64 digest.
 */
export function hostKeyFingerprint(keyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** How known_hosts names a server: `host` on port 22, `[host]:port` on any other port. */
export function knownHostsName(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Ed25519 first, then ECDSA, then RSA: the order a user is shown and asked to confirm. */
function keyRank(type: string): number {
  if (type === "ssh-ed25519") return 0;
  if (type.startsWith("ecdsa-")) return 1;
  if (type === "ssh-rsa") return 2;
  return 3;
}

/**
 * The host keys the server at `host:port` presents (`ssh-keyscan`), Ed25519 first, each with its
 * SHA-256 fingerprint. Empty when the server did not answer. `ssh-keyscan` alone cannot tell a
 * real server from a man in the middle: a caller pins a key only after the user confirmed its
 * fingerprint (or named it with `--host-key`).
 */
export async function scanHostKeys(options: {
  host: string;
  port?: number;
  runner: CommandRunner;
}): Promise<ScannedHostKey[]> {
  const scan = await options.runner.run(
    "ssh-keyscan",
    ["-T", "10", "-p", String(options.port ?? 22), "-t", "ed25519,ecdsa,rsa", options.host],
    { timeoutMs: 30_000 },
  );
  const seen = new Set<string>();
  const keys: ScannedHostKey[] = [];
  for (const line of parseKeyscan(scan.stdout)) {
    const [, type, key] = line.split(/\s+/);
    if (type === undefined || key === undefined || !/^[A-Za-z0-9+/]+={0,3}$/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ type, key, fingerprint: hostKeyFingerprint(key) });
  }
  return keys.sort((a, b) => keyRank(a.type) - keyRank(b.type));
}

/**
 * Replaces the entries of `name` (see {@link knownHostsName}) in a known_hosts file with `keys`,
 * keeping every other host's entries, and returns the new lines for `name`.
 */
export async function writeKnownHost(
  file: string,
  name: string,
  keys: readonly Pick<ScannedHostKey, "type" | "key">[],
): Promise<string> {
  const existing = (await readTextIfExists(file)) ?? "";
  const others = parseKeyscan(existing).filter(
    (line) => !(line.split(/\s+/)[0] ?? "").split(",").includes(name),
  );
  const lines = keys.map((k) => `${name} ${k.type} ${k.key}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${[...others, ...lines].join("\n")}\n`, { mode: 0o644 });
  return `${lines.join("\n")}\n`;
}
