import type { FetchLike } from "@opscrew/contracts";
import type { z } from "zod";

/** Longest wait after a 429, whatever the provider's `RateLimit-Reset` says. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

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
  fetch: FetchLike;
  /** Every attempt of every request gets its own timeout of this many milliseconds. */
  timeoutMs: number;
  retry: RetryRules;
  sleep(ms: number): Promise<void>;
  /** Epoch milliseconds, to turn `RateLimit-Reset` into a wait. */
  now(): number;
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
 * Every other failure throws what `request.fail` returns.
 */
export async function requestJson<S extends z.ZodType>(
  client: JsonClient,
  request: JsonRequest<S>,
): Promise<z.infer<S>> {
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
      response = await client.fetch(request.url, { ...init, signal });
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
      json = JSON.parse(text);
    } catch (cause) {
      throw await request.fail({ kind: "invalid-json", idempotent, cause });
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw await request.fail({ kind: "unexpected", issues, idempotent });
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
