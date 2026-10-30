import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testKeyMaker } from "../testing";
import { splitPlan, withNetwork } from "./__fixtures__/plans";
import { allocateNetwork } from "./allocate";
import { deviceConfig } from "./device";
import { networkSteps, wireGuardEndpoint } from "./steps";

const APP_IP = "203.0.113.10";
const DATA_IP = "203.0.113.20";
const OWN_FACTS = { app: { udpPortsInUse: [], wireguardInterfaces: [] } };

/** A split plan on the network, with a laptop granted read-only Postgres and a phone with no grant. */
function planWithDevices(app: "cloud" | "own-tunnel" = "cloud") {
  const keys = testKeyMaker(app);
  const plan = splitPlan({ app });
  const { network, privateKeys } = allocateNetwork(plan, app === "cloud" ? {} : OWN_FACTS, keys);
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
