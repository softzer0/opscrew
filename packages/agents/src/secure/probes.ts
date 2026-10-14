import type { CheckResult } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { planProvider, providerProfile } from "../providers";
import { providerConsole } from "../shared";
import { originIsCloudflareOnly } from "../verify/checks";

const OPEN_TO_ALL = new Set(["0.0.0.0/0", "::/0"]);

/**
 * Outside probes of the ports a server the user owns should (or should not) answer on. Public
 * mode: SSH on the server's port (deploys need it) and 80/443 (visitors need them). Tunnel mode:
 * no web port is expected at all (the app is reached only through the Cloudflare Tunnel), and SSH
 * answering from this machine is informational (deploys reach it through the tunnel).
 */
export async function probeOwnServerPorts(
  host: string,
  plan: DeployPlan,
  options: { connect: TcpConnect; sshPort: number; timeoutMs?: number },
): Promise<CheckResult[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const port = options.sshPort;
  const tunnel = plan.target.provider === "own" && plan.target.access === "tunnel";
  const [ssh, http, https] = await Promise.all(
    [port, 80, 443].map((p) => options.connect(host, p, timeoutMs)),
  );
  const sshBase = {
    id: "ssh-port-open",
    title: `SSH (port ${port}) is reachable`,
    target: host,
  };
  const out: CheckResult[] = [];
  if (ssh) {
    out.push({
      ...sshBase,
      severity: "info",
      status: "pass",
      message: tunnel
        ? `Port ${port} answers from this machine; deploys from GitHub Actions reach SSH through the Cloudflare Tunnel.`
        : `Port ${port} answers; deploys from GitHub Actions can connect.`,
    });
  } else if (tunnel) {
    out.push({
      ...sshBase,
      severity: "info",
      status: "warn",
      message: `Port ${port} does not answer from this machine. Deploys reach SSH through the Cloudflare Tunnel, so this is fine when this machine is not on the server's network.`,
    });
  } else {
    out.push({
      ...sshBase,
      severity: "high",
      status: "fail",
      message: `Port ${port} does not answer, so deploys cannot reach the server.`,
      remediation: `Check that your server is on, that sshd listens on port ${port} and that its firewall (ufw, and any firewall of your hosting provider or router) lets SSH in.`,
    });
  }
  for (const [web, open] of [
    [80, http],
    [443, https],
  ] as const) {
    if (tunnel) {
      out.push({
        id: `port-${web}-closed-tunnel`,
        title: `Web port ${web} is closed (the app is served through the tunnel)`,
        severity: "medium",
        target: host,
        ...(open
          ? {
              status: "fail" as const,
              message: `Port ${web} answers, although the app is served only through the Cloudflare Tunnel and needs no open web port.`,
              remediation: `If another program of yours serves port ${web} on purpose, you can ignore this; otherwise stop it or block the port in the firewall (ufw).`,
            }
          : {
              status: "pass" as const,
              message: `Port ${web} does not answer: the app is reached only through the Cloudflare Tunnel.`,
            }),
      });
      continue;
    }
    const base = {
      id: `port-${web}-open`,
      title: `Web port ${web} is reachable`,
      severity: "medium" as const,
      target: host,
    };
    out.push(
      open
        ? { ...base, status: "pass", message: `Port ${web} answers.` }
        : {
            ...base,
            status: "fail",
            message: `Port ${web} does not answer, so visitors cannot reach the app.`,
            remediation:
              "Check that Caddy is running (`docker compose ps` in /srv/app) and that the firewall (ufw, and any firewall of your hosting provider) allows ports 80 and 443.",
          },
    );
  }
  return out;
}

/**
 * Outside probes of the ports that should be open: 22 (SSH, needed by deploys) and 80/443. When
 * only Cloudflare may reach the origin, 80/443 are expected to be filtered from this machine;
 * either outcome is reported as info.
 */
export async function probeExpectedPorts(
  host: string,
  plan: DeployPlan,
  options: { connect: TcpConnect; timeoutMs?: number },
): Promise<CheckResult[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const [ssh, http, https] = await Promise.all(
    [22, 80, 443].map((port) => options.connect(host, port, timeoutMs)),
  );
  const out: CheckResult[] = [];
  const profile = providerProfile(planProvider(plan));

  const sshOpenToAll = plan.security.sshAllowedCidrs.some((cidr) => OPEN_TO_ALL.has(cidr));
  if (ssh) {
    out.push({
      id: "port-22-open",
      title: "SSH (port 22) is reachable",
      severity: "info",
      status: "pass",
      message: "Port 22 answers; deploys from GitHub Actions can connect.",
      target: host,
    });
  } else {
    out.push({
      id: "port-22-open",
      title: "SSH (port 22) is reachable",
      severity: sshOpenToAll ? "high" : "info",
      status: sshOpenToAll ? "fail" : "warn",
      message: sshOpenToAll
        ? "Port 22 does not answer, so deploys cannot reach the server."
        : `Port 22 does not answer from this machine; SSH is limited to ${plan.security.sshAllowedCidrs.join(", ")}.`,
      ...(sshOpenToAll
        ? {
            remediation: `Check that the ${profile.serverNoun} is running in the ${providerConsole(profile)} and that the ${profile.displayName} firewall allows port 22.`,
          }
        : {}),
      target: host,
    });
  }

  const cloudflareOnly = originIsCloudflareOnly(plan);
  for (const [port, open] of [
    [80, http],
    [443, https],
  ] as const) {
    const base = {
      id: `port-${port}-${cloudflareOnly ? "cloudflare-only" : "open"}`,
      title: cloudflareOnly
        ? `Web port ${port} only accepts Cloudflare`
        : `Web port ${port} is reachable`,
      target: host,
    };
    if (cloudflareOnly) {
      out.push({
        ...base,
        severity: "info",
        status: open ? "warn" : "pass",
        message: open
          ? `Port ${port} answers from this machine although only Cloudflare should reach it (fine if this machine is on Cloudflare's network).`
          : `Port ${port} is filtered for visitors that are not Cloudflare, as intended.`,
      });
    } else if (open) {
      out.push({ ...base, severity: "medium", status: "pass", message: `Port ${port} answers.` });
    } else {
      out.push({
        ...base,
        severity: "medium",
        status: "fail",
        message: `Port ${port} does not answer, so visitors cannot reach the app.`,
        remediation: `Check that Caddy is running (\`docker compose ps\`) and that the ${profile.displayName} firewall allows the port.`,
      });
    }
  }
  return out;
}
