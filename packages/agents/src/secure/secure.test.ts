import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CheckResult,
  CommandOptions,
  CommandResult,
  FetchLike,
  Scanner,
  ScanReport,
} from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, TOOLS } from "@opscrew/iac-templates";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import {
  createSecretsScanner,
  type DeepToolResult,
  type LocalDocker,
  type TcpConnect,
} from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { recordServerAddress } from "../shared";
import { createTestPhaseDeps, ScriptedRunner, type TestPhaseDeps } from "../testing";
import {
  SERVER,
  SERVER_IPV4,
  SERVER_IPV6,
  type TestPlanOptions,
  testPlan,
} from "../verify/__fixtures__/plan";
import { renderSecurityReport, type SecurityReportInput, securityProblems } from "./report";
import { runSecure } from "./run";

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

/** A short Lynis report in the layout of the 014 spike's (`--deep`). */
const LYNIS_REPORT = [
  "lynis_version=3.1.7",
  "warning[]=PKGS-7388|Can't find any security repository in /etc/apt/sources.list or sources.list.d directory|-|-|",
  "warning[]=PKGS-7392|Found one or more vulnerable packages.|-|-|",
  "suggestion[]=PKGS-7392|Update your system with apt-get update, apt-get upgrade, apt-get dist-upgrade and/or unattended-upgrades|-|-|",
  "suggestion[]=FILE-6310|To decrease the impact of a full /home file system, place /home on a separate partition|-|-|",
  "hardening_index=62",
].join("\n");

const SSH_AUDIT_JSON = JSON.stringify({
  banner: { software: "OpenSSH_9.6p1" },
  kex: [
    { algorithm: "sntrup761x25519-sha512@openssh.com", notes: { info: ["default"] } },
    {
      algorithm: "ecdh-sha2-nistp256",
      notes: {
        fail: [
          "using elliptic curves that are suspected as being backdoored by the U.S. National Security Agency",
        ],
      },
    },
  ],
  key: [{ algorithm: "ssh-ed25519", notes: { info: ["available since OpenSSH 6.5"] } }],
  enc: [{ algorithm: "chacha20-poly1305@openssh.com", notes: {} }],
  mac: [{ algorithm: "hmac-sha1", notes: { fail: ["using broken SHA-1 hash algorithm"] } }],
});

const SSH_POLICY_JSON = JSON.stringify({
  errors: [
    {
      actual: ["hmac-sha1"],
      expected_optional: [""],
      expected_required: ["hmac-sha2-512-etm@openssh.com"],
      mismatched_field: "MACs",
    },
  ],
  host: SERVER_IPV4,
  passed: false,
  policy: "Hardened Ubuntu Server 24.04 LTS (version 2)",
  port: 22,
  warnings: [],
});

const TESTSSL_JSON = JSON.stringify({
  version: "3.2.4 ",
  scanResult: [
    {
      targetHost: "shop.example.com",
      protocols: [{ id: "TLS1_3", severity: "OK", finding: "offered with final" }],
      serverDefaults: [
        { id: "OCSP_stapling", severity: "LOW", finding: "not offered" },
        { id: "cert_trust", severity: "INFO", finding: "Ok via SAN" },
      ],
      headerResponse: [{ id: "security_headers", severity: "MEDIUM", finding: "--" }],
    },
  ],
});

/** Docker on this computer: ssh-audit's audit and policy, testssl.sh's JSON (exit 3 as ssh-audit does). */
function fakeLocalDocker() {
  const calls: (readonly string[])[] = [];
  const docker: LocalDocker = {
    async run(args) {
      calls.push(args);
      if (args[0] === "version") return { exitCode: 0, stdout: "29.8.2\n", stderr: "" };
      if (args.includes(IMAGES.sshAudit.ref)) {
        return {
          exitCode: 3,
          stdout: args.includes("-P") ? SSH_POLICY_JSON : SSH_AUDIT_JSON,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: TESTSSL_JSON, stderr: "" };
    },
  };
  return { docker, calls };
}

const lynisFetch: FetchLike = async (url) => {
  if (String(url) !== TOOLS.lynis.url) throw new Error(`unexpected fetch ${String(url)}`);
  return new Response(new Uint8Array([31, 139, 8, 0]));
};

interface ServerOptions {
  /** Password login left on (sshd drop-in and the outside probe). */
  passwordAuth?: boolean;
  /** `docker ps`'s ports of the app's Postgres (default: none published). */
  dbPorts?: string;
  /** The login variables set in its container (default: its password). */
  dbLogin?: string;
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
      case "grep -qx 'ENABLED=yes' /etc/ufw/ufw.conf":
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
        // `--deep`: Lynis's image is not on the server, its container prints the report.
        if (remote?.startsWith("docker image inspect")) return ok("no");
        if (remote?.startsWith("docker run")) return ok(LYNIS_REPORT);
        if (remote?.startsWith("if docker image inspect")) return ok("");
        // The app's Postgres (`db`): its ports and the login variables that are set.
        if (remote?.includes("{{.Ports}}")) return ok(o.dbPorts ?? "5432/tcp");
        if (remote?.includes("docker inspect")) return ok(o.dbLogin ?? "POSTGRES_PASSWORD");
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
  options: { deployKey?: boolean; fetch?: FetchLike } = {},
): Promise<TestPhaseDeps & { runner: ScriptedRunner }> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-secure-"));
  const runner = new ScriptedRunner(serverScript(server));
  const deps = await createTestPhaseDeps({
    root,
    runner,
    clock: { now: () => new Date(NOW) },
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  await writeArtifact("plan", deps.paths.files.plan, testPlan(plan));
  if (plan.ip !== false) await recordServerAddress(deps.paths, SERVER);
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

  it("checks that no service port is public and that each service's login is set (FR-1328)", async () => {
    const clean = await runSecure(await setup(), { scanners: noScanners, tcpConnect: ports() });
    expect(find(clean.hostChecks, "service-db-port")).toMatchObject({ status: "pass" });
    expect(find(clean.hostChecks, "service-db-login")).toMatchObject({
      status: "pass",
      message: "PostgreSQL (db) requires its login: POSTGRES_PASSWORD is set.",
    });

    const deps = await setup({}, { dbPorts: "0.0.0.0:5432->5432/tcp", dbLogin: "" });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports([5432]) });
    expect(find(result.hostChecks, "service-db-port")).toMatchObject({
      status: "fail",
      severity: "critical",
    });
    expect(find(result.hostChecks, "service-db-login")).toMatchObject({
      status: "fail",
      message: "PostgreSQL (db) runs without POSTGRES_PASSWORD, so its login is not set.",
    });
    expect(find(result.probes, "port-5432-closed")).toMatchObject({ status: "fail" });
    expect(result.passed).toBe(false);
    // Only the names of the login variables are ever asked for, never their values.
    const login = deps.runner.calls.find((c) => (c.args.at(-1) ?? "").includes("docker inspect"));
    expect(login?.args.at(-1)).toContain("sed -n -E 's/^(POSTGRES_PASSWORD)=.+$/\\1/p'");
  });

  it("probes the ports of the plan's services from outside", async () => {
    const base = testPlan();
    const deps = await setup();
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({
        ...base,
        services: [
          ...base.services,
          { kind: "nats", version: "2.15", memoryMb: 64, reason: "nats", licence: "Apache-2.0" },
        ],
      }),
    );
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports([4222]) });
    expect(find(result.probes, "port-4222-closed")).toMatchObject({
      status: "fail",
      message: "Port 4222 (NATS) is reachable from the internet.",
    });
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

  it("names the plan provider's firewall and console in the probe fixes", async () => {
    const remediation = (checks: readonly CheckResult[], id: string) =>
      find(checks, id).remediation;
    const hetzner = await setup({ httpAllowedFrom: "any" });
    const onHetzner = await runSecure(hetzner, {
      scanners: noScanners,
      tcpConnect: async (_host, port) => port === 5432,
    });
    expect(remediation(onHetzner.probes, "port-5432-closed")).toContain("Hetzner Cloud firewall");
    expect(remediation(onHetzner.probes, "port-22-open")).toContain(
      "Hetzner Cloud console (https://console.hetzner.cloud/)",
    );

    const digitalocean = await setup({ httpAllowedFrom: "any", provider: "digitalocean" });
    const onDigitalOcean = await runSecure(digitalocean, {
      scanners: noScanners,
      tcpConnect: async (_host, port) => port === 5432,
    });
    const probes = onDigitalOcean.probes;
    expect(remediation(probes, "port-5432-closed")).toContain("the DigitalOcean firewall");
    expect(remediation(probes, "port-22-open")).toContain(
      "Droplet is running in the DigitalOcean console (https://cloud.digitalocean.com/)",
    );
    expect(remediation(probes, "port-443-open")).toContain("DigitalOcean firewall");
    expect(onDigitalOcean.report).toContain("DigitalOcean firewall");
    expect(onDigitalOcean.report).not.toContain("Hetzner");
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
    // A complete sidecar as `opscrew provision --plan-only` writes it (findSavedPlan validates it).
    const planFile = join(deps.paths.files.plansDir, "2026-10-11T12-00-00-000Z.tfplan");
    await writeFile(
      `${planFile}.json`,
      JSON.stringify({
        planHash,
        planFile,
        dir: join(deps.paths.root, "opscrew", "infra", "prod"),
        engine: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
        createdAt: "2026-10-11T12:00:00.000Z",
        changes: [],
        counts: { create: 0, update: 0, delete: 0, replace: 0 },
        hasDestroy: false,
        policy: [],
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

  it("keeps the server's address out of the report behind Cloudflare's proxy", async () => {
    // A failing probe whose target is the server, so the address would show up in the fix list.
    const deps = await setup({ httpAllowedFrom: "any" }, { passwordAuth: true });
    const result = await runSecure(deps, { scanners: noScanners, tcpConnect: ports([5432]) });
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).toBe(result.report);
    expect(report).not.toContain(SERVER_IPV4);
    expect(report).not.toContain(SERVER_IPV6);
    expect(report).toContain("Connections attempted from this machine to the server.");
    expect(report).toContain("Port 5432 (PostgreSQL) is reachable from the internet.");
    // The checks themselves still ran against the address, and the terminal may show it.
    expect(find(result.probes, "port-5432-closed").target).toBe(SERVER_IPV4);
    expect(deps.runner.calls.some((c) => c.args.includes(`deploy@${SERVER_IPV4}`))).toBe(true);

    // Without a domain the app is served on the address, so the report names it.
    const open = await setup({ domain: undefined }, {});
    const plain = await runSecure(open, { scanners: noScanners, tcpConnect: ports() });
    expect(plain.report).toContain(`Server: \`${SERVER_IPV4}\`.`);
  });

  it("skips the server checks before provision and without the deploy key", async () => {
    const before = await setup({ ip: false });
    const a = await runSecure(before, { scanners: noScanners, tcpConnect: ports() });
    expect(a.hostChecks).toEqual([]);
    expect(a.probes).toEqual([]);
    expect(a.report).toContain(
      "Skipped: OpsCrew does not know the server's address on this computer",
    );
    expect(a.report).not.toContain("opscrew provision` first");
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

describe("runSecure --deep", () => {
  const lynisCalls = (deps: TestPhaseDeps & { runner: ScriptedRunner }) =>
    deps.runner.calls.filter((c) => (c.args.at(-1) ?? "").includes("docker image"));

  it("without --deep runs and reports exactly as before (FR-1425)", async () => {
    const deps = await setup({ httpAllowedFrom: "any" });
    const local = fakeLocalDocker();
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: ports(),
      docker: local.docker,
    });
    expect(local.calls).toEqual([]);
    expect(lynisCalls(deps)).toEqual([]);
    expect(result.deep).toBeUndefined();
    expect(result.report).not.toContain("Deeper checks");
    expect(result.report).toMatchSnapshot();
  });

  it("runs Lynis over SSH, then ssh-audit and testssl.sh from this computer, and reports them", async () => {
    const deps = await setup({ httpAllowedFrom: "any" }, {}, { fetch: lynisFetch });
    const local = fakeLocalDocker();
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: ports(),
      deep: true,
      docker: local.docker,
    });

    expect(result.deep?.map((run) => [run.tool, run.version])).toEqual([
      ["lynis", "3.1.7"],
      ["ssh-audit", "3.9.0"],
      ["testssl", "3.2.4"],
    ]);
    // Lynis: one container from the pinned image over the deploy user's SSH, then the image goes.
    const run = deps.runner.calls.find((c) => (c.args.at(-1) ?? "").startsWith("docker run"));
    expect(run?.args).toContain(`deploy@${SERVER_IPV4}`);
    expect(run?.args.at(-1)).toContain(IMAGES.curl.ref);
    expect(run?.options?.timeoutMs).toBe(240_000);
    expect(lynisCalls(deps).at(-1)?.args.at(-1)).toContain(`docker image rm ${IMAGES.curl.ref}`);
    // ssh-audit against the server's SSH port; testssl.sh against the hostname.
    expect(local.calls.filter((args) => args.includes(IMAGES.sshAudit.ref))[0]?.slice(-3)).toEqual([
      "-p",
      "22",
      SERVER_IPV4,
    ]);
    expect(local.calls.at(-1)?.at(-1)).toBe("shop.example.com:443");

    expect(result.deep?.[0]?.hardeningIndex).toBe(62);
    expect(result.problems.filter((p) => p.area === "Deeper checks").map((p) => p.title)).toEqual([
      expect.stringContaining("does not meet the policy: MACs differ"),
      "The Lynis hardening index is 62 of 100.",
      "Found one or more vulnerable packages.",
      "security_headers: none",
      "Update your system with apt-get update, apt-get upgrade, apt-get dist-upgrade and/or unattended-upgrades",
      "hmac-sha1: using broken SHA-1 hash algorithm.",
    ]);
    expect(result.passed).toBe(false);

    const report = result.report;
    expect(report).toContain("| Deeper checks | 0 passed, 1 failed, 5 warnings, 0 skipped |");
    expect(report).toContain("## Deeper checks");
    expect(report).toContain("### Lynis 3.1.7");
    expect(report).toContain("Hardening index: **62** of 100.");
    expect(report).toContain("### ssh-audit 3.9.0");
    expect(report).toContain("### testssl.sh 3.2.4");
    expect(report).toContain("shop.example.com (Cloudflare's edge)");
    expect(report).toContain("Known noise, set apart and not counted:");
    expect(report).toContain("deb822");
    // Proxied: the server's address stays out of the committed report.
    expect(report).not.toContain(SERVER_IPV4);
    expect(report.slice(report.indexOf("## Deeper checks"))).toMatchSnapshot();
  });

  it("skips ssh-audit and testssl.sh without Docker, and Lynis still runs", async () => {
    const deps = await setup({ httpAllowedFrom: "any" }, {}, { fetch: lynisFetch });
    const docker: LocalDocker = {
      run: async () => {
        throw new Error("Could not run docker: it is not installed or not on PATH.");
      },
    };
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: ports(),
      deep: true,
      docker,
    });
    const [lynis, sshAudit, testssl] = result.deep ?? [];
    expect(lynis?.results.some((r) => r.id === "PKGS-7392")).toBe(true);
    for (const run of [sshAudit, testssl]) {
      expect(run?.results).toEqual([
        expect.objectContaining({
          status: "skip",
          message: expect.stringContaining("Docker is not installed on this computer"),
          remediation: expect.stringContaining("Install Docker Desktop"),
        }),
      ]);
    }
    expect(result.report).toContain("| Deeper checks |");
    expect(result.report).toContain("2 skipped");
  });

  it("skips Lynis when the server cannot be reached over SSH, never passing it", async () => {
    const deps = await setup({ httpAllowedFrom: "any" }, {}, { deployKey: false });
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: ports(),
      deep: true,
      docker: fakeLocalDocker().docker,
    });
    expect(result.deep?.[0]?.results).toEqual([
      expect.objectContaining({
        status: "skip",
        message: expect.stringContaining("the deploy key is not on this machine"),
      }),
    ]);
  });
});

function deepRuns(): DeepToolResult[] {
  return [
    {
      tool: "lynis",
      version: "3.1.7",
      hardeningIndex: 70,
      results: [
        {
          id: "hardening-index",
          title: "Lynis hardening index is 65 or more",
          status: "pass",
          severity: "medium",
          message: "The Lynis hardening index is 70 of 100.",
          source: "lynis",
        },
        {
          id: "BOOT-5122",
          title: "Lynis suggestion BOOT-5122",
          status: "warn",
          severity: "low",
          message: "Set a password on GRUB boot loader",
          source: "lynis",
          noise: "A GRUB password guards the boot menu at the console.",
        },
      ],
    },
    {
      tool: "ssh-audit",
      version: "3.9.0",
      results: [
        {
          id: "ssh-audit-skipped",
          title: "ssh-audit ran",
          status: "skip",
          severity: "info",
          message: "Docker is not installed on this computer.",
          remediation: "Install Docker Desktop.",
          source: "ssh-audit",
        },
      ],
    },
  ];
}

describe("renderSecurityReport with the deeper checks", () => {
  it("adds the section per tool with its version, results and noise apart, and counts no noise", () => {
    const input = { ...fixedInput(), deep: deepRuns() };
    const report = renderSecurityReport(input);
    // Everything before the new section is today's report, apart from the summary row.
    const today = renderSecurityReport(fixedInput());
    expect(report.slice(0, report.indexOf("## Deeper checks"))).toBe(
      today
        .slice(0, today.indexOf("---\n"))
        .replace(
          "| Outside probes | 0 passed, 1 failed, 0 warnings, 0 skipped |",
          "| Outside probes | 0 passed, 1 failed, 0 warnings, 0 skipped |\n| Deeper checks | 1 passed, 0 failed, 0 warnings, 1 skipped |",
        ),
    );
    expect(securityProblems(input).some((p) => p.area === "Deeper checks")).toBe(false);
    expect(report).toContain("Docker is not installed on this computer. Install Docker Desktop.");
    expect(report.slice(report.indexOf("## Deeper checks"))).toMatchSnapshot();
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
