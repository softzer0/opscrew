import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { canonicalJson, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost, wgPublicKey } from "./__fixtures__/fake-host";
import {
  applyApproved,
  cloudServer,
  desiredFor,
  provision,
  SH_AVAILABLE,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
  shSyntax,
  wireguardKeys,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { RECORD_PATH } from "./constants";
import { HostRecordSchema } from "./facts";
import { hostPlanHash } from "./hash";
import { inspectHost, networkInspectScript } from "./inspect";
import {
  NETWORK_DROP_IN,
  type NetworkStepParams,
  NetworkStepParamsSchema,
  networkConfig,
  networkDropIn,
} from "./network";
import {
  parseIpv4Routes,
  parseNetworkState,
  parseUfwAdded,
  parseWireguardLinks,
  splitSections,
} from "./parse";
import { planHost, planNetwork, planTeardown, planUndo } from "./plan";
import { dockerRootCommand } from "./privilege";
import { asRoot, pipedScript } from "./shell";
import { stepScripts } from "./steps";
import type { HostPlan, HostStep } from "./types";

/** The shape of the pinned Caddy image (`IMAGES.caddy.ref`); the digest is a stand-in. */
const IMAGE = `caddy:2.11.7-alpine@sha256:${"0".repeat(63)}1`;
const COMMAND = "opscrew provision";

/**
 * The app server's network: a db server with a public address and a laptop (a device), and a
 * Postgres published on the private address (port 5432).
 */
function appNetwork(overrides: Partial<NetworkStepParams> = {}): NetworkStepParams {
  return {
    interface: "wg-opscrew0",
    address: "10.200.4.1/24",
    port: 51820,
    publicKey: wireguardKeys("app").publicKey,
    peers: [
      {
        name: "db",
        publicKey: wireguardKeys("db").publicKey,
        endpoint: "203.0.113.20:51820",
        allowedIp: "10.200.4.2/32",
      },
      {
        name: "laptop",
        publicKey: wireguardKeys("laptop").publicKey,
        allowedIp: "10.200.4.100/32",
      },
    ],
    otherInterfaces: [],
    sshPort: 22,
    localPorts: [5432],
    ...overrides,
  };
}

/** OpsCrew's rules that let the host's Docker networks reach `ip` on `port`, as ufw lists them. */
function localRules(ip: string, port: number): string {
  return [
    `ufw allow from 172.16.0.0/12 to ${ip} port ${port} proto tcp comment 'opscrew-network-local'`,
    `ufw allow from 192.168.0.0/16 to ${ip} port ${port} proto tcp comment 'opscrew-network-local'`,
    "",
  ].join("\n");
}

type Peer = NetworkStepParams["peers"][number];

/** The app server's private key (made at runtime from a seed, never committed). */
const APP_KEY = wireguardKeys("app").privateKey;

/** The network's plan on a fresh server the user owns (root). */
async function setupPlan(network: NetworkStepParams = appNetwork()): Promise<HostPlan> {
  return planNetwork(await inspectHost(new FakeHost()), { app: "shop", network }, COMMAND);
}

/** A server OpsCrew created: deploy is in the docker group, without sudo. */
function dockerServer(): FakeHost {
  const fake = cloudServer();
  fake.dockerAccess = true;
  return fake;
}

/** The plan's only step and its scripts. */
function only(plan: HostPlan): { step: HostStep; scripts: ReturnType<typeof stepScripts> } {
  const [step] = plan.steps;
  if (step === undefined) throw new Error("no step");
  return { step, scripts: stepScripts(plan, step) };
}

/** A teardown plan with the interface's removal, the given interfaces staying. */
function removalPlan(otherInterfaces: string, iface = "wg-opscrew0"): HostPlan {
  return {
    schemaVersion: 1,
    purpose: "teardown",
    app: "shop",
    steps: [
      {
        id: "network",
        title: `Remove ${iface}`,
        state: "change",
        scope: "app",
        params: { interface: iface, remove: true, otherInterfaces },
      },
    ],
    findings: [],
    deleteData: false,
  };
}

/** The host record the fake holds. */
function record(fake: FakeHost) {
  return HostRecordSchema.parse(JSON.parse(fake.files.get(RECORD_PATH) ?? "{}"));
}

describe("the network step's parameters", () => {
  const issues = (params: unknown) => {
    const parsed = NetworkStepParamsSchema.safeParse(params);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
  };
  const withPeer = (peer: Partial<Peer>): NetworkStepParams => {
    const [db, ...rest] = appNetwork().peers;
    return appNetwork({ peers: [{ ...(db as Peer), ...peer }, ...rest] });
  };

  it("accept the app server's network", () => {
    expect(issues(appNetwork())).toEqual([]);
    expect(
      issues(appNetwork({ peers: [], otherInterfaces: ["wg-opscrew1"], sshPort: 2222 })),
    ).toEqual([]);
  });

  it("take an endpoint only as host:port", () => {
    for (const endpoint of ["203.0.113.20:51820", "[2001:db8::7]:51820", "db.example.com:51820"]) {
      expect(issues(withPeer({ endpoint })), endpoint).toEqual([]);
    }
    for (const endpoint of [
      "203.0.113.20",
      "203.0.113.20:0",
      "203.0.113.20:70000",
      "2001:db8::7:51820",
      "203.0.113.300:51820",
      "203.0.113.0/24:51820",
      ":51820",
    ]) {
      expect(issues(withPeer({ endpoint })), endpoint).toEqual(["peers.0.endpoint"]);
    }
  });

  it("take an allowed IP only as a /32 inside the network's range", () => {
    expect(issues(withPeer({ allowedIp: "10.200.4.254/32" }))).toEqual([]);
    for (const allowedIp of [
      "10.200.5.2/32",
      "10.200.4.0/32",
      "10.200.4.255/32",
      "10.200.4.2/24",
      "10.200.4.2",
      "10.200.4.256/32",
    ]) {
      expect(issues(withPeer({ allowedIp })), allowedIp).toEqual(["peers.0.allowedIp"]);
    }
  });

  it("refuse a bad address, interface, key, keepalive or SSH port", () => {
    expect(issues(appNetwork({ address: "10.200.4.0/24" }))).toEqual(["address"]);
    expect(issues(appNetwork({ address: "10.200.4.1/16" }))).toEqual(["address"]);
    expect(issues(appNetwork({ interface: "wg0" }))).toEqual(["interface"]);
    expect(issues(appNetwork({ otherInterfaces: ["wg-opscrew0"] }))).toEqual(["otherInterfaces"]);
    expect(issues(appNetwork({ publicKey: "not-a-key" }))).toEqual(["publicKey"]);
    expect(issues(withPeer({ keepalive: 0 }))).toEqual(["peers.0.keepalive"]);
    expect(issues(appNetwork({ sshPort: 0 }))).toEqual(["sshPort"]);
    expect(issues(appNetwork({ localPorts: [0] }))).toEqual(["localPorts.0"]);
    // The interface is named after the port.
    expect(issues(appNetwork({ port: 51821 }))).toEqual(["port"]);
    expect(issues(appNetwork({ interface: "wg-opscrew1", port: 51821 }))).toEqual([]);
    expect(issues({ ...appNetwork(), privateKey: APP_KEY })).toEqual([""]);
  });

  it("are refused by planNetwork with the field that is wrong", async () => {
    const facts = await inspectHost(dockerServer());
    expect(() =>
      planNetwork(facts, { app: "shop", network: withPeer({ endpoint: "203.0.113.20" }) }, COMMAND),
    ).toThrow(/peers\.0\.endpoint: must be host:port/);
  });
});

describe("the network's files", () => {
  it("the configuration holds no private key: wg-quick sets it from the key file", () => {
    const config = networkConfig(appNetwork());
    expect(config).not.toMatch(/PrivateKey/);
    expect(config).toContain("PostUp = wg set %i private-key /etc/wireguard/%i.key");
    expect(config).toContain("Address = 10.200.4.1/24\nListenPort = 51820\n");
    expect(config).not.toContain(APP_KEY);
    expect(config).toMatchSnapshot();
  });

  it("Docker's drop-in wants every OpsCrew interface and starts after it, without requiring it", () => {
    const dropIn = networkDropIn(["wg-opscrew1", "wg-opscrew0"]);
    expect(dropIn).toContain(
      "[Unit]\nWants=wg-quick@wg-opscrew0.service wg-quick@wg-opscrew1.service\nAfter=wg-quick@wg-opscrew0.service wg-quick@wg-opscrew1.service\n",
    );
    expect(dropIn).not.toMatch(/Requires=/);
  });
});

describe("planNetwork", () => {
  it("plans the network on a server OpsCrew created, whose login becomes root through Docker", async () => {
    const facts = await inspectHost(dockerServer());
    expect(facts.privilege).toBe("docker");
    const plan = planNetwork(facts, { app: "shop", network: appNetwork() }, COMMAND);
    expect(plan.findings).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    const { step } = only(plan);
    expect(step).toMatchObject({ id: "network", state: "change", scope: "app" });
    expect(step.title).toBe(
      "Join the private network as 10.200.4.1/24 on WireGuard interface wg-opscrew0 (UDP port 51820), linked to db and laptop",
    );
    expect(step.reason).toContain("on standard input (never in this plan)");
    // Shown and audited: the peers' public addresses are not in the plan's text.
    expect(`${step.title} ${step.reason}`).not.toContain("203.0.113.20");
  });

  it("gives the same plan hash for the same peers and interfaces in any order", async () => {
    const facts = await inspectHost(dockerServer());
    const network = appNetwork({ otherInterfaces: ["wg-opscrew2", "wg-opscrew1"] });
    const reordered = {
      ...network,
      peers: [...network.peers].reverse(),
      otherInterfaces: ["wg-opscrew1", "wg-opscrew2"],
    };
    expect(hostPlanHash(planNetwork(facts, { app: "shop", network: reordered }, COMMAND))).toBe(
      hostPlanHash(planNetwork(facts, { app: "shop", network }, COMMAND)),
    );
  });

  it("still refuses a login that needs a password for sudo or cannot become root", async () => {
    for (const sudo of ["password", "none"] as const) {
      const fake = new FakeHost({ login: "alice", sudo });
      const plan = planNetwork(
        await inspectHost(fake),
        { app: "shop", network: appNetwork() },
        COMMAND,
      );
      expect(plan.findings.map((finding) => finding.code)).toEqual([
        sudo === "password" ? "sudo-needs-password" : "no-root-access",
      ]);
      expect(only(plan).step.state).toBe("blocked");
    }
  });

  it("refuses a firewall other than ufw, naming the UDP port and the SSH rule the network needs", async () => {
    const fake = new FakeHost();
    fake.firewalld = true;
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork({ sshPort: 2222 }) },
      COMMAND,
    );
    expect(plan.findings).toHaveLength(1);
    expect(plan.findings[0]).toMatchObject({ code: "other-firewall" });
    expect(plan.findings[0]?.message).toContain("UDP port 51820 open to every address");
    expect(plan.findings[0]?.message).toContain("SSH (TCP port 2222) allowed in on wg-opscrew0");
    expect(only(plan).step.state).toBe("blocked");
  });

  it("refuses a range a route of the server overlaps, and says to change network.range", async () => {
    const fake = new FakeHost();
    fake.routes.push("10.200.0.0/16 via 192.168.1.1 dev eth1 proto static");
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    expect(plan.findings).toEqual([
      expect.objectContaining({
        code: "network-range-taken",
        message: expect.stringContaining(
          "10.200.4.0/24 overlaps a route this server already has (10.200.0.0/16 dev eth1)",
        ),
        hint: expect.stringContaining("Change network.range in opscrew/plan.yaml"),
      }),
    ]);
    // A narrower route inside the range clashes too; routes elsewhere and the network's own do not.
    fake.routes.pop();
    fake.routes.push("10.200.4.128/25 dev br-1a2b3c proto kernel scope link src 10.200.4.129");
    const narrower = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    expect(narrower.findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("(10.200.4.128/25 dev br-1a2b3c)"),
    ]);
    fake.routes.pop();
    fake.wireguard.set("wg-opscrew0", {
      enabled: true,
      active: true,
      address: "10.200.4.1/24",
      peers: [],
    });
    const own = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    expect(own.findings).toEqual([]);
  });

  it("is never planned for a server OpsCrew sets up from its root facts: planHost refuses a Docker-only login", async () => {
    const fake = dockerServer();
    const plan = planHost(await inspectHost(fake), desiredFor(fake), COMMAND);
    expect(plan.findings.map((finding) => finding.code)).toEqual(["root-only-through-docker"]);
  });
});

describe("the network step's scripts", () => {
  it("match their snapshot (setup, removal, removal of the last interface)", async () => {
    const sets = {
      setup: only(await setupPlan()).scripts,
      removal: only(removalPlan("wg-opscrew1")).scripts,
      "removal of the last": only(removalPlan("")).scripts,
    };
    const all = Object.fromEntries<string>([
      ...Object.entries(sets).flatMap(([name, set]): [string, string][] => [
        [`${name} check`, set.check],
        [`${name} apply`, set.apply],
        [`${name} verify`, set.verify],
      ]),
      ["inspection through Docker", networkInspectScript()],
    ]);
    expect(all).toMatchSnapshot();
    for (const [name, script] of Object.entries(all)) {
      expect(script, name).not.toContain(APP_KEY);
      expect(script, name).not.toMatch(
        /(^|\s)\[\[\s|<<<|\bfunction\s+\w+|\s\$'|\$\{\w+\/\/|\bsource\s|\w+\+=\(|\[ [^\]\n]*== |\bdeclare\s|\bpushd\b/m,
      );
      // Root scripts reach the server through sudo, or through Docker on its stdin.
      for (const command of [script, asRoot("sudo", script), pipedScript(script, `${APP_KEY}\n`)]) {
        const syntax = shSyntax(command);
        if (syntax !== undefined) expect(syntax.ok, `${name}: ${syntax.stderr}`).toBe(true);
      }
    }
  });

  it("take the key only from stdin, optionally, check it, and write it to a root-only file", async () => {
    const { scripts } = only(await setupPlan());
    expect(scripts.secrets).toEqual({ names: ["wireguardKey"], required: false });
    expect(scripts.apply).toContain("IFS= read -r key || true");
    expect(scripts.apply).toMatch(
      /umask 077\n\s*printf '%s\\n' "\$key" \| write_file "\$KEY_FILE" 0600/,
    );
    // The key variable goes only through builtins: to wg pubkey's stdin, and to that file.
    const uses = scripts.apply.split("\n").filter((line) => /\$key\b/.test(line));
    expect(uses.map((line) => line.trim())).toEqual([
      'case "$key" in',
      'if [ -n "$key" ]; then',
      `if [ "$(printf '%s\\n' "$key" | wg pubkey)" != "$PUBLIC_KEY" ]; then`,
      `printf '%s\\n' "$key" | write_file "$KEY_FILE" 0600`,
    ]);
  });
});

describe.skipIf(!SH_AVAILABLE)("the network step in a real shell (commands stubbed)", () => {
  /** A harness whose `wg`, `systemctl`, `ip`, `ufw`, `apt-get` and `dpkg-query` keep their state in files. */
  function harness(): ShellHarness {
    const h = new ShellHarness();
    mkdirSync(h.native("/run"), { recursive: true });
    h.stub(
      "dpkg-query",
      `for last; do :; done\nif [ -f "$S/pkg-$last" ]; then printf 'install ok installed'; else exit 1; fi`,
      { log: false },
    );
    h.stub(
      "apt-get",
      // apt may read the session's stdin: this one swallows whatever is left of it.
      `cat > /dev/null\nfor last; do :; done\ncase " $* " in *" install "*) touch "$S/pkg-$last" ;; esac`,
    );
    h.stub(
      "wg",
      `case "$1" in
  pubkey)
    k=$(cat)
    f="$S/pub-$(printf '%s' "$k" | tr '/+=' '_.-')"
    if [ -f "$f" ]; then cat "$f"; else echo unknown; fi ;;
  show) cat "$S/peers" 2>/dev/null ;;
  syncconf)
    cp "$3" "$S/synced.conf"
    sed -n 's/^PublicKey = //p' "$3" > "$S/peers" ;;
esac`,
    );
    h.stub(
      "systemctl",
      `cmd=$1
shift
case "$cmd" in
  is-active) [ -f "$S/active" ] ;;
  is-enabled) if [ -f "$S/enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  enable) touch "$S/enabled" ;;
  start|restart)
    conf="$S/../etc/wireguard/wg-opscrew0.conf"
    sed -n 's/^Address = //p' "$conf" > "$S/address"
    sed -n 's/^PublicKey = //p' "$conf" > "$S/peers"
    touch "$S/active" ;;
  disable) rm -f "$S/enabled" "$S/active" ;;
esac`,
    );
    h.stub(
      "ip",
      `case "$*" in
  "-4 -o addr show dev "*) if [ -f "$S/active" ]; then printf '7: %s    inet %s scope global %s\\n' "$6" "$(cat "$S/address")" "$6"; fi ;;
  "link show "*) [ -f "$S/active" ] ;;
  "link delete "*) rm -f "$S/active" ;;
esac`,
    );
    h.stub(
      "ufw",
      `touch "$S/ufw"
case "$1" in
  show) echo "Added user rules (see 'ufw status' for running firewall):"; cat "$S/ufw" ;;
  allow)
    shift
    rule=''
    comment=''
    while [ $# -gt 0 ]; do
      if [ "$1" = comment ]; then comment=$2; shift 2; else rule="$rule $1"; shift; fi
    done
    echo "ufw allow$rule comment '$comment'" >> "$S/ufw" ;;
  --force)
    shift 3
    rule="ufw allow $*"
    { grep -v -x -F "$rule" "$S/ufw" | grep -v -F "$rule comment '"; } > "$S/ufw.new" || true
    mv "$S/ufw.new" "$S/ufw" ;;
esac`,
    );
    // `wg pubkey` knows the app server's key.
    h.write(
      `/state/pub-${APP_KEY.replace(/[/+=]/g, (c) => ({ "/": "_", "+": ".", "=": "-" })[c] ?? c)}`,
      `${wireguardKeys("app").publicKey}\n`,
    );
    return h;
  }

  it("installs, writes the key, the keyless configuration and the drop-in, starts the unit, then opens ufw", async () => {
    const h = harness();
    try {
      const { scripts } = only(await setupPlan());
      expect(h.run(scripts.check).stdout).toContain("state=change");
      h.clearCalls();
      const run = h.run(scripts.apply, `${APP_KEY}\n`);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const calls = h.calls().filter((call) => !call.startsWith("wg pubkey"));
      expect(calls).toEqual([
        "apt-get -q -y -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold update",
        "apt-get -q -y -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install wireguard-tools",
        "systemctl daemon-reload",
        "systemctl enable --quiet wg-quick@wg-opscrew0.service",
        "systemctl is-active --quiet wg-quick@wg-opscrew0.service",
        "systemctl start wg-quick@wg-opscrew0.service",
        "ufw show added",
        "ufw allow 51820/udp comment opscrew-network",
        "ufw allow in on wg-opscrew0 to any port 22 proto tcp comment opscrew-network-ssh",
        "ufw allow from 172.16.0.0/12 to 10.200.4.1 port 5432 proto tcp comment opscrew-network-local",
        "ufw allow from 192.168.0.0/16 to 10.200.4.1 port 5432 proto tcp comment opscrew-network-local",
      ]);
      expect(h.read("/etc/wireguard/wg-opscrew0.key")).toBe(`${APP_KEY}\n`);
      expect(h.read("/etc/wireguard/wg-opscrew0.conf")).toBe(networkConfig(appNetwork()));
      expect(h.read(NETWORK_DROP_IN)).toBe(networkDropIn(["wg-opscrew0"]));
      expect(h.exists("/run/opscrew-wg-opscrew0.conf")).toBe(false);
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");
    } finally {
      h.dispose();
    }
  });

  it("syncs new peers from a full temporary configuration with the key file's key, removed right after", async () => {
    const h = harness();
    try {
      expect(h.run(only(await setupPlan()).scripts.apply, `${APP_KEY}\n`).status).toBe(0);
      h.clearCalls();
      const phone = {
        name: "phone",
        publicKey: wireguardKeys("phone").publicKey,
        allowedIp: "10.200.4.101/32",
      };
      const next = appNetwork({ peers: [...appNetwork().peers, phone] });
      const { scripts } = only(await setupPlan(next));
      expect(h.run(scripts.check).stdout).toContain("state=change");
      // No key this time: the server keeps its own.
      const run = h.run(scripts.apply);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const calls = h.calls();
      expect(calls).toContain(
        `wg syncconf wg-opscrew0 ${h.posix("/run/opscrew-wg-opscrew0.conf")}`,
      );
      expect(calls.some((call) => /^systemctl (start|restart)/.test(call))).toBe(false);
      const synced = h.read("/state/synced.conf") ?? "";
      expect(
        synced.startsWith(
          `[Interface]\nPrivateKey = ${APP_KEY}\nListenPort = 51820\n\n[Peer]\n# db\n`,
        ),
      ).toBe(true);
      expect(synced).toContain(
        `# phone\nPublicKey = ${phone.publicKey}\nAllowedIPs = 10.200.4.101/32\n`,
      );
      expect(h.exists("/run/opscrew-wg-opscrew0.conf")).toBe(false);
      expect(h.read("/etc/wireguard/wg-opscrew0.key")).toBe(`${APP_KEY}\n`);
      expect(h.read("/etc/wireguard/wg-opscrew0.conf")).not.toMatch(/PrivateKey/);
      expect(h.run(scripts.verify).status).toBe(0);
      // A new address brings the interface up again.
      h.clearCalls();
      const moved = only(await setupPlan(appNetwork({ address: "10.200.4.9/24" }))).scripts;
      expect(h.run(moved.apply).status).toBe(0);
      expect(h.calls()).toContain("systemctl restart wg-quick@wg-opscrew0.service");
      expect(h.run(moved.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("stops before any change without a key, and never writes a key other than the plan's", async () => {
    const h = harness();
    try {
      const { scripts } = only(await setupPlan());
      const none = h.run(scripts.apply);
      expect(none.status).not.toBe(0);
      expect(none.stderr).toContain(
        "No WireGuard key arrived on standard input, and the server has none for wg-opscrew0 yet.",
      );
      expect(h.exists("/etc/wireguard/wg-opscrew0.conf")).toBe(false);
      const other = wireguardKeys("someone else").privateKey;
      const wrong = h.run(scripts.apply, `${other}\n`);
      expect(wrong.status).not.toBe(0);
      expect(wrong.stderr).toContain(
        "The WireGuard key that arrived on standard input is not the one the plan names, so it was not written.",
      );
      expect(wrong.stderr).not.toContain(other);
      expect(h.exists("/etc/wireguard/wg-opscrew0.key")).toBe(false);
      expect(h.exists("/etc/wireguard/wg-opscrew0.conf")).toBe(false);
      const odd = h.run(scripts.apply, "not a key; rm -rf /\n");
      expect(odd.stderr).toContain(
        "The WireGuard key has unexpected characters, so it was not written.",
      );
    } finally {
      h.dispose();
    }
  });

  it("opens SSH on the interface on the login's port, and its removal takes OpsCrew's rules only", async () => {
    const h = harness();
    try {
      // The user's own rule for the port, and another app's network on wg-opscrew1.
      const blogLocal = localRules("10.200.7.1", 5432);
      h.write("/state/ufw", `ufw allow 51820/udp\n${blogLocal}`);
      h.write("/etc/wireguard/wg-opscrew1.conf", "[Interface]\nAddress = 10.200.7.1/24\n");
      const scripts = only(await setupPlan(appNetwork({ sshPort: 2222 }))).scripts;
      expect(h.run(scripts.apply, `${APP_KEY}\n`).status).toBe(0);
      // The user's own rule for the port counts; SSH opens on 2222; Docker's networks reach
      // Postgres on .1.
      expect(h.read("/state/ufw")).toBe(
        `ufw allow 51820/udp\n${blogLocal}ufw allow in on wg-opscrew0 to any port 2222 proto tcp comment 'opscrew-network-ssh'\n${localRules("10.200.4.1", 5432)}`,
      );
      expect(h.run(scripts.verify).status).toBe(0);
      const removal = only(removalPlan("wg-opscrew1")).scripts;
      expect(h.run(removal.check).stdout).toContain("state=change");
      const run = h.run(removal.apply);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(h.calls()).toContain("systemctl disable --now --quiet wg-quick@wg-opscrew0.service");
      // The other app's rules stay.
      expect(h.read("/state/ufw")).toBe(`ufw allow 51820/udp\n${blogLocal}`);
      expect(h.exists("/etc/wireguard/wg-opscrew0.conf")).toBe(false);
      expect(h.exists("/etc/wireguard/wg-opscrew0.key")).toBe(false);
      expect(h.read(NETWORK_DROP_IN)).toBe(networkDropIn(["wg-opscrew1"]));
      expect(h.run(removal.verify).status).toBe(0);
      // The last interface's removal deletes the drop-in, and every Docker networks' rule.
      const last = only(removalPlan("")).scripts;
      expect(h.run(last.check).stdout).toContain("state=change");
      expect(h.run(last.apply).status).toBe(0);
      expect(h.exists(NETWORK_DROP_IN)).toBe(false);
      expect(h.read("/state/ufw")).toBe("ufw allow 51820/udp\n");
      expect(h.run(last.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("removes its own Docker networks' rules when an interface that stays has no configuration", async () => {
    const h = harness();
    try {
      expect(h.run(only(await setupPlan()).scripts.apply, `${APP_KEY}\n`).status).toBe(0);
      expect(h.read("/state/ufw")).toContain(localRules("10.200.4.1", 5432));
      // wg-opscrew1 is named as staying, but its configuration is gone.
      const removal = only(removalPlan("wg-opscrew1")).scripts;
      const run = h.run(removal.apply);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(h.read("/state/ufw")).not.toContain("opscrew-network-local");
      expect(h.run(removal.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("opens the private address to the Docker networks on the planned ports only", async () => {
    const h = harness();
    try {
      const blogLocal = localRules("10.200.7.1", 6379);
      h.write("/state/ufw", blogLocal);
      const two = only(await setupPlan(appNetwork({ localPorts: [6379, 5432] }))).scripts;
      expect(h.run(two.apply, `${APP_KEY}\n`).status).toBe(0);
      expect(h.run(two.verify).status).toBe(0);
      const ssh =
        "ufw allow 51820/udp comment 'opscrew-network'\nufw allow in on wg-opscrew0 to any port 22 proto tcp comment 'opscrew-network-ssh'\n";
      // Each pool, each port.
      expect(h.read("/state/ufw")).toBe(
        `${blogLocal}${ssh}${[
          "ufw allow from 172.16.0.0/12 to 10.200.4.1 port 5432 proto tcp comment 'opscrew-network-local'",
          "ufw allow from 172.16.0.0/12 to 10.200.4.1 port 6379 proto tcp comment 'opscrew-network-local'",
          "ufw allow from 192.168.0.0/16 to 10.200.4.1 port 5432 proto tcp comment 'opscrew-network-local'",
          "ufw allow from 192.168.0.0/16 to 10.200.4.1 port 6379 proto tcp comment 'opscrew-network-local'",
          "",
        ].join("\n")}`,
      );
      // A port no longer published is closed again; the other app's rules stay.
      const one = only(await setupPlan(appNetwork({ localPorts: [5432] }))).scripts;
      expect(h.run(one.check).stdout).toContain("state=change");
      expect(h.run(one.apply).status).toBe(0);
      expect(h.read("/state/ufw")).toBe(`${blogLocal}${ssh}${localRules("10.200.4.1", 5432)}`);
      expect(h.run(one.verify).status).toBe(0);
      const none = only(await setupPlan(appNetwork({ localPorts: [] }))).scripts;
      expect(h.run(none.check).stdout).toContain("state=change");
      expect(h.run(none.apply).status).toBe(0);
      expect(h.read("/state/ufw")).toBe(`${blogLocal}${ssh}`);
      expect(h.run(none.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("the inspection reads the network as the check does, so an unchanged network plans in place", async () => {
    const h = harness();
    try {
      expect(h.run(only(await setupPlan()).scripts.apply, `${APP_KEY}\n`).status).toBe(0);
      const run = h.run(networkInspectScript());
      expect(run.status).toBe(0);
      const sections = splitSections(run.stdout);
      const state = parseNetworkState(sections.get("network")?.text ?? "");
      expect(state.interfaces).toEqual([
        {
          name: "wg-opscrew0",
          config: sha256Hex(networkConfig(appNetwork())),
          publicKey: wireguardKeys("app").publicKey,
          enabled: true,
          active: true,
          addresses: ["10.200.4.1/24"],
          peers: appNetwork().peers.map((peer) => peer.publicKey),
        },
      ]);
      expect(run.stdout).not.toContain(APP_KEY);
      const inspected = await inspectHost(new FakeHost());
      const ufwRules = parseUfwAdded(sections.get("ufw-added")?.text ?? "");
      const facts = {
        ...inspected,
        network: state,
        firewall: { ...inspected.firewall, ufwRules },
      };
      const plan = (network: NetworkStepParams) =>
        planNetwork(facts, { app: "shop", network }, COMMAND);
      expect(only(plan(appNetwork())).step.state).toBe("in-place");
      expect(only(plan(appNetwork({ peers: [] }))).step.state).toBe("change");
      expect(only(plan(appNetwork({ sshPort: 2222 }))).step.state).toBe("change");
      expect(only(plan(appNetwork({ localPorts: [5432, 6379] }))).step.state).toBe("change");
      expect(only(plan(appNetwork({ localPorts: [] }))).step.state).toBe("change");
    } finally {
      h.dispose();
    }
  });
});

describe("applying the network on a server OpsCrew created (root through Docker)", () => {
  it("runs every root script in the privileged container, with the key only on standard input", async () => {
    const fake = dockerServer();
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    const result = await applyApproved(fake, plan, {
      rootImage: IMAGE,
      secrets: { wireguardKey: APP_KEY },
    });
    expect(result.applied).toEqual(["network"]);
    const command = `docker run --rm -i --privileged --pid=host --net=host --ipc=host --uts=host ${IMAGE} nsenter -t 1 -m -u -i -n -p -- sh -s`;
    expect(dockerRootCommand(IMAGE)).toBe(command);
    const root = fake.calls.filter((call) => call.name !== "privilege" && call.name !== "inspect");
    expect(root.map((call) => call.name)).toEqual([
      "record.read",
      "record.write",
      "network.check",
      "record.write",
      "network.apply",
      "network.verify",
    ]);
    for (const call of root) {
      expect(call.command).toBe(command);
      expect(call.docker?.image).toBe(IMAGE);
    }
    for (const call of fake.calls) {
      expect(call.command).not.toContain(APP_KEY);
      expect(call.script).not.toContain(APP_KEY);
    }
    // Only the apply's stdin carries the key, piped into the script by the container's sh.
    expect(
      fake.calls.filter((call) => call.docker?.stdin.includes(APP_KEY)).map((call) => call.name),
    ).toEqual(["network.apply"]);
    const apply = root.find((call) => call.name === "network.apply");
    expect(apply?.input).toBe(`${APP_KEY}\n`);
    expect(
      apply?.docker?.stdin.startsWith(
        `printf '%s' '${APP_KEY}\n' | {\n# opscrew-host: network.apply\n`,
      ),
    ).toBe(true);
    expect(fake.wireguardLog).toEqual([
      "install wireguard-tools",
      "key wg-opscrew0",
      "start wg-opscrew0",
    ]);
    expect(record(fake).networks).toEqual({ "wg-opscrew0": "shop" });
    // Applied again, it is in place, and the key is not sent.
    const again = await applyApproved(fake, plan, {
      rootImage: IMAGE,
      secrets: { wireguardKey: APP_KEY },
    });
    expect(again).toEqual({ applied: [], skipped: ["network"] });
    expect(fake.calls.filter((call) => call.name === "network.apply")).toHaveLength(1);
  });

  it("changes the peers without the key: the server keeps its own", async () => {
    const fake = dockerServer();
    await applyApproved(
      fake,
      planNetwork(await inspectHost(fake), { app: "shop", network: appNetwork() }, COMMAND),
      { rootImage: IMAGE, secrets: { wireguardKey: APP_KEY } },
    );
    const phone = {
      name: "phone",
      publicKey: wireguardKeys("phone").publicKey,
      allowedIp: "10.200.4.101/32",
    };
    const next = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork({ peers: [...appNetwork().peers, phone] }) },
      COMMAND,
    );
    expect((await applyApproved(fake, next, { rootImage: IMAGE })).applied).toEqual(["network"]);
    expect(fake.wireguardLog.at(-1)).toBe("syncconf wg-opscrew0");
    expect(fake.wireguard.get("wg-opscrew0")?.peers).toContain(phone.publicKey);
  });

  it("is refused plainly without the image, or with one not pinned by its digest, before any change", async () => {
    const fake = dockerServer();
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    fake.calls.length = 0;
    await expect(
      applyApproved(fake, plan, { secrets: { wireguardKey: APP_KEY } }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("becomes root on the server only through Docker"),
    });
    expect(fake.calls.map((call) => call.name)).toEqual(["privilege"]);
    await expect(
      applyApproved(fake, plan, {
        rootImage: "caddy:2.11.7-alpine",
        secrets: { wireguardKey: APP_KEY },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("pinned by its digest"),
    });
    expect(fake.calls.map((call) => call.name)).toEqual(["privilege"]);
  });

  it("never changes another app's network on the same interface", async () => {
    const fake = dockerServer();
    fake.files.set(
      RECORD_PATH,
      JSON.stringify({
        schemaVersion: 1,
        apps: [],
        opscrewVersion: "0.1.0",
        changes: [],
        networks: { "wg-opscrew0": "blog" },
      }),
    );
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    await expect(
      applyApproved(fake, plan, { rootImage: IMAGE, secrets: { wireguardKey: APP_KEY } }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        'wg-opscrew0 on this server is the private network of the OpsCrew app "blog"',
      ),
    });
    expect(fake.wireguardLog).toEqual([]);
  });

  it("never lets the key into an error, the plan or its hash input", async () => {
    const fake = dockerServer();
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    expect(JSON.stringify(plan)).not.toContain(APP_KEY);
    expect(canonicalJson(plan)).not.toContain(APP_KEY);
    // A server that echoes what it got on stdin.
    fake.echoStdinOn = "network.apply";
    const error = await applyApproved(fake, plan, {
      rootImage: IMAGE,
      secrets: { wireguardKey: APP_KEY },
    }).then(
      () => {
        throw new Error("the apply should have failed");
      },
      (caught: unknown) => caught as Error & { hint?: string; cause?: unknown },
    );
    expect(error).toBeInstanceOf(Error);
    expect(`${error.message} ${error.hint ?? ""}`).not.toContain(APP_KEY);
    expect(String(error.cause ?? "")).not.toContain(APP_KEY);
    expect(error.message).toContain("[REDACTED:wireguard-key]");
  });
});

describe("planning an unchanged network", () => {
  it("is in place as root, and a change for anything that differs", async () => {
    const fake = new FakeHost();
    const network = appNetwork();
    const plan = async () =>
      only(planNetwork(await inspectHost(fake), { app: "shop", network }, COMMAND)).step;
    expect((await plan()).state).toBe("change");
    await applyApproved(
      fake,
      planNetwork(await inspectHost(fake), { app: "shop", network }, COMMAND),
      { secrets: { wireguardKey: APP_KEY } },
    );
    const inPlace = await plan();
    expect(inPlace).toMatchObject({ state: "in-place", reason: "Already set." });
    const unchanged = planNetwork(await inspectHost(fake), { app: "shop", network }, COMMAND);
    fake.calls.length = 0;
    expect(await applyApproved(fake, unchanged)).toEqual({ applied: [], skipped: ["network"] });
    expect(fake.calls).toEqual([]);

    const wg = fake.wireguard.get("wg-opscrew0");
    if (wg === undefined) throw new Error("no interface");
    wg.active = false;
    expect((await plan()).state).toBe("change");
    wg.active = true;
    const local = fake.ufwRules.findIndex((rule) => rule.comment === "opscrew-network-local");
    const [removed] = fake.ufwRules.splice(local, 1);
    expect((await plan()).state).toBe("change");
    if (removed !== undefined) fake.ufwRules.push(removed);
    expect((await plan()).state).toBe("in-place");
    // A port the plan no longer names is still open to the Docker networks.
    fake.ufwRules.push({
      rule: "allow from 172.16.0.0/12 to 10.200.4.1 port 6379 proto tcp",
      comment: "opscrew-network-local",
    });
    expect((await plan()).state).toBe("change");
    fake.ufwRules.pop();
    fake.files.delete(NETWORK_DROP_IN);
    expect((await plan()).state).toBe("change");
  });

  it("is read through sudo for a login with passwordless sudo", async () => {
    const fake = new FakeHost({ login: "alice" });
    await inspectHost(fake);
    const read = fake.calls.find((call) => call.name === "network.inspect");
    expect(read?.command.startsWith("sudo -n sh -c ")).toBe(true);
  });

  it("is read as root through Docker with the image; without it, the change is planned as before", async () => {
    const fake = dockerServer();
    const network = appNetwork();
    await applyApproved(
      fake,
      planNetwork(await inspectHost(fake), { app: "shop", network }, COMMAND),
      { rootImage: IMAGE, secrets: { wireguardKey: APP_KEY } },
    );
    fake.calls.length = 0;
    const facts = await inspectHost(fake, { rootImage: IMAGE });
    const read = fake.calls.find((call) => call.name === "network.inspect");
    expect(read?.command).toBe(dockerRootCommand(IMAGE));
    expect(read?.docker?.stdin).not.toContain(APP_KEY);
    expect(fake.calls.find((call) => call.name === "inspect")?.command.startsWith("sh -c ")).toBe(
      true,
    );
    expect(facts.network?.interfaces.map((item) => item.name)).toEqual(["wg-opscrew0"]);
    expect(only(planNetwork(facts, { app: "shop", network }, COMMAND)).step.state).toBe("in-place");
    const withoutImage = await inspectHost(fake);
    expect(withoutImage.network).toBeNull();
    expect(only(planNetwork(withoutImage, { app: "shop", network }, COMMAND)).step.state).toBe(
      "change",
    );
  });

  it("is not read without a way to root", async () => {
    const facts = await inspectHost(new FakeHost({ login: "alice", sudo: "none" }));
    expect(facts.network).toBeNull();
  });
});

describe("the network on a server the user owns", () => {
  it("is set up as root, and its teardown removes it and its record, keeping the other app's", async () => {
    const fake = new FakeHost();
    await provision(fake);
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: appNetwork() },
      COMMAND,
    );
    await applyApproved(fake, plan, { secrets: { wireguardKey: APP_KEY } });
    expect(
      fake.calls
        .filter((call) => call.name.startsWith("network."))
        .every((call) => call.command.startsWith("sh -c ")),
    ).toBe(true);
    // Another app's network on the same server.
    fake.wireguard.set("wg-opscrew1", {
      enabled: true,
      active: true,
      address: "10.200.7.1/24",
      peers: [],
    });
    const held = record(fake);
    fake.files.set(
      RECORD_PATH,
      JSON.stringify({ ...held, networks: { ...held.networks, "wg-opscrew1": "blog" } }),
    );

    const facts = await inspectHost(fake);
    expect(facts.wireguardInterfaces).toEqual(["wg-opscrew0", "wg-opscrew1"]);
    const teardown = planTeardown(
      facts,
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    const removal = teardown.steps.find((step) => step.id === "network");
    expect(removal).toMatchObject({
      state: "change",
      scope: "app",
      params: { interface: "wg-opscrew0", remove: true, otherInterfaces: "wg-opscrew1" },
    });
    // After the app's containers, which listen on the network, are gone: its filter, then it.
    const ids = teardown.steps.map((step) => step.id);
    expect(ids.indexOf("network-filter")).toBe(ids.indexOf("app-dirs") + 1);
    expect(ids.indexOf("network")).toBe(ids.indexOf("app-dirs") + 2);
    await applyApproved(fake, teardown, { command: "opscrew destroy" });
    expect(fake.wireguard.has("wg-opscrew0")).toBe(false);
    expect(fake.files.get(NETWORK_DROP_IN)).toBe(networkDropIn(["wg-opscrew1"]));
    expect(record(fake).networks).toEqual({ "wg-opscrew1": "blog" });
    expect(fake.ufwRules.map((rule) => rule.comment)).not.toContain("opscrew-network");
  });

  it("an undo removes a network left behind", async () => {
    const fake = new FakeHost();
    await provision(fake);
    await applyApproved(
      fake,
      planNetwork(await inspectHost(fake), { app: "shop", network: appNetwork() }, COMMAND),
      { secrets: { wireguardKey: APP_KEY } },
    );
    // The app went, its network stayed (a teardown that stopped before it).
    const held = record(fake);
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    const withoutNetwork = {
      ...teardown,
      steps: teardown.steps.filter((step) => step.id !== "network"),
    };
    await applyApproved(fake, withoutNetwork, { command: "opscrew destroy" });
    expect(record(fake).networks).toEqual(held.networks);
    expect(fake.wireguard.has("wg-opscrew0")).toBe(true);
    const undo = planUndo(
      await inspectHost(fake),
      { repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy --undo-host",
    );
    expect(undo.steps.find((step) => step.id === "network")).toMatchObject({
      scope: "shared",
      params: { interface: "wg-opscrew0", remove: true, otherInterfaces: "" },
    });
    await applyApproved(fake, undo, { command: "opscrew destroy --undo-host" });
    expect(fake.wireguard.size).toBe(0);
    expect(fake.files.has(NETWORK_DROP_IN)).toBe(false);
  });
});

describe("the network's facts", () => {
  it("read the WireGuard interfaces, the UDP ports in use and the IPv4 routes without root", async () => {
    const fake = dockerServer();
    fake.wireguard.set("wg-opscrew0", {
      enabled: true,
      active: true,
      address: "10.200.4.2/24",
      peers: [],
    });
    const facts = await inspectHost(fake);
    expect(facts.privilege).toBe("docker");
    expect(fake.calls.find((call) => call.name === "inspect")?.command.startsWith("sh -c ")).toBe(
      true,
    );
    expect(facts.wireguardInterfaces).toEqual(["wg-opscrew0"]);
    expect(facts.udpPortsInUse).toEqual([53, 68, 51820]);
    expect(facts.ipv4Routes).toEqual([
      "172.17.0.0/16 dev docker0",
      "192.168.1.0/24 dev eth0",
      "10.200.4.0/24 dev wg-opscrew0",
    ]);
  });

  it("parse ip's output as Ubuntu prints it", () => {
    expect(
      parseWireguardLinks(
        [
          "7: wg-opscrew0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/none ",
          "9: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/none ",
        ].join("\n"),
      ),
    ).toEqual(["wg-opscrew0", "wg0"]);
    expect(
      parseIpv4Routes(
        [
          "default via 172.31.1.1 dev eth0 proto dhcp src 203.0.113.10 metric 100",
          "10.0.0.0/8 via 10.0.0.1 dev enp7s0",
          "blackhole 10.99.0.0/16 proto static",
          "10.50.0.0/24 proto static metric 20",
          "\tnexthop via 10.0.0.1 dev enp7s0 weight 1",
          "172.31.1.1 dev eth0 proto dhcp scope link src 203.0.113.10 metric 100",
        ].join("\n"),
      ),
    ).toEqual(["10.0.0.0/8 dev enp7s0", "10.99.0.0/16", "10.50.0.0/24", "172.31.1.1 dev eth0"]);
  });
});

describe("the test keys", () => {
  it("are what Node's x25519 key maker gives: the fake's wg pubkey agrees with it", () => {
    const pair = generateKeyPairSync("x25519");
    const base64 = (value: string | undefined) =>
      Buffer.from(value ?? "", "base64url").toString("base64");
    expect(wgPublicKey(base64(pair.privateKey.export({ format: "jwk" }).d))).toBe(
      base64(pair.publicKey.export({ format: "jwk" }).x),
    );
  });
});
