import { createHmac } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";

/** The name the webhook's fingerprint is computed under: `valueFingerprints(key, { webhook })`. */
export const WEBHOOK_FINGERPRINT_NAME = "webhook";

/**
 * Keyed fingerprints of values: `HMAC-SHA256(key, name + "\0" + value)` as hex, per entry. The
 * key stays on the user's computer (0600), so a fingerprint tells whether a value changed without
 * revealing it; values never leave memory. The webhook's fingerprint is
 * `valueFingerprints(key, { webhook: webhookId }).webhook`.
 */
export function valueFingerprints(
  key: Uint8Array,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  checkKey(key);
  const out: Record<string, string> = {};
  for (const name of Object.keys(values).sort()) {
    const value = values[name];
    if (typeof value === "string") out[name] = fingerprint(key, name, value);
  }
  return out;
}

/** One keyed fingerprint (the key is checked by the caller). */
export function fingerprint(key: Uint8Array, name: string, value: string): string {
  return createHmac("sha256", key).update(`${name}\0${value}`, "utf8").digest("hex");
}

/** A value key is at least 16 random bytes. */
export function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length < 16) {
    throw new OpsCrewError("INVALID_INPUT", "The value key must be at least 16 bytes.", {
      hint: "Use the key OpsCrew keeps for this project (32 random bytes, readable only by you).",
    });
  }
}
