/**
 * Key material for origin TLS: P-256 key pairs, a PKCS#10 certificate request for Cloudflare's
 * Origin CA, and a self-signed client certificate for Authenticated Origin Pulls. Built with
 * `node:crypto` and the DER writer in `./der`.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { OpsCrewError } from "../errors";
import {
  bitString,
  boolean,
  explicitTag,
  implicitTag,
  integer,
  octetString,
  oid,
  sequence,
  set,
  utf8String,
  x509Time,
} from "./der";

/** A P-256 key pair as PEM: the private key in PKCS#8, the public key in SPKI. */
export interface P256KeyPair {
  privateKey: string;
  publicKey: string;
}

/** The most hostnames one certificate request may name (Cloudflare's Origin CA limit). */
export const MAX_CSR_HOSTNAMES = 100;

/** RFC 5280's upper bound on a common name (`ub-common-name`). */
const MAX_COMMON_NAME = 64;
/** A lower-case ASCII hostname: labels of letters, digits and inner hyphens, joined by dots. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

const OID = {
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/** A new ECDSA P-256 key pair. */
export function generateP256(): P256KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function p256Key(pem: string): { privateKey: KeyObject; spki: Uint8Array } {
  const privateKey = createPrivateKey(pem);
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new OpsCrewError("INVALID_INPUT", "The key is not an ECDSA P-256 private key.", {
      hint: "Use a key from generateP256().",
    });
  }
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, spki: new Uint8Array(spki) };
}

/** `Name` with one common name. */
function commonNameOf(cn: string): Uint8Array {
  return sequence(set(sequence(oid(OID.commonName), utf8String(cn))));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** `toBeSigned` with its ecdsa-with-SHA256 signature, as a certificate or request's outer SEQUENCE. */
function signed(toBeSigned: Uint8Array, privateKey: KeyObject): Uint8Array {
  const signature = sign("sha256", toBeSigned, privateKey);
  return sequence(toBeSigned, sequence(oid(OID.ecdsaWithSha256)), bitString(signature));
}

function pem(label: string, der: Uint8Array): string {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * A PKCS#10 certificate request (PEM) for `hostnames`, signed with `key` (PKCS#8 PEM of a P-256
 * key): the common name is the first hostname, and a subjectAltName extension request lists every
 * hostname. Refuses an empty list or more than {@link MAX_CSR_HOSTNAMES}.
 */
export function buildCsr(input: { key: string; hostnames: readonly string[] }): string {
  const { hostnames } = input;
  const [first] = hostnames;
  if (first === undefined || hostnames.length > MAX_CSR_HOSTNAMES) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `A certificate request needs 1 to ${MAX_CSR_HOSTNAMES} hostnames; it was given ${hostnames.length}.`,
      { hint: `Split the hostnames into groups of at most ${MAX_CSR_HOSTNAMES}.` },
    );
  }
  const invalid = hostnames.find((name) => !HOSTNAME.test(name));
  if (invalid !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${invalid}" is not a lower-case hostname, so it cannot go in a certificate request.`,
      { hint: "Write hostnames in lower case, with an international name in its xn-- form." },
    );
  }
  if (first.length > MAX_COMMON_NAME) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The first hostname becomes the certificate's common name, which holds at most ${MAX_COMMON_NAME} characters; ${first} has ${first.length}.`,
      { hint: `Put a hostname of at most ${MAX_COMMON_NAME} characters first.` },
    );
  }
  const { privateKey, spki } = p256Key(input.key);
  const encoder = new TextEncoder();
  const altNames = sequence(...hostnames.map((name) => implicitTag(2, encoder.encode(name))));
  const extensions = sequence(extension(OID.subjectAltName, false, altNames));
  const attributes = implicitTag(0, sequence(oid(OID.extensionRequest), set(extensions)), true);
  const info = sequence(integer(0), commonNameOf(first), spki, attributes);
  return pem("CERTIFICATE REQUEST", signed(info, privateKey));
}

/**
 * A self-signed X.509 v3 client certificate (PEM) for `commonName`, valid for `days` from `now`:
 * a random 16-byte positive serial, basicConstraints CA:false, keyUsage digitalSignature (both
 * critical) and extKeyUsage clientAuth. `key` is the PKCS#8 PEM of a P-256 key.
 */
export function selfSignedClientCertificate(input: {
  key: string;
  commonName: string;
  days: number;
  now?: Date;
}): string {
  const { privateKey, spki } = p256Key(input.key);
  const notBefore = new Date(Math.floor((input.now ?? new Date()).getTime() / 1000) * 1000);
  const notAfter = new Date(notBefore.getTime() + input.days * 86_400_000);
  const serial = new Uint8Array(randomBytes(16));
  // Positive (top bit clear) and exactly 16 bytes in DER (first byte not zero).
  serial[0] = ((serial[0] as number) & 0x7f) | 0x01;
  const name = commonNameOf(input.commonName);
  const extensions = sequence(
    extension(OID.basicConstraints, true, sequence()),
    // digitalSignature is bit 0: one byte 0x80 with 7 unused bits.
    extension(OID.keyUsage, true, bitString(Uint8Array.of(0x80), 7)),
    extension(OID.extKeyUsage, false, sequence(oid(OID.clientAuth))),
  );
  const tbs = sequence(
    explicitTag(0, integer(2)),
    integer(serial),
    sequence(oid(OID.ecdsaWithSha256)),
    name,
    sequence(x509Time(notBefore), x509Time(notAfter)),
    name,
    spki,
    explicitTag(3, extensions),
  );
  return pem("CERTIFICATE", signed(tbs, privateKey));
}

/** The SHA-256 of the DER inside the first PEM block of `pemText`, as 64 lower-case hex digits. */
export function fingerprintSha256(pemText: string): string {
  const block = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pemText);
  if (!block) throw new OpsCrewError("INVALID_INPUT", "The text holds no PEM block.");
  const der = Buffer.from((block[2] as string).replace(/\s+/g, ""), "base64");
  return createHash("sha256").update(der).digest("hex");
}
