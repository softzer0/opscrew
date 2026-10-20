/**
 * age X25519 keys in age's Bech32 forms: the identity `AGE-SECRET-KEY-1…` (upper case) and the
 * recipient `age1…` (lower case). sops embeds age, so these are all OpsCrew needs to make a key.
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { OpsCrewError } from "../errors";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const IDENTITY_HRP = "age-secret-key-";
const RECIPIENT_HRP = "age";
/** PKCS#8 DER of an X25519 private key, up to its 32 raw bytes (RFC 8410). */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= GENERATOR[i] as number;
  }
  return checksum;
}

function expandHrp(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

function convertBits(data: Iterable<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  if (!pad && (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1)) !== 0)) {
    throw new Error("Bech32 data has non-zero padding.");
  }
  return out;
}

/** Bech32 (BIP 173) of `bytes` under `hrp`, lower case, without BIP 173's 90-character limit. */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...expandHrp(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => CHARSET[v]).join("")}`;
}

/**
 * The human-readable part (lower case) and bytes of a Bech32 string, or `undefined` when it is not
 * valid Bech32 (mixed case, a bad character or a bad checksum).
 */
export function bech32Decode(text: string): { hrp: string; bytes: Uint8Array } | undefined {
  const lower = text.toLowerCase();
  if (text !== lower && text !== text.toUpperCase()) return undefined;
  const at = lower.lastIndexOf("1");
  if (at < 1 || lower.length - at - 1 < 6) return undefined;
  const hrp = lower.slice(0, at);
  if ([...hrp].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)) return undefined;
  const data = [...lower.slice(at + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1) || polymod([...expandHrp(hrp), ...data]) !== 1) return undefined;
  try {
    return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
  } catch {
    return undefined;
  }
}

function recipientOfScalar(scalar: Uint8Array): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return bech32Encode(RECIPIENT_HRP, new Uint8Array(spki.subarray(spki.length - 32)));
}

/**
 * A new age X25519 key: the identity (`AGE-SECRET-KEY-1…`, the private key) and its recipient
 * (`age1…`). `random` supplies the 32 secret bytes (tests pass known ones).
 */
export function generateAgeIdentity(random: (size: number) => Uint8Array = randomBytes): {
  identity: string;
  recipient: string;
} {
  const scalar = random(32);
  if (scalar.length !== 32) throw new Error("An age identity needs exactly 32 random bytes.");
  return {
    identity: bech32Encode(IDENTITY_HRP, scalar).toUpperCase(),
    recipient: recipientOfScalar(scalar),
  };
}

/** The recipient (`age1…`) of an age identity; surrounding whitespace is ignored. */
export function ageRecipientOf(identity: string): string {
  const text = identity.trim();
  const decoded = bech32Decode(text);
  if (
    decoded === undefined ||
    decoded.hrp !== IDENTITY_HRP ||
    decoded.bytes.length !== 32 ||
    text !== text.toUpperCase()
  ) {
    throw new OpsCrewError("INVALID_INPUT", "That is not an age identity.", {
      hint: "An age identity is one line that starts with AGE-SECRET-KEY-1.",
    });
  }
  return recipientOfScalar(decoded.bytes);
}

/** True for an age X25519 recipient: `age1…`, lower case, with a valid checksum and 32 bytes. */
export function isAgeRecipient(text: string): boolean {
  const decoded = bech32Decode(text);
  return (
    decoded !== undefined &&
    text === text.toLowerCase() &&
    decoded.hrp === RECIPIENT_HRP &&
    decoded.bytes.length === 32
  );
}
