import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  cloudServer,
  provision,
  SH_AVAILABLE,
  shSyntax,
  wireguardKeys,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { DEAD_MAN_DIR } from "./constants";
import { inspectHost } from "./inspect";
import type { NetworkStepParams } from "./network";
import { planNetwork, planPublicSsh } from "./plan";
import {
  type PublicSshParams,
  PublicSshParamsSchema,
  publicSshFields,
  publicSshRules,
} from "./public-ssh";
import { asRoot, pipedScript } from "./shell";
import { armScript, stepScripts } from "./steps";
import type { HostPlan, HostStep } from "./types";

const COMMAND = "opscrew secure --close-public-ssh";
const ANYWHERE = ["0.0.0.0/0", "::/0"];

function closing(overrides: Partial<PublicSshParams> = {}): PublicSshParams {
  return {
    open: false,
    interface: "wg-opscrew0",
    allowedCidrs: [],
    sshPort: 22,
    cloudServer: false,
    ...overrides,
  };
}

function opening(overrides: Partial<PublicSshParams> = {}): PublicSshParams {
  return closing({ open: true, allowedCidrs: ANYWHERE, ...overrides });
}

function scriptsOf(params: PublicSshParams) {
  const step: HostStep = {
    id: "public-ssh",
    title: "Public SSH",
    state: "change",
    scope: "shared",
    params: publicSshFields(params),
  };
  const plan: HostPlan = {
    schemaVersion: 1,
    purpose: "setup",
    app: "shop",
    steps: [step],
    findings: [],
  };
  return stepScripts(plan, step);
}

describe("the public SSH step's parameters", () => {
  it("give the ufw rules: from anywhere as one rule, otherwise one per source", () => {
    expect(publicSshRules(opening())).toEqual(["22/tcp"]);
    expect(
      publicSshRules(opening({ allowedCidrs: ["203.0.113.0/24", "2001:db8::/32"], sshPort: 2222 })),
    ).toEqual([
      "from 2001:db8::/32 to any port 2222 proto tcp",
      "from 203.0.113.0/24 to any port 2222 proto tcp",
    ]);
    expect(publicSshRules(opening({ allowedCidrs: ["0.0.0.0/0"] }))).toEqual([
      "from 0.0.0.0/0 to any port 22 proto tcp",
    ]);
    expect(publicSshRules(closing({ allowedCidrs: ANYWHERE }))).toEqual([]);
  });

  it("refuse opening to no one, a source that is not canonical, and a bad interface or port", () => {
    for (const params of [
      opening({ allowedCidrs: [] }),
      opening({ allowedCidrs: ["203.0.113.7/24"] }),
      opening({ allowedCidrs: ["example.com"] }),
      closing({ interface: "eth0" }),
      closing({ sshPort: 0 }),
    ]) {
      expect(PublicSshParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(false);
    }
  });
});

describe("the public SSH step's scripts", () => {
  it("match their snapshot (closing, closing on a cloud server, opening) and run under the dead-man switch", () => {
    const sets = {
      close: scriptsOf(closing()),
      "close on a cloud server": scriptsOf(closing({ cloudServer: true })),
      open: scriptsOf(opening({ allowedCidrs: ["203.0.113.0/24", "2001:db8::/32"] })),
    };
    const all: Record<string, string> = {};
    for (const [name, set] of Object.entries(sets)) {
      expect(set.deadMan?.step, name).toBe("ufw");
      if (set.deadMan === undefined) throw new Error("no dead-man switch");
      Object.assign(all, {
        [`${name} check`]: set.check,
        [`${name} apply`]: set.apply,
        [`${name} verify`]: set.verify,
        [`${name} arm`]: armScript(set.deadMan, 180),
      });
    }
    expect(all).toMatchSnapshot();
    for (const [name, script] of Object.entries(all)) {
      for (const command of [script, asRoot("sudo", script), pipedScript(script)]) {
        const syntax = shSyntax(command);
        if (syntax !== undefined) expect(syntax.ok, `${name}: ${syntax.stderr}`).toBe(true);
      }
    }
  });
});

describe.skipIf(!SH_AVAILABLE)("the public SSH step in a real shell (commands stubbed)", () => {
  /** ufw over a file of `ufw show added` lines; a rule without a comment is kept without one. */
  const UFW = `f="$S/ufw"
touch "$f"
case "$1" in
  status) if [ -e "$S/ufw-active" ]; then echo 'Status: active'; else echo 'Status: inactive'; fi ;;
  show) echo "Added user rules (see 'ufw status' for running firewall):"; cat "$f" ;;
  allow)
    shift
    rule=''
    comment=''
    while [ $# -gt 0 ]; do
      if [ "$1" = comment ]; then comment=$2; shift 2; else rule="$rule $1"; shift; fi
    done
    if [ -n "$comment" ]; then echo "ufw allow$rule comment '$comment'" >> "$f"; else echo "ufw allow$rule" >> "$f"; fi ;;
  --force)
    shift 3
    rule="ufw allow $*"
    { grep -v -x -F "$rule" "$f" | grep -v -F "$rule comment '"; } > "$f.new" || true
    mv "$f.new" "$f" ;;
esac`;
  /** The dead-man timer is active once systemd-run scheduled it. */
  const SYSTEMCTL = `case "$1" in is-active) [ -e "$S/timer" ] ;; *) exit 0 ;; esac`;
  const NETWORK_RULE =
    "ufw allow in on wg-opscrew0 to any port 22 proto tcp comment 'opscrew-network-ssh'";
  const USER_RULE = "ufw allow 8080/tcp";

  function harness(rules: string[]): ShellHarness {
    const h = new ShellHarness();
    h.stub("ufw", UFW);
    h.stub("systemctl", SYSTEMCTL);
    h.stub("systemd-run", `touch "$S/timer"`);
    h.write("/state/ufw-active", "");
    h.write("/state/ufw", `${rules.join("\n")}\n`);
    return h;
  }
  const rules = (h: ShellHarness) => (h.read("/state/ufw") ?? "").split("\n").filter(Boolean);

  it("closing removes OpsCrew's public rules for the port and keeps the interface's and yours", () => {
    const h = harness([
      "ufw allow 22/tcp comment 'opscrew-ssh'",
      "ufw allow from 203.0.113.0/24 to any port 22 proto tcp comment 'opscrew-ssh'",
      NETWORK_RULE,
      USER_RULE,
    ]);
    try {
      const scripts = scriptsOf(closing());
      expect(h.run(scripts.check).stdout).toContain("state=change");
      const run = h.run(scripts.apply);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(rules(h)).toEqual([NETWORK_RULE, USER_RULE]);
      expect(h.calls().filter((call) => call.startsWith("ufw --force"))).toEqual([
        "ufw --force delete allow 22/tcp",
        "ufw --force delete allow from 203.0.113.0/24 to any port 22 proto tcp",
      ]);
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");
    } finally {
      h.dispose();
    }
  });

  it("closing on a server OpsCrew created also removes cloud-init's uncommented rule", () => {
    const h = harness(["ufw allow 22/tcp", NETWORK_RULE]);
    try {
      expect(h.run(scriptsOf(closing()).check).stdout).toContain("state=in-place");
      const scripts = scriptsOf(closing({ cloudServer: true }));
      expect(h.run(scripts.check).stdout).toContain("state=change");
      expect(h.run(scripts.apply).status).toBe(0);
      expect(rules(h)).toEqual([NETWORK_RULE]);
      expect(h.run(scripts.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("refuses to close without SSH on the interface, or with ufw off, changing nothing", () => {
    const before = ["ufw allow 22/tcp comment 'opscrew-ssh'"];
    const h = harness(before);
    try {
      const scripts = scriptsOf(closing());
      const run = h.run(scripts.apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(
        "SSH is not open on the private network's interface wg-opscrew0",
      );
      expect(rules(h)).toEqual(before);
      h.write("/state/ufw", `${[...before, NETWORK_RULE].join("\n")}\n`);
      h.run(`rm -f '${h.root}/state/ufw-active'`);
      const off = h.run(scripts.apply);
      expect(off.status).not.toBe(0);
      expect(off.stderr).toContain("ufw is off");
      expect(rules(h)).toEqual([...before, NETWORK_RULE]);
    } finally {
      h.dispose();
    }
  });

  it("opening adds the allowed sources first, then removes OpsCrew's other public rules", () => {
    const h = harness([
      NETWORK_RULE,
      "ufw allow from 198.51.100.0/24 to any port 22 proto tcp comment 'opscrew-ssh'",
    ]);
    try {
      const scripts = scriptsOf(opening({ allowedCidrs: ["203.0.113.0/24", "2001:db8::/32"] }));
      expect(h.run(scripts.check).stdout).toContain("state=change");
      expect(h.run(scripts.apply).status).toBe(0);
      expect(h.calls().filter((call) => /^ufw (allow|--force)/.test(call))).toEqual([
        "ufw allow from 2001:db8::/32 to any port 22 proto tcp comment opscrew-ssh",
        "ufw allow from 203.0.113.0/24 to any port 22 proto tcp comment opscrew-ssh",
        "ufw --force delete allow from 198.51.100.0/24 to any port 22 proto tcp",
      ]);
      expect(h.run(scripts.verify).status).toBe(0);
      // From anywhere: one rule for the port.
      const anywhere = scriptsOf(opening());
      expect(h.run(anywhere.apply).status).toBe(0);
      expect(rules(h)).toEqual([NETWORK_RULE, "ufw allow 22/tcp comment 'opscrew-ssh'"]);
      expect(h.run(anywhere.check).stdout).toContain("state=in-place");
    } finally {
      h.dispose();
    }
  });

  it("the dead-man switch's undo puts the rules back as they were", () => {
    const before = ["ufw allow 22/tcp", NETWORK_RULE, "ufw allow 22/tcp comment 'opscrew-ssh'"];
    const h = harness(before);
    try {
      const scripts = scriptsOf(closing({ cloudServer: true }));
      if (scripts.deadMan === undefined) throw new Error("no dead-man switch");
      expect(h.run(armScript(scripts.deadMan, 180)).status).toBe(0);
      expect(h.run(scripts.apply).status).toBe(0);
      expect(rules(h)).toEqual([NETWORK_RULE]);
      const undo = h.runFile(`${DEAD_MAN_DIR}/ufw.undo.sh`);
      expect(undo.status).toBe(0);
      expect([...rules(h)].sort()).toEqual([...before].sort());
      h.run(`rm -f '${h.root}/state/timer'`);

      // Opening: the undo removes what it added and puts back what it removed.
      const opened = [
        "ufw allow from 198.51.100.0/24 to any port 22 proto tcp comment 'opscrew-ssh'",
      ];
      h.write("/state/ufw", `${[NETWORK_RULE, ...opened].join("\n")}\n`);
      const open = scriptsOf(opening({ allowedCidrs: ["203.0.113.0/24"] }));
      if (open.deadMan === undefined) throw new Error("no dead-man switch");
      expect(h.run(armScript(open.deadMan, 180)).status).toBe(0);
      expect(h.run(open.apply).status).toBe(0);
      expect(rules(h)).toEqual([
        NETWORK_RULE,
        "ufw allow from 203.0.113.0/24 to any port 22 proto tcp comment 'opscrew-ssh'",
      ]);
      expect(h.runFile(`${DEAD_MAN_DIR}/ufw.undo.sh`).status).toBe(0);
      expect(rules(h)).toEqual([NETWORK_RULE, ...opened]);
    } finally {
      h.dispose();
    }
  });
});

describe("planning public SSH", () => {
  /** A server the user owns, set up by OpsCrew (ufw with OpsCrew's 22/tcp) and on the network. */
  async function server(): Promise<FakeHost> {
    const fake = new FakeHost();
    await provision(fake);
    const network: NetworkStepParams = {
      interface: "wg-opscrew0",
      address: "10.200.4.1/24",
      port: 51820,
      publicKey: wireguardKeys("app").publicKey,
      peers: [],
      otherInterfaces: [],
      sshPort: 22,
      localPorts: [],
    };
    await applyApproved(fake, planNetwork(await inspectHost(fake), { app: "shop", network }, "x"), {
      secrets: { wireguardKey: wireguardKeys("app").privateKey },
    });
    return fake;
  }

  it("closes under the dead-man switch, then plans in place; opening reverses it", async () => {
    const fake = await server();
    const plan = planPublicSsh(
      await inspectHost(fake),
      { app: "shop", publicSsh: closing() },
      COMMAND,
    );
    expect(plan.steps).toMatchObject([
      {
        id: "public-ssh",
        state: "change",
        scope: "shared",
        title: "Close public SSH (port 22): SSH answers only on the private network (wg-opscrew0)",
        params: {
          open: false,
          interface: "wg-opscrew0",
          allowedCidrs: "",
          sshPort: 22,
          cloudServer: false,
        },
      },
    ]);
    const start = fake.calls.length;
    await applyApproved(fake, plan, { command: COMMAND });
    const names = fake.calls.slice(start).map((call) => call.name);
    expect(names.filter((name) => name.startsWith("deadman."))).toEqual([
      "deadman.arm.ufw",
      "deadman.cancel.ufw",
    ]);
    expect(fake.ufwRules.some((rule) => rule.comment === "opscrew-ssh")).toBe(false);
    expect(
      planPublicSsh(await inspectHost(fake), { app: "shop", publicSsh: closing() }, COMMAND)
        .steps[0]?.state,
    ).toBe("in-place");

    const open = planPublicSsh(
      await inspectHost(fake),
      { app: "shop", publicSsh: opening() },
      COMMAND,
    );
    expect(open.steps[0]).toMatchObject({
      state: "change",
      title: "Open SSH (port 22) to 0.0.0.0/0 and ::/0 again",
    });
    await applyApproved(fake, open, { command: COMMAND });
    expect(fake.ufwRules).toContainEqual({ rule: "allow 22/tcp", comment: "opscrew-ssh" });
  });

  it("puts the rules back when new logins fail after closing", async () => {
    const fake = await server();
    const before = fake.ufwRules.map((rule) => ({ ...rule }));
    const plan = planPublicSsh(
      await inspectHost(fake),
      { app: "shop", publicSsh: closing() },
      COMMAND,
    );
    await expect(
      applyApproved(fake, plan, { command: COMMAND, verifyLogin: async () => false }),
    ).rejects.toThrow(/put the previous firewall settings back/);
    expect(fake.ufwRules).toEqual(before);
  });

  it("is a change while ufw is off, and its apply refuses to close, changing nothing", async () => {
    const fake = await server();
    await applyApproved(
      fake,
      planPublicSsh(await inspectHost(fake), { app: "shop", publicSsh: closing() }, COMMAND),
      { command: COMMAND },
    );
    fake.ufwActive = false;
    const rules = fake.ufwRules.map((rule) => ({ ...rule }));
    const plan = planPublicSsh(
      await inspectHost(fake),
      { app: "shop", publicSsh: closing() },
      COMMAND,
    );
    expect(plan.steps[0]?.state).toBe("change");
    await expect(applyApproved(fake, plan, { command: COMMAND })).rejects.toThrow(
      "ufw is off on this server, so closing public SSH in it would change nothing.",
    );
    expect(fake.ufwRules).toEqual(rules);
  });

  it("is planned as a change on a server OpsCrew created whose rules were not read as root", async () => {
    const fake = cloudServer();
    fake.dockerAccess = true;
    const plan = planPublicSsh(
      await inspectHost(fake),
      { app: "shop", publicSsh: closing({ cloudServer: true }) },
      COMMAND,
    );
    expect(plan.findings).toEqual([]);
    expect(plan.steps[0]).toMatchObject({ state: "change", params: { cloudServer: true } });
    expect(plan.steps[0]?.reason).toContain("and cloud-init's");
  });
});
