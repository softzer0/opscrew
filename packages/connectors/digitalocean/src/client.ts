import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** Default DigitalOcean API base URL (paths start with `/v2`). */
export const DIGITALOCEAN_API_URL = "https://api.digitalocean.com";
/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Page size used for paginated list endpoints (the API maximum). */
const PER_PAGE = 200;
/** Safety stop for pagination that never ends. */
const MAX_PAGES = 100;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_SERVER_ERROR_RETRIES = 1;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
const SERVER_ERROR_RETRY_MS = 1_000;
/** Default time one HTTP request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_ACTION_POLL_MS = 5_000;

/** Page where DigitalOcean API tokens are created. */
export const DIGITALOCEAN_TOKEN_URL = "https://cloud.digitalocean.com/account/api/tokens";

/** Least-privilege custom scopes OpsCrew needs (provision, drift, destroy with snapshot). */
export const DIGITALOCEAN_SCOPES: readonly string[] = [
  "account:read",
  "regions:read",
  "sizes:read",
  "actions:read",
  "droplet:create",
  "droplet:read",
  "droplet:update",
  "droplet:delete",
  "ssh_key:create",
  "ssh_key:read",
  "ssh_key:delete",
  "firewall:create",
  "firewall:read",
  "firewall:update",
  "firewall:delete",
  "tag:create",
  "tag:read",
  "tag:delete",
  "image:create",
  "image:read",
  "snapshot:read",
];

/** Hint after a write whose outcome is unknown: repeating it could do it twice. */
const MAYBE_DONE_HINT =
  "The change may still have been made: check the DigitalOcean control panel before trying again.";
const TOKEN_HINT = `Create a custom-scoped token at ${DIGITALOCEAN_TOKEN_URL} and set it as DIGITALOCEAN_TOKEN.`;
/** How to create a token with the right scopes (worded so redaction rules leave the scope list alone). */
export const SCOPE_HINT = `Create a custom-scoped token at ${DIGITALOCEAN_TOKEN_URL}, then set it as DIGITALOCEAN_TOKEN. Scopes it needs: ${DIGITALOCEAN_SCOPES.join(", ")}.`;

// --- Response schemas (OpenAPI shapes; unknown fields are kept, ids become strings) -------------

/** DigitalOcean ids are integers on the wire; OpsCrew keeps them as strings. */
const idSchema = z.union([z.number(), z.string()]).transform((value) => String(value));

/** Numbers that may arrive as decimal strings. */
const decimal = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: "custom", message: `Not a number: ${String(value)}` });
    return z.NEVER;
  }
  return parsed;
});

const linksSchema = z
  .looseObject({
    pages: z
      .looseObject({
        next: z.string().nullable().optional(),
        last: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable()
  .optional();
const metaSchema = z.looseObject({ total: z.number().nullable().optional() }).nullable().optional();

export const accountSchema = z.looseObject({
  droplet_limit: z.number().nullable().optional(),
  floating_ip_limit: z.number().nullable().optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  uuid: z.string().nullable().optional(),
  email_verified: z.boolean().nullable().optional(),
  /** `active`, `warning` or `locked`. */
  status: z.string(),
  status_message: z.string().nullable().optional(),
  team: z
    .looseObject({ uuid: z.string().nullable().optional(), name: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
/** The account a token belongs to (`GET /v2/account`). */
export type DigitalOceanAccount = z.infer<typeof accountSchema>;

export const sizeSchema = z.looseObject({
  slug: z.string(),
  /** Memory in MiB. */
  memory: decimal,
  vcpus: decimal,
  /** Disk in GB. */
  disk: decimal,
  /** Included transfer in TB. */
  transfer: decimal.nullable().optional(),
  /** USD per month. */
  price_monthly: decimal,
  /** USD per hour. */
  price_hourly: decimal.nullable().optional(),
  regions: z.array(z.string()).default([]),
  available: z.boolean(),
  description: z.string().nullable().optional(),
});
/** A Droplet size (`GET /v2/sizes`). */
export type DigitalOceanSize = z.infer<typeof sizeSchema>;

export const regionSchema = z.looseObject({
  slug: z.string(),
  name: z.string().nullable().optional(),
  sizes: z.array(z.string()).default([]),
  available: z.boolean(),
  features: z.array(z.string()).optional(),
});
/** A region (`GET /v2/regions`). */
export type DigitalOceanRegion = z.infer<typeof regionSchema>;

const networkSchema = z.looseObject({
  ip_address: z.string().nullable().optional(),
  /** `public` or `private`. */
  type: z.string().nullable().optional(),
});

export const dropletSchema = z.looseObject({
  id: idSchema,
  name: z.string(),
  /** `new`, `active`, `off` or `archive`. */
  status: z.string(),
  tags: z.array(z.string()).nullable().optional(),
  size_slug: z.string().nullable().optional(),
  networks: z
    .looseObject({
      v4: z.array(networkSchema).nullable().optional(),
      v6: z.array(networkSchema).nullable().optional(),
    })
    .nullable()
    .optional(),
  region: z.looseObject({ slug: z.string().nullable().optional() }).nullable().optional(),
});
/** A Droplet (`GET /v2/droplets`); `id` is a string. */
export type DigitalOceanDroplet = z.infer<typeof dropletSchema>;

export const actionSchema = z.looseObject({
  id: idSchema,
  /** `in-progress`, `completed` or `errored`. */
  status: z.string(),
  type: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  resource_id: idSchema.nullable().optional(),
  resource_type: z.string().nullable().optional(),
  region_slug: z.string().nullable().optional(),
});
/** A DigitalOcean action (`GET /v2/actions/{id}`); ids are strings. */
export type DigitalOceanAction = z.infer<typeof actionSchema>;

export const snapshotSchema = z.looseObject({
  id: idSchema,
  name: z.string(),
  created_at: z.string().nullable().optional(),
  regions: z.array(z.string()).nullable().optional(),
  size_gigabytes: decimal.nullable().optional(),
  min_disk_size: decimal.nullable().optional(),
  type: z.string().nullable().optional(),
});
/** A Droplet snapshot (`GET /v2/droplets/{id}/snapshots`); `id` is a string. */
export type DigitalOceanSnapshot = z.infer<typeof snapshotSchema>;

const errorBodySchema = z.looseObject({
  id: z.string().optional(),
  message: z.string().optional(),
});

// --- Client -------------------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DigitalOceanClientOptions {
  /** DigitalOcean API token. Only ever sent in the `Authorization` header. */
  token: string;
  fetch?: FetchLike;
  /** API base URL without `/v2` (default {@link DIGITALOCEAN_API_URL}). */
  baseUrl?: string;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay used for rate-limit waits, retries and polling. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) used to interpret `ratelimit-reset` and action timeouts. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 15 seconds). */
  timeoutMs?: number;
}

/** Polling options for {@link DigitalOceanClient.waitForAction}. */
export interface WaitForActionOptions {
  /** Give up after this many milliseconds (default 15 minutes). */
  timeoutMs?: number;
  /** Delay between polls in milliseconds (default 5 seconds). */
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Typed DigitalOcean API v2 client with pagination, rate-limit handling and plain-English errors
 * that never contain the token. The only write is {@link snapshotDroplet}, called after approval.
 */
export class DigitalOceanClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: DigitalOceanClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = (options.baseUrl ?? DIGITALOCEAN_API_URL).replace(/\/+$/, "");
    this.userAgent = `opscrew/${options.version ?? CONNECTOR_VERSION}`;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** The account the token belongs to (`GET /v2/account`). */
  async getAccount(): Promise<DigitalOceanAccount> {
    const body = await this.request("/v2/account", z.looseObject({ account: accountSchema }));
    return body.account;
  }

  /** All Droplet sizes (`GET /v2/sizes`, every page). */
  listSizes(): Promise<DigitalOceanSize[]> {
    return this.listAll("/v2/sizes", "sizes", sizeSchema);
  }

  /** All regions (`GET /v2/regions`, every page). */
  listRegions(): Promise<DigitalOceanRegion[]> {
    return this.listAll("/v2/regions", "regions", regionSchema);
  }

  /** Droplets carrying `tag` (`GET /v2/droplets?tag_name=<tag>`, every page). */
  listDropletsByTag(tag: string): Promise<DigitalOceanDroplet[]> {
    return this.listAll("/v2/droplets", "droplets", dropletSchema, { tag_name: tag });
  }

  /**
   * Starts a snapshot of a Droplet (`POST /v2/droplets/{id}/actions`, `type: "snapshot"`) and
   * returns the action. Use {@link waitForAction} to wait for it and
   * {@link listDropletSnapshots} to find the snapshot by `name`.
   */
  async snapshotDroplet(dropletId: string | number, name: string): Promise<DigitalOceanAction> {
    const body = await this.request(
      `/v2/droplets/${encodeURIComponent(String(dropletId))}/actions`,
      z.looseObject({ action: actionSchema }),
      {},
      { method: "POST", body: { type: "snapshot", name } },
    );
    return body.action;
  }

  /** One action by id (`GET /v2/actions/{id}`). */
  async getAction(actionId: string | number): Promise<DigitalOceanAction> {
    const body = await this.request(
      `/v2/actions/${encodeURIComponent(String(actionId))}`,
      z.looseObject({ action: actionSchema }),
    );
    return body.action;
  }

  /**
   * Polls an action until it is `completed` and returns it. An `errored` action and a timeout
   * both throw `OpsCrewError` (`PROVIDER_ERROR`).
   */
  async waitForAction(
    actionId: string | number,
    options: WaitForActionOptions = {},
  ): Promise<DigitalOceanAction> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_ACTION_POLL_MS;
    const start = this.now();
    for (;;) {
      const action = await this.getAction(actionId);
      const label = `DigitalOcean action ${action.id}${action.type ? ` (${action.type})` : ""}`;
      if (action.status === "completed") return action;
      if (action.status === "errored") {
        throw new OpsCrewError("PROVIDER_ERROR", `${label} failed.`, {
          hint: "Check the Droplet's history in the DigitalOcean control panel (https://cloud.digitalocean.com/droplets), then try again.",
        });
      }
      const elapsed = this.now() - start;
      if (elapsed >= timeoutMs) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `${label} did not finish within ${duration(timeoutMs)}.`,
          {
            hint: "It may still be running: check its progress in the DigitalOcean control panel and try again once it has finished.",
          },
        );
      }
      await this.sleep(Math.min(pollMs, timeoutMs - elapsed));
    }
  }

  /** Snapshots of one Droplet (`GET /v2/droplets/{id}/snapshots`, every page). */
  listDropletSnapshots(dropletId: string | number): Promise<DigitalOceanSnapshot[]> {
    return this.listAll(
      `/v2/droplets/${encodeURIComponent(String(dropletId))}/snapshots`,
      "snapshots",
      snapshotSchema,
    );
  }

  private async listAll<T>(
    path: string,
    key: string,
    item: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const schema = z.looseObject({ [key]: z.array(item), links: linksSchema, meta: metaSchema });
    const out: T[] = [];
    const seen = new Set<number>();
    let page = 1;
    for (;;) {
      if (seen.size >= MAX_PAGES) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean kept returning more pages for ${path} after ${MAX_PAGES} pages.`,
          { hint: "The DigitalOcean API may have changed; please report this to OpsCrew." },
        );
      }
      seen.add(page);
      const body = (await this.request(path, schema, {
        ...query,
        page: String(page),
        per_page: String(PER_PAGE),
      })) as Record<string, unknown> & { links?: z.infer<typeof linksSchema> };
      const items = body[key] as T[];
      if (items.length === 0) break;
      out.push(...items);
      const next = nextPage(body.links?.pages?.next, page);
      if (next === undefined || seen.has(next)) break;
      page = next;
    }
    return out;
  }

  private async request<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string> = {},
    init: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const method = init.method ?? "GET";
    // A write is only repeated after a 429 (DigitalOcean did not accept it). After a 5xx, a
    // timeout or a dropped connection it may already have been carried out.
    const idempotent = method === "GET";

    let rateLimitRetries = 0;
    let serverErrorRetries = 0;
    for (;;) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      let body: { json: unknown } | { error: unknown } | undefined;
      try {
        response = await untilAborted(
          this.fetchImpl(url.toString(), {
            method,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: "application/json",
              "User-Agent": this.userAgent,
              ...(init.body !== undefined && { "Content-Type": "application/json" }),
            },
            ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
            signal,
          }),
          signal,
        );
        if (response.ok) {
          body = await untilAborted(response.json(), signal).then(
            (json: unknown) => ({ json }),
            (error: unknown) => {
              if (signal.aborted) throw error;
              return { error };
            },
          );
        }
      } catch (cause) {
        if (idempotent && serverErrorRetries < MAX_SERVER_ERROR_RETRIES) {
          await this.sleep(SERVER_ERROR_RETRY_MS);
          serverErrorRetries++;
          continue;
        }
        const what = signal.aborted
          ? `The DigitalOcean API did not answer within ${duration(this.timeoutMs)} (${method} ${path}).`
          : `Could not reach the DigitalOcean API (${method} ${path}).`;
        throw new OpsCrewError("PROVIDER_ERROR", what, {
          hint: idempotent
            ? "Check your network connection and try again; see https://status.digitalocean.com/ if it keeps happening."
            : MAYBE_DONE_HINT,
          cause,
        });
      }

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        await this.sleep(this.rateLimitWait(response));
        rateLimitRetries++;
        continue;
      }
      if (idempotent && response.status >= 500 && serverErrorRetries < MAX_SERVER_ERROR_RETRIES) {
        await this.sleep(SERVER_ERROR_RETRY_MS);
        serverErrorRetries++;
        continue;
      }
      if (!response.ok || body === undefined) {
        throw await this.toError(response, method, path, signal, idempotent);
      }
      if ("error" in body) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean returned invalid JSON for ${path}.`,
          {
            hint: idempotent
              ? "Try again; see https://status.digitalocean.com/ if it keeps happening."
              : MAYBE_DONE_HINT,
          },
        );
      }
      const parsed = schema.safeParse(body.json);
      if (!parsed.success) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean returned an unexpected response for ${path}: ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
          {
            hint: idempotent
              ? "The DigitalOcean API may have changed; please report this to OpsCrew."
              : `${MAYBE_DONE_HINT} The DigitalOcean API may have changed; please report this to OpsCrew.`,
          },
        );
      }
      return parsed.data;
    }
  }

  /** Wait until `ratelimit-reset` (epoch seconds) when present, capped at 60 s. */
  private rateLimitWait(response: Response): number {
    const reset = Number(response.headers.get("ratelimit-reset"));
    const wait =
      Number.isFinite(reset) && reset > 0 ? reset * 1000 - this.now() : DEFAULT_RATE_LIMIT_WAIT_MS;
    return Math.min(Math.max(wait, 0), MAX_RATE_LIMIT_WAIT_MS);
  }

  private async toError(
    response: Response,
    method: string,
    path: string,
    signal: AbortSignal,
    idempotent: boolean,
  ): Promise<OpsCrewError> {
    let apiMessage: string | undefined;
    try {
      const parsed = errorBodySchema.safeParse(await untilAborted(response.json(), signal));
      if (parsed.success) apiMessage = parsed.data.message ?? parsed.data.id;
    } catch {
      // Body was not JSON; fall back to the status text.
    }
    // The API should never echo the token; make sure it cannot reach a message anyway.
    const detail = scrub(
      apiMessage ?? (response.statusText || `HTTP ${response.status}`),
      this.token,
    );
    const request = `${method} ${path}`;
    switch (response.status) {
      case 401:
        return new OpsCrewError(
          "CREDENTIALS_INVALID",
          `DigitalOcean rejected the API token (${detail}).`,
          { hint: TOKEN_HINT },
        );
      case 403:
        return new OpsCrewError(
          "CREDENTIALS_INVALID",
          `DigitalOcean refused ${request} (HTTP 403: ${detail}). The token is probably missing a scope OpsCrew needs.`,
          { hint: SCOPE_HINT },
        );
      case 404:
        return new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean could not find what ${request} asked for (HTTP 404: ${detail}).`,
          {
            hint: "It may have been deleted in the DigitalOcean control panel; check https://cloud.digitalocean.com/ and try again.",
          },
        );
      case 422:
        return new OpsCrewError("PROVIDER_ERROR", `DigitalOcean rejected ${request}: ${detail}`, {
          hint: "Fix the value DigitalOcean named above and try again.",
        });
      case 429:
        return new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean rate limit reached for ${request} (${detail}).`,
          { hint: "Wait a few minutes and try again." },
        );
      default:
        return new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean API request ${request} failed (HTTP ${response.status}: ${detail}).`,
          {
            hint: idempotent
              ? "Try again later; check https://status.digitalocean.com/ if it keeps failing."
              : MAYBE_DONE_HINT,
          },
        );
    }
  }
}

/** The page number named by a `links.pages.next` URL, or the following page when unreadable. */
function nextPage(link: string | null | undefined, current: number): number | undefined {
  if (link === undefined || link === null || link === "") return undefined;
  try {
    const page = Number(new URL(link, DIGITALOCEAN_API_URL).searchParams.get("page"));
    if (Number.isInteger(page) && page > current) return page;
  } catch {
    // Not a URL: fall through.
  }
  return current + 1;
}

function scrub(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("[REDACTED]");
}

/**
 * Settles like `promise`, or rejects with the signal's reason once it aborts, so a `fetch`
 * implementation that ignores its abort signal still cannot hang the caller.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const value = Math.round(ms / 100) / 10;
  return `${value} second${value === 1 ? "" : "s"}`;
}
