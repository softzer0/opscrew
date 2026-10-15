import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

/**
 * A self-signed certificate made at test time with Node's crypto only (no openssl, nothing
 * committed): EC P-256, an empty subject and issuer, SAN `localhost` and `0.0.0.0`, no basic
 * constraints, valid for one day, like the certificate Portainer generates on first start
 * (research R2).
 */
export interface TestCertificate {
  /** PEM of the certificate. */
  cert: string;
  /** PEM (PKCS#8) of the private key. */
  key: string;
  /** Node's colon-separated upper-case SHA-256 fingerprint (`AB:CD:…`). */
  fingerprint256: string;
}

export function selfSignedCertificate(now = new Date()): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaWithSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const emptyName = seq();
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + 24 * 3600_000);
  const extensions = seq(
    // keyUsage (critical): digitalSignature.
    seq(oid("2.5.29.15"), BOOL_TRUE, octets(tlv(0x03, Buffer.from([0x07, 0x80])))),
    // extKeyUsage: serverAuth.
    seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))),
    // subjectAltName (critical, as the subject is empty): DNS localhost, IP 0.0.0.0.
    seq(
      oid("2.5.29.17"),
      BOOL_TRUE,
      octets(seq(tlv(0x82, Buffer.from("localhost", "ascii")), tlv(0x87, Buffer.from([0, 0, 0, 0])))),
    ),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaWithSha256,
    emptyName,
    seq(utcTime(notBefore), utcTime(notAfter)),
    emptyName,
    spki,
    tlv(0xa3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const x509 = new X509Certificate(der);
  return {
    cert: x509.toString(),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint256: x509.fingerprint256,
  };
}

const BOOL_TRUE = tlv(0x01, Buffer.from([0xff]));

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function seq(...parts: Buffer[]): Buffer {
  return tlv(0x30, ...parts);
}

function octets(value: Buffer): Buffer {
  return tlv(0x04, value);
}

function integer(value: Buffer): Buffer {
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) & 0x80) === 0) {
    bytes = bytes.subarray(1);
  }
  if (((bytes[0] ?? 0) & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const group = [value & 0x7f];
    for (let high = value >> 7; high > 0; high >>= 7) group.unshift((high & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}
