import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CheckResult,
  CommandOptions,
  CommandResult,
  Scanner,
  ScanReport,
} from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { createSecretsScanner, type TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedRunner, type TestPhaseDeps } from "../testing";
import { SERVER_IPV4, type TestPlanOptions, testPlan } from "../verify/__fixtures__/plan";
import {
  renderSecurityReport,
  runSecure,
  type SecurityReportInput,
  securityProblems,
} from "./index";

const NOW = "2026-10-11T12:00:00.000Z";

const HARDENED_SSHD = [
  "PasswordAuthentication no",
  "KbdInteractiveAuthentication no",
  "PermitRootLogin no",
  "MaxAuthTries 3",
  "X11Forwarding no",
  "AllowUsers deploy",
].join("\n");

const SS_OUTPUT = [
  "LISTEN 0      4096   0.0.0.0:22        0.0.0.0:*",
  "LISTEN 0      4096   0.0.0.0:80        0.0.0.0:*",
  "LISTEN 0      4096   0.0.0.0:443       0.0.0.0:*",
  "LISTEN 0      4096   127.0.0.53%lo:53  0.0.0.0:*",
  "LISTEN 0      4096   [::]:22           [::]:*",
].join("\n");

interface ServerOptions {
  /** Password login left on (sshd drop-in and the outside probe). */
  passwordAuth?: boolean;
}

/** A fake Ubuntu 24.04 server answering over `ssh` (as the deploy user) and the password probe. */
function serverScript(o: ServerOptions = {}) {
  return (command: string, args: readonly string[], _options?: CommandOptions): CommandResult => {
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
        stderr: `deploy@${SERVER_IPV4}: Permission denied (${o.passwordAuth ? "publickey,password" : "publickey"}).`,
      };
    }
    const remote = args[args.length - 1];
    switch (remote) {
      case "cat /etc/ssh/sshd_config.d/10-opscrew.conf":
        return ok(
          o.passwordAuth
            ? HARDENED_SSHD.replace("PasswordAuthentication no", "PasswordAuthentication yes")
            : HARDENED_SSHD,
        );
      case "systemctl is-active fail2ban":
      case "systemctl is-active ufw":
        return ok("active");
      case "systemctl is-enabled unattended-upgrades":
        return ok("enabled");
      case "ss -H -tln":
        return ok(SS_OUTPUT);
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
        return { exitCode: 127, stdout: "", stderr: `unexpected command: ${remote}` };
    }
  };
}

/** Outside view: 22/80/443 answer, everything else is closed unless listed in `open`. */
function ports(open: number[] = []): TcpConnect {
  return async (_host, port) => [22, 80, 443, ...open].includes(port);
}

const noScanners: Scanner[] = [];

async function setup(
  plan: TestPlanOptions = {},
  server: ServerOptions = {},
  options: { deployKey?: boolean } = {},
): Promise<TestPhaseDeps & { runner: ScriptedRunner }> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-secure-"));
  const runner = new ScriptedRunner(serverScript(server));
  const deps = await createTestPhaseDeps({
    root,
    runner,
    clock: { now: () => new Date(NOW) },
  });
  await writeArtifact("plan", deps.paths.files.plan, testPlan(plan));
  if (options.deployKey !== false) {
    await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
    await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  }
  return deps as TestPhaseDeps & { runner: ScriptedRunner };
}

function find(checks: readonly CheckResult[], id: string): CheckResult {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

describe("runSecure", () => {
  it("writes a clean report for a hardened server", async () => {
    const deps = await setup({ httpAllowedFrom: "any" });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports() });

    expect(result.passed).toBe(true);
    expect(result.hostChecks.every((c) => c.status === "pass")).toBe(true);
    expect(result.probes.every((c) => c.status === "pass")).toBe(true);
    expect(result.reportPath).toBe("opscrew/SECURITY_REPORT.md");
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).toBe(result.report);
    expect(report).toContain("# OpsCrew security report: shop");
    expect(report).toContain("**No problems found.**");
    expect(report).toContain("## Server hardening");
    expect(report).toContain("## Outside probes");
    expect(report).toContain("Not evaluated: no infrastructure plan was available.");
    expect((await deps.state.read()).phases.secure?.status).toBe("ok");

    // SSH runs as deploy with the project's key and pinned known_hosts.
    const ssh = deps.runner.calls.find((c) => c.args.at(-1) === "ss -H -tln");
    expect(ssh?.args).toContain(deps.paths.files.deployKey);
    expect(ssh?.args).toContain(`UserKnownHostsFile=${deps.paths.files.knownHosts}`);
    expect(ssh?.args).toContain(`deploy@${SERVER_IPV4}`);
  });

  it("reports enabled SSH password login as a high failure with the fix (US4 scenario 1)", async () => {
    const deps = await setup({}, { passwordAuth: true });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports() });

    const probe = find(result.probes, "ssh-password-login-disabled");
    expect(probe).toMatchObject({ status: "fail", severity: "high" });
    expect(find(result.hostChecks, "ssh-hardening")).toMatchObject({
      status: "fail",
      severity: "high",
    });
    expect(result.passed).toBe(false);
    const report = result.report;
    expect(report).toContain(
      "**High** · Outside probe: The server still offers password login over SSH.",
    );
    expect(report).toContain("Expected: SSH refuses password logins.");
    expect(report).toContain(
      "**Fix:** Set PasswordAuthentication no and KbdInteractiveAuthentication no, then restart ssh.",
    );
    expect(report).toContain("password login is still allowed");
    expect((await deps.state.read()).phases.secure?.status).toBe("failed");
    expect(deps.reporter.lines[0]?.level).toBe("step");
    expect(
      deps.reporter.lines.some((l) => l.level === "error" && l.message.includes("problem")),
    ).toBe(true);
  });

  it("reports a reachable database port as a critical failure naming the port (US4 scenario 2)", async () => {
    const deps = await setup({ httpAllowedFrom: "any" });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports([5432]) });

    expect(find(result.probes, "port-5432-closed")).toMatchObject({
      status: "fail",
      severity: "critical",
    });
    const [first] = result.problems;
    expect(first).toMatchObject({ severity: "critical", status: "fail" });
    expect(first?.title).toContain("5432");
    expect(result.report).toContain(
      "1. **Critical** · Outside probe: Port 5432 (PostgreSQL) is reachable from the internet.",
    );
    expect(result.summary).toContain("CRITICAL");
    expect(result.summary).toContain("5432");
  });

  it("treats filtered web ports as expected when only Cloudflare may reach the origin", async () => {
    const deps = await setup({ httpAllowedFrom: "cloudflare" });
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: async (_host, port) => port === 22,
    });
    expect(find(result.probes, "port-443-cloudflare-only")).toMatchObject({
      status: "pass",
      severity: "info",
    });
    expect(result.passed).toBe(true);
  });

  it("evaluates the plan policies when an engine plan is given", async () => {
    const deps = await setup({ httpAllowedFrom: "any" });
    const planJson = {
      planned_values: {
        root_module: {
          child_modules: [
            {
              resources: [
                {
                  address: "module.server.hcloud_server.this",
                  mode: "managed",
                  type: "hcloud_server",
                  name: "this",
                  values: {
                    firewall_ids: [1],
                    ssh_keys: ["1"],
                    delete_protection: true,
                    backups: true,
                  },
                },
                {
                  address: "module.server.hcloud_firewall.this",
                  mode: "managed",
                  type: "hcloud_firewall",
                  name: "this",
                  values: {
                    rule: [
                      { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0"] },
                      { direction: "in", protocol: "tcp", port: "5432", source_ips: ["0.0.0.0/0"] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports(), planJson });
    const failed = result.policies?.filter((p) => !p.passed) ?? [];
    expect(failed.map((p) => p.policyId)).toEqual(["no-open-admin-ports"]);
    expect(result.passed).toBe(false);
    expect(result.report).toContain("## Infrastructure policies");
    expect(result.report).toContain("tcp/5432");
  });

  it("re-checks the plan provision applied last when no plan JSON is given", async () => {
    const deps = await setup({ httpAllowedFrom: "any" });
    const planHash = "a".repeat(64);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      deployment: { ...plan.deployment, lastPlanHash: planHash },
    });
    await mkdir(deps.paths.files.plansDir, { recursive: true });
    const firewall = {
      address: "module.server.hcloud_firewall.this",
      mode: "managed",
      type: "hcloud_firewall",
      name: "this",
      values: { rule: [{ direction: "in", protocol: "tcp", port: "6379", source_ips: ["::/0"] }] },
    };
    await writeFile(
      join(deps.paths.files.plansDir, "2026-10-11T12-00-00-000Z.tfplan.json"),
      JSON.stringify({
        planHash,
        planJson: { planned_values: { root_module: { resources: [firewall] } } },
      }),
    );
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports() });
    expect(result.policies?.filter((p) => !p.passed).map((p) => p.policyId)).toContain(
      "no-open-admin-ports",
    );
  });

  it("never writes a secret found by the scan into the report or the output", async () => {
    const deps = await setup({ httpAllowedFrom: "any" });
    const secret = fakeSecret("github-token");
    await writeFile(join(deps.paths.root, "config.js"), `export const token = "${secret}";\n`);
    const result = await runSecure(deps, {
      scanners: [createSecretsScanner()],
      tcpConnect: ports(),
    });
    expect(result.scan.findings.length).toBeGreaterThan(0);
    expect(result.report).toContain("config.js");
    expect(result.report).not.toContain(secret);
    expect(await readFile(deps.paths.files.securityReport, "utf8")).not.toContain(secret);
    expect(deps.reporter.text()).not.toContain(secret);
    expect(result.passed).toBe(false);
  });

  it("skips the server checks before provision and without the deploy key", async () => {
    const before = await setup({ ip: false });
    const a = await runSecure(before, { scanners: noScanners, tcpConnect: ports() });
    expect(a.hostChecks).toEqual([]);
    expect(a.probes).toEqual([]);
    expect(a.report).toContain("Skipped: no server is recorded");
    expect(before.runner.calls).toEqual([]);

    const noKey = await setup({ httpAllowedFrom: "any" }, {}, { deployKey: false });
    const b = await runSecure(noKey, { scanners: noScanners, tcpConnect: ports() });
    expect(b.hostChecks).toEqual([]);
    expect(b.probes.length).toBeGreaterThan(0);
    expect(b.report).toContain("the deploy key is not on this machine");
    expect(noKey.reporter.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("marks the phase failed when the plan is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-secure-"));
    const deps = await createTestPhaseDeps({ root });
    await expect(runSecure(deps, { scanners: noScanners })).rejects.toMatchObject({
      code: "ARTIFACT_MISSING",
    });
    expect((await deps.state.read()).phases.secure?.status).toBe("failed");
  });
});

function fixedInput(): SecurityReportInput {
  const scan: ScanReport = {
    tool: "opscrew",
    version: "0.1.0",
    project: "shop",
    startedAt: NOW,
    finishedAt: NOW,
    findings: [
      {
        id: "f1",
        ruleId: "config/docker-root-user",
        title: "Container runs as root",
        severity: "medium",
        category: "config",
        file: "Dockerfile",
        line: 1,
        description: "The image has no USER instruction.",
        remediation: "Add a non-root USER.",
        source: "opscrew-config",
      },
    ],
    scanners: [
      { id: "opscrew-config", status: "ran", durationMs: 3 },
      { id: "gitleaks", status: "skipped", reason: "gitleaks is not installed" },
    ],
    counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
  };
  return {
    appName: "shop",
    version: "0.1.0",
    generatedAt: NOW,
    host: SERVER_IPV4,
    scan,
    policies: [
      {
        policyId: "firewall-attached",
        title: "Server has a firewall",
        severity: "high",
        passed: true,
        message: "The server is attached to a Hetzner Cloud firewall.",
      },
      {
        policyId: "delete-protection",
        title: "Server is protected against accidental deletion",
        severity: "medium",
        passed: false,
        message: "Delete protection is off. Turn it on.",
        resource: "module.server.hcloud_server.this",
      },
    ],
    hostChecks: [
      {
        id: "fail2ban",
        title: "Brute-force protection (fail2ban) is running",
        severity: "medium",
        status: "pass",
        message: "fail2ban is active.",
      },
      {
        id: "reboot-required",
        title: "No reboot pending",
        severity: "low",
        status: "warn",
        message: "Security updates were installed that need a reboot.",
        remediation: "Reboot the server.",
      },
    ],
    probes: [
      {
        id: "port-6379-closed",
        title: "Port 6379 (Redis/Valkey) is closed to the internet",
        severity: "critical",
        status: "fail",
        message: "Port 6379 (Redis/Valkey) is reachable from the internet.",
        remediation: "Close it in the Hetzner firewall.",
        target: SERVER_IPV4,
      },
    ],
  };
}

describe("renderSecurityReport", () => {
  it("is deterministic and orders the remediation list by severity", () => {
    const input = fixedInput();
    const a = renderSecurityReport(input);
    expect(renderSecurityReport(structuredClone(input))).toBe(a);
    expect(securityProblems(input).map((p) => [p.severity, p.status, p.area])).toEqual([
      ["critical", "fail", "Outside probe"],
      ["medium", "fail", "Code scan"],
      ["medium", "fail", "Infrastructure policy"],
      ["low", "warn", "Server"],
    ]);
    expect(a).toContain("**3 problems to fix** (1 critical, 2 medium) and 1 warning.");
    expect(a).toMatchSnapshot();
  });
});
