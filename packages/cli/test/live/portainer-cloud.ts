/**
 * Network helpers of the Portainer live test (`portainer-target.test.ts`): the test's own calls to
 * Portainer (setup as "the user", observations, the decoys; always with the certificate pinned),
 * the zone rulesets it compares and the DNS record it creates in Cloudflare, a few GitHub reads,
 * GHCR's token endpoint, the test computer's public address and an MCP client session with the
 * built CLI. Nothing here prints; the test masks everything it logs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type PinnedRequest, pinnedRequest } from "@opscrew/connector-portainer";
import {
  api,
  type Cloudflare,
  type CloudflareZone,
  GITHUB_API,
  type GitHubRepo,
  minutes,
} from "./cloud";
import { logErrors } from "./portainer-support";

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
// Cloudflare: the zone's rulesets before and after the run, and the record the user creates.

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

/**
 * The head commit of `branch`, or `undefined` when the branch does not exist. Reads the Git ref
 * (`GET /git/ref/heads/{branch}`), not `GET /branches/{branch}`: the branches endpoint can answer
 * 404 for a moment after a ref was created through the Git Data API, as OpsCrew creates it.
 */
export async function branchHead(github: GitHubRepo, branch: string): Promise<string | undefined> {
  const got = await github.call(
    "GET",
    `/repos/${github.name}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (got.status === 404) return undefined;
  const sha = (got.json as { object?: { sha?: string } } | undefined)?.object?.sha;
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

/**
 * The `##[error]` messages in the log of the job named `jobName` of a workflow run, in order.
 * Reads only that job's log (Actions: read is enough; check-run annotations need Checks: read).
 * GitHub masks the run's secrets in the log; the log itself is never returned or printed, and the
 * test still scrubs the messages it shows.
 */
export async function jobErrors(
  github: GitHubRepo,
  runId: number,
  jobName: string,
): Promise<string[]> {
  const got = await github.call(
    "GET",
    `/repos/${github.name}/actions/runs/${runId}/jobs?per_page=100`,
  );
  const jobs = (got.json as { jobs?: { id: number; name: string }[] } | undefined)?.jobs;
  if (got.status !== 200 || jobs === undefined) {
    throw new Error(`Could not list the jobs of workflow run ${runId} (HTTP ${got.status}).`);
  }
  const job = jobs.find((item) => item.name === jobName);
  if (job === undefined) throw new Error(`Workflow run ${runId} has no job named ${jobName}.`);
  const log = await github.redirectedText(`/repos/${github.name}/actions/jobs/${job.id}/logs`);
  if (log.status !== 200) {
    throw new Error(`Could not read the log of job ${job.name} (HTTP ${log.status}).`);
  }
  return logErrors(log.text);
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

/** The test computer's public IPv4 address, from Cloudflare's trace on 1.1.1.1 (`ip=<address>`). */
export async function publicIpv4(): Promise<string> {
  const response = await fetch("https://1.1.1.1/cdn-cgi/trace", {
    headers: { "User-Agent": "opscrew-e2e" },
  });
  if (!response.ok) throw new Error(`Cloudflare's trace answered HTTP ${response.status}.`);
  const ip = /^ip=(\d{1,3}(?:\.\d{1,3}){3})$/m.exec(await response.text())?.[1];
  if (ip === undefined) throw new Error("Could not read this computer's public IPv4 address.");
  return ip;
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
