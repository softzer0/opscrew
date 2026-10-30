import { readFileSync } from "node:fs";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  cloudServer,
  provision,
  SH_AVAILABLE,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
  shSyntax,
  wireguardKeys,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import { inspectHost } from "./inspect";
import type { NetworkStepParams } from "./network";
import { networkFileHashes, networkFilterFileHashes, networkUfwRules } from "./network-files";
import {
  NETWORK_FILTER_UNIT,
  NETWORK_FILTER_UNIT_TEXT,
  type NetworkFilterParams,
  NetworkFilterParamsSchema,
  networkFilterDropIn,
  networkFilterDropInPath,
  networkFilterFields,
  networkFilterScript,
  networkFilterScriptPath,
  readNetworkFilter,
  readNetworkFilterScript,
} from "./network-filter";
import { parseNetworkFilterRules } from "./parse";
import { planNetwork, planTeardown } from "./plan";
import { dockerRootCommand } from "./privilege";
import { asRoot, pipedScript } from "./shell";
import { stepScripts } from "./steps";
import type { HostPlan, HostStep } from "./types";

const IMAGE = `caddy:2.11.7-alpine@sha256:${"0".repeat(63)}1`;
const COMMAND = "opscrew provision";
const DB_KEY = wireguardKeys("db").privateKey;

/** The db server's network: linked to the app's server, Postgres and Valkey published on it. */
function dbNetwork(overrides: Partial<NetworkStepParams> = {}): NetworkStepParams {
  return {
    interface: "wg-opscrew0",
    address: "10.200.4.2/24",
    port: 51820,
    publicKey: wireguardKeys("db").publicKey,
    peers: [
      {
        name: "app",
        publicKey: wireguardKeys("app").publicKey,
        endpoint: "203.0.113.10:51820",
        allowedIp: "10.200.4.1/32",
        keepalive: 25,
      },
    ],
    otherInterfaces: [],
    sshPort: 22,
    localPorts: [5432, 6379],
    ...overrides,
  };
}

/** Postgres for the app's server and a laptop granted it; Valkey for the app's server only. */
function dbFilter(overrides: Partial<NetworkFilterParams> = {}): NetworkFilterParams {
  return {
    interface: "wg-opscrew0",
    address: "10.200.4.2",
    rules: [
      { port: 6379, sources: ["10.200.4.1"] },
      { port: 5432, sources: ["10.200.4.100", "10.200.4.1"] },
    ],
    ...overrides,
  };
}

/** A setup plan holding only the step with these fields. */
function setupWith(params: HostStep["params"]): { plan: HostPlan; step: HostStep } {
  const step: HostStep = {
    id: "network-filter",
    title: "Filter",
    state: "change",
    scope: "app",
    params,
  };
  return {
    plan: { schemaVersion: 1, purpose: "setup", app: "shop", steps: [step], findings: [] },
    step,
  };
}

function scriptsOf(params: HostStep["params"]) {
  const { plan, step } = setupWith(params);
  return stepScripts(plan, step);
}

/** The filter step's scripts for a removal in a teardown. */
function removalScripts(iface = "wg-opscrew0") {
  const step: HostStep = {
    id: "network-filter",
    title: "Remove",
    state: "change",
    scope: "app",
    params: { interface: iface, remove: true },
  };
  return stepScripts(
    { schemaVersion: 1, purpose: "teardown", app: "shop", steps: [step], findings: [] },
    step,
  );
}

describe("the network filter's parameters", () => {
  it("are kept flat, by port, with each port's sources sorted and without duplicates", () => {
    const fields = networkFilterFields(
      dbFilter({
        rules: [
          { port: 6379, sources: ["10.200.4.1"] },
          { port: 5432, sources: ["10.200.4.100", "10.200.4.1", "10.200.4.100"] },
          { port: 8090, sources: [] },
        ],
      }),
    );
    expect(fields).toEqual({
      interface: "wg-opscrew0",
      address: "10.200.4.2",
      rules: "5432=10.200.4.1,10.200.4.100 6379=10.200.4.1 8090=",
    });
  });

  it("refuse a port named twice, a bad address, interface or port", () => {
    const bad = [
      dbFilter({
        rules: [
          { port: 5432, sources: [] },
          { port: 5432, sources: ["10.200.4.1"] },
        ],
      }),
      dbFilter({ address: "10.200.4.2/24" }),
      dbFilter({ interface: "wg0" }),
      dbFilter({ rules: [{ port: 0, sources: [] }] }),
      dbFilter({ rules: [{ port: 5432, sources: ["10.200.4.1/32"] }] }),
      dbFilter({ rules: [{ port: 5432, sources: ["10.200.004.1"] }] }),
    ];
    for (const params of bad) {
      expect(NetworkFilterParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(
        false,
      );
    }
    expect(NetworkFilterParamsSchema.safeParse(dbFilter()).success).toBe(true);
  });
});

describe("the network filter's scripts", () => {
  it("match their snapshot (the script on the server, the unit, the drop-in, setup and removal)", () => {
    const setup = scriptsOf(networkFilterFields(dbFilter()));
    const removal = removalScripts();
    const all: Record<string, string> = {
      "server script": networkFilterScript(dbFilter()),
      "templated unit": NETWORK_FILTER_UNIT_TEXT,
      "Docker's drop-in": networkFilterDropIn("wg-opscrew0"),
      "setup check": setup.check,
      "setup apply": setup.apply,
      "setup verify": setup.verify,
      "removal check": removal.check,
      "removal apply": removal.apply,
      "removal verify": removal.verify,
      "readNetworkFilter's read": readNetworkFilterScript("wg-opscrew0"),
    };
    expect(all).toMatchSnapshot();
    for (const [name, script] of Object.entries(all)) {
      if (/unit|drop-in/.test(name)) continue;
      for (const command of [script, asRoot("sudo", script), pipedScript(script)]) {
        const syntax = shSyntax(command);
        if (syntax !== undefined) expect(syntax.ok, `${name}: ${syntax.stderr}`).toBe(true);
      }
    }
  });

  it("drop new connections to each port on any input interface unless they come from its sources", () => {
    const script = networkFilterScript(dbFilter());
    expect(script).toContain(
      [
        "-s 10.200.4.1/32 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 5432 --ctdir ORIGINAL -j ACCEPT",
        "-s 10.200.4.100/32 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 5432 --ctdir ORIGINAL -j ACCEPT",
        "-p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 5432 --ctdir ORIGINAL -j DROP",
        "-s 10.200.4.1/32 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 6379 --ctdir ORIGINAL -j ACCEPT",
        "-p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 6379 --ctdir ORIGINAL -j DROP",
      ].join("\n"),
    );
    expect(script).not.toMatch(/ -i /);
    // The web filter's refusal of Docker's nftables backend, naming this filter.
    expect(script).toContain(
      "which has no DOCKER-USER chain, so OpsCrew's network filter cannot work.",
    );
  });

  it("are a unit instance per interface that runs before Docker, which requires it", () => {
    expect(networkFilterScriptPath("wg-opscrew3")).toBe(
      "/usr/local/sbin/opscrew-network-filter-wg-opscrew3",
    );
    expect(NETWORK_FILTER_UNIT).toBe("/etc/systemd/system/opscrew-network-filter@.service");
    expect(NETWORK_FILTER_UNIT_TEXT).toContain(
      "ExecStart=/usr/local/sbin/opscrew-network-filter-%i",
    );
    expect(NETWORK_FILTER_UNIT_TEXT).toContain("Before=docker.service\n");
    expect(networkFilterDropInPath("wg-opscrew3")).toBe(
      "/etc/systemd/system/docker.service.d/opscrew-network-filter-wg-opscrew3.conf",
    );
    expect(networkFilterDropIn("wg-opscrew3")).toContain(
      "[Unit]\nRequires=opscrew-network-filter@wg-opscrew3.service\nAfter=opscrew-network-filter@wg-opscrew3.service\n",
    );
  });

  it("remove the filter for an empty rule list", () => {
    const empty = scriptsOf(networkFilterFields(dbFilter({ rules: [] })));
    expect(empty.apply).toBe(removalScripts().apply);
  });
});

describe.skipIf(!SH_AVAILABLE)("the network filter in a real shell (commands stubbed)", () => {
  /** iptables over files: `$S/iptables/<chain>` holds the chain's rules; `-I` honours its position. */
  const IPTABLES = `d="$S/iptables"
mkdir -p "$d"
if [ "$1" = -w ]; then shift; fi
if [ "$1" = -n ]; then shift; fi
op=$1
chain=$2
shift 2
f="$d/$chain"
case "$op" in
  -L) [ -e "$f" ] ;;
  -N) [ ! -e "$f" ] || exit 1; : > "$f" ;;
  -S) [ -e "$f" ] || exit 1; echo "-N $chain"; cat "$f" ;;
  -C) [ -e "$f" ] && grep -qxF -- "-A $chain $*" "$f" ;;
  -I)
    n=$1
    shift
    [ -e "$f" ] || exit 1
    awk -v n="$n" -v r="-A $chain $*" 'NR == n { print r } { print } END { if (NR < n) print r }' "$f" > "$f.new"
    mv "$f.new" "$f" ;;
  -D) [ -e "$f" ] || exit 1; awk -v r="-A $chain $*" 'done || $0 != r { print; next } { done = 1 }' "$f" > "$f.new"; mv "$f.new" "$f" ;;
  -F) : > "$f" ;;
  -X) if [ -s "$f" ] || grep -rqs -- "-j $chain\\$" "$d"; then exit 1; fi; rm -f "$f" ;;
  *) exit 2 ;;
esac`;
  const RESTORE = `d="$S/iptables"
mkdir -p "$d"
while IFS= read -r line; do
  case "$line" in
    :*) chain=\${line#:}; chain=\${chain%% *}; : > "$d/$chain" ;;
    "-A "*) chain=$(printf '%s\\n' "$line" | cut -d ' ' -f 2); printf '%s\\n' "$line" >> "$d/$chain" ;;
  esac
done`;
  const SYSTEMCTL = `cmd=$1
shift
for unit; do :; done
case "$cmd" in
  is-enabled) if [ -e "$S/enabled.$unit" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) [ -e "$S/active.$unit" ] ;;
  enable) touch "$S/enabled.$unit" ;;
  disable) rm -f "$S/enabled.$unit" ;;
  start) touch "$S/active.$unit" ;;
  stop) rm -f "$S/active.$unit" ;;
  *) exit 0 ;;
esac`;
  const WEB_JUMPS = [80, 443].map(
    (port) =>
      `-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport ${port} --ctdir ORIGINAL -j OPSCREW-WEB`,
  );
  const USER_RULE = "-A DOCKER-USER -s 10.0.0.0/8 -j ACCEPT";

  /** A server whose Docker runs, with the web filter's jumps and a rule of the user's. */
  function harness(): ShellHarness {
    const h = new ShellHarness();
    h.stub("iptables", IPTABLES);
    h.stub("iptables-restore", RESTORE);
    h.stub("systemctl", SYSTEMCTL);
    h.write("/state/active.docker", "");
    h.write("/state/iptables/DOCKER-USER", `${[...WEB_JUMPS, USER_RULE].join("\n")}\n`);
    return h;
  }
  const lines = (h: ShellHarness, path: string) =>
    (h.read(path) ?? "").split("\n").filter((line) => line !== "");

  it("installs the chain, jumps to it right after the web filter's jumps, then makes Docker require the unit", () => {
    const h = harness();
    try {
      const scripts = scriptsOf(networkFilterFields(dbFilter()));
      expect(h.run(scripts.check).stdout).toContain("state=change");
      const run = h.run(scripts.apply);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(lines(h, "/state/iptables/OPSCREW-wg-opscrew0")).toEqual([
        "-A OPSCREW-wg-opscrew0 -s 10.200.4.1/32 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 5432 --ctdir ORIGINAL -j ACCEPT",
        "-A OPSCREW-wg-opscrew0 -s 10.200.4.100/32 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 5432 --ctdir ORIGINAL -j ACCEPT",
        "-A OPSCREW-wg-opscrew0 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 5432 --ctdir ORIGINAL -j DROP",
        "-A OPSCREW-wg-opscrew0 -s 10.200.4.1/32 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 6379 --ctdir ORIGINAL -j ACCEPT",
        "-A OPSCREW-wg-opscrew0 -p tcp -m conntrack --ctstate NEW --ctorigdst 10.200.4.2 --ctorigdstport 6379 --ctdir ORIGINAL -j DROP",
      ]);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([
        ...WEB_JUMPS,
        "-A DOCKER-USER -j OPSCREW-wg-opscrew0",
        USER_RULE,
      ]);
      expect(h.read(networkFilterScriptPath("wg-opscrew0"))).toBe(networkFilterScript(dbFilter()));
      expect(h.read(NETWORK_FILTER_UNIT)).toBe(NETWORK_FILTER_UNIT_TEXT);
      expect(h.read(networkFilterDropInPath("wg-opscrew0"))).toBe(
        networkFilterDropIn("wg-opscrew0"),
      );
      expect(h.calls().filter((call) => /^systemctl (enable|start) /.test(call))).toEqual([
        "systemctl enable opscrew-network-filter@wg-opscrew0.service",
        "systemctl start opscrew-network-filter@wg-opscrew0.service",
      ]);
      expect(h.run(scripts.verify).status).toBe(0);
      expect(h.run(scripts.check).stdout).toContain("state=in-place");

      // Applied again (new sources): the chain is rebuilt and the jump is not added twice.
      const changed = scriptsOf(
        networkFilterFields(dbFilter({ rules: [{ port: 5432, sources: ["10.200.4.1"] }] })),
      );
      expect(h.run(changed.check).stdout).toContain("state=change");
      expect(h.run(changed.apply).status).toBe(0);
      expect(lines(h, "/state/iptables/OPSCREW-wg-opscrew0")).toHaveLength(2);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([
        ...WEB_JUMPS,
        "-A DOCKER-USER -j OPSCREW-wg-opscrew0",
        USER_RULE,
      ]);
      expect(h.run(changed.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("is not in place when a rule of the chain is missing or the jump is gone", () => {
    const h = harness();
    try {
      const scripts = scriptsOf(networkFilterFields(dbFilter()));
      expect(h.run(scripts.apply).status).toBe(0);
      const chain = lines(h, "/state/iptables/OPSCREW-wg-opscrew0");
      h.write("/state/iptables/OPSCREW-wg-opscrew0", `${chain.slice(1).join("\n")}\n`);
      expect(h.run(scripts.check).stdout).toContain("state=change");
      expect(h.run(scripts.verify).status).not.toBe(0);
      expect(h.run(scripts.apply).status).toBe(0);
      expect(h.run(scripts.verify).status).toBe(0);
      h.write("/state/iptables/DOCKER-USER", `${USER_RULE}\n`);
      expect(h.run(scripts.check).stdout).toContain("state=change");
    } finally {
      h.dispose();
    }
  });

  it("refuses Docker's nftables backend and a running Docker without DOCKER-USER, changing nothing", () => {
    const h = harness();
    try {
      const scripts = scriptsOf(networkFilterFields(dbFilter()));
      h.write("/etc/docker/daemon.json", '{ "firewall-backend": "nftables" }\n');
      const run = h.run(scripts.apply);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("nftables firewall backend");
      expect(run.stderr).toContain("OpsCrew's network filter cannot work");
      expect(h.exists(networkFilterScriptPath("wg-opscrew0"))).toBe(false);
      expect(h.exists(networkFilterDropInPath("wg-opscrew0"))).toBe(false);

      h.write("/etc/docker/daemon.json", "{}\n");
      h.run(`rm -f '${h.root}/state/iptables/DOCKER-USER'`);
      const missing = h.run(scripts.apply);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("no DOCKER-USER chain");
      expect(h.exists(networkFilterDropInPath("wg-opscrew0"))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it("makes DOCKER-USER itself at boot, before Docker", () => {
    const h = harness();
    try {
      const scripts = scriptsOf(networkFilterFields(dbFilter()));
      expect(h.run(scripts.apply).status).toBe(0);
      // A reboot: the rules are gone and Docker has not started yet.
      h.run(`rm -rf '${h.root}/state/iptables' '${h.root}/state/active.docker'`);
      const boot = h.run(
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\nsh /usr/local/sbin/opscrew-network-filter-wg-opscrew0",
      );
      expect(boot.stderr).toBe("");
      expect(boot.status).toBe(0);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([
        "-A DOCKER-USER -j OPSCREW-wg-opscrew0",
      ]);
      expect(lines(h, "/state/iptables/OPSCREW-wg-opscrew0")).toHaveLength(5);
    } finally {
      h.dispose();
    }
  });

  it("is removed with its jump, chain, unit instance and drop-in; the templated unit goes with the last filter", () => {
    const h = harness();
    try {
      const other = dbFilter({ interface: "wg-opscrew1", address: "10.200.9.2" });
      expect(h.run(scriptsOf(networkFilterFields(dbFilter())).apply).status).toBe(0);
      expect(h.run(scriptsOf(networkFilterFields(other)).apply).status).toBe(0);

      const removal = removalScripts("wg-opscrew0");
      expect(h.run(removal.check).stdout).toContain("state=change");
      const run = h.run(removal.apply);
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(h.exists("/state/iptables/OPSCREW-wg-opscrew0")).toBe(false);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([
        ...WEB_JUMPS,
        "-A DOCKER-USER -j OPSCREW-wg-opscrew1",
        USER_RULE,
      ]);
      expect(h.exists(networkFilterScriptPath("wg-opscrew0"))).toBe(false);
      expect(h.exists(networkFilterDropInPath("wg-opscrew0"))).toBe(false);
      expect(h.exists("/state/enabled.opscrew-network-filter@wg-opscrew0.service")).toBe(false);
      // Another interface still uses the templated unit.
      expect(h.exists(NETWORK_FILTER_UNIT)).toBe(true);
      expect(h.run(removal.verify).status).toBe(0);
      expect(h.run(removal.check).stdout).toContain("state=in-place");

      expect(h.run(removalScripts("wg-opscrew1").apply).status).toBe(0);
      expect(h.exists(NETWORK_FILTER_UNIT)).toBe(false);
      expect(lines(h, "/state/iptables/DOCKER-USER")).toEqual([...WEB_JUMPS, USER_RULE]);
      expect(h.run(removalScripts("wg-opscrew1").verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });
});

describe("planning the network filter", () => {
  async function dbServer(): Promise<FakeHost> {
    const fake = new FakeHost();
    await provision(fake);
    return fake;
  }

  it("hashes the files the network and filter steps write as inspection reads them", async () => {
    const fake = await dbServer();
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork(), filter: dbFilter() },
      COMMAND,
    );
    await applyApproved(fake, plan, { secrets: { wireguardKey: DB_KEY } });
    const facts = await inspectHost(fake);
    const network = facts.network;
    expect(facts.firewall.ufwRules).toEqual(expect.arrayContaining(networkUfwRules(dbNetwork())));
    const files = networkFileHashes(dbNetwork());
    const filter = networkFilterFileHashes(dbFilter());
    expect(network?.interfaces[0]?.config).toBe(files.config);
    expect(network?.dropIn).toBe(files.dropIn);
    expect(network?.filterUnit).toBe(filter.unit);
    expect(network?.filters[0]).toMatchObject({ script: filter.script, dropIn: filter.dropIn });
  });

  it("follows the network step, and an applied filter plans in place", async () => {
    const fake = await dbServer();
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork(), filter: dbFilter() },
      COMMAND,
    );
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["network", "change"],
      ["network-filter", "change"],
    ]);
    expect(plan.steps[1]).toMatchObject({
      scope: "app",
      title:
        "Let only the app's servers and the devices granted access reach TCP ports 5432 and 6379 on 10.200.4.2",
      params: networkFilterFields(dbFilter()),
    });
    await applyApproved(fake, plan, { secrets: { wireguardKey: DB_KEY } });
    expect(fake.networkFilters.get("wg-opscrew0")?.rules).toHaveLength(5);

    const again = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork(), filter: dbFilter() },
      COMMAND,
    );
    expect(again.steps.map((step) => step.state)).toEqual(["in-place", "in-place"]);
    // A new device granted Postgres changes the filter only.
    const granted = dbFilter({
      rules: [
        { port: 5432, sources: ["10.200.4.1", "10.200.4.100", "10.200.4.101"] },
        { port: 6379, sources: ["10.200.4.1"] },
      ],
    });
    const changed = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork(), filter: granted },
      COMMAND,
    );
    expect(changed.steps.map((step) => step.state)).toEqual(["in-place", "change"]);
  });

  it("removes the filter for an empty rule list, and plans nothing to remove when there is none", async () => {
    const fake = await dbServer();
    await applyApproved(
      fake,
      planNetwork(
        await inspectHost(fake),
        { app: "shop", network: dbNetwork(), filter: dbFilter() },
        COMMAND,
      ),
      { secrets: { wireguardKey: DB_KEY } },
    );
    const empty = dbFilter({ rules: [] });
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork({ localPorts: [] }), filter: empty },
      COMMAND,
    );
    expect(plan.steps[1]).toMatchObject({ id: "network-filter", state: "change" });
    await applyApproved(fake, plan);
    expect(fake.networkFilters.size).toBe(0);
    expect(fake.files.has(networkFilterScriptPath("wg-opscrew0"))).toBe(false);
    const after = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork({ localPorts: [] }), filter: empty },
      COMMAND,
    );
    expect(after.steps[1]).toMatchObject({ id: "network-filter", state: "in-place" });
  });

  it("refuses Docker's nftables backend with a finding, and a filter for another interface or address", async () => {
    const fake = await dbServer();
    fake.files.set("/etc/docker/daemon.json", '{ "firewall-backend": "nftables" }\n');
    fake.dockerFirewall = "nftables";
    const plan = planNetwork(
      await inspectHost(fake),
      { app: "shop", network: dbNetwork(), filter: dbFilter() },
      COMMAND,
    );
    expect(plan.findings.map((finding) => finding.code)).toEqual(["docker-nftables"]);
    expect(plan.findings[0]?.message).toContain("services published on the private network");
    expect(plan.steps.map((step) => step.state)).toEqual(["blocked", "blocked"]);

    const facts = await inspectHost(new FakeHost());
    for (const filter of [
      dbFilter({ interface: "wg-opscrew1" }),
      dbFilter({ address: "10.200.4.3" }),
    ]) {
      expect(() =>
        planNetwork(facts, { app: "shop", network: dbNetwork(), filter }, COMMAND),
      ).toThrow(
        /the private network's filter must be for this server's interface and private address/i,
      );
    }
  });

  it("is set up through Docker on a server OpsCrew created", async () => {
    const fake = cloudServer();
    fake.dockerAccess = true;
    const plan = planNetwork(
      await inspectHost(fake, { rootImage: IMAGE }),
      { app: "shop", network: dbNetwork(), filter: dbFilter() },
      COMMAND,
    );
    await applyApproved(fake, plan, { secrets: { wireguardKey: DB_KEY }, rootImage: IMAGE });
    const calls = fake.calls.filter((call) => call.name.startsWith("network-filter."));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.command).toBe(dockerRootCommand(IMAGE));
    expect(fake.networkFilters.has("wg-opscrew0")).toBe(true);
  });

  it("is removed by the app's teardown before its network", async () => {
    const fake = await dbServer();
    await applyApproved(
      fake,
      planNetwork(
        await inspectHost(fake),
        { app: "shop", network: dbNetwork(), filter: dbFilter() },
        COMMAND,
      ),
      { secrets: { wireguardKey: DB_KEY } },
    );
    const teardown = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT, repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy",
    );
    expect(teardown.steps.find((step) => step.id === "network-filter")).toMatchObject({
      state: "change",
      scope: "app",
      params: { interface: "wg-opscrew0", remove: true },
    });
    await applyApproved(fake, teardown, { command: "opscrew destroy" });
    expect(fake.networkFilters.size).toBe(0);
    expect(fake.files.has(NETWORK_FILTER_UNIT)).toBe(false);
    expect(fake.wireguard.size).toBe(0);
  });
});

describe("readNetworkFilter", () => {
  const LISTING = readFileSync(
    new URL("./__fixtures__/iptables-s-network-filter.txt", import.meta.url),
    "utf8",
  );

  /** A server that answers the read with `stdout`, recording the command and its stdin. */
  function server(stdout: string, exitCode = 0) {
    const calls: { command: string; input?: string }[] = [];
    const remote: RemoteExec = {
      host: "203.0.113.20",
      async run(command: string, options?: RemoteRunOptions): Promise<CommandResult> {
        calls.push({ command, ...(options?.input === undefined ? {} : { input: options.input }) });
        return {
          exitCode,
          stdout,
          stderr: exitCode === 0 ? "" : "opscrew: iptables is not installed on the server.\n",
        };
      },
    };
    return { remote, calls };
  }

  it("parses each filtered port with the sources accepted before its drop", async () => {
    const { remote, calls } = server(`jump yes\n${LISTING}`);
    expect(await readNetworkFilter(remote, "wg-opscrew0", "sudo")).toEqual([
      { port: 5432, sources: ["10.200.4.1", "10.200.4.100"] },
      { port: 6379, sources: ["10.200.4.1"] },
      // 8090: the source accepted after the drop does not count; 9200 accepts everyone.
      { port: 8090, sources: [] },
    ]);
    expect(calls[0]?.command).toMatch(/^sudo -n sh -c '# opscrew-host: network-filter\.read\n/);
    expect(calls[0]?.command).toContain("OPSCREW-wg-opscrew0");
  });

  it("is undefined when the chain does not exist or DOCKER-USER does not jump to it", async () => {
    expect(
      await readNetworkFilter(server("jump no\n").remote, "wg-opscrew0", "root"),
    ).toBeUndefined();
    expect(
      await readNetworkFilter(server(`jump no\n${LISTING}`).remote, "wg-opscrew0", "root"),
    ).toBeUndefined();
    expect(
      await readNetworkFilter(server("jump yes\n").remote, "wg-opscrew0", "root"),
    ).toBeUndefined();
  });

  it("reads through Docker with the image, and fails plainly when the server cannot read it", async () => {
    const { remote, calls } = server(`jump yes\n${LISTING}`);
    await readNetworkFilter(remote, "wg-opscrew0", "docker", IMAGE);
    expect(calls[0]?.command).toBe(dockerRootCommand(IMAGE));
    expect(calls[0]?.input).toContain("# opscrew-host: network-filter.read");
    await expect(readNetworkFilter(server("", 3).remote, "wg-opscrew0", "root")).rejects.toThrow(
      "iptables is not installed on the server.",
    );
    await expect(readNetworkFilter(remote, "eth0", "root")).rejects.toThrow(
      /not one of OpsCrew's WireGuard interfaces/,
    );
  });

  it("parses what the step installs back to the step's rules", () => {
    const script = networkFilterScript(dbFilter());
    const specs = /cat <<'OPSCREW_RULES'\n([\s\S]*?)\nOPSCREW_RULES/.exec(script)?.[1] ?? "";
    const listing = specs.split("\n").map((spec) => `-A OPSCREW-wg-opscrew0 ${spec}`);
    expect(parseNetworkFilterRules(listing)).toEqual([
      { port: 5432, sources: ["10.200.4.1", "10.200.4.100"] },
      { port: 6379, sources: ["10.200.4.1"] },
    ]);
  });
});
