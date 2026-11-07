/** `opscrew/check/check.json`: what the scheduled check checks. Never an address, key or URL. */
export interface CheckConfig {
  version: 1;
  /** Minutes between scheduled runs. */
  intervalMinutes: number;
  thresholds: CheckThresholds;
  /** Where alerts are also posted; the address is the secret `OPSCREW_CHECK_WEBHOOK`. */
  webhook?: "slack" | "discord" | "ntfy";
  /** The repository's visibility when the file was rendered. */
  public: boolean;
  environments: CheckEnvironment[];
}

export interface CheckThresholds {
  /** A disk this full (percent) is a warning. */
  diskWarn: number;
  /** A disk this full (percent) is high. */
  diskHigh: number;
  /** A certificate with fewer days left fails. */
  certDays: number;
  /** Tries of the health path before it fails. */
  tries: number;
  retrySeconds: number;
  timeoutSeconds: number;
}

/** One app's environment. */
export interface CheckEnvironment {
  /** `<app key or name>/<env>`, as `OPSCREW_CHECK_PAUSED` names it. */
  key: string;
  hosts: { hostname: string; healthPath: string }[];
  /** The server whose disk is checked; absent for Portainer, Cloudflare and GitHub Pages. */
  server?: CheckServer;
  /** The app's extra servers (`plan.servers`), each with its `name`; absent without them. */
  extraServers?: CheckServer[];
  /**
   * With scheduled snapshots on: the app's folder in `/srv/apps` and the ids of the servers with
   * its data (each listed by this or an earlier environment), whose last scheduled snapshot is
   * checked. Absent when they are off, or no server with its data is read.
   */
  snapshots?: { app: string; servers: string[] };
}

export interface CheckServer {
  /** Stable, never an address: two environments on one server have one disk check. */
  id: string;
  /**
   * The server's name in the plan, which its entry in the secret has as `id`: an extra server's;
   * absent for the app's server (`app`).
   */
  name?: string;
  /**
   * The secret whose list ({@link ServerEntry}) has the server's address, port, user and host
   * keys; none for `own-runner`.
   */
  secret?: string;
  /**
   * Where the disk is read: over SSH from GitHub's machines (`github`) or the environment's
   * self-hosted runner (`runner-host`: its runner machine or, for an extra server, the app server's
   * runner), or on the server's own runner (`own-runner`).
   */
  via: "github" | "runner-host" | "own-runner";
}

/**
 * An entry of a server secret's list (one per server of the environment): the server's name in
 * the plan (`app` or an extra server's) and how the check key reaches it.
 */
export interface ServerEntry extends ServerReach {
  id: string;
}

/** How the check key reaches a server. */
export interface ServerReach {
  host: string;
  port: number;
  user: string;
  /** The server's known-hosts line(s). */
  knownHosts: string;
}

/** Everything the check reads and does outside itself. */
export interface CheckIo {
  config: CheckConfig;
  /** The command line's arguments: `--only disk:<server id>` or none. */
  argv: readonly string[];
  fetch: typeof fetch;
  /** The days the hostname's certificate has left, negative once expired. */
  tlsDaysLeft(hostname: string, timeoutMs: number): Promise<number>;
  /** The server's answer over SSH with the check key: its {@link CHECK_COMMAND} output. */
  ssh(server: ServerReach, key: string): Promise<string>;
  /** {@link CHECK_COMMAND}'s output on this machine. */
  local(): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
  /** Appends Markdown to the job summary; absent outside GitHub Actions. */
  summary?: ((markdown: string) => Promise<void>) | undefined;
}

/** Runs the check once; resolves the exit code (0 when it could report everything, else 1). */
export function run(env: Record<string, string | undefined>, io: CheckIo): Promise<number>;

/** The days the certificate on `hostname`:443 has left, negative once expired. */
export function tlsDaysLeft(hostname: string, timeoutMs: number): Promise<number>;

/** The server's answer over SSH with the check key, from key files in `RUNNER_TEMP` removed afterwards. */
export function sshRead(server: ServerReach, key: string): Promise<string>;

/** {@link CHECK_COMMAND} on this machine. */
export function localRead(): Promise<string>;

/**
 * The check key's forced command on each server (a copy of `CHECK_KEY_COMMAND` in
 * `@opscrew/connector-ssh-host`): `df -P -B1 /`, then each scheduled snapshot's
 * `scheduled <app> at|id|after|running` lines, never the log's text. Read-only.
 */
export const CHECK_COMMAND: string;

/**
 * How {@link CHECK_COMMAND} reads a scheduled snapshot's log from its `lines`: its last
 * scheduled snapshot id line (`id`, absent without one) and the non-empty lines after it.
 */
export function scheduledLog(lines: readonly string[]): { id?: string; after: string[] };

/**
 * The rule for a scheduled snapshot's log: its last run failed unless it printed the snapshot's
 * id and no non-empty line follows it (`after`, their number). With an `id`, only its copy off
 * the server failed.
 */
export function scheduledFailed(log: { id?: string; after: number }): boolean;
