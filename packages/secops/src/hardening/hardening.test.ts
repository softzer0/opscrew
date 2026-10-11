import type { CommandResult, CommandRunner, RemoteExec } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import {
  HOST_CHECKS,
  probePorts,
  probeSshPasswordAuth,
  publicListeningPorts,
  runHostChecks,
} from "./index";

const ok = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: "" });

const HEALTHY: Record<string, CommandResult> = {
  "test -f /var/lib/opscrew-ready && echo yes || echo no": ok("yes\n"),
  "cat /etc/ssh/sshd_config.d/10-opscrew.conf": ok(
    "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nMaxAuthTries 3\nX11Forwarding no\nAllowUsers deploy\n",
  ),
  "systemctl is-active fail2ban": ok("active\n"),
  "systemctl is-enabled unattended-upgrades": ok("enabled\n"),
  "systemctl is-active ufw": ok("active\n"),
  "ss -H -tln": ok(
    [
      "LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*",
      "LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*",
      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
      "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
      "LISTEN 0 4096 [::]:443 [::]:*",
      "LISTEN 0 128 [::]:22 [::]:*",
      "LISTEN 0 4096 [::1]:5432 [::]:*",
    ].join("\n"),
  ),
  "df -P /": ok(
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 39028736 9757184 27630700 27% /\n",
  ),
  "test -f /var/run/reboot-required && echo yes || echo no": ok("no\n"),
  "apt list --upgradable 2>/dev/null | grep -ci security || true": ok("0\n"),
};

function remote(
  overrides: Record<string, CommandResult | Error> = {},
): RemoteExec & { commands: string[] } {
  const commands: string[] = [];
  return {
    host: "203.0.113.10",
    commands,
    async run(command) {
      commands.push(command);
      const answer = overrides[command] ?? HEALTHY[command];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error(`unexpected command ${command}`);
      return answer;
    },
  };
}

describe("publicListeningPorts", () => {
  it("ignores loopback addresses", () => {
    expect(publicListeningPorts(HEALTHY["ss -H -tln"]?.stdout ?? "")).toEqual([22, 80, 443]);
  });
});

describe("runHostChecks", () => {
  it("passes a healthy Ubuntu 24.04 server", async () => {
    const results = await runHostChecks(remote());
    expect(results).toHaveLength(HOST_CHECKS.length);
    expect(results.filter((r) => r.status !== "pass")).toEqual([]);
    expect(results.every((r) => r.target === "203.0.113.10")).toBe(true);
  });

  it("reports password login and root login (spec US4 scenario 1)", async () => {
    const results = await runHostChecks(
      remote({
        "cat /etc/ssh/sshd_config.d/10-opscrew.conf": ok(
          "PasswordAuthentication yes\nPermitRootLogin yes\n",
        ),
      }),
    );
    const ssh = results.find((r) => r.id === "ssh-hardening");
    expect(ssh).toMatchObject({ status: "fail", severity: "high" });
    expect(ssh?.message).toContain("password login is still allowed");
    expect(ssh?.remediation).toContain("PasswordAuthentication no");
  });

  it("fails unexpected public ports and an exposed Docker API", async () => {
    const results = await runHostChecks(
      remote({
        "ss -H -tln": ok(
          "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:2375 0.0.0.0:*",
        ),
      }),
    );
    expect(results.find((r) => r.id === "listening-ports")?.message).toContain("2375, 5432");
    expect(results.find((r) => r.id === "docker-socket-not-exposed")).toMatchObject({
      status: "fail",
      severity: "critical",
    });
  });

  it("grades disk usage and pending reboots", async () => {
    const full = await runHostChecks(
      remote({ "df -P /": ok("Filesystem x\n/dev/sda1 1 1 1 96% /\n") }),
    );
    expect(full.find((r) => r.id === "disk-usage")).toMatchObject({
      status: "fail",
      severity: "high",
    });
    const reboot = await runHostChecks(
      remote({ "test -f /var/run/reboot-required && echo yes || echo no": ok("yes\n") }),
    );
    expect(reboot.find((r) => r.id === "reboot-required")?.status).toBe("warn");
  });

  it("keeps going when a command cannot run", async () => {
    const results = await runHostChecks(
      remote({ "systemctl is-active fail2ban": new Error("connection reset") }),
    );
    expect(results.find((r) => r.id === "fail2ban")).toMatchObject({ status: "warn" });
    expect(results).toHaveLength(HOST_CHECKS.length);
  });

  it("flags unfinished setup and stopped services", async () => {
    const results = await runHostChecks(
      remote({
        "test -f /var/lib/opscrew-ready && echo yes || echo no": ok("no\n"),
        "systemctl is-active fail2ban": ok("inactive\n", 3),
      }),
    );
    expect(results.find((r) => r.id === "setup-finished")?.status).toBe("fail");
    expect(results.find((r) => r.id === "fail2ban")?.message).toContain("inactive");
  });
});

describe("probePorts", () => {
  it("fails any reachable sensitive port (spec US4 scenario 2)", async () => {
    const results = await probePorts("203.0.113.10", {
      ports: [5432, 6379],
      connect: async (_h, port) => port === 5432,
    });
    expect(results[0]).toMatchObject({ status: "fail", severity: "critical" });
    expect(results[0]?.message).toContain("5432 (PostgreSQL)");
    expect(results[1]?.status).toBe("pass");
  });

  it("checks the default sensitive ports", async () => {
    const asked: number[] = [];
    await probePorts("h", {
      connect: async (_h, port) => {
        asked.push(port);
        return false;
      },
    });
    expect(asked).toEqual(expect.arrayContaining([3306, 5432, 6379, 27017]));
  });
});

describe("probeSshPasswordAuth", () => {
  const runner = (stderr: string): CommandRunner => ({
    run: async () => ({ exitCode: 255, stdout: "", stderr }),
  });

  it("passes when only public keys are accepted", async () => {
    const result = await probeSshPasswordAuth("h", {
      runner: runner("deploy@h: Permission denied (publickey)."),
      knownHostsFile: "kh",
    });
    expect(result.status).toBe("pass");
  });

  it("fails when passwords are still offered", async () => {
    const result = await probeSshPasswordAuth("h", {
      runner: runner("deploy@h: Permission denied (publickey,password)."),
      knownHostsFile: "kh",
    });
    expect(result).toMatchObject({ status: "fail", severity: "high" });
  });

  it("warns when the answer is unclear", async () => {
    const result = await probeSshPasswordAuth("h", {
      runner: runner("ssh: connect to host h port 22: Connection timed out"),
      knownHostsFile: "kh",
    });
    expect(result.status).toBe("warn");
  });
});
