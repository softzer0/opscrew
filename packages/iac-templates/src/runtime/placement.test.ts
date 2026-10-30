// Feature 018: a Compose project per server, services published on the private network, and the
// device logins' start wrapper (T1805, ADR 0022).
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GARAGE_STORAGE, withPlacement, withServices } from "../catalog/__fixtures__/plans";
import {
  hostSettingsServices,
  publishedOnNetwork,
  renderCompose,
  renderRuntimeFiles,
  renderServerCompose,
} from "./index";

type Compose = {
  name: string;
  services: Record<string, Record<string, unknown> & { ports?: string[]; depends_on?: object }>;
  networks: Record<string, unknown>;
  volumes?: Record<string, unknown>;
};

function compose(content: string): Compose {
  return parse(content);
}

/** `plan` with a worker and a cron job, which stay on the app's server. */
function withProcesses(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    processes: {
      workers: [{ name: "worker", command: "node worker.js", source: "library" }],
      cron: [{ name: "cleanup", schedule: "@daily", command: "node cleanup.js" }],
    },
  });
}

/** Postgres (`db`) on the server `data`, Valkey (`cache`) on the app's, with a worker and cron. */
const POSTGRES_ELSEWHERE = withPlacement(
  withProcesses(withServices([{ kind: "postgres" }, { kind: "valkey" }])),
  { servers: { data: "hetzner" }, placed: { db: "data" } },
);

/** Kafka (`events`) on the server `broker`. */
const KAFKA_ELSEWHERE = withPlacement(withServices([{ kind: "kafka", name: "events" }]), {
  servers: { broker: "hetzner" },
  placed: { events: "broker" },
});

/** Postgres and Valkey on the app's server, the laptop granted read-only access to Valkey. */
const VALKEY_GRANTED = withPlacement(withServices([{ kind: "postgres" }, { kind: "valkey" }]), {
  devices: ["laptop"],
  grants: [{ device: "laptop", service: "cache", access: "read-only" }],
});

describe("the app's Compose file (the app's server)", () => {
  it("leaves out a service placed on another server, and waits only for its own (snapshot)", () => {
    const file = renderCompose(POSTGRES_ELSEWHERE);
    const doc = compose(file.content);
    expect(Object.keys(doc.services)).toEqual(["app", "worker", "cron", "cache"]);
    for (const name of ["app", "worker", "cron"]) {
      expect(doc.services[name]?.depends_on).toEqual({ cache: { condition: "service_healthy" } });
    }
    expect(doc.services.cache?.ports).toBeUndefined();
    expect(file.content).toMatchSnapshot();
  });

  it("has no service and no dependency when every service runs elsewhere", () => {
    const doc = compose(renderCompose(KAFKA_ELSEWHERE).content);
    expect(Object.keys(doc.services)).toEqual(["app"]);
    expect(doc.services.app?.depends_on).toBeUndefined();
    expect(doc.volumes).toBeUndefined();
  });

  it("publishes a service a device was granted on the app's private address, with its wrapper (snapshot)", () => {
    const file = renderCompose(VALKEY_GRANTED);
    const doc = compose(file.content);
    expect(doc.services.cache?.ports).toEqual(["10.200.4.1:6379:6379"]);
    expect(doc.services.db?.ports).toBeUndefined();
    expect(doc.services.cache?.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining("--aclfile /tmp/opscrew-users.acl"),
    ]);
    // Its logins come from its env file with its password, never from this file.
    expect(doc.services.cache?.env_file).toEqual(["cache.env"]);
    expect(file.content).not.toMatch(/OPSCREW_ACL_USERS=|grant-sha256/);
    expect(file.content).toMatchSnapshot();
  });

  it("is the same as without a network when the network has no server, device or grant", () => {
    const plain = withServices([{ kind: "postgres" }, { kind: "valkey" }]);
    const networked = withPlacement(plain, {});
    expect(networked.network).toBeDefined();
    expect(renderCompose(networked)).toEqual(renderCompose(plain));
    expect(renderRuntimeFiles(networked)).toEqual(renderRuntimeFiles(plain));
    // A device without a grant publishes nothing either.
    expect(renderCompose(withPlacement(plain, { devices: ["laptop"] }))).toEqual(
      renderCompose(plain),
    );
  });

  it("starts the host settings' container only where an engine needs it", () => {
    const plan = withPlacement(withServices([{ kind: "opensearch" }, { kind: "postgres" }]), {
      servers: { search: "hetzner" },
      placed: { opensearch: "search" },
    });
    expect(hostSettingsServices(plan)).toEqual([]);
    expect(Object.keys(compose(renderCompose(plan).content).services)).toEqual(["app", "db"]);
    expect(hostSettingsServices(plan, "search")).toEqual(["sysctl"]);
    // On a server the user owns, the host plan sets them, as on an own app server.
    const own = withPlacement(withServices([{ kind: "opensearch" }, { kind: "postgres" }]), {
      servers: { box: "own" },
      placed: { opensearch: "box" },
    });
    expect(hostSettingsServices(own, "box")).toEqual([]);
    expect(Object.keys(compose(renderServerCompose(own, "box").content).services)).toEqual([
      "opensearch",
    ]);
  });
});

describe("an extra server's Compose file", () => {
  it("runs the services placed there in the app's project, published on its private address only (snapshot)", () => {
    const file = renderServerCompose(POSTGRES_ELSEWHERE, "data");
    expect(file.path).toBe("opscrew/runtime/servers/data/compose.yaml");
    expect(file.kind).toBe("runtime");
    const doc = compose(file.content);
    expect(doc.name).toBe("shop");
    expect(Object.keys(doc.services)).toEqual(["db"]);
    expect(doc.services.db?.ports).toEqual(["10.200.4.2:5432:5432"]);
    expect(doc.services.db?.networks).toEqual(["internal"]);
    expect(doc.services.db?.env_file).toEqual(["db.env"]);
    expect(doc.services.db?.volumes).toEqual(["/srv/data/shop/db:/var/lib/postgresql/data"]);
    expect(doc.networks).toEqual({ internal: {} });
    expect(file.content).not.toMatch(/caddy|kamal-proxy|opscrew-edge|APP_IMAGE/);
    expect(file.content).toMatchSnapshot();
  });

  it("advertises Kafka at its private address (snapshot)", () => {
    const file = renderServerCompose(KAFKA_ELSEWHERE, "broker");
    const events = compose(file.content).services.events as {
      ports: string[];
      environment: Record<string, string>;
    };
    expect(events.ports).toEqual(["10.200.4.2:9092:9092"]);
    expect(events.environment.KAFKA_ADVERTISED_LISTENERS).toBe("PLAINTEXT://10.200.4.2:9092");
    expect(compose(file.content).volumes).toEqual({
      events_data: {},
      events_secrets: {},
      events_config: {},
    });
    expect(file.content).toMatchSnapshot();
  });

  it("runs the host settings' container on a cloud server when an engine there needs it", () => {
    const plan = withPlacement(withServices([{ kind: "opensearch" }, { kind: "postgres" }]), {
      servers: { search: "hetzner" },
      placed: { opensearch: "search" },
    });
    const doc = compose(renderServerCompose(plan, "search").content);
    expect(Object.keys(doc.services)).toEqual(["sysctl", "opensearch"]);
    expect(doc.services.opensearch?.depends_on).toEqual({
      sysctl: { condition: "service_completed_successfully" },
    });
  });

  it("keeps the settings files of every server's services in the runtime folder", () => {
    const plan = withPlacement(
      withServices([{ kind: "mysql" }, { kind: "garage" }, { kind: "postgres" }], {
        storage: GARAGE_STORAGE,
      }),
      { servers: { data: "hetzner" }, placed: { mysql: "data" } },
    );
    expect(renderRuntimeFiles(plan).map((file) => file.path)).toEqual([
      "opscrew/runtime/services/garage/garage.toml",
      "opscrew/runtime/services/mysql/my.cnf",
      "opscrew/runtime/edge/compose.yaml",
    ]);
    // Mounted beside the server's compose.yaml, where the deploy copies them.
    expect(compose(renderServerCompose(plan, "data").content).services.mysql?.volumes).toContain(
      "./services/mysql/my.cnf:/etc/mysql/conf.d/opscrew.cnf:ro",
    );
  });

  it("refuses a server the plan doesn't have", () => {
    expect(() => renderServerCompose(POSTGRES_ELSEWHERE, "app")).toThrow(
      "The plan has no extra server named app.",
    );
    expect(() => renderServerCompose(POSTGRES_ELSEWHERE, "cache")).toThrow(/no extra server/);
  });

  it("refuses two services published on one address with the same port", () => {
    const plan = withPlacement(
      withServices([
        { kind: "valkey", options: { mode: "queue" } },
        { kind: "valkey", options: { mode: "cache" } },
      ]),
      { servers: { data: "hetzner" }, placed: { queue: "data", cache: "data" } },
    );
    expect(() => renderServerCompose(plan, "data")).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message:
          "The services queue and cache both listen on port 6379, and both would be published at 10.200.4.2 on the server data.",
        hint: "Place one of them on another server (services[].server in opscrew/plan.yaml), then run the command again.",
      }),
    );
    const granted = withPlacement(
      withServices([
        { kind: "valkey", options: { mode: "queue" } },
        { kind: "valkey", options: { mode: "cache" } },
      ]),
      {
        devices: ["laptop"],
        grants: [
          { device: "laptop", service: "queue", access: "read-only" },
          { device: "laptop", service: "cache", access: "read-only" },
        ],
      },
    );
    expect(() => renderCompose(granted)).toThrow(
      expect.objectContaining({
        message:
          "The services queue and cache both listen on port 6379, and both would be published at 10.200.4.1 on the app's server.",
        hint: "Grant devices only one of them (opscrew vpn revoke <device> <service> for the other), or place one on another server (services[].server in opscrew/plan.yaml), then run the command again.",
      }),
    );
  });
});

describe("the rendered files", () => {
  it("hold no secret, and no device login's hash, on any server", () => {
    // The renderers' context refuses every secret: rendering at all shows none is needed.
    const plan = withPlacement(withServices([{ kind: "postgres" }, { kind: "valkey" }]), {
      servers: { data: "hetzner" },
      placed: { cache: "data" },
      devices: ["laptop"],
      grants: [
        { device: "laptop", service: "cache", access: "full" },
        { device: "laptop", service: "db", access: "read-only" },
      ],
    });
    const files = [
      renderCompose(plan),
      renderServerCompose(plan, "data"),
      ...renderRuntimeFiles(plan),
    ];
    for (const file of files) {
      expect(file.content).not.toMatch(/OPSCREW_ACL_USERS=|grant-sha256|requirepass [0-9a-f]/);
    }
    const cache = compose(renderServerCompose(plan, "data").content).services.cache;
    expect(cache?.env_file).toEqual(["cache.env"]);
    expect(cache?.environment).toBeUndefined();
  });
});

describe("publishedOnNetwork", () => {
  it("lists each service and port published on a server's private address", () => {
    expect(publishedOnNetwork(POSTGRES_ELSEWHERE, "data")).toEqual([
      { service: "db", port: 5432, address: "10.200.4.2" },
    ]);
    expect(publishedOnNetwork(POSTGRES_ELSEWHERE, "app")).toEqual([]);
    expect(publishedOnNetwork(VALKEY_GRANTED, "app")).toEqual([
      { service: "cache", port: 6379, address: "10.200.4.1" },
    ]);
    expect(publishedOnNetwork(withServices([{ kind: "postgres" }]), "app")).toEqual([]);
  });

  it("lists the dashboards on the app's private address when the server hosts this app alone", () => {
    const withDashboards = (plan: DeployPlan, beszelMode: "hub" | "agent") =>
      DeployPlanSchema.parse({
        ...plan,
        portainer: { enabled: true, version: "2.33.1", access: "local" },
        observability: {
          beszel:
            beszelMode === "hub"
              ? { enabled: true, version: "0.21.1" }
              : {
                  enabled: true,
                  version: "0.21.1",
                  mode: "agent",
                  hubUrl: "https://beszel.example.org",
                  hubKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`,
                },
        },
      });
    const services = withServices([{ kind: "postgres" }, { kind: "valkey" }]);
    const plan = withPlacement(withDashboards(services, "hub"), {
      devices: ["laptop"],
      grants: [{ device: "laptop", service: "cache", access: "read-only" }],
    });
    const alone = { dashboardsOnNetwork: true };
    expect(publishedOnNetwork(plan, "app", alone)).toEqual([
      { service: "cache", port: 6379, address: "10.200.4.1" },
      { service: "beszel", port: 8090, address: "10.200.4.1", dashboard: true },
      { service: "portainer", port: 9443, address: "10.200.4.1", dashboard: true },
    ]);
    // Beszel's agent alone has no dashboard here; an extra server never has one.
    const agent = withPlacement(withDashboards(services, "agent"), {
      servers: { data: "hetzner" },
      placed: { db: "data" },
      devices: ["laptop"],
    });
    expect(publishedOnNetwork(agent, "app", alone)).toEqual([
      { service: "portainer", port: 9443, address: "10.200.4.1", dashboard: true },
    ]);
    expect(publishedOnNetwork(agent, "data", alone)).toEqual([
      { service: "db", port: 5432, address: "10.200.4.2" },
    ]);
    // By default (a server other apps may share), the dashboards stay off the network.
    expect(publishedOnNetwork(plan, "app")).toEqual([
      { service: "cache", port: 6379, address: "10.200.4.1" },
    ]);
  });

  it("matches the ports the Compose files publish", () => {
    const plan = withPlacement(
      withServices([{ kind: "postgres" }, { kind: "mongodb" }, { kind: "valkey" }]),
      {
        servers: { data: "hetzner", docs: "own" },
        placed: { db: "data", mongodb: "docs" },
        devices: ["laptop"],
        grants: [{ device: "laptop", service: "cache", access: "full" }],
      },
    );
    const ports = (content: string) =>
      Object.entries(compose(content).services).flatMap(([service, s]) =>
        (s.ports ?? []).map((port) => {
          const [address, published] = port.split(":");
          return { service, port: Number(published), address };
        }),
      );
    expect(publishedOnNetwork(plan, "app")).toEqual(ports(renderCompose(plan).content));
    for (const server of ["data", "docs"]) {
      expect(publishedOnNetwork(plan, server)).toEqual(
        ports(renderServerCompose(plan, server).content),
      );
    }
  });
});
