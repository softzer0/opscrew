import { Socket } from "node:net";
import type { CheckResult, CommandRunner } from "@opscrew/contracts";

/** Opens a TCP connection; resolves true when it connects, false on refusal or timeout. */
export type TcpConnect = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const defaultTcpConnect: TcpConnect = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = new Socket();
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });

/** Ports that must never be reachable from the internet, with what usually runs there. */
export const SENSITIVE_PORTS: Readonly<Record<number, string>> = {
  2375: "Docker API",
  3000: "Node.js development server",
  3306: "MySQL",
  5432: "PostgreSQL",
  5672: "RabbitMQ",
  6379: "Redis/Valkey",
  8000: "app server",
  8080: "app server",
  9200: "Elasticsearch",
  27017: "MongoDB",
};

export interface ProbeOptions {
  ports?: number[];
  timeoutMs?: number;
  connect?: TcpConnect;
  /** Cloud provider shown in remediation texts, for example `Hetzner Cloud` or `DigitalOcean`. */
  providerName?: string;
}

/** Checks from the outside that sensitive ports on `host` are closed. */
export async function probePorts(host: string, options: ProbeOptions = {}): Promise<CheckResult[]> {
  const ports = options.ports ?? Object.keys(SENSITIVE_PORTS).map(Number);
  const connect = options.connect ?? defaultTcpConnect;
  const timeoutMs = options.timeoutMs ?? 3000;
  const firewall = options.providerName
    ? `the ${options.providerName} firewall`
    : "your cloud provider's firewall";
  const open = await Promise.all(ports.map((port) => connect(host, port, timeoutMs)));
  return ports.map((port, i) => {
    const service = SENSITIVE_PORTS[port] ?? "service";
    return open[i]
      ? {
          id: `port-${port}-closed`,
          title: `Port ${port} (${service}) is closed to the internet`,
          severity: "critical",
          status: "fail",
          message: `Port ${port} (${service}) is reachable from the internet.`,
          remediation: `Close it in ${firewall} and stop publishing it from Docker; use the internal network instead.`,
          target: host,
        }
      : {
          id: `port-${port}-closed`,
          title: `Port ${port} (${service}) is closed to the internet`,
          severity: "critical",
          status: "pass",
          message: `Port ${port} is not reachable from the internet.`,
          target: host,
        };
  });
}

export interface SshPasswordProbeOptions {
  runner: CommandRunner;
  knownHostsFile: string;
  user?: string;
  port?: number;
}

/**
 * Tries an SSH login that offers only passwords. A hardened server answers "Permission denied
 * (publickey)" without ever offering password authentication.
 */
export async function probeSshPasswordAuth(
  host: string,
  options: SshPasswordProbeOptions,
): Promise<CheckResult> {
  const base = {
    id: "ssh-password-login-disabled",
    title: "SSH refuses password logins",
    severity: "high" as const,
    target: host,
  };
  const result = await options.runner.run(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${options.knownHostsFile}`,
      "-p",
      String(options.port ?? 22),
      `${options.user ?? "deploy"}@${host}`,
      "true",
    ],
    { timeoutMs: 20_000 },
  );
  const methods = /Permission denied \(([^)]*)\)/.exec(result.stderr)?.[1];
  if (methods === undefined) {
    return {
      ...base,
      status: "warn",
      message: "Could not tell which SSH login methods the server accepts.",
      remediation: "Check the server's SSH settings manually.",
    };
  }
  const offered = methods.split(",").map((m) => m.trim());
  return offered.includes("password") || offered.includes("keyboard-interactive")
    ? {
        ...base,
        status: "fail",
        message: "The server still offers password login over SSH.",
        remediation:
          "Set PasswordAuthentication no and KbdInteractiveAuthentication no, then restart ssh.",
      }
    : { ...base, status: "pass", message: "The server only accepts SSH keys." };
}
