import type { CheckResult, CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  HOST_CHECKS,
  type OwnServerHardening,
  ownServerHostChecks,
  probeSshPasswordAuth,
  runHostChecks,
} from "./index";

const ok = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: "" });

const DROP_IN = "cat /etc/ssh/sshd_config.d/10-opscrew.conf";
const SS = "ss -H -tln";

/** OpsCrew's drop-in on a server the user owns (see the host adapter's `sshdDropIn`). */
function dropIn(permitRootLogin: string, passwordsOff: boolean): string {
  return [
    "# Managed by OpsCrew. `opscrew destroy --undo-host` puts the previous setting back.",
    `PermitRootLogin ${permitRootLogin}`,
    ...(passwordsOff ? ["PasswordAuthentication no"] : []),
    "",
  ].join("\n");
}

const PREPARED: Record<string, CommandResult> = {
  "test -f /var/lib/opscrew-ready && echo yes || echo no": ok("yes\n"),
  [DROP_IN]: ok(dropIn("no", true)),
  "systemctl is-active fail2ban": ok("active\n"),
  "systemctl is-enabled unattended-upgrades": ok("enabled\n"),
  "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf": ok(""),
  [SS]: ok(
    [
      "LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*",
      "LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*",
      "LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*",
      "LISTEN 0 128 [::]:2222 [::]:*",
      "LISTEN 0 4096 127.0.0.1:18080 0.0.0.0:*",
      "LISTEN 0 4096 127.0.0.1:9443 0.0.0.0:*",
    ].join("\n"),
  ),
  "df -P /": ok(
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 39028736 9757184 27630700 27% /\n",
  ),
  "test -f /var/run/reboot-required && echo yes || echo no": ok("no\n"),
  "apt list --upgradable 2>/dev/null | grep -ci security || true": ok("0\n"),
};

function remote(overrides: Record<string, CommandResult> = {}): RemoteExec {
  return {
    host: "server",
    async run(command) {
      const answer = overrides[command] ?? PREPARED[command];
      if (!answer) throw new Error(`unexpected command ${command}`);
      return answer;
    },
  };
}

const SUDO_USER: OwnServerHardening = { sshPorts: [2222], rootLogin: false, passwordsKept: false };

function byId(results: readonly CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

describe("ownServerHostChecks", () => {
  it("runs the same checks in the same order as on servers OpsCrew creates", () => {
    expect(ownServerHostChecks(SUDO_USER).map((check) => check.id)).toEqual(
      HOST_CHECKS.map((check) => check.id),
    );
    // The commands stay read-only and the same (they run as the unprivileged deploy user).
    expect(ownServerHostChecks(SUDO_USER).map((check) => check.command)).toEqual(
      HOST_CHECKS.map((check) => check.command),
    );
  });

  it("passes a prepared server with a sudo login, key-only SSH and SSH on its own port", async () => {
    const results = await runHostChecks(remote(), ownServerHostChecks(SUDO_USER));
    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(byId(results, "listening-ports").message).toContain("2222");
    expect(byId(results, "setup-finished").message).not.toContain("loud-init");
  });

  it("accepts PermitRootLogin prohibit-password when the admin login is root, and says why", async () => {
    const overrides = { [DROP_IN]: ok(dropIn("prohibit-password", true)) };
    const root = await runHostChecks(
      remote(overrides),
      ownServerHostChecks({ ...SUDO_USER, rootLogin: true }),
    );
    const ssh = byId(root, "ssh-hardening");
    expect(ssh.status).toBe("pass");
    expect(ssh.message).toContain("root keeps key-only logins");

    // The same file fails for a sudo login: root should not log in at all then.
    const sudo = await runHostChecks(remote(overrides), ownServerHostChecks(SUDO_USER));
    expect(byId(sudo, "ssh-hardening").status).toBe("fail");
    expect(byId(sudo, "ssh-hardening").message).toContain("PermitRootLogin");
    // Root with passwords never passes.
    const yes = await runHostChecks(
      remote({ [DROP_IN]: ok(dropIn("yes", true)) }),
      ownServerHostChecks({ ...SUDO_USER, rootLogin: true }),
    );
    expect(byId(yes, "ssh-hardening").status).toBe("fail");
  });

  it("reports password logins the user chose to keep as a plain warning, not a failure", async () => {
    const overrides = { [DROP_IN]: ok(dropIn("no", false)) };
    const kept = await runHostChecks(
      remote(overrides),
      ownServerHostChecks({ ...SUDO_USER, passwordsKept: true }),
    );
    const ssh = byId(kept, "ssh-hardening");
    expect(ssh).toMatchObject({ status: "warn" });
    expect(ssh.message).toContain("you chose to keep them");
    expect(ssh.remediation).toContain("--password-logins off");

    // Without that choice the same file is a failure.
    const notChosen = await runHostChecks(remote(overrides), ownServerHostChecks(SUDO_USER));
    expect(byId(notChosen, "ssh-hardening").status).toBe("fail");
  });

  it("fails when OpsCrew's SSH settings file is gone", async () => {
    const results = await runHostChecks(
      remote({ [DROP_IN]: ok("", 1) }),
      ownServerHostChecks(SUDO_USER),
    );
    const ssh = byId(results, "ssh-hardening");
    expect(ssh.status).toBe("fail");
    expect(ssh.remediation).toContain("opscrew provision");
  });

  it("accepts every real SSH port in listening-ports, never assumes 22", async () => {
    const twoPorts = ok(
      ["LISTEN 0 128 0.0.0.0:22 0.0.0.0:*", "LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*"].join("\n"),
    );
    const both = await runHostChecks(
      remote({ [SS]: twoPorts }),
      ownServerHostChecks({ ...SUDO_USER, sshPorts: [22, 2222] }),
    );
    expect(byId(both, "listening-ports").status).toBe("pass");

    // Port 22 is not SSH on this server: something else listens there.
    const only2222 = await runHostChecks(
      remote({ [SS]: twoPorts }),
      ownServerHostChecks(SUDO_USER),
    );
    const ports = byId(only2222, "listening-ports");
    expect(ports.status).toBe("fail");
    expect(ports.message).toContain("public addresses: 22 (SSH uses 2222)");
  });

  it("leaves the checks of servers OpsCrew creates unchanged", async () => {
    const results = await runHostChecks(
      remote({ [DROP_IN]: ok(dropIn("prohibit-password", true)) }),
      HOST_CHECKS,
    );
    // Hetzner/DigitalOcean keep requiring no root login and port 22.
    expect(byId(results, "ssh-hardening").status).toBe("fail");
    expect(byId(results, "listening-ports").status).toBe("fail");
  });
});

describe("probeSshPasswordAuth on a server whose password logins were kept on purpose", () => {
  const runner = (stderr: string): CommandRunner & { args: string[][] } => {
    const args: string[][] = [];
    return {
      args,
      run: async (_command, list) => {
        args.push([...list]);
        return { exitCode: 255, stdout: "", stderr };
      },
    };
  };

  it("warns instead of failing, on the server's SSH port", async () => {
    const ssh = runner("deploy@h: Permission denied (publickey,password).");
    const result = await probeSshPasswordAuth("h", {
      runner: ssh,
      knownHostsFile: "kh",
      port: 2222,
      passwordsKept: true,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("chose to keep");
    expect(ssh.args[0]).toEqual(expect.arrayContaining(["-p", "2222"]));
  });

  it("still passes when only keys are offered", async () => {
    const result = await probeSshPasswordAuth("h", {
      runner: runner("deploy@h: Permission denied (publickey)."),
      knownHostsFile: "kh",
      passwordsKept: true,
    });
    expect(result.status).toBe("pass");
  });
});
