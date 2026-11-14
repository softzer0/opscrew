import type { FetchLike } from "@opscrew/contracts";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { CLOUDFLARE_API } from "../client";

/** Cloudflare's envelope around a successful `result`. */
export const ok = (result: unknown): FakeReply => ({
  body: { success: true, errors: [], messages: [], result },
});

/** Cloudflare's envelope around a refusal with one error. */
export const refuse = (status: number, code: number, message: string): FakeReply => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

/** One page of `items` as Cloudflare lists them: `page` and `per_page` read, `result_info` set. */
export function paged(items: readonly unknown[], url: URL, perPage: number): FakeReply {
  const page = Number(url.searchParams.get("page") ?? 1);
  const size = Number(url.searchParams.get("per_page") ?? perPage);
  const result = items.slice((page - 1) * size, page * size);
  return {
    body: {
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: {
        page,
        per_page: size,
        count: result.length,
        total_count: items.length,
        total_pages: Math.max(1, Math.ceil(items.length / size)),
      },
    },
  };
}

/**
 * Throws for a query parameter the fake does not answer: a filter it ignored would list too
 * much, so the test stops instead (the client sees a failed request, with this error as its cause).
 */
export function only(url: URL, known: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!known.includes(key)) {
      throw new Error(`fake cloudflare: ${url.pathname} does not take the query parameter ${key}`);
    }
  }
}

/** `reply` sent the way core's `fakeFetch` sends it (a timeout and a lost connection included). */
export const answer = (reply: FakeReply, ...request: Parameters<FetchLike>) =>
  fakeFetch({ "/": reply }, { base: CLOUDFLARE_API }).fetch(...request);

/** A one-shot failure of the next request matching `"METHOD /path"` (prefix). */
export interface FakeFault {
  match: string;
  reply: FakeReply;
  /** Carry the request out first: the change reaches Cloudflare, but its answer is `reply`. */
  applied?: boolean;
}

/** The fault `faults` holds for the request, taken out of the list (undefined: none). */
export function takeFault(
  faults: FakeFault[],
  method: string,
  path: string,
): FakeFault | undefined {
  const at = faults.findIndex((f) => `${method} ${path}`.startsWith(f.match));
  return at === -1 ? undefined : faults.splice(at, 1)[0];
}
