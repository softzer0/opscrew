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
}

export interface CheckServer {
  /** Stable, never an address: two environments on one server have one disk check. */
  id: string;
  /** The secret with the server's address, port, user and host keys; none for `own-runner`. */
  secret?: string;
  /**
   * Where the disk is read: over SSH from GitHub's machines (`github`) or the environment's runner
   * machine (`runner-host`), or on the server's own runner (`own-runner`).
   */
  via: "github" | "runner-host" | "own-runner";
}

/** A server secret's content: how the check key reaches the server. */
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
  /** `df` over SSH with the check key: the server's `df -P -B1 /` output. */
  ssh(server: ServerReach, key: string): Promise<string>;
  /** `df -P -B1 /` on this machine. */
  df(): Promise<string>;
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

/** `df` over SSH with the check key, from key files in `RUNNER_TEMP` removed afterwards. */
export function sshDf(server: ServerReach, key: string): Promise<string>;

/** `df -P -B1 /` on this machine. */
export function localDf(): Promise<string>;
