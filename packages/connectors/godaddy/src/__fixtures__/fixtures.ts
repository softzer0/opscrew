import { type FakeReply, fakeFetch as coreFakeFetch } from "@opscrew/core/testing";
import { GODADDY_API } from "../client";

/** Core's fake fetch with routes relative to the GoDaddy API (`"POST /v3/domains/..."`). */
export function fakeFetch(routes: Record<string, FakeReply | FakeReply[]>, base = GODADDY_API) {
  return coreFakeFetch(routes, { base });
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
