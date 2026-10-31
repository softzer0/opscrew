import type { CheckResult } from "@opscrew/contracts";
import { webOnlyFromCloudflare } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { planProvider, providerProfile } from "../providers";
import { ipv6HttpsAnswers, providerConsole } from "../shared";

const OPEN_TO_ALL = new Set(["0.0.0.0/0", "::/0"]);

/**
 * Outside probes of the ports a server the user owns should (or should not) answer on. Public
 * mode: SSH on the server's port (deploys need it) and 80/443 (visitors need them; behind
 * Cloudflare's proxy only Cloudflare, so from here they should be closed, and answering is a
 * finding). Tunnel mode:
 * no web port is expected at all (the app is reached only through the Cloudflare Tunnel), and SSH
 * answering from this machine is informational (deploys reach it through the tunnel).
 */
export async function probeOwnServerPorts(
  host: string,
  plan: DeployPlan,
  options: {
    connect: TcpConnect;
    sshPort: number;
    timeoutMs?: number;
    /** Behind the web filter: the server's public IPv6 address, probed on 443 (must not answer). */
    ipv6?: string;
    /** Whether this computer can reach IPv6 addresses (default: it has a global IPv6 address). */
    ipv6Route?: () => Promise<boolean>;
  },
): Promise<CheckResult[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const port = options.sshPort;
  const tunnel = plan.target.provider === "own" && plan.target.access === "tunnel";
  // In public mode behind Cloudflare's proxy, OpsCrew's web filter in Docker's DOCKER-USER chain
  // lets ports 80/443 in only from Cloudflare's IP ranges; in tunnel mode no web port is open.
  const cloudflareOnly = !tunnel && webOnlyFromCloudflare(plan);
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
    if (cloudflareOnly) {
      // Behind Cloudflare's proxy OpsCrew's web filter (DOCKER-USER) lets only Cloudflare's ranges
      // in, as the cloud firewall does on Hetzner and DigitalOcean: a closed port is as intended.
      out.push({
        id: `port-${web}-cloudflare-only`,
        title: `Web port ${web} only accepts Cloudflare`,
        target: host,
        ...(open
          ? {
              severity: "medium" as const,
              status: "fail" as const,
              message: `Port ${web} answers from this machine, so visitors can reach your server around Cloudflare's protection.`,
              remediation:
                "Run `opscrew drift` to see whether OpsCrew's web filter (in Docker's DOCKER-USER chain) is missing or was changed, then `opscrew provision`: it shows the change that lets only Cloudflare's IP ranges reach ports 80 and 443. You can ignore this only if this machine is itself on Cloudflare's network.",
            }
          : {
              severity: "info" as const,
              status: "pass" as const,
              message: `Port ${web} is filtered for visitors that are not Cloudflare, as intended.`,
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
              "Check that Caddy is running (`docker compose ps` in /srv/edge, OpsCrew's shared edge) and that the firewall (ufw, and any firewall of your hosting provider) allows ports 80 and 443.",
          },
    );
  }
  if (cloudflareOnly && options.ipv6 !== undefined) {
    out.push(await probeOwnIpv6(options.ipv6, options, timeoutMs));
  }
  return out;
}

/**
 * Behind OpsCrew's web filter the site is published on IPv4 only: 443 on the server's IPv6
 * address must not answer (docker-proxy would serve it around DOCKER-USER). Skipped with a note
 * when this computer has no IPv6 route.
 */
async function probeOwnIpv6(
  ipv6: string,
  options: { connect: TcpConnect; ipv6Route?: () => Promise<boolean> },
  timeoutMs: number,
): Promise<CheckResult> {
  const base = {
    id: "port-443-ipv6-closed",
    title: "Web port 443 does not answer on IPv6 (the site is published on IPv4 only)",
    target: ipv6,
  };
  const open = await ipv6HttpsAnswers(ipv6, options.connect, timeoutMs, options.ipv6Route);
  if (open === undefined) {
    return {
      ...base,
      severity: "info",
      status: "skip",
      message:
        "Skipped: this computer has no IPv6 route, so it cannot try your server's IPv6 address. Run `opscrew secure` from a network with IPv6 to check it.",
    };
  }
  return open
    ? {
        ...base,
        severity: "medium",
        status: "fail",
        message:
          "Port 443 answers on your server's IPv6 address, so visitors can reach it around Cloudflare and OpsCrew's web filter.",
        remediation:
          "Something on your server publishes port 443 on IPv6 (for example a container or web server of your own). Stop it or make it listen on IPv4 only, then run `opscrew secure` again.",
      }
    : {
        ...base,
        severity: "info",
        status: "pass",
        message: "Port 443 does not answer on your server's IPv6 address, as intended.",
      };
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
  if (plan.network?.publicSsh === false) {
    // Closed on purpose (`opscrew secure --close-public-ssh`): port 22 must not answer from here.
    out.push({
      id: "port-22-open",
      title: "SSH (port 22) is closed to the internet",
      severity: ssh ? "high" : "info",
      status: ssh ? "fail" : "pass",
      message: ssh
        ? "Port 22 answers from this machine, but public SSH should be closed: SSH is meant to answer only on the private network."
        : "Port 22 does not answer from this machine: SSH answers only on the private network.",
      ...(ssh
        ? {
            remediation:
              "Run `opscrew secure --close-public-ssh` again: it closes port 22 in the cloud firewall and the server's firewall.",
          }
        : {}),
      target: host,
    });
  } else if (ssh) {
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

  // Behind Cloudflare's proxy the cloud firewall lets ports 80/443 in only from Cloudflare.
  const cloudflareOnly = webOnlyFromCloudflare(plan);
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
