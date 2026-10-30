import { createPrivateKey, createPublicKey } from "node:crypto";
import { NetworkSchema, WireGuardKeySchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testKeyMaker } from "../testing";
import { splitPlan, withNetwork } from "./__fixtures__/plans";
import { allocateNetwork, networkRange, nextDeviceAddress } from "./allocate";
import { x25519KeyPair } from "./keys";

/** The number of an IPv4 address. */
function n(address: string): number {
  return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

const DATA_SERVER = {
  name: "data",
  target: {
    provider: "hetzner",
    mode: "vps-compose",
    location: "nbg1",
    serverType: "cx23",
    backups: true,
  },
} as const;

describe("x25519KeyPair", () => {
  it("makes a WireGuard pair: base64 of 32 bytes, the public key derived from the private one", () => {
    const pair = x25519KeyPair();
    expect(WireGuardKeySchema.safeParse(pair.publicKey).success).toBe(true);
    expect(WireGuardKeySchema.safeParse(pair.privateKey).success).toBe(true);
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      Buffer.from(pair.privateKey, "base64"),
    ]);
    const x = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({
      format: "jwk",
    }).x;
    expect(Buffer.from(x ?? "", "base64url").toString("base64")).toBe(pair.publicKey);
    expect(x25519KeyPair().privateKey).not.toBe(pair.privateKey);
  });
});

describe("networkRange", () => {
  it("picks a /24 inside 10.200.0.0/13 from the app and environment, the same every time", () => {
    const plan = splitPlan();
    const range = networkRange(plan);
    expect(range).toMatch(/^10\.20[0-7]\.\d+\.0\/24$/);
    expect(networkRange(plan)).toBe(range);
    const staging = networkRange({
      app: { ...plan.app, name: "shop-staging" },
      environment: { name: "staging", deploySource: { from: "main" }, runner: "github" },
    });
    const other = networkRange({ app: { ...plan.app, key: "admin" }, environment: undefined });
    expect(new Set([range, staging, other]).size).toBe(3);
    // The environment alone, the app's name and key unchanged.
    const environmentOnly = networkRange({
      app: plan.app,
      environment: { name: "staging", deploySource: { from: "main" }, runner: "github" },
    });
    expect(environmentOnly).not.toBe(range);
    expect(environmentOnly).not.toBe(staging);
  });
});

describe("allocateNetwork", () => {
  it("makes the network: app at .1, servers from .2 in plan order, port 51820, a key each", () => {
    const keys = testKeyMaker();
    const plan = {
      ...splitPlan(),
      servers: [...(splitPlan().servers ?? []), { ...DATA_SERVER, name: "queue" }],
    };
    const { network, privateKeys } = allocateNetwork(plan, {}, keys);
    const base = n(network.range.split("/")[0] ?? "");
    expect(network.members.map((m) => [m.name, n(m.address) - base, m.port])).toEqual([
      ["app", 1, 51820],
      ["data", 2, 51820],
      ["queue", 3, 51820],
    ]);
    expect(network.members.map((m) => m.publicKey)).toEqual(keys.made.map((k) => k.publicKey));
    expect(privateKeys).toEqual({
      app: keys.made[0]?.privateKey,
      data: keys.made[1]?.privateKey,
      queue: keys.made[2]?.privateKey,
    });
    expect(network).toMatchObject({ devices: [], grants: [], publicSsh: true });
    expect(NetworkSchema.parse(network)).toEqual(network);
    // The plan carries only public keys.
    const text = JSON.stringify(network);
    for (const pair of keys.made) expect(text).not.toContain(pair.privateKey);
  });

  it("gives the user's own server the first port its facts show free", () => {
    const plan = splitPlan({ app: "own", data: "own" });
    const { network } = allocateNetwork(
      plan,
      {
        app: { udpPortsInUse: [51820, 51821], wireguardInterfaces: ["wg0", "wg-opscrew2"] },
        data: { udpPortsInUse: [53], wireguardInterfaces: [] },
      },
      testKeyMaker(),
    );
    expect(network.members.map((m) => [m.name, m.port])).toEqual([
      ["app", 51823],
      ["data", 51820],
    ]);
  });

  it("needs the facts of a new member on the user's own server", () => {
    expect(() => allocateNetwork(splitPlan({ data: "own" }), {}, testKeyMaker())).toThrow(
      "Server data is the user's own",
    );
  });

  it("keeps every existing address, port and key, and the devices, grants and public SSH", () => {
    const first = allocateNetwork(splitPlan(), {}, testKeyMaker("first"));
    const device = {
      name: "laptop",
      address: nextDeviceAddress(first.network),
      publicKey: testKeyMaker("device")().publicKey,
      addedAt: "2026-10-30T10:00:00.000Z",
    };
    const network = {
      ...first.network,
      members: first.network.members.map((m) => (m.name === "data" ? { ...m, port: 51822 } : m)),
      devices: [device],
      grants: [{ device: "laptop", service: "db", access: "read-only" as const }],
      publicSsh: false,
    };
    const plan = withNetwork(splitPlan(), network);
    const keys = testKeyMaker("again");
    const again = allocateNetwork(plan, {}, keys);
    expect(again.network).toEqual(network);
    expect(again.privateKeys).toEqual({});
    expect(keys.made).toEqual([]);
  });

  it("adds a new server at the first free address and drops a server the plan no longer has", () => {
    const first = allocateNetwork(
      {
        ...splitPlan(),
        servers: [
          ...(splitPlan().servers ?? []),
          { ...DATA_SERVER, name: "queue" },
          { ...DATA_SERVER, name: "search" },
        ],
      },
      {},
      testKeyMaker("first"),
    );
    // `queue` (.3) leaves; `logs` takes its address, `search` keeps .4.
    const plan = {
      ...splitPlan(),
      servers: [
        ...(splitPlan().servers ?? []),
        { ...DATA_SERVER, name: "search" },
        { ...DATA_SERVER, name: "logs" },
      ],
      network: first.network,
    };
    const keys = testKeyMaker("second");
    const { network, privateKeys } = allocateNetwork(plan, {}, keys);
    const base = n(network.range.split("/")[0] ?? "");
    expect(network.members.map((m) => [m.name, n(m.address) - base])).toEqual([
      ["app", 1],
      ["data", 2],
      ["search", 4],
      ["logs", 3],
    ]);
    expect(Object.keys(privateKeys)).toEqual(["logs"]);
    expect(network.members.find((m) => m.name === "search")).toEqual(
      first.network.members.find((m) => m.name === "search"),
    );
  });
});

describe("nextDeviceAddress", () => {
  it("gives the first free address from .100", () => {
    const { network } = allocateNetwork(splitPlan(), {}, testKeyMaker());
    const base = n(network.range.split("/")[0] ?? "");
    const at = (host: number) => ({
      name: `d${host}`,
      address: [24, 16, 8, 0].map((s) => Math.floor((base + host) / 2 ** s) % 256).join("."),
      publicKey: network.members[0]?.publicKey ?? "",
      addedAt: "2026-10-30T10:00:00.000Z",
    });
    expect(n(nextDeviceAddress(network)) - base).toBe(100);
    expect(n(nextDeviceAddress({ ...network, devices: [at(100), at(102)] })) - base).toBe(101);
    const full = Array.from({ length: 155 }, (_, i) => at(100 + i));
    expect(() => nextDeviceAddress({ ...network, devices: full })).toThrow(
      "has no free address for another device",
    );
  });
});
