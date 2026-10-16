import { type FakeCall, type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { PORKBUN_API } from "./client";

/** One canned answer of the fake Porkbun API (`error` simulates a network failure). */
export type FakeRoute = FakeReply;

/**
 * Core's fake fetch for the Porkbun API: routes by `"METHOD /path"` prefix (longest wins), records
 * every call (with its JSON body), and serves each route's queue in order (the last repeats).
 */
export function fakePorkbun(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const fake = fakeFetch(routes, { base: PORKBUN_API });
  return {
    fetch: fake.fetch,
    calls: fake.calls as (FakeCall & { body: Record<string, unknown> | undefined })[],
  };
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

/** An availability item of a check answer. */
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
