/**
 * Key material for TLS: P-256 key pairs, a PKCS#10 certificate request for Cloudflare's Origin CA,
 * a self-signed client certificate for Authenticated Origin Pulls, and the local certificate
 * authority with the leaf certificates it signs for localhost. Built with `node:crypto` and the
 * DER writer in `./der`.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { OpsCrewError } from "../errors";
import {
  bitString,
  boolean,
  children,
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
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/**
 * keyUsage bits as a DER BIT STRING: digitalSignature is bit 0 (0x80, 7 unused bits);
 * keyCertSign and cRLSign are bits 5 and 6 (0x06, 1 unused bit).
 */
const KEY_USAGE = {
  digitalSignature: bitString(Uint8Array.of(0x80), 7),
  keyCertSignAndCrlSign: bitString(Uint8Array.of(0x06), 1),
} as const;

/** A new ECDSA P-256 key pair. */
export function generateP256(): P256KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

/** A P-256 private key (PKCS#8 PEM or a key object) and its public key as SPKI DER. */
function p256Key(key: string | KeyObject): { privateKey: KeyObject; spki: Uint8Array } {
  const privateKey = typeof key === "string" ? createPrivateKey(key) : key;
  if (
    privateKey.type !== "private" ||
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

/**
 * RFC 5280's key identifier (method 1): the SHA-1 of the subjectPublicKey bits, which for P-256
 * are the 65-byte uncompressed point that ends the SPKI.
 */
function keyIdentifier(spki: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash("sha1")
      .update(spki.subarray(spki.length - 65))
      .digest(),
  );
}

/** `Name` with one common name. */
function commonNameOf(cn: string): Uint8Array {
  return sequence(set(sequence(oid(OID.commonName), utf8String(cn))));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** The subjectAltName value: each hostname as a dNSName (`[2] IMPLICIT IA5String`). */
function dnsNames(hostnames: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  return sequence(...hostnames.map((name) => implicitTag(2, encoder.encode(name))));
}

/**
 * Refuses a hostname that is not lower-case ASCII, and a common name (by default the first
 * hostname) longer than RFC 5280 allows.
 */
function checkHostnames(commonName: string, hostnames: readonly string[], what: string): void {
  const invalid = hostnames.find((name) => !HOSTNAME.test(name));
  if (invalid !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `"${invalid}" is not a lower-case hostname, so it cannot go in ${what}.`,
      { hint: "Write hostnames in lower case, with an international name in its xn-- form." },
    );
  }
  if (commonName.length > MAX_COMMON_NAME) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The certificate's common name holds at most ${MAX_COMMON_NAME} characters; ${commonName} has ${commonName.length}.`,
      { hint: `Put a hostname of at most ${MAX_COMMON_NAME} characters first.` },
    );
  }
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

/** The validity of a certificate made `now` for `days`: from `now` to the second. */
function validityOf(now: Date, days: number): { notBefore: Date; notAfter: Date } {
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000);
  return { notBefore, notAfter: new Date(notBefore.getTime() + days * 86_400_000) };
}

/**
 * An X.509 v3 certificate (PEM) with a random 16-byte positive serial, signed with `signingKey`
 * (the subject's own key when self-signed, the issuer's otherwise).
 */
function certificate(
  o: {
    issuer: Uint8Array;
    subject: Uint8Array;
    notBefore: Date;
    notAfter: Date;
    spki: Uint8Array;
    extensions: Uint8Array[];
  },
  signingKey: KeyObject,
): string {
  const serial = new Uint8Array(randomBytes(16));
  // Positive (top bit clear) and exactly 16 bytes in DER (first byte not zero).
  serial[0] = ((serial[0] as number) & 0x7f) | 0x01;
  const tbs = sequence(
    explicitTag(0, integer(2)),
    integer(serial),
    sequence(oid(OID.ecdsaWithSha256)),
    o.issuer,
    sequence(x509Time(o.notBefore), x509Time(o.notAfter)),
    o.subject,
    o.spki,
    explicitTag(3, sequence(...o.extensions)),
  );
  return pem("CERTIFICATE", signed(tbs, signingKey));
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
  checkHostnames(first, hostnames, "a certificate request");
  const { privateKey, spki } = p256Key(input.key);
  const extensions = sequence(extension(OID.subjectAltName, false, dnsNames(hostnames)));
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
  const name = commonNameOf(input.commonName);
  return certificate(
    {
      issuer: name,
      subject: name,
      ...validityOf(input.now ?? new Date(), input.days),
      spki,
      extensions: [
        extension(OID.basicConstraints, true, sequence()),
        extension(OID.keyUsage, true, KEY_USAGE.digitalSignature),
        extension(OID.extKeyUsage, false, sequence(oid(OID.clientAuth))),
      ],
    },
    privateKey,
  );
}

/**
 * The local certificate authority's self-signed certificate (PEM) for `commonName`, valid for
 * `days` from `now`: basicConstraints CA:TRUE with pathlen 0 and keyUsage keyCertSign and cRLSign
 * (both critical), and a subjectKeyIdentifier. `key` is its P-256 private key.
 */
export function localCaCertificate(
  key: KeyObject,
  o: { commonName: string; days: number; now: Date },
): string {
  const { privateKey, spki } = p256Key(key);
  const name = commonNameOf(o.commonName);
  return certificate(
    {
      issuer: name,
      subject: name,
      ...validityOf(o.now, o.days),
      spki,
      extensions: [
        extension(OID.basicConstraints, true, sequence(boolean(true), integer(0))),
        extension(OID.keyUsage, true, KEY_USAGE.keyCertSignAndCrlSign),
        extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(spki))),
      ],
    },
    privateKey,
  );
}

/**
 * A server certificate (PEM) for `hostnames`, signed by the local CA (`caKey` and its
 * `caCertificate`): the common name is `commonName` (default: the first hostname), and it has the
 * CA's subject as its issuer, every hostname as a SAN DNS name, basicConstraints CA:false and
 * keyUsage digitalSignature (both critical), extKeyUsage serverAuth, and subject and authority key
 * identifiers. Valid for `days` from `now`, but never past the CA's own notAfter. `key` is the
 * leaf's P-256 private key; only its public key goes in the certificate.
 */
export function signedLeafCertificate(o: {
  caKey: KeyObject;
  caCertificate: string;
  key: KeyObject;
  hostnames: readonly string[];
  /** At most 64 characters; for a first hostname longer than a common name holds. */
  commonName?: string;
  days: number;
  now: Date;
}): string {
  const [first] = o.hostnames;
  if (first === undefined) {
    throw new OpsCrewError("INVALID_INPUT", "A leaf certificate needs at least one hostname.");
  }
  const commonName = o.commonName ?? first;
  checkHostnames(commonName, o.hostnames, "a certificate");
  const ca = p256Key(o.caKey);
  const leaf = p256Key(o.key);
  const caCertificate = new X509Certificate(o.caCertificate);
  const caSpki = caCertificate.publicKey.export({ format: "der", type: "spki" });
  if (!caSpki.equals(ca.spki)) {
    throw new OpsCrewError("INVALID_INPUT", "The CA key does not match the CA certificate.", {
      hint: "Pass the key the local CA's certificate was made with.",
    });
  }
  const { notBefore, notAfter: wanted } = validityOf(o.now, o.days);
  // `validTo`, not `validToDate`: Node 22.9, the oldest OpsCrew supports, lacks the latter.
  const caExpires = new Date(caCertificate.validTo);
  const notAfter = wanted < caExpires ? wanted : caExpires;
  if (notAfter <= notBefore) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The local CA expired on ${caExpires.toISOString()}, so it cannot sign a certificate.`,
      { hint: "Make a new local CA, and trust it again." },
    );
  }
  // The issuer is the CA's subject, copied as encoded: the sixth element of its TBSCertificate.
  const [tbs] = children(new Uint8Array(caCertificate.raw));
  const issuer = children(tbs as Uint8Array)[5] as Uint8Array;
  return certificate(
    {
      issuer,
      subject: commonNameOf(commonName),
      notBefore,
      notAfter,
      spki: leaf.spki,
      extensions: [
        extension(OID.basicConstraints, true, sequence()),
        extension(OID.keyUsage, true, KEY_USAGE.digitalSignature),
        extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, dnsNames(o.hostnames)),
        extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(leaf.spki))),
        extension(
          OID.authorityKeyIdentifier,
          false,
          sequence(implicitTag(0, keyIdentifier(ca.spki))),
        ),
      ],
    },
    ca.privateKey,
  );
}

/** The SHA-256 of the DER inside the first PEM block of `pemText`, as 64 lower-case hex digits. */
export function fingerprintSha256(pemText: string): string {
  const block = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pemText);
  if (!block) throw new OpsCrewError("INVALID_INPUT", "The text holds no PEM block.");
  const der = Buffer.from((block[2] as string).replace(/\s+/g, ""), "base64");
  return createHash("sha256").update(der).digest("hex");
}
