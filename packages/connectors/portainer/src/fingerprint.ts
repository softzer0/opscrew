/**
 * Certificate fingerprints. OpsCrew's canonical form is `SHA256:` followed by the 32 bytes of the
 * certificate's SHA-256 digest as upper-case hex pairs separated by colons
 * (`SHA256:AB:CD:…:EF`): the same digits Node's `fingerprint256`, `openssl x509 -fingerprint
 * -sha256` and browsers show, so a user can compare them at a glance. Every accepted form is
 * normalised to it before comparing or storing.
 */

const PREFIX = /^(?:sha-?256)(?:\s+fingerprint)?\s*[:=]\s*/i;
const HEX = /^[0-9A-Fa-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]{43}=?$/;

/**
 * The canonical form of a SHA-256 certificate fingerprint, or `undefined` when `text` is not one.
 * Accepts an optional `SHA256:` (or openssl's `sha256 Fingerprint=`) prefix and 64 hex digits
 * (with or without colons or spaces, any case) or 43 base64 characters (optionally padded).
 */
export function normalizeCertFingerprint(text: string): string | undefined {
  const body = text.trim().replace(PREFIX, "");
  const hex = body.replace(/[:\s]/g, "");
  if (HEX.test(hex)) return format(Buffer.from(hex, "hex"));
  if (BASE64.test(body)) {
    const bytes = Buffer.from(body, "base64");
    if (bytes.length === 32) return format(bytes);
  }
  return undefined;
}

/** True when both are SHA-256 fingerprints of the same certificate, in any accepted form. */
export function sameCertFingerprint(a: string, b: string): boolean {
  const left = normalizeCertFingerprint(a);
  return left !== undefined && left === normalizeCertFingerprint(b);
}

function format(digest: Buffer): string {
  const pairs = digest.toString("hex").toUpperCase().match(/../g) ?? [];
  return `SHA256:${pairs.join(":")}`;
}
