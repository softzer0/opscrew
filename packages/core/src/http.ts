import type { FetchLike } from "@opscrew/contracts";
import type { z } from "zod";
import { OpsCrewError } from "./errors";
import type { Redactor } from "./redact";
import { durationText } from "./text";
import { realSleep } from "./time";
import { zodIssues } from "./values";

/** Longest wait after a 429, whatever the provider's `RateLimit-Reset` says. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** How long one request to a hosting panel may take unless its client is given another time. */
const PANEL_REQUEST_TIMEOUT_MS = 60_000;

/** The next step when a provider's API could not be reached. */
export const CONNECTION_HINT = "Check your internet connection and try again.";

/** The next step after a provider's rate limit stopped a request. */
export const RATE_LIMIT_HINT = "Wait a minute and try again.";

/** The next step after a provider failed on its side: try again, then look at its status page. */
export function statusPageHint(url: string): string {
  return `Try again in a minute; if it keeps failing, check ${url}.`;
}

/** The next step after a write got no clear answer from `where`: it may have been done. */
export function maybeDoneHint(where: string): string {
  return `The request may still have reached ${where}; check the current state before trying again.`;
}

/** The next step after `provider` answered in a shape OpsCrew doesn't know: report it. */
export function changedApiHint(provider: string): string {
  return `The ${provider} API may have changed; please report this to OpsCrew.`;
}

/**
 * `value` (a provider's answer) validated against `schema`. An answer that does not match throws
 * `PROVIDER_ERROR` naming its first problems, with `hint` as the next step (by default
 * {@link changedApiHint}).
 */
export function parseAnswer<S extends z.ZodType>(
  schema: S,
  value: unknown,
  provider: string,
  what: string,
  hint?: string,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${provider} returned an unexpected answer when trying to ${what}: ${zodIssues(parsed.error)}.`,
      { hint: hint ?? changedApiHint(provider) },
    );
  }
  return parsed.data;
}

/** What a hosting panel's client is given besides the account's access. */
export interface PanelClientOptions {
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Shared redactor; a private one is used when omitted. The token is always registered. */
  redactor?: Redactor;
  /** Per request (default 60 s). */
  timeoutMs?: number;
}

/**
 * The origin (`https://<host>:<port>`) of a hosting panel's address, which must be `https://` and
 * name nothing else: no login, path, query or fragment.
 * @throws OpsCrewError `INVALID_INPUT` naming `OPSCREW_HOSTING_URL`, with `example` as the
 * address to set (`https://panel.example.com:2083`).
 */
export function httpsOrigin(address: string, example: string): string {
  const url = URL.parse(address.trim());
  if (
    url?.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "OPSCREW_HOSTING_URL isn't a panel's https:// address.",
      {
        hint: `Set OPSCREW_HOSTING_URL to the panel's address alone, such as ${example}.`,
      },
    );
  }
  return url.origin;
}

/** How {@link fetchText} names a request that got no answer. */
export interface FetchTextOptions {
  /** Who was asked, to start the error: `cPanel`. */
  service: string;
  /** What the request does, to end "… when trying to <what>". */
  what: string;
  /** A change: a lost answer says it may have been made, instead of checking the connection. */
  write: boolean;
  /** For the request and reading its answer (default 60 s). */
  timeoutMs?: number | undefined;
}

/**
 * Sends one request with `fetch` (default: the global one) and reads its answer as text, within
 * the timeout. A timeout or a lost connection throws `PROVIDER_ERROR`, whose hint for a write is
 * {@link maybeDoneHint} and for a read {@link CONNECTION_HINT}.
 */
export async function fetchText(
  fetch: FetchLike | undefined,
  url: string,
  init: RequestInit,
  options: FetchTextOptions,
): Promise<{ status: number; ok: boolean; text: string }> {
  const timeoutMs = options.timeoutMs ?? PANEL_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await (fetch ?? globalThis.fetch)(url, { ...init, signal });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } catch {
    const { service, what } = options;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      signal.aborted
        ? `${service} did not answer within ${durationText(timeoutMs)} when trying to ${what}.`
        : `Could not reach ${service} at ${new URL(url).host} to ${what}.`,
      { hint: options.write ? maybeDoneHint(service) : CONNECTION_HINT },
    );
  }
}

/** How a JSON API client retries; see {@link requestJson}. */
export interface RetryRules {
  /** Retries of a `GET` after a 5xx, a timeout or a lost connection. */
  serverErrors: number;
  /** Wait before such retry number `attempt` (0-based). */
  serverErrorDelayMs(attempt: number): number;
  /** Retries of any request answered with 429: the provider did not accept it. */
  rateLimits: number;
  /** Wait before 429 retry number `attempt` (0-based) when the answer has no `RateLimit-Reset`. */
  rateLimitDelayMs(attempt: number): number;
}

/** What a JSON API client shares between its requests. */
export interface JsonClient {
  /**
   * The per-attempt timeout relies on this fetch honouring its `AbortSignal` (for the request and
   * for reading the body), as Node's `fetch` does.
   */
  fetch: FetchLike;
  /** Every attempt of every request gets its own timeout of this many milliseconds. */
  timeoutMs: number;
  retry: RetryRules;
  sleep(ms: number): Promise<void>;
  /** Epoch milliseconds, to turn `RateLimit-Reset` into a wait. */
  now(): number;
}

/** What a provider client's options may set of its {@link JsonClient}. */
export interface JsonClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch milliseconds. */
  now?: () => number;
}

/**
 * The {@link JsonClient} of a provider client: what `options` sets, else the provider's
 * `timeoutMs`, the global `fetch`, {@link realSleep} and `Date.now`. The retry rules are the
 * provider's.
 */
export function jsonClient(
  options: JsonClientOptions,
  provider: { timeoutMs: number; retry: RetryRules },
): JsonClient {
  return {
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    timeoutMs: options.timeoutMs ?? provider.timeoutMs,
    retry: provider.retry,
    sleep: options.sleep ?? realSleep,
    now: options.now ?? Date.now,
  };
}

/** Why a request failed, for the client to turn into its provider's plain-English error. */
export type RequestFailure =
  /** No answer after any retries: the attempt timed out (`timedOut`) or the connection was lost. */
  | { kind: "unreachable"; timedOut: boolean; idempotent: boolean; cause: unknown }
  /** The provider answered with an error status (after any retries); the body is not read yet. */
  | { kind: "status"; response: Response; idempotent: boolean }
  /** A success status whose body is not JSON. */
  | { kind: "invalid-json"; idempotent: boolean; cause: unknown }
  /** JSON that does not match the schema; `issues` names the first three problems. */
  | { kind: "unexpected"; issues: string; idempotent: boolean };

/** One request to a JSON API. */
export interface JsonRequest<S extends z.ZodType> {
  url: string;
  /** Query parameters added to `url`. */
  query?: Record<string, string>;
  /** Default `GET`. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as given, plus `Accept: application/json` (and `Content-Type` with a body). */
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /** The answer is validated against it. */
  schema: S;
  /** The error to throw for a failure. */
  fail(failure: RequestFailure): Error | Promise<Error>;
}

/**
 * Sends a request and returns its JSON answer validated against `request.schema`. Every attempt
 * has its own timeout. Only a `GET` is repeated after a 5xx, a timeout or a lost connection:
 * a write may already have been carried out, so it is never sent twice. Any request answered with
 * 429 is repeated (the provider did not accept it), after waiting until `RateLimit-Reset` (epoch
 * seconds) when the answer has one and otherwise `retry.rateLimitDelayMs`, never more than 60 s.
 * An empty success body (a 204) parses as `undefined`, for a `z.undefined()` schema. Every other
 * failure throws what `request.fail` returns.
 */
export async function requestJson<S extends z.ZodType>(
  client: JsonClient,
  request: JsonRequest<S>,
): Promise<z.infer<S>> {
  const url = new URL(request.url);
  for (const [name, value] of Object.entries(request.query ?? {}))
    url.searchParams.set(name, value);
  const method = request.method ?? "GET";
  const idempotent = method === "GET";
  const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = {
    method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  };

  let serverErrorRetries = 0;
  let rateLimitRetries = 0;
  for (;;) {
    const signal = AbortSignal.timeout(client.timeoutMs);
    let response: Response;
    let text: string | undefined;
    try {
      response = await client.fetch(url.toString(), { ...init, signal });
      if (response.ok) text = await response.text();
    } catch (cause) {
      if (idempotent && serverErrorRetries < client.retry.serverErrors) {
        await client.sleep(client.retry.serverErrorDelayMs(serverErrorRetries++));
        continue;
      }
      throw await request.fail({
        kind: "unreachable",
        timedOut: signal.aborted,
        idempotent,
        cause,
      });
    }

    if (response.status === 429 && rateLimitRetries < client.retry.rateLimits) {
      await client.sleep(rateLimitWait(client, response, rateLimitRetries++));
      continue;
    }
    if (idempotent && response.status >= 500 && serverErrorRetries < client.retry.serverErrors) {
      await client.sleep(client.retry.serverErrorDelayMs(serverErrorRetries++));
      continue;
    }
    if (text === undefined) throw await request.fail({ kind: "status", response, idempotent });

    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch (cause) {
      throw await request.fail({ kind: "invalid-json", idempotent, cause });
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw await request.fail({ kind: "unexpected", issues: zodIssues(parsed.error), idempotent });
    }
    return parsed.data;
  }
}

function rateLimitWait(client: JsonClient, response: Response, attempt: number): number {
  const reset = Number(response.headers.get("RateLimit-Reset"));
  const wait =
    Number.isFinite(reset) && reset > 0
      ? reset * 1000 - client.now()
      : client.retry.rateLimitDelayMs(attempt);
  return Math.min(Math.max(wait, 0), MAX_RATE_LIMIT_WAIT_MS);
}

/** How {@link pollAction} watches a long-running provider action. */
export interface PollActionOptions<T> {
  /** Reads the action's current state. */
  read(): Promise<T>;
  /** True once the action is done; throw here to stop with an error when it failed. */
  finished(action: T): boolean;
  /** The error for an action still running after `timeoutMs`. */
  timedOut(action: T): Error;
  timeoutMs: number;
  intervalMs: number;
  sleep(ms: number): Promise<void>;
  /** Epoch milliseconds. */
  now(): number;
}

/**
 * Reads the action every `intervalMs` until `finished` says it is done, and returns its last
 * state. Throws what `finished` throws, or `timedOut(action)` once `timeoutMs` have passed; the
 * last wait is shortened so the deadline is kept.
 */
export async function pollAction<T>(options: PollActionOptions<T>): Promise<T> {
  const start = options.now();
  for (;;) {
    const action = await options.read();
    if (options.finished(action)) return action;
    const elapsed = options.now() - start;
    if (elapsed >= options.timeoutMs) throw options.timedOut(action);
    await options.sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed));
  }
}
