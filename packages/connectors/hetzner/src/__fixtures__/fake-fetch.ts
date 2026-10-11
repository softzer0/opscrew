import { readFileSync } from "node:fs";

/** Reads a JSON fixture from this directory. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: URL;
  headers: Record<string, string>;
}

/**
 * Fake `fetch` keyed by `<pathname>` or `<pathname>?page=<n>` (most specific wins). Each key maps
 * to a list of replies consumed in order; the last reply repeats.
 */
export function fakeFetch(routes: Record<string, FakeReply | FakeReply[]>) {
  const calls: RecordedCall[] = [];
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const path = url.pathname.replace(/^\/v1/, "");
    const page = url.searchParams.get("page");
    const queue =
      (page !== null ? queues.get(`${path}?page=${page}`) : undefined) ?? queues.get(path);
    if (queue === undefined || queue.length === 0) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), {
        status: 404,
      });
    }
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as FakeReply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json", ...reply.headers },
    });
  };
  return { fetch, calls };
}

/** Records requested sleeps without waiting. */
export function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}
