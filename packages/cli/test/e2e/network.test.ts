/**
 * The private network's Docker pass (feature 018, plan.md "14.", research R5a and R6a): two servers
 * in privileged Ubuntu 24.04 containers (`network-support.ts`), each with its own Docker, ufw and a
 * `deploy` user in the docker group without sudo, as the servers OpsCrew creates. `app` is the
 * app's server, `data` the extra server the services are placed on. OpsCrew's own code drives them:
 * - the `network` and `network-filter` host plans (the agents' `networkHostPlan`, `applyHostPlan`
 *   bound to the plan's hash) applied as `deploy`, root through Docker (the `docker` privilege),
 *   then planned again as in place;
 * - a peer added on both servers while `app` pings `data`'s private address, losing nothing;
 * - the services placed on `data` rendered by `renderServerCompose` with their env files, started as
 *   the deploy starts them (`docker compose up -d --wait`, then the services' setup steps): Kafka,
 *   Redpanda and a MongoDB replica set pass their own checks, which reach back to their advertised
 *   private address;
 * - Postgres on `data`'s private address reached from a container on a bridge network of `app`;
 * - a device (a container of `app` whose only interface is its own WireGuard link to `data`)
 *   refused on Postgres's port, let in after its grant (the filter's sources and the `grant` step),
 *   refused again after the revoke;
 * - each database's `grant` step (`planGrant`), run as `deploy` from its home folder through
 *   `docker compose -p shop exec -T` with no Compose file (mongosh reads its script from standard
 *   input): a read-only login reads and cannot write; Postgres's full login writes rows but is
 *   refused `COPY … PROGRAM` and changes to the app's tables;
 * - the ACL wrapper on Valkey, Redis and Dragonfly (`OPSCREW_ACL_USERS` in the env file): a
 *   read-only login reads and cannot write; a full one writes but is refused CONFIG, MODULE and
 *   SHUTDOWN.
 *
 * The services run in three turns, since some share a port (MySQL and MariaDB, the Redis-protocol
 * engines, Kafka and Redpanda): each turn is a new plan for `data`, whose network host plan follows.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon that may run
 * privileged containers, and the network for the image's packages and the pinned images. The
 * servers, their Docker volumes, the network, the servers' image and the images this pass pulled
 * are removed afterwards, by name.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type AppEnvironment,
  assembleAppEnv,
  networkHostPlan,
  serviceEnvSecrets,
  type WireGuardKeyPair,
  x25519KeyPair,
} from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import {
  type ApplySecrets,
  applyHostPlan,
  type GrantParams,
  type HostPlan,
  hostPlanHash,
  inspectHost,
  planGrant,
} from "@opscrew/connector-ssh-host";
import type { CommandResult } from "@opscrew/contracts";
import {
  grantHashSecret,
  IMAGES,
  initStepsFor,
  renderServerCompose,
  serviceEnvSecret,
  serviceSpec,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type PlanService,
  PlanServiceSchema,
} from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  docker,
  dockerSkipReason,
  imageIds,
  LABEL,
  removeNewImages,
  runtimeFiles,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
  UBUNTU,
} from "./docker-support";
import { dockerOk, hasImage, unique, until } from "./edge-support";
import {
  asDeploy,
  asRoot,
  type ContainerServer,
  checked,
  copyImages,
  dockerWith,
  SERVER_DOCKERFILE,
  startServer,
} from "./network-support";

const SKIP = dockerSkipReason();
if (SKIP !== undefined) console.warn(`Skipping the private network's Docker pass: ${SKIP}.`);

const APP = "shop";
const APP_DIR = `/srv/apps/${APP}`;
const COMMAND = "opscrew provision";
/** The image root steps run in when `deploy` becomes root through Docker, as the agents pass it. */
const ROOT_IMAGE = IMAGES.caddy.ref;
const PORT = 51820;
const IFACE = "wg-opscrew0";
const ADDRESSES = { app: "10.200.7.1", data: "10.200.7.2" } as const;
const DEVICES = { laptop: "10.200.7.100", desk: "10.200.7.101", phone: "10.200.7.102" } as const;
type ServerName = keyof typeof ADDRESSES;
type DeviceName = keyof typeof DEVICES;
const DATA_IP = ADDRESSES.data;

/** A service placed on `data`, with the catalog's version and memory. */
function placed(name: string, kind: PlanService["kind"], options?: object): PlanService {
  const spec = serviceSpec(kind);
  return PlanServiceSchema.parse({
    name,
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    server: "data",
    ...(options === undefined ? {} : { options }),
    reason: `The private network's Docker pass runs ${spec.title} on the server data.`,
    licence: spec.licence.id,
  });
}

/** The three turns of services on `data`: no two in a turn share a port. */
const TURNS = {
  first: [
    placed("db", "postgres"),
    placed("mysql", "mysql"),
    placed("mongodb", "mongodb", { replicaSet: true }),
    placed("cache", "valkey", { mode: "cache" }),
    placed("kafka", "kafka"),
  ],
  second: [
    placed("mariadb", "mariadb"),
    placed("redis", "redis", { mode: "cache" }),
    placed("redpanda", "redpanda"),
  ],
  third: [placed("dragonfly", "dragonfly", { mode: "cache" })],
};

/** The pinned image of a service kind. */
function serviceImage(kind: PlanService["kind"]): string {
  return IMAGES[serviceSpec(kind).image].ref;
}

/** The services' pinned images, each once. */
const SERVICE_IMAGES = [
  ...new Set(Object.values(TURNS).flatMap((turn) => turn.map((s) => serviceImage(s.kind)))),
];
const POSTGRES_IMAGE = serviceImage("postgres");

type Grant = NonNullable<DeployPlan["network"]>["grants"][number];

describe.skipIf(SKIP !== undefined)("the private network on two container servers (018)", () => {
  const network = unique("net");
  const image = `${unique("server")}:1`;
  const names = { app: unique("app"), data: unique("data") };
  let servers: Record<ServerName, ContainerServer>;
  let endpoints: Record<string, string>;
  let before: Set<string> = new Set();
  const keys: Record<ServerName | DeviceName, WireGuardKeyPair> = {
    app: x25519KeyPair(),
    data: x25519KeyPair(),
    laptop: x25519KeyPair(),
    desk: x25519KeyPair(),
    phone: x25519KeyPair(),
  };
  /** The devices on the network; `phone` joins while a ping runs. */
  const devices: DeviceName[] = ["laptop", "desk"];
  /** Each device's login password per service, made on first use. */
  const passwords = new Map<string, string>();
  /** The services' generated values of the turn running on `data`. */
  let values: AppEnvironment["values"];

  function password(device: DeviceName, service: string): string {
    const key = `${device}/${service}`;
    const made = passwords.get(key) ?? randomBytes(16).toString("hex");
    passwords.set(key, made);
    return made;
  }

  /** The app's plan with `services` on `data`, the devices on the network and `grants`. */
  function splitPlan(services: PlanService[], grants: Grant[] = []): DeployPlan {
    const base = testPlan({ postgres: false, userSecret: false });
    const member = (name: ServerName) => ({
      name,
      address: ADDRESSES[name],
      port: PORT,
      publicKey: keys[name].publicKey,
    });
    return DeployPlanSchema.parse({
      ...base,
      servers: [
        {
          name: "data",
          target: {
            provider: "hetzner",
            mode: "vps-compose",
            location: "nbg1",
            serverType: "cx23",
            backups: false,
          },
        },
      ],
      services,
      network: {
        range: "10.200.7.0/24",
        members: [member("app"), member("data")],
        devices: devices.map((name) => ({
          name,
          address: DEVICES[name],
          publicKey: keys[name].publicKey,
          addedAt: "2026-10-31T10:00:00.000Z",
        })),
        grants,
      },
    });
  }

  /** `plan`'s host plan approved by its hash and applied as `deploy` on the server. */
  async function apply(server: ServerName, plan: HostPlan, secrets: ApplySecrets = {}) {
    expect(plan.findings, `${server}: the plan's findings`).toEqual([]);
    return applyHostPlan(servers[server].login, plan, {
      approvedHash: hostPlanHash(plan),
      command: COMMAND,
      verifyLogin: async () => true,
      rootImage: ROOT_IMAGE,
      secrets,
    });
  }

  /**
   * The server's private network host plan for `plan`, made as provision makes it
   * (`applyNetworkPlans`): from the server's inspection read through Docker, with its private key
   * only when the server does not hold it.
   */
  async function networkPlan(plan: DeployPlan, server: ServerName) {
    const facts = await inspectHost(servers[server].login, { rootImage: ROOT_IMAGE });
    expect(facts.privilege, `${server}: how deploy becomes root`).toBe("docker");
    const hostPlan = networkHostPlan(
      plan,
      server,
      facts,
      { endpoints, sshPort: 22, alone: true },
      COMMAND,
    );
    const held = facts.network?.interfaces.find((i) => i.name === IFACE)?.publicKey;
    const key = held === keys[server].publicKey ? undefined : keys[server].privateKey;
    return { hostPlan, secrets: key === undefined ? {} : { wireguardKey: key } };
  }

  async function applyNetwork(plan: DeployPlan, server: ServerName) {
    const { hostPlan, secrets } = await networkPlan(plan, server);
    return apply(server, hostPlan, secrets);
  }

  /** `docker compose -p shop <args>` on `data` as deploy in the app's folder. */
  function composeOnData(args: string[], timeoutMs = TWO_MINUTES): Promise<CommandResult> {
    return asDeploy(servers.data.name, APP_DIR, ["docker", "compose", "-p", APP, ...args], {
      timeoutMs,
    });
  }

  /** `args` in the service's container on `data`, with `env` set there. */
  function inService(service: string, args: string[], env: Record<string, string> = {}) {
    const flags = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
    return composeOnData(["exec", "-T", ...flags, service, ...args]);
  }

  /**
   * Deploys `plan`'s services on `data` as the deploy does: its Compose file, the services' env
   * files (with the devices' password hashes for the Redis-protocol engines, as provision stores
   * them) and settings files in the app's folder, `up -d --wait --remove-orphans`, then each
   * service's setup step unless its check passes.
   */
  async function deploy(plan: DeployPlan) {
    for (const grant of plan.network?.grants ?? []) {
      const kind = plan.services.find((s) => s.name === grant.service)?.kind;
      if (kind !== "valkey" && kind !== "redis" && kind !== "dragonfly") continue;
      const hash = createHash("sha256")
        .update(password(grant.device as DeviceName, grant.service))
        .digest("hex");
      values.services[grant.service] = {
        ...values.services[grant.service],
        [grantHashSecret(grant.device)]: hash,
      };
    }
    await checked(
      asDeploy(servers.data.name, "/srv/apps", ["mkdir", "-p", APP_DIR]),
      "the app folder on data",
    );
    const env = serviceEnvSecrets(plan, { values });
    const files = new Map([["compose.yaml", renderServerCompose(plan, "data").content]]);
    for (const service of plan.services) {
      const text = env[serviceEnvSecret(service.name)];
      if (text !== undefined) files.set(`${service.name}.env`, text);
    }
    for (const [path, content] of runtimeFiles(plan)) {
      if (path.startsWith("services/")) files.set(path, content);
    }
    for (const [path, content] of files) {
      await checked(
        asDeploy(
          servers.data.name,
          APP_DIR,
          ["sh", "-c", 'mkdir -p "$(dirname "$1")" && umask 077 && cat > "$1"', "sh", path],
          { input: content },
        ),
        `writing ${path} on data`,
      );
    }
    const up = await composeOnData(["up", "-d", "--wait", "--remove-orphans"], TEN_MINUTES);
    if (up.exitCode !== 0) {
      const logs = await composeOnData(["logs", "--tail", "40"]);
      throw new Error(
        `The services on data did not become healthy (exit ${up.exitCode}):\n${tail(up.stderr, 20)}\n${tail(logs.stdout, 80)}`,
      );
    }
    for (const step of initStepsFor(plan, "data")) {
      const done = await inService(step.service, [...step.check]);
      if (done.exitCode === 0) continue;
      await checked(inService(step.service, [...step.run]), `${step.service}'s setup on data`);
    }
  }

  /** A new turn's plan on `data`: its services' values, its network host plan, its deploy. */
  async function startTurn(services: PlanService[], grants: Grant[]): Promise<void> {
    const plan = splitPlan(services, grants);
    values = (await assembleAppEnv({ plan, ask: async () => ({ skip: true }) })).values;
    await applyNetwork(plan, "data");
    await deploy(plan);
  }

  /** The `grant` host plan on `data` for `params`, applied. */
  async function grantStep(params: GrantParams) {
    const facts = await inspectHost(servers.data.login, { rootImage: ROOT_IMAGE });
    const plan = planGrant(facts, { app: APP, grant: params }, COMMAND);
    const secrets = params.remove
      ? {}
      : { grantPassword: password(params.login as DeviceName, params.service) };
    return { plan, result: await apply("data", plan, secrets) };
  }

  /** Gives the login its access, then checks that the step's own check sees it in place. */
  async function granted(params: Omit<GrantParams, "remove">) {
    const { plan, result } = await grantStep({ ...params, remove: false });
    expect(result.applied, `${params.service}: the grant step`).toEqual(["grant"]);
    const again = await apply("data", plan, {
      grantPassword: password(params.login as DeviceName, params.service),
    });
    expect(again.skipped, `${params.service}: the grant step's check`).toEqual(["grant"]);
  }

  /** `args` on `app` as root, in its own Docker's device container `laptop`. */
  function onDevice(args: string[], env: Record<string, string> = {}) {
    const flags = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
    return docker(["exec", servers.app.name, "docker", "exec", ...flags, "laptop", ...args]);
  }

  /** pg_isready's exit code from the device: 0 accepting, 2 no answer. */
  async function deviceReachesPostgres(): Promise<number> {
    return (await onDevice(["pg_isready", "-h", DATA_IP, "-p", "5432", "-t", "3"])).exitCode;
  }

  /** stdout and stderr together, for a refusal's message. */
  const output = (result: CommandResult) => `${result.stdout}\n${result.stderr}`;

  beforeAll(async () => {
    before = await imageIds();
    for (const ref of SERVICE_IMAGES.concat(ROOT_IMAGE)) {
      if (!(await hasImage(ref))) await dockerOk(["pull", ref], `pulling ${ref}`, TEN_MINUTES);
    }
    await checked(
      dockerWith(
        ["build", "-q", "--label", LABEL, "-t", image, "-"],
        SERVER_DOCKERFILE,
        TEN_MINUTES,
      ),
      "building the servers' image",
    );
    await dockerOk(["network", "create", "--label", LABEL, network], "creating the network");
    const [app, data] = await Promise.all([
      startServer(names.app, image, network),
      startServer(names.data, image, network),
    ]);
    servers = { app, data };
    endpoints = { app: app.address, data: data.address };
    await Promise.all([
      copyImages(app.name, [ROOT_IMAGE, POSTGRES_IMAGE]),
      copyImages(data.name, [ROOT_IMAGE, ...SERVICE_IMAGES]),
    ]);
  }, 3 * TEN_MINUTES);

  afterAll(async () => {
    for (const name of Object.values(names)) {
      await docker(["rm", "-f", "-v", name]);
      await docker(["volume", "rm", `${name}-docker`, `${name}-containerd`]);
    }
    await docker(["network", "rm", network]);
    await docker(["image", "rm", image]);
    await removeNewImages(before, [...SERVICE_IMAGES, ROOT_IMAGE, UBUNTU]);
  }, TEN_MINUTES);

  it(
    "joins both servers to the network with the real host plans, as deploy through Docker",
    async () => {
      const plan = splitPlan(TURNS.first);
      for (const server of ["app", "data"] as const) {
        const result = await applyNetwork(plan, server);
        expect(result.applied, `${server}: applied`).toEqual(["network", "network-filter"]);
      }
      await until(
        "app's ping to data's private address",
        async () =>
          (await docker(["exec", servers.app.name, "ping", "-c", "1", "-W", "2", DATA_IP]))
            .exitCode === 0 || undefined,
        30_000,
      );
      // Read back as root through Docker, both servers are as planned.
      for (const server of ["app", "data"] as const) {
        const { hostPlan } = await networkPlan(plan, server);
        expect(
          hostPlan.steps.map((step) => `${step.id}: ${step.state}`),
          `${server}: planned again`,
        ).toEqual(["network: in-place", "network-filter: in-place"]);
      }
    },
    TEN_MINUTES,
  );

  it(
    "adds a peer on both servers while app pings data's private address, losing nothing",
    async () => {
      const ping = docker(
        ["exec", servers.app.name, "ping", "-c", "60", "-i", "0.2", "-W", "1", DATA_IP],
        TWO_MINUTES,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      devices.push("phone");
      const plan = splitPlan(TURNS.first);
      for (const server of ["app", "data"] as const) {
        const result = await applyNetwork(plan, server);
        expect(result.applied, `${server}: applied`).toEqual(["network"]);
        const peers = await asRoot(servers[server].name, `wg show ${IFACE} peers`, "wg show");
        expect(peers, `${server}: the new peer`).toContain(keys.phone.publicKey);
      }
      const pinged = await ping;
      expect(pinged.exitCode, output(pinged)).toBe(0);
      expect(pinged.stdout).toMatch(/ 60 received, 0% packet loss/);
    },
    TEN_MINUTES,
  );

  it(
    "runs the services on data's private address; Kafka's check and MongoDB's replica set reach it",
    async () => {
      await startTurn(TURNS.first, []);
      const ports = await composeOnData(["port", "db", "5432"]);
      expect(ports.stdout.trim()).toBe(`${DATA_IP}:5432`);
      // Kafka's own health check reached the broker it advertises (`up --wait` waited for it).
      const kafka = await composeOnData(["ps", "--format", "{{.Health}}", "kafka"]);
      expect(kafka.stdout.trim()).toBe("healthy");
      // The replica set's one member is data's private address, and it took the primary's role.
      const hello = await inService("mongodb", [
        "bash",
        "-c",
        'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval \'const h = db.hello(); print(h.isWritablePrimary + " " + h.me)\'',
      ]);
      expect(hello.exitCode, output(hello)).toBe(0);
      expect(hello.stdout.trim()).toBe(`true ${DATA_IP}:27017`);
    },
    TEN_MINUTES,
  );

  it(
    "reaches Postgres on data's private address from a container on a bridge network of app",
    async () => {
      await checked(
        inService("db", [
          ...["psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-c"],
          "CREATE TABLE items (id int PRIMARY KEY); INSERT INTO items VALUES (1);",
        ]),
        "the app's table",
      );
      await asRoot(servers.app.name, "docker network create apps >/dev/null", "a bridge network");
      const query = await docker([
        ...["exec", servers.app.name, "docker", "run", "--rm", "--network", "apps"],
        ...["-e", `PGPASSWORD=${values.services.db?.password}`, POSTGRES_IMAGE],
        ...["psql", "-h", DATA_IP, "-U", "app", "-d", "app", "-tAc", "SELECT count(*) FROM items"],
      ]);
      expect(query.exitCode, output(query)).toBe(0);
      expect(query.stdout.trim()).toBe("1");
    },
    TWO_MINUTES,
  );

  it(
    "refuses a device on Postgres's port until its grant, and again after the revoke",
    async () => {
      // The device: a container of app whose only interface is its own WireGuard link to data.
      await asRoot(
        servers.app.name,
        `set -e
docker run -d --name laptop --network none --entrypoint sleep ${POSTGRES_IMAGE} infinity >/dev/null
pid=$(docker inspect -f '{{.State.Pid}}' laptop)
umask 077
cat > /root/laptop.key
ip link add wg-laptop type wireguard
wg set wg-laptop private-key /root/laptop.key peer ${keys.data.publicKey} endpoint ${servers.data.address}:${PORT} allowed-ips ${DATA_IP}/32 persistent-keepalive 25
rm -f /root/laptop.key
ip link set wg-laptop netns "$pid"
nsenter -t "$pid" -n ip addr add ${DEVICES.laptop}/24 dev wg-laptop
nsenter -t "$pid" -n ip link set wg-laptop up`,
        "the device laptop",
        `${keys.laptop.privateKey}\n`,
      );
      await until(
        "the device's ping to data",
        async () =>
          (await onDevice(["ping", "-c", "1", "-W", "2", DATA_IP])).exitCode === 0 || undefined,
        30_000,
      );
      expect(await deviceReachesPostgres(), "before the grant").toBe(2);

      const grant = {
        service: "db",
        kind: "postgres",
        login: "laptop",
        access: "read-only",
      } as const;
      await applyNetwork(
        splitPlan(TURNS.first, [{ device: "laptop", service: "db", access: "read-only" }]),
        "data",
      );
      await granted(grant);
      const login = { PGPASSWORD: password("laptop", "db") };
      const psql = ["psql", "-h", DATA_IP, "-U", "laptop", "-d", "app", "-v", "ON_ERROR_STOP=1"];
      const read = await onDevice([...psql, "-tAc", "SELECT count(*) FROM items"], login);
      expect(read.exitCode, output(read)).toBe(0);
      expect(read.stdout.trim()).toBe("1");
      const write = await onDevice([...psql, "-c", "INSERT INTO items VALUES (9)"], login);
      expect(write.exitCode).not.toBe(0);
      expect(write.stderr).toMatch(/permission denied for table items/);

      await applyNetwork(splitPlan(TURNS.first), "data");
      const { result } = await grantStep({ ...grant, remove: true });
      expect(result.applied).toEqual(["grant"]);
      expect(await deviceReachesPostgres(), "after the revoke").toBe(2);
      const roles = await inService("db", [
        ...["psql", "-U", "app", "-d", "app", "-tAc"],
        "SELECT count(*) FROM pg_roles WHERE rolname = 'laptop'",
      ]);
      expect(roles.stdout.trim()).toBe("0");
    },
    TEN_MINUTES,
  );

  it(
    "gives the devices their logins; MySQL's and MongoDB's read-only ones read and cannot write",
    async () => {
      const plan = splitPlan(TURNS.first, [
        { device: "laptop", service: "mysql", access: "read-only" },
        { device: "laptop", service: "mongodb", access: "read-only" },
        { device: "laptop", service: "cache", access: "read-only" },
        { device: "desk", service: "db", access: "full" },
        { device: "desk", service: "cache", access: "full" },
      ]);
      await applyNetwork(plan, "data");
      // Valkey starts again with the devices' logins in its environment.
      await deploy(plan);
      await granted({ service: "mysql", kind: "mysql", login: "laptop", access: "read-only" });
      await mysqlReadOnly("mysql", "mysql", "MYSQL_ROOT_PASSWORD");
      await granted({ service: "mongodb", kind: "mongodb", login: "laptop", access: "read-only" });
      await checked(
        inService("mongodb", [
          "bash",
          "-c",
          'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin app --eval "db.items.insertOne({ n: 1 })"',
        ]),
        "MongoDB's document",
      );
      const url = `mongodb://laptop:${password("laptop", "mongodb")}@${DATA_IP}:27017/app?authSource=admin&directConnection=true`;
      const read = await inService("mongodb", [
        ...["mongosh", "--quiet", url, "--eval", "db.items.countDocuments()"],
      ]);
      expect(read.exitCode, output(read)).toBe(0);
      expect(read.stdout.trim()).toBe("1");
      const write = await inService("mongodb", [
        ...["mongosh", "--quiet", url, "--eval", "db.items.insertOne({ n: 2 })"],
      ]);
      expect(write.exitCode).not.toBe(0);
      expect(output(write)).toMatch(/not authorized on app/);
    },
    TEN_MINUTES,
  );

  it(
    "gives Postgres a full login that writes rows but is refused COPY … PROGRAM and DDL",
    async () => {
      await granted({ service: "db", kind: "postgres", login: "desk", access: "full" });
      const psql = (sql: string) =>
        inService(
          "db",
          ["psql", "-h", DATA_IP, "-U", "desk", "-d", "app", "-v", "ON_ERROR_STOP=1", "-c", sql],
          { PGPASSWORD: password("desk", "db") },
        );
      const insert = await psql("INSERT INTO items VALUES (2)");
      expect(insert.exitCode, output(insert)).toBe(0);
      const refused = {
        "COPY items FROM PROGRAM 'id'": /permission denied to COPY to or from an external program/,
        "ALTER TABLE items ADD COLUMN extra int": /must be owner of table items/,
        "DROP TABLE items": /must be owner of table items/,
        "CREATE TABLE extra (id int)": /permission denied for schema public/,
      };
      for (const [sql, message] of Object.entries(refused)) {
        const result = await psql(sql);
        expect(result.exitCode, sql).not.toBe(0);
        expect(result.stderr, sql).toMatch(message);
      }
    },
    TWO_MINUTES,
  );

  it(
    "starts Valkey on its ACL file: a read-only login reads, a full one writes but has no admin",
    async () => {
      await aclLogins("cache", "valkey-cli", "VALKEY_PASSWORD");
    },
    TWO_MINUTES,
  );

  it(
    "runs Redpanda on data's private address, with MariaDB's and Redis's device logins",
    async () => {
      await startTurn(TURNS.second, [
        { device: "laptop", service: "mariadb", access: "read-only" },
        { device: "laptop", service: "redis", access: "read-only" },
        { device: "desk", service: "redis", access: "full" },
      ]);
      // Its own client reaches the broker it advertises, data's private address.
      const health = await composeOnData(["ps", "--format", "{{.Health}}", "redpanda"]);
      expect(health.stdout.trim()).toBe("healthy");
      const topic = await inService("redpanda", ["rpk", "topic", "create", "opscrew-check"]);
      expect(topic.exitCode, output(topic)).toBe(0);
      await granted({ service: "mariadb", kind: "mariadb", login: "laptop", access: "read-only" });
      await mysqlReadOnly("mariadb", "mariadb", "MARIADB_ROOT_PASSWORD");
      await aclLogins("redis", "redis-cli", "REDIS_PASSWORD");
    },
    TEN_MINUTES,
  );

  it(
    "starts Dragonfly on its ACL file: a read-only login reads, a full one writes but has no admin",
    async () => {
      await startTurn(TURNS.third, [
        { device: "laptop", service: "dragonfly", access: "read-only" },
        { device: "desk", service: "dragonfly", access: "full" },
      ]);
      await aclLogins("dragonfly", "redis-cli", "DFLY_requirepass");
    },
    TEN_MINUTES,
  );

  /**
   * MySQL's or MariaDB's `laptop` login, read-only: it counts the app's rows and is refused an
   * insert. The table is made as root (`rootVariable` holds its password in the container).
   */
  async function mysqlReadOnly(service: string, client: string, rootVariable: string) {
    await checked(
      inService(service, [
        "sh",
        "-c",
        `MYSQL_PWD="$${rootVariable}" ${client} -uroot app -e "CREATE TABLE items (id INT PRIMARY KEY); INSERT INTO items VALUES (1)"`,
      ]),
      `${service}'s table`,
    );
    const login = { MYSQL_PWD: password("laptop", service) };
    const as = (sql: string) =>
      inService(service, [client, "-h", DATA_IP, "-u", "laptop", "-N", "app", "-e", sql], login);
    const read = await as("SELECT COUNT(*) FROM items");
    expect(read.exitCode, output(read)).toBe(0);
    expect(read.stdout.trim()).toBe("1");
    const write = await as("INSERT INTO items VALUES (2)");
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr).toMatch(/INSERT command denied to user 'laptop'/);
  }

  /**
   * A Valkey, Redis or Dragonfly started on the wrapper's ACL file: the app's login (`variable`
   * holds its password in the container) writes a key; `laptop` (read-only) reads it and is
   * refused a write; `desk` (full) writes, and is refused CONFIG, MODULE and SHUTDOWN.
   */
  async function aclLogins(service: string, cli: string, variable: string) {
    await checked(
      inService(service, ["sh", "-c", `REDISCLI_AUTH="$${variable}" ${cli} SET opscrew:check app`]),
      `${service}'s key`,
    );
    const as = (device: DeviceName, ...args: string[]) =>
      inService(service, [
        ...[cli, "-h", DATA_IP, "--user", device, "--pass", password(device, service)],
        ...["--no-auth-warning", ...args],
      ]);
    expect((await as("laptop", "GET", "opscrew:check")).stdout.trim()).toBe("app");
    expect(output(await as("laptop", "SET", "opscrew:check", "laptop"))).toMatch(/NOPERM/);
    expect((await as("desk", "SET", "opscrew:check", "desk")).stdout.trim()).toBe("OK");
    for (const command of [["CONFIG", "GET", "maxmemory"], ["MODULE", "LIST"], ["SHUTDOWN"]]) {
      expect(output(await as("desk", ...command)), command.join(" ")).toMatch(/NOPERM/);
    }
    expect((await as("desk", "PING")).stdout.trim()).toBe("PONG");
  }
});
