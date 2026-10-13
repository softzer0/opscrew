import type { FetchLike } from "@opscrew/contracts";

/** One canned answer of the fake Porkbun API. `throws` simulates a network failure. */
export interface FakeRoute {
  status?: number;
  body?: unknown;
  /** Raw body text (for unreadable answers); wins over `body`. */
  text?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

/** A request the fake API received. */
export interface FakeCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const BASE = "https://api.porkbun.com/api/json/v3";

/**
 * Fake fetch for the Porkbun API: routes by `"METHOD /path"` prefix (longest wins), records every
 * call, and serves each route's queue in order (the last answer repeats).
 */
export function fakePorkbun(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    calls.push({ method, url, path, headers, body });
    const target = `${method} ${path}`;
    const key = Object.keys(routes)
      .filter((k) => target.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unrouted ${target}`);
    const entry = routes[key];
    const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!route) throw new Error(`empty route ${key}`);
    if (route.throws) throw route.throws;
    return new Response(route.text ?? JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

/** A Porkbun success answer. */
export const ok = (fields: Record<string, unknown> = {}): FakeRoute => ({
  body: { status: "SUCCESS", requestId: "req-ok", ...fields },
});

/** A Porkbun error answer. */
export const err = (
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): FakeRoute => ({
  status,
  body: { status: "ERROR", code, message, requestId: "req-err-1", ...extra },
});

/** A single-check `response` item. */
export function availability(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    avail: "yes",
    type: "registration",
    price: "9.73",
    regularPrice: "9.73",
    premium: "no",
    minDuration: 1,
    additional: { renewal: { type: "renewal", price: "10.37" } },
    ...fields,
  };
}

export const noSleep = async (_ms: number) => {};
