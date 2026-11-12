/**
 * The SFTP connector against a real OpenSSH SFTP-only host: an `alpine:3.24` container whose user
 * is chrooted with `ForceCommand internal-sftp` (no shell), reached with the system's `sftp` and a
 * pinned host key. It uploads a release and switches `current` between two releases many times
 * while a reader in the container looks at `current` all along: the reader must never find it
 * missing. It pulls the image and installs packages, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { SftpFiles } from "./files";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  for (const tool of ["sftp", "ssh-keygen", "ssh-keyscan"]) {
    if (spawnSync(tool, ["-?"], { encoding: "utf8" }).error !== undefined) return `no ${tool} here`;
  }
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[connector-sftp] skipping the SFTP-only host on alpine: ${reason}`);

/** The host: OpenSSH with one chrooted, SFTP-only user whose key is outside the chroot. */
const SETUP = `set -eu
apk add --no-cache openssh-server >/dev/null
ssh-keygen -A >/dev/null
adduser -D -h /home/web web
sed -i 's/^web:!/web:*/' /etc/shadow
install -d -m 0755 -o root -g root /srv/sftp/web
install -d -m 0755 -o web -g web /srv/sftp/web/home/web
install -d -m 0755 /etc/ssh/keys
install -m 0644 /t/id.pub /etc/ssh/keys/web
cat > /etc/ssh/sshd_config <<'CONF'
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthorizedKeysFile /etc/ssh/keys/%u
Subsystem sftp internal-sftp
Match User web
  ChrootDirectory /srv/sftp/%u
  ForceCommand internal-sftp -d /home/%u
  AllowTcpForwarding no
  X11Forwarding no
CONF
exec /usr/sbin/sshd -D -e
`;

/** Looks at the app's `current` until /tmp/stop appears; says how often, and each time it was missing. */
const READER = `n=0
while [ ! -f /tmp/stop ]; do
  [ -e /srv/sftp/web/home/web/app/current/index.html ] || echo missing >> /tmp/reader.log
  n=$((n + 1))
done
echo "reads $n" >> /tmp/reader.log
`;

const docker = (...args: string[]) =>
  spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });

/** A ustar archive of folders and files, as OpsCrew's `tarStream` writes one. */
function tar(entries: { name: string; dir?: boolean; text?: string; link?: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write(`${(entry.dir === true ? 0o755 : 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(entry.dir === true ? "5" : entry.link !== undefined ? "2" : "0", 156);
    if (entry.link !== undefined) header.write(entry.link, 157, 100);
    header.write("ustar\u000000", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

describe.skipIf(reason !== undefined)("an OpenSSH SFTP-only host (alpine)", () => {
  it("takes an upload, and switches current in one step while a reader never sees it missing", {
    timeout: 300_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "opscrew-sftp-docker-"));
    const name = `opscrew-test-sftp-${process.pid}-${Date.now()}`;
    try {
      const key = join(dir, "id");
      expect(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status).toBe(0);
      writeFileSync(join(dir, "setup.sh"), SETUP);
      writeFileSync(join(dir, "reader.sh"), READER);
      const started = docker(
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "opscrew-test=sftp",
        "-p",
        "127.0.0.1::22",
        "-v",
        `${dir}:/t:ro`,
        "alpine:3.24",
        "sh",
        "/t/setup.sh",
      );
      expect(started.status, started.stderr).toBe(0);
      const port = Number(docker("port", name, "22").stdout.trim().split(":").pop());
      let knownHosts = "";
      for (let i = 0; i < 60 && knownHosts === ""; i++) {
        knownHosts = spawnSync("ssh-keyscan", ["-p", String(port), "127.0.0.1"], {
          encoding: "utf8",
        }).stdout;
        if (knownHosts === "") await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      expect(knownHosts, docker("logs", name).stderr).not.toBe("");
      writeFileSync(join(dir, "known_hosts"), knownHosts);
      const files = new SftpFiles(
        {
          host: "127.0.0.1",
          port,
          user: "web",
          keyFile: key,
          knownHostsFile: join(dir, "known_hosts"),
        },
        { runner: new NodeCommandRunner() },
      );

      // The app's folder with two releases and current, in one archive; a settings file.
      await files.uploadTar(
        "app",
        tar([
          { name: "releases/", dir: true },
          { name: "releases/1-1/", dir: true },
          { name: "releases/1-1/index.html", text: "one" },
          { name: "releases/2-1/", dir: true },
          { name: "releases/2-1/index.html", text: "two" },
          { name: "releases/2-1/a b/", dir: true },
          { name: "releases/2-1/a b/x*y [1].txt", text: "odd" },
          { name: "current", link: "releases/1-1" },
        ]),
      );
      await files.writeFile("app/state", new TextEncoder().encode("running=1-1\n"), 0o600);
      expect(await files.readFile("app/state")).toBe("running=1-1\n");
      expect(await files.readFile("app/none")).toBeUndefined();
      expect(await files.list("app")).toEqual(["current", "releases", "state"]);
      expect(
        docker("exec", name, "stat", "-c", "%a", "/srv/sftp/web/home/web/app/state").stdout.trim(),
      ).toBe("600");

      // The switch, many times over, while the reader looks.
      expect(docker("exec", "-d", name, "sh", "/t/reader.sh").status).toBe(0);
      for (let i = 0; i < 10; i++) {
        await files.link("app/current", "releases/2-1");
        await files.link("app/current", "releases/1-1");
      }
      await files.link("app/current", "releases/2-1");
      docker("exec", name, "touch", "/tmp/stop");
      let log = "";
      for (let i = 0; i < 20 && !log.includes("reads"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        log = docker("exec", name, "cat", "/tmp/reader.log").stdout;
      }
      expect(log).toMatch(/^reads \d+\n$/);
      expect(Number(/reads (\d+)/.exec(log)?.[1])).toBeGreaterThan(100);
      expect(
        docker("exec", name, "readlink", "/srv/sftp/web/home/web/app/current").stdout.trim(),
      ).toBe("releases/2-1");
      // No temporary link or file is left beside them.
      expect(await files.list("app")).toEqual(["current", "releases", "state"]);

      // A release removed with everything in it; the running one and its link stay.
      await files.remove("app/releases/1-1");
      await files.remove("app/current");
      expect(await files.list("app/releases")).toEqual(["2-1"]);
      await files.remove("app");
      expect(await files.list(".")).toEqual([]);
    } finally {
      docker("rm", "-f", name);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
