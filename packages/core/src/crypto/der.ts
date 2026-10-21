/**
 * A minimal DER writer: just the ASN.1 types OpsCrew's CSR and certificates need. Every writing
 * function returns the complete encoding (tag, length, content); {@link children} reads one level.
 */

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One TLV with tag byte `tag` around `content`. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), encodeLength(content.length), content);
}

/** The bytes of `parts`, one after the other. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** SEQUENCE of already encoded `items`. */
export function sequence(...items: Uint8Array[]): Uint8Array {
  return tlv(0x30, concatBytes(...items));
}

/** SET of already encoded `items`, sorted by their encodings as DER requires. */
export function set(...items: Uint8Array[]): Uint8Array {
  const sorted = [...items].sort((a, b) => Buffer.compare(a, b));
  return tlv(0x31, concatBytes(...sorted));
}

/** BOOLEAN. */
export function boolean(value: boolean): Uint8Array {
  return tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));
}

/**
 * INTEGER of a non-negative value: a number, or the big-endian bytes of one (a serial number).
 * Leading zero bytes are dropped and one is added when the top bit is set, so it stays positive.
 */
export function integer(value: number | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`DER integer must be a non-negative safe integer, not ${value}.`);
    }
    const digits: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) digits.unshift(rest % 256);
    bytes = Uint8Array.from(digits);
  } else {
    let start = 0;
    while (start < value.length && value[start] === 0) start++;
    bytes = value.subarray(start);
  }
  if (bytes.length === 0 || (bytes[0] as number) & 0x80)
    bytes = concatBytes(Uint8Array.of(0), bytes);
  return tlv(0x02, bytes);
}

/** OBJECT IDENTIFIER from its dotted form (`2.5.4.3`). */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const [first, second, ...rest] = arcs;
  if (
    first === undefined ||
    second === undefined ||
    arcs.some((arc) => !Number.isSafeInteger(arc))
  ) {
    throw new Error(`Not an object identifier: ${dotted}`);
  }
  const bytes: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const groups = [arc % 128];
    for (let high = Math.floor(arc / 128); high > 0; high = Math.floor(high / 128)) {
      groups.unshift(0x80 | (high % 128));
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

/** BIT STRING of `bytes`, whose last `unusedBits` bits are padding. */
export function bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(0x03, concatBytes(Uint8Array.of(unusedBits), bytes));
}

/** OCTET STRING. */
export function octetString(bytes: Uint8Array): Uint8Array {
  return tlv(0x04, bytes);
}

/** UTF8String. */
export function utf8String(text: string): Uint8Array {
  return tlv(0x0c, new TextEncoder().encode(text));
}

function timeDigits(date: Date, fullYear: boolean): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = iso.slice(0, 19).replace(/\D/g, "");
  return `${fullYear ? digits : digits.slice(2)}Z`;
}

/** UTCTime (`YYMMDDHHMMSSZ`), for dates from 1950 to 2049. */
export function utcTime(date: Date): Uint8Array {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw new Error(`UTCTime cannot hold the year ${year}.`);
  return tlv(0x17, new TextEncoder().encode(timeDigits(date, false)));
}

/** GeneralizedTime (`YYYYMMDDHHMMSSZ`). */
export function generalizedTime(date: Date): Uint8Array {
  return tlv(0x18, new TextEncoder().encode(timeDigits(date, true)));
}

/** A certificate's time as RFC 5280 asks: UTCTime through 2049, GeneralizedTime from 2050. */
export function x509Time(date: Date): Uint8Array {
  return date.getUTCFullYear() < 2050 ? utcTime(date) : generalizedTime(date);
}

function contextTag(n: number, constructed: boolean, content: Uint8Array): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 30) {
    throw new Error(`Context tag [${n}] needs the long form, which is not supported.`);
  }
  return tlv(0x80 | (constructed ? 0x20 : 0) | n, content);
}

/** `[n] EXPLICIT`: the encoded `value` wrapped in a constructed context tag. */
export function explicitTag(n: number, value: Uint8Array): Uint8Array {
  return contextTag(n, true, value);
}

/**
 * `[n] IMPLICIT`: a context tag in place of the value's own tag, around its `content` bytes.
 * `constructed` for a SEQUENCE or SET, primitive otherwise (an IA5String dNSName).
 */
export function implicitTag(n: number, content: Uint8Array, constructed = false): Uint8Array {
  return contextTag(n, constructed, content);
}

/**
 * The complete encodings of the elements inside the constructed value (a SEQUENCE) that `der`
 * begins with: the one reading OpsCrew needs, to copy the issuer's name from a CA certificate.
 */
export function children(der: Uint8Array): Uint8Array[] {
  const element = (at: number): { start: number; end: number } => {
    const first = der[at + 1];
    if (first === undefined) throw new Error("The DER value ends early.");
    let start = at + 2;
    let length = first;
    if (first & 0x80) {
      length = 0;
      for (const byte of der.subarray(start, start + (first & 0x7f))) length = length * 256 + byte;
      start += first & 0x7f;
    }
    if (start + length > der.length) throw new Error("The DER value ends early.");
    return { start, end: start + length };
  };
  const outer = element(0);
  const items: Uint8Array[] = [];
  for (let at = outer.start; at < outer.end; ) {
    const { end } = element(at);
    items.push(der.subarray(at, end));
    at = end;
  }
  return items;
}
