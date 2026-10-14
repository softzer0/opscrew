import { describe, expect, it } from "vitest";
import { FakeHost, type OsPreset } from "./__fixtures__/fake-host";
import { desiredFor, planFor } from "./__fixtures__/helpers";
import { inspectHost, inspectScript } from "./inspect";
import { planHost } from "./plan";

const SUPPORTED: OsPreset[] = [
  "ubuntu-22.04",
  "ubuntu-24.04",
  "ubuntu-26.04",
  "debian-12",
  "debian-13",
];

describe("inspectHost", () => {
  for (const os of SUPPORTED) {
    for (const arch of ["amd64", "arm64"] as const) {
      it(`reads a fresh ${os} ${arch} server and plans every step as a change`, async () => {
        const fake = new FakeHost({ os, arch });
        const facts = await inspectHost(fake);
        expect(facts.os.id).toBe(os.split("-")[0]);
        expect(facts.os.versionId).toBe(os.split("-")[1]);
        expect(facts.arch).toBe(arch);
        expect(facts.privilege).toBe("root");
        expect(facts.sshd?.ports).toEqual([22]);
        expect(facts.docker.kind).toBe("absent");
        const plan = planHost(facts, desiredFor(fake));
        expect(plan.findings).toEqual([]);
        expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
          ["docker", "change"],
          ["docker-daemon", "change"],
          ["deploy-user", "change"],
          ["sshd", "change"],
          ["ufw", "change"],
          ["fail2ban", "change"],
          ["unattended-upgrades", "change"],
          ["runtime-dirs", "change"],
          ["app-marker", "change"],
        ]);
        expect(plan.steps[0]?.params).toEqual({ distro: os.split("-")[0], action: "install" });
      });
    }
  }

  it("runs only read-only commands: the privilege probe and the inspection script", async () => {
    const fake = new FakeHost({ login: "admin", sudo: "nopasswd" });
    await inspectHost(fake);
    expect(fake.names()).toEqual(["privilege", "inspect"]);
    // The inspection runs as root through sudo -n; the probe runs as the login.
    expect(fake.calls.map((call) => call.sudo)).toEqual([false, true]);
  });

  it("uses no command that changes the server", () => {
    const script = inspectScript();
    const mutating = [
      /\bapt(-get)?\s+(install|remove|purge|update)/,
      /\b(useradd|usermod|userdel|groupadd|chown|chmod|mkdir|install\s+-|rm\s|mv\s|cp\s|tee\s|touch\s)/,
      /\bsystemctl\s+(start|stop|restart|reload|enable|disable|try-reload)/,
      /\bufw\s+(allow|deny|enable|disable|delete|default|--force)/,
      /\bsystemd-run\b/,
      /\bdocker\s+(run|rm|compose\s+(up|down)|stop|volume\s+rm)/,
      /\bsed\s+-i/,
    ];
    for (const pattern of mutating) expect(script).not.toMatch(pattern);
    // Output goes only to stdout and /dev/null.
    expect(script.match(/>\s*(\S+)/g)?.filter((r) => !/\/dev\/null|&2|&1/.test(r)) ?? []).toEqual(
      [],
    );
  });

  it("reports the server's own addresses, without container bridges", async () => {
    const fake = new FakeHost();
    const facts = await inspectHost(fake);
    expect(facts.addresses).toEqual([
      { interface: "eth0", family: "ipv4", address: "192.168.1.20", public: false },
    ]);
  });

  it("reports the sudo login's own name, not root", async () => {
    const fake = new FakeHost({ login: "alice", sudo: "nopasswd" });
    const facts = await inspectHost(fake);
    expect(facts.user).toBe("alice");
    expect(facts.privilege).toBe("sudo");
    const plan = planHost(facts, desiredFor(fake));
    expect(plan.findings).toEqual([]);
    expect(plan.steps.find((step) => step.id === "sshd")?.params.permitRootLogin).toBe("no");
  });

  it("refuses with a plain finding when sudo needs a password, without running sudo scripts", async () => {
    const fake = new FakeHost({ login: "alice", sudo: "password" });
    const plan = await planFor(fake);
    expect(plan.findings.map((finding) => finding.code)).toEqual(["sudo-needs-password"]);
    expect(plan.findings[0]?.hint).toContain("NOPASSWD");
    expect(plan.steps.every((step) => step.state === "blocked")).toBe(true);
    expect(fake.calls.every((call) => !call.sudo)).toBe(true);
  });

  it("refuses a login that cannot become root", async () => {
    const fake = new FakeHost({ login: "alice", sudo: "none" });
    const plan = await planFor(fake);
    expect(plan.findings.map((finding) => finding.code)).toEqual(["no-root-access"]);
  });

  it.each([
    ["ubuntu-20.04", "amd64", "unsupported-os"],
    ["linuxmint-22", "amd64", "unsupported-os"],
    ["debian-12", "armhf", "unsupported-arch"],
  ] as const)("refuses %s on %s with %s", async (os, arch, code) => {
    const fake = new FakeHost({ os, arch });
    const plan = await planFor(fake);
    expect(plan.findings.map((finding) => finding.code)).toEqual([code]);
    expect(plan.findings[0]?.message).toMatch(/does not support|architecture/);
    expect(plan.steps.every((step) => step.state === "blocked")).toBe(true);
  });

  it("refuses a server without systemd", async () => {
    const fake = new FakeHost();
    fake.systemd = false;
    const plan = await planFor(fake);
    expect(plan.findings.map((finding) => finding.code)).toEqual(["no-systemd"]);
  });

  it("reads Docker from Docker's repository with its version and plugins", async () => {
    const fake = new FakeHost();
    fake.packages.set("docker-ce", "5:27.3.1-1~ubuntu.24.04~noble");
    fake.packages.set("docker-compose-plugin", "2.29.7");
    fake.dockerRunning = true;
    const facts = await inspectHost(fake);
    expect(facts.docker).toMatchObject({
      kind: "docker-repo",
      version: "27.3.1",
      running: true,
      composePlugin: true,
      buildxPlugin: false,
    });
  });
});
