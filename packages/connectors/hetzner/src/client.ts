import type { FetchLike } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  durationText,
  type JsonClient,
  jsonClient,
  OpsCrewError,
  pollAction,
  RATE_LIMIT_HINT,
  type RequestFailure,
  requestJson,
  statusPageHint,
} from "@opscrew/core";
import { z } from "zod";

/** Default Hetzner Cloud API base URL. */
export const HETZNER_API_URL = "https://api.hetzner.cloud/v1";
/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Page size used for paginated list endpoints. */
const PER_PAGE = 50;
/** Default time one HTTP request may take before it counts as failed (and a read is retried). */
const REQUEST_TIMEOUT_MS = 15_000;
const ACTION_INTERVAL_MS = 2_000;
/** How to create the Hetzner Cloud API token OpsCrew needs and where it goes. */
export const HETZNER_TOKEN_HINT =
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

const metaSchema = z
  .looseObject({
    pagination: z.looseObject({ next_page: z.number().nullable().optional() }).optional(),
  })
  .optional();

const serverTypeSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  cores: z.number(),
  memory: z.number(),
  disk: z.number(),
  cpu_type: z.string(),
  architecture: z.string().optional(),
  deprecated: z.union([z.boolean(), deprecationSchema]).nullable().optional(),
  deprecation: deprecationSchema.nullable().optional(),
  prices: z.array(z.looseObject({ location: z.string(), price_monthly: priceSchema })),
  locations: z
    .array(
      z.looseObject({
        name: z.string(),
        available: z.boolean().optional(),
        deprecation: deprecationSchema.nullable().optional(),
      }),
    )
    .optional(),
});
export type HetznerServerType = z.infer<typeof serverTypeSchema>;

const locationSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  country: z.string(),
  city: z.string().optional(),
});
export type HetznerLocation = z.infer<typeof locationSchema>;

const pricingSchema = z.looseObject({
  currency: z.string(),
  primary_ips: z
    .array(
      z.looseObject({
        type: z.string(),
        prices: z.array(z.looseObject({ location: z.string(), price_monthly: priceSchema })),
      }),
    )
    .optional(),
  server_backup: z.looseObject({ percentage: decimal }).optional(),
});
export type HetznerPricing = z.infer<typeof pricingSchema>;

const serverSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
  public_net: z
    .looseObject({
      ipv4: z.looseObject({ ip: z.string() }).nullable().optional(),
      ipv6: z.looseObject({ ip: z.string() }).nullable().optional(),
    })
    .optional(),
});

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

/** Input for {@link HetznerClient.createSnapshot}. */
export interface CreateSnapshotOptions {
  description: string;
  labels?: Record<string, string>;
}

const imageSchema = z.looseObject({
  id: z.number(),
  type: z.string(),
  description: z.string().nullable().optional(),
  /** ISO 8601 creation time. */
  created: z.string(),
  /** GB in Hetzner's storage, what a snapshot is billed by; null while it is being created. */
  image_size: z.number().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  created_from: z.looseObject({ id: z.number() }).nullable().optional(),
});
/** A Hetzner Cloud image (`GET /images`). */
export type HetznerImage = z.infer<typeof imageSchema>;

const actionSchema = z.looseObject({
  id: z.number(),
  command: z.string().optional(),
  /** `running`, `success` or `error`. */
  status: z.string(),
  error: z
    .looseObject({ code: z.string().optional(), message: z.string().optional() })
    .nullable()
    .optional(),
});
/** A Hetzner Cloud action (`GET /actions/{id}`). */
export type HetznerAction = z.infer<typeof actionSchema>;

const errorBodySchema = z.looseObject({
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
});

// --- Client -------------------------------------------------------------------------------------

export interface HetznerClientOptions {
  /** Hetzner Cloud project API token. Only ever sent in the `Authorization` header. */
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay used between retries and polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for `RateLimit-Reset` and action timeouts. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 15 seconds). */
  timeoutMs?: number;
}

/**
 * Typed Hetzner Cloud API client with pagination, retries and error mapping. Write methods are
 * only called after an approval; reads and rate-limited writes are retried, other failed writes
 * are not (the server may already have carried them out).
 */
export class HetznerClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #http: JsonClient;

  constructor(options: HetznerClientOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? HETZNER_API_URL).replace(/\/+$/, "");
    this.#userAgent = `opscrew/${options.version ?? CONNECTOR_VERSION}`;
    this.#http = jsonClient(options, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      retry: {
        serverErrors: 2,
        serverErrorDelayMs: (attempt) => 2 ** attempt * 1000,
        rateLimits: 3,
        rateLimitDelayMs: (attempt) => 2 ** attempt * 1000,
      },
    });
  }

  /** All server types (`GET /server_types`, every page). */
  listServerTypes(): Promise<HetznerServerType[]> {
    return this.#listAll("/server_types", "server_types", serverTypeSchema);
  }

  /** All locations (`GET /locations`, every page). */
  listLocations(): Promise<HetznerLocation[]> {
    return this.#listAll("/locations", "locations", locationSchema);
  }

  /** Prices for primary IPs and backups (`GET /pricing`). */
  async getPricing(): Promise<HetznerPricing> {
    return (await this.#request("/pricing", z.looseObject({ pricing: pricingSchema }))).pricing;
  }

  /** Servers, optionally filtered by a label selector (`GET /servers`, every page). */
  async listServers(options: { labelSelector?: string } = {}): Promise<HetznerServerSummary[]> {
    const query: Record<string, string> = {};
    if (options.labelSelector !== undefined) query.label_selector = options.labelSelector;
    const servers = await this.#listAll("/servers", "servers", serverSchema, query);
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
  ): Promise<{ imageId: number; actionId: number }> {
    const body = await this.#request(
      `/servers/${encodeURIComponent(String(serverId))}/actions/create_image`,
      z.looseObject({ image: z.looseObject({ id: z.number() }), action: actionSchema }),
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

  /**
   * The snapshots of a server matching `labelSelector` (`GET /images?type=snapshot`, every page).
   * Hetzner's `bound_to` filter only applies to backups, so snapshots are matched to the server by
   * their `created_from` here.
   */
  async listSnapshots(serverId: number, labelSelector: string): Promise<HetznerImage[]> {
    const images = await this.#listAll("/images", "images", imageSchema, {
      type: "snapshot",
      label_selector: labelSelector,
    });
    return images.filter((image) => image.created_from?.id === serverId);
  }

  /** Deletes an image (`DELETE /images/{id}`); Hetzner answers 204 once it is gone. */
  async deleteImage(imageId: number): Promise<void> {
    await this.#request(
      `/images/${encodeURIComponent(String(imageId))}`,
      z.undefined(),
      {},
      {
        method: "DELETE",
      },
    );
  }

  /**
   * Starts rebuilding a server from an image (`POST /servers/{id}/actions/rebuild`), keeping its
   * id and addresses. Use {@link waitForAction} with the returned `actionId`. The `root_password`
   * Hetzner may answer with is stripped while parsing and never kept.
   */
  async rebuildServer(serverId: number, imageId: number): Promise<{ actionId: number }> {
    const body = await this.#request(
      `/servers/${encodeURIComponent(String(serverId))}/actions/rebuild`,
      z.object({ action: actionSchema }),
      {},
      { method: "POST", body: { image: String(imageId) } },
    );
    return { actionId: body.action.id };
  }

  /** One action by id (`GET /actions/{id}`). */
  async getAction(actionId: number): Promise<HetznerAction> {
    const body = await this.#request(
      `/actions/${encodeURIComponent(String(actionId))}`,
      z.looseObject({ action: actionSchema }),
    );
    return body.action;
  }

  /**
   * Polls an action every 2 seconds until it succeeds and returns it. An action that ends in
   * `error` and one still running after `timeoutMs` both throw `OpsCrewError` (`PROVIDER_ERROR`).
   */
  waitForAction(actionId: number, options: { timeoutMs: number }): Promise<HetznerAction> {
    const label = (action: HetznerAction) =>
      `Hetzner action ${actionId}${action.command ? ` (${action.command})` : ""}`;
    return pollAction({
      read: () => this.getAction(actionId),
      finished: (action) => {
        if (action.status === "error") {
          const detail = action.error?.message ?? action.error?.code ?? "no reason given";
          throw new OpsCrewError("PROVIDER_ERROR", `${label(action)} failed: ${detail}`, {
            hint: "Check the server in the Hetzner Cloud Console, then try again.",
          });
        }
        return action.status === "success";
      },
      timedOut: (action) =>
        new OpsCrewError(
          "PROVIDER_ERROR",
          `${label(action)} did not finish within ${durationText(options.timeoutMs)}.`,
          {
            hint: "It may still be running: check its progress in the Hetzner Cloud Console and try again once it has finished.",
          },
        ),
      timeoutMs: options.timeoutMs,
      intervalMs: ACTION_INTERVAL_MS,
      sleep: this.#http.sleep,
      now: this.#http.now,
    });
  }

  /**
   * Checks the token with a cheap read (one location). Resolves when the token works; throws
   * `OpsCrewError` (`CREDENTIALS_INVALID` for a rejected token) otherwise.
   */
  async verifyToken(): Promise<void> {
    await this.#request("/locations", z.looseObject({ locations: z.array(locationSchema) }), {
      per_page: "1",
    });
  }

  async #listAll<T>(
    path: string,
    key: string,
    item: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const schema = z.looseObject({ [key]: z.array(item), meta: metaSchema });
    const out: T[] = [];
    let page: number | null | undefined = 1;
    while (page !== null && page !== undefined) {
      const body = (await this.#request(path, schema, {
        page: String(page),
        per_page: String(PER_PAGE),
        ...query,
      })) as Record<string, unknown> & { meta?: z.infer<typeof metaSchema> };
      out.push(...(body[key] as T[]));
      page = body.meta?.pagination?.next_page;
    }
    return out;
  }

  #request<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string> = {},
    init: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const method = init.method ?? "GET";
    return requestJson(this.#http, {
      url: `${this.#baseUrl}${path}`,
      query,
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "User-Agent": this.#userAgent },
      ...(init.body !== undefined && { body: init.body }),
      schema,
      fail: (failure) => this.#error(failure, method, path),
    });
  }

  async #error(failure: RequestFailure, method: string, path: string): Promise<OpsCrewError> {
    switch (failure.kind) {
      case "unreachable": {
        const { timedOut, cause } = failure;
        const within = `did not answer within ${durationText(this.#http.timeoutMs)}`;
        if (!failure.idempotent) {
          return new OpsCrewError(
            "PROVIDER_ERROR",
            timedOut
              ? `The Hetzner Cloud API ${within} (${method} ${path}).`
              : `Lost the connection to the Hetzner Cloud API (${method} ${path}).`,
            {
              hint: "The change may still have been made: check the Hetzner Cloud Console before trying again.",
              cause,
            },
          );
        }
        return timedOut
          ? new OpsCrewError("PROVIDER_ERROR", `The Hetzner Cloud API ${within} (${path}).`, {
              hint: "Try again in a few minutes; check https://status.hetzner.com/ if it keeps happening.",
              cause,
            })
          : new OpsCrewError("PROVIDER_ERROR", `Could not reach the Hetzner Cloud API (${path}).`, {
              hint: CONNECTION_HINT,
              cause,
            });
      }
      case "invalid-json":
        return new OpsCrewError("PROVIDER_ERROR", `Hetzner returned invalid JSON for ${path}.`, {
          cause: failure.cause,
        });
      case "unexpected":
        return new OpsCrewError(
          "PROVIDER_ERROR",
          `Hetzner returned an unexpected response for ${path}: ${failure.issues}`,
          { hint: "The Hetzner API may have changed; please report this to OpsCrew." },
        );
      case "status":
        return statusError(failure.response, path);
    }
  }
}

async function statusError(response: Response, path: string): Promise<OpsCrewError> {
  let apiMessage: string | undefined;
  let apiCode: string | undefined;
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) ({ message: apiMessage, code: apiCode } = parsed.data.error);
  } catch {
    // Body was not JSON; fall back to the status text.
  }
  const detail = apiMessage ?? (response.statusText || `HTTP ${response.status}`);
  if (response.status === 401) {
    return new OpsCrewError("CREDENTIALS_INVALID", `Hetzner rejected the API token: ${detail}`, {
      hint: HETZNER_TOKEN_HINT,
    });
  }
  if (response.status === 429) {
    return new OpsCrewError("PROVIDER_ERROR", `Hetzner rate limit reached: ${detail}`, {
      hint: RATE_LIMIT_HINT,
    });
  }
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `Hetzner API request ${path} failed (HTTP ${response.status}): ${detail}`,
    { hint: statusHint(response.status, apiCode) },
  );
}

/** The next step after Hetzner answered with an error `status` and error `code`. */
function statusHint(status: number, code: string | undefined): string {
  switch (status) {
    case 403:
      if (code === "protected") {
        return "Remove its delete protection in the Hetzner Cloud Console first, then try again.";
      }
      return "Check that the token belongs to the right project and has Read & Write permission.";
    case 404:
      return "It may have been deleted: check the Hetzner Cloud Console and use an id that exists there.";
    case 409:
    case 423:
      return "Another action is still running on it: wait until it has finished in the Hetzner Cloud Console, then try again.";
    case 400:
    case 422:
      return "Hetzner refused the request as sent: fix what it named above, then try again.";
    default:
      return statusPageHint("https://status.hetzner.com/");
  }
}
