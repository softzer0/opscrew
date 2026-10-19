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
  /**
   * The ports of the app's own services with their names (`{ 4222: "NATS" }`), probed besides
   * `ports` (FR-1328).
   */
  services?: Readonly<Record<number, string>>;
  timeoutMs?: number;
  connect?: TcpConnect;
  /** Cloud provider shown in remediation texts, for example `Hetzner Cloud` or `DigitalOcean`. */
  providerName?: string;
}

/** Checks from the outside that sensitive ports on `host`, and the app's services' ports, are closed. */
export async function probePorts(host: string, options: ProbeOptions = {}): Promise<CheckResult[]> {
  const services = options.services ?? {};
  const ports = [
    ...new Set([
      ...(options.ports ?? Object.keys(SENSITIVE_PORTS).map(Number)),
      ...Object.keys(services).map(Number),
    ]),
  ];
  const connect = options.connect ?? defaultTcpConnect;
  const timeoutMs = options.timeoutMs ?? 3000;
  const firewall = options.providerName
    ? `the ${options.providerName} firewall`
    : "your cloud provider's firewall";
  const open = await Promise.all(ports.map((port) => connect(host, port, timeoutMs)));
  return ports.map((port, i) => {
    const service = services[port] ?? SENSITIVE_PORTS[port] ?? "service";
    const base = {
      id: `port-${port}-closed`,
      title: `Port ${port} (${service}) is closed to the internet`,
      severity: "critical" as const,
    };
    return open[i]
      ? {
          ...base,
          status: "fail",
          message: `Port ${port} (${service}) is reachable from the internet.`,
          remediation: `Close it in ${firewall} and stop publishing it from Docker; use the internal network instead.`,
          target: host,
        }
      : {
          ...base,
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
  /**
   * A server the user owns whose password logins were kept by the user's explicit choice: offered
   * passwords are then reported as a warning, not a failure.
   */
  passwordsKept?: boolean;
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
  const passwords = offered.includes("password") || offered.includes("keyboard-interactive");
  if (passwords && options.passwordsKept === true) {
    return {
      ...base,
      status: "warn",
      message:
        "The server still offers password login over SSH, because you chose to keep password logins.",
      remediation:
        "Give every user of the server an SSH key, then run `opscrew provision --password-logins off`.",
    };
  }
  return passwords
    ? {
        ...base,
        status: "fail",
        message: "The server still offers password login over SSH.",
        remediation:
          "Set PasswordAuthentication no and KbdInteractiveAuthentication no, then restart ssh.",
      }
    : { ...base, status: "pass", message: "The server only accepts SSH keys." };
}
