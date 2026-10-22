/**
 * The SSH firewall's real scripts against a real nft: in an `ubuntu:24.04` container with
 * NET_ADMIN, run through `sudo -n` (which drops SSH_CONNECTION, so the scripts find OpsCrew's
 * connection through /proc), under the automatic undo with the real flock. The step loads
 * OpsCrew's table for sshd's port, its check and verify find it in place, loading it again adds
 * no second copy, a user's own table stays, another address is refused, the unit passes
 * `systemd-analyze verify`, and the inspection reads the connection, sshd's Port and ListenAddress
 * ports and the table. The undo removes the table when it fires; the removal deletes only
 * OpsCrew's table. systemctl and systemd-run are stand-ins (no init runs in the container): the
 * unit's restart runs its ExecStart, and a timer is a file. It pulls the image and installs
 * packages, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import { SHOP_REPOSITORY } from "./__fixtures__/helpers";
import { factsFromOutput, inspectHost, inspectScript } from "./inspect";
import { planRunnerHost } from "./plan";
import { sshFirewallFileHashes, sshFirewallListing } from "./ssh-firewall";
import { armScript, cancelScript, stepScripts, triggerScript } from "./steps";
import type { HostPlan } from "./types";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[connector-ssh-host] skipping the nft check on ubuntu:24.04: ${reason}`);

const SOURCES = ["198.51.100.0/24", "2001:db8::/32"];
const FROM = "198.51.100.20 50022 10.0.0.2 2222";

async function firewallPlan(fake: FakeHost, sshFrom?: string[]): Promise<HostPlan> {
  return planRunnerHost(
    await inspectHost(fake),
    {
      repositoryUrl: SHOP_REPOSITORY,
      runners: [],
      ...(sshFrom ? { harden: { firewall: { sshFrom } } } : {}),
    },
    "opscrew runner host add home",
  );
}

function scriptsOf(plan: HostPlan) {
  const step = plan.steps.find((item) => item.id === "ssh-firewall");
  if (step === undefined) throw new Error("no ssh-firewall step");
  return stepScripts(plan, step);
}

const SCRIPT = `set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends nftables sudo systemd openssh-server >/dev/null 2>&1
cat > /usr/local/sbin/systemctl <<'STUB'
#!/bin/sh
[ "$1" = --quiet ] && shift
case "$1" in
  restart) /usr/sbin/nft -f /etc/opscrew/nftables-ssh.nft ;;
  enable) touch /run/opscrew-enabled ;;
  disable) rm -f /run/opscrew-enabled ;;
  is-enabled) if [ -e /run/opscrew-enabled ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) case "$2" in --quiet) unit=$3 ;; *) unit=$2 ;; esac; [ -e "/run/$unit" ] || exit 3 ;;
  stop) rm -f "/run/$2" ;;
esac
STUB
cat > /usr/local/bin/systemd-run <<'STUB'
#!/bin/sh
for a do case "$a" in --unit=*) touch "/run/\${a#--unit=}.timer" ;; esac; done
STUB
chmod 0755 /usr/local/sbin/systemctl /usr/local/bin/systemd-run
# sshd's settings as inspection reads them: Port 2222, and a ListenAddress with its own port.
ssh-keygen -A >/dev/null
install -d -m 0755 /run/sshd
printf 'Port 2222\\nListenAddress 0.0.0.0:2200\\n' > /etc/ssh/sshd_config.d/50-test.conf
# The user's own table, which OpsCrew leaves alone.
nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority 0; policy accept; }'
nft add rule inet filter input tcp dport 80 accept
export SSH_CONNECTION='${FROM}'
echo "check: $(sudo -n sh /t/check.sh | grep '^state=')"
sudo -n sh /t/arm.sh
sudo -n sh /t/apply.sh && echo "apply: ok"
echo "cancel: $(sudo -n sh /t/cancel.sh)"
sudo -n sh /t/verify.sh && echo "verify: ok"
echo "check again: $(sudo -n sh /t/check.sh | grep '^state=')"
sudo -n sh /t/apply.sh && echo "apply again: ok"
echo "port-2222 rules: $(nft list table inet opscrew | grep -c 'dport 2222')"
nft list table inet filter | grep -q 'tcp dport 80 accept' && echo "user table: kept"
SSH_CONNECTION='203.0.113.9 50022 10.0.0.2 2222' sudo -n sh /t/apply.sh 2>/tmp/other; echo "other address: $?"
grep -o 'OpsCrew now connects from [^,]*' /tmp/other
systemd-analyze verify /etc/systemd/system/opscrew-ssh-firewall.service && echo "unit: ok"
echo "@@inspect"
sudo -n sh /t/inspect.sh
echo "@@end"
sudo -n sh /t/remove-apply.sh && echo "remove: ok"
sudo -n sh /t/remove-verify.sh && echo "removed: ok"
echo "tables: $(nft list tables | tr '\\n' ' ')"
# No working login after the change: the undo fires and the table goes again.
sudo -n sh /t/arm.sh >/dev/null
sudo -n sh /t/apply.sh && echo "applied again: $(nft list tables | grep -c opscrew)"
echo "trigger: $(sudo -n sh /t/trigger.sh)"
echo "after the undo: $(nft list tables | tr '\\n' ' ')"
[ ! -e /etc/opscrew/nftables-ssh.nft ] && [ ! -e /etc/systemd/system/opscrew-ssh-firewall.service ] && echo "undo files: gone"
`;

describe.skipIf(reason !== undefined)("the SSH firewall on ubuntu:24.04 with nft", () => {
  it("loads OpsCrew's table once for sshd's port, from the planned address only, under the automatic undo", {
    timeout: 300_000,
  }, async () => {
    const fake = new FakeHost({ login: "ana" });
    fake.sshdBase.port = [2222];
    fake.sshClient = { address: "198.51.100.20", port: 2222 };
    const setup = scriptsOf(await firewallPlan(fake, SOURCES));
    const deadMan = setup.deadMan;
    if (deadMan === undefined) throw new Error("no automatic undo");
    fake.sshFirewall = { table: "present", enabled: true };
    const removal = scriptsOf(await firewallPlan(fake));
    const dir = mkdtempSync(join(tmpdir(), "opscrew-nft-"));
    try {
      writeFileSync(join(dir, "check.sh"), setup.check);
      writeFileSync(join(dir, "apply.sh"), setup.apply);
      writeFileSync(join(dir, "verify.sh"), setup.verify);
      writeFileSync(join(dir, "arm.sh"), armScript(deadMan, 180));
      writeFileSync(join(dir, "cancel.sh"), cancelScript(deadMan.step));
      writeFileSync(join(dir, "trigger.sh"), triggerScript(deadMan.step));
      writeFileSync(join(dir, "remove-apply.sh"), removal.apply);
      writeFileSync(join(dir, "remove-verify.sh"), removal.verify);
      writeFileSync(join(dir, "inspect.sh"), inspectScript());
      writeFileSync(join(dir, "run.sh"), SCRIPT);
      const run = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--label",
          "opscrew-test=ssh-firewall",
          "--cap-add",
          "NET_ADMIN",
          "-v",
          `${dir}:/t:ro`,
          "ubuntu:24.04",
          "sh",
          "/t/run.sh",
        ],
        { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      );
      const out = run.stdout;
      expect(run.status, `${out}\n${run.stderr}`).toBe(0);
      expect(out).toContain("check: state=change");
      expect(out).toContain("apply: ok");
      expect(out).toContain("cancel: cancelled");
      expect(out).toContain("verify: ok");
      expect(out).toContain("check again: state=in-place");
      expect(out).toContain("apply again: ok");
      expect(out).toContain("port-2222 rules: 3");
      expect(out).toContain("user table: kept");
      expect(out).toContain("other address: 4");
      expect(out).toContain("OpsCrew now connects from 203.0.113.9");
      expect(out).toContain("unit: ok");
      expect(out).toContain("remove: ok");
      expect(out).toContain("removed: ok");
      expect(out).toMatch(/tables: table inet filter \n/);
      expect(out).toContain("applied again: 1");
      expect(out).toContain("trigger: restored");
      expect(out).toMatch(/after the undo: table inet filter \n/);
      expect(out).toContain("undo files: gone");

      // The inspection reads the connection through sudo, sshd's ports, and the table.
      const inspection = out.slice(out.indexOf("@@inspect\n") + 10, out.indexOf("@@end"));
      const facts = factsFromOutput(inspection, "root");
      expect(facts.sshClient).toEqual({ address: "198.51.100.20", port: 2222 });
      expect(facts.sshd).toMatchObject({ ports: [2222], listenPorts: [2200] });
      const planned = { sources: SOURCES, ports: [2222] };
      expect(facts.sshFirewall).toEqual({
        nft: true,
        table: sshFirewallListing(planned),
        files: sshFirewallFileHashes(planned),
        enabled: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
