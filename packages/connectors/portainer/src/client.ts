import { OpsCrewError, parseAnswer, Redactor } from "@opscrew/core";
import { z } from "zod";
import {
  COMPOSE_ONEOFF_LABEL,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  VolumeNameSchema,
} from "./names";
import {
  type PinnedRequest,
  type PinnedRequestInit,
  PortainerCertificateError,
  type PortainerEndpoint,
  parsePortainerEndpoint,
  pinnedRequest,
} from "./pinned";
import { checkKey, fingerprint, WEBHOOK_FINGERPRINT_NAME } from "./values";

/** Default time one request to Portainer may take. */
export const PORTAINER_REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "opscrew-connector-portainer/0.1.0";
/**
 * Where in Portainer the access token OpsCrew uses is created, as the start of a sentence: callers
 * continue it with ", then set PORTAINER_API_KEY to it…" or ", set PORTAINER_API_KEY to it, then …".
 */
export const PORTAINER_TOKEN_STEPS =
  "In Portainer, open your user menu → My account → Access tokens and add a token (for an administrator, or for a user who may manage stacks on the environment)";
const TOKEN_HINT = `${PORTAINER_TOKEN_STEPS}, then set PORTAINER_API_KEY to it.`;
/** What a 403 means for registry entries, as an access the user can grant. */
const REGISTRY_ACCESS = "manage registries (administrators only)";

// --- What the client returns (secrets are dropped while parsing) --------------------------------

/** `GET /api/system/version`. */
export interface PortainerVersionInfo {
  version: string;
  /** The Compose version Portainer deploys stacks with. */
  composeVersion?: string;
  /** The Docker client version bundled with Portainer. */
  dockerVersion?: string;
}

/** The token's user (`GET /api/users/me`). */
export interface PortainerUser {
  id: number;
  username: string;
  /** Portainer role 1 is an administrator, 2 a regular ("limited") user. */
  role: "admin" | "user";
}

/** An environment the token's user may see (`GET /api/endpoints`). */
export interface PortainerEnvironment {
  id: number;
  name: string;
  /** Portainer's environment type (1 Docker, 2 agent on Docker, 3 ACI, 4 Edge, 5–7 Kubernetes). */
  type: number;
  /** 1 up, 2 down. */
  status?: number;
  /** From the latest snapshot, when Portainer has one. */
  swarm?: boolean;
}

/** The parts of Docker's `/info` OpsCrew reads. */
export interface DockerInfo {
  architecture?: string;
  serverVersion?: string;
  swarmActive: boolean;
}

/** A container, reduced to its Compose project and service and the host ports it publishes. */
export interface ContainerSummary {
  project?: string;
  /** Its Compose service; absent for a one-off container (`docker compose run`). */
  service?: string;
  running: boolean;
  publishedPorts: number[];
}

/** A Docker volume, reduced to its name and Compose project. */
export interface VolumeSummary {
  name: string;
  project?: string;
}

/** A registry entry (its password is never returned by Portainer, nor kept). */
export interface RegistrySummary {
  id: number;
  name: string;
  url: string;
  type?: number;
}

/** A registry entry as an administrator sees it, with the environments it is granted on. */
export interface RegistryEntry extends RegistrySummary {
  environments: number[];
}

/** A stack, without its environment values or webhook id (both secrets). */
export interface StackDetails {
  id: number;
  name: string;
  /** 1 Swarm, 2 Compose, 3 Kubernetes. */
  type?: number;
  environmentId?: number;
  /** 1 active, 2 inactive, 3 deploying, 4 error. */
  status?: number;
  /** Portainer's deploy history; `time` is Portainer's Unix time of the entry. */
  deploymentStatus: { status: number; message?: string; time?: number }[];
  /** The names of the stack's `Env` entries; values are never kept. */
  envKeys: string[];
  /** With a value key: `valueFingerprints(key, Env)` of the values Portainer holds. */
  envFingerprints?: Record<string, string>;
  autoUpdate?: {
    webhook: boolean;
    forcePullImage: boolean;
    forceUpdate: boolean;
    interval?: string;
    /** With a value key: the webhook id's fingerprint (`valueFingerprints(key, { webhook })`). */
    webhookFingerprint?: string;
  };
  /** Git stacks only; the URL without any login, and only whether authentication is on. */
  gitConfig?: {
    url?: string;
    referenceName?: string;
    configFilePath?: string;
    authenticated: boolean;
  };
}

/** One `Env` entry sent to Portainer (values are secrets). */
export interface EnvPair {
  name: string;
  value: string;
}

/** Input for {@link PortainerClient.createGitStack} and the Git updates. */
export interface GitStackInput {
  name: string;
  repositoryUrl: string;
  referenceName: string;
  composeFile: string;
  /** For private repositories: a read-only token (secret). */
  authentication?: { username: string; password: string };
  /** The stack webhook's UUID (secret). */
  webhookId: string;
  env: readonly EnvPair[];
}

/** Input for {@link PortainerClient.createStringStack} and {@link PortainerClient.updateStringStack}. */
export interface StringStackInput {
  name: string;
  compose: string;
  env: readonly EnvPair[];
}

/** Typed calls to Portainer's API; zod-validated, ids are parsed numbers, the token is redacted. */
export interface PortainerClient {
  /**
   * True when requests go over HTTPS to the confirmed certificate fingerprint; false for plain
   * HTTP to this computer.
   */
  readonly pinned: boolean;
  /** `GET /api/system/status` (no token). */
  systemStatus(): Promise<{ version: string }>;
  /** `GET /api/system/version`. */
  systemVersion(): Promise<PortainerVersionInfo>;
  /** `GET /api/users/me`. */
  currentUser(): Promise<PortainerUser>;
  /** `GET /api/endpoints`. */
  listEnvironments(): Promise<PortainerEnvironment[]>;
  /** `GET /api/endpoints/{id}/docker/info`. */
  dockerInfo(environmentId: number): Promise<DockerInfo>;
  /** `GET /api/endpoints/{id}/docker/containers/json?all=1` (an administrator sees all). */
  listContainers(environmentId: number): Promise<ContainerSummary[]>;
  /** `GET /api/endpoints/{id}/docker/volumes` (Compose volumes only). */
  listVolumes(environmentId: number): Promise<VolumeSummary[]>;
  /** `DELETE /api/endpoints/{id}/docker/volumes/{name}`. */
  removeVolume(environmentId: number, name: string): Promise<"removed" | "absent">;
  /** `GET /api/endpoints/{id}/registries`: the entries the token's user may use there. */
  listEnvironmentRegistries(environmentId: number): Promise<RegistrySummary[]>;
  /** `GET /api/registries` (administrators only). */
  listRegistries(): Promise<RegistryEntry[]>;
  /** `POST /api/registries`: a Custom (type 3) entry with a login. */
  createRegistry(input: {
    name: string;
    url: string;
    username: string;
    password: string;
  }): Promise<{ id: number }>;
  /**
   * `PUT /api/registries/{id}`: sends the entry's name, URL and login (a replaced token).
   * `RegistryAccesses` is left out; apply grants the entry again afterwards all the same.
   */
  updateRegistry(
    registryId: number,
    input: { name: string; url: string; username: string; password: string },
  ): Promise<void>;
  /** `PUT /api/endpoints/{id}/registries/{registryId}`: lets `userId` use the entry there. */
  grantRegistry(environmentId: number, registryId: number, userId: number): Promise<void>;
  /** `DELETE /api/registries/{id}`. */
  removeRegistry(registryId: number): Promise<"removed" | "absent">;
  /** `GET /api/stacks` on one environment. */
  listStacks(environmentId: number): Promise<StackDetails[]>;
  /** `GET /api/stacks/{id}`; `undefined` when Portainer has no such stack. */
  getStack(stackId: number): Promise<StackDetails | undefined>;
  /** `GET /api/stacks/{id}/file`. */
  getStackFile(stackId: number): Promise<string>;
  /** `POST /api/stacks/create/standalone/repository?endpointId=N` (deploys asynchronously). */
  createGitStack(environmentId: number, input: GitStackInput): Promise<StackDetails>;
  /** `POST /api/stacks/{id}/git?endpointId=N`: saves the Git settings (no redeploy). */
  updateGitStack(
    stackId: number,
    environmentId: number,
    input: Omit<GitStackInput, "name">,
  ): Promise<StackDetails>;
  /** `PUT /api/stacks/{id}/git/redeploy?endpointId=N` (asynchronous). */
  redeployGitStack(
    stackId: number,
    environmentId: number,
    input: Pick<GitStackInput, "referenceName" | "authentication" | "env">,
  ): Promise<StackDetails>;
  /** `POST /api/stacks/create/standalone/string?endpointId=N` (deploys asynchronously). */
  createStringStack(environmentId: number, input: StringStackInput): Promise<StackDetails>;
  /** `PUT /api/stacks/{id}?endpointId=N` with the full `Env` (asynchronous). */
  updateStringStack(
    stackId: number,
    environmentId: number,
    input: Omit<StringStackInput, "name">,
  ): Promise<StackDetails>;
  /** `POST /api/stacks/{id}/start?endpointId=N`: starts a stopped stack again. */
  startStack(stackId: number, environmentId: number): Promise<StackDetails>;
  /** `POST /api/stacks/{id}/stop?endpointId=N`. */
  stopStack(stackId: number, environmentId: number): Promise<void>;
  /** `DELETE /api/stacks/{id}?endpointId=N`. */
  removeStack(stackId: number, environmentId: number): Promise<"removed" | "absent">;
  /** Registers a secret with the client's redactor (errors are redacted with it). */
  registerSecret(value: string, label: string): void;
  /** Redacts the token and every registered secret from `text`. */
  redact(text: string): string;
}

/** A refusal or failure Portainer answered with; `status` is the HTTP status. */
export class PortainerApiError extends OpsCrewError {
  readonly status: number;

  constructor(
    code: "CREDENTIALS_INVALID" | "PROVIDER_ERROR",
    status: number,
    message: string,
    hint: string,
  ) {
    super(code, message, { hint });
    this.name = "PortainerApiError";
    this.status = status;
  }
}

/** Options for {@link portainerClient}. */
export interface PortainerClientDeps {
  /** The request function; defaults to {@link pinnedRequest} for the endpoint. */
  request?: PinnedRequest;
  /** Shared redactor; a private one is used when omitted. The token is always registered. */
  redactor?: Redactor;
  /** Per-request timeout (default {@link PORTAINER_REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * The local value key (at least 16 bytes). While parsing a stack, its `Env` values and webhook
   * id become keyed fingerprints and are dropped; without it only the keys are kept.
   */
  valueKey?: Uint8Array;
}

/**
 * The Portainer client for one endpoint and access token (`PORTAINER_API_KEY`). The endpoint is
 * validated first (HTTPS with a pinned certificate, or HTTP to this computer); the token is sent
 * only as `X-API-Key` and never appears in errors.
 */
export function portainerClient(
  endpoint: PortainerEndpoint,
  token: string,
  deps: PortainerClientDeps = {},
): PortainerClient {
  const target = parsePortainerEndpoint(endpoint);
  if (typeof token !== "string" || !/^[\x21-\x7e]{8,512}$/.test(token)) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      "PORTAINER_API_KEY is not set to an access token.",
      {
        hint: TOKEN_HINT,
      },
    );
  }
  const redactor = deps.redactor ?? new Redactor();
  redactor.addLiteral(token, "PORTAINER_API_KEY");
  const request = deps.request ?? pinnedRequest(endpoint);
  const timeoutMs = deps.timeoutMs ?? PORTAINER_REQUEST_TIMEOUT_MS;
  if (deps.valueKey !== undefined) checkKey(deps.valueKey);
  const stackSchema = stackSchemaFor(deps.valueKey);

  async function call<S extends z.ZodType>(
    spec: Omit<PinnedRequestInit, "headers" | "timeoutMs" | "body"> & {
      action: string;
      /** What a 403 means here, as an access the user can grant. */
      access?: string;
      body?: unknown;
      schema?: S;
      auth?: false;
      notFound?: "absent";
    },
  ): Promise<z.output<S> | "absent" | undefined> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (spec.auth !== false) headers["X-API-Key"] = token;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await request({
      method: spec.method,
      path: spec.path,
      headers,
      timeoutMs,
      ...(spec.body !== undefined && { body: JSON.stringify(spec.body) }),
    }).catch((error: unknown) => {
      throw redactError(error, redactor);
    });
    if (response.status === 404 && spec.notFound === "absent") return "absent";
    if (response.status < 200 || response.status >= 300) {
      throw apiError(response.status, response.body, spec.action, spec.access, redactor);
    }
    if (spec.schema === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Portainer returned invalid JSON when asked to ${spec.action}.`,
        {
          hint: "Check that the address is Portainer's (not a proxy's login page), then try again.",
        },
      );
    }
    return parseAnswer(
      spec.schema,
      json,
      "Portainer",
      spec.action,
      "OpsCrew supports Portainer 2.45 or newer; if yours is, please report this to OpsCrew.",
    );
  }

  const get = async <S extends z.ZodType>(
    path: string,
    schema: S,
    action: string,
    access?: string,
  ): Promise<z.output<S>> =>
    (await call({ method: "GET", path, schema, action, ...(access && { access }) })) as z.output<S>;

  const stackBody = async (
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    action: string,
  ): Promise<StackDetails> =>
    (await call({
      method,
      path,
      body,
      schema: stackSchema,
      action,
      access: STACK_ACCESS,
    })) as StackDetails;

  return {
    pinned: target.pin !== undefined,
    async systemStatus() {
      // Portainer answers this one without authentication: the token is not sent.
      const status = (await call({
        method: "GET",
        path: "/api/system/status",
        schema: statusSchema,
        action: "report its version",
        auth: false,
      })) as z.output<typeof statusSchema>;
      return { version: status.Version };
    },
    async systemVersion() {
      const body = await get(
        "/api/system/version",
        versionSchema,
        "report its version",
        "read Portainer's version",
      );
      return {
        version: body.ServerVersion,
        ...(body.Dependencies?.ComposeVersion && {
          composeVersion: body.Dependencies.ComposeVersion,
        }),
        ...(body.Dependencies?.DockerVersion && { dockerVersion: body.Dependencies.DockerVersion }),
      };
    },
    async currentUser() {
      const user = await get("/api/users/me", userSchema, "tell which user the token belongs to");
      return {
        id: user.Id,
        username: user.Username,
        role: user.Role === 1 ? "admin" : "user",
      } satisfies PortainerUser;
    },
    async listEnvironments() {
      const list = await get("/api/endpoints", z.array(endpointSchema), "list its environments");
      return list.map((endpoint) => ({
        id: endpoint.Id,
        name: endpoint.Name,
        type: endpoint.Type,
        ...(endpoint.Status !== undefined && { status: endpoint.Status }),
        ...(endpoint.Snapshots?.[0]?.Swarm !== undefined && {
          swarm: endpoint.Snapshots[0].Swarm,
        }),
      }));
    },
    async dockerInfo(environmentId) {
      const info = await get(
        `/api/endpoints/${id(environmentId)}/docker/info`,
        dockerInfoSchema,
        "read the environment's Docker information",
        "use the environment",
      );
      return {
        ...(info.Architecture && { architecture: info.Architecture }),
        ...(info.ServerVersion && { serverVersion: info.ServerVersion }),
        swarmActive: info.Swarm?.LocalNodeState === "active",
      };
    },
    async listContainers(environmentId) {
      const list = await get(
        `/api/endpoints/${id(environmentId)}/docker/containers/json?all=1`,
        z.array(containerSchema),
        "list the environment's containers",
        "list the environment's containers",
      );
      return list.map((container) => {
        const project = container.Labels?.[COMPOSE_PROJECT_LABEL];
        const oneOff = container.Labels?.[COMPOSE_ONEOFF_LABEL] === "True";
        const service = oneOff ? undefined : container.Labels?.[COMPOSE_SERVICE_LABEL];
        const ports = new Set<number>();
        for (const port of container.Ports ?? []) {
          if (port.PublicPort !== undefined && port.PublicPort > 0) ports.add(port.PublicPort);
        }
        return {
          ...(project !== undefined && { project }),
          ...(service !== undefined && { service }),
          running: container.State === "running",
          publishedPorts: [...ports].sort((a, b) => a - b),
        };
      });
    },
    async listVolumes(environmentId) {
      // Every volume (not only labelled ones): a volume named like OpsCrew's without the app's
      // project label must be seen, so a teardown never deletes it.
      const body = await get(
        `/api/endpoints/${id(environmentId)}/docker/volumes`,
        volumesSchema,
        "list the environment's volumes",
        "list the environment's volumes",
      );
      return (body.Volumes ?? []).map((volume) => {
        const project = volume.Labels?.[COMPOSE_PROJECT_LABEL];
        return { name: volume.Name, ...(project !== undefined && { project }) };
      });
    },
    async removeVolume(environmentId, name) {
      const valid = VolumeNameSchema.safeParse(name);
      if (!valid.success) {
        throw new OpsCrewError("INVALID_INPUT", "That is not a Docker volume name.");
      }
      const result = await call({
        method: "DELETE",
        path: `/api/endpoints/${id(environmentId)}/docker/volumes/${encodeURIComponent(valid.data)}`,
        action: `delete the volume ${valid.data}`,
        access: "delete the app's volumes",
        notFound: "absent",
      });
      return result === "absent" ? "absent" : "removed";
    },
    async listEnvironmentRegistries(environmentId) {
      const what = "list the registries usable on the environment";
      const list = await get(
        `/api/endpoints/${id(environmentId)}/registries`,
        z.array(registrySchema),
        what,
        what,
      );
      return list.map(toRegistrySummary);
    },
    async listRegistries() {
      const list = await get(
        "/api/registries",
        z.array(registrySchema),
        "list its registries",
        REGISTRY_ACCESS,
      );
      return list.map((registry) => ({
        ...toRegistrySummary(registry),
        environments: Object.keys(registry.RegistryAccesses ?? {})
          .map(Number)
          .filter((key) => Number.isSafeInteger(key) && key > 0)
          .sort((a, b) => a - b),
      }));
    },
    async createRegistry(input) {
      const body = (await call({
        method: "POST",
        path: "/api/registries",
        body: {
          Name: input.name,
          Type: 3,
          URL: input.url,
          BaseURL: "",
          Authentication: true,
          Username: input.username,
          Password: input.password,
        },
        schema: z.object({ Id: idSchema }),
        action: `add the registry entry ${input.name}`,
        access: REGISTRY_ACCESS,
      })) as { Id: number };
      return { id: body.Id };
    },
    async updateRegistry(registryId, input) {
      await call({
        method: "PUT",
        path: `/api/registries/${id(registryId)}`,
        body: {
          Name: input.name,
          URL: input.url,
          Authentication: true,
          Username: input.username,
          Password: input.password,
        },
        action: `replace the token of the registry entry ${input.name}`,
        access: REGISTRY_ACCESS,
      });
    },
    async grantRegistry(environmentId, registryId, userId) {
      await call({
        method: "PUT",
        path: `/api/endpoints/${id(environmentId)}/registries/${id(registryId)}`,
        body: {
          UserAccessPolicies: { [String(id(userId))]: { RoleId: 0 } },
          TeamAccessPolicies: {},
          Namespaces: [],
        },
        action: "let the user use the registry entry on the environment",
        access: REGISTRY_ACCESS,
      });
    },
    async removeRegistry(registryId) {
      const result = await call({
        method: "DELETE",
        path: `/api/registries/${id(registryId)}`,
        action: "remove the registry entry",
        access: REGISTRY_ACCESS,
        notFound: "absent",
      });
      return result === "absent" ? "absent" : "removed";
    },
    async listStacks(environmentId) {
      const filters = encodeURIComponent(JSON.stringify({ EndpointID: id(environmentId) }));
      const list = await get(
        `/api/stacks?filters=${filters}`,
        z.array(z.unknown()),
        "list its stacks",
        STACK_ACCESS,
      );
      const out: StackDetails[] = [];
      for (const item of list) {
        // Only the shape of stacks OpsCrew may touch matters; others are skipped, never failed on.
        const parsed = stackSchema.safeParse(item);
        if (parsed.success && (parsed.data.environmentId ?? environmentId) === environmentId) {
          out.push(parsed.data);
        }
      }
      return out;
    },
    async getStack(stackId) {
      const result = await call({
        method: "GET",
        path: `/api/stacks/${id(stackId)}`,
        schema: stackSchema,
        action: "show the stack",
        access: STACK_ACCESS,
        notFound: "absent",
      });
      return result === "absent" ? undefined : (result as StackDetails);
    },
    async getStackFile(stackId) {
      const body = await get(
        `/api/stacks/${id(stackId)}/file`,
        z.object({ StackFileContent: z.string() }),
        "show the stack's file",
        STACK_ACCESS,
      );
      return body.StackFileContent;
    },
    createGitStack(environmentId, input) {
      return stackBody(
        "POST",
        `/api/stacks/create/standalone/repository?endpointId=${id(environmentId)}`,
        {
          Name: input.name,
          RepositoryURL: input.repositoryUrl,
          RepositoryReferenceName: input.referenceName,
          ComposeFile: input.composeFile,
          AdditionalFiles: [],
          ...gitAuthentication(input.authentication),
          AutoUpdate: { Webhook: input.webhookId, ForcePullImage: false },
          Env: input.env.map(pair),
          TLSSkipVerify: false,
          FromAppTemplate: false,
        },
        `create the stack ${input.name}`,
      );
    },
    updateGitStack(stackId, environmentId, input) {
      return stackBody(
        "POST",
        `/api/stacks/${id(stackId)}/git?endpointId=${id(environmentId)}`,
        {
          AutoUpdate: { Webhook: input.webhookId, ForcePullImage: false },
          Env: input.env.map(pair),
          Prune: false,
          ConfigFilePath: input.composeFile,
          AdditionalFiles: [],
          RepositoryURL: input.repositoryUrl,
          RepositoryReferenceName: input.referenceName,
          ...gitAuthentication(input.authentication),
          TLSSkipVerify: false,
        },
        "save the stack's Git settings",
      );
    },
    redeployGitStack(stackId, environmentId, input) {
      return stackBody(
        "PUT",
        `/api/stacks/${id(stackId)}/git/redeploy?endpointId=${id(environmentId)}`,
        {
          RepositoryReferenceName: input.referenceName,
          ...gitAuthentication(input.authentication),
          Env: input.env.map(pair),
          Prune: false,
          PullImage: false,
        },
        "redeploy the stack from its branch",
      );
    },
    createStringStack(environmentId, input) {
      return stackBody(
        "POST",
        `/api/stacks/create/standalone/string?endpointId=${id(environmentId)}`,
        {
          Name: input.name,
          StackFileContent: input.compose,
          Env: input.env.map(pair),
          FromAppTemplate: false,
        },
        `create the stack ${input.name}`,
      );
    },
    updateStringStack(stackId, environmentId, input) {
      return stackBody(
        "PUT",
        `/api/stacks/${id(stackId)}?endpointId=${id(environmentId)}`,
        {
          StackFileContent: input.compose,
          Env: input.env.map(pair),
          Prune: false,
          PullImage: false,
        },
        "update the stack",
      );
    },
    startStack(stackId, environmentId) {
      return stackBody(
        "POST",
        `/api/stacks/${id(stackId)}/start?endpointId=${id(environmentId)}`,
        undefined,
        "start the stack",
      );
    },
    async stopStack(stackId, environmentId) {
      await call({
        method: "POST",
        path: `/api/stacks/${id(stackId)}/stop?endpointId=${id(environmentId)}`,
        action: "stop the stack",
        access: STACK_ACCESS,
      });
    },
    async removeStack(stackId, environmentId) {
      const result = await call({
        method: "DELETE",
        path: `/api/stacks/${id(stackId)}?endpointId=${id(environmentId)}`,
        action: "remove the stack",
        access: STACK_ACCESS,
        notFound: "absent",
      });
      return result === "absent" ? "absent" : "removed";
    },
    registerSecret(value, label) {
      redactor.addLiteral(value, label);
    },
    redact: (text) => redactor.redact(text),
  };
}

const STACK_ACCESS = "manage stacks on the environment";

/** Path segment for an id: a positive integer, never text from elsewhere. */
function id(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OpsCrewError("INTERNAL", "Portainer ids are positive whole numbers.");
  }
  return value;
}

function pair(entry: EnvPair): { name: string; value: string } {
  return { name: entry.name, value: entry.value };
}

function gitAuthentication(auth: GitStackInput["authentication"]) {
  return auth === undefined
    ? { RepositoryAuthentication: false }
    : {
        RepositoryAuthentication: true,
        RepositoryUsername: auth.username,
        RepositoryPassword: auth.password,
      };
}

/**
 * A failed request's error with the token and registered secrets masked: a new error when
 * masking changes its text, else the error itself. A changed certificate is passed on as it is
 * (its text is fixed and its two fingerprints), so callers can still tell it apart.
 */
function redactError(error: unknown, redactor: Redactor): unknown {
  if (!(error instanceof OpsCrewError) || error instanceof PortainerCertificateError) return error;
  const message = redactor.redact(error.message);
  const hint = error.hint === undefined ? undefined : redactor.redact(error.hint);
  if (message === error.message && hint === error.hint) return error;
  return new OpsCrewError(error.code, message, hint === undefined ? undefined : { hint });
}

function apiError(
  status: number,
  body: string,
  action: string,
  access: string | undefined,
  redactor: Redactor,
): PortainerApiError {
  let detail = "";
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      detail = [parsed.data.message, parsed.data.details]
        .filter((part): part is string => typeof part === "string" && part.trim() !== "")
        .join(": ");
    }
  } catch {
    // Not JSON: the status alone is reported.
  }
  // Portainer's messages may echo what it was sent (a Git URL, a compose error): redact them.
  const safe = redactor.redact(detail.replace(/\s+/g, " ").trim().slice(0, 400));
  const suffix = safe === "" ? "" : `: ${safe}`;
  if (status === 401) {
    return new PortainerApiError(
      "CREDENTIALS_INVALID",
      status,
      `Portainer rejected the access token (PORTAINER_API_KEY) when asked to ${action}${suffix}.`,
      TOKEN_HINT,
    );
  }
  if (status === 403) {
    return new PortainerApiError(
      "PROVIDER_ERROR",
      status,
      `Portainer refused to ${action}: the token's user may not ${access ?? "do this"} (HTTP 403)${suffix}.`,
      access?.includes("administrators")
        ? "Use an administrator's access token, or follow the steps OpsCrew shows for a limited token."
        : "In Portainer, give the token's user access to the environment (Environments → the environment → Manage access) or use an administrator's token, then try again.",
    );
  }
  if (status === 409) {
    return new PortainerApiError(
      "PROVIDER_ERROR",
      status,
      `Portainer refused to ${action} because it conflicts with something that exists${suffix}.`,
      "Look in Portainer for the stack or entry with that name; OpsCrew never changes what it did not create. Choose another app name or remove the other one yourself.",
    );
  }
  return new PortainerApiError(
    "PROVIDER_ERROR",
    status,
    `Portainer could not ${action} (HTTP ${status})${suffix}.`,
    status >= 500
      ? "Check Portainer's logs and that the environment is up, then try again."
      : "Check the request in Portainer and try again; if it keeps failing, please report it to OpsCrew.",
  );
}

// --- Response schemas: unknown keys are dropped, secrets are dropped in the transforms ----------

const idSchema = z.int().positive();
const errorBodySchema = z.object({
  message: z.string().optional(),
  details: z.string().optional(),
});
const statusSchema = z.object({ Version: z.string().min(1) });
const versionSchema = z.object({
  ServerVersion: z.string().min(1),
  Dependencies: z
    .object({ ComposeVersion: z.string().optional(), DockerVersion: z.string().optional() })
    .nullable()
    .optional(),
});
const userSchema = z.object({ Id: idSchema, Username: z.string(), Role: z.int() });
const endpointSchema = z.object({
  Id: idSchema,
  Name: z.string(),
  Type: z.int(),
  Status: z.int().optional(),
  Snapshots: z
    .array(z.object({ Swarm: z.boolean().optional() }))
    .nullable()
    .optional(),
});
const dockerInfoSchema = z.object({
  Architecture: z.string().optional(),
  ServerVersion: z.string().optional(),
  Swarm: z.object({ LocalNodeState: z.string().optional() }).nullable().optional(),
});
const labelsSchema = z.record(z.string(), z.string()).nullable().optional();
const containerSchema = z.object({
  Labels: labelsSchema,
  State: z.string().optional(),
  Ports: z
    .array(z.object({ PublicPort: z.int().optional() }))
    .nullable()
    .optional(),
});
const volumesSchema = z.object({
  Volumes: z
    .array(z.object({ Name: z.string(), Labels: labelsSchema }))
    .nullable()
    .optional(),
});
const registrySchema = z.object({
  Id: idSchema,
  Name: z.string(),
  URL: z.string(),
  Type: z.int().optional(),
  RegistryAccesses: z.record(z.string(), z.unknown()).nullable().optional(),
});

function toRegistrySummary(registry: z.output<typeof registrySchema>): RegistrySummary {
  return {
    id: registry.Id,
    name: registry.Name,
    url: registry.URL,
    ...(registry.Type !== undefined && { type: registry.Type }),
  };
}

/** A Git URL without a login, query or fragment (a user may have put a token in it). */
function safeGitUrl(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(not a URL)";
  }
}

/** A stack as Portainer returns it, values and webhook id included (they never leave the parse). */
const rawStackSchema = z.object({
  Id: idSchema,
  Name: z.string(),
  Type: z.int().optional(),
  EndpointId: z.int().nonnegative().optional(),
  Status: z.int().optional(),
  Env: z
    .array(z.object({ name: z.string(), value: z.string().optional() }))
    .nullable()
    .optional(),
  AutoUpdate: z
    .object({
      Webhook: z.string().optional(),
      Interval: z.string().optional(),
      ForceUpdate: z.boolean().optional(),
      ForcePullImage: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  GitConfig: z
    .object({
      URL: z.string().optional(),
      ReferenceName: z.string().optional(),
      ConfigFilePath: z.string().optional(),
      Authentication: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  DeploymentStatus: z
    .array(
      z.object({
        Status: z.int(),
        Message: z.string().optional(),
        Time: z.number().optional(),
      }),
    )
    .nullable()
    .optional(),
});

/**
 * A stack as OpsCrew keeps it. Portainer returns `Env` values and the webhook id in plain text
 * (research R7): with a value key they become keyed fingerprints here, and are dropped either way.
 */
function stackSchemaFor(valueKey: Uint8Array | undefined) {
  return rawStackSchema.transform((stack): StackDetails => toStackDetails(stack, valueKey));
}

function toStackDetails(
  stack: z.output<typeof rawStackSchema>,
  valueKey: Uint8Array | undefined,
): StackDetails {
  const git = stack.GitConfig;
  const auto = stack.AutoUpdate;
  const url = safeGitUrl(git?.URL);
  const env = stack.Env ?? [];
  let envFingerprints: Record<string, string> | undefined;
  if (valueKey !== undefined) {
    envFingerprints = {};
    for (const entry of env) {
      if (typeof entry.value === "string") {
        envFingerprints[entry.name] = fingerprint(valueKey, entry.name, entry.value);
      }
    }
  }
  const webhook =
    typeof auto?.Webhook === "string" && auto.Webhook !== "" ? auto.Webhook : undefined;
  return {
    id: stack.Id,
    name: stack.Name,
    ...(stack.Type !== undefined && { type: stack.Type }),
    ...(stack.EndpointId !== undefined &&
      stack.EndpointId > 0 && { environmentId: stack.EndpointId }),
    ...(stack.Status !== undefined && { status: stack.Status }),
    deploymentStatus: (stack.DeploymentStatus ?? []).map((entry) => ({
      status: entry.Status,
      ...(entry.Message !== undefined && entry.Message !== "" && { message: entry.Message }),
      ...(typeof entry.Time === "number" && Number.isFinite(entry.Time) && { time: entry.Time }),
    })),
    envKeys: [...new Set(env.map((entry) => entry.name))].sort(),
    ...(envFingerprints !== undefined && { envFingerprints }),
    ...(auto !== null &&
      auto !== undefined && {
        autoUpdate: {
          webhook: webhook !== undefined,
          forcePullImage: auto.ForcePullImage === true,
          forceUpdate: auto.ForceUpdate === true,
          ...(auto.Interval !== undefined && auto.Interval !== "" && { interval: auto.Interval }),
          ...(valueKey !== undefined &&
            webhook !== undefined && {
              webhookFingerprint: fingerprint(valueKey, WEBHOOK_FINGERPRINT_NAME, webhook),
            }),
        },
      }),
    ...(git !== null &&
      git !== undefined && {
        gitConfig: {
          ...(url !== undefined && { url }),
          ...(git.ReferenceName !== undefined && { referenceName: git.ReferenceName }),
          ...(git.ConfigFilePath !== undefined && { configFilePath: git.ConfigFilePath }),
          authenticated: git.Authentication !== null && git.Authentication !== undefined,
        },
      }),
  };
}
