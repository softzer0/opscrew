import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { detectEngines } from "@opscrew/iac-engine";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PUBLIC_KEY, testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { renderInfra } from "./index";

const MODULES = ["hetzner-vps", "digitalocean-droplet"] as const;

/**
 * The engines that render the template for real, with OPSCREW_IT=1 as the package's other engine
 * tests; each check skips without its binary.
 */
const runIt = process.env.OPSCREW_IT === "1";
const engines = runIt ? await detectEngines() : [];
if (!runIt) {
  console.warn("[iac-templates] skipping the cloud-init check with the engines: set OPSCREW_IT=1.");
}
for (const name of runIt ? ["tofu", "terraform"] : []) {
  if (!engines.some((d) => d.name === name && d.supported)) {
    console.warn(
      `[iac-templates] skipping the cloud-init check with ${name}: no usable ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
    );
  }
}
const template = MODULE_FILES["hetzner-vps/cloud-init.yaml.tftpl"] ?? "";

/**
 * Renders the template the way Terraform's `templatefile` does for this file: keeps or drops the
 * lines of each whole-line `%{ if <bool> ~}` … `%{ endif ~}`, substitutes the string variables
 * and unescapes `$${` / `%%{`. Throws on any other interpolation or directive.
 */
function renderTemplate(source: string, vars: Record<string, string | boolean>): string {
  const kept = source.replace(
    /^%\{ if (\w+) ~\}\n([\s\S]*?)^%\{ endif ~\}\n/gm,
    (_match, name: string, body: string) => {
      if (typeof vars[name] !== "boolean") throw new Error(`no boolean ${name}`);
      return vars[name] ? body : "";
    },
  );
  return kept.replace(/(\$\$\{|%%\{|\$\{([^}]*)\}|%\{[^}]*\})/g, (match, _all, name) => {
    if (match === "$${") return "${";
    if (match === "%%{") return "%{";
    const value = typeof name === "string" ? vars[name.trim()] : undefined;
    if (typeof value === "string") return value;
    throw new Error(`unexpected template expression ${match}`);
  });
}

interface WriteFile {
  path: string;
  permissions?: string;
  content: string;
}
interface CloudConfig {
  packages: string[];
  write_files: WriteFile[];
  runcmd: (string | string[])[];
  users: { name: string; ssh_authorized_keys: string[] }[];
}

const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/10-opscrew.conf";

/**
 * research.md R8 on OpsCrew's own servers: ssh-audit's Ubuntu 24.04 guide without GSSAPI, exactly
 * as the lead read it from ssh-audit.com (the user-key types too: only `deploy` logs in, with
 * OpsCrew's ED25519 key), the two host keys, and the filtered moduli through ModuliFile.
 */
const R8_LINES = [
  "KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group18-sha512,diffie-hellman-group-exchange-sha256,diffie-hellman-group16-sha512",
  "Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-gcm@openssh.com,aes128-ctr",
  "MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com",
  "RequiredRSASize 3072",
  "HostKey /etc/ssh/ssh_host_ed25519_key",
  "HostKey /etc/ssh/ssh_host_rsa_key",
  "HostKeyAlgorithms sk-ssh-ed25519-cert-v01@openssh.com,ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256",
  "CASignatureAlgorithms sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256",
  "HostbasedAcceptedAlgorithms sk-ssh-ed25519-cert-v01@openssh.com,ssh-ed25519-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-512,rsa-sha2-256-cert-v01@openssh.com,rsa-sha2-256",
  "PubkeyAcceptedAlgorithms sk-ssh-ed25519-cert-v01@openssh.com,ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256",
  "ModuliFile /etc/ssh/moduli.opscrew",
];
const MODULI_COMMAND = "sh -c awk '$5 >= 3071' /etc/ssh/moduli > /etc/ssh/moduli.opscrew";
const SSHD_CHECK_COMMAND = `sh -c install -d -m 0755 /run/sshd && sshd -t || rm -f ${SSHD_DROP_IN}`;

/** Why the Docker check of the SSH settings is skipped, or undefined when it runs. */
const dockerSkip = ((): string | undefined => {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
})();
if (dockerSkip)
  console.warn(`[iac-templates] skipping the sshd check on ubuntu:24.04: ${dockerSkip}`);

/**
 * Runs in ubuntu:24.04 with the drop-in at /t: installs openssh-server, runs cloud-init's own
 * moduli and sshd -t commands, starts sshd on port 2222, and prints what a modern client, an old
 * client (NIST key exchange only) and ssh-keyscan see.
 */
function sshdCheckScript(): string {
  const command = (line: string) => line.replace(/^sh -c /, "");
  return `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends openssh-server openssh-client >/dev/null
useradd --create-home --shell /bin/bash deploy
install -m 0644 /t/10-opscrew.conf ${SSHD_DROP_IN}
${command(MODULI_COMMAND)}
${command(SSHD_CHECK_COMMAND)}
test -f ${SSHD_DROP_IN} && echo "sshd -t: ok"
echo "weak moduli: $(awk '!($5 >= 3071)' /etc/ssh/moduli.opscrew | wc -l)"
dpkg --verify openssh-server | grep -q /etc/ssh/moduli || echo "moduli conffile: unchanged"
/usr/sbin/sshd -p 2222
ssh-keygen -q -t ed25519 -N '' -f /root/id
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
install -m 0600 -o deploy -g deploy /root/id.pub /home/deploy/.ssh/authorized_keys
login() { ssh -i /root/id -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/known_hosts -p 2222 "$@" deploy@127.0.0.1 true; }
login && echo "modern client: ok"
login -o KexAlgorithms=diffie-hellman-group-exchange-sha256 && echo "group exchange: ok"
if login -o KexAlgorithms=ecdh-sha2-nistp256 2>/dev/null; then echo "old client: accepted"; else echo "old client: refused"; fi
echo "host keys: $(ssh-keyscan -p 2222 127.0.0.1 2>/dev/null | awk '{ print $2 }' | sort | tr '\\n' ' ' | sed 's/ $//')"
`;
}

const VARS = { ssh_public_key: PUBLIC_KEY, check_key_entry: "", web: true };
const rendered = renderTemplate(template, VARS);
const config = parse(rendered) as CloudConfig;
const WEB_RULES = ["ufw allow 80/tcp", "ufw allow 443/tcp", "ufw allow 443/udp"];
const file = (path: string) => config.write_files.find((f) => f.path === path);
const installer = file("/usr/local/sbin/opscrew-install-docker");
const script = installer?.content ?? "";

describe("cloud-init template", () => {
  it("renders to a cloud-config with the deploy key and no stray interpolation", () => {
    expect(rendered.startsWith("#cloud-config\n")).toBe(true);
    expect(config.users[0]?.ssh_authorized_keys).toEqual([PUBLIC_KEY]);
  });

  it("adds the scheduled check's line, restricted to df, after the deploy key", () => {
    const line = `restrict,command="df -P -B1 /" ${PUBLIC_KEY.split(" ").slice(0, 2).join(" ")} opscrew-check:acme/shop`;
    // As main.tf builds it: a second list item, quoted by jsonencode.
    const entry = `\n      - ${JSON.stringify(line)}`;
    const withCheck = renderTemplate(template, { ...VARS, check_key_entry: entry });
    expect((parse(withCheck) as CloudConfig).users[0]?.ssh_authorized_keys).toEqual([
      PUBLIC_KEY,
      line,
    ]);
    // Only that line differs.
    expect(withCheck.replace(entry, "")).toBe(rendered);
    for (const module of MODULES) {
      expect(MODULE_FILES[`${module}/main.tf`]).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL's interpolation, not JavaScript's.
        'check_key_entry = var.check_key_line == "" ? "" : "\\n      - ${jsonencode(var.check_key_line)}"',
      );
      expect(MODULE_FILES[`${module}/variables.tf`]).toMatch(
        /variable "check_key_line" \{[^}]*default {5}= ""/,
      );
    }
  });

  it("allows the web's ports in ufw only on a server that serves the web", () => {
    const commands = (text: string) =>
      (parse(text) as CloudConfig).runcmd.map((c) => (Array.isArray(c) ? c.join(" ") : c));
    expect(commands(rendered)).toEqual(expect.arrayContaining(WEB_RULES));
    const withoutWeb = renderTemplate(template, { ...VARS, web: false });
    const rest = commands(withoutWeb);
    for (const rule of WEB_RULES) expect(rest).not.toContain(rule);
    // Only those lines differ: SSH stays allowed and ufw is still enabled.
    expect(rest).toEqual(commands(rendered).filter((c) => !WEB_RULES.includes(c)));
    for (const module of MODULES) {
      expect(MODULE_FILES[`${module}/main.tf`]).toMatch(/^ {4}web {13}= var\.web$/m);
      expect(MODULE_FILES[`${module}/variables.tf`]).toMatch(
        /variable "web" \{[^}]*type {8}= bool\n {2}default {5}= true/,
      );
    }
  });

  for (const name of ["tofu", "terraform"] as const) {
    const engine = engines.find((d) => d.name === name && d.supported);
    it.skipIf(!engine)(
      `renders as ${name}'s templatefile does, with and without the web`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), `opscrew-cloud-init-${name}-`));
        try {
          writeFileSync(join(dir, "t.tftpl"), template);
          for (const web of [true, false]) {
            const result = await new NodeCommandRunner().run(engine?.binary ?? name, ["console"], {
              cwd: dir,
              input: `base64encode(templatefile("t.tftpl", { ssh_public_key = ${JSON.stringify(PUBLIC_KEY)}, check_key_entry = "", web = ${web} }))\n`,
            });
            expect(result.exitCode, result.stderr).toBe(0);
            const base64 = /"([A-Za-z0-9+/=]+)"/.exec(result.stdout)?.[1] ?? "";
            expect(Buffer.from(base64, "base64").toString("utf8")).toBe(
              renderTemplate(template, { ...VARS, web }),
            );
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }

  it("never installs the distribution's Docker packages", () => {
    expect(config.packages).not.toContain("docker.io");
    expect(config.packages).not.toContain("docker-compose-v2");
    expect(rendered).not.toMatch(/docker\.io\b(?!\/)/);
    expect(rendered).not.toContain("docker-compose-v2");
    expect(rendered).not.toContain("get.docker.com");
  });

  it("keeps the rest of the first-boot setup", () => {
    expect(config.packages).toEqual(
      expect.arrayContaining(["fail2ban", "unattended-upgrades", "ufw", "curl", "ca-certificates"]),
    );
    for (const path of [
      "/etc/ssh/sshd_config.d/10-opscrew.conf",
      "/etc/fail2ban/jail.d/opscrew.local",
      "/etc/docker/daemon.json",
      "/etc/apt/apt.conf.d/20auto-upgrades",
    ]) {
      expect(file(path), path).toBeDefined();
    }
    const commands = config.runcmd.map((c) => (Array.isArray(c) ? c.join(" ") : c));
    expect(commands).toEqual(
      expect.arrayContaining([
        "usermod -aG docker deploy",
        "ufw --force enable",
        "systemctl enable --now docker fail2ban unattended-upgrades",
        "systemctl restart ssh",
      ]),
    );
  });

  it("adds Docker's apt repository for the release and architecture with Docker's key", () => {
    expect(installer?.permissions).toBe("0755");
    expect(script.startsWith("#!/bin/sh\nset -eu\n")).toBe(true);
    expect(script).toContain("install -m 0755 -d /etc/apt/keyrings");
    expect(script).toContain(
      "curl -fsSL --retry 5 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    );
    expect(script).toContain("chmod a+r /etc/apt/keyrings/docker.asc");
    const source =
      /cat > \/etc\/apt\/sources\.list\.d\/docker\.sources <<EOF\n([\s\S]*?)\nEOF/.exec(
        script,
      )?.[1];
    expect(source).toBe(
      [
        "Types: deb",
        "URIs: https://download.docker.com/linux/ubuntu",
        "Suites: $codename",
        "Components: stable",
        "Architectures: $arch",
        "Signed-By: /etc/apt/keyrings/docker.asc",
      ].join("\n"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test.
    expect(script).toContain('codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"');
    expect(script).toContain('arch="$(dpkg --print-architecture)"');
  });

  it("installs Docker Engine and its plugins from that repository and requires 28 or newer", () => {
    expect(script).toMatch(
      /apt-get [^\n]*install -y docker-ce docker-ce-cli containerd\.io docker-buildx-plugin docker-compose-plugin\n/,
    );
    expect(script).toContain('docker version --format "{{.Server.Version}}"');
    expect(script).toMatch(/-lt 28 \]/);
    expect(script).toContain("docker compose version");
  });

  it("installs Docker first and marks the server ready only when the install succeeded", () => {
    const first = config.runcmd[0];
    expect(first).toEqual(["/usr/local/sbin/opscrew-install-docker"]);
    const last = config.runcmd.at(-1);
    expect(last).toEqual([
      "sh",
      "-c",
      "/usr/local/sbin/opscrew-install-docker --check && test -f /etc/ssh/sshd_config.d/10-opscrew.conf && touch /var/lib/opscrew-ready",
    ]);
    expect(rendered.match(/touch \/var\/lib\/opscrew-ready/g)).toHaveLength(1);
  });

  it("prepares what a GitHub Actions runner needs from root on every server: its libraries, deploy's lingering and /srv/runners", () => {
    // What the runner's bin/installdependencies.sh (v2.338.0) installs on Ubuntu 24.04.
    expect(config.packages).toEqual(
      expect.arrayContaining(["libicu74", "libkrb5-3", "liblttng-ust1t64", "libssl3t64", "zlib1g"]),
    );
    const commands = config.runcmd.map((c) => (Array.isArray(c) ? c.join(" ") : c));
    // Docker, then deploy in its group, then lingering: the user manager lingering starts then
    // has the docker group (it keeps the groups it started with).
    const order = [
      "/usr/local/sbin/opscrew-install-docker",
      "usermod -aG docker deploy",
      "loginctl enable-linger deploy",
    ].map((command) => commands.indexOf(command));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(commands).toContain(
      "install -d -m 0750 -o deploy -g deploy /srv/edge /srv/apps /srv/data /srv/runners",
    );
    // deploy gets no sudo, and the runner itself is never installed here.
    expect(rendered).not.toMatch(/sudo|actions-runner/);
  });

  it("matches its snapshot", () => {
    expect(rendered).toMatchSnapshot();
  });

  it("hardens SSH to R8's algorithms with only the ED25519 and RSA host keys", () => {
    const lines = (file(SSHD_DROP_IN)?.content ?? "").trimEnd().split("\n");
    expect(lines.slice(0, 6)).toEqual([
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin no",
      "MaxAuthTries 3",
      "X11Forwarding no",
      "AllowUsers deploy",
    ]);
    expect(lines.slice(6)).toEqual(R8_LINES);
    expect(lines.join("\n")).not.toContain("ecdsa");
    // Host keys are never regenerated: their fingerprints, pinned by OpsCrew, stay.
    expect(rendered).not.toContain("ssh-keygen");
    expect(rendered).not.toContain("ssh_host_ecdsa");
  });

  it("writes the filtered moduli copy and lets sshd -t pass the settings before SSH restarts", () => {
    const commands = config.runcmd.map((c) => (Array.isArray(c) ? c.join(" ") : c));
    const moduli = commands.indexOf(MODULI_COMMAND);
    const check = commands.indexOf(SSHD_CHECK_COMMAND);
    const restart = commands.indexOf("systemctl restart ssh");
    expect(moduli).toBeGreaterThan(-1);
    // /etc/ssh/moduli is an openssh-server conffile: only read, never written.
    expect(rendered).not.toMatch(/(>|mv [^\n]*) \/etc\/ssh\/moduli(?!\.opscrew)/);
    expect(check).toBeGreaterThan(moduli);
    expect(restart).toBeGreaterThan(check);
  });

  it.skipIf(dockerSkip !== undefined)(
    "passes sshd -t on ubuntu:24.04 and accepts a modern client, offering no ECDSA host key",
    { timeout: 300_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "opscrew-sshd-"));
      const name = `opscrew-sshd-test-${randomBytes(4).toString("hex")}`;
      try {
        writeFileSync(join(dir, "10-opscrew.conf"), file(SSHD_DROP_IN)?.content ?? "");
        writeFileSync(join(dir, "check.sh"), sshdCheckScript());
        const run = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            name,
            "--label",
            "opscrew-test=sshd",
            "-v",
            `${dir}:/t:ro`,
            "ubuntu:24.04",
            "sh",
            "/t/check.sh",
          ],
          { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
        );
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain("sshd -t: ok");
        expect(run.stdout).toContain("modern client: ok");
        expect(run.stdout).toContain("old client: refused");
        expect(run.stdout).toMatch(/host keys: ssh-ed25519 ssh-rsa\n/);
        expect(run.stdout).toContain("weak moduli: 0");
        expect(run.stdout).toContain("moduli conffile: unchanged");
        expect(run.stdout).toContain("group exchange: ok");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(spawnSync("sh", ["-c", "true"]).status !== 0)("installer is valid POSIX sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "opscrew-cloud-init-"));
    try {
      const path = join(dir, "install.sh");
      writeFileSync(path, script);
      const result = spawnSync("sh", ["-n", path], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(MODULES)("%s module", (module) => {
  it("uses the shared template and never rebuilds an existing server for it", () => {
    expect(MODULE_FILES[`${module}/cloud-init.yaml.tftpl`]).toBe(template);
    const main = MODULE_FILES[`${module}/main.tf`] ?? "";
    expect(main).toMatch(/ignore_changes = \[[^\]]*\buser_data\b/);
  });

  it("renders the same server, its user_data included, with and without the server's runner", () => {
    const without = testPlan({ provider: module === "hetzner-vps" ? "hetzner" : "digitalocean" });
    const withRunner = DeployPlanSchema.parse({ ...without, environment: { runner: "server" } });
    const ctx = testContext({ cloudflare: testCloudflare() });
    const files = renderInfra(without, ctx);
    expect(files.map((f) => f.path)).toContain(
      `opscrew/infra/modules/${module}/cloud-init.yaml.tftpl`,
    );
    expect(renderInfra(withRunner, ctx)).toEqual(files);
  });
});
