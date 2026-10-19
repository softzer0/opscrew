import { createHash } from "node:crypto";
import { rmSync, symlinkSync } from "node:fs";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost, type OsPreset } from "./__fixtures__/fake-host";
import { desiredFor, planFor, provision } from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { dockerFirewall, inspectHost, inspectScript, RUNTIME_FILES_SNIPPET } from "./inspect";
import { parseAppRecords, parseDirs, parseRuntimeFiles, splitSections } from "./parse";
import { planHost } from "./plan";
import { appRecord } from "./steps";

const appRecordFor = (app: string) =>
  appRecord({
    app,
    projectId: `${app}-1`,
    access: "public",
    hostnames: [],
    services: ["web"],
    memoryMb: 512,
    deployKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE opscrew-deploy",
  });

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
        const plan = planHost(facts, desiredFor(fake), "opscrew provision");
        expect(plan.findings).toEqual([]);
        expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
          ["docker", "change"],
          ["docker-daemon", "change"],
          ["deploy-user", "change"],
          ["deploy-key", "change"],
          ["sshd", "change"],
          ["ufw", "change"],
          ["fail2ban", "change"],
          ["unattended-upgrades", "change"],
          ["runtime-dirs", "change"],
          ["app-dirs", "change"],
          ["app-record", "change"],
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
    const plan = planHost(facts, desiredFor(fake), "opscrew provision");
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

describe("inspectHost: OpsCrew's runtime files in each app's folder", () => {
  it("reads checksums of the rendered files and only presence and mode of the others", async () => {
    const fake = new FakeHost();
    await provision(fake);
    deployApp(fake, "shop");
    const facts = await inspectHost(fake);
    const sum = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    expect(facts.runtimeFiles).toEqual([
      {
        app: "shop",
        name: "compose.yaml",
        kind: "file",
        owner: "deploy",
        group: "deploy",
        mode: "644",
        sha256: sum(fake.appFiles.get("shop")?.get("compose.yaml")?.content ?? ""),
      },
      { app: "shop", name: "Caddyfile", kind: "absent", sha256: null },
      {
        app: "shop",
        name: ".env",
        kind: "file",
        owner: "deploy",
        group: "deploy",
        mode: "644",
        sha256: null,
      },
      {
        app: "shop",
        name: "app.env",
        kind: "file",
        owner: "deploy",
        group: "deploy",
        mode: "600",
        sha256: null,
      },
      { app: "shop", name: "db.env", kind: "absent", sha256: null },
    ]);
  });

  it("reports no file on a fresh server", async () => {
    const facts = await inspectHost(new FakeHost());
    expect(facts.runtimeFiles).toEqual([]);
  });

  it.skipIf(!BASH_AVAILABLE)(
    "prints no file content and no checksum of a file that holds secrets (real shell)",
    () => {
      const sh = new ShellHarness();
      try {
        const secret = fakeSecret("generic-password", "app-env");
        sh.write("/srv/apps/shop/compose.yaml", "services: {}\n");
        sh.write("/srv/apps/shop/Caddyfile", ":80 {\n}\n");
        sh.write("/srv/apps/shop/app.env", `SECRET_KEY=${secret}\n`);
        sh.write("/srv/apps/shop/db.env", `POSTGRES_PASSWORD=${secret}\n`);
        sh.write("/srv/apps/blog/compose.yaml", "services: {}\n");
        sh.write("/srv/apps/Not An App/compose.yaml", "services: {}\n");
        const result = sh.run(RUNTIME_FILES_SNIPPET);
        expect(result.status).toBe(0);
        const files = parseRuntimeFiles(result.stdout);
        expect(new Set(files.map((file) => file.app))).toEqual(new Set(["blog", "shop"]));
        const byName = new Map(
          files.filter((file) => file.app === "shop").map((file) => [file.name, file]),
        );
        const sum = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
        expect(byName.get("compose.yaml")).toMatchObject({
          kind: "file",
          sha256: sum("services: {}\n"),
        });
        expect(byName.get("Caddyfile")?.sha256).toBe(sum(":80 {\n}\n"));
        expect(byName.get("app.env")).toMatchObject({ kind: "file", sha256: null });
        expect(byName.get("db.env")).toMatchObject({ kind: "file", sha256: null });
        expect(byName.get(".env")).toEqual({
          app: "shop",
          name: ".env",
          kind: "absent",
          sha256: null,
        });
        // Nothing about the secret files beyond their owner and mode reaches OpsCrew.
        expect(result.stdout).not.toContain(secret);
        expect(result.stdout).not.toContain(sum(`SECRET_KEY=${secret}\n`));
        expect(result.stdout).not.toContain(sum(`POSTGRES_PASSWORD=${secret}\n`));
        expect(result.stdout.match(/\b[0-9a-f]{64}\b/g)).toHaveLength(3);
      } finally {
        sh.dispose();
      }
    },
  );

  it.skipIf(!BASH_AVAILABLE)(
    "reads nothing through an app folder that is a symbolic link or not a directory (real shell)",
    () => {
      const sh = new ShellHarness();
      try {
        sh.write("/srv/apps/shop", "not a directory\n");
        const result = sh.run(RUNTIME_FILES_SNIPPET);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("");

        rmSync(sh.native("/srv/apps/shop"));
        sh.write("/srv/elsewhere/compose.yaml", "services: {}\n");
        let linked = true;
        try {
          symlinkSync(sh.native("/srv/elsewhere"), sh.native("/srv/apps/shop"), "junction");
        } catch {
          linked = false; // this machine cannot create links
        }
        if (linked && sh.run('[ -L "/srv/apps/shop" ]').status === 0) {
          expect(sh.run(RUNTIME_FILES_SNIPPET).stdout.trim()).toBe("");
        }
      } finally {
        sh.dispose();
      }
    },
  );

  it("keeps no checksum for a secret file and never follows links", () => {
    const hash = "a".repeat(64);
    expect(
      parseRuntimeFiles(
        [
          `shop app.env file deploy deploy 600 ${hash}`,
          "shop compose.yaml link",
          `shop Caddyfile file root root 644 ${hash}`,
          "shop unknown.txt file root root 644 -",
          "Bad compose.yaml link",
        ].join("\n"),
      ),
    ).toEqual([
      { app: "shop", name: "compose.yaml", kind: "link", sha256: null },
      {
        app: "shop",
        name: "Caddyfile",
        kind: "file",
        owner: "root",
        group: "root",
        mode: "644",
        sha256: hash,
      },
      { app: "shop", name: ".env", kind: "absent", sha256: null },
      {
        app: "shop",
        name: "app.env",
        kind: "file",
        owner: "deploy",
        group: "deploy",
        mode: "600",
        sha256: null,
      },
      { app: "shop", name: "db.env", kind: "absent", sha256: null },
    ]);
    expect(RUNTIME_FILES_SNIPPET).toMatch(/if \[ -L "\$p" \]; then echo "\$app \$f link"/);
  });
});

describe("inspectHost: the apps' records and folders (real shell)", () => {
  it.skipIf(!BASH_AVAILABLE)(
    "prints each app's record on one line, and only folders with app names",
    () => {
      const sh = new ShellHarness();
      try {
        const record = { ...appRecordFor("shop"), hostnames: ["shop.example.com"] };
        sh.write("/etc/opscrew/apps/shop.json", `${JSON.stringify(record, null, 2)}\n`);
        sh.write("/etc/opscrew/apps/blog.json", "{");
        sh.write("/etc/opscrew/apps/notes.txt", "not a record\n");
        sh.write("/srv/apps/shop/compose.yaml", "services: {}\n");
        sh.write("/srv/data/shop/PG_VERSION", "17\n");
        sh.write("/srv/data/Bad Name/x", "\n");
        // The harness moves the paths under its root; the server prints them as they are.
        const sections = splitSections(sh.run(inspectScript()).stdout.replaceAll(sh.root, ""));
        expect(parseAppRecords(sections.get("apps")?.text ?? "")).toEqual([
          { name: "blog", record: null },
          { name: "shop", record },
        ]);
        expect(
          parseDirs(sections.get("dirs")?.text ?? "").map((dir) => [dir.path, dir.kind]),
        ).toEqual([
          ["/srv/edge", "absent"],
          ["/srv/apps", "dir"],
          ["/srv/data", "dir"],
          ["/srv/app", "absent"],
          ["/srv/apps/shop", "dir"],
          ["/srv/data/shop", "dir"],
        ]);
      } finally {
        sh.dispose();
      }
    },
  );
});

describe("dockerFirewall", () => {
  const none = { text: "", exit: 1 };
  const json = (text: string) => ({ text, exit: 0 });
  it("is iptables by default", () => {
    expect(dockerFirewall({ daemonJson: none, execStart: "", info: "" })).toEqual({
      backend: "iptables",
    });
    expect(
      dockerFirewall({ daemonJson: none, execStart: "", info: '{"Driver":"iptables"}' }),
    ).toEqual({ backend: "iptables" });
  });

  it("sees the nftables backend in daemon.json, the flags or docker info", () => {
    for (const input of [
      { daemonJson: json('{ "firewall-backend": "nftables" }'), execStart: "", info: "" },
      { daemonJson: none, execStart: "/usr/bin/dockerd --firewall-backend=nftables", info: "" },
      { daemonJson: none, execStart: "", info: '{"Driver":"nftables"}' },
    ]) {
      expect(dockerFirewall(input).backend).toBe("nftables");
    }
  });

  it("sees iptables turned off, and the nftables backend in the unit's environment", () => {
    expect(
      dockerFirewall({ daemonJson: json('{ "iptables": false }'), execStart: "", info: "" })
        .backend,
    ).toBe("off");
    expect(
      dockerFirewall({ daemonJson: none, execStart: "dockerd --iptables=false", info: "" }).backend,
    ).toBe("off");
    expect(
      dockerFirewall({
        daemonJson: none,
        execStart:
          "ExecStart={ argv[]=/usr/bin/dockerd }\nEnvironment=DOCKER_FIREWALL_BACKEND=nftables",
        info: "",
      }).backend,
    ).toBe("nftables");
    // ip6tables does not matter: the filter mode publishes on IPv4 only.
    expect(
      dockerFirewall({ daemonJson: json('{ "ip6tables": false }'), execStart: "", info: "" }),
    ).toEqual({ backend: "iptables" });
  });

  it("reads OpsCrew's web filter on a fresh server as absent", async () => {
    const facts = await inspectHost(new FakeHost());
    expect(facts.webFilter).toMatchObject({
      backend: "iptables",
      files: { script: null, unit: null, dropIn: null },
      enabled: false,
      active: false,
      rules4: { chain: null },
    });
  });
});
