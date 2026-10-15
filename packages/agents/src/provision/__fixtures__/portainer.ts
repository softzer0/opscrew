import { createHash } from "node:crypto";
import type { PinnedRequest, PinnedRequestInit } from "@opscrew/connector-portainer";
import { type DeployPlan, DeployPlanSchema, type PortainerWeb } from "@opscrew/plan-schema";
import { testPlan } from "./fakes";

export interface PortainerPlanOptions {
  web?: PortainerWeb;
  redeploy?: "updater" | "cloudflare";
  /** The app's domain on Cloudflare (default `shop.example.com`); `null` for none. */
  domain?: string | null;
  postgres?: boolean;
  deployed?: boolean;
  www?: boolean;
  environmentId?: number;
  arch?: "amd64" | "arm64";
}

/** A valid `opscrew/plan.yaml` for the user's Portainer (the same app as {@link testPlan}). */
export function portainerPlan(options: PortainerPlanOptions = {}): DeployPlan {
  const web = options.web ?? { mode: "tunnel" };
  const domain = options.domain === undefined ? "shop.example.com" : options.domain;
  const base = testPlan({
    ...(domain !== null ? { domain } : {}),
    postgres: options.postgres ?? true,
    deployed: options.deployed ?? false,
    www: options.www ?? false,
  });
  return DeployPlanSchema.parse({
    ...base,
    target: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: options.environmentId ?? 3,
      arch: options.arch ?? "amd64",
      redeploy: options.redeploy ?? "updater",
      web,
    },
    dns:
      domain === null
        ? { provider: "none", proxied: false }
        : { ...base.dns, proxied: web.mode === "tunnel" },
    cost: {
      monthly: { amount: 0, currency: "EUR" },
      breakdown: [
        { item: "Your Portainer (you already run it)", monthly: { amount: 0, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "live",
      asOf: "2026-10-15T00:00:00.000Z",
    },
  });
}

/** A stack as Portainer stores it (values in plain text, as research R7 found). */
export interface FakeStack {
  Id: number;
  Name: string;
  Type: number;
  EndpointId: number;
  Status: number;
  Env: { name: string; value: string }[];
  AutoUpdate?: { Webhook: string; ForcePullImage: boolean; ForceUpdate: boolean };
  GitConfig?: {
    URL: string;
    ReferenceName: string;
    ConfigFilePath: string;
    Authentication?: { Username: string };
  };
  DeploymentStatus: { Status: number; Message?: string; Time: number }[];
  /** The stack file (string stacks); Git stacks hold whatever the branch has. */
  file: string;
  /** Test bookkeeping: who created it (`opscrew` through the API, or `user`). */
  owner: "opscrew" | "user";
}

export interface FakeRegistry {
  Id: number;
  Name: string;
  URL: string;
  Type: number;
  Username?: string;
  /** Environment ids it is granted on, with the user ids allowed there. */
  RegistryAccesses: Record<string, { UserAccessPolicies: Record<string, { RoleId: number }> }>;
}

export interface FakePortainerOptions {
  token: string;
  /** The token's user is an administrator (default) or a limited user. */
  admin?: boolean;
  environmentId?: number;
  architecture?: string;
  version?: string;
  composeVersion?: string;
  stacks?: Omit<FakeStack, "owner">[];
  registries?: FakeRegistry[];
  /** Containers on the environment (administrators see them): project and published ports. */
  containers?: { project?: string; ports?: number[]; running?: boolean }[];
  /** Requests (`METHOD path` prefixes) that fail with HTTP 500 and this message. */
  failures?: Record<string, string>;
}

/** Everything the fake was sent, for assertions (secrets included: tests only). */
export interface FakePortainer {
  request: PinnedRequest;
  readonly stacks: FakeStack[];
  readonly registries: FakeRegistry[];
  readonly volumes: { Name: string; Labels: Record<string, string> }[];
  /** `METHOD path` of every request, in order. */
  readonly calls: string[];
  /** Every request body as sent (they carry secrets: never print them). */
  readonly bodies: { call: string; body: unknown }[];
  /** Requests that changed something. */
  mutations(): string[];
}

/** A Portainer CE 2.45 with one Docker environment, answering like the real API (research R1–R7). */
export function fakePortainer(options: FakePortainerOptions): FakePortainer {
  const envId = options.environmentId ?? 3;
  const admin = options.admin ?? true;
  const userId = admin ? 1 : 7;
  const stacks: FakeStack[] = (options.stacks ?? []).map((stack) => ({ ...stack, owner: "user" }));
  const registries: FakeRegistry[] = [...(options.registries ?? [])];
  const volumes: { Name: string; Labels: Record<string, string> }[] = [];
  const calls: string[] = [];
  const bodies: { call: string; body: unknown }[] = [];
  let nextId = 100;
  let clock = 1_760_000_000;
  const json = (status: number, body?: unknown) => ({
    status,
    body: body === undefined ? "" : JSON.stringify(body),
  });
  const visible = (stack: FakeStack) => admin || stack.owner === "opscrew";
  const raw = (stack: FakeStack) => {
    const { file: _file, owner: _owner, ...rest } = stack;
    return rest;
  };
  const deploy = (stack: FakeStack, status = 1, message?: string) => {
    stack.Status = status;
    stack.DeploymentStatus.push({
      Status: status,
      ...(message !== undefined ? { Message: message } : {}),
      Time: ++clock,
    });
  };
  const projectVolumes = (stack: FakeStack) => {
    for (const match of stack.file.matchAll(/^ {2}([a-z_]+_data|caddy_config): \{\}$/gm)) {
      const name = `${stack.Name}_${match[1]}`;
      if (!volumes.some((volume) => volume.Name === name)) {
        volumes.push({ Name: name, Labels: { "com.docker.compose.project": stack.Name } });
      }
    }
  };
  const request: PinnedRequest = async (init: PinnedRequestInit) => {
    const call = `${init.method} ${init.path}`;
    calls.push(call);
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    if (body !== undefined) bodies.push({ call, body });
    if (init.path !== "/api/system/status" && init.headers["X-API-Key"] !== options.token) {
      return json(401, { message: "Unauthorized" });
    }
    for (const [prefix, message] of Object.entries(options.failures ?? {})) {
      if (call.startsWith(prefix)) return json(500, { message });
    }
    const url = new URL(`http://portainer${init.path}`);
    const path = url.pathname;
    const id = (index: number) => Number(path.split("/")[index]);
    const stackById = (stackId: number) =>
      stacks.find((stack) => stack.Id === stackId && visible(stack));

    if (init.method === "GET") {
      if (path === "/api/system/status") return json(200, { Version: options.version ?? "2.45.2" });
      if (path === "/api/system/version") {
        return json(200, {
          ServerVersion: options.version ?? "2.45.2",
          ServerEdition: "CE",
          VersionSupport: "LTS",
          Dependencies: { ComposeVersion: options.composeVersion ?? "v2.39.1", DockerVersion: "28.5.1" },
        });
      }
      if (path === "/api/users/me") {
        return json(200, { Id: userId, Username: admin ? "admin" : "deployer", Role: admin ? 1 : 2 });
      }
      if (path === "/api/endpoints") {
        return json(200, [{ Id: envId, Name: "local", Type: 1, Status: 1, Snapshots: [{ Swarm: false }] }]);
      }
      if (path === `/api/endpoints/${envId}/docker/info`) {
        return json(200, {
          Architecture: options.architecture ?? "x86_64",
          OSType: "linux",
          ServerVersion: "28.5.1",
          Swarm: { LocalNodeState: "inactive" },
        });
      }
      if (path === "/api/stacks") return json(200, stacks.filter(visible).map(raw));
      if (/^\/api\/stacks\/\d+$/.test(path)) {
        const stack = stackById(id(3));
        return stack === undefined ? json(404, { message: "Not found" }) : json(200, raw(stack));
      }
      if (/^\/api\/stacks\/\d+\/file$/.test(path)) {
        const stack = stackById(id(3));
        return stack === undefined
          ? json(404, { message: "Not found" })
          : json(200, { StackFileContent: stack.file });
      }
      if (path === `/api/endpoints/${envId}/registries`) {
        return json(
          200,
          registries
            .filter((entry) => admin || entry.RegistryAccesses[String(envId)]?.UserAccessPolicies[String(userId)])
            .map(({ Username: _u, RegistryAccesses: _a, ...entry }) => entry),
        );
      }
      if (path === `/api/endpoints/${envId}/docker/volumes`) return json(200, { Volumes: volumes });
      if (path === "/api/registries") {
        return admin
          ? json(200, registries.map(({ Username: _u, ...entry }) => entry))
          : json(403, { message: "Access denied" });
      }
      if (path === `/api/endpoints/${envId}/docker/containers/json`) {
        return admin
          ? json(
              200,
              (options.containers ?? []).map((container) => ({
                Labels:
                  container.project === undefined
                    ? {}
                    : { "com.docker.compose.project": container.project },
                State: container.running === false ? "exited" : "running",
                Ports: (container.ports ?? []).map((port) => ({ PublicPort: port })),
              })),
            )
          : json(403, { message: "Access denied" });
      }
    }
    if (init.method === "POST" && path === "/api/registries") {
      const entry: FakeRegistry = {
        Id: ++nextId,
        Name: String(body?.Name),
        URL: String(body?.URL),
        Type: Number(body?.Type),
        Username: String(body?.Username),
        RegistryAccesses: {},
      };
      registries.push(entry);
      return json(200, { Id: entry.Id });
    }
    if (init.method === "PUT" && /^\/api\/registries\/\d+$/.test(path)) {
      if (!admin) return json(403, { message: "Access denied" });
      const entry = registries.find((item) => item.Id === id(3));
      if (entry === undefined) return json(404, { message: "Not found" });
      entry.Name = String(body?.Name);
      entry.URL = String(body?.URL);
      entry.Username = String(body?.Username);
      return json(200, { Id: entry.Id });
    }
    if (init.method === "PUT" && /^\/api\/endpoints\/\d+\/registries\/\d+$/.test(path)) {
      const entry = registries.find((item) => item.Id === id(5));
      if (entry === undefined) return json(404, { message: "Not found" });
      entry.RegistryAccesses[String(id(3))] = {
        UserAccessPolicies: (body?.UserAccessPolicies ?? {}) as Record<string, { RoleId: number }>,
      };
      return json(204);
    }
    if (init.method === "POST" && path === "/api/stacks/create/standalone/repository") {
      const stack: FakeStack = {
        Id: ++nextId,
        Name: String(body?.Name).toLowerCase(),
        Type: 2,
        EndpointId: envId,
        Status: 3,
        Env: (body?.Env ?? []) as { name: string; value: string }[],
        AutoUpdate: {
          Webhook: String((body?.AutoUpdate as { Webhook?: string } | undefined)?.Webhook ?? ""),
          ForcePullImage: false,
          ForceUpdate: false,
        },
        GitConfig: {
          URL: String(body?.RepositoryURL),
          ReferenceName: String(body?.RepositoryReferenceName),
          ConfigFilePath: String(body?.ComposeFile),
          ...(body?.RepositoryAuthentication === true
            ? { Authentication: { Username: String(body?.RepositoryUsername) } }
            : {}),
        },
        DeploymentStatus: [],
        file: "name: placeholder\n",
        owner: "opscrew",
      };
      if (stacks.some((other) => other.Name === stack.Name)) return json(409, { message: "exists" });
      stacks.push(stack);
      deploy(stack);
      return json(200, raw(stack));
    }
    if (init.method === "POST" && path === "/api/stacks/create/standalone/string") {
      const stack: FakeStack = {
        Id: ++nextId,
        Name: String(body?.Name).toLowerCase(),
        Type: 2,
        EndpointId: envId,
        Status: 3,
        Env: (body?.Env ?? []) as { name: string; value: string }[],
        DeploymentStatus: [],
        file: String(body?.StackFileContent),
        owner: "opscrew",
      };
      if (stacks.some((other) => other.Name === stack.Name)) return json(409, { message: "exists" });
      stacks.push(stack);
      deploy(stack);
      projectVolumes(stack);
      return json(200, raw(stack));
    }
    if (init.method === "POST" && /^\/api\/stacks\/\d+\/git$/.test(path)) {
      const stack = stackById(id(3));
      if (stack === undefined) return json(404, { message: "Not found" });
      stack.Env = (body?.Env ?? []) as { name: string; value: string }[];
      stack.AutoUpdate = {
        Webhook: String((body?.AutoUpdate as { Webhook?: string } | undefined)?.Webhook ?? ""),
        ForcePullImage: false,
        ForceUpdate: false,
      };
      stack.GitConfig = {
        URL: String(body?.RepositoryURL),
        ReferenceName: String(body?.RepositoryReferenceName),
        ConfigFilePath: String(body?.ConfigFilePath),
        ...(body?.RepositoryAuthentication === true
          ? { Authentication: { Username: String(body?.RepositoryUsername) } }
          : {}),
      };
      return json(200, raw(stack));
    }
    if (init.method === "PUT" && /^\/api\/stacks\/\d+\/git\/redeploy$/.test(path)) {
      const stack = stackById(id(3));
      if (stack === undefined) return json(404, { message: "Not found" });
      stack.Env = (body?.Env ?? []) as { name: string; value: string }[];
      deploy(stack);
      return json(200, raw(stack));
    }
    if (init.method === "PUT" && /^\/api\/stacks\/\d+$/.test(path)) {
      const stack = stackById(id(3));
      if (stack === undefined) return json(404, { message: "Not found" });
      stack.Env = (body?.Env ?? []) as { name: string; value: string }[];
      stack.file = String(body?.StackFileContent);
      deploy(stack);
      return json(200, raw(stack));
    }
    if (init.method === "POST" && /^\/api\/stacks\/\d+\/(start|stop)$/.test(path)) {
      const stack = stackById(id(3));
      if (stack === undefined) return json(404, { message: "Not found" });
      if (path.endsWith("/stop")) stack.Status = 2;
      else deploy(stack);
      return json(200, raw(stack));
    }
    if (init.method === "DELETE" && /^\/api\/stacks\/\d+$/.test(path)) {
      const index = stacks.findIndex((stack) => stack.Id === id(3) && visible(stack));
      if (index < 0) return json(404, { message: "Not found" });
      stacks.splice(index, 1);
      return json(204);
    }
    if (init.method === "DELETE" && /^\/api\/endpoints\/\d+\/docker\/volumes\//.test(path)) {
      const name = decodeURIComponent(path.split("/").pop() ?? "");
      const index = volumes.findIndex((volume) => volume.Name === name);
      if (index < 0) return json(404, { message: "No such volume" });
      volumes.splice(index, 1);
      return json(204);
    }
    if (init.method === "DELETE" && /^\/api\/registries\/\d+$/.test(path)) {
      const index = registries.findIndex((entry) => entry.Id === id(3));
      if (index < 0) return json(404, { message: "Not found" });
      registries.splice(index, 1);
      return json(204);
    }
    return json(404, { message: `no route ${call}` });
  };
  return {
    request,
    stacks,
    registries,
    volumes,
    calls,
    bodies,
    mutations: () => calls.filter((call) => !call.startsWith("GET ")),
  };
}

/** A certificate fingerprint and public-key pin made at runtime (never a committed literal). */
export function fakeCertificate(seed = "portainer certificate") {
  const digest = createHash("sha256").update(seed).digest();
  return {
    fingerprint: `SHA256:${(digest.toString("hex").toUpperCase().match(/../g) ?? []).join(":")}`,
    publicKeyPin: `sha256//${createHash("sha256").update(`${seed} key`).digest("base64")}`,
  };
}

/** `show -json` of a Portainer root (Cloudflare Tunnels and Access only): no policy fails. */
export function portainerPlanJson() {
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.tunnel",
            resources: [
              {
                address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
                mode: "managed",
                type: "cloudflare_zero_trust_tunnel_cloudflared",
                name: "this",
                values: { name: "opscrew-shop" },
              },
            ],
          },
        ],
      },
    },
    resource_changes: [],
  };
}
