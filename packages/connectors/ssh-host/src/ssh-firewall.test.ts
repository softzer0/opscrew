/**
 * The SSH firewall's sources, files and scripts: sources in the form nft prints them, the rules
 * file and unit, and the step's real scripts in a real shell (nft and systemctl stubbed) for the
 * lockout guard, the idempotent check and the removal.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import { SHOP_REPOSITORY } from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { foreignNft } from "./firewall";
import { inspectHost } from "./inspect";
import { canonicalSshSource, networkHolds } from "./parse";
import { planRunnerHost } from "./plan";
import {
  SSH_FIREWALL_FUNCTIONS,
  SSH_FIREWALL_UNIT_TEXT,
  sshFirewallListing,
  sshFirewallRules,
  sshSources,
} from "./ssh-firewall";
import { armScript, type StepScripts, stepScripts } from "./steps";
import type { DesiredRunnerHost } from "./types";

describe("SSH sources", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["203.0.113.7/32", "203.0.113.7"],
    ["198.51.100.77/24", "198.51.100.0/24"],
    ["2001:DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8:0:0:1:0:0:1/128", "2001:db8::1:0:0:1"],
    ["2001:db8::/32", "2001:db8::/32"],
    ["2001:0db8:0000:0001:0000:0000:0000:0000/64", "2001:db8:0:1::/64"],
    // One zero group stays as it is; of two equal zero runs the first is shortened.
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:0:0:1:0:0:1:1", "2001::1:0:0:1:1"],
    ["fe80::1:2:3:4/64", "fe80::/64"],
  ])("%s is %s, as nft prints it", (text, printed) => {
    expect(canonicalSshSource(text)).toBe(printed);
  });

  it.each(["0.0.0.0/0", "::/0", "::1", "::ffff:198.51.100.20", "2001:db8::1%eth0", "1::2::3", "x"])(
    "refuses %s",
    (text) => {
      expect(canonicalSshSource(text)).toBeNull();
    },
  );

  it("are sorted, IPv4 first, without duplicates", () => {
    expect(
      sshSources(["2001:db8::/32", "203.0.113.7/32", "198.51.100.0/24", "203.0.113.7"]),
    ).toEqual(["198.51.100.0/24", "203.0.113.7", "2001:db8::/32"]);
  });

  it("hold an address in the network, of the same family only", () => {
    expect(networkHolds("198.51.100.0/25", "198.51.100.20")).toBe(true);
    expect(networkHolds("198.51.100.0/25", "198.51.100.200")).toBe(false);
    expect(networkHolds("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(networkHolds("2001:db8::/48", "2001:db8:0:ffff::9")).toBe(true);
    expect(networkHolds("2001:db8::/48", "2001:db8:1::9")).toBe(false);
    expect(networkHolds("2001:db8::/48", "198.51.100.20")).toBe(false);
  });
});

describe("the SSH firewall's files", () => {
  it("replace OpsCrew's table in one load, with SSH's ports from each source and the rest of them dropped", () => {
    expect(
      sshFirewallRules({ sources: ["198.51.100.0/24", "2001:db8::/32"], ports: [22, 2222] }),
    ).toBe(`#!/usr/sbin/nft -f
# Managed by OpsCrew: SSH (ports 22 and 2222) only from the sources you named.
# opscrew-ssh-firewall.service loads it at boot. It is OpsCrew's own table (inet opscrew);
# no other table, rule or default policy is touched. Turning the SSH firewall off deletes the
# table and this file.
add table inet opscrew
delete table inet opscrew
table inet opscrew {
\tchain input {
\t\ttype filter hook input priority 0; policy accept;
\t\tip saddr 198.51.100.0/24 tcp dport 22 accept
\t\tip6 saddr 2001:db8::/32 tcp dport 22 accept
\t\tip saddr 198.51.100.0/24 tcp dport 2222 accept
\t\tip6 saddr 2001:db8::/32 tcp dport 2222 accept
\t\ttcp dport 22 drop
\t\ttcp dport 2222 drop
\t}
}
`);
    expect(sshFirewallListing({ sources: ["203.0.113.7"], ports: [22] })).toBe(
      "table inet opscrew {|chain input {|type filter hook input priority filter; policy accept;|ip saddr 203.0.113.7 tcp dport 22 accept|tcp dport 22 drop|}|}|",
    );
  });

  it("load at boot through OpsCrew's own unit, again after the nftables service flushes them", () => {
    expect(SSH_FIREWALL_UNIT_TEXT).toContain(
      "ExecStart=/usr/sbin/nft -f /etc/opscrew/nftables-ssh.nft",
    );
    expect(SSH_FIREWALL_UNIT_TEXT).toContain(
      "PartOf=nftables.service\nReloadPropagatedFrom=nftables.service",
    );
    expect(SSH_FIREWALL_UNIT_TEXT).toContain("WantedBy=multi-user.target");
    expect(SSH_FIREWALL_UNIT_TEXT).not.toMatch(/flush|ExecStop/);
  });

  it("are OpsCrew's own table, which never counts as another firewall", () => {
    const listed = `table inet opscrew {
\tchain input {
\t\ttype filter hook input priority filter; policy accept;
\t\tip saddr 198.51.100.0/24 tcp dport 22 accept
\t\ttcp dport 22 drop
\t}
}`;
    expect(foreignNft(listed)).toEqual([]);
  });
});

/** The ssh-firewall step's scripts of a runner machine's plan with `harden`. */
async function firewallScripts(harden: DesiredRunnerHost["harden"]): Promise<StepScripts> {
  const fake = new FakeHost({ login: "ana" });
  if (harden?.firewall === undefined) {
    fake.sshFirewall = { table: "table inet opscrew {|}|", enabled: true };
  }
  const plan = planRunnerHost(
    await inspectHost(fake),
    { repositoryUrl: SHOP_REPOSITORY, runners: [], ...(harden ? { harden } : {}) },
    "opscrew runner host add home",
  );
  const step = plan.steps.find((item) => item.id === "ssh-firewall");
  if (step === undefined) throw new Error("no ssh-firewall step");
  return stepScripts(plan, step);
}

/** `nft list table inet opscrew` as nft 1.0 prints it, for `sources`. */
function listed(sources: readonly string[], priority = "filter"): string {
  return [
    "table inet opscrew {",
    "\tchain input {",
    `\t\ttype filter hook input priority ${priority}; policy accept;`,
    ...sources.map((s) => `\t\t${s.includes(":") ? "ip6" : "ip"} saddr ${s} tcp dport 22 accept`),
    "\t\ttcp dport 22 drop",
    "\t}",
    "}",
    "",
  ].join("\n");
}

const CONNECTION = (from: string) =>
  `SSH_CONNECTION='${from} 50022 192.168.1.20 22'\nexport SSH_CONNECTION\n`;

describe.skipIf(!BASH_AVAILABLE)(
  "the SSH firewall's scripts in a real shell (nft and systemctl stubbed)",
  () => {
    const SOURCES = ["198.51.100.0/24", "2001:db8::/32"];

    function harness(): ShellHarness {
      const h = new ShellHarness();
      // nft lists the table it was given in $S/table; `nft delete table` removes it.
      h.stub(
        "nft",
        `case "$1 $2" in
  "list table") [ -f "$S/table" ] || exit 1; cat "$S/table" ;;
  "delete table") rm -f "$S/table" ;;
esac`,
      );
      h.stub(
        "systemctl",
        `case "$1" in
  is-enabled) if [ -f "$S/enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) [ -f "$S/timer" ] || exit 3 ;;
  enable) touch "$S/enabled" ;;
  disable) rm -f "$S/enabled" ;;
  stop) rm -f "$S/timer" ;;
esac`,
      );
      h.stub("systemd-run", 'touch "$S/timer"');
      return h;
    }

    it("the automatic undo removes OpsCrew's table, or puts its earlier rules back", async () => {
      const scripts = await firewallScripts({ firewall: { sshFrom: SOURCES } });
      const deadMan = scripts.deadMan;
      if (deadMan === undefined) throw new Error("no automatic undo");
      expect(deadMan.step).toBe("ssh-firewall");
      const h = harness();
      try {
        // Nothing of OpsCrew's before: the undo removes what the apply put there.
        expect(h.run(armScript(deadMan, 180)).stdout).toBe("armed\n");
        h.run(`${CONNECTION("198.51.100.20")}${scripts.apply}`);
        h.write("/state/table", listed(SOURCES));
        h.clearCalls();
        expect(h.runFile("/etc/opscrew/deadman/ssh-firewall.undo.sh").status).toBe(0);
        expect(h.calls()).toEqual([
          "systemctl disable --quiet opscrew-ssh-firewall.service",
          "systemctl daemon-reload",
          "nft list table inet opscrew",
          "nft delete table inet opscrew",
        ]);
        expect(h.exists("/etc/opscrew/nftables-ssh.nft")).toBe(false);
        expect(h.exists("/etc/systemd/system/opscrew-ssh-firewall.service")).toBe(false);

        // OpsCrew's earlier rules: they come back and are loaded again.
        const earlier = sshFirewallRules({ sources: ["198.51.100.0/24"], ports: [22] });
        h.write("/etc/opscrew/nftables-ssh.nft", earlier);
        rmSync(h.native("/state/timer"));
        h.run(armScript(deadMan, 180));
        h.run(`${CONNECTION("198.51.100.20")}${scripts.apply}`);
        h.clearCalls();
        h.runFile("/etc/opscrew/deadman/ssh-firewall.undo.sh");
        expect(h.read("/etc/opscrew/nftables-ssh.nft")).toBe(earlier);
        expect(h.calls()).toEqual([`nft -f ${h.posix("/etc/opscrew/nftables-ssh.nft")}`]);
      } finally {
        h.dispose();
      }
    });

    it("refuses to turn the firewall on over a connection from another address, and changes nothing", async () => {
      const { apply } = await firewallScripts({ firewall: { sshFrom: SOURCES } });
      const h = harness();
      try {
        const run = h.run(`${CONNECTION("198.51.100.77")}${apply}`);
        expect(run.status).toBe(4);
        expect(run.stderr).toContain(
          "opscrew: OpsCrew now connects from 198.51.100.77, not from 198.51.100.20 as when the plan was made, so it did not turn the SSH firewall on.",
        );
        expect(h.exists("/etc/opscrew/nftables-ssh.nft")).toBe(false);
        expect(h.calls()).toEqual([]);
      } finally {
        h.dispose();
      }
    });

    it("writes the rules and the unit, and loads them through the unit, from the planned address", async () => {
      const { apply, check } = await firewallScripts({ firewall: { sshFrom: SOURCES } });
      const h = harness();
      try {
        const run = h.run(`${CONNECTION("198.51.100.20")}${apply}`);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(h.read("/etc/opscrew/nftables-ssh.nft")).toBe(
          sshFirewallRules({ sources: SOURCES, ports: [22] }),
        );
        expect(h.read("/etc/systemd/system/opscrew-ssh-firewall.service")).toBe(
          SSH_FIREWALL_UNIT_TEXT,
        );
        expect(h.calls()).toEqual([
          "systemctl daemon-reload",
          "systemctl enable --quiet opscrew-ssh-firewall.service",
          "systemctl restart opscrew-ssh-firewall.service",
        ]);
        // The check is read-only: before nft lists the table, a change.
        expect(h.run(check).stdout).toContain("prev.table=absent\nstate=change");
      } finally {
        h.dispose();
      }
    });

    it("is in place only when nft lists exactly the planned table, as new and old nft print it", async () => {
      const { apply, check, verify } = await firewallScripts({ firewall: { sshFrom: SOURCES } });
      const h = harness();
      try {
        h.run(`${CONNECTION("198.51.100.20")}${apply}`);
        // An automatic undo still waiting: a change.
        h.write("/state/timer", "");
        h.write("/state/table", listed(SOURCES));
        expect(h.run(check).stdout).toContain("state=change");
        rmSync(h.native("/state/timer"));
        for (const priority of ["filter", "0"]) {
          h.write("/state/table", listed(SOURCES, priority));
          expect(h.run(check).stdout, priority).toContain("prev.table=present\nstate=in-place");
          expect(h.run(verify).status).toBe(0);
        }
        // A rule more, or one source less, is a change.
        h.write("/state/table", listed([...SOURCES, "203.0.113.7"]));
        expect(h.run(check).stdout).toContain("state=change");
        h.write("/state/table", listed(SOURCES.slice(0, 1)));
        expect(h.run(check).stdout).toContain("state=change");
        const failed = h.run(verify);
        expect(failed.status).toBe(5);
        expect(failed.stderr).toContain("opscrew: OpsCrew's SSH firewall is not in effect.");
        // The unit turned off: a change too.
        h.write("/state/table", listed(SOURCES));
        rmSync(h.native("/state/enabled"));
        expect(h.run(check).stdout).toContain("state=change");
      } finally {
        h.dispose();
      }
    });

    it("removal deletes only OpsCrew's table, its unit and its rules file", async () => {
      const { apply, verify } = await firewallScripts(undefined);
      const h = harness();
      try {
        h.write("/state/table", listed(SOURCES));
        h.write("/state/enabled", "");
        h.write(
          "/etc/opscrew/nftables-ssh.nft",
          sshFirewallRules({ sources: SOURCES, ports: [22] }),
        );
        h.write("/etc/systemd/system/opscrew-ssh-firewall.service", SSH_FIREWALL_UNIT_TEXT);
        expect(h.run(verify).status).toBe(5);
        h.clearCalls();
        const run = h.run(apply);
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(h.calls()).toEqual([
          "systemctl disable --quiet opscrew-ssh-firewall.service",
          "systemctl daemon-reload",
          "nft list table inet opscrew",
          "nft delete table inet opscrew",
        ]);
        expect(h.exists("/etc/opscrew/nftables-ssh.nft")).toBe(false);
        expect(h.exists("/etc/systemd/system/opscrew-ssh-firewall.service")).toBe(false);
        expect(h.run(verify).status).toBe(0);
        // Again, with nothing left: nothing to delete.
        h.clearCalls();
        expect(h.run(apply).status).toBe(0);
        expect(h.calls()).toEqual(["nft list table inet opscrew"]);
      } finally {
        h.dispose();
      }
    });
  },
);

/** Linux's /proc (the walk reads each process's stat and initial environment). */
const PROC = existsSync("/proc/self/stat") && existsSync("/proc/self/environ");

describe.skipIf(!PROC)("ssh_connection", () => {
  it("reads SSH_CONNECTION from a parent process when sudo dropped it", () => {
    const inner = `${SSH_FIREWALL_FUNCTIONS}\nssh_connection`;
    // The outer shell keeps SSH_CONNECTION in its environment; the inner one runs without it.
    const run = spawnSync("sh", ["-c", 'env -u SSH_CONNECTION sh -c "$1"; true', "sh", inner], {
      encoding: "utf8",
      env: { ...process.env, SSH_CONNECTION: "203.0.113.9 50022 192.168.1.20 22" },
    });
    expect(run.stdout).toBe("203.0.113.9 50022 192.168.1.20 22\n");
    const own = spawnSync("sh", ["-c", inner], {
      encoding: "utf8",
      env: { ...process.env, SSH_CONNECTION: "2001:db8::9 50022 2001:db8::1 22" },
    });
    expect(own.stdout).toBe("2001:db8::9 50022 2001:db8::1 22\n");
  });
});
