/** The private network while a move gives the app another app server (feature 023, plan.md "7."). */
import { type DeployPlan, MONITORING_PUSH_PORT, type NetworkMember } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { updateServerAddresses } from "../shared/server-record";
import { createTestPhaseDeps, testKeyMaker } from "../testing";
import { monitoredPlan, networked, splitPlan } from "./__fixtures__/plans";
import { moveAppMember } from "./allocate";
import { PREVIOUS_MEMBER, publicEndpoints } from "./endpoints";
import { networkFilterRules, networkSteps } from "./steps";

const OLD_IP = "203.0.113.10";
const NEW_IP = "198.51.100.10";
const DATA_IP = "203.0.113.20";

/** `plan` moving to a DigitalOcean app server: a new `app` member, the old one kept by the move. */
function moving(plan: DeployPlan): { plan: DeployPlan; old: NetworkMember; fresh: NetworkMember } {
  const network = plan.network;
  const old = network?.members.find((m) => m.name === "app");
  if (network === undefined || old === undefined) throw new Error("no network");
  const { member: fresh } = moveAppMember(network, undefined, testKeyMaker("moved"));
  return {
    old,
    fresh,
    plan: {
      ...plan,
      target: {
        provider: "digitalocean",
        mode: "vps-compose",
        location: "fra1",
        serverType: "s-2vcpu-4gb",
        image: "ubuntu-24-04-x64",
        backups: false,
        edge: "caddy",
      },
      network: {
        ...network,
        members: network.members.map((m) => (m.name === "app" ? fresh : m)),
      },
      retarget: {
        from: { target: plan.target, deploy: plan.deploy, member: old },
        step: "created",
        empty: [],
        startedAt: "2026-11-06T10:00:00.000Z",
      },
    },
  };
}

const facts = {
  endpoints: { app: NEW_IP, data: DATA_IP, [PREVIOUS_MEMBER]: OLD_IP },
  wireguardInterfaces: [],
  published: [{ service: "db", port: 5432 }],
  sshPort: 22,
};

describe("moveAppMember", () => {
  it("gives the new app server the first free server address, port 51820 and a new key", () => {
    const { plan } = networked(splitPlan());
    const keys = testKeyMaker("moved");
    const { member, privateKey } = moveAppMember(plan.network as never, undefined, keys);
    const prefix = plan.network?.range.split(".").slice(0, 3).join(".");
    // .1 is the old app server's, .2 the data server's.
    expect(member).toEqual({
      name: "app",
      address: `${prefix}.3`,
      port: 51820,
      publicKey: keys.made[0]?.publicKey,
    });
    expect(privateKey).toBe(keys.made[0]?.privateKey);
  });

  it("takes the first port the user's own new server leaves free", () => {
    const { plan } = networked(splitPlan());
    const own = { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew1"] };
    expect(moveAppMember(plan.network as never, own, testKeyMaker()).member.port).toBe(51822);
  });
});

describe("networkSteps during a move", () => {
  it("links an extra server to the new app server and still to the old one", () => {
    const { plan, old, fresh } = moving(networked(splitPlan()).plan);
    const steps = networkSteps(plan, "data", facts);
    expect(steps.network.peers).toEqual([
      expect.objectContaining({
        name: "app",
        publicKey: fresh.publicKey,
        endpoint: `${NEW_IP}:51820`,
        allowedIp: `${fresh.address}/32`,
      }),
      expect.objectContaining({
        name: PREVIOUS_MEMBER,
        publicKey: old.publicKey,
        endpoint: `${OLD_IP}:51820`,
        allowedIp: `${old.address}/32`,
      }),
    ]);
    // Postgres admits both app servers until --finish.
    expect(steps.filter.rules).toEqual([{ port: 5432, sources: [fresh.address, old.address] }]);
  });

  it("links the new app server to the other servers only, never to the old one", () => {
    const { plan } = moving(networked(splitPlan()).plan);
    const steps = networkSteps(plan, "app", { ...facts, published: [] });
    expect(steps.network.peers.map((p) => p.name)).toEqual(["data"]);
  });

  it("lets both app servers push to a monitoring server of its own", () => {
    const { plan, old, fresh } = moving(networked(monitoredPlan()).plan);
    const data = plan.network?.members.find((m) => m.name === "data")?.address;
    const rules = networkFilterRules(plan, "monitoring", []);
    expect(rules).toContainEqual({
      port: MONITORING_PUSH_PORT,
      sources: [fresh.address, data, old.address],
    });
  });

  it("drops the old app server once the move no longer holds its member", () => {
    const { plan } = moving(networked(splitPlan()).plan);
    const { member: _gone, ...from } = plan.retarget?.from ?? ({} as never);
    const left = { ...plan, retarget: { ...plan.retarget, from } } as DeployPlan;
    expect(networkSteps(left, "data", facts).network.peers.map((p) => p.name)).toEqual(["app"]);
  });
});

describe("publicEndpoints during a move", () => {
  it("reaches the new app server at the move's new address and the old one as previous", async () => {
    const { plan } = moving(networked(splitPlan()).plan);
    const deps = await createTestPhaseDeps();
    await updateServerAddresses(deps.paths, () => ({
      schemaVersion: 1,
      deployment: { ipv4: OLD_IP },
      servers: { data: { ipv4: DATA_IP } },
      retarget: { from: { ipv4: OLD_IP }, next: { ipv4: NEW_IP } },
    }));
    expect(await publicEndpoints(deps, plan)).toEqual({
      app: NEW_IP,
      data: DATA_IP,
      [PREVIOUS_MEMBER]: OLD_IP,
    });
  });

  it("reaches the user's own old server at its public address", async () => {
    const own = { app: { udpPortsInUse: [], wireguardInterfaces: [] } };
    const base = networked(splitPlan({ app: "own" }), own).plan;
    const { plan } = moving(base);
    const deps = await createTestPhaseDeps();
    await updateServerAddresses(deps.paths, () => ({
      schemaVersion: 1,
      servers: { data: { ipv4: DATA_IP } },
      retarget: {
        from: { ipv4: "192.168.1.20" },
        next: { ipv4: NEW_IP },
        fromOwn: {
          host: "box.example.com",
          port: 22,
          user: "root",
          agent: true,
          publicIpv4: OLD_IP,
        },
      },
    }));
    expect((await publicEndpoints(deps, plan))[PREVIOUS_MEMBER]).toBe(OLD_IP);
  });
});
