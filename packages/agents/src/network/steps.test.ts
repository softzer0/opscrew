import {
  type DeployPlan,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  networkInterface,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testKeyMaker } from "../testing";
import { monitoredPlan, senderPlan, splitPlan, withNetwork } from "./__fixtures__/plans";
import { allocateNetwork, type NetworkHostFacts } from "./allocate";
import { deviceConfig } from "./device";
import { networkFilterRules, networkRemovalSteps, networkSteps, wireGuardEndpoint } from "./steps";

const APP_IP = "203.0.113.10";
const DATA_IP = "203.0.113.20";
const MONITORING_IP = "203.0.113.30";
const OWN_FACTS = { app: { udpPortsInUse: [], wireguardInterfaces: [] } };

/**
 * A split plan (or `plan`) on the network, allocated with `facts`, with a laptop granted read-only
 * Postgres and a phone with no grant.
 */
function planWithDevices(
  app: "cloud" | "own-tunnel" = "cloud",
  plan: Omit<DeployPlan, "network"> = splitPlan({ app }),
  facts: Readonly<Record<string, NetworkHostFacts>> = app === "cloud" ? {} : OWN_FACTS,
) {
  const keys = testKeyMaker(`${app}-${plan.app.name}`);
  const { network, privateKeys } = allocateNetwork(plan, facts, keys);
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const devices = ["laptop", "phone"].map((name, i) => ({
    name,
    address: `${prefix}.${100 + i}`,
    publicKey: keys().publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  }));
  const full = withNetwork(plan, {
    ...network,
    devices,
    grants: [{ device: "laptop", service: "db", access: "read-only" }],
  });
  return { plan: full, prefix, keys, privateKeys };
}

function member(plan: DeployPlan, name: string) {
  const found = plan.network?.members.find((m) => m.name === name);
  if (found === undefined) throw new Error(name);
  return found;
}

describe("networkSteps", () => {
  it("links a server with a public address to the other servers and every device", () => {
    const { plan, prefix, keys } = planWithDevices();
    const app = member(plan, "app");
    const data = member(plan, "data");
    const steps = networkSteps(plan, "data", {
      endpoints: { app: APP_IP, data: DATA_IP },
      wireguardInterfaces: [],
      published: [{ service: "db", port: 5432 }],
      sshPort: 22,
    });
    expect(steps.network).toEqual({
      interface: "wg-opscrew0",
      address: `${prefix}.2/24`,
      port: 51820,
      publicKey: data.publicKey,
      // Every link between servers keeps itself alive; a device's configuration does that itself.
      peers: [
        {
          name: "app",
          publicKey: app.publicKey,
          endpoint: `${APP_IP}:51820`,
          allowedIp: `${prefix}.1/32`,
          keepalive: 25,
        },
        { name: "laptop", publicKey: keys.made[2]?.publicKey, allowedIp: `${prefix}.100/32` },
        { name: "phone", publicKey: keys.made[3]?.publicKey, allowedIp: `${prefix}.101/32` },
      ],
      otherInterfaces: [],
      sshPort: 22,
    });
    expect(steps.filter).toEqual({
      interface: "wg-opscrew0",
      address: `${prefix}.2`,
      rules: [{ port: 5432, sources: [`${prefix}.1`, `${prefix}.100`] }],
    });
    // No private key in either step's params.
    const text = JSON.stringify(steps);
    for (const pair of keys.made) expect(text).not.toContain(pair.privateKey);
  });

  it("gives a server without a public address no endpoint and no device", () => {
    const { plan, prefix } = planWithDevices("own-tunnel");
    const facts = { endpoints: { data: DATA_IP }, published: [], sshPort: 2222 };
    const app = networkSteps(plan, "app", {
      ...facts,
      wireguardInterfaces: ["wg0", "wg-opscrew0", "wg-opscrew3"],
    });
    expect(app.network.peers).toEqual([
      {
        name: "data",
        publicKey: member(plan, "data").publicKey,
        endpoint: `${DATA_IP}:51820`,
        allowedIp: `${prefix}.2/32`,
        keepalive: 25,
      },
    ]);
    // Docker's drop-in waits for the host's other OpsCrew interfaces, never the user's own.
    expect(app.network.otherInterfaces).toEqual(["wg-opscrew3"]);
    expect(app.network.sshPort).toBe(2222);
    expect(app.filter.rules).toEqual([]);
    const data = networkSteps(plan, "data", { ...facts, wireguardInterfaces: [], sshPort: 22 });
    expect(data.network.peers[0]).toEqual({
      name: "app",
      publicKey: member(plan, "app").publicKey,
      allowedIp: `${prefix}.1/32`,
      keepalive: 25,
    });
  });

  it("opens a dashboard's port to every device, and nothing else", () => {
    const { plan, prefix } = planWithDevices();
    const steps = networkSteps(plan, "app", {
      endpoints: { app: APP_IP, data: DATA_IP },
      wireguardInterfaces: [],
      published: [
        { service: "beszel", port: 8090, dashboard: true },
        { service: "db", port: 5432 },
      ],
      sshPort: 22,
    });
    expect(steps.filter.rules).toEqual([
      { port: 8090, sources: [`${prefix}.100`, `${prefix}.101`] },
      { port: 5432, sources: [`${prefix}.1`, `${prefix}.100`] },
    ]);
  });

  it("admits no device on a server without a public address: none can reach it", () => {
    const { plan, prefix } = planWithDevices("own-tunnel");
    const steps = networkSteps(plan, "app", {
      endpoints: { data: DATA_IP },
      wireguardInterfaces: [],
      published: [
        { service: "beszel", port: 8090, dashboard: true },
        { service: "db", port: 5432 },
      ],
      sshPort: 22,
    });
    expect(steps.filter.rules).toEqual([
      { port: 8090, sources: [] },
      { port: 5432, sources: [`${prefix}.1`] },
    ]);
  });

  it("refuses a server that is not on the network", () => {
    const { plan } = planWithDevices();
    expect(() =>
      networkSteps(plan, "nope", {
        endpoints: {},
        wireguardInterfaces: [],
        published: [],
        sshPort: 22,
      }),
    ).toThrow('Server "nope" is not on the plan\'s private network.');
  });
});

describe("the monitoring server on the network", () => {
  /** The shared monitoring server: its owner's network on wg-opscrew0. */
  const SHARED_FACTS = {
    monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
  };
  const PUBLISHED = {
    app: [{ service: "beszel", port: 8090, dashboard: true }],
    data: [{ service: "db", port: 5432 }],
  };

  /** Every address a server's rules admit. */
  function admitted(plan: DeployPlan, server: "app" | "data"): string[] {
    return networkFilterRules(plan, server, PUBLISHED[server]).flatMap((rule) => rule.sources);
  }

  it("on its own server: the servers push to the front, only the devices open Grafana, nothing admits it", () => {
    const { plan, prefix } = planWithDevices("cloud", monitoredPlan());
    expect(member(plan, "monitoring").address).toBe(`${prefix}.3`);
    expect(networkFilterRules(plan, "monitoring", [])).toEqual([
      { port: MONITORING_PUSH_PORT, sources: [`${prefix}.1`, `${prefix}.2`] },
      { port: MONITORING_GRAFANA_PORT, sources: [`${prefix}.100`, `${prefix}.101`] },
    ]);
    // The app's and data's rules stay 018's: the monitoring server only receives.
    expect(networkFilterRules(plan, "app", PUBLISHED.app)).toEqual([
      { port: 8090, sources: [`${prefix}.100`, `${prefix}.101`] },
    ]);
    expect(networkFilterRules(plan, "data", PUBLISHED.data)).toEqual([
      { port: 5432, sources: [`${prefix}.1`, `${prefix}.100`] },
    ]);
    for (const server of ["app", "data"] as const) {
      expect(admitted(plan, server)).not.toContain(`${prefix}.3`);
    }
  });

  it("on the app's server: the extra servers push to it, and the app still reaches its services", () => {
    const { plan, prefix } = planWithDevices("cloud", monitoredPlan({ on: "app" }));
    expect(networkFilterRules(plan, "app", PUBLISHED.app)).toEqual([
      { port: 8090, sources: [`${prefix}.100`, `${prefix}.101`] },
      { port: MONITORING_PUSH_PORT, sources: [`${prefix}.2`] },
      { port: MONITORING_GRAFANA_PORT, sources: [`${prefix}.100`, `${prefix}.101`] },
    ]);
    expect(networkFilterRules(plan, "data", PUBLISHED.data)).toEqual([
      { port: 5432, sources: [`${prefix}.1`, `${prefix}.100`] },
    ]);
    // Behind a Cloudflare Tunnel no device reaches the app's server: Grafana admits none.
    const tunnel = planWithDevices("own-tunnel", monitoredPlan({ on: "app", app: "own-tunnel" }));
    expect(networkFilterRules(tunnel.plan, "app", [])).toEqual([
      { port: MONITORING_PUSH_PORT, sources: [`${tunnel.prefix}.2`] },
      { port: MONITORING_GRAFANA_PORT, sources: [] },
    ]);
  });

  it("on a shared server: each interface gets its own network's peers and rules", () => {
    const owner = planWithDevices("cloud", monitoredPlan());
    const sender = planWithDevices("cloud", senderPlan(), SHARED_FACTS);
    const o = owner.prefix;
    const s = sender.prefix;
    expect(s).not.toBe(o);
    const onServer = {
      wireguardInterfaces: ["wg0", "wg-opscrew0", "wg-opscrew1"],
      published: [],
      sshPort: 22,
    };
    const ownerSteps = networkSteps(owner.plan, "monitoring", {
      ...onServer,
      endpoints: { app: APP_IP, data: DATA_IP, monitoring: MONITORING_IP },
    });
    const senderSteps = networkSteps(sender.plan, "monitoring", {
      ...onServer,
      endpoints: { app: "203.0.113.11", data: "203.0.113.21", monitoring: MONITORING_IP },
    });
    expect(ownerSteps.network).toMatchObject({
      interface: "wg-opscrew0",
      address: `${o}.3/24`,
      otherInterfaces: ["wg-opscrew1"],
    });
    expect(ownerSteps.filter).toEqual({
      interface: "wg-opscrew0",
      address: `${o}.3`,
      rules: [
        { port: MONITORING_PUSH_PORT, sources: [`${o}.1`, `${o}.2`] },
        { port: MONITORING_GRAFANA_PORT, sources: [`${o}.100`, `${o}.101`] },
      ],
    });
    const outside = member(sender.plan, "monitoring");
    expect(senderSteps.network).toEqual({
      interface: "wg-opscrew1",
      address: `${s}.3/24`,
      port: 51821,
      publicKey: outside.publicKey,
      peers: [
        {
          name: "app",
          publicKey: member(sender.plan, "app").publicKey,
          endpoint: "203.0.113.11:51820",
          allowedIp: `${s}.1/32`,
          keepalive: 25,
        },
        {
          name: "data",
          publicKey: member(sender.plan, "data").publicKey,
          endpoint: "203.0.113.21:51820",
          allowedIp: `${s}.2/32`,
          keepalive: 25,
        },
        { name: "laptop", publicKey: sender.keys.made[3]?.publicKey, allowedIp: `${s}.100/32` },
        { name: "phone", publicKey: sender.keys.made[4]?.publicKey, allowedIp: `${s}.101/32` },
      ],
      otherInterfaces: ["wg-opscrew0"],
      sshPort: 22,
    });
    expect(senderSteps.filter).toEqual({
      interface: "wg-opscrew1",
      address: `${s}.3`,
      rules: [
        { port: MONITORING_PUSH_PORT, sources: [`${s}.1`, `${s}.2`] },
        { port: MONITORING_GRAFANA_PORT, sources: [`${s}.100`, `${s}.101`] },
      ],
    });
    // The sender's servers link to it at its public address, on its port there, and never admit it.
    const app = networkSteps(sender.plan, "app", {
      endpoints: { app: "203.0.113.11", data: "203.0.113.21", monitoring: MONITORING_IP },
      wireguardInterfaces: [],
      published: PUBLISHED.app,
      sshPort: 22,
    });
    expect(app.network.peers).toContainEqual({
      name: "monitoring",
      publicKey: outside.publicKey,
      endpoint: `${MONITORING_IP}:51821`,
      allowedIp: `${s}.3/32`,
      keepalive: 25,
    });
    for (const server of ["app", "data"] as const) {
      expect(admitted(sender.plan, server)).not.toContain(`${s}.3`);
    }
    // No private key in any step's params, the outside member's included.
    const text = JSON.stringify([ownerSteps, senderSteps, app]);
    for (const pair of [...owner.keys.made, ...sender.keys.made]) {
      expect(text).not.toContain(pair.privateKey);
    }
    expect(sender.privateKeys.monitoring).toBe(sender.keys.made[2]?.privateKey);
  });

  it("gives the removal params of a member's interface once it leaves", () => {
    const { plan } = planWithDevices("cloud", senderPlan(), SHARED_FACTS);
    const iface = networkInterface(member(plan, "monitoring"));
    expect(
      networkRemovalSteps(iface, { wireguardInterfaces: ["wg0", "wg-opscrew0", "wg-opscrew1"] }),
    ).toEqual({
      network: { interface: "wg-opscrew1", remove: true, otherInterfaces: ["wg-opscrew0"] },
      filter: { interface: "wg-opscrew1", remove: true },
    });
  });
});

describe("wireGuardEndpoint", () => {
  it("puts an IPv6 address in brackets", () => {
    expect(wireGuardEndpoint("203.0.113.10", 51820)).toBe("203.0.113.10:51820");
    expect(wireGuardEndpoint("2001:db8::10", 51821)).toBe("[2001:db8::10]:51821");
    expect(wireGuardEndpoint("box.example.com", 51820)).toBe("box.example.com:51820");
  });
});

describe("deviceConfig", () => {
  it("writes the device's key and address, and a peer per server with a public address", () => {
    const { plan, prefix, keys } = planWithDevices("own-tunnel");
    const devicePrivate = testKeyMaker("laptop")().privateKey;
    const text = deviceConfig(plan, "laptop", devicePrivate, { data: DATA_IP });
    expect(text).toBe(
      [
        "# OpsCrew: shop's private network, device laptop",
        "[Interface]",
        `PrivateKey = ${devicePrivate}`,
        `Address = ${prefix}.100/32`,
        "",
        "[Peer]",
        "# data",
        `PublicKey = ${member(plan, "data").publicKey}`,
        `Endpoint = ${DATA_IP}:51820`,
        `AllowedIPs = ${prefix}.2/32`,
        "PersistentKeepalive = 25",
        "",
      ].join("\n"),
    );
    // Only the device's own private key: never a server's.
    for (const pair of keys.made) expect(text).not.toContain(pair.privateKey);
  });

  it("refuses a device that is not on the network", () => {
    const { plan } = planWithDevices();
    expect(() => deviceConfig(plan, "tablet", "x", {})).toThrow(
      'Device "tablet" is not on the plan\'s private network.',
    );
  });
});
