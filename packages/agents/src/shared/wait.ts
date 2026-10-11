import { readFile, writeFile } from "node:fs/promises";
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
          hint: "If you did not rebuild the server, someone may be intercepting the connection. Check in the Hetzner Console before continuing.",
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
