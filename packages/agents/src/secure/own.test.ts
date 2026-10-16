import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import type { CheckResult, CommandResult, Scanner } from "@opscrew/contracts";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import {
  hostPlanFile,
  type OwnServerConnectionInput,
  recordOwnServer,
  recordServerAddress,
} from "../shared";
import { createTestPhaseDeps, LAN_IPV4, OWN_IPV4, ownPlan, ScriptedRunner } from "../testing";
import { withoutOwnServer } from "./own";
import { runSecure } from "./run";

const NOW = "2026-10-14T12:00:00.000Z";

interface ServerOptions {
  /** OpsCrew's drop-in: `PermitRootLogin` value and whether it turns passwords off. */
  root?: string;
  passwordsOff?: boolean;
  /** The port sshd listens on (on the server). */
  sshPort?: number;
  /** Other ports listening on public addresses. */
  alsoListening?: number[];
}

/** The user's server as the deploy user sees it over SSH, and the outside password probe. */
function serverScript(o: ServerOptions = {}) {
  const port = o.sshPort ?? 22;
  const others = (o.alsoListening ?? []).map((p) => `LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:*`);
  return (command: string, args: readonly string[]): CommandResult => {
    const ok = (stdout: string): CommandResult => ({
      exitCode: 0,
      stdout: `${stdout}\n`,
      stderr: "",
    });
    if (command !== "ssh") return { exitCode: 1, stdout: "", stderr: "not a git repository" };
    if (args.includes("PubkeyAuthentication=no")) {
      return {
        exitCode: 255,
        stdout: "",
        stderr: `Permission denied (${o.passwordsOff === false ? "publickey,password" : "publickey"}).`,
      };
    }
    switch (args[args.length - 1]) {
      case "cat /etc/ssh/sshd_config.d/10-opscrew.conf":
        return ok(
          [
            "# Managed by OpsCrew. `opscrew destroy --undo-host` puts the previous setting back.",
            `PermitRootLogin ${o.root ?? "no"}`,
            ...(o.passwordsOff === false ? [] : ["PasswordAuthentication no"]),
          ].join("\n"),
        );
      case "systemctl is-active fail2ban":
        return ok("active");
      case "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf":
        return ok("");
      case "systemctl is-enabled unattended-upgrades":
        return ok("enabled");
      case "ss -H -tln":
        return ok(
          [
            `LISTEN 0 4096 0.0.0.0:${port} 0.0.0.0:*`,
            `LISTEN 0 4096 [::]:${port} [::]:*`,
            "LISTEN 0 4096 127.0.0.1:18080 0.0.0.0:*",
            ...others,
          ].join("\n"),
        );
      case "df -P /":
        return ok(
          "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1         39000000 4200000  33000000      12% /",
        );
      case "test -f /var/lib/opscrew-ready && echo yes || echo no":
        return ok("yes");
      case "test -f /var/run/reboot-required && echo yes || echo no":
        return ok("no");
      case "apt list --upgradable 2>/dev/null | grep -ci security || true":
        return ok("0");
      default:
        return { exitCode: 127, stdout: "", stderr: "unexpected command" };
    }
  };
}

/** The setup host plan provision applied (only the steps secure reads). */
function setupPlan(o: { root: boolean; disablePasswords: boolean; sshPorts: string }): HostPlan {
  return {
    schemaVersion: 1,
    purpose: "setup",
    app: "shop",
    steps: [
      {
        id: "sshd",
        title: "SSH",
        state: "in-place",
        params: {
          permitRootLogin: o.root ? "prohibit-password" : "no",
          disablePasswords: o.disablePasswords,
          kbdInteractiveOff: false,
        },
      },
      {
        id: "ufw",
        title: "Firewall (ufw)",
        state: "in-place",
        params: { sshPorts: o.sshPorts, sshRulePorts: "", webRules: "", web: false },
      },
    ],
    findings: [],
  };
}

async function setup(input: {
  plan: DeployPlan;
  own: OwnServerConnectionInput;
  server?: ServerOptions;
  hostPlan?: HostPlan;
  deployment?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-secure-own-"));
  const runner = new ScriptedRunner(serverScript(input.server));
  const deps = await createTestPhaseDeps({ root, runner, clock: { now: () => new Date(NOW) } });
  const approvals = [];
  if (input.hostPlan !== undefined) {
    const hash = hostPlanHash(input.hostPlan);
    await mkdir(deps.paths.files.plansDir, { recursive: true });
    await writeFile(hostPlanFile(deps.paths, hash), JSON.stringify(input.hostPlan));
    approvals.push({ planHash: hash, approver: "test-user", at: NOW, kind: "host-apply" });
  }
  await writeArtifact("plan", deps.paths.files.plan, {
    ...input.plan,
    approvals,
    deployment: { lastApplyAt: NOW },
  });
  await recordOwnServer(deps.paths, input.own);
  if (input.deployment !== undefined)
    await recordServerAddress(deps.paths, { ipv4: input.deployment });
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return Object.assign(deps, { runner });
}

const noScanners: Scanner[] = [];

function find(checks: readonly CheckResult[], id: string): CheckResult {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

/** The outside view: only the listed ports answer. */
function answering(...open: number[]): TcpConnect & { probed: string[] } {
  const probed: string[] = [];
  return Object.assign(
    async (host: string, port: number) => {
      probed.push(`${host}:${port}`);
      return open.includes(port);
    },
    { probed },
  );
}

const TUNNEL_LOGIN: OwnServerConnectionInput = {
  host: LAN_IPV4,
  port: 2222,
  user: "root",
  agent: true,
  reachable: false,
};

describe("runSecure on a server the user owns", () => {
  it("tunnel mode: root keeps key-only logins, kept passwords warn, SSH on its own port, no web ports", async () => {
    const deps = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: TUNNEL_LOGIN,
      server: { root: "prohibit-password", passwordsOff: false, sshPort: 2222 },
      hostPlan: setupPlan({ root: true, disablePasswords: false, sshPorts: "2222" }),
    });
    const connect = answering(2222);
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: connect });

    expect(find(result.hostChecks, "ssh-hardening")).toMatchObject({ status: "warn" });
    expect(find(result.hostChecks, "ssh-hardening").message).toContain(
      "root keeps key-only logins",
    );
    expect(find(result.hostChecks, "listening-ports")).toMatchObject({ status: "pass" });
    expect(find(result.probes, "ssh-password-login-disabled")).toMatchObject({ status: "warn" });
    expect(find(result.probes, "port-80-closed-tunnel")).toMatchObject({ status: "pass" });
    expect(find(result.probes, "port-443-closed-tunnel")).toMatchObject({ status: "pass" });
    expect(find(result.probes, "ssh-port-open")).toMatchObject({ status: "pass" });
    expect(result.passed).toBe(true);
    // The deploy user logs in on the recorded address and port, with the pinned known_hosts.
    const ssh = deps.runner.calls.find((c) => c.args.at(-1) === "ss -H -tln");
    expect(ssh?.args).toEqual(expect.arrayContaining(["-p", "2222", `deploy@${LAN_IPV4}`]));
    expect(connect.probed).toContain(`${LAN_IPV4}:2222`);
    expect(connect.probed).not.toContain(`${LAN_IPV4}:22`);

    // The committed report never names the server.
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).not.toContain(LAN_IPV4);
    expect(report).toContain("you chose to keep");
    // No provider wording on a server the user owns.
    expect(`${report}\n${deps.reporter.text()}`).not.toMatch(
      /Your own server|console|cloud provider/,
    );
  });

  it("allows only sshd's real ports: behind NAT (login 2222 → sshd 22) port 2222 on the server is not SSH", async () => {
    const nat = (alsoListening: number[]) =>
      setup({
        plan: ownPlan({ access: "tunnel" }),
        own: TUNNEL_LOGIN,
        server: { sshPort: 22, alsoListening },
        hostPlan: setupPlan({ root: false, disablePasswords: true, sshPorts: "22" }),
      });
    const clean = await runSecure(await nat([]), {
      scanners: noScanners,
      tcpConnect: answering(2222),
    });
    expect(find(clean.hostChecks, "listening-ports").status).toBe("pass");
    const other = await runSecure(await nat([2222]), {
      scanners: noScanners,
      tcpConnect: answering(2222),
    });
    const ports = find(other.hostChecks, "listening-ports");
    expect(ports.status).toBe("fail");
    expect(ports.message).toContain("public addresses: 2222 (SSH uses 22)");
  });

  it("tunnel mode fails when a web port answers", async () => {
    const deps = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: TUNNEL_LOGIN,
      server: { sshPort: 2222 },
      hostPlan: setupPlan({ root: false, disablePasswords: true, sshPorts: "2222" }),
    });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: answering(2222, 80) });
    expect(find(result.probes, "port-80-closed-tunnel")).toMatchObject({
      status: "fail",
      severity: "medium",
    });
    expect(find(result.probes, "port-443-closed-tunnel").status).toBe("pass");
    expect(result.passed).toBe(false);
  });

  it("public mode probes the public address; the committed report names neither address", async () => {
    const plan = ownPlan();
    const deps = await setup({
      plan: { ...plan, dns: { ...plan.dns, proxied: false } },
      own: { host: OWN_IPV4, port: 22, user: "admin", agent: true, reachable: true },
      hostPlan: setupPlan({ root: false, disablePasswords: true, sshPorts: "22" }),
      deployment: OWN_IPV4,
    });
    const connect = answering(22, 80, 443);
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: connect });
    expect(result.hostChecks.every((c) => c.status === "pass")).toBe(true);
    expect(find(result.probes, "port-80-open").status).toBe("pass");
    expect(find(result.probes, "port-5432-closed").status).toBe("pass");
    expect(result.passed).toBe(true);
    expect(connect.probed).toContain(`${OWN_IPV4}:443`);
    expect(await readFile(deps.paths.files.securityReport, "utf8")).not.toContain(OWN_IPV4);
  });

  it("behind Cloudflare's proxy: closed web ports are what OpsCrew set up, open ones a finding", async () => {
    const options = {
      plan: ownPlan(),
      own: { host: OWN_IPV4, port: 22, user: "admin", agent: true, reachable: true },
      hostPlan: setupPlan({ root: false, disablePasswords: true, sshPorts: "22" }),
      deployment: OWN_IPV4,
    };
    const closed = await runSecure(await setup(options), {
      scanners: noScanners,
      tcpConnect: answering(22),
    });
    for (const port of [80, 443]) {
      expect(find(closed.probes, `port-${port}-cloudflare-only`)).toMatchObject({
        status: "pass",
        severity: "info",
      });
    }
    expect(closed.probes.some((probe) => probe.id === "port-80-open")).toBe(false);
    expect(closed.passed).toBe(true);

    const deps = await setup(options);
    const open = await runSecure(deps, { scanners: noScanners, tcpConnect: answering(22, 443) });
    expect(find(open.probes, "port-80-cloudflare-only").status).toBe("pass");
    const https = find(open.probes, "port-443-cloudflare-only");
    expect(https).toMatchObject({ status: "fail", severity: "medium" });
    expect(https.message).toContain("around Cloudflare's protection");
    expect(https.remediation).toContain("opscrew provision");
    expect(open.passed).toBe(false);
    expect(await readFile(deps.paths.files.securityReport, "utf8")).not.toContain(OWN_IPV4);
  });

  it("behind the web filter, 443 must not answer on the server's IPv6 address either", async () => {
    const OWN_IPV6 = "2001:db8::10";
    const options = {
      plan: ownPlan(),
      own: {
        host: OWN_IPV4,
        port: 22,
        user: "admin",
        agent: true,
        reachable: true,
        publicIpv6: OWN_IPV6,
      },
      hostPlan: setupPlan({ root: false, disablePasswords: true, sshPorts: "22" }),
      deployment: OWN_IPV4,
    };
    // docker-proxy answers on IPv6 (around DOCKER-USER): a finding, the address never reported.
    const deps = await setup(options);
    const probed: string[] = [];
    const open6 = await runSecure(deps, {
      scanners: noScanners,
      ipv6Route: async () => true,
      tcpConnect: async (host, port) => {
        probed.push(`${host}:${port}`);
        return port === 22 || host === OWN_IPV6;
      },
    });
    expect(probed).toContain(`${OWN_IPV6}:443`);
    expect(find(open6.probes, "port-443-ipv6-closed")).toMatchObject({
      status: "fail",
      severity: "medium",
    });
    expect(open6.passed).toBe(false);
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).not.toContain(OWN_IPV6);
    expect(report).not.toContain(OWN_IPV4);

    // Closed on IPv6: as intended. No IPv6 route from this computer: skipped with a note.
    const closed = await runSecure(await setup(options), {
      scanners: noScanners,
      ipv6Route: async () => true,
      tcpConnect: answering(22),
    });
    expect(find(closed.probes, "port-443-ipv6-closed").status).toBe("pass");
    const noRoute = await runSecure(await setup(options), {
      scanners: noScanners,
      ipv6Route: async () => false,
      tcpConnect: answering(22),
    });
    expect(find(noRoute.probes, "port-443-ipv6-closed")).toMatchObject({ status: "skip" });
    expect(find(noRoute.probes, "port-443-ipv6-closed").message).toMatch(/no IPv6 route/);

    // DNS only: no IPv6 probe (the server answers everyone there).
    const plan = ownPlan();
    const dnsOnly = await runSecure(
      await setup({
        ...options,
        plan: {
          ...plan,
          dns: { ...plan.dns, proxied: false },
          security: { ...plan.security, httpAllowedFrom: "any" },
        },
      }),
      { scanners: noScanners, ipv6Route: async () => true, tcpConnect: answering(22, 80, 443) },
    );
    expect(dnsOnly.probes.some((probe) => probe.id === "port-443-ipv6-closed")).toBe(false);
  });

  it("without the applied host plan on this computer, a password-on drop-in fails", async () => {
    const deps = await setup({
      plan: ownPlan({ access: "tunnel" }),
      own: TUNNEL_LOGIN,
      server: { root: "prohibit-password", passwordsOff: false, sshPort: 2222 },
    });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: answering(2222) });
    // A root login still means key-only root is fine; the password choice is unknown.
    const ssh = find(result.hostChecks, "ssh-hardening");
    expect(ssh.status).toBe("fail");
    expect(ssh.message).toContain("password login is still allowed");
    expect(ssh.message).not.toContain("PermitRootLogin");
    expect(find(result.probes, "ssh-password-login-disabled").status).toBe("fail");
  });

  it("never names the server's addresses or login host name in the terminal, in any mode", async () => {
    const OWN_IPV6 = "2001:db8::10";
    const LOGIN = "home-server.example.net";
    const plan = ownPlan();
    const modes: DeployPlan[] = [
      // DNS only.
      {
        ...plan,
        dns: { ...plan.dns, proxied: false },
        security: { ...plan.security, httpAllowedFrom: "any" },
      },
      // Behind Cloudflare's proxy and OpsCrew's web filter.
      plan,
      ownPlan({ access: "tunnel" }),
    ];
    for (const mode of modes) {
      const deps = await setup({
        plan: mode,
        own: {
          host: LOGIN,
          port: 22,
          user: "admin",
          agent: true,
          reachable: mode.target.provider === "own" && mode.target.access === "public",
          publicIpv4: OWN_IPV4,
          publicIpv6: OWN_IPV6,
        },
        // A password left on and every port answering: failures that name their targets.
        server: { passwordsOff: false },
        deployment: OWN_IPV4,
      });
      const result = await runSecure(deps, {
        scanners: noScanners,
        ipv6Route: async () => true,
        tcpConnect: async () => true,
      });
      expect(result.passed).toBe(false);
      const terminal = `${deps.reporter.text()}\n${result.summary}`;
      for (const name of [OWN_IPV4, OWN_IPV6, LOGIN]) expect(terminal).not.toContain(name);
      expect(terminal).toContain("your server");
    }
  });

  it("says where to run it when this computer does not know the server", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-secure-own-"));
    const deps = await createTestPhaseDeps({
      root,
      runner: new ScriptedRunner(serverScript()),
      clock: { now: () => new Date(NOW) },
    });
    await writeArtifact("plan", deps.paths.files.plan, ownPlan({ access: "tunnel" }));
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: answering() });
    expect(result.hostChecks).toEqual([]);
    expect(result.probes).toEqual([]);
    expect(result.report).toContain("does not know how to reach your server");
  });
});

describe("withoutOwnServer", () => {
  it("replaces addresses and host names, not longer names that contain them", () => {
    expect(
      withoutOwnServer("ssh deploy@192.168.1.20 and 192.168.1.200, home.example.net", [
        "192.168.1.20",
        "home.example.net",
      ]),
    ).toBe("ssh deploy@your server and 192.168.1.200, your server");
  });
});
