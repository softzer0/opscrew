import type { PinnedRequest, PinnedRequestInit, PinnedResponse } from "../pinned";

/**
 * A fake Portainer CE 2.45 behind a route map, with the behaviour research R1–R9 observed on a live
 * server: tokens and roles, environment access, stacks with asynchronous deploys and their failure
 * semantics (R7), Git stacks built from a branch with the webhook (R5), registries (R4), and the
 * Docker proxy for containers and volumes (R6, R9). State is plain data so tests can inspect it.
 */

export type DeployOutcome =
  | { kind: "ok" }
  | { kind: "invalid" | "missing-image" | "port-conflict"; message?: string };

export interface FakeUser {
  Id: number;
  Username: string;
  /** 1 administrator, 2 regular ("limited") user. */
  Role: 1 | 2;
  token: string;
}

export interface FakeEnvironment {
  Id: number;
  Name: string;
  /** 1 Docker, 2 agent, 3 ACI, 4 Edge, 5–7 Kubernetes. */
  Type: number;
  Status: 1 | 2;
  /** The snapshot's Swarm flag. */
  swarm: boolean;
  /** Docker's `Architecture` (`x86_64`, `aarch64`). */
  arch: string;
  dockerVersion: string;
  /** Regular users who may use the environment (administrators always may). */
  users: number[];
  /** Docker's `NCPU` and `MemTotal` (default 4 and 8 GiB). */
  cpus?: number;
  memoryBytes?: number;
}

export interface FakeStack {
  Id: number;
  Name: string;
  Type: 1 | 2 | 3;
  EndpointId: number;
  Env: { name: string; value: string }[];
  Status: 1 | 2 | 3 | 4;
  DeploymentStatus: { Status: number; Message?: string; Time?: number }[];
  AutoUpdate: {
    Webhook?: string;
    ForcePullImage?: boolean;
    ForceUpdate?: boolean;
    Interval?: string;
  } | null;
  GitConfig: {
    URL: string;
    ReferenceName: string;
    ConfigFilePath: string;
    Authentication: { Username: string; Password: string } | null;
  } | null;
  /** The last good stack file (what runs). */
  file: string;
  /** The user who created it (its resource control). */
  ownerId: number;
  /** The containers of its Compose project. */
  containers: "running" | "stopped" | "none";
  /** Host ports its containers publish while they run. */
  ports: number[];
  /** Git stacks: the branch commit that was deployed last. */
  deployedCommit?: string;
  /** Deploys started, for assertions (R5: an unchanged branch does not redeploy). */
  deploys: number;
  pending?: {
    polls: number;
    outcome: DeployOutcome;
    file: string;
    commit?: string;
    wasHealthy: boolean;
    /** Not marked deploying yet (`answerBeforeDeploying`). */
    unmarked?: boolean;
  };
  /** Started but not running yet: reads left that still show Status 2 (`startPolls`). */
  starting?: number;
}

export interface FakeRegistry {
  Id: number;
  Name: string;
  Type: number;
  URL: string;
  Username: string;
  Password: string;
  /** Environment id → users who may use the entry there. */
  accesses: Record<number, number[]>;
}

/** A container Portainer did not create (another Compose project, a plain `docker run`). */
export interface FakeContainer {
  EndpointId: number;
  project?: string;
  /** Its Compose service, and whether it is a one-off container (`docker compose run`). */
  service?: string;
  oneOff?: boolean;
  running: boolean;
  ports: number[];
  /** Its Docker id (default `c<index>` in the list); the routes below find it by this id. */
  id?: string;
  /** What `…/containers/{id}/logs` answers: Docker's framing ({@link dockerFrames}) or raw TTY. */
  logs?: Uint8Array;
  /** What `…/containers/{id}/stats` and `…/containers/{id}/json` answer, as Docker gives them. */
  stats?: unknown;
  inspect?: unknown;
}

/** Docker's log framing: an 8-byte header (stream, 0, 0, 0, big-endian size) before each chunk. */
export function dockerFrames(
  ...frames: [stream: number, payload: string | Uint8Array][]
): Uint8Array {
  return Buffer.concat(
    frames.map(([stream, payload]) => {
      const bytes = Buffer.from(payload);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(bytes.length, 4);
      return Buffer.concat([header, bytes]);
    }),
  );
}

export interface FakeVolume {
  EndpointId: number;
  Name: string;
  project?: string;
}

/** A branch of a Git repository Portainer can clone. */
export interface FakeBranch {
  commit: string;
  file: string;
  /** Private repositories need this password (a read-only token). */
  password?: string;
}

export interface FakeState {
  version: string;
  edition: string;
  composeVersion: string;
  users: FakeUser[];
  environments: FakeEnvironment[];
  stacks: FakeStack[];
  registries: FakeRegistry[];
  containers: FakeContainer[];
  volumes: FakeVolume[];
  /** `<repository URL>#<reference>` → branch. */
  git: Record<string, FakeBranch>;
  /** Outcomes of the next deploys, in order (default: ok). */
  outcomes: DeployOutcome[];
  /** Reads of a deploying stack before its deploy finishes; 0 finishes it before the answer. */
  deployPolls: number;
  /** Keep only the last N `DeploymentStatus` entries (unlimited when absent). */
  deploymentStatusLimit?: number;
  /** Answer before marking the stack deploying (the answer still shows the old status). */
  answerBeforeDeploying?: boolean;
  /**
   * Reads of a started stack that still show it stopped (Status 2). Default 0: the start runs
   * the stack before Portainer answers. Assumption checked live in T1008 (that the start call is
   * synchronous); the adapter also handles a start that is not.
   */
  startPolls?: number;
  /**
   * Leave `Time` out of new `DeploymentStatus` entries. By default every entry has a Time, an
   * assumption checked live in T1008; without it the adapter compares the entry count and
   * whether it saw Status 3.
   */
  untimedDeploymentStatus?: boolean;
  /**
   * `PUT /api/registries/{id}` without `RegistryAccesses` clears the entry's grants. By default
   * they stay, an assumption checked live in T1008; apply grants again either way.
   */
  registryUpdateClearsGrants?: boolean;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  /** A body that is not JSON (a log stream). */
  bytes?: Uint8Array;
}

export interface FakePortainerOptions extends Partial<FakeState> {
  /** Forced replies: return one to override a route (for example a 500). */
  override?: (call: RecordedCall) => FakeReply | undefined;
}

/** The fake's default administrator and limited user tokens (synthetic, made at runtime). */
export function fakeTokens(seed: string) {
  return {
    admin: `ptr_FAKE${seed}admin${"a".repeat(24)}`,
    limited: `ptr_FAKE${seed}limited${"b".repeat(22)}`,
  };
}

export function fakePortainer(options: FakePortainerOptions = {}) {
  const tokens = fakeTokens("default");
  const state: FakeState = {
    version: options.version ?? "2.45.2",
    edition: options.edition ?? "CE",
    composeVersion: options.composeVersion ?? "2.39.1",
    users: options.users ?? [
      { Id: 1, Username: "admin", Role: 1, token: tokens.admin },
      { Id: 2, Username: "dev", Role: 2, token: tokens.limited },
    ],
    environments: options.environments ?? [
      {
        Id: 3,
        Name: "nas",
        Type: 1,
        Status: 1,
        swarm: false,
        arch: "x86_64",
        dockerVersion: "29.9.1",
        users: [2],
      },
    ],
    stacks: options.stacks ?? [],
    registries: options.registries ?? [],
    containers: options.containers ?? [],
    volumes: options.volumes ?? [],
    git: options.git ?? {},
    outcomes: options.outcomes ?? [],
    deployPolls: options.deployPolls ?? 1,
    ...(options.deploymentStatusLimit !== undefined && {
      deploymentStatusLimit: options.deploymentStatusLimit,
    }),
    ...(options.answerBeforeDeploying !== undefined && {
      answerBeforeDeploying: options.answerBeforeDeploying,
    }),
    ...(options.startPolls !== undefined && { startPolls: options.startPolls }),
    ...(options.untimedDeploymentStatus !== undefined && {
      untimedDeploymentStatus: options.untimedDeploymentStatus,
    }),
    ...(options.registryUpdateClearsGrants !== undefined && {
      registryUpdateClearsGrants: options.registryUpdateClearsGrants,
    }),
  };
  const calls: RecordedCall[] = [];
  let clock = 1_760_000_000;
  let nextId = 100;

  const reply = (status: number, body?: unknown): FakeReply => ({
    status,
    ...(body !== undefined && { body }),
  });
  const denied = () => reply(403, { message: "Access denied to resource", details: "" });
  const notFound = (what: string) => reply(404, { message: `Unable to find ${what}` });

  const isAdmin = (user: FakeUser) => user.Role === 1;
  const environment = (envId: number) => state.environments.find((env) => env.Id === envId);
  const mayUseEnvironment = (user: FakeUser, env: FakeEnvironment) =>
    isAdmin(user) || env.users.includes(user.Id);
  const mayUseStack = (user: FakeUser, stack: FakeStack) =>
    isAdmin(user) || stack.ownerId === user.Id;
  const ownsProject = (user: FakeUser, envId: number, project: string | undefined) =>
    isAdmin(user) ||
    state.stacks.some(
      (stack) => stack.EndpointId === envId && stack.Name === project && stack.ownerId === user.Id,
    );

  /** Portainer returns `Env` values in plain text (R7); the client must drop them. */
  const stackJson = (stack: FakeStack) => ({
    Id: stack.Id,
    Name: stack.Name,
    Type: stack.Type,
    EndpointId: stack.EndpointId,
    EntryPoint: stack.GitConfig?.ConfigFilePath ?? "docker-compose.yml",
    Env: stack.Env,
    Status: stack.Status,
    AutoUpdate: stack.AutoUpdate,
    GitConfig: stack.GitConfig,
    DeploymentStatus: stack.DeploymentStatus,
    ResourceControl: { Id: stack.Id + 1000, OwnerId: stack.ownerId },
  });

  const registryJson = (registry: FakeRegistry) => ({
    Id: registry.Id,
    Name: registry.Name,
    Type: registry.Type,
    URL: registry.URL,
    Authentication: true,
    Username: registry.Username,
    // The password is never returned (R4).
    RegistryAccesses: Object.fromEntries(
      Object.entries(registry.accesses).map(([envId, users]) => [
        envId,
        {
          UserAccessPolicies: Object.fromEntries(users.map((uid) => [uid, { RoleId: 0 }])),
          TeamAccessPolicies: {},
          Namespaces: [],
        },
      ]),
    ),
  });

  /** Appends a deploy history entry, keeping at most `deploymentStatusLimit`. */
  function pushStatus(stack: FakeStack, entry: FakeStack["DeploymentStatus"][number]) {
    // Assumption checked live in T1008: Portainer puts a Time on every entry.
    const { Time: _time, ...untimed } = entry;
    stack.DeploymentStatus.push(state.untimedDeploymentStatus === true ? untimed : entry);
    const limit = state.deploymentStatusLimit;
    if (limit !== undefined && stack.DeploymentStatus.length > limit) {
      stack.DeploymentStatus.splice(0, stack.DeploymentStatus.length - limit);
    }
  }

  /** A deploy starts: Portainer answers at once and finishes in the background (R7). */
  function startDeploy(stack: FakeStack, file: string, commit?: string) {
    const wasHealthy = stack.Status === 1;
    if (stack.Status === 4) {
      // R7: a stack already in error is fully removed before its next deploy.
      stack.containers = "none";
    }
    stack.deploys++;
    stack.pending = {
      polls: state.deployPolls,
      outcome: state.outcomes.shift() ?? { kind: "ok" },
      file,
      ...(commit !== undefined && { commit }),
      wasHealthy,
    };
    if (state.answerBeforeDeploying === true) {
      stack.pending.unmarked = true;
      return;
    }
    markDeploying(stack);
    // A fast deploy can finish before Portainer answers.
    if (state.deployPolls === 0) progress(stack);
  }

  function markDeploying(stack: FakeStack) {
    stack.Status = 3;
    pushStatus(stack, { Status: 3, Time: clock++ });
  }

  function progress(stack: FakeStack) {
    if (stack.starting !== undefined) {
      stack.starting--;
      if (stack.starting <= 0) {
        stack.starting = undefined;
        stack.Status = 1;
        stack.containers = "running";
      }
      return;
    }
    const pending = stack.pending;
    if (pending === undefined) return;
    if (pending.unmarked === true) {
      pending.unmarked = false;
      markDeploying(stack);
      return;
    }
    if (pending.polls > 0) {
      pending.polls--;
      return;
    }
    stack.pending = undefined;
    const outcome = pending.outcome;
    if (outcome.kind === "ok") {
      stack.Status = 1;
      stack.file = pending.file;
      if (pending.commit !== undefined) stack.deployedCommit = pending.commit;
      stack.containers = "running";
      pushStatus(stack, { Status: 1, Time: clock++ });
      return;
    }
    // R7 failure semantics: the last good file stays (the new Env is already saved).
    const messages = {
      invalid: "failed to deploy a stack: yaml: line 3: did not find expected key",
      "missing-image":
        "failed to deploy a stack: Error response from daemon: manifest unknown",
      "port-conflict":
        "failed to deploy a stack: Bind for 0.0.0.0:80 failed: port is already allocated",
    } as const;
    if (outcome.kind === "missing-image") {
      // Kept only when the stack was healthy.
      if (!pending.wasHealthy) stack.containers = "none";
    } else if (outcome.kind === "port-conflict") {
      // Recreated and left stopped: the app is down.
      stack.containers = "stopped";
    }
    // invalid: the old containers keep running.
    stack.Status = 4;
    pushStatus(stack, {
      Status: 4,
      Message: outcome.message ?? messages[outcome.kind],
      Time: clock++,
    });
  }

  function cloneBranch(url: string, reference: string, password?: string): FakeBranch | FakeReply {
    const branch = state.git[`${url}#${reference}`];
    if (branch === undefined) {
      return reply(500, {
        message: "Unable to clone git repository",
        details: "failed to clone git repository: reference not found",
      });
    }
    if (branch.password !== undefined && branch.password !== password) {
      return reply(500, {
        message: "Unable to clone git repository",
        details: "failed to clone git repository: authentication required",
      });
    }
    return branch;
  }

  function nameTaken(envId: number, name: string, exceptId?: number) {
    return state.stacks.some(
      (stack) => stack.EndpointId === envId && stack.Name === name && stack.Id !== exceptId,
    );
  }

  function webhookTaken(webhook: string | undefined, exceptId?: number) {
    return (
      webhook !== undefined &&
      webhook !== "" &&
      state.stacks.some((stack) => stack.AutoUpdate?.Webhook === webhook && stack.Id !== exceptId)
    );
  }

  type Body = Record<string, unknown>;
  type Handler = (args: {
    match: RegExpMatchArray;
    query: URLSearchParams;
    body: Body;
    user: FakeUser;
  }) => FakeReply;
  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, pattern: RegExp, handler: Handler) =>
    routes.push([method, pattern, handler]);

  const stackFor = (user: FakeUser, idText: string | undefined) => {
    const stack = state.stacks.find((item) => item.Id === Number(idText));
    if (stack === undefined) return notFound("a stack with the specified identifier");
    if (!mayUseStack(user, stack)) return denied();
    return stack;
  };
  const envFor = (user: FakeUser, idText: string | undefined) => {
    const env = environment(Number(idText));
    if (env === undefined) return notFound("an environment with the specified identifier");
    if (!mayUseEnvironment(user, env)) return denied();
    return env;
  };
  const isReply = (value: unknown): value is FakeReply =>
    typeof value === "object" && value !== null && "status" in value && !("Id" in value);

  route("GET", /^\/api\/system\/version$/, () =>
    reply(200, {
      ServerVersion: state.version,
      ServerEdition: state.edition,
      VersionSupport: "LTS",
      DatabaseVersion: state.version,
      Build: { BuildNumber: "1", GoVersion: "go1.25" },
      Dependencies: { ComposeVersion: state.composeVersion, DockerVersion: "29.0.0" },
      Runtime: { Env: ["PORTAINER_INTERNAL=1"] },
    }),
  );
  route("GET", /^\/api\/users\/me$/, ({ user }) =>
    reply(200, { Id: user.Id, Username: user.Username, Role: user.Role, ThemeSettings: {} }),
  );
  route("GET", /^\/api\/endpoints$/, ({ user }) =>
    reply(
      200,
      state.environments
        .filter((env) => mayUseEnvironment(user, env))
        .map((env) => ({
          Id: env.Id,
          Name: env.Name,
          Type: env.Type,
          Status: env.Status,
          URL: "unix:///var/run/docker.sock",
          Snapshots: [{ Swarm: env.swarm, DockerVersion: env.dockerVersion, TotalCPU: 4 }],
        })),
    ),
  );
  route("GET", /^\/api\/endpoints\/(\d+)\/docker\/info$/, ({ match, user }) => {
    const env = envFor(user, match[1]);
    if (isReply(env)) return env;
    return reply(200, {
      Architecture: env.arch,
      OSType: "linux",
      ServerVersion: env.dockerVersion,
      Swarm: { LocalNodeState: env.swarm ? "active" : "inactive" },
      Name: "nas-host",
      NCPU: env.cpus ?? 4,
      MemTotal: env.memoryBytes ?? 8 * 1024 ** 3,
    });
  });
  route("GET", /^\/api\/endpoints\/(\d+)\/docker\/containers\/json$/, ({ match, user }) => {
    const env = envFor(user, match[1]);
    if (isReply(env)) return env;
    const fromStacks = state.stacks
      .filter((stack) => stack.EndpointId === env.Id && stack.containers !== "none")
      .map(
        (stack): FakeContainer => ({
          EndpointId: env.Id,
          project: stack.Name,
          running: stack.containers === "running",
          ports: stack.ports,
        }),
      );
    const outside = state.containers.filter((container) => container.EndpointId === env.Id);
    const visible = [...fromStacks, ...outside].filter((container) =>
      ownsProject(user, env.Id, container.project),
    );
    return reply(
      200,
      visible.map((container, index) => ({
        Id: container.id ?? `c${index}`,
        Names: [`/container-${index}`],
        State: container.running ? "running" : "exited",
        Labels: {
          ...(container.project !== undefined && {
            "com.docker.compose.project": container.project,
          }),
          ...(container.service !== undefined && {
            "com.docker.compose.service": container.service,
            "com.docker.compose.oneoff": container.oneOff === true ? "True" : "False",
          }),
          "traefik.http.middlewares.auth.basicauth.users": "user:$apr1$FAKEHASH",
        },
        Ports: container.running
          ? container.ports.map((port) => ({ PrivatePort: port, PublicPort: port, Type: "tcp" }))
          : [],
      })),
    );
  });
  route(
    "GET",
    /^\/api\/endpoints\/(\d+)\/docker\/containers\/([^/]+)\/(logs|stats|json)$/,
    ({ match, user }) => {
      const env = envFor(user, match[1]);
      if (isReply(env)) return env;
      const name = decodeURIComponent(match[2] ?? "");
      const container = state.containers.find(
        (item) => item.EndpointId === env.Id && item.id === name,
      );
      if (container === undefined) return reply(404, { message: `No such container: ${name}` });
      // Spike result 7: a standard user reads only its own stacks' containers.
      if (!ownsProject(user, env.Id, container.project)) return denied();
      if (match[3] === "logs") return { status: 200, bytes: container.logs ?? new Uint8Array() };
      return reply(200, match[3] === "stats" ? container.stats : container.inspect);
    },
  );
  route("GET", /^\/api\/endpoints\/(\d+)\/docker\/volumes$/, ({ match, user }) => {
    const env = envFor(user, match[1]);
    if (isReply(env)) return env;
    return reply(200, {
      Volumes: state.volumes
        .filter((volume) => volume.EndpointId === env.Id)
        .filter((volume) => ownsProject(user, env.Id, volume.project))
        .map((volume) => ({
          Name: volume.Name,
          Driver: "local",
          Labels:
            volume.project === undefined ? null : { "com.docker.compose.project": volume.project },
        })),
      Warnings: null,
    });
  });
  route("DELETE", /^\/api\/endpoints\/(\d+)\/docker\/volumes\/([^/]+)$/, ({ match, user }) => {
    const env = envFor(user, match[1]);
    if (isReply(env)) return env;
    const name = decodeURIComponent(match[2] ?? "");
    const volume = state.volumes.find((item) => item.EndpointId === env.Id && item.Name === name);
    if (volume === undefined) return reply(404, { message: `get ${name}: no such volume` });
    // R9: once the stack's resource control is gone, a limited user cannot see its volumes.
    if (!ownsProject(user, env.Id, volume.project)) return denied();
    const inUse = state.stacks.some(
      (stack) =>
        stack.EndpointId === env.Id && stack.Name === volume.project && stack.containers !== "none",
    );
    if (inUse) return reply(409, { message: `remove ${name}: volume is in use` });
    state.volumes = state.volumes.filter((item) => item !== volume);
    return reply(204);
  });
  route("GET", /^\/api\/endpoints\/(\d+)\/registries$/, ({ match, user }) => {
    const env = envFor(user, match[1]);
    if (isReply(env)) return env;
    return reply(
      200,
      state.registries
        .filter((registry) => isAdmin(user) || registry.accesses[env.Id]?.includes(user.Id))
        .map(registryJson),
    );
  });
  route("PUT", /^\/api\/endpoints\/(\d+)\/registries\/(\d+)$/, ({ match, user, body }) => {
    if (!isAdmin(user)) return denied();
    const env = envFor(user, match[1]);
    if (isReply(env)) return env;
    const registry = state.registries.find((item) => item.Id === Number(match[2]));
    if (registry === undefined) return notFound("a registry with the specified identifier");
    const policies = (body.UserAccessPolicies ?? {}) as Record<string, unknown>;
    registry.accesses[env.Id] = Object.keys(policies).map(Number);
    return reply(204);
  });
  route("GET", /^\/api\/registries$/, ({ user }) =>
    isAdmin(user) ? reply(200, state.registries.map(registryJson)) : denied(),
  );
  route("POST", /^\/api\/registries$/, ({ user, body }) => {
    if (!isAdmin(user)) return denied();
    if (typeof body.Name !== "string" || typeof body.URL !== "string") {
      return reply(400, { message: "Invalid request payload" });
    }
    if (state.registries.some((item) => item.Name === body.Name)) {
      return reply(409, { message: "Another registry with the same name already exists" });
    }
    // Portainer compares the URL and, with authentication on, the user name (not the password).
    if (
      body.Authentication === true &&
      state.registries.some((item) => item.URL === body.URL && item.Username === body.Username)
    ) {
      return reply(409, {
        message: "Another registry with the same URL and credentials already exists",
        details: "A registry is already defined for this URL and credentials",
      });
    }
    const registry: FakeRegistry = {
      Id: nextId++,
      Name: body.Name,
      Type: Number(body.Type),
      URL: body.URL,
      Username: String(body.Username ?? ""),
      Password: String(body.Password ?? ""),
      accesses: {},
    };
    state.registries.push(registry);
    return reply(200, registryJson(registry));
  });
  route("PUT", /^\/api\/registries\/(\d+)$/, ({ match, user, body }) => {
    if (!isAdmin(user)) return denied();
    const registry = state.registries.find((item) => item.Id === Number(match[1]));
    if (registry === undefined) return notFound("a registry with the specified identifier");
    if (
      typeof body.Name !== "string" ||
      typeof body.URL !== "string" ||
      typeof body.Authentication !== "boolean"
    ) {
      return reply(400, { message: "Invalid request payload" });
    }
    if (state.registries.some((item) => item.Name === body.Name && item !== registry)) {
      return reply(409, { message: "Another registry with the same name already exists" });
    }
    registry.Name = body.Name;
    registry.URL = body.URL;
    if (typeof body.Username === "string") registry.Username = body.Username;
    // An empty password keeps the saved one.
    if (typeof body.Password === "string" && body.Password !== "") {
      registry.Password = body.Password;
    }
    // Assumption checked live in T1008: leaving RegistryAccesses out keeps the entry's grants
    // (`registryUpdateClearsGrants` plays the opposite).
    if (body.RegistryAccesses === undefined || body.RegistryAccesses === null) {
      if (state.registryUpdateClearsGrants === true) registry.accesses = {};
    } else {
      const accesses = body.RegistryAccesses as Record<
        string,
        { UserAccessPolicies?: Record<string, unknown> } | null
      >;
      registry.accesses = Object.fromEntries(
        Object.entries(accesses).map(([envId, access]) => [
          Number(envId),
          Object.keys(access?.UserAccessPolicies ?? {}).map(Number),
        ]),
      );
    }
    return reply(200, registryJson(registry));
  });
  route("DELETE", /^\/api\/registries\/(\d+)$/, ({ match, user }) => {
    if (!isAdmin(user)) return denied();
    const registry = state.registries.find((item) => item.Id === Number(match[1]));
    if (registry === undefined) return notFound("a registry with the specified identifier");
    state.registries = state.registries.filter((item) => item !== registry);
    return reply(204);
  });
  route("GET", /^\/api\/stacks$/, ({ user, query }) => {
    const filters = JSON.parse(query.get("filters") ?? "{}") as { EndpointID?: number };
    const visible = state.stacks.filter(
      (stack) =>
        mayUseStack(user, stack) &&
        (filters.EndpointID === undefined || stack.EndpointId === filters.EndpointID),
    );
    for (const stack of visible) progress(stack);
    return reply(200, visible.map(stackJson));
  });
  route("GET", /^\/api\/stacks\/(\d+)$/, ({ match, user }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    progress(stack);
    return reply(200, stackJson(stack));
  });
  route("GET", /^\/api\/stacks\/(\d+)\/file$/, ({ match, user }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    return reply(200, { StackFileContent: stack.file });
  });
  route("POST", /^\/api\/stacks\/create\/standalone\/repository$/, ({ query, user, body }) => {
    const env = envFor(user, query.get("endpointId") ?? undefined);
    if (isReply(env)) return env;
    const name = String(body.Name ?? "").toLowerCase();
    if (name === "") return reply(400, { message: "Invalid stack name" });
    if (body.RepositoryAuthentication === true && !body.RepositoryPassword) {
      return reply(400, { message: "Password must be specified when authentication is enabled" });
    }
    if (nameTaken(env.Id, name)) {
      return reply(409, { message: `A stack with the normalized name '${name}' already exists` });
    }
    const auto = body.AutoUpdate as FakeStack["AutoUpdate"];
    if (webhookTaken(auto?.Webhook)) return reply(409, { message: "Webhook ID already exists" });
    const url = String(body.RepositoryURL);
    const reference = String(body.RepositoryReferenceName);
    const branch = cloneBranch(
      url,
      reference,
      body.RepositoryAuthentication === true ? String(body.RepositoryPassword) : undefined,
    );
    if (isReply(branch)) return branch;
    const stack: FakeStack = {
      Id: nextId++,
      Name: name,
      Type: 2,
      EndpointId: env.Id,
      Env: (body.Env as FakeStack["Env"] | undefined) ?? [],
      Status: 2,
      DeploymentStatus: [],
      AutoUpdate: auto ?? null,
      GitConfig: {
        URL: url,
        ReferenceName: reference,
        ConfigFilePath: String(body.ComposeFile ?? "docker-compose.yml"),
        Authentication:
          body.RepositoryAuthentication === true
            ? {
                Username: String(body.RepositoryUsername ?? ""),
                Password: String(body.RepositoryPassword),
              }
            : null,
      },
      file: "",
      ownerId: user.Id,
      containers: "none",
      ports: [],
      deploys: 0,
    };
    state.stacks.push(stack);
    startDeploy(stack, branch.file, branch.commit);
    return reply(200, stackJson(stack));
  });
  route("POST", /^\/api\/stacks\/create\/standalone\/string$/, ({ query, user, body }) => {
    const env = envFor(user, query.get("endpointId") ?? undefined);
    if (isReply(env)) return env;
    const name = String(body.Name ?? "").toLowerCase();
    if (name === "") return reply(400, { message: "Invalid stack name" });
    if (typeof body.StackFileContent !== "string" || body.StackFileContent === "") {
      return reply(400, { message: "Invalid stack file content" });
    }
    if (nameTaken(env.Id, name)) {
      return reply(409, { message: `A stack with the normalized name '${name}' already exists` });
    }
    const stack: FakeStack = {
      Id: nextId++,
      Name: name,
      Type: 2,
      EndpointId: env.Id,
      Env: (body.Env as FakeStack["Env"] | undefined) ?? [],
      Status: 2,
      DeploymentStatus: [],
      AutoUpdate: null,
      GitConfig: null,
      file: "",
      ownerId: user.Id,
      containers: "none",
      ports: [],
      deploys: 0,
    };
    state.stacks.push(stack);
    startDeploy(stack, body.StackFileContent);
    return reply(200, stackJson(stack));
  });
  route("PUT", /^\/api\/stacks\/(\d+)$/, ({ match, user, body }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    if (stack.GitConfig !== null) return reply(400, { message: "Use the Git endpoints for a Git stack" });
    if (typeof body.StackFileContent !== "string" || body.StackFileContent === "") {
      return reply(400, { message: "Invalid stack file content" });
    }
    // R7: leaving out Env clears it.
    stack.Env = (body.Env as FakeStack["Env"] | undefined) ?? [];
    startDeploy(stack, body.StackFileContent);
    return reply(200, stackJson(stack));
  });
  route("POST", /^\/api\/stacks\/(\d+)\/git$/, ({ match, user, body }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    if (stack.GitConfig === null) return reply(400, { message: "Stack is not a Git stack" });
    const auto = (body.AutoUpdate as FakeStack["AutoUpdate"] | undefined) ?? null;
    if (webhookTaken(auto?.Webhook, stack.Id)) {
      return reply(409, { message: "Webhook ID already exists" });
    }
    stack.AutoUpdate = auto;
    stack.Env = (body.Env as FakeStack["Env"] | undefined) ?? [];
    stack.GitConfig = {
      URL: String(body.RepositoryURL ?? stack.GitConfig.URL),
      ReferenceName: String(body.RepositoryReferenceName ?? stack.GitConfig.ReferenceName),
      ConfigFilePath: String(body.ConfigFilePath ?? stack.GitConfig.ConfigFilePath),
      Authentication:
        body.RepositoryAuthentication === true
          ? {
              Username: String(body.RepositoryUsername ?? ""),
              Password: String(body.RepositoryPassword ?? ""),
            }
          : null,
    };
    return reply(200, stackJson(stack));
  });
  route("PUT", /^\/api\/stacks\/(\d+)\/git\/redeploy$/, ({ match, user, body }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    const git = stack.GitConfig;
    if (git === null) return reply(400, { message: "Stack is not a Git stack" });
    if (body.Env !== undefined && body.Env !== null) stack.Env = body.Env as FakeStack["Env"];
    const branch = cloneBranch(
      git.URL,
      String(body.RepositoryReferenceName ?? git.ReferenceName),
      git.Authentication?.Password,
    );
    if (isReply(branch)) return branch;
    startDeploy(stack, branch.file, branch.commit);
    return reply(200, stackJson(stack));
  });
  route("POST", /^\/api\/stacks\/(\d+)\/start$/, ({ match, user }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    if (stack.Status !== 2) return reply(400, { message: "Stack is already active" });
    if ((state.startPolls ?? 0) > 0) {
      // A start that finishes after Portainer answered (the answer still shows Status 2).
      stack.starting = state.startPolls;
      return reply(200, stackJson(stack));
    }
    // Assumption checked live in T1008: starting runs the stack's last good file again before
    // Portainer answers.
    stack.Status = 1;
    stack.containers = "running";
    return reply(200, stackJson(stack));
  });
  route("POST", /^\/api\/stacks\/(\d+)\/stop$/, ({ match, user }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    if (stack.Status === 2) return reply(400, { message: "Stack is already inactive" });
    // Assumption (checked live in T1008): stopping a Compose stack removes its containers.
    stack.Status = 2;
    stack.containers = "none";
    return reply(200, stackJson(stack));
  });
  route("DELETE", /^\/api\/stacks\/(\d+)$/, ({ match, user }) => {
    const stack = stackFor(user, match[1]);
    if (isReply(stack)) return stack;
    // R9: the named volumes stay.
    state.stacks = state.stacks.filter((item) => item !== stack);
    return reply(204);
  });

  const unauthenticated: Array<[string, RegExp, (match: RegExpMatchArray) => FakeReply]> = [
    ["GET", /^\/api\/system\/status$/, () => reply(200, { Version: state.version, InstanceID: "fake" })],
    [
      "POST",
      /^\/api\/stacks\/webhooks\/([^/]+)$/,
      (match) => {
        const stack = state.stacks.find((item) => item.AutoUpdate?.Webhook === match[1]);
        if (stack === undefined) return reply(404, { message: "Unable to find the stack" });
        // R5: webhooks on string stacks are ignored.
        if (stack.GitConfig === null) return reply(204);
        const branch = cloneBranch(
          stack.GitConfig.URL,
          stack.GitConfig.ReferenceName,
          stack.GitConfig.Authentication?.Password,
        );
        if (isReply(branch)) return branch;
        // R5 assumption (Portainer's RedeployWhenChanged): a webhook call for an unchanged branch
        // does not redeploy. The live test (T1008) checks it; if Portainer does redeploy, the
        // updater must compare the branch head first.
        if (branch.commit === stack.deployedCommit && stack.pending === undefined) return reply(204);
        startDeploy(stack, branch.file, branch.commit);
        return reply(204);
      },
    ],
  ];

  async function handle(init: PinnedRequestInit): Promise<PinnedResponse> {
    const url = new URL(init.path, "http://portainer.invalid");
    let body: unknown;
    if (init.body !== undefined) body = JSON.parse(init.body);
    const call: RecordedCall = {
      method: init.method,
      path: url.pathname,
      query: url.searchParams,
      headers: { ...init.headers },
      ...(body !== undefined && { body }),
    };
    calls.push(call);
    const forced = options.override?.(call);
    const result = forced ?? dispatch(call, body);
    if (result.bytes !== undefined) {
      return {
        status: result.status,
        body: Buffer.from(result.bytes).toString("utf8"),
        ...(init.raw === true && { bytes: result.bytes }),
      };
    }
    return {
      status: result.status,
      body: result.body === undefined ? "" : JSON.stringify(result.body),
    };
  }

  function dispatch(call: RecordedCall, body: unknown): FakeReply {
    for (const [method, pattern, handler] of unauthenticated) {
      const match = call.path.match(pattern);
      if (match !== null && method === call.method) return handler(match);
    }
    const user = state.users.find((item) => item.token === call.headers["X-API-Key"]);
    if (user === undefined) {
      return reply(401, { message: "Unauthorized", details: "A valid authorisation token is missing" });
    }
    for (const [method, pattern, handler] of routes) {
      const match = call.path.match(pattern);
      if (match !== null && method === call.method) {
        return handler({ match, query: call.query, body: (body ?? {}) as Body, user });
      }
    }
    return reply(404, { message: "no route" });
  }

  const request: PinnedRequest = (init) => handle(init);

  /** Simulates the updater (or the workflow through Access) calling the stack webhook. */
  const callWebhook = (uuid: string) =>
    handle({ method: "POST", path: `/api/stacks/webhooks/${uuid}`, headers: {}, timeoutMs: 1000 });

  /** Finishes every pending deploy (as time passing would). */
  const settle = () => {
    for (const stack of state.stacks) {
      while (stack.pending !== undefined || stack.starting !== undefined) progress(stack);
    }
  };

  return { request, state, calls, callWebhook, settle, tokens };
}

/** Records requested sleeps without waiting, and a clock that moves with them. */
export function fakeClock(start = 0) {
  let now = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}
