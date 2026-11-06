/**
 * The CLI side of the `opscrew retarget` tests: a live deployment of `shop` from the harness, on
 * Hetzner Cloud, the user's own server or their Portainer, with every fake of
 * `@opscrew/agents/testing`'s move (`moveFakes`), the user's own server's host adapter and the
 * user's Portainer (its API, and its Docker proxy to a Docker fake), a command runner for resolved
 * binaries that copies between the fake servers, and a CLI context for each run. Tests only.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type HostAdapterApi,
  NEW_STORAGE_KEY_VARS,
  type PortainerAccess,
  recordOwnServer,
  recordPortainerConnection,
  STORAGE_KEY_VARS,
  updateServerAddresses,
} from "@opscrew/agents";
import {
  DOMAIN,
  FakeBucketEngine,
  type FakeHosts,
  FakeHostServer,
  type FakePortainer,
  fakePortainer,
  FakeRclone,
  fingerprintOf,
  freshFacts,
  HOST_KEY,
  moveFakes,
  movePlan,
  OLD_IPV4,
  OLD_IPV6,
  PORTAINER_CERT,
  PORTAINER_TOKEN,
  PORTAINER_URL,
  portainerServices,
  preparedServerFacts,
  projectRunner,
  RootEngine,
  siteMoveHarness,
  targetOf,
  withBucket,
} from "@opscrew/agents/testing";
import type { FakeDocker } from "@opscrew/connector-docker/testing";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  FetchLike,
  RemoteExec,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, type ServerlessProvider } from "@opscrew/plan-schema";
import { type CliServices, withServices } from "../../deps";
import { deployProject } from "./deploy";
import { projectContext } from "./harness";

/** Where a move in these tests starts: a cloud provider, the user's own server, their Portainer. */
export type MoveFrom = "hetzner" | "own" | "portainer";

/** The fingerprint of the host key every fake server presents (`ssh-keyscan` answers it). */
export const HOST_KEY_FINGERPRINT = fingerprintOf(HOST_KEY.split(" ")[1] ?? "");
/** The user's own new server, as a move to it is answered. */
export const OWN_NEW_IPV4 = "198.51.100.40";
/** The public address of the user's Portainer host, where its Caddy serves the app. */
export const PORTAINER_IPV4 = "198.51.100.50";
/** The repository's read-only token for Portainer (synthetic). */
export const REPO_READ_TOKEN = fakeSecret("github-pat");
/** The Docker fake's name for the user's Portainer environment. */
const PORTAINER_DOCKER = "portainer";

/** Real git; `ssh-keyscan` answers with {@link HOST_KEY}; `scp` copies between the fake hosts. */
class MoveRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner({ defaultTimeoutMs: 60_000 });

  constructor(private readonly hosts: FakeHosts) {}

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.exe$/i, "");
    if (name === "git") return this.#node.run(command, args, options);
    if (name === "ssh-keyscan") {
      return { exitCode: 0, stdout: `${args[args.length - 1]} ${HOST_KEY}\n`, stderr: "" };
    }
    if (name === "scp") return this.hosts.scp(args);
    // The admin login of the user's own server (the host adapter's work is the fake's).
    if (name === "ssh" && args.some((arg) => arg.startsWith("root@"))) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "not found" };
  }
}

/**
 * The user's Portainer with environment 3 (a Docker host): with `live`, the app's stack is there
 * already (OpsCrew's record lists it as id 7).
 */
function userPortainer(live: boolean): FakePortainer {
  const stack = {
    Id: 7,
    Name: "opscrew-shop",
    Type: 2,
    EndpointId: 3,
    Status: 1,
    Env: [],
    DeploymentStatus: [],
    file: "",
  };
  return fakePortainer({ token: PORTAINER_TOKEN, stacks: live ? [stack] : [] });
}

/** The app's stack in the Portainer environment: the app, its services and the stack's Caddy. */
function seedStack(hosts: FakeHosts, docker: FakeDocker): void {
  hosts.seed(PORTAINER_DOCKER, {}, true);
  const id = "portainer-caddy".padEnd(64, "0");
  if (docker.containers.has(id)) return;
  docker.containers.set(id, {
    id,
    name: "opscrew-shop-caddy-1",
    image: "caddy",
    cmd: [],
    env: [],
    labels: { [COMPOSE_PROJECT_LABEL]: "opscrew-shop", [COMPOSE_SERVICE_LABEL]: "caddy" },
    binds: [],
    mounts: [],
    state: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
}

/** Whether the app answers through the stack's Caddy in the Portainer environment. */
function portainerServes(docker: FakeDocker): boolean {
  const running = (service: string) =>
    [...docker.containers.values()].some(
      (c) =>
        c.labels[COMPOSE_PROJECT_LABEL] === "opscrew-shop" &&
        c.labels[COMPOSE_SERVICE_LABEL] === service &&
        c.state === "running",
    );
  return running("app") && running("caddy");
}

/** Portainer's certificate and its one usable Docker environment, as the answers reach them. */
const portainerAccess: PortainerAccess = {
  fetchCertificateFingerprint: async () => PORTAINER_CERT.fingerprint,
  listEnvironments: async () => [{ id: 3, name: "local", kind: "docker", up: true, arch: "amd64" }],
};

/** The keys of the app's bucket at Hetzner and of its new bucket at DigitalOcean (synthetic). */
export const BUCKET_KEYS = {
  old: {
    accessKeyId: fakeSecret("aws-access-key-id", "old-bucket"),
    secretAccessKey: fakeSecret("aws-secret-access-key", "old-bucket"),
  },
  new: {
    accessKeyId: fakeSecret("aws-access-key-id", "new-bucket"),
    secretAccessKey: fakeSecret("aws-secret-access-key", "new-bucket"),
  },
};

/**
 * A live deployment of `shop` (Cloudflare DNS, self-hosted Postgres holding `orders before the
 * move`) on `from` (default Hetzner Cloud) and its fakes. With `bucket`, its files are in the
 * bucket `shop-uploads` at Hetzner Object Storage (holding three files), with the bucket's root
 * and state as provision left them, both buckets' keys in the environment, and the servers'
 * rclone one-offs.
 */
export async function moveProject(options: { from?: MoveFrom; bucket?: boolean } = {}) {
  const from = options.from ?? "hetzner";
  const base = movePlan();
  const placed =
    from === "hetzner"
      ? base
      : DeployPlanSchema.parse({
          ...base,
          target: targetOf(from),
          dns: { ...base.dns, proxied: false },
        });
  const plan = options.bucket === true ? withBucket(placed, "hetzner") : placed;
  const project = await deployProject(plan);
  const fakes = await moveFakes(project.root, project.env);
  const { hosts, engine, paths } = fakes;
  const runner = new MoveRunner(hosts);
  let seconds = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, seconds++)) };
  const env = {
    ...fakes.env,
    PORTAINER_API_KEY: PORTAINER_TOKEN,
    // The read-only token Portainer fetches the private repository's deploy branch with.
    OPSCREW_REPO_READ_TOKEN: REPO_READ_TOKEN,
    ...(options.bucket === true
      ? {
          [STORAGE_KEY_VARS.accessKeyId]: BUCKET_KEYS.old.accessKeyId,
          [STORAGE_KEY_VARS.secretAccessKey]: BUCKET_KEYS.old.secretAccessKey,
          [NEW_STORAGE_KEY_VARS.accessKeyId]: BUCKET_KEYS.new.accessKeyId,
          [NEW_STORAGE_KEY_VARS.secretAccessKey]: BUCKET_KEYS.new.secretAccessKey,
        }
      : {}),
  };
  // The bucket's root's state, its engine beside the move's, and rclone on the servers.
  const storage = new FakeBucketEngine(fakes.events, { bucket: "shop-uploads", region: "fsn1" });
  const rclone = new FakeRclone(fakes.events);
  if (options.bucket === true) {
    await writeFile(path.join(paths.files.tfstateDir, "storage.tfstate"), '{"version":4}\n');
    for (const name of ["a.png", "b.png", "c.pdf"]) rclone.old.set(name, `${name} bytes`);
  }

  if (from !== "hetzner") {
    // No server of OpsCrew's in the state: DNS points at the old side's public address.
    engine.state.servers = {};
    engine.state.dns = OLD_IPV4;
    engine.state.outputs = { servers: {} };
  }
  if (from === "own") {
    await recordOwnServer(paths, {
      host: OLD_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      serve: "dns-only",
      hostKey: HOST_KEY_FINGERPRINT,
    });
  }
  if (from === "portainer") {
    await recordPortainerConnection(paths, {
      url: PORTAINER_URL,
      certFingerprint: PORTAINER_CERT.fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "caddy", records: true },
      created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" }], volumes: [] },
    });
    await updateServerAddresses(paths, (current) => ({
      ...current,
      deployment: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 },
    }));
    // The app runs in the Portainer environment with its data; nothing on a server.
    Object.assign(hosts.host(PORTAINER_DOCKER), { app: true, db: "orders before the move" });
    const file = { type: "file" as const, mode: 0o600, uid: 999, gid: 999 };
    hosts.seed(PORTAINER_DOCKER, { PG_VERSION: { ...file, data: Buffer.alloc(1024) } }, true);
    seedStack(hosts, hosts.docker(PORTAINER_DOCKER));
    Object.assign(hosts.host(OLD_IPV4), { app: false, caddy: false, db: "empty" });
  }
  // The database's password in the app's generated values.
  await writeFile(
    path.join(paths.projectHomeDir, "generated_values.json"),
    `${JSON.stringify({ dbPassword: fakeSecret("generic-password", "move db password") })}\n`,
  );

  // The domain answers from where DNS points: a server, or the Portainer host's Caddy.
  const portainerDocker = hosts.docker(PORTAINER_DOCKER);
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    // The object storage answers 404 for a deleted bucket.
    if (/your-objectstorage\.com|digitaloceanspaces\.com/.test(url.hostname)) {
      return new Response(null, { status: 404 });
    }
    const at = url.hostname === DOMAIN ? engine.dnsServer()?.ipv4 : undefined;
    if (at === (from === "portainer" ? OLD_IPV4 : PORTAINER_IPV4)) {
      const ok = portainerServes(portainerDocker);
      return new Response(ok ? "ok" : "bad gateway", { status: ok ? 200 : 502 });
    }
    return fakes.fetch(input, init);
  };
  const portainerApi = userPortainer(from === "portainer");
  // The user's servers by address: the old one runs the app when it is the old side.
  const ownHosts = new Map([
    [OLD_IPV4, new FakeHostServer(from === "own" ? preparedServerFacts(paths.projectId) : freshFacts())],
    [OWN_NEW_IPV4, new FakeHostServer(freshFacts())],
  ]);
  const ownHost = (remote: RemoteExec): FakeHostServer => {
    const server = ownHosts.get(remote.host);
    if (server === undefined) throw new Error(`no fake server of the user's at ${remote.host}`);
    return server;
  };
  const host: HostAdapterApi = {
    inspect: (remote) => ownHost(remote).inspect(remote),
    apply: (remote, plan, applyOptions) => ownHost(remote).apply(remote, plan, applyOptions),
  };
  const moveEngine = new RootEngine<FakeBucketEngine>(engine, storage);
  const services = {
    ...fakes.services,
    engine: async () => moveEngine,
    remote: rclone.wrap(hosts.remote),
    own: { host, homeDir: project.root },
    portainer: portainerServices(portainerDocker, {
      portainer: portainerApi,
      onStackCreate: () => seedStack(hosts, portainerDocker),
    }),
  };

  /** A test context for one `opscrew` run in the project, with every fake attached. */
  const context = (options: { interactive?: boolean; services?: CliServices } = {}) => {
    const ctx = projectContext(
      { ...project, env },
      {
        ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
        services: {
          runner,
          fetch,
          streams: hosts.streams,
          clock,
          portainerAccess,
          ...options.services,
        },
      },
    );
    withServices(ctx, { retarget: services });
    return ctx;
  };

  return {
    ...fakes,
    project,
    plan,
    context,
    ownHosts,
    portainerApi,
    portainer: portainerDocker,
    storage,
    rclone,
  };
}

export type MoveProject = Awaited<ReturnType<typeof moveProject>>;

/**
 * A static site of `example-app` live on `from` (`siteMoveHarness`: its roots' engine, GitHub
 * Pages, the Worker in the Cloudflare zone, GitHub's deploy runs), with a CLI context for each
 * `opscrew` run there.
 */
export async function siteMoveProject(from: ServerlessProvider) {
  const site = await siteMoveHarness(from);
  const runner = projectRunner();
  const project = { root: site.root, dir: site.root, env: site.env, cleanup: async () => {} };
  /** A test context for one non-interactive `opscrew` run in the site's project. */
  const context = () => {
    const ctx = projectContext(project, { services: { runner, fetch: site.fetch } });
    withServices(ctx, { retarget: site.services });
    return ctx;
  };
  return { ...site, context };
}

export type SiteMoveProject = Awaited<ReturnType<typeof siteMoveProject>>;
