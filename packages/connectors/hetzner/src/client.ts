import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

/** Default Hetzner Cloud API base URL. */
export const HETZNER_API_URL = "https://api.hetzner.cloud/v1";
/** Version sent in the `User-Agent` header when the caller does not pass one. */
export const HETZNER_CONNECTOR_VERSION = "0.1.0";
/** Page size used for paginated list endpoints. */
export const PER_PAGE = 50;

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_SERVER_ERROR_RETRIES = 2;
const MAX_WAIT_MS = 60_000;
/** Default time one HTTP request may take before it counts as failed and is retried. */
export const HETZNER_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_HINT =
  "Create a Read & Write API token in the Hetzner Cloud Console (your project → Security → API tokens) and set it as HCLOUD_TOKEN.";

// --- Response schemas (hcloud-go shapes; unknown fields are kept) ------------------------------

/** Hetzner sends prices as decimal strings; accept numbers too and parse to `number`. */
const decimal = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: "custom", message: `Not a decimal number: ${String(value)}` });
    return z.NEVER;
  }
  return parsed;
});

const priceSchema = z.looseObject({ net: decimal, gross: decimal });

const deprecationSchema = z.looseObject({
  announced: z.string().optional(),
  unavailable_after: z.string().optional(),
});

const paginationSchema = z.looseObject({
  page: z.number().optional(),
  per_page: z.number().optional(),
  next_page: z.number().nullable().optional(),
  last_page: z.number().nullable().optional(),
  total_entries: z.number().nullable().optional(),
});
const metaSchema = z.looseObject({ pagination: paginationSchema.optional() }).optional();

export const serverTypePriceSchema = z.looseObject({
  location: z.string(),
  price_hourly: priceSchema,
  price_monthly: priceSchema,
  included_traffic: z.number().nullable().optional(),
  price_per_tb_traffic: priceSchema.nullable().optional(),
});

export const serverTypeLocationSchema = z.looseObject({
  id: z.number().optional(),
  name: z.string(),
  available: z.boolean().optional(),
  recommended: z.boolean().optional(),
  deprecation: deprecationSchema.nullable().optional(),
});

export const serverTypeSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().nullable().optional(),
  cores: z.number(),
  memory: z.number(),
  disk: z.number(),
  storage_type: z.string().optional(),
  cpu_type: z.string(),
  architecture: z.string().optional(),
  included_traffic: z.number().nullable().optional(),
  deprecated: z.union([z.boolean(), deprecationSchema]).nullable().optional(),
  deprecation: deprecationSchema.nullable().optional(),
  prices: z.array(serverTypePriceSchema),
  locations: z.array(serverTypeLocationSchema).optional(),
});
export type HetznerServerType = z.infer<typeof serverTypeSchema>;

export const locationSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  country: z.string(),
  city: z.string().optional(),
  network_zone: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});
export type HetznerLocation = z.infer<typeof locationSchema>;

const locationPriceSchema = z.looseObject({
  location: z.string(),
  price_hourly: priceSchema.optional(),
  price_monthly: priceSchema,
});

export const pricingSchema = z.looseObject({
  currency: z.string(),
  vat_rate: decimal.optional(),
  primary_ips: z
    .array(z.looseObject({ type: z.string(), prices: z.array(locationPriceSchema) }))
    .optional(),
  server_backup: z.looseObject({ percentage: decimal }).optional(),
  volume: z.looseObject({ price_per_gb_month: priceSchema }).optional(),
});
export type HetznerPricing = z.infer<typeof pricingSchema>;

export const imageSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullable().optional(),
  description: z.string().optional(),
  type: z.string(),
  status: z.string().optional(),
  os_flavor: z.string().optional(),
  os_version: z.string().nullable().optional(),
  architecture: z.string().optional(),
  deprecated: z.string().nullable().optional(),
});
export type HetznerImage = z.infer<typeof imageSchema>;

export const serverSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  created: z.string().optional(),
  server_type: z.looseObject({ name: z.string() }).optional(),
  datacenter: z
    .looseObject({ location: z.looseObject({ name: z.string() }).optional() })
    .optional(),
  labels: z.record(z.string(), z.string()).optional(),
  public_net: z
    .looseObject({
      ipv4: z.looseObject({ ip: z.string() }).nullable().optional(),
      ipv6: z.looseObject({ ip: z.string() }).nullable().optional(),
    })
    .optional(),
});
export type HetznerServer = z.infer<typeof serverSchema>;

/** A server as returned by {@link HetznerClient.listServers}. */
export interface HetznerServerSummary {
  id: number;
  name: string;
  /** Hetzner status such as `running`, `off`, `initializing`. */
  status: string;
  labels: Record<string, string>;
  /** Public IPv4 address, when the server has one. */
  ipv4?: string;
  /** Public IPv6 network as reported by Hetzner (for example `2001:db8::/64`), when present. */
  ipv6?: string;
}

/** Filter for {@link HetznerClient.listServers}. */
export interface ListServersOptions {
  /** Hetzner label selector, for example `managed-by=opscrew,app=shop`. */
  labelSelector?: string;
}

/** Input for {@link HetznerClient.createSnapshot}. */
export interface CreateSnapshotOptions {
  description: string;
  labels?: Record<string, string>;
}

/** Ids returned by {@link HetznerClient.createSnapshot}. */
export interface CreateSnapshotResult {
  imageId: number;
  actionId: number;
}

/** Polling options for {@link HetznerClient.waitForAction}. */
export interface WaitForActionOptions {
  /** Give up after this many milliseconds (default 10 minutes). */
  timeoutMs?: number;
  /** Delay between polls in milliseconds (default 2 seconds). */
  intervalMs?: number;
  /** Injectable delay between polls (defaults to the client's). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in epoch ms (defaults to the client's). */
  now?: () => number;
}

export const actionSchema = z.looseObject({
  id: z.number(),
  command: z.string().optional(),
  /** `running`, `success` or `error`. */
  status: z.string(),
  progress: z.number().optional(),
  started: z.string().nullable().optional(),
  finished: z.string().nullable().optional(),
  error: z
    .looseObject({ code: z.string().optional(), message: z.string().optional() })
    .nullable()
    .optional(),
});
/** A Hetzner Cloud action (`GET /actions/{id}`). */
export type HetznerAction = z.infer<typeof actionSchema>;

const DEFAULT_ACTION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_ACTION_INTERVAL_MS = 2_000;

const errorBodySchema = z.looseObject({
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
});

// --- Client -------------------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HetznerClientOptions {
  /** Hetzner Cloud project API token. Only ever sent in the `Authorization` header. */
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay used between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) used to interpret `RateLimit-Reset`. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default {@link HETZNER_REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Typed Hetzner Cloud API client with pagination, retries and error mapping. Write methods are
 * only called after an approval; reads and rate-limited writes are retried, other failed writes
 * are not (the server may already have carried them out).
 */
export class HetznerClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: HetznerClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = (options.baseUrl ?? HETZNER_API_URL).replace(/\/+$/, "");
    this.userAgent = `opscrew/${options.version ?? HETZNER_CONNECTOR_VERSION}`;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? HETZNER_REQUEST_TIMEOUT_MS;
  }

  /** All server types (`GET /server_types`, every page). */
  listServerTypes(): Promise<HetznerServerType[]> {
    return this.listAll("/server_types", "server_types", serverTypeSchema);
  }

  /** All locations (`GET /locations`, every page). */
  listLocations(): Promise<HetznerLocation[]> {
    return this.listAll("/locations", "locations", locationSchema);
  }

  /** Prices for IPs, backups and volumes (`GET /pricing`). */
  async getPricing(): Promise<HetznerPricing> {
    const body = await this.request("/pricing", z.looseObject({ pricing: pricingSchema }));
    return body.pricing;
  }

  /** Images, optionally filtered by `name` and `architecture` (`GET /images`, every page). */
  listImages(
    filter: { name?: string; architecture?: "x86" | "arm" } = {},
  ): Promise<HetznerImage[]> {
    const query: Record<string, string> = {};
    if (filter.name !== undefined) query.name = filter.name;
    if (filter.architecture !== undefined) query.architecture = filter.architecture;
    return this.listAll("/images", "images", imageSchema, query);
  }

  /** One server by id (`GET /servers/{id}`). */
  async getServer(id: number): Promise<HetznerServer> {
    const body = await this.request(
      `/servers/${encodeURIComponent(String(id))}`,
      z.looseObject({ server: serverSchema }),
    );
    return body.server;
  }

  /** Servers, optionally filtered by a label selector (`GET /servers`, every page). */
  async listServers(options: ListServersOptions = {}): Promise<HetznerServerSummary[]> {
    const query: Record<string, string> = {};
    if (options.labelSelector !== undefined) query.label_selector = options.labelSelector;
    const servers = await this.listAll("/servers", "servers", serverSchema, query);
    return servers.map((server) => {
      const summary: HetznerServerSummary = {
        id: server.id,
        name: server.name,
        status: server.status,
        labels: { ...server.labels },
      };
      const ipv4 = server.public_net?.ipv4?.ip;
      const ipv6 = server.public_net?.ipv6?.ip;
      if (ipv4 !== undefined) summary.ipv4 = ipv4;
      if (ipv6 !== undefined) summary.ipv6 = ipv6;
      return summary;
    });
  }

  /**
   * Starts a snapshot of a server (`POST /servers/{id}/actions/create_image`, `type: "snapshot"`).
   * Use {@link waitForAction} with the returned `actionId` to wait until the image is ready.
   */
  async createSnapshot(
    serverId: number,
    options: CreateSnapshotOptions,
  ): Promise<CreateSnapshotResult> {
    const body = await this.request(
      `/servers/${encodeURIComponent(String(serverId))}/actions/create_image`,
      z.looseObject({ image: imageSchema, action: actionSchema }),
      {},
      {
        method: "POST",
        body: {
          type: "snapshot",
          description: options.description,
          ...(options.labels !== undefined && { labels: options.labels }),
        },
      },
    );
    return { imageId: body.image.id, actionId: body.action.id };
  }

  /** One action by id (`GET /actions/{id}`). */
  async getAction(actionId: number): Promise<HetznerAction> {
    const body = await this.request(
      `/actions/${encodeURIComponent(String(actionId))}`,
      z.looseObject({ action: actionSchema }),
    );
    return body.action;
  }

  /**
   * Polls an action until it succeeds and returns it. An action that ends in `error` and a
   * timeout both throw `OpsCrewError` (`PROVIDER_ERROR`).
   */
  async waitForAction(
    actionId: number,
    options: WaitForActionOptions = {},
  ): Promise<HetznerAction> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_ACTION_INTERVAL_MS;
    const sleep = options.sleep ?? this.sleep;
    const now = options.now ?? this.now;
    const start = now();
    for (;;) {
      const action = await this.getAction(actionId);
      const label = `Hetzner action ${actionId}${action.command ? ` (${action.command})` : ""}`;
      if (action.status === "success") return action;
      if (action.status === "error") {
        const detail = action.error?.message ?? action.error?.code ?? "no reason given";
        throw new OpsCrewError("PROVIDER_ERROR", `${label} failed: ${detail}`, {
          hint: "Check the server in the Hetzner Cloud Console, then try again.",
        });
      }
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `${label} did not finish within ${seconds(timeoutMs)}.`,
          {
            hint: "It may still be running: check its progress in the Hetzner Cloud Console and try again once it has finished.",
          },
        );
      }
      await sleep(Math.min(intervalMs, timeoutMs - elapsed));
    }
  }

  /**
   * Checks the token with a cheap read (one location). Resolves when the token works; throws
   * `OpsCrewError` (`CREDENTIALS_INVALID` for a rejected token) otherwise.
   */
  async verifyToken(): Promise<void> {
    await this.request("/locations", z.looseObject({ locations: z.array(locationSchema) }), {
      per_page: "1",
    });
  }

  private async listAll<T>(
    path: string,
    key: string,
    item: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const schema = z.looseObject({ [key]: z.array(item), meta: metaSchema });
    const out: T[] = [];
    let page: number | null | undefined = 1;
    const seen = new Set<number>();
    while (page !== null && page !== undefined && !seen.has(page)) {
      seen.add(page);
      const body = (await this.request(path, schema, {
        ...query,
        page: String(page),
        per_page: String(PER_PAGE),
      })) as Record<string, unknown> & { meta?: z.infer<typeof metaSchema> };
      out.push(...(body[key] as T[]));
      page = body.meta?.pagination?.next_page;
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
    // A write is only retried when Hetzner said it did not accept it (429). After a 5xx, a timeout
    // or a dropped connection it may already have been carried out, so it is never repeated.
    const idempotent = method === "GET";

    let rateLimitRetries = 0;
    let serverErrorRetries = 0;
    for (;;) {
      // A fresh timeout per attempt: a hanging API counts as a failed attempt and is retried.
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
        const timedOut = signal.aborted;
        if (!idempotent) {
          throw new OpsCrewError(
            "PROVIDER_ERROR",
            timedOut
              ? `The Hetzner Cloud API did not answer within ${seconds(this.timeoutMs)} (${method} ${path}).`
              : `Lost the connection to the Hetzner Cloud API (${method} ${path}).`,
            {
              hint: "The change may still have been made: check the Hetzner Cloud Console before trying again.",
              cause,
            },
          );
        }
        if (serverErrorRetries < MAX_SERVER_ERROR_RETRIES) {
          await this.sleep(2 ** serverErrorRetries * 1000);
          serverErrorRetries++;
          continue;
        }
        if (timedOut) {
          throw new OpsCrewError(
            "PROVIDER_ERROR",
            `The Hetzner Cloud API did not answer within ${seconds(this.timeoutMs)} (${path}).`,
            {
              hint: "Try again in a few minutes; check https://status.hetzner.com/ if it keeps happening.",
              cause,
            },
          );
        }
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Could not reach the Hetzner Cloud API (${path}).`,
          {
            hint: "Check your network connection and try again.",
            cause,
          },
        );
      }

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        await this.sleep(this.rateLimitWait(response, rateLimitRetries));
        rateLimitRetries++;
        continue;
      }
      if (idempotent && response.status >= 500 && serverErrorRetries < MAX_SERVER_ERROR_RETRIES) {
        await this.sleep(2 ** serverErrorRetries * 1000);
        serverErrorRetries++;
        continue;
      }
      if (!response.ok || body === undefined) throw await toError(response, path, signal);
      if ("error" in body) {
        throw new OpsCrewError("PROVIDER_ERROR", `Hetzner returned invalid JSON for ${path}.`, {
          cause: body.error,
        });
      }
      const parsed = schema.safeParse(body.json);
      if (!parsed.success) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `Hetzner returned an unexpected response for ${path}: ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
          { hint: "The Hetzner API may have changed; please report this to OpsCrew." },
        );
      }
      return parsed.data;
    }
  }

  /** Wait until `RateLimit-Reset` (unix seconds) when present, else 2^n seconds; capped at 60 s. */
  private rateLimitWait(response: Response, attempt: number): number {
    const reset = Number(response.headers.get("RateLimit-Reset"));
    const wait =
      Number.isFinite(reset) && reset > 0 ? reset * 1000 - this.now() : 2 ** attempt * 1000;
    return Math.min(Math.max(wait, 0), MAX_WAIT_MS);
  }
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

function seconds(ms: number): string {
  const value = Math.round(ms / 100) / 10;
  return `${value} second${value === 1 ? "" : "s"}`;
}

async function toError(
  response: Response,
  path: string,
  signal: AbortSignal,
): Promise<OpsCrewError> {
  let apiMessage: string | undefined;
  try {
    const parsed = errorBodySchema.safeParse(await untilAborted(response.json(), signal));
    if (parsed.success) apiMessage = parsed.data.error.message;
  } catch {
    // Body was not JSON; fall back to the status text.
  }
  const detail = apiMessage ?? (response.statusText || `HTTP ${response.status}`);
  if (response.status === 401) {
    return new OpsCrewError("CREDENTIALS_INVALID", `Hetzner rejected the API token: ${detail}`, {
      hint: TOKEN_HINT,
    });
  }
  if (response.status === 429) {
    return new OpsCrewError("PROVIDER_ERROR", `Hetzner rate limit reached: ${detail}`, {
      hint: "Wait a minute and try again.",
    });
  }
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `Hetzner API request ${path} failed (HTTP ${response.status}): ${detail}`,
    {
      hint:
        response.status === 403
          ? "Check that the token belongs to the right project and has Read & Write permission."
          : "Try again later; check https://status.hetzner.com/ if it keeps failing.",
    },
  );
}
