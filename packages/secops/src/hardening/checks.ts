import type { CheckResult, CommandResult, RemoteExec, Severity } from "@opscrew/contracts";

/** A check run on the server as the unprivileged `deploy` user (no sudo). */
export interface HostCheck {
  id: string;
  title: string;
  severity: Severity;
  command: string;
  evaluate(result: CommandResult): CheckResult;
}

const SSH_DROPIN = "/etc/ssh/sshd_config.d/10-opscrew.conf";

function check(
  base: Pick<HostCheck, "id" | "title" | "severity">,
  status: CheckResult["status"],
  message: string,
  remediation?: string,
): CheckResult {
  return {
    id: base.id,
    title: base.title,
    severity: base.severity,
    status,
    message,
    ...(remediation ? { remediation } : {}),
  };
}

/** Local listening TCP ports (`ss -H -tln`), excluding loopback addresses. */
export function publicListeningPorts(ssOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of ssOutput.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const local = columns[3];
    if (!local) continue;
    const separator = local.lastIndexOf(":");
    const address = local.slice(0, separator).replace(/^\[|\]$/g, "");
    const port = Number(local.slice(separator + 1));
    if (!Number.isInteger(port)) continue;
    if (address.startsWith("127.") || address === "::1" || address.endsWith("%lo")) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

const sshDropin: HostCheck = {
  id: "ssh-hardening",
  title: "SSH allows keys only, no root login",
  severity: "high",
  command: `cat ${SSH_DROPIN}`,
  evaluate(result) {
    if (result.exitCode !== 0) {
      return check(
        this,
        "fail",
        `The OpsCrew SSH settings file ${SSH_DROPIN} is missing.`,
        "Re-create the server with `opscrew provision` or restore the file from cloud-init.",
      );
    }
    const config = result.stdout.toLowerCase();
    const missing = [
      ["passwordauthentication no", "password login is still allowed"],
      ["permitrootlogin no", "root can still log in"],
      ["kbdinteractiveauthentication no", "keyboard-interactive login is still allowed"],
    ]
      .filter(([needle]) => !config.includes(needle as string))
      .map(([, problem]) => problem);
    return missing.length === 0
      ? check(this, "pass", "SSH accepts keys only and root cannot log in.")
      : check(
          this,
          "fail",
          `SSH hardening is incomplete: ${missing.join("; ")}.`,
          `Set PasswordAuthentication no, PermitRootLogin no and KbdInteractiveAuthentication no in ${SSH_DROPIN}, then restart ssh.`,
        );
  },
};

function serviceCheck(
  id: string,
  title: string,
  severity: Severity,
  verb: "is-active" | "is-enabled",
  unit: string,
  expected: string,
  remediation: string,
): HostCheck {
  return {
    id,
    title,
    severity,
    command: `systemctl ${verb} ${unit}`,
    evaluate(result) {
      const state = result.stdout.trim();
      return state === expected
        ? check(this, "pass", `${unit} is ${expected}.`)
        : check(this, "fail", `${unit} is ${state || "not installed"}.`, remediation);
    },
  };
}

const UFW_REMEDIATION =
  "Enable it with `ufw enable` (as root) after allowing 22, 80 and 443 (the Hetzner firewall still protects the server).";

/**
 * `systemctl is-active ufw` reports `active` even after `ufw disable` (the unit is a oneshot that
 * stays active), so read the persistent switch in `/etc/ufw/ufw.conf` instead. The file is
 * world-readable, so this works as the unprivileged `deploy` user where `ufw status` does not.
 */
const ufwEnabled: HostCheck = {
  id: "ufw",
  title: "Host firewall (ufw) is enabled",
  severity: "medium",
  command: "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf",
  evaluate(result) {
    if (result.exitCode === 0) return check(this, "pass", "ufw is enabled.");
    return result.exitCode === 1
      ? check(
          this,
          "fail",
          "ufw is installed but disabled, so it filters nothing.",
          UFW_REMEDIATION,
        )
      : check(
          this,
          "fail",
          "ufw is not installed (or /etc/ufw/ufw.conf cannot be read).",
          `Install it with \`apt install ufw\` (as root). ${UFW_REMEDIATION}`,
        );
  },
};

const listeningPorts: HostCheck = {
  id: "listening-ports",
  title: "Only SSH and web ports listen on public addresses",
  severity: "high",
  command: "ss -H -tln",
  evaluate(result) {
    if (result.exitCode !== 0)
      return check(this, "warn", "Could not list listening ports (ss failed).");
    const unexpected = publicListeningPorts(result.stdout).filter(
      (p) => ![22, 80, 443].includes(p),
    );
    return unexpected.length === 0
      ? check(this, "pass", "Only ports 22, 80 and 443 listen on public addresses.")
      : check(
          this,
          "fail",
          `Unexpected ports listen on public addresses: ${unexpected.join(", ")}.`,
          "Do not publish container ports other than Caddy's 80/443; reach databases over the internal Docker network.",
        );
  },
};

const dockerTcp: HostCheck = {
  id: "docker-socket-not-exposed",
  title: "Docker API is not exposed over TCP",
  severity: "critical",
  command: "ss -H -tln",
  evaluate(result) {
    if (result.exitCode !== 0)
      return check(this, "warn", "Could not list listening ports (ss failed).");
    const exposed = publicListeningPorts(result.stdout).filter((p) => p === 2375 || p === 2376);
    return exposed.length === 0
      ? check(this, "pass", "The Docker API is only reachable through its local socket.")
      : check(
          this,
          "fail",
          `The Docker API listens on TCP port ${exposed.join(", ")}: anyone who reaches it controls the server.`,
          "Remove the TCP host from the Docker daemon configuration and restart Docker.",
        );
  },
};

const rebootRequired: HostCheck = {
  id: "reboot-required",
  title: "No reboot pending",
  severity: "low",
  command: "test -f /var/run/reboot-required && echo yes || echo no",
  evaluate(result) {
    return result.stdout.trim() === "yes"
      ? check(
          this,
          "warn",
          "Security updates were installed that need a reboot.",
          "Reboot the server from the Hetzner Cloud console during a quiet moment; the app containers start again automatically.",
        )
      : check(this, "pass", "No reboot is pending.");
  },
};

const diskUsage: HostCheck = {
  id: "disk-usage",
  title: "Disk has free space",
  severity: "medium",
  command: "df -P /",
  evaluate(result) {
    const match = result.stdout.match(/(\d+)%\s+\/\s*$/m);
    if (!match) return check(this, "warn", "Could not read disk usage.");
    const used = Number(match[1]);
    if (used >= 95)
      return {
        ...check(
          this,
          "fail",
          `The disk is ${used}% full.`,
          "Free space (old images: `docker image prune`) or resize the server.",
        ),
        severity: "high",
      };
    if (used >= 85)
      return check(
        this,
        "fail",
        `The disk is ${used}% full.`,
        "Free space (old images: `docker image prune`) or resize the server.",
      );
    return check(this, "pass", `The disk is ${used}% full.`);
  },
};

const setupFinished: HostCheck = {
  id: "setup-finished",
  title: "Server setup (cloud-init) finished",
  severity: "high",
  command: "test -f /var/lib/opscrew-ready && echo yes || echo no",
  evaluate(result) {
    return result.stdout.trim() === "yes"
      ? check(this, "pass", "Cloud-init finished the OpsCrew setup.")
      : check(
          this,
          "fail",
          "The server setup did not finish, so hardening may be incomplete.",
          "Check `cloud-init status --long` on the server, then re-run `opscrew provision`.",
        );
  },
};

const pendingSecurityUpdates: HostCheck = {
  id: "security-updates",
  title: "No security updates waiting",
  severity: "low",
  command: "apt list --upgradable 2>/dev/null | grep -ci security || true",
  evaluate(result) {
    const count = Number(result.stdout.trim() || "0");
    return count > 0
      ? check(
          this,
          "warn",
          `${count} security update(s) are waiting; unattended-upgrades installs them nightly.`,
        )
      : check(this, "pass", "No security updates are waiting.");
  },
};

/** All host checks, in report order. */
export const HOST_CHECKS: readonly HostCheck[] = [
  setupFinished,
  sshDropin,
  serviceCheck(
    "fail2ban",
    "Brute-force protection (fail2ban) is running",
    "medium",
    "is-active",
    "fail2ban",
    "active",
    "Start it with `systemctl enable --now fail2ban` (as root).",
  ),
  serviceCheck(
    "unattended-upgrades",
    "Automatic security updates are enabled",
    "medium",
    "is-enabled",
    "unattended-upgrades",
    "enabled",
    "Enable it with `systemctl enable --now unattended-upgrades` (as root).",
  ),
  ufwEnabled,
  listeningPorts,
  dockerTcp,
  diskUsage,
  rebootRequired,
  pendingSecurityUpdates,
];

/**
 * Runs every host check over `remote`. A check whose command fails to run is reported as `warn`
 * with the reason instead of stopping the others.
 */
export async function runHostChecks(
  remote: RemoteExec,
  checks: readonly HostCheck[] = HOST_CHECKS,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const hostCheck of checks) {
    try {
      const result = await remote.run(hostCheck.command, { timeoutMs: 20_000 });
      results.push({ ...hostCheck.evaluate(result), target: remote.host });
    } catch (error) {
      results.push({
        id: hostCheck.id,
        title: hostCheck.title,
        severity: hostCheck.severity,
        status: "warn",
        message: `Could not run the check: ${error instanceof Error ? error.message : String(error)}`,
        target: remote.host,
      });
    }
  }
  return results;
}
