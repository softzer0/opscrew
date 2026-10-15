/**
 * Network helpers of the Portainer live test (`portainer-target.test.ts`): the throwaway Hetzner
 * server with its firewall, the test's own calls to Portainer (setup as "the user", observations,
 * the decoys; always with the certificate pinned), what OpsCrew creates in Cloudflare for an app
 * in a Portainer, a few GitHub reads, GHCR's token endpoint, plain HTTP probes and an MCP client
 * session with the built CLI. Nothing here prints; the test masks everything it logs.
 */
import { request as nodeHttpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type PinnedRequest, pinnedRequest } from "@opscrew/connector-portainer";
import {
  type ApiResult,
  api,
  type Cloudflare,
  type CloudflareAppResources,
  type CloudflareZone,
  deleteThrowaway,
  GITHUB_API,
  type GitHubRepo,
  HETZNER_API,
  type HttpsAnswer,
  hetznerLabels,
  minutes,
  retryDelete,
  sleep,
  type ThrowawayServer,
  type ZoneRuleset,
} from "./own-cloud";
import { type HetznerServerType, hetznerIpv6Address, serverCandidates } from "./own-support";
import { firewallRules } from "./portainer-support";

// ---------------------------------------------------------------------------------------------
// Hetzner: the throwaway server with its firewall, created outside OpsCrew.

/**
 * Creates the throwaway server the test installs Portainer on: a firewall that opens Portainer's
 * port only to the test computer (`firewallRules`), the test's SSH key, then the cheapest x86
 * server type in the nearby locations that Hetzner accepts (Ubuntu 24.04, IPv4 and IPv6). The ids
 * are reported at once (`onFirewall`, `onKey`, `onServer`) so cleanup finds them after a failure.
 */
export async function createPortainerServer(options: {
  token: string;
  runId: string;
  publicKey: string;
  locations: readonly string[];
  forcedType?: string;
  testIpv4: string;
  onFirewall: (id: number) => void;
  onKey: (id: number) => void;
  onServer: (id: number) => void;
  log: (message: string) => void;
}): Promise<ThrowawayServer> {
  const hetzner = (method: string, path: string, body?: unknown) =>
    api(HETZNER_API, options.token, method, path, body);
  const name = `opscrew-e2e-portainer-${options.runId}`;
  const labels = hetznerLabels(options.runId);

  const firewall = await hetzner("POST", "/firewalls", {
    name,
    labels,
    rules: firewallRules(options.testIpv4),
  });
  const firewallId = (firewall.json as { firewall?: { id: number } } | undefined)?.firewall?.id;
  if (firewall.status !== 201 || firewallId === undefined) {
    throw new Error(`Hetzner refused the test's firewall (HTTP ${firewall.status}).`);
  }
  options.onFirewall(firewallId);

  const key = await hetzner("POST", "/ssh_keys", { name, public_key: options.publicKey, labels });
  const keyId = (key.json as { ssh_key?: { id: number } } | undefined)?.ssh_key?.id;
  if (key.status !== 201 || keyId === undefined) {
    throw new Error(`Hetzner refused the test's SSH key (HTTP ${key.status}).`);
  }
  options.onKey(keyId);

  const types = await hetzner("GET", "/server_types?per_page=50");
  const list = (types.json as { server_types?: HetznerServerType[] } | undefined)?.server_types;
  if (types.status !== 200 || list === undefined) {
    throw new Error(`Could not list Hetzner server types (HTTP ${types.status}).`);
  }
  const candidates = serverCandidates(list, options.locations, options.forcedType).slice(0, 8);
  if (candidates.length === 0) {
    throw new Error(
      `No x86 server type${options.forcedType ? ` named ${options.forcedType}` : ""} is offered in ${options.locations.join(", ")}.`,
    );
  }
  const refusals: string[] = [];
  for (const candidate of candidates) {
    options.log(
      `creating a ${candidate.serverType} server in ${candidate.location} (${candidate.hourlyGross.toFixed(4)} EUR an hour)`,
    );
    const created = await hetzner("POST", "/servers", {
      name,
      server_type: candidate.serverType,
      image: "ubuntu-24.04",
      location: candidate.location,
      ssh_keys: [keyId],
      firewalls: [{ firewall: firewallId }],
      labels,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      start_after_create: true,
    });
    const server = (created.json as { server?: { id: number } } | undefined)?.server;
    if (created.status === 201 && server !== undefined) {
      options.onServer(server.id);
      return { ...(await waitUntilRunning(hetzner, server.id, options.log)), name, ...candidate };
    }
    const error = (created.json as { error?: { code?: string } } | undefined)?.error?.code;
    refusals.push(`${candidate.serverType} in ${candidate.location}: ${error ?? created.status}`);
  }
  throw new Error(`Hetzner created no server: ${refusals.join("; ")}.`);
}

async function waitUntilRunning(
  hetzner: (method: string, path: string) => Promise<ApiResult>,
  id: number,
  log: (message: string) => void,
): Promise<{ id: number; ipv4: string; ipv6?: string; ipv6Network?: string }> {
  log("waiting for the server to run (up to 5 minutes)");
  const deadline = Date.now() + minutes(5);
  while (Date.now() < deadline) {
    const got = await hetzner("GET", `/servers/${id}`);
    const server = (
      got.json as
        | {
            server?: {
              status: string;
              public_net: { ipv4?: { ip: string } | null; ipv6?: { ip: string } | null };
            };
          }
        | undefined
    )?.server;
    const ipv4 = server?.public_net.ipv4?.ip;
    if (server?.status === "running" && ipv4 !== undefined) {
      const network = server.public_net.ipv6?.ip;
      return {
        id,
        ipv4,
        ...(network === undefined
          ? {}
          : { ipv6: hetznerIpv6Address(network), ipv6Network: network.replace(/\/\d+$/, "") }),
      };
    }
    await sleep(5_000);
  }
  throw new Error("The throwaway server did not reach the running state within 5 minutes.");
}

/**
 * Deletes the throwaway server and SSH key (`deleteThrowaway`), then its firewall (the known id
 * and anything labelled with this run, never anything else), which Hetzner frees only once the
 * server is gone. Returns problems.
 */
export async function deletePortainerThrowaway(options: {
  token: string;
  runId: string;
  serverId?: number;
  keyId?: number;
  firewallId?: number;
}): Promise<string[]> {
  const problems = await deleteThrowaway({
    token: options.token,
    runId: options.runId,
    ...(options.serverId === undefined ? {} : { serverId: options.serverId }),
    ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
  });
  const hetzner = (method: string, path: string) => api(HETZNER_API, options.token, method, path);
  const selector = encodeURIComponent(`managed-by=opscrew-e2e,run=${options.runId}`);
  const listed = await hetzner("GET", `/firewalls?label_selector=${selector}`);
  const ids = new Set(
    ((listed.json as { firewalls?: { id: number }[] } | undefined)?.firewalls ?? []).map(
      (item) => item.id,
    ),
  );
  if (options.firewallId !== undefined) ids.add(options.firewallId);
  for (const id of ids) {
    // A firewall stays "in use" for a little while after its server is deleted.
    let deleted = false;
    for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
      deleted = await retryDelete(() => hetzner("DELETE", `/firewalls/${id}`));
    }
    if (!deleted) problems.push(`Hetzner did not delete firewall ${id}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Portainer: the test's own calls, always with the certificate pinned.

/** A Portainer answer: the status, the parsed JSON body (when it is JSON) and the text. */
export interface PortainerAnswer {
  status: number;
  json: unknown;
  text: string;
}

/**
 * The test's Portainer client ("the user" setting Portainer up and looking at it). Every request
 * goes through the adapter's pinned request function, so a different certificate fails before
 * anything is sent. Error messages name the status and Portainer's own `message`, never a body.
 */
export class PortainerApi {
  private readonly send: PinnedRequest;
  private auth: Record<string, string> = {};

  constructor(
    private readonly url: string,
    private readonly fingerprint: string,
  ) {
    this.send = pinnedRequest({ url, certFingerprint: fingerprint });
  }

  /** A client for the same Portainer that sends `X-API-Key: <token>`. */
  withToken(token: string): PortainerApi {
    const client = new PortainerApi(this.url, this.fingerprint);
    client.auth = { "X-API-Key": token };
    return client;
  }

  /** A client for the same Portainer that sends a session (`Authorization: Bearer <jwt>`). */
  withSession(jwt: string): PortainerApi {
    const client = new PortainerApi(this.url, this.fingerprint);
    client.auth = { Authorization: `Bearer ${jwt}` };
    return client;
  }

  /** One request; never throws for an HTTP error status. */
  async call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      json?: unknown;
      form?: { body: string; contentType: string };
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<PortainerAnswer> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.auth,
      ...options.headers,
    };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers["Content-Type"] = options.form.contentType;
      body = options.form.body;
    }
    const answer = await this.send({
      method,
      path,
      headers,
      ...(body === undefined ? {} : { body }),
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    let json: unknown;
    try {
      json = answer.body ? JSON.parse(answer.body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: answer.status, json, text: answer.body };
  }

  /** {@link call}, throwing a plain message (`Portainer refused to <what>`) unless 2xx. */
  async ok<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    what: string,
    options: Parameters<PortainerApi["call"]>[2] = {},
  ): Promise<T> {
    const answer = await this.call(method, path, options);
    if (answer.status < 200 || answer.status >= 300) {
      const message = (answer.json as { message?: unknown } | undefined)?.message;
      throw new Error(
        `Portainer refused to ${what} (HTTP ${answer.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}).`,
      );
    }
    return answer.json as T;
  }
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: what OpsCrew creates for an app in a Portainer (iac-templates infra/portainer.ts).

interface Named {
  id: string;
  name: string;
}

/**
 * What OpsCrew may have created in Cloudflare for `app` in a Portainer: DNS records on
 * `hostnames`, the tunnels `opscrew-<app>` (the app) and `opscrew-<app>-portainer` (the webhook),
 * the Access application `OpsCrew Portainer webhook (<app>)`, the policy and service token
 * `OpsCrew deploy (<app>)`, and the zone's rulesets (all of them, for the snapshot before the run;
 * `Cloudflare.removeCreated` deletes only the run's). Never the Zero Trust organization.
 */
export async function portainerAppResources(
  cloudflare: Cloudflare,
  zone: CloudflareZone,
  app: string,
  hostnames: readonly string[],
): Promise<CloudflareAppResources> {
  const records = (
    await cloudflare.list<Named & { type: string }>(`/zones/${zone.id}/dns_records`)
  ).filter((record) => hostnames.includes(record.name));
  const account = `/accounts/${zone.accountId}`;
  const tunnelNames = [`opscrew-${app}`, `opscrew-${app}-portainer`];
  const tunnels: Named[] = [];
  for (const name of tunnelNames) {
    const found = await cloudflare.list<Named>(
      `${account}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
    );
    tunnels.push(...found.filter((tunnel) => tunnel.name === name));
  }
  const apps = (await cloudflare.list<Named>(`${account}/access/apps`)).filter(
    (item) => item.name === `OpsCrew Portainer webhook (${app})`,
  );
  const policies = (await cloudflare.list<Named>(`${account}/access/policies`)).filter(
    (item) => item.name === `OpsCrew deploy (${app})`,
  );
  const serviceTokens = (await cloudflare.list<Named>(`${account}/access/service_tokens`)).filter(
    (item) => item.name === `OpsCrew deploy (${app})`,
  );
  const listed = await cloudflare.call("GET", `/zones/${zone.id}/rulesets`);
  const rulesets = (listed.json as { result?: ZoneRuleset[] } | undefined)?.result;
  return {
    records,
    tunnels,
    apps,
    policies,
    serviceTokens,
    ...(listed.status === 200 && Array.isArray(rulesets) ? { rulesets } : {}),
  };
}

/**
 * The rules of a zone ruleset in a comparable form (each rule's id, expression, action, its
 * parameters and whether it is enabled; not the versions and times Cloudflare changes on its own),
 * or `undefined` when the ruleset is gone.
 */
export async function rulesetRules(
  cloudflare: Cloudflare,
  zone: CloudflareZone,
  id: string,
): Promise<string | undefined> {
  const read = await cloudflare.call("GET", `/zones/${zone.id}/rulesets/${id}`);
  if (read.status === 404) return undefined;
  const rules = (read.json as { result?: { rules?: Record<string, unknown>[] } } | undefined)
    ?.result?.rules;
  if (read.status !== 200) {
    throw new Error(`Cloudflare did not show the ruleset ${id} (HTTP ${read.status}).`);
  }
  return JSON.stringify(
    (rules ?? []).map((rule) => ({
      id: rule.id,
      expression: rule.expression,
      action: rule.action,
      action_parameters: rule.action_parameters,
      enabled: rule.enabled,
    })),
  );
}

/**
 * The zone rulesets in `snapshot` (id → rules from {@link rulesetRules}) whose rules are no longer
 * the same, by name; never restored, only reported.
 */
export async function changedRulesets(
  cloudflare: Cloudflare,
  zone: CloudflareZone,
  snapshot: ReadonlyMap<string, { name: string; rules: string | undefined }>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const [id, before] of snapshot) {
    if (before.rules === undefined) continue;
    const now = await rulesetRules(cloudflare, zone, id);
    if (now !== before.rules) {
      changed.push(
        `the zone ruleset "${before.name}" that existed before the run ${now === undefined ? "is gone" : "has other rules now"} (not restored; check it in Cloudflare)`,
      );
    }
  }
  return changed;
}

/** Creates a DNS-only record (the one OpsCrew tells the user to create) and returns its id. */
export async function createDnsRecord(
  cloudflare: Cloudflare,
  zone: CloudflareZone,
  record: { type: "A" | "AAAA"; name: string; content: string },
): Promise<string> {
  const created = await cloudflare.call("POST", `/zones/${zone.id}/dns_records`, {
    ...record,
    proxied: false,
    ttl: 60,
    comment: "opscrew-e2e: the record the user creates for caddy or proxy mode",
  });
  const id = (created.json as { result?: { id?: string } } | undefined)?.result?.id;
  if (created.status !== 200 || id === undefined) {
    throw new Error(
      `Cloudflare did not create the ${record.type} record (HTTP ${created.status}).`,
    );
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// GitHub: a few reads the Portainer flow needs.

/** The repository's visibility and owner. */
export async function repoInfo(
  github: GitHubRepo,
): Promise<{ private: boolean; owner: string; ownerType: string }> {
  const got = await github.call("GET", `/repos/${github.name}`);
  const repo = got.json as
    | { private?: boolean; owner?: { login?: string; type?: string } }
    | undefined;
  if (got.status !== 200 || typeof repo?.private !== "boolean" || !repo.owner?.login) {
    throw new Error(`Could not read the throwaway repository (HTTP ${got.status}).`);
  }
  return { private: repo.private, owner: repo.owner.login, ownerType: repo.owner.type ?? "User" };
}

/** The head commit of `branch`, or `undefined` when the branch does not exist. */
export async function branchHead(github: GitHubRepo, branch: string): Promise<string | undefined> {
  const got = await github.call(
    "GET",
    `/repos/${github.name}/branches/${encodeURIComponent(branch)}`,
  );
  if (got.status === 404) return undefined;
  const sha = (got.json as { commit?: { sha?: string } } | undefined)?.commit?.sha;
  if (got.status !== 200 || sha === undefined) {
    throw new Error(`Could not read the branch ${branch} (HTTP ${got.status}).`);
  }
  return sha;
}

/** The text of `path` at `ref`, or `undefined` when it does not exist there. */
export async function fileAt(
  github: GitHubRepo,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const got = await github.call(
    "GET",
    `/repos/${github.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
  );
  if (got.status === 404) return undefined;
  const content = (got.json as { content?: string } | undefined)?.content;
  if (got.status !== 200 || content === undefined) {
    throw new Error(`Could not read ${path} at ${ref} (HTTP ${got.status}).`);
  }
  return Buffer.from(content, "base64").toString("utf8");
}

/** A commit's first message line, its number of parents and the paths in its tree. */
export async function commitDetails(
  github: GitHubRepo,
  sha: string,
): Promise<{ subject: string; parents: number; paths: string[] }> {
  const got = await github.call("GET", `/repos/${github.name}/git/commits/${sha}`);
  const commit = got.json as
    | { message?: string; parents?: unknown[]; tree?: { sha?: string } }
    | undefined;
  if (got.status !== 200 || commit?.tree?.sha === undefined) {
    throw new Error(`Could not read commit ${sha} (HTTP ${got.status}).`);
  }
  const tree = await github.call(
    "GET",
    `/repos/${github.name}/git/trees/${commit.tree.sha}?recursive=1`,
  );
  const entries =
    (tree.json as { tree?: { path: string; type: string }[] } | undefined)?.tree ?? [];
  return {
    subject: (commit.message ?? "").split("\n")[0] ?? "",
    parents: commit.parents?.length ?? 0,
    paths: entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .sort(),
  };
}

/** Every step of every job of a workflow run, with its conclusion. */
export async function runSteps(
  github: GitHubRepo,
  runId: number,
): Promise<{ job: string; step: string; conclusion: string | null }[]> {
  const got = await github.call("GET", `/repos/${github.name}/actions/runs/${runId}/jobs`);
  const jobs =
    (
      got.json as
        | { jobs?: { name: string; steps?: { name: string; conclusion: string | null }[] }[] }
        | undefined
    )?.jobs ?? [];
  return jobs.flatMap((job) =>
    (job.steps ?? []).map((step) => ({
      job: job.name,
      step: step.name,
      conclusion: step.conclusion,
    })),
  );
}

/** The names of the repository's GitHub Actions secrets. */
export async function secretNames(github: GitHubRepo): Promise<string[]> {
  const got = await github.call("GET", `/repos/${github.name}/actions/secrets?per_page=100`);
  if (got.status !== 200)
    throw new Error(`Could not list the Actions secrets (HTTP ${got.status}).`);
  return ((got.json as { secrets?: { name: string }[] } | undefined)?.secrets ?? []).map(
    (secret) => secret.name,
  );
}

/**
 * The visibility of the app's container package (`public` or `private`), read with the classic
 * `read:packages` token; `undefined` when GitHub does not say.
 */
export async function packageVisibility(
  token: string,
  owner: string,
  ownerType: string,
  name: string,
): Promise<string | undefined> {
  const scope = ownerType === "Organization" ? "orgs" : "users";
  const got = await api(
    GITHUB_API,
    token,
    "GET",
    `/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(name)}`,
  );
  const visibility = (got.json as { visibility?: string } | undefined)?.visibility;
  return got.status === 200 ? visibility : undefined;
}

/**
 * The HTTP status of GHCR's token endpoint for pulling `repository` (`<owner>/<name>`) with the
 * login `user`/`password`: 200 means GHCR accepts that login for a pull.
 */
export async function ghcrPullStatus(
  repository: string,
  user: string,
  password: string,
): Promise<number> {
  const basic = Buffer.from(`${user}:${password}`).toString("base64");
  const response = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
    { headers: { Authorization: `Basic ${basic}`, "User-Agent": "opscrew-e2e" } },
  );
  await response.text();
  return response.status;
}

// ---------------------------------------------------------------------------------------------
// Probes from this computer.

/** The test computer's public IPv4 address, from Cloudflare's trace on 1.1.1.1. */
export async function traceText(): Promise<string> {
  const response = await fetch("https://1.1.1.1/cdn-cgi/trace", {
    headers: { "User-Agent": "opscrew-e2e" },
  });
  if (!response.ok) throw new Error(`Cloudflare's trace answered HTTP ${response.status}.`);
  return response.text();
}

/** A plain HTTP request (web mode `proxy`: Caddy on the Portainer host's port). */
export function httpGet(
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<HttpsAnswer> {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      new URL(url),
      {
        method: "GET",
        headers: { "User-Agent": "opscrew-e2e", ...options.headers },
        timeout: options.timeoutMs ?? 15_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 100_000) body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The request timed out.")));
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// MCP: the built CLI's `opscrew mcp` with a client that shows approval dialogs.

/** A tool result: whether it is an error, its text and its structured content. */
export interface McpToolResult {
  isError: boolean;
  text: string;
  data: Record<string, unknown>;
}

/**
 * An MCP session with `opscrew mcp` over stdio. The client supports form elicitation and answers
 * OpsCrew's approval dialogs as the user would: it approves a yes/no dialog only when `approve`
 * returns true for its message, and never types a name (so nothing destructive is approved).
 * `transcript` keeps every result, dialog message and line of standard error for the leak check.
 */
export class McpSession {
  /** Everything the server sent: results (text and JSON), dialog messages, standard error. */
  readonly transcript: string[] = [];
  /** The dialog messages, in order. */
  readonly dialogs: { message: string; approved: boolean }[] = [];

  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async start(options: {
    cli: string;
    cwd: string;
    env: Record<string, string | undefined>;
    approve: (message: string) => boolean;
  }): Promise<McpSession> {
    const env = Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => {
        return entry[1] !== undefined;
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [options.cli, "mcp"],
      cwd: options.cwd,
      env,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "opscrew-e2e", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    const session = new McpSession(client, transport);
    transport.stderr?.on("data", (chunk: Buffer) => session.transcript.push(chunk.toString()));
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as {
        message?: string;
        requestedSchema?: { properties?: Record<string, unknown> };
      };
      const message = params.message ?? "";
      session.transcript.push(message);
      const yesNo = params.requestedSchema?.properties?.approve !== undefined;
      const approved = yesNo && options.approve(message);
      session.dialogs.push({ message, approved });
      return approved
        ? { action: "accept" as const, content: { approve: true } }
        : { action: "decline" as const };
    });
    await client.connect(transport);
    return session;
  }

  /** Calls a tool (up to 30 minutes: an apply waits for Portainer). */
  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: minutes(30),
      maxTotalTimeout: minutes(30),
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((item) => (item as { type?: string; text?: string }).text ?? "")
      .join("\n");
    const data = (result.structuredContent ?? {}) as Record<string, unknown>;
    this.transcript.push(text, JSON.stringify(data));
    return { isError: result.isError === true, text, data };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
  }
}
