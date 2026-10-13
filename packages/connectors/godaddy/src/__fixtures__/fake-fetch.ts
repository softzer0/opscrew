import type { FetchLike } from "@opscrew/contracts";

/** One fake answer: a JSON body (or raw text), a status and headers. */
export interface FakeRoute {
  status?: number;
  body?: unknown;
  /** Raw response text instead of JSON (for unreadable answers). */
  text?: string;
  headers?: Record<string, string>;
  /** Throw this instead of answering (a network failure). */
  error?: Error;
}

/** A request the fake fetch received. */
export interface FakeCall {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Fake fetch for the GoDaddy API: routes by `"METHOD /path"` prefix (query included, longest
 * match wins). A route may be a queue: each call takes the next entry and the last one repeats.
 */
export function fakeFetch(routes: Record<string, FakeRoute | FakeRoute[]>, base = "https://api.godaddy.com") {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, url, headers, body });
    const target = `${method} ${path}`;
    const key = Object.keys(routes)
      .filter((k) => target.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unrouted ${target}`);
    const entry = routes[key];
    const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!route) throw new Error(`empty route ${key}`);
    if (route.error) throw route.error;
    const text = route.text ?? (route.body === undefined ? "" : JSON.stringify(route.body));
    return new Response(route.status === 204 ? null : text, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

/** A GoDaddy error body. */
export function gdError(name: string, extra: Record<string, unknown> = {}): unknown {
  return { name, correlationId: "00000000-0000-4000-8000-000000000000", message: name, ...extra };
}

/** Money in GoDaddy's minor units. */
export function usd(cents: number): { currencyCode: string; value: number } {
  return { currencyCode: "USD", value: cents };
}

export const noSleep = async (): Promise<void> => {};

/** Every text an error exposes (message, hint, name, cause chain, own properties, stack). */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (current instanceof Error) {
      parts.push(current.message, current.stack ?? "", current.name);
      const own = current as unknown as Record<string, unknown>;
      for (const key of Object.keys(own)) parts.push(`${key}=${safeString(own[key])}`);
      current = current.cause;
    } else {
      parts.push(safeString(current));
      break;
    }
  }
  return parts.join("\n");
}

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
