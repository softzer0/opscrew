import type { CheckResult, CommandResult, RemoteExec, Severity } from "@opscrew/contracts";
import { inPrivateNetworks } from "@opscrew/plan-schema";

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

/**
 * Local listening TCP ports (`ss -H -tln`), excluding loopback addresses and the addresses of
 * OpsCrew's private networks, which only the network's members reach.
 */
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
    // A socket bound to one interface prints its name after the address (10.200.4.2%wg-opscrew0).
    if (inPrivateNetworks(address.replace(/%.*$/, ""))) continue;
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
  "Enable it with `ufw enable` (as root) after allowing 22, 80 and 443 (the cloud provider's firewall still protects the server).";

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
          "Reboot the server during a quiet moment: from your cloud provider's console for a server OpsCrew created, or with `sudo reboot` from your own login on a server you already had. The app's containers start again on their own.",
        )
      : check(this, "pass", "No reboot is pending.");
  },
};

/** A disk this full (percent) is a warning (`secure`'s disk check, `status`'s figures). */
export const DISK_WARN_PERCENT = 85;
/** A disk this full (percent) is high severity. */
export const DISK_HIGH_PERCENT = 95;

const diskUsage: HostCheck = {
  id: "disk-usage",
  title: "Disk has free space",
  severity: "medium",
  command: "df -P /",
  evaluate(result) {
    const match = result.stdout.match(/(\d+)%\s+\/\s*$/m);
    if (!match) return check(this, "warn", "Could not read disk usage.");
    const used = Number(match[1]);
    if (used >= DISK_HIGH_PERCENT)
      return {
        ...check(
          this,
          "fail",
          `The disk is ${used}% full.`,
          "Free space (old images: `docker image prune`) or resize the server.",
        ),
        severity: "high",
      };
    if (used >= DISK_WARN_PERCENT)
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

/** How OpsCrew set up a server the user already owns, as its host checks need to know it. */
export interface OwnServerHardening {
  /** Every port sshd really listens on (from the host plan); never assumed to be 22. */
  sshPorts: readonly number[];
  /** The admin login is root, so root keeps key-only logins (`PermitRootLogin prohibit-password`). */
  rootLogin: boolean;
  /** The user explicitly chose to keep password logins (`--password-logins keep`). */
  passwordsKept: boolean;
}

const OWN_SSH_REMEDIATION =
  "Run `opscrew provision` again: its host plan puts OpsCrew's SSH settings back (nothing changes without your approval).";

/** The value of `key` in an sshd config text (lower case), or undefined when it is not set. */
function sshdValue(config: string, key: string): string | undefined {
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (line === "" || line.startsWith("#")) continue;
    const [name, value] = line.split(/\s+/);
    if (name === key) return value;
  }
  return undefined;
}

/**
 * OpsCrew's SSH settings on a server the user owns: no password logins (unless the user chose to
 * keep them, a warning), and no root login, or key-only root login when the user logs in as root.
 * Keyboard-interactive is not required here: OpsCrew turns it off only where it would allow
 * passwords, and the outside probe checks what SSH really offers.
 */
function ownSshDropin(own: OwnServerHardening): HostCheck {
  return {
    ...sshDropin,
    title: own.rootLogin
      ? "SSH allows keys only, root logs in with a key only"
      : "SSH allows keys only, no root login",
    evaluate(result) {
      if (result.exitCode !== 0) {
        return check(
          this,
          "fail",
          `The OpsCrew SSH settings file ${SSH_DROPIN} is missing.`,
          OWN_SSH_REMEDIATION,
        );
      }
      const root = sshdValue(result.stdout, "permitrootlogin");
      const keyOnlyRoot = root === "prohibit-password" || root === "without-password";
      const problems: string[] = [];
      if (!(root === "no" || (own.rootLogin && keyOnlyRoot))) {
        problems.push(
          own.rootLogin
            ? `PermitRootLogin is ${root ?? "not set"}, but it should be prohibit-password (root logs in with a key only) or no`
            : `PermitRootLogin is ${root ?? "not set"}, but it should be no (you log in as a user with sudo)`,
        );
      }
      const passwords = sshdValue(result.stdout, "passwordauthentication") !== "no";
      if (passwords && !own.passwordsKept) problems.push("password login is still allowed");
      if (problems.length > 0) {
        return check(
          this,
          "fail",
          `SSH hardening is incomplete: ${problems.join("; ")}.`,
          OWN_SSH_REMEDIATION,
        );
      }
      const rootText = keyOnlyRoot
        ? "root keeps key-only logins because you connect as root (the stricter option is a user with sudo and no root login)"
        : "root cannot log in";
      if (passwords) {
        return check(
          this,
          "warn",
          `SSH still accepts password logins because you chose to keep them (some users of this server log in with a password); ${rootText}.`,
          "Give those users SSH keys, then run `opscrew provision --password-logins off` to turn password logins off.",
        );
      }
      return check(this, "pass", `SSH accepts keys only; ${rootText}.`);
    },
  };
}

/** Only sshd's real ports and the web ports may listen on public addresses of a server the user owns. */
function ownListeningPorts(own: OwnServerHardening): HostCheck {
  const ssh = [...new Set(own.sshPorts)].sort((a, b) => a - b);
  const allowed = new Set([...ssh, 80, 443]);
  const sshText = `SSH (port ${ssh.join(", ")})`;
  return {
    ...listeningPorts,
    evaluate(result) {
      if (result.exitCode !== 0)
        return check(this, "warn", "Could not list listening ports (ss failed).");
      const unexpected = publicListeningPorts(result.stdout).filter((p) => !allowed.has(p));
      return unexpected.length === 0
        ? check(this, "pass", `Only ${sshText} and the web ports listen on public addresses.`)
        : check(
            this,
            "fail",
            `Unexpected ports listen on public addresses: ${unexpected.join(", ")} (SSH uses ${ssh.join(", ")}).`,
            "Do not publish container ports other than Caddy's; reach databases over the internal Docker network. If it is a service of yours that must be reachable, make sure the firewall (ufw) lets in only what it should.",
          );
    },
  };
}

/** The host checks for a server the user already owns (see {@link OwnServerHardening}). */
export function ownServerHostChecks(own: OwnServerHardening): readonly HostCheck[] {
  const replaced: Readonly<Record<string, HostCheck>> = {
    "setup-finished": {
      ...setupFinished,
      title: "Server setup by OpsCrew finished",
      evaluate(result) {
        return result.stdout.trim() === "yes"
          ? check(this, "pass", "OpsCrew's host setup finished.")
          : check(
              this,
              "fail",
              "OpsCrew's host setup did not finish, so hardening may be incomplete.",
              "Run `opscrew provision` again: it shows what is still missing and changes nothing without your approval.",
            );
      },
    },
    "ssh-hardening": ownSshDropin(own),
    ufw: {
      ...ufwEnabled,
      evaluate(result) {
        if (result.exitCode === 0) return check(this, "pass", "ufw is enabled.");
        return check(
          this,
          "fail",
          result.exitCode === 1
            ? "ufw is installed but disabled, so it filters nothing."
            : "ufw is not installed (or /etc/ufw/ufw.conf cannot be read).",
          "Run `opscrew provision` again: its host plan turns ufw back on with the SSH rule first (nothing changes without your approval).",
        );
      },
    },
    "listening-ports": ownListeningPorts(own),
  };
  return HOST_CHECKS.map((hostCheck) => replaced[hostCheck.id] ?? hostCheck);
}

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
