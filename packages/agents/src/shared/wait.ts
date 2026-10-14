import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRunner, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { TcpConnect } from "@opscrew/secops";

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: Sleep;
  now?: () => number;
}

/** Polls until `host:port` accepts TCP connections. Resolves false on timeout. */
export async function waitForPort(
  host: string,
  port: number,
  options: WaitOptions & { connect: TcpConnect },
): Promise<boolean> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    if (await options.connect(host, port, Math.min(5000, options.intervalMs))) return true;
    if (now() >= deadline) return false;
    await sleep(options.intervalMs);
  }
}

/** Polls the server until cloud-init wrote `/var/lib/opscrew-ready`. Connection errors are retried. */
export async function waitForCloudInit(remote: RemoteExec, options: WaitOptions): Promise<boolean> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    try {
      const result = await remote.run(
        "test -f /var/lib/opscrew-ready && echo ready || echo waiting",
        {
          timeoutMs: 20_000,
        },
      );
      if (result.exitCode === 0 && result.stdout.trim() === "ready") return true;
    } catch {
      // The server may still be booting; try again.
    }
    if (now() >= deadline) return false;
    await sleep(options.intervalMs);
  }
}

/** `host keytype key` lines from `ssh-keyscan`, without comments. */
export function parseKeyscan(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => line.split(/\s+/).length >= 3);
}

function keysFor(knownHosts: string, host: string): string[] {
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
  let existing = "";
  try {
    existing = await readFile(options.knownHostsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const others = parseKeyscan(existing).filter(
    (line) => !(line.split(/\s+/)[0] ?? "").split(",").includes(name),
  );
  const lines = keys.map((k) => `${name} ${k.type} ${k.key}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${[...others, ...lines].join("\n")}\n`, { mode: 0o644 });
  return `${lines.join("\n")}\n`;
}
