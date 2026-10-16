import type { FetchLike } from "@opscrew/contracts";

/** One answer of {@link fakeFetch}. */
export interface FakeReply {
  /** Default 200. */
  status?: number;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is instead of `body` (an answer that is not JSON, or XML). */
  text?: string;
  /** Added to `content-type: application/json`. */
  headers?: Record<string, string>;
  /** Thrown instead of answering: a lost connection. */
  error?: Error;
  /** Never answers: the request ends only when its signal aborts (a timeout). */
  hang?: boolean;
}

/** A request {@link fakeFetch} received. */
export interface FakeCall {
  method: string;
  url: string;
  /** The URL without `base`: path and query. */
  path: string;
  headers: Record<string, string>;
  /** The request body, parsed when it is JSON. */
  body: unknown;
}

/**
 * Fake `fetch` for HTTP client tests. `routes` maps `"METHOD /path?query"` or `"/path?query"` (any
 * method) to a reply or a queue of replies: each request takes the next one and the last one
 * repeats. Keys match as prefixes of the method and the URL without `base`, and the longest
 * matching key wins, so `"/"` answers every request no other key matches. An unrouted request
 * throws. Like `fetch`, it rejects with the signal's reason once `init.signal` aborts.
 */
export function fakeFetch(
  routes: Record<string, FakeReply | FakeReply[]>,
  options: { base?: string } = {},
): { fetch: FetchLike; calls: FakeCall[] } {
  const base = options.base ?? "";
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    calls.push({
      method,
      url,
      path,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? parseBody(init.body) : undefined,
    });
    const key = [...queues.keys()]
      .filter((k) => `${method} ${path}`.startsWith(k) || path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const queue = key === undefined ? undefined : queues.get(key);
    const reply = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error(`fakeFetch: no route for ${method} ${path}`);

    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    if (reply.error) throw reply.error;
    if (reply.hang) {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(status === 204 ? null : text, {
      status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, calls };
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
