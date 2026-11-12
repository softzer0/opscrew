import { randomUUID } from "node:crypto";
import type { FetchLike, ProviderRedactor } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  durationText,
  type JsonClient,
  jsonClient,
  listText,
  OpsCrewError,
  pollAction,
  RATE_LIMIT_HINT,
  type RequestFailure,
  requestJson,
} from "@opscrew/core";
import { z } from "zod";

/** Contabo's API. */
export const CONTABO_API_URL = "https://api.contabo.com";
/** Contabo's login (Keycloak): an OAuth2 password grant. */
export const CONTABO_AUTH_URL =
  "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
/** Where the API credentials are created: Customer Control Panel → Account → Security. */
export const CONTABO_CREDENTIALS_URL = "https://new.contabo.com/account/security";
/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Page size of the list calls. */
const PAGE_SIZE = 100;
/** Default time one HTTP request may take before it counts as failed (and a read is retried). */
const REQUEST_TIMEOUT_MS = 30_000;
/** A token is renewed this long before Contabo says it expires, so none expires in flight. */
const TOKEN_MARGIN_MS = 30_000;
const STATUS_INTERVAL_MS = 5_000;

/** The four environment variables of Contabo's API credentials, all needed. */
export const CONTABO_ENV = {
  clientId: "CNTB_OAUTH2_CLIENT_ID",
  clientSecret: "CNTB_OAUTH2_CLIENT_SECRET",
  user: "CNTB_OAUTH2_USER",
  password: "CNTB_OAUTH2_PASS",
} as const;

/** How to create the credentials and where they go. */
export const CONTABO_CREDENTIALS_HINT = `Create the API credentials in Contabo's Customer Control Panel (Account → Security, ${CONTABO_CREDENTIALS_URL}) and set ${listText(Object.values(CONTABO_ENV))}.`;

/** Contabo's refusal of a snapshot names its limit (the wording is not documented). */
const SNAPSHOT_LIMIT = /limit|maximum/i;

/** The next step when Contabo refuses a snapshot at the plan's limit. */
const SNAPSHOT_LIMIT_HINT =
  "Contabo counts every snapshot on the server, including ones taken by hand: delete one first (`opscrew snapshot list` shows OpsCrew's, `opscrew snapshot delete <id>` deletes one, and one taken by hand goes in Contabo's Customer Control Panel), then try again.";

/** Contabo's API credentials: an OAuth2 client and the account's API user. */
export interface ContaboCredentials {
  clientId: string;
  clientSecret: string;
  /** The API user: the account's login email. */
  user: string;
  /** The API password. */
  password: string;
}

/**
 * The four credentials from `env`, each registered with `redactor` as soon as it is read, or the
 * names of those that are missing (empty or blank).
 */
export function readContaboCredentials(
  env: Record<string, string | undefined>,
  redactor: ProviderRedactor,
): { credentials?: ContaboCredentials; missing: string[] } {
  const values: Partial<ContaboCredentials> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(CONTABO_ENV) as [keyof ContaboCredentials, string][]) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
      continue;
    }
    redactor.addLiteral(value, name);
    values[key] = value;
  }
  return missing.length > 0 ? { missing } : { credentials: values as ContaboCredentials, missing };
}

// --- Answer schemas (unknown fields are kept) -------------------------------------------------

const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  /** Seconds. */
  expires_in: z.number().positive(),
});

const tokenErrorSchema = z.looseObject({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const errorBodySchema = z.looseObject({
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

const paginationSchema = z.looseObject({ page: z.number(), totalPages: z.number() });

const instanceSchema = z.looseObject({
  instanceId: z.number(),
  /** Contabo's own name, for example `vmi123456`. */
  name: z.string(),
  /** The name the customer chose; empty when none was set. */
  displayName: z.string().nullable().optional(),
  status: z.string(),
  /** The day a cancelled instance's contract ends (`2026-12-10`); empty while not cancelled. */
  cancelDate: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});
/** A Contabo compute instance, as its API answers it. */
export type ContaboInstance = z.infer<typeof instanceSchema>;

const snapshotSchema = z.looseObject({
  snapshotId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  instanceId: z.number(),
  /** ISO 8601. */
  createdDate: z.string(),
});
/** A snapshot of an instance, as Contabo's API answers it. */
type ContaboSnapshot = z.infer<typeof snapshotSchema>;

const idSchema = z.union([z.number(), z.string()]).transform(String);

const tagSchema = z.looseObject({ tagId: idSchema, name: z.string() });
/** A tag, as Contabo's API answers it. */
type ContaboTag = z.infer<typeof tagSchema>;

const assignmentSchema = z.looseObject({ resourceType: z.string(), resourceId: idSchema });
/** A resource a tag is assigned to, as Contabo's API answers it. */
type ContaboTagAssignment = z.infer<typeof assignmentSchema>;

/**
 * A list, which Contabo may also answer JSON-encoded in a string: it does so for the `instances`
 * of a firewall that protects a server (research R6).
 */
function listOrEncoded<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? parseJson(value) : value),
    z.array(item),
  );
}

const firewallRuleSchema = z.looseObject({
  /** `tcp`, `udp`, `icmp`, or empty for every protocol. */
  protocol: z.string(),
  destPorts: z.array(z.string()),
  /** An empty list means any source of that family. */
  srcCidr: z.looseObject({ ipv4: z.array(z.string()), ipv6: z.array(z.string()) }),
  /** `accept`; Contabo's own rule, appended to every firewall, is the only `drop`. */
  action: z.string(),
  status: z.string(),
});
/** An inbound rule of a firewall, as Contabo's API answers it. */
export type ContaboFirewallRule = z.infer<typeof firewallRuleSchema>;

const firewallSchema = z.looseObject({
  /** A UUID. */
  firewallId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  /** `active`, or `inactive`, when it filters nothing. */
  status: z.string(),
  /** The ids of the instances it protects: objects, numbers, or either JSON-encoded. */
  instances: listOrEncoded(
    z
      .union([z.number(), z.looseObject({ instanceId: z.number() })])
      .transform((instance) =>
        String(typeof instance === "number" ? instance : instance.instanceId),
      ),
  ),
  /** Per instance: `ok` once protected, `processing`, `deleting`, or `error_…`. */
  instanceStatus: listOrEncoded(
    z.looseObject({
      instanceId: idSchema,
      status: z.string(),
      errorMessage: z.string().nullable().optional(),
    }),
  ),
  rules: z.looseObject({ inbound: z.array(firewallRuleSchema) }),
});
/** A firewall, as Contabo's API answers it, with its instances' ids as strings. */
export type ContaboFirewall = z.infer<typeof firewallSchema>;

/** An inbound rule as OpsCrew writes it: it accepts, and each source list holds a network. */
export interface FirewallRuleRequest {
  protocol: "tcp" | "udp" | "icmp";
  destPorts: readonly string[];
  srcCidr: { ipv4: readonly string[]; ipv6: readonly string[] };
  action: "accept";
  status: "active";
}

/** The next step when a firewall does not protect a server. */
const FIREWALL_HINT = "Check the firewall and the server in Contabo's Customer Control Panel.";

/** An answer whose content OpsCrew does not use: it only has to be a JSON object. */
const acknowledged = z.looseObject({});

// --- Client -------------------------------------------------------------------------------------

export interface ContaboClientOptions {
  credentials: ContaboCredentials;
  /** Masks the credentials (and the access tokens, registered as they come) in every error. */
  redactor: ProviderRedactor;
  fetch?: FetchLike;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay used between retries and polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for the token's expiry and the waits. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 30 seconds). */
  timeoutMs?: number;
}

/** Thrown inside a request whose token Contabo refused, so that it is renewed and sent again. */
const TOKEN_REFUSED = new Error("Contabo refused the access token.");

/**
 * Typed client for Contabo's API: logs in with an OAuth2 password grant, keeps the access token
 * until it expires, and sends an `x-request-id` with every call. Every answer is validated.
 * A request Contabo answers with 401 is sent once more with a new token (a 401 means Contabo did
 * nothing). Otherwise only reads are repeated (after a 5xx, a timeout or a lost connection), and
 * any request answered with 429; a write that got no answer is never sent twice. The client never
 * creates instances: servers are created through the IaC engine.
 */
export class ContaboClient {
  readonly #credentials: ContaboCredentials;
  readonly #redactor: ProviderRedactor;
  readonly #userAgent: string;
  readonly #http: JsonClient;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(options: ContaboClientOptions) {
    this.#credentials = options.credentials;
    this.#redactor = options.redactor;
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

  /** Checks the credentials: a token, then one page of one instance. */
  async verify(): Promise<void> {
    await this.#request(
      "GET",
      "/v1/compute/instances",
      z.looseObject({ data: z.array(z.unknown()) }),
      {
        query: { page: "1", size: "1" },
      },
    );
  }

  /** Every instance of the account (`GET /v1/compute/instances`, every page). */
  listInstances(): Promise<ContaboInstance[]> {
    return this.#listAll("/v1/compute/instances", instanceSchema);
  }

  /** One instance (`GET /v1/compute/instances/{id}`). */
  async getInstance(instanceId: number): Promise<ContaboInstance> {
    const body = await this.#request(
      "GET",
      `/v1/compute/instances/${instanceId}`,
      z.looseObject({ data: z.array(instanceSchema).length(1) }),
    );
    return body.data[0] as ContaboInstance;
  }

  /** Every tag of the account, every page. */
  listTags(): Promise<ContaboTag[]> {
    return this.#listAll("/v1/tags", tagSchema);
  }

  /** The resources tag `tagId` is assigned to, every page. */
  listTagAssignments(tagId: string): Promise<ContaboTagAssignment[]> {
    return this.#listAll(`/v1/tags/${encodeURIComponent(tagId)}/assignments`, assignmentSchema);
  }

  /** An instance's snapshots, every page. */
  listSnapshots(instanceId: number): Promise<ContaboSnapshot[]> {
    return this.#listAll(`/v1/compute/instances/${instanceId}/snapshots`, snapshotSchema);
  }

  /**
   * Snapshots an instance (`POST …/snapshots`; Contabo allows a name of up to 30 characters and a
   * description of up to 255). Contabo answers with the snapshot. A refusal that names the
   * snapshot limit says how to make room.
   */
  async createSnapshot(
    instanceId: number,
    snapshot: { name: string; description: string },
  ): Promise<ContaboSnapshot> {
    const body = await this.#request(
      "POST",
      `/v1/compute/instances/${instanceId}/snapshots`,
      z.looseObject({ data: z.array(snapshotSchema).length(1) }),
      { body: snapshot },
    );
    return body.data[0] as ContaboSnapshot;
  }

  /** Deletes a snapshot (`DELETE …/snapshots/{id}`; Contabo answers 204). */
  async deleteSnapshot(instanceId: number, snapshotId: string): Promise<void> {
    await this.#request(
      "DELETE",
      `/v1/compute/instances/${instanceId}/snapshots/${encodeURIComponent(snapshotId)}`,
      z.undefined(),
    );
  }

  /**
   * Reverts an instance to a snapshot (`POST …/snapshots/{id}/rollback`). Contabo deletes the
   * instance's newer snapshots.
   */
  async rollbackSnapshot(instanceId: number, snapshotId: string): Promise<void> {
    await this.#request(
      "POST",
      `/v1/compute/instances/${instanceId}/snapshots/${encodeURIComponent(snapshotId)}/rollback`,
      acknowledged,
      { body: {} },
    );
  }

  /**
   * Starts an instance action: `shutdown` (a graceful shutdown) or `start`. Contabo's answer only
   * says the request was taken: wait with {@link waitForStatus}.
   */
  async instanceAction(instanceId: number, action: "shutdown" | "start"): Promise<void> {
    await this.#request(
      "POST",
      `/v1/compute/instances/${instanceId}/actions/${action}`,
      acknowledged,
    );
  }

  /**
   * Reads the instance every 5 seconds until its status is `status`. An instance in `error`, and
   * one in another status after `timeoutMs`, throw `PROVIDER_ERROR` naming its status.
   */
  waitForStatus(
    instanceId: number,
    status: string,
    options: { timeoutMs: number },
  ): Promise<ContaboInstance> {
    return pollAction({
      read: () => this.getInstance(instanceId),
      finished: (instance) => {
        if (instance.status === "error" && status !== "error") {
          const detail = instance.errorMessage ? `: ${instance.errorMessage}` : ".";
          throw this.#failure(
            "PROVIDER_ERROR",
            `Contabo instance ${instanceId} is in error${detail}`,
            {
              hint: "Check the instance in Contabo's Customer Control Panel.",
            },
          );
        }
        return instance.status === status;
      },
      timedOut: (instance) =>
        this.#failure(
          "PROVIDER_ERROR",
          `Contabo instance ${instanceId} was not ${status} within ${durationText(options.timeoutMs)}: it is ${instance.status}.`,
          { hint: "Check the instance in Contabo's Customer Control Panel." },
        ),
      timeoutMs: options.timeoutMs,
      intervalMs: STATUS_INTERVAL_MS,
      sleep: this.#http.sleep,
      now: this.#http.now,
    });
  }

  /**
   * The firewalls whose name contains `name` (`GET /v1/firewalls?name=`, every page): Contabo's
   * filter matches substrings, so the caller compares the exact name.
   */
  listFirewalls(name: string): Promise<ContaboFirewall[]> {
    return this.#listAll("/v1/firewalls", firewallSchema, { name });
  }

  /** One firewall (`GET /v1/firewalls/{id}`). */
  async getFirewall(firewallId: string): Promise<ContaboFirewall> {
    const body = await this.#request(
      "GET",
      `/v1/firewalls/${encodeURIComponent(firewallId)}`,
      z.looseObject({ data: z.array(firewallSchema).length(1) }),
    );
    return body.data[0] as ContaboFirewall;
  }

  /**
   * Creates a firewall with its inbound rules (`POST /v1/firewalls`). Contabo answers with it,
   * its own "Block all traffic" rule appended.
   */
  async createFirewall(firewall: {
    name: string;
    description: string;
    status: "active";
    rules: { inbound: readonly FirewallRuleRequest[] };
  }): Promise<ContaboFirewall> {
    const body = await this.#request(
      "POST",
      "/v1/firewalls",
      z.looseObject({ data: z.array(firewallSchema).length(1) }),
      { body: firewall },
    );
    return body.data[0] as ContaboFirewall;
  }

  /** Sets a firewall's inbound rules (`PUT /v1/firewalls/{id}`); Contabo keeps its own rule. */
  async setFirewallRules(
    firewallId: string,
    inbound: readonly FirewallRuleRequest[],
  ): Promise<void> {
    await this.#request("PUT", `/v1/firewalls/${encodeURIComponent(firewallId)}`, acknowledged, {
      body: { rules: { inbound } },
    });
  }

  /** Sets a firewall's description and status (`PATCH /v1/firewalls/{id}`). */
  async updateFirewall(
    firewallId: string,
    fields: { description: string; status: "active" },
  ): Promise<void> {
    await this.#request("PATCH", `/v1/firewalls/${encodeURIComponent(firewallId)}`, acknowledged, {
      body: fields,
    });
  }

  /** Adds an instance to a firewall (`POST /v1/firewalls/{id}/instances/{instanceId}`). */
  async assignFirewall(firewallId: string, instanceId: number): Promise<void> {
    await this.#request(
      "POST",
      `/v1/firewalls/${encodeURIComponent(firewallId)}/instances/${instanceId}`,
      acknowledged,
    );
  }

  /** Removes an instance from a firewall (`DELETE /v1/firewalls/{id}/instances/{instanceId}`). */
  async unassignFirewall(firewallId: string, instanceId: number): Promise<void> {
    await this.#request(
      "DELETE",
      `/v1/firewalls/${encodeURIComponent(firewallId)}/instances/${instanceId}`,
      acknowledged,
    );
  }

  /** Deletes a firewall (`DELETE /v1/firewalls/{id}`; Contabo answers 204). */
  async deleteFirewall(firewallId: string): Promise<void> {
    await this.#request("DELETE", `/v1/firewalls/${encodeURIComponent(firewallId)}`, z.undefined());
  }

  /**
   * Reads the firewall every 5 seconds until it protects each of `instanceIds` (its
   * `instanceStatus` is `ok`). An instance in an `error_…` status, and one not protected after
   * `timeoutMs`, throw `PROVIDER_ERROR` naming it and its status.
   */
  waitForFirewall(
    firewallId: string,
    instanceIds: readonly string[],
    options: { timeoutMs: number },
  ): Promise<ContaboFirewall> {
    const status = (firewall: ContaboFirewall, id: string) =>
      firewall.instanceStatus.find((entry) => entry.instanceId === id);
    return pollAction({
      read: () => this.getFirewall(firewallId),
      finished: (firewall) => {
        for (const id of instanceIds) {
          const entry = status(firewall, id);
          if (entry?.status.startsWith("error") !== true) continue;
          const detail = entry.errorMessage ? `: ${entry.errorMessage}` : ".";
          throw this.#failure(
            "PROVIDER_ERROR",
            `Contabo's firewall ${firewall.name} could not protect server ${id} (${entry.status})${detail}`,
            { hint: FIREWALL_HINT },
          );
        }
        return instanceIds.every((id) => status(firewall, id)?.status === "ok");
      },
      timedOut: (firewall) => {
        const waiting = instanceIds
          .filter((id) => status(firewall, id)?.status !== "ok")
          .map((id) => `server ${id} (${status(firewall, id)?.status ?? "not listed"})`);
        return this.#failure(
          "PROVIDER_ERROR",
          `Contabo's firewall ${firewall.name} did not protect ${listText(waiting)} within ${durationText(options.timeoutMs)}.`,
          { hint: FIREWALL_HINT },
        );
      },
      timeoutMs: options.timeoutMs,
      intervalMs: STATUS_INTERVAL_MS,
      sleep: this.#http.sleep,
      now: this.#http.now,
    });
  }

  async #listAll<T>(
    path: string,
    item: z.ZodType<T>,
    filter: Record<string, string> = {},
  ): Promise<T[]> {
    const schema = z.looseObject({ data: z.array(item), _pagination: paginationSchema });
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const body = await this.#request("GET", path, schema, {
        query: { page: String(page), size: String(PAGE_SIZE), ...filter },
      });
      out.push(...body.data);
      if (page >= body._pagination.totalPages) return out;
    }
  }

  async #request<S extends z.ZodType>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    schema: S,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    for (let renewed = false; ; renewed = true) {
      const token = await this.#accessToken(renewed);
      try {
        return await requestJson(this.#http, {
          url: `${CONTABO_API_URL}${path}`,
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "x-request-id": randomUUID(),
            "User-Agent": this.#userAgent,
          },
          ...(options.query !== undefined && { query: options.query }),
          ...(options.body !== undefined && { body: options.body }),
          schema,
          fail: (failure) =>
            failure.kind === "status" && failure.response.status === 401 && !renewed
              ? TOKEN_REFUSED
              : this.#error(failure, method, path),
        });
      } catch (error) {
        if (error !== TOKEN_REFUSED) throw error;
      }
    }
  }

  /** The cached access token, or a new one when it has expired or `renew` is set. */
  async #accessToken(renew: boolean): Promise<string> {
    if (!renew && this.#token !== undefined && this.#http.now() < this.#token.expiresAt) {
      return this.#token.value;
    }
    this.#token = undefined;
    const answer = await this.#login();
    this.#redactor.addLiteral(answer.access_token, "Contabo access token");
    this.#token = {
      value: answer.access_token,
      expiresAt: this.#http.now() + answer.expires_in * 1000 - TOKEN_MARGIN_MS,
    };
    return this.#token.value;
  }

  /** The OAuth2 password grant against Contabo's Keycloak. */
  async #login(): Promise<z.infer<typeof tokenSchema>> {
    const { clientId, clientSecret, user, password } = this.#credentials;
    const form = new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
      username: user,
      password,
    });
    let response: Response;
    let text: string;
    try {
      response = await this.#http.fetch(CONTABO_AUTH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.#userAgent,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.#http.timeoutMs),
      });
      text = await response.text();
    } catch (cause) {
      throw this.#failure("PROVIDER_ERROR", "Could not reach Contabo's login (auth.contabo.com).", {
        hint: CONNECTION_HINT,
        cause,
      });
    }
    const json = parseJson(text);
    if (!response.ok) {
      const body = tokenErrorSchema.safeParse(json);
      const detail =
        (body.success && (body.data.error_description ?? body.data.error)) ||
        response.statusText ||
        `HTTP ${response.status}`;
      if (response.status === 400 || response.status === 401) {
        throw this.#failure(
          "CREDENTIALS_INVALID",
          `Contabo refused the API credentials: ${detail}`,
          {
            hint: CONTABO_CREDENTIALS_HINT,
          },
        );
      }
      throw this.#failure(
        "PROVIDER_ERROR",
        `Contabo's login failed (HTTP ${response.status}): ${detail}`,
        { hint: statusHint(response.status) },
      );
    }
    const parsed = tokenSchema.safeParse(json);
    if (!parsed.success) {
      throw this.#failure("PROVIDER_ERROR", "Contabo's login answered without an access token.", {
        hint: "Contabo's login may have changed; please report this to OpsCrew.",
      });
    }
    return parsed.data;
  }

  async #error(failure: RequestFailure, method: string, path: string): Promise<OpsCrewError> {
    switch (failure.kind) {
      case "unreachable": {
        const { timedOut, cause } = failure;
        const what = timedOut
          ? `Contabo's API did not answer within ${durationText(this.#http.timeoutMs)}`
          : "Lost the connection to Contabo's API";
        if (!failure.idempotent) {
          return this.#failure("PROVIDER_ERROR", `${what} (${method} ${path}).`, {
            hint: "The change may still have been made: check the Customer Control Panel before trying again.",
            cause,
          });
        }
        return this.#failure("PROVIDER_ERROR", `${what} (${path}).`, {
          hint: timedOut ? "Try again in a few minutes." : CONNECTION_HINT,
          cause,
        });
      }
      case "invalid-json":
        return this.#failure("PROVIDER_ERROR", `Contabo returned invalid JSON for ${path}.`, {
          cause: failure.cause,
        });
      case "unexpected":
        return this.#failure(
          "PROVIDER_ERROR",
          `Contabo returned an unexpected answer for ${path}: ${failure.issues}`,
          { hint: "Contabo's API may have changed; please report this to OpsCrew." },
        );
      case "status":
        return this.#statusError(failure.response, method, path);
    }
  }

  async #statusError(response: Response, method: string, path: string): Promise<OpsCrewError> {
    const { status } = response;
    const body = errorBodySchema.safeParse(parseJson(await response.text().catch(() => "")));
    const message = body.success ? body.data.message : undefined;
    const detail =
      (Array.isArray(message) ? message.join("; ") : message) ||
      response.statusText ||
      `HTTP ${status}`;
    const request = `${method} ${path}`;
    switch (status) {
      case 401:
      case 403:
        return this.#failure(
          "CREDENTIALS_INVALID",
          `Contabo refused the API credentials (HTTP ${status}, ${request}): ${detail}`,
          {
            hint:
              status === 401
                ? CONTABO_CREDENTIALS_HINT
                : "Check in Contabo's Customer Control Panel that the API user may manage compute instances, snapshots, tags and firewalls, then try again.",
          },
        );
      case 402:
        return this.#failure(
          "PROVIDER_ERROR",
          `Contabo needs a paid service for this (HTTP 402, ${request}): ${detail}`,
          {
            hint: "Order or pay for the service in Contabo's Customer Control Panel, then try again.",
          },
        );
      case 429:
        return this.#failure(
          "PROVIDER_ERROR",
          `Contabo's rate limit was reached (${request}): ${detail}`,
          {
            hint: RATE_LIMIT_HINT,
          },
        );
      default: {
        const snapshotLimit =
          status < 500 &&
          method === "POST" &&
          path.endsWith("/snapshots") &&
          SNAPSHOT_LIMIT.test(detail);
        return this.#failure(
          "PROVIDER_ERROR",
          `Contabo answered HTTP ${status} to ${request}: ${detail}`,
          { hint: snapshotLimit ? SNAPSHOT_LIMIT_HINT : statusHint(status) },
        );
      }
    }
  }

  /** An `OpsCrewError` with its message and hint passed through the redactor. */
  #failure(
    code: OpsCrewError["code"],
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ): OpsCrewError {
    return new OpsCrewError(code, this.#redactor.redact(message), {
      ...(options.hint !== undefined && { hint: this.#redactor.redact(options.hint) }),
      ...(options.cause !== undefined && { cause: options.cause }),
    });
  }
}

/** The next step after Contabo answered with an error `status`. */
function statusHint(status: number): string {
  switch (status) {
    case 404:
      return "It may have been cancelled or removed: check the Customer Control Panel and use an id that exists there.";
    case 409:
      return "It conflicts with the instance's current state or another change still running: check the instance in the Customer Control Panel, wait until it is done, then try again.";
    case 400:
    case 422:
      return "Contabo refused the request as sent: fix what it named above, then try again.";
    case 429:
      return RATE_LIMIT_HINT;
    default:
      return status >= 500
        ? "Contabo failed on its side: try again in a few minutes, and contact Contabo's support if it keeps failing."
        : "Check the Customer Control Panel, then try again.";
  }
}

/** `text` parsed as JSON, or `undefined` when it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
