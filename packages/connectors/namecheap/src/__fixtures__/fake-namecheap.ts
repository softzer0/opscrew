import { readFileSync } from "node:fs";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { NamecheapClient, type NamecheapClientOptions } from "../client";

/** A recorded Namecheap answer from `src/__fixtures__/`. */
export function fixture(name: string): string {
  return readFileSync(new URL(`./${name}.xml`, import.meta.url), "utf8");
}

/**
 * A route answer: XML text (HTTP 200), an HTTP status with a body, a network failure, or `hang`
 * (no answer until the request's signal aborts: a timeout).
 */
export type Route = string | { status: number; body: string } | Error | { hang: true };

export interface RecordedCall {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  body: string;
  params: URLSearchParams;
  /** The command without the `namecheap.` prefix. */
  command: string;
}

/**
 * Fake fetch routing by `Command` (without `namecheap.`), or `Command:AddressId` /
 * `Command:ActionName` when such a route exists. A route may be a queue (the last entry repeats). Unrouted commands throw.
 */
export function fakeNamecheap(routes: Record<string, Route | Route[]>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const body = String(init?.body ?? "");
    const params = new URLSearchParams(body);
    const command = (params.get("Command") ?? "").replace(/^namecheap\./, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method,
      contentType: headers["Content-Type"],
      body,
      params,
      command,
    });
    const qualifier = params.get("AddressId") ?? params.get("ActionName");
    const qualified = qualifier ? `${command}:${qualifier}` : "";
    const key = qualified && qualified in routes ? qualified : command;
    const entry = routes[key];
    if (entry === undefined) throw new Error(`unrouted ${key}`);
    const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (route === undefined) throw new Error(`empty route ${key}`);
    if (route instanceof Error) throw route;
    if (typeof route === "object" && "hang" in route) {
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const { status, body: text } = typeof route === "string" ? { status: 200, body: route } : route;
    return new Response(text, { status, headers: { "content-type": "text/xml" } });
  };
  return { fetch, calls, of: (command: string) => calls.filter((c) => c.command === command) };
}

export const API_KEY = fakeSecret("namecheap-api-key");
export const CLIENT_IP = "203.0.113.7";
export const noSleep = async () => {};

/** Routes for the default address (two entries; the second is the default). */
export const ADDRESS_ROUTES = {
  "users.address.getList": fixture("users-address-getList"),
  "users.address.getInfo:101": fixture("users-address-getInfo-101"),
  "users.address.getInfo:102": fixture("users-address-getInfo-102"),
};

/** A client over the fake fetch with a fixed ClientIp. */
export function makeClient(
  fetch: FetchLike,
  options: Partial<NamecheapClientOptions> = {},
): NamecheapClient {
  return new NamecheapClient({
    apiUser: "opscrew-sandbox",
    apiKey: API_KEY,
    clientIp: CLIENT_IP,
    fetch,
    sleep: noSleep,
    ...options,
  });
}

/** Fake contact values seeded in `users-address-getInfo-102.xml` (SC-702). */
export const CONTACT_VALUES = [
  "Person",
  "Fake Title",
  "Fake Org Invalid",
  "1 Test Street",
  "Suite Fake",
  "Testville",
  "Teststate",
  "00001-0000",
  "1.5555550100",
  "5555550100",
  "test@example.invalid",
] as const;
