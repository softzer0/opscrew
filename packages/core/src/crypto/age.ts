/**
 * age X25519 keys in age's Bech32 forms: the identity `AGE-SECRET-KEY-1…` (upper case) and the
 * recipient `age1…` (lower case). sops embeds age, so these are all OpsCrew needs to make a key.
 * {@link ageDecryptStream} opens an age file encrypted to such a key, such as a snapshot's
 * off-server copy (024 plan.md 6.).
 */
import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
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

/** The 32 secret bytes of an age identity; surrounding whitespace is ignored. */
function identityScalar(identity: string): Uint8Array {
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
  return decoded.bytes;
}

/** The recipient (`age1…`) of an age identity; surrounding whitespace is ignored. */
export function ageRecipientOf(identity: string): string {
  return recipientOfScalar(identityScalar(identity));
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

/** The first line of every age file (age-encryption.org/v1). */
export const AGE_VERSION = "age-encryption.org/v1";
/** SubjectPublicKeyInfo DER of an X25519 public key, up to its 32 raw bytes (RFC 8410). */
export const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
/** The X25519 stanza's HKDF info. */
export const X25519_INFO = "age-encryption.org/v1/X25519";
/** A plaintext chunk of the payload's STREAM, and its Poly1305 tag. */
export const CHUNK_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const SEALED_CHUNK_BYTES = CHUNK_BYTES + TAG_BYTES;
/** The payload's nonce, after the header. */
const NONCE_BYTES = 16;
/** The most bytes a header may take: a file encrypted to a few recipients needs far fewer. */
const MAX_HEADER_BYTES = 64 * 1024;
/** Unpadded standard base64, as age writes it: a stanza body's line, the MAC. */
const BASE64 = /^[A-Za-z0-9+/]*$/;

/** A file that is not an age file OpsCrew can read whole: refused, nothing more is written. */
function damaged(why: string): OpsCrewError {
  return new OpsCrewError("ARTIFACT_INVALID", `The encrypted file ${why}, so it was not used.`, {
    hint: "The copy may be damaged or changed: use another copy, or take a new one.",
  });
}

/** `text` as unpadded base64 of exactly `bytes` bytes (any length when undefined). */
function base64Of(text: string, bytes?: number): Buffer {
  if (!BASE64.test(text)) throw damaged("has a damaged header");
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== text) throw damaged("has a damaged header");
  if (bytes !== undefined && decoded.length !== bytes) throw damaged("has a damaged header");
  return decoded;
}

/** HKDF-SHA-256 of `ikm` to 32 bytes. */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
}

/** ChaCha20-Poly1305's opening of `sealed` (its tag last), or `undefined` when the tag is wrong. */
function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer | undefined {
  if (sealed.length < TAG_BYTES) return undefined;
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return undefined;
  }
}

/** An age stanza of the header: its type, its arguments and its body. */
interface Stanza {
  args: string[];
  body: Buffer;
}

/** The parsed header: its stanzas, its MAC, the bytes the MAC covers. */
interface Header {
  stanzas: Stanza[];
  mac: Buffer;
  covered: Buffer;
}

/** The header `text` (up to and including the footer line's newline), parsed strictly. */
function parseHeader(text: string): Header {
  const lines = text.split("\n");
  // The text ends with the footer's newline.
  lines.pop();
  if (lines[0] !== AGE_VERSION) throw damaged("is no age file (age-encryption.org/v1)");
  const stanzas: Stanza[] = [];
  let at = 1;
  while (at < lines.length && (lines[at] as string).startsWith("-> ")) {
    const args = (lines[at] as string).slice(3).split(" ");
    if (args.some((arg) => arg === "")) throw damaged("has a damaged header");
    at++;
    const body: string[] = [];
    for (;;) {
      const line = lines[at];
      if (line === undefined || line.length > 64) throw damaged("has a damaged header");
      body.push(line);
      at++;
      if (line.length < 64) break;
    }
    stanzas.push({ args, body: base64Of(body.join("")) });
  }
  const footer = lines[at];
  if (at !== lines.length - 1 || footer === undefined || !footer.startsWith("--- ")) {
    throw damaged("has a damaged header");
  }
  const end = text.length - footer.length - 1 + 3;
  return { stanzas, mac: base64Of(footer.slice(4), 32), covered: Buffer.from(text.slice(0, end)) };
}

/**
 * The file key of the first X25519 stanza `scalar` opens (age's X25519 recipient type), or
 * `undefined` when none is for this key.
 */
function unwrapFileKey(scalar: Uint8Array, stanzas: readonly Stanza[]): Buffer | undefined {
  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const own = spki.subarray(spki.length - 32);
  for (const { args, body } of stanzas) {
    if (args[0] !== "X25519") continue;
    if (args.length !== 2 || body.length !== 32) throw damaged("has a damaged header");
    const share = base64Of(args[1] as string, 32);
    let shared: Buffer;
    try {
      const publicKey = createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, share]),
        format: "der",
        type: "spki",
      });
      shared = diffieHellman({ privateKey, publicKey });
    } catch {
      // A share of low order: no key can open it.
      continue;
    }
    if (shared.every((byte) => byte === 0)) continue;
    const wrap = hkdf(shared, Buffer.concat([share, own]), X25519_INFO);
    const fileKey = open(wrap, Buffer.alloc(12), body);
    if (fileKey?.length === 16) return fileKey;
  }
  return undefined;
}

/**
 * A stream that decrypts an age file (age-encryption.org/v1, research R3) with the X25519
 * `identity` (`AGE-SECRET-KEY-1…`, or the text of an age key file, whose comment lines are
 * skipped), such as the recovery copy's key the user keeps on this computer. It holds at most two
 * of the payload's 64 KiB chunks at a time, so a file of any size
 * streams through, and writes a chunk only once its tag checks. It fails closed, writing nothing
 * more: `SECRETS_KEY_REJECTED` when the file is not encrypted to the identity, `ARTIFACT_INVALID`
 * for a damaged header, a header MAC or a chunk tag that doesn't check, and a truncated file.
 * @throws OpsCrewError `INVALID_INPUT` at once when `identity` is no age identity.
 */
export function ageDecryptStream(identity: string): Transform {
  const line = identity
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text.startsWith("AGE-SECRET-KEY-1"));
  const scalar = identityScalar(line ?? identity);
  let pending: Buffer = Buffer.alloc(0);
  let payloadKey: Buffer | undefined;
  let counter = 0;

  /** Reads the header off `pending` once it is all there; false until then. */
  function readHeader(): boolean {
    const footer = pending.indexOf("\n--- ");
    const end = footer === -1 ? -1 : pending.indexOf("\n", footer + 1);
    if (end === -1 || pending.length < end + 1 + NONCE_BYTES) {
      if (pending.length > MAX_HEADER_BYTES) throw damaged("has no age header");
      return false;
    }
    const header = parseHeader(pending.subarray(0, end + 1).toString("latin1"));
    const fileKey = unwrapFileKey(scalar, header.stanzas);
    if (fileKey === undefined) {
      throw new OpsCrewError(
        "SECRETS_KEY_REJECTED",
        "The age key cannot open the encrypted file: it is not one of the keys the file was encrypted to.",
        { hint: "Use the recovery copy's age key the copy was made with, or the backup key." },
      );
    }
    const mac = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header"))
      .update(header.covered)
      .digest();
    if (!timingSafeEqual(mac, header.mac)) throw damaged("has a header that was changed");
    const nonce = pending.subarray(end + 1, end + 1 + NONCE_BYTES);
    payloadKey = hkdf(fileKey, nonce, "payload");
    pending = pending.subarray(end + 1 + NONCE_BYTES);
    return true;
  }

  /** The next chunk of the payload, opened; `last` for the final one. */
  function chunk(sealed: Buffer, last: boolean): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(counter, 5, 6);
    nonce[11] = last ? 1 : 0;
    const plain = open(payloadKey as Buffer, nonce, sealed);
    if (plain === undefined) {
      throw damaged(last ? "is cut short or was changed" : "was changed");
    }
    if (last && plain.length === 0 && counter > 0) throw damaged("is damaged at its end");
    counter++;
    return plain;
  }

  return new Transform({
    transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      try {
        pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
        if (payloadKey === undefined && !readHeader()) return done();
        // A full chunk is the last only when nothing follows it: keep the last one back.
        while (pending.length > SEALED_CHUNK_BYTES) {
          this.push(chunk(pending.subarray(0, SEALED_CHUNK_BYTES), false));
          pending = pending.subarray(SEALED_CHUNK_BYTES);
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (payloadKey === undefined && !readHeader()) throw damaged("is cut short");
        done(null, chunk(pending, true));
      } catch (error) {
        done(error as Error);
      }
    },
  });
}
