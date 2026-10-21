/**
 * The sshd drop-in OpsCrew writes on a server the user owns, checked by a real OpenSSH: in an
 * `ubuntu:24.04` container with `openssh-server`, each drop-in passes `sshd -t`, and a modern
 * client logs in. With an ECDSA host key pinned, the ECDSA host key is still offered and a client
 * that knows only that key logs in. ECDSA and RSA-2048 user keys still work, an RSA-2048 host key
 * is still offered, and sshd reads the filtered moduli through ModuliFile. It pulls the image and
 * installs packages, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULI_FILTER, SSHD_MODULI, SSHD_MODULI_FILE, sshdDropIn } from "./constants";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[connector-ssh-host] skipping the sshd check on ubuntu:24.04: ${reason}`);

const login = { permitRootLogin: "no", disablePasswords: true, kbdInteractiveOff: true };

/** Starts sshd with `/t/<variant>.conf` on `port` and prints what clients see. */
function variant(name: string, port: number): string {
  return `install -m 0644 /t/${name}.conf /etc/ssh/sshd_config.d/10-opscrew.conf
sshd -t && echo "${name} sshd -t: ok"
/usr/sbin/sshd -p ${port}
ssh -i /root/id -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/kh-${name} -p ${port} deploy@127.0.0.1 true && echo "${name} modern client: ok"
ssh -i /root/id-ecdsa -o BatchMode=yes -o UserKnownHostsFile=/root/kh-${name} -p ${port} deploy@127.0.0.1 true && echo "${name} ECDSA user key: ok"
ssh -i /root/id -o BatchMode=yes -o UserKnownHostsFile=/root/kh-${name} -o KexAlgorithms=diffie-hellman-group-exchange-sha256 -p ${port} deploy@127.0.0.1 true && echo "${name} group exchange: ok"
ssh -i /root/id-rsa2048 -o BatchMode=yes -o UserKnownHostsFile=/root/kh-${name} -p ${port} other@127.0.0.1 true && echo "${name} RSA-2048 user key: ok"
echo "${name} host keys: $(ssh-keyscan -p ${port} 127.0.0.1 2>/dev/null | awk '{ print $2 }' | sort | tr '\\n' ' ' | sed 's/ $//')"
ssh-keyscan -t rsa -p ${port} 127.0.0.1 > /root/rsa-${name} 2>/dev/null || true
ssh -i /root/id -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/rsa-${name} -p ${port} deploy@127.0.0.1 true && echo "${name} RSA-2048-pinned client: ok"
ssh-keyscan -t ecdsa -p ${port} 127.0.0.1 > /root/pinned-${name} 2>/dev/null || true
if [ -s /root/pinned-${name} ] && ssh -i /root/id -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/pinned-${name} -p ${port} deploy@127.0.0.1 true; then echo "${name} ECDSA-pinned client: ok"; else echo "${name} ECDSA-pinned client: refused"; fi
pkill -f "sshd -p ${port}" || true`;
}

const SCRIPT = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends openssh-server openssh-client procps >/dev/null
useradd --create-home --shell /bin/bash deploy
install -d -m 0755 /run/sshd
ssh-keygen -q -t ed25519 -N '' -f /root/id
ssh-keygen -q -t ecdsa -N '' -f /root/id-ecdsa
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
cat /root/id.pub /root/id-ecdsa.pub > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys
# Another account with an RSA-2048 key, and a server whose RSA host key has 2048 bits.
useradd --create-home --shell /bin/bash other
ssh-keygen -q -t rsa -b 2048 -N '' -f /root/id-rsa2048
install -d -m 0700 -o other -g other /home/other/.ssh
install -m 0600 -o other -g other /root/id-rsa2048.pub /home/other/.ssh/authorized_keys
rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub
ssh-keygen -q -t rsa -b 2048 -N '' -f /etc/ssh/ssh_host_rsa_key
awk '${MODULI_FILTER}' ${SSHD_MODULI} > ${SSHD_MODULI_FILE}
echo "weak moduli: $(awk '!(${MODULI_FILTER})' ${SSHD_MODULI_FILE} | wc -l)"
${variant("modern", 2222)}
${variant("ecdsa", 2223)}
`;

describe.skipIf(reason !== undefined)("the sshd drop-in on ubuntu:24.04", () => {
  it("passes sshd -t, accepts a modern client, and keeps a pinned ECDSA key working", {
    timeout: 300_000,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "opscrew-sshd-"));
    try {
      writeFileSync(join(dir, "modern.conf"), sshdDropIn({ ...login, moduliFile: true }));
      writeFileSync(
        join(dir, "ecdsa.conf"),
        sshdDropIn({
          ...login,
          moduliFile: true,
          ecdsaHostKey: "ecdsa-sha2-nistp256",
        }),
      );
      writeFileSync(join(dir, "check.sh"), SCRIPT);
      const run = spawnSync(
        "docker",
        [
          "run",
          "--rm",
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
      const out = run.stdout;
      expect(run.status, `${out}\n${run.stderr}`).toBe(0);
      expect(out).toContain("weak moduli: 0");
      expect(out).toContain("modern sshd -t: ok");
      // Other accounts' ECDSA keys keep working, and DH group exchange reads the filtered copy.
      expect(out).toContain("modern ECDSA user key: ok");
      expect(out).toContain("modern group exchange: ok");
      // No RequiredRSASize on a server the user owns: RSA-2048 user and host keys keep working.
      expect(out).toContain("modern RSA-2048 user key: ok");
      expect(out).toContain("modern RSA-2048-pinned client: ok");
      expect(out).toContain("ecdsa RSA-2048 user key: ok");
      expect(out).toContain("modern modern client: ok");
      expect(out).toMatch(/modern host keys: ssh-ed25519 ssh-rsa\n/);
      expect(out).toContain("modern ECDSA-pinned client: refused");
      expect(out).toContain("ecdsa sshd -t: ok");
      expect(out).toContain("ecdsa modern client: ok");
      expect(out).toMatch(/ecdsa host keys: ecdsa-sha2-nistp256 ssh-ed25519 ssh-rsa\n/);
      expect(out).toContain("ecdsa ECDSA-pinned client: ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
