import { createHash } from "node:crypto";
import type { z } from "zod";

/**
 * The first `max` problems of a failed zod parse as `path: message`, joined with `; `; a problem
 * with the value itself is `(root)`. `at` goes in front of every path, for a part parsed alone.
 */
export function zodIssues(error: z.ZodError, max = 3, at: readonly PropertyKey[] = []): string {
  return error.issues
    .slice(0, max)
    .map((issue) => `${[...at, ...issue.path].join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** True for a plain JSON-like object: not `null` and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` members dropped (and `undefined`
 * array items written as `null`, as `JSON.stringify` does). The same value always gives the same
 * text, whatever order its keys were written in, so a plan's hash is stable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}

/** SHA-256 of `data` (text is hashed as UTF-8) as 64 lower-case hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
