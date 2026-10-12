import type { CheckResult } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { planProvider, providerProfile } from "../providers";
import { providerConsole } from "../shared";
import { originIsCloudflareOnly } from "../verify/checks";

const OPEN_TO_ALL = new Set(["0.0.0.0/0", "::/0"]);

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
