import type { FetchLike } from "@opscrew/contracts";
import {
  type JsonClient,
  OpsCrewError,
  pollAction,
  type RequestFailure,
  requestJson,
} from "@opscrew/core";
import { z } from "zod";

/** Default DigitalOcean API base URL (paths start with `/v2`). */
export const DIGITALOCEAN_API_URL = "https://api.digitalocean.com";
/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Page size used for paginated list endpoints (the API maximum). */
const PER_PAGE = 200;
/** Default time one HTTP request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 15_000;
const ACTION_POLL_MS = 5_000;

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
    pages: z.looseObject({ next: z.string().nullable().optional() }).nullable().optional(),
  })
  .nullable()
  .optional();

const accountSchema = z.looseObject({
  email: z.string().nullable().optional(),
  email_verified: z.boolean().nullable().optional(),
  /** `active`, `warning` or `locked`. */
  status: z.string(),
  status_message: z.string().nullable().optional(),
  team: z.looseObject({ name: z.string().nullable().optional() }).nullable().optional(),
});
/** The account a token belongs to (`GET /v2/account`). */
export type DigitalOceanAccount = z.infer<typeof accountSchema>;

const sizeSchema = z.looseObject({
  slug: z.string(),
  /** Memory in MiB. */
  memory: decimal,
  vcpus: decimal,
  /** Disk in GB. */
  disk: decimal,
  /** USD per month. */
  price_monthly: decimal,
  regions: z.array(z.string()).default([]),
  available: z.boolean(),
  description: z.string().nullable().optional(),
});
/** A Droplet size (`GET /v2/sizes`). */
export type DigitalOceanSize = z.infer<typeof sizeSchema>;

const regionSchema = z.looseObject({
  slug: z.string(),
  name: z.string().nullable().optional(),
  sizes: z.array(z.string()).default([]),
  available: z.boolean(),
});
/** A region (`GET /v2/regions`). */
export type DigitalOceanRegion = z.infer<typeof regionSchema>;

const networkSchema = z.looseObject({
  ip_address: z.string().nullable().optional(),
  /** `public` or `private`. */
  type: z.string().nullable().optional(),
});

const dropletSchema = z.looseObject({
  id: idSchema,
  name: z.string(),
  /** `new`, `active`, `off` or `archive`. */
  status: z.string(),
  tags: z.array(z.string()).nullable().optional(),
  networks: z
    .looseObject({
      v4: z.array(networkSchema).nullable().optional(),
      v6: z.array(networkSchema).nullable().optional(),
    })
    .nullable()
    .optional(),
});
/** A Droplet (`GET /v2/droplets`); `id` is a string. */
export type DigitalOceanDroplet = z.infer<typeof dropletSchema>;

const actionSchema = z.looseObject({
  id: idSchema,
  /** `in-progress`, `completed` or `errored`. */
  status: z.string(),
  type: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  resource_id: idSchema.nullable().optional(),
});
/** A DigitalOcean action (`GET /v2/actions/{id}`); ids are strings. */
export type DigitalOceanAction = z.infer<typeof actionSchema>;

const snapshotSchema = z.looseObject({
  id: idSchema,
  name: z.string(),
  created_at: z.string().nullable().optional(),
});
/** A Droplet snapshot (`GET /v2/droplets/{id}/snapshots`); `id` is a string. */
export type DigitalOceanSnapshot = z.infer<typeof snapshotSchema>;

const errorBodySchema = z.looseObject({
  id: z.string().optional(),
  message: z.string().optional(),
});

// --- Client -------------------------------------------------------------------------------------

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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Typed DigitalOcean API v2 client with pagination, rate-limit handling and plain-English errors
 * that never contain the token. The only write is {@link snapshotDroplet}, called after approval.
 */
export class DigitalOceanClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #http: JsonClient;

  constructor(options: DigitalOceanClientOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? DIGITALOCEAN_API_URL).replace(/\/+$/, "");
    this.#userAgent = `opscrew/${options.version ?? CONNECTOR_VERSION}`;
    this.#http = {
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      retry: {
        serverErrors: 1,
        serverErrorDelayMs: () => 1_000,
        rateLimits: 1,
        rateLimitDelayMs: () => 5_000,
      },
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    };
  }

  /** The account the token belongs to (`GET /v2/account`). */
  async getAccount(): Promise<DigitalOceanAccount> {
    const body = await this.#request("/v2/account", z.looseObject({ account: accountSchema }));
    return body.account;
  }

  /** All Droplet sizes (`GET /v2/sizes`, every page). */
  listSizes(): Promise<DigitalOceanSize[]> {
    return this.#listAll("/v2/sizes", "sizes", sizeSchema);
  }

  /** All regions (`GET /v2/regions`, every page). */
  listRegions(): Promise<DigitalOceanRegion[]> {
    return this.#listAll("/v2/regions", "regions", regionSchema);
  }

  /** Droplets carrying `tag` (`GET /v2/droplets?tag_name=<tag>`, every page). */
  listDropletsByTag(tag: string): Promise<DigitalOceanDroplet[]> {
    return this.#listAll("/v2/droplets", "droplets", dropletSchema, { tag_name: tag });
  }

  /**
   * Starts a snapshot of a Droplet (`POST /v2/droplets/{id}/actions`, `type: "snapshot"`) and
   * returns the action. Use {@link waitForAction} to wait for it and
   * {@link listDropletSnapshots} to find the snapshot by `name`.
   */
  async snapshotDroplet(dropletId: string | number, name: string): Promise<DigitalOceanAction> {
    const body = await this.#request(
      `/v2/droplets/${encodeURIComponent(String(dropletId))}/actions`,
      z.looseObject({ action: actionSchema }),
      {},
      { method: "POST", body: { type: "snapshot", name } },
    );
    return body.action;
  }

  /** One action by id (`GET /v2/actions/{id}`). */
  async getAction(actionId: string | number): Promise<DigitalOceanAction> {
    const body = await this.#request(
      `/v2/actions/${encodeURIComponent(String(actionId))}`,
      z.looseObject({ action: actionSchema }),
    );
    return body.action;
  }

  /**
   * Polls an action every 5 seconds until it is `completed` and returns it. An `errored` action
   * and one still running after `timeoutMs` both throw `OpsCrewError` (`PROVIDER_ERROR`).
   */
  waitForAction(
    actionId: string | number,
    options: { timeoutMs: number },
  ): Promise<DigitalOceanAction> {
    const label = (action: DigitalOceanAction) =>
      `DigitalOcean action ${action.id}${action.type ? ` (${action.type})` : ""}`;
    return pollAction({
      read: () => this.getAction(actionId),
      finished: (action) => {
        if (action.status === "errored") {
          throw new OpsCrewError("PROVIDER_ERROR", `${label(action)} failed.`, {
            hint: "Check the Droplet's history in the DigitalOcean control panel (https://cloud.digitalocean.com/droplets), then try again.",
          });
        }
        return action.status === "completed";
      },
      timedOut: (action) =>
        new OpsCrewError(
          "PROVIDER_ERROR",
          `${label(action)} did not finish within ${duration(options.timeoutMs)}.`,
          {
            hint: "It may still be running: check its progress in the DigitalOcean control panel and try again once it has finished.",
          },
        ),
      timeoutMs: options.timeoutMs,
      intervalMs: ACTION_POLL_MS,
      sleep: this.#http.sleep,
      now: this.#http.now,
    });
  }

  /** Snapshots of one Droplet (`GET /v2/droplets/{id}/snapshots`, every page). */
  listDropletSnapshots(dropletId: string | number): Promise<DigitalOceanSnapshot[]> {
    return this.#listAll(
      `/v2/droplets/${encodeURIComponent(String(dropletId))}/snapshots`,
      "snapshots",
      snapshotSchema,
    );
  }

  /** Every page of a list, following `links.pages.next` until a page without one or an empty page. */
  async #listAll<T>(
    path: string,
    key: string,
    item: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const schema = z.looseObject({ [key]: z.array(item), links: linksSchema });
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const body = (await this.#request(path, schema, {
        page: String(page),
        per_page: String(PER_PAGE),
        ...query,
      })) as Record<string, unknown> & { links?: z.infer<typeof linksSchema> };
      const items = body[key] as T[];
      out.push(...items);
      if (items.length === 0 || !body.links?.pages?.next) return out;
    }
  }

  #request<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string> = {},
    init: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const method = init.method ?? "GET";
    return requestJson(this.#http, {
      url: url.toString(),
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "User-Agent": this.#userAgent },
      ...(init.body !== undefined && { body: init.body }),
      schema,
      fail: (failure) => this.#error(failure, method, path),
    });
  }

  async #error(failure: RequestFailure, method: string, path: string): Promise<OpsCrewError> {
    const { idempotent } = failure;
    switch (failure.kind) {
      case "unreachable":
        return new OpsCrewError(
          "PROVIDER_ERROR",
          failure.timedOut
            ? `The DigitalOcean API did not answer within ${duration(this.#http.timeoutMs)} (${method} ${path}).`
            : `Could not reach the DigitalOcean API (${method} ${path}).`,
          {
            hint: idempotent
              ? "Check your network connection and try again; see https://status.digitalocean.com/ if it keeps happening."
              : MAYBE_DONE_HINT,
            cause: failure.cause,
          },
        );
      case "invalid-json":
        return new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean returned invalid JSON for ${path}.`,
          {
            hint: idempotent
              ? "Try again; see https://status.digitalocean.com/ if it keeps happening."
              : MAYBE_DONE_HINT,
          },
        );
      case "unexpected":
        return new OpsCrewError(
          "PROVIDER_ERROR",
          `DigitalOcean returned an unexpected response for ${path}: ${failure.issues}`,
          {
            hint: idempotent
              ? "The DigitalOcean API may have changed; please report this to OpsCrew."
              : `${MAYBE_DONE_HINT} The DigitalOcean API may have changed; please report this to OpsCrew.`,
          },
        );
      case "status":
        return this.#statusError(failure.response, `${method} ${path}`, idempotent);
    }
  }

  async #statusError(
    response: Response,
    request: string,
    idempotent: boolean,
  ): Promise<OpsCrewError> {
    let apiMessage: string | undefined;
    try {
      const parsed = errorBodySchema.safeParse(await response.json());
      if (parsed.success) apiMessage = parsed.data.message ?? parsed.data.id;
    } catch {
      // Body was not JSON; fall back to the status text.
    }
    // The API should never echo the token; make sure it cannot reach a message anyway.
    const detail = (apiMessage ?? (response.statusText || `HTTP ${response.status}`))
      .split(this.#token)
      .join("[REDACTED]");
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

function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const value = Math.round(ms / 100) / 10;
  return `${value} second${value === 1 ? "" : "s"}`;
}
