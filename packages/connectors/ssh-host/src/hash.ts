import { createHash } from "node:crypto";
import type { HostPlan } from "./types";

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` members dropped. The same plan
 * always gives the same text, whatever order its keys were written in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
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

/** SHA-256 (lower-case hex) of the canonical JSON of the plan: the hash `host-apply` binds. */
export function hostPlanHash(plan: HostPlan): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}
