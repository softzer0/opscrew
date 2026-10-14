import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PUBLIC_KEY } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";

const MODULES = ["hetzner-vps", "digitalocean-droplet"] as const;
const template = MODULE_FILES["hetzner-vps/cloud-init.yaml.tftpl"] ?? "";

/**
 * Renders the template the way Terraform's `templatefile` does for this file: substitutes the
 * one variable and unescapes `$${` / `%%{`. Throws on any other interpolation or directive.
 */
function renderTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/(\$\$\{|%%\{|\$\{([^}]*)\}|%\{[^}]*\})/g, (match, _all, name) => {
    if (match === "$${") return "${";
    if (match === "%%{") return "%{";
    if (typeof name === "string" && name.trim() in vars) return vars[name.trim()] ?? "";
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

const rendered = renderTemplate(template, { ssh_public_key: PUBLIC_KEY });
const config = parse(rendered) as CloudConfig;
const file = (path: string) => config.write_files.find((f) => f.path === path);
const installer = file("/usr/local/sbin/opscrew-install-docker");
const script = installer?.content ?? "";

describe("cloud-init template", () => {
  it("renders to a cloud-config with the deploy key and no stray interpolation", () => {
    expect(rendered.startsWith("#cloud-config\n")).toBe(true);
    expect(config.users[0]?.ssh_authorized_keys).toEqual([PUBLIC_KEY]);
  });

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
      "/usr/local/sbin/opscrew-install-docker --check && touch /var/lib/opscrew-ready",
    ]);
    expect(rendered.match(/touch \/var\/lib\/opscrew-ready/g)).toHaveLength(1);
  });

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
});
