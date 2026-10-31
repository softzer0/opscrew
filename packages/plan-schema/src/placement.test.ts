// Feature 018: split placement and the private network, `servers`, `services[].server`,
// `network`, `deployment.placement` and `move` (T1801a, ADR 0022).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  APP_SERVER,
  DeployPlanSchema,
  DeviceNameSchema,
  ExtraServerSchema,
  GRANTABLE_KINDS,
  inPrivateNetworks,
  MoveSchema,
  NetworkSchema,
  networkInterface,
  parseArtifact,
  ServerNameSchema,
  serializeArtifact,
  serverOfService,
  servicesOn,
  WireGuardKeySchema,
} from "./index";
import { toJsonSchemas } from "./json-schema";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

/** A WireGuard public key, made up at runtime. */
const key = () => randomBytes(32).toString("base64");

const addedAt = "2026-10-30T12:00:00.000Z";

/** The fixture's plan on Hetzner, as parsed. */
async function serverPlan() {
  return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
}

const valkey = {
  name: "cache",
  kind: "valkey",
  version: "8.1",
  memoryMb: 128,
  options: { mode: "cache" },
  reason: "The app uses ioredis.",
  licence: "BSD-3-Clause",
};
const kafka = {
  name: "events",
  kind: "kafka",
  version: "4.0",
  memoryMb: 1024,
  options: {},
  reason: "The app uses kafkajs.",
  licence: "Apache-2.0",
};

/**
 * The fixture's plan split over three servers: Postgres (`db`) on a Hetzner server `data`, Valkey
 * (`cache`) on the user's own server `box`, the app on its own; a laptop on the network with
 * read-only access to Postgres.
 */
async function splitPlan(overrides: Record<string, unknown> = {}) {
  const plan = await serverPlan();
  return {
    ...plan,
    servers: [
      {
        name: "data",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "hel1",
          serverType: "cpx32",
          backups: true,
        },
      },
      { name: "box", target: { provider: "own", mode: "vps-compose", arch: "amd64" } },
    ],
    services: [
      { ...plan.services[0], server: "data" },
      { ...valkey, server: "box" },
    ],
    network: {
      range: "10.200.4.0/24",
      members: [
        { name: "app", address: "10.200.4.1", port: 51820, publicKey: key() },
        { name: "data", address: "10.200.4.2", port: 51820, publicKey: key() },
        { name: "box", address: "10.200.4.3", port: 51821, publicKey: key() },
      ],
      devices: [{ name: "laptop", address: "10.200.4.100", publicKey: key(), addedAt }],
      grants: [{ device: "laptop", service: "db", access: "read-only" }],
    },
    ...overrides,
  };
}

type SplitPlan = Awaited<ReturnType<typeof splitPlan>>;

/** The split plan with `network` changed by `change`. */
async function withNetwork(change: (network: SplitPlan["network"]) => Record<string, unknown>) {
  const plan = await splitPlan();
  return { ...plan, network: change(plan.network) };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

function paths(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  return issues(result)?.map((issue) => issue.path);
}

describe("a plan without the new fields", () => {
  const kinds = [
    "hetzner",
    "digitalocean",
    "own",
    "portainer",
    "localhost",
    "cloudflare-workers",
    "github-pages",
  ];

  it.each(kinds)("parses %s to the same object and bytes as before", async (kind) => {
    // Each fixture was written by the plan schema before 018: its text is that parse's output.
    const before = await fixture(`before-placement/plan-${kind}.yaml`);
    const plan = parseArtifact("plan", before, "fixture");
    expect(plan).toStrictEqual(parseYaml(before));
    expect(serializeArtifact("plan", plan)).toBe(before);
    for (const field of ["servers", "network", "move"]) expect(plan).not.toHaveProperty(field);
    expect(plan.deployment).not.toHaveProperty("placement");
    for (const service of plan.services) expect(service).not.toHaveProperty("server");
  });
});

describe("the names and keys", () => {
  it("names the app's server app", () => {
    expect(APP_SERVER).toBe("app");
  });

  it("accepts a server name of 1-15 lower-case letters, digits or hyphens, never app or previous", () => {
    for (const name of ["d", "data", "db-1", "a23456789012345"]) {
      expect(ServerNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ["", "Data", "1db", "-db", "db_1", "a234567890123456"]) {
      expect(ServerNameSchema.safeParse(name).success, name).toBe(false);
    }
    expect(ServerNameSchema.safeParse("app").error?.issues[0]?.message).toBe(
      'must not be "app": that names the app\'s own server (target); give the extra server another name, such as "data"',
    );
    // `module "server_previous"` is the app's old server during a retarget.
    expect(ServerNameSchema.safeParse("previous").error?.issues[0]?.message).toMatch(
      /^must not be "previous"/,
    );
  });

  it("accepts a device name of 1-32 lower-case letters, digits or hyphens, never default", () => {
    for (const name of ["laptop", "ci-runner-2", `a${"b".repeat(31)}`]) {
      expect(DeviceNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ["", "Laptop", "2laptop", "my laptop", `a${"b".repeat(32)}`, "default"]) {
      expect(DeviceNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("accepts a WireGuard key only as the base64 of exactly 32 bytes", () => {
    for (let i = 0; i < 50; i++) {
      expect(WireGuardKeySchema.safeParse(key()).success).toBe(true);
    }
    const valid = key();
    const lastChar = valid.at(-2) ?? "";
    // The 43rd character carries 4 bits of the key and 2 bits that must be zero.
    const nonCanonical = `${valid.slice(0, 42)}${lastChar === "B" ? "C" : "B"}=`;
    for (const bad of [
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      randomBytes(64).toString("base64"),
      valid.slice(0, -1),
      ` ${valid}`,
      `${valid}\n`,
      randomBytes(32).toString("base64url"),
      nonCanonical,
      "",
    ]) {
      expect(WireGuardKeySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(WireGuardKeySchema.safeParse("not a key").error?.issues[0]?.message).toBe(
      "must be a WireGuard public key: the base64 of 32 bytes (44 characters ending in =), as `wg pubkey` prints it",
    );
  });

  it("lists the kinds a device can be granted", () => {
    expect(GRANTABLE_KINDS).toEqual([
      "postgres",
      "mysql",
      "mariadb",
      "mongodb",
      "valkey",
      "redis",
      "dragonfly",
    ]);
  });
});

describe("the private networks' addresses", () => {
  it("are the addresses inside 10.200.0.0/13", () => {
    for (const address of ["10.200.0.0", "10.200.4.2", "10.207.255.255"]) {
      expect(inPrivateNetworks(address), address).toBe(true);
    }
    for (const address of ["10.199.255.255", "10.208.0.0", "192.168.1.20", "::1"]) {
      expect(inPrivateNetworks(address), address).toBe(false);
    }
  });
});

describe("the network's interface", () => {
  it("is wg-opscrew<k>, k being the port above 51820", () => {
    expect(networkInterface({ port: 51820 })).toBe("wg-opscrew0");
    expect(networkInterface({ port: 51821 })).toBe("wg-opscrew1");
    // Linux allows 15 characters in an interface's name.
    expect(networkInterface({ port: 65535 })).toBe("wg-opscrew13715");
  });

  it("refuses a port below 51820 or above 65535", async () => {
    for (const port of [51819, 1024, 65536]) {
      const result = DeployPlanSchema.safeParse(
        await withNetwork((network) => ({
          ...network,
          members: network.members.map((m, i) => (i === 0 ? { ...m, port } : m)),
        })),
      );
      expect(paths(result), String(port)).toEqual(["network.members.0.port"]);
    }
  });
});

describe("a split plan", () => {
  it("parses, with the network's defaults and an extra cloud server's image filled in", async () => {
    const plan = DeployPlanSchema.parse(await splitPlan());
    expect(plan.servers).toEqual([
      {
        name: "data",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "hel1",
          serverType: "cpx32",
          image: "ubuntu-24.04",
          backups: true,
        },
      },
      { name: "box", target: { provider: "own", mode: "vps-compose", arch: "amd64" } },
    ]);
    expect(plan.network?.publicSsh).toBe(true);
    const { devices: _d, grants: _g, ...bare } = (await splitPlan()).network;
    const network = DeployPlanSchema.parse(await splitPlan({ network: bare })).network;
    expect(network?.devices).toEqual([]);
    expect(network?.grants).toEqual([]);
  });

  it("round-trips through plan.yaml unchanged, with a move and the placement", async () => {
    const move = { service: "db", from: "app", to: "data", step: "deployed", copy: "dump" };
    const plan = DeployPlanSchema.parse(
      await splitPlan({
        move: { ...move, sizeBytes: 1_048_576 },
        deployment: { url: "https://app.example.com", placement: { db: "app", cache: "box" } },
      }),
    );
    const text = serializeArtifact("plan", plan);
    expect(parseArtifact("plan", text, "plan.yaml")).toEqual(plan);
    expect(serializeArtifact("plan", parseArtifact("plan", text, "plan.yaml"))).toBe(text);
    expect(plan.deployment.placement).toEqual({ db: "app", cache: "box" });
  });

  it("refuses an extra server's edge or tunnel, which it never has", async () => {
    const plan = await splitPlan();
    const [data, box] = plan.servers;
    const result = DeployPlanSchema.safeParse({
      ...plan,
      servers: [
        { ...data, target: { ...data?.target, edge: "caddy" } },
        { ...box, target: { ...box?.target, access: "tunnel" } },
      ],
    });
    expect(paths(result)).toEqual(["servers.0.target", "servers.1.target"]);
    expect(ExtraServerSchema.safeParse(data).success).toBe(true);
  });

  it("tells where each service runs, and what each server runs", async () => {
    const plan = DeployPlanSchema.parse(
      await splitPlan({
        services: [
          { ...(await serverPlan()).services[0], server: "data" },
          { ...valkey, server: "box" },
          { ...valkey, name: "queue", options: { mode: "queue" } },
          { ...valkey, name: "old", enabled: false, server: "box" },
        ],
      }),
    );
    expect(serverOfService(plan, "db")).toBe("data");
    expect(serverOfService(plan, "cache")).toBe("box");
    expect(serverOfService(plan, "queue")).toBe(APP_SERVER);
    expect(() => serverOfService(plan, "nope")).toThrow('The plan has no service named "nope"');
    expect(servicesOn(plan, "box").map((s) => s.name)).toEqual(["cache"]);
    expect(servicesOn(plan, APP_SERVER).map((s) => s.name)).toEqual(["queue"]);
    expect(servicesOn(plan, "data").map((s) => s.name)).toEqual(["db"]);
    expect(servicesOn(plan, "elsewhere")).toEqual([]);
  });
});

describe("where extra servers and the network go", () => {
  const targets = {
    portainer: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 2,
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "caddy" },
    },
    localhost: {
      provider: "localhost",
      mode: "local-compose",
      arch: "arm64",
      ports: { https: 443, http: 80 },
      image: "local-build",
    },
  };

  it("accepts them on a cloud server and on your own server", async () => {
    const own = { provider: "own", mode: "vps-compose", arch: "amd64", access: "public" };
    expect(DeployPlanSchema.safeParse(await splitPlan()).success).toBe(true);
    expect(DeployPlanSchema.safeParse(await splitPlan({ target: own })).success).toBe(true);
  });

  it("refuses them in a Portainer or on localhost", async () => {
    const portainer = await splitPlan({ target: targets.portainer });
    expect(issues(DeployPlanSchema.safeParse(portainer))).toEqual([
      {
        path: "servers",
        message:
          "is refused with a Portainer target: extra servers run on a cloud server or your own server (target.provider hetzner, digitalocean or own); remove servers, or choose such a target",
      },
      {
        path: "network",
        message:
          "is refused with a Portainer target: the private network links a cloud server or your own server (target.provider hetzner, digitalocean or own); remove network, or choose such a target",
      },
    ]);
    const local = await splitPlan({
      target: targets.localhost,
      dns: { provider: "none", proxied: false, www: false },
      deployment: {},
    });
    expect(paths(DeployPlanSchema.safeParse(local))).toEqual(["servers", "network"]);
  });

  it("refuses a network alone on a target without servers", async () => {
    const { servers: _s, ...plan } = await withNetwork((n) => ({
      ...n,
      members: n.members.slice(0, 1),
    }));
    const portainer = {
      ...plan,
      target: targets.portainer,
      services: (await serverPlan()).services,
    };
    expect(paths(DeployPlanSchema.safeParse(portainer))).toEqual(["network"]);
  });
});

describe("the extra servers", () => {
  it("refuses two servers of one name", async () => {
    const plan = await splitPlan();
    const [data] = plan.servers;
    const result = DeployPlanSchema.safeParse({ ...plan, servers: [...plan.servers, data] });
    expect(issues(result)).toContainEqual({
      path: "servers.2.name",
      message: '"data" is already the name of another server; give each its own',
    });
  });

  it("refuses a service on a server the plan doesn't have", async () => {
    const plan = await splitPlan();
    const result = DeployPlanSchema.safeParse({
      ...plan,
      services: [plan.services[0], { ...valkey, server: "cache-box" }],
    });
    expect(issues(result)).toContainEqual({
      path: "services.1.server",
      message:
        'names no server of the plan: "cache-box"; use one of data, box, or leave server out to run the service on the app\'s server',
    });
  });

  it("refuses a server that runs no enabled service, unless it holds a move's old copy", async () => {
    const plan = await splitPlan();
    const idle = {
      ...plan,
      services: [plan.services[0], { ...valkey, server: "box", enabled: false }],
    };
    expect(issues(DeployPlanSchema.safeParse(idle))).toEqual([
      {
        path: "servers.1",
        message:
          "runs no enabled service: place a service on box (services[].server), or remove the server (it is deleted at the next provision, after your approval)",
      },
    ]);
    const moving = {
      ...plan,
      services: [plan.services[0], valkey],
      move: { service: "cache", from: "box", to: "app", step: "switched", copy: "empty" },
    };
    expect(DeployPlanSchema.safeParse(moving).success).toBe(true);
  });

  it("needs the network to link them", async () => {
    const { network: _n, ...plan } = await splitPlan();
    expect(issues(DeployPlanSchema.safeParse(plan))).toEqual([
      {
        path: "network",
        message:
          "is required with extra servers: the private network links them to the app's server; run opscrew design to add it",
      },
    ]);
  });

  it("refuses a move to another target together with extra servers", async () => {
    const plan = await serverPlan();
    const retarget = {
      from: { target: plan.target },
      step: "started",
      startedAt: addedAt,
    };
    expect(issues(DeployPlanSchema.safeParse(await splitPlan({ retarget })))).toEqual([
      {
        path: "retarget",
        message:
          "is refused for an app with extra servers: moving it to another provider is not available yet; place every service on the app's server (remove services[].server and servers), then move it",
      },
    ]);
    expect(DeployPlanSchema.safeParse({ ...plan, retarget }).success).toBe(true);
  });
});

describe("the network's members", () => {
  it("refuses a /24 outside 10.200.0.0/13, another size, or host bits", async () => {
    for (const range of ["10.199.4.0/24", "10.208.0.0/24", "192.168.4.0/24", "10.200.4.0/25"]) {
      const result = DeployPlanSchema.safeParse(await withNetwork((n) => ({ ...n, range })));
      expect(paths(result)?.[0], range).toBe("network.range");
    }
    const hostBits = DeployPlanSchema.safeParse(
      await withNetwork((n) => ({ ...n, range: "10.200.4.7/24" })),
    );
    expect(issues(hostBits)?.[0]).toEqual({
      path: "network.range",
      message:
        "must be a /24 network inside 10.200.0.0/13 with its last number 0, such as 10.200.4.0/24",
    });
    for (const range of ["10.200.0.0/24", "10.207.255.0/24"]) {
      const result = DeployPlanSchema.safeParse(
        await withNetwork((n) => ({
          ...n,
          range,
          members: n.members.map((m, i) => ({
            ...m,
            address: range.replace(/0\/24$/, String(i + 1)),
          })),
          devices: [],
          grants: [],
        })),
      );
      expect(result.success, range).toBe(true);
    }
  });

  it("needs app and every server, each once", async () => {
    const missing = DeployPlanSchema.safeParse(
      await withNetwork((n) => ({ ...n, members: n.members.slice(1, 2) })),
    );
    expect(issues(missing)).toEqual([
      {
        path: "network.members",
        message:
          'has no member "app": every server of the app needs one (app and data, box), with its address and port',
      },
      {
        path: "network.members",
        message:
          'has no member "box": every server of the app needs one (app and data, box), with its address and port',
      },
    ]);
    const twice = DeployPlanSchema.safeParse(
      await withNetwork((n) => ({
        ...n,
        members: [...n.members, { ...n.members[1], address: "10.200.4.9" }],
      })),
    );
    expect(issues(twice)).toEqual([
      {
        path: "network.members.3.name",
        message: '"data" is already a member; each server is a member once',
      },
    ]);
    const stranger = DeployPlanSchema.safeParse(
      await withNetwork((n) => ({
        ...n,
        members: [...n.members, { ...n.members[1], name: "old", address: "10.200.4.9" }],
      })),
    );
    expect(issues(stranger)).toEqual([
      {
        path: "network.members.3.name",
        message:
          'names no server of the plan: "old"; a member is "app" or the name of one of servers (data, box)',
      },
    ]);
  });

  it("needs each address inside the range, unique, and neither the network nor broadcast address", async () => {
    const at = (address: string) =>
      withNetwork((n) => ({
        ...n,
        members: n.members.map((m, i) => (i === 2 ? { ...m, address } : m)),
      }));
    expect(issues(DeployPlanSchema.safeParse(await at("10.200.5.3")))).toEqual([
      {
        path: "network.members.2.address",
        message:
          "must be inside the network's range 10.200.4.0/24, from 10.200.4.1 to 10.200.4.254",
      },
    ]);
    for (const address of ["10.200.4.0", "10.200.4.255"]) {
      expect(paths(DeployPlanSchema.safeParse(await at(address))), address).toEqual([
        "network.members.2.address",
      ]);
    }
    expect(issues(DeployPlanSchema.safeParse(await at("10.200.4.2")))).toEqual([
      {
        path: "network.members.2.address",
        message: "10.200.4.2 is already the address of data; give each its own",
      },
    ]);
  });
});

describe("the network's devices and grants", () => {
  it("needs unique device names, and addresses in the range no member or other device has", async () => {
    const laptop = (change: Record<string, unknown>) =>
      withNetwork((n) => ({ ...n, devices: [...n.devices, { ...n.devices[0], ...change }] }));
    expect(issues(DeployPlanSchema.safeParse(await laptop({ address: "10.200.4.101" })))).toEqual([
      {
        path: "network.devices.1.name",
        message: '"laptop" is already the name of another device; give each its own',
      },
    ]);
    expect(
      issues(DeployPlanSchema.safeParse(await laptop({ name: "phone", address: "10.200.4.1" }))),
    ).toEqual([
      {
        path: "network.devices.1.address",
        message: "10.200.4.1 is already the address of app; give each its own",
      },
    ]);
    expect(
      paths(DeployPlanSchema.safeParse(await laptop({ name: "phone", address: "10.200.9.1" }))),
    ).toEqual(["network.devices.1.address"]);
    expect(
      DeployPlanSchema.safeParse(await laptop({ name: "phone", address: "10.200.4.101" })).success,
    ).toBe(true);
  });

  it("never names a device like one of the app's servers", async () => {
    for (const name of ["app", "data", "box"]) {
      const plan = await withNetwork((n) => ({
        ...n,
        devices: [...n.devices, { ...n.devices[0], name, address: "10.200.4.101" }],
      }));
      expect(issues(DeployPlanSchema.safeParse(plan)), name).toEqual([
        {
          path: "network.devices.1.name",
          message: `"${name}" is the name of a server of the app; give the device another name, such as "laptop"`,
        },
      ]);
    }
  });

  it("refuses a device's private key or a field it doesn't know", async () => {
    const result = DeployPlanSchema.safeParse(
      await withNetwork((n) => ({
        ...n,
        devices: [{ ...n.devices[0], privateKey: key() }],
      })),
    );
    expect(paths(result)).toEqual(["network.devices.0"]);
  });

  it("needs each grant to name a device and an enabled service of a grantable kind", async () => {
    const grant = (change: Record<string, unknown>) =>
      withNetwork((n) => ({ ...n, grants: [{ ...n.grants[0], ...change }] }));
    expect(issues(DeployPlanSchema.safeParse(await grant({ device: "phone" })))).toEqual([
      {
        path: "network.grants.0.device",
        message: 'names no device of the network: "phone"; add it first (opscrew vpn add phone)',
      },
    ]);
    expect(issues(DeployPlanSchema.safeParse(await grant({ service: "mail" })))).toEqual([
      {
        path: "network.grants.0.service",
        message: 'names no enabled service of the plan: "mail"; grant one of db, cache',
      },
    ]);
    const plan = await splitPlan();
    const withKafka = {
      ...plan,
      services: [
        ...plan.services,
        { ...kafka, server: "data" },
        { ...valkey, name: "off", enabled: false },
      ],
    };
    const kafkaGrant = {
      ...withKafka,
      network: {
        ...plan.network,
        grants: [{ device: "laptop", service: "events", access: "full" }],
      },
    };
    expect(issues(DeployPlanSchema.safeParse(kafkaGrant))).toEqual([
      {
        path: "network.grants.0.service",
        message:
          "is events, a kafka service, which has no logins to grant: a device can be granted postgres, mysql, mariadb, mongodb, valkey, redis or dragonfly",
      },
    ]);
    const offGrant = {
      ...withKafka,
      network: { ...plan.network, grants: [{ device: "laptop", service: "off", access: "full" }] },
    };
    expect(paths(DeployPlanSchema.safeParse(offGrant))).toEqual(["network.grants.0.service"]);
    expect(
      DeployPlanSchema.safeParse(await grant({ service: "cache", access: "full" })).success,
    ).toBe(true);
  });

  it("allows devices and grants on a network with no extra server", async () => {
    const plan = await splitPlan();
    const result = DeployPlanSchema.safeParse({
      ...plan,
      servers: [],
      services: (await serverPlan()).services,
      network: { ...plan.network, members: plan.network.members.slice(0, 1) },
    });
    expect(result.success).toBe(true);
  });
});

describe("a move", () => {
  const move = { service: "db", from: "app", to: "data", step: "started", copy: "dump" };

  it("accepts each step and copy, and refuses another", () => {
    for (const step of ["started", "deployed", "switched"]) {
      expect(MoveSchema.safeParse({ ...move, step }).success, step).toBe(true);
    }
    expect(MoveSchema.safeParse({ ...move, copy: "empty" }).success).toBe(true);
    expect(MoveSchema.safeParse({ ...move, step: "migrated" }).success).toBe(false);
    expect(MoveSchema.safeParse({ ...move, sizeBytes: -1 }).success).toBe(false);
  });

  it("needs a service of the plan, and two different servers of the plan", async () => {
    expect(DeployPlanSchema.safeParse(await splitPlan({ move })).success).toBe(true);
    expect(
      issues(DeployPlanSchema.safeParse(await splitPlan({ move: { ...move, service: "search" } }))),
    ).toEqual([
      {
        path: "move.service",
        message: 'names no service of the plan: "search"; use one of db, cache',
      },
    ]);
    expect(
      issues(DeployPlanSchema.safeParse(await splitPlan({ move: { ...move, to: "app" } }))),
    ).toEqual([
      {
        path: "move.to",
        message: 'must differ from move.from ("app"): a move takes a service to another server',
      },
    ]);
    const unknown = DeployPlanSchema.safeParse(
      await splitPlan({ move: { ...move, from: "gone", to: "elsewhere" } }),
    );
    expect(issues(unknown)).toEqual([
      {
        path: "move.from",
        message: 'names no server of the plan: "gone"; use app or one of data, box',
      },
      {
        path: "move.to",
        message: 'names no server of the plan: "elsewhere"; use app or one of data, box',
      },
    ]);
  });
});

describe("the JSON schema of the plan", () => {
  it("has servers, the network, a move and the placement, and the network's defaults", () => {
    const plan = toJsonSchemas().plan as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(plan.properties)).toEqual(
      expect.arrayContaining(["servers", "network", "move"]),
    );
    expect(plan.properties.deployment?.properties).toHaveProperty("placement");
    expect(plan.properties.network).toMatchObject({
      properties: {
        devices: { default: [] },
        grants: { default: [] },
        publicSsh: { default: true },
      },
    });
    expect(NetworkSchema.parse({ range: "10.200.4.0/24", members: [] })).toEqual({
      range: "10.200.4.0/24",
      members: [],
      devices: [],
      grants: [],
      publicSsh: true,
    });
  });

  it("keeps the allow-list public SSH reopens to while it is closed", () => {
    const closed = {
      range: "10.200.4.0/24",
      members: [],
      publicSsh: false,
      publicSshAllowedCidrs: ["203.0.113.0/24", "2001:db8::/32"],
    };
    expect(NetworkSchema.parse(closed).publicSshAllowedCidrs).toEqual([
      "203.0.113.0/24",
      "2001:db8::/32",
    ]);
    expect(
      NetworkSchema.safeParse({ ...closed, publicSshAllowedCidrs: ["somewhere"] }).success,
    ).toBe(false);
  });
});
