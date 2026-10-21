import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  X509Certificate,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findExecutable } from "../exec";
import {
  buildCsr,
  fingerprintSha256,
  generateP256,
  localCaCertificate,
  MAX_CSR_HOSTNAMES,
  selfSignedClientCertificate,
  signedLeafCertificate,
} from "./x509";

const OPENSSL = findExecutable("openssl");
if (OPENSSL === undefined) {
  console.warn(
    "openssl is not on PATH: skipping the openssl checks of the certificate request and certificates.",
  );
}

function openssl(args: string[], input: string): { status: number | null; out: string } {
  const result = spawnSync(OPENSSL as string, args, { input, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const derOf = (pem: string) =>
  Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");

describe("generateP256", () => {
  it("returns a PKCS#8 private key and its SPKI public key as PEM", () => {
    const { privateKey, publicKey } = generateP256();
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+-----END PRIVATE KEY-----\n$/);
    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/);
    const derived = createPublicKey(privateKey).export({ format: "pem", type: "spki" });
    expect(derived).toBe(publicKey);
    expect(createPublicKey(publicKey).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(generateP256().privateKey).not.toBe(privateKey);
  });
});

describe("selfSignedClientCertificate", () => {
  const key = generateP256();
  const now = new Date("2026-10-21T10:20:30.456Z");
  const pem = selfSignedClientCertificate({
    key: key.privateKey,
    commonName: "opscrew-shop",
    days: 5475,
    now,
  });
  const cert = new X509Certificate(pem);
  const der = derOf(pem);

  it("is a self-signed X.509 v3 certificate for the common name, signed by the key", () => {
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+-----END CERTIFICATE-----\n$/);
    expect(cert.subject).toBe("CN=opscrew-shop");
    expect(cert.issuer).toBe("CN=opscrew-shop");
    expect(cert.verify(createPublicKey(key.publicKey))).toBe(true);
    expect(cert.publicKey.export({ format: "pem", type: "spki" })).toBe(key.publicKey);
    expect(cert.ca).toBe(false);
    // Version 3: [0] EXPLICIT INTEGER 2 opens the TBSCertificate.
    expect(der.includes(Buffer.from("a003020102", "hex"))).toBe(true);
  });

  it("is valid for the days asked, from now to the second", () => {
    expect(new Date(cert.validFrom).toISOString()).toBe("2026-10-21T10:20:30.000Z");
    expect(new Date(cert.validTo).toISOString()).toBe("2041-10-17T10:20:30.000Z");
    const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000;
    expect(days).toBe(5475);
  });

  it("has a random 16-byte positive serial", () => {
    expect(cert.serialNumber).toMatch(/^[0-9A-F]{32}$/);
    expect(Number.parseInt(cert.serialNumber.slice(0, 2), 16)).toBeLessThan(0x80);
    const other = new X509Certificate(
      selfSignedClientCertificate({ key: key.privateKey, commonName: "opscrew-shop", days: 1 }),
    );
    expect(other.serialNumber).not.toBe(cert.serialNumber);
  });

  it("has basicConstraints CA:false and keyUsage digitalSignature (critical) and extKeyUsage clientAuth", () => {
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
    // basicConstraints, critical, an empty SEQUENCE (CA defaults to false).
    expect(der.includes(Buffer.from("300c0603551d130101ff04023000", "hex"))).toBe(true);
    // keyUsage, critical, the BIT STRING with only digitalSignature set.
    expect(der.includes(Buffer.from("300e0603551d0f0101ff040403020780", "hex"))).toBe(true);
    // extKeyUsage with id-kp-clientAuth.
    expect(der.includes(Buffer.from("30130603551d25040c300a06082b06010505070302", "hex"))).toBe(
      true,
    );
  });

  it.skipIf(OPENSSL === undefined)("reads as a client certificate in openssl", () => {
    const { status, out } = openssl(["x509", "-noout", "-text"], pem);
    expect(status, out).toBe(0);
    expect(out).toMatch(/X509v3 Basic Constraints: critical\s+CA:FALSE/);
    expect(out).toMatch(/X509v3 Key Usage: critical\s+Digital Signature\s*\n/);
    expect(out).toMatch(/X509v3 Extended Key Usage:\s+TLS Web Client Authentication/);
  });

  it("gives the SHA-256 fingerprint of the certificate's DER", () => {
    const expected = createHash("sha256").update(der).digest("hex");
    expect(fingerprintSha256(pem)).toBe(expected);
    expect(cert.fingerprint256.replaceAll(":", "").toLowerCase()).toBe(expected);
    expect(() => fingerprintSha256("no pem here")).toThrow(/no PEM block/);
  });
});

/** The 20-byte key identifier that follows `prefixHex` (an extension's OID and wrapping) in `der`. */
function keyIdAfter(der: Buffer, prefixHex: string): string {
  const prefix = Buffer.from(prefixHex, "hex");
  const at = der.indexOf(prefix);
  expect(at, prefixHex).toBeGreaterThanOrEqual(0);
  return der.subarray(at + prefix.length, at + prefix.length + 20).toString("hex");
}
// subjectKeyIdentifier: OCTET STRING (22) around OCTET STRING (20).
const SKI = "0603551d0e04160414";
// authorityKeyIdentifier: OCTET STRING (24) around SEQUENCE (22) around [0] (20).
const AKI = "0603551d23041830168014";

/** The private scalar of a P-256 key, which no certificate may hold. */
const privateScalar = (key: KeyObject) =>
  Buffer.from(key.export({ format: "jwk" }).d as string, "base64url");

describe("localCaCertificate and signedLeafCertificate", () => {
  const now = new Date("2026-10-22T08:09:10.789Z");
  const caKey = createPrivateKey(generateP256().privateKey);
  const caPem = localCaCertificate(caKey, { commonName: "OpsCrew local CA", days: 3650, now });
  const ca = new X509Certificate(caPem);
  const caDer = derOf(caPem);
  const leafKey = createPrivateKey(generateP256().privateKey);
  const hostnames = ["a.localhost", "staging.a.localhost"];
  const leafPem = signedLeafCertificate({
    caKey,
    caCertificate: caPem,
    key: leafKey,
    hostnames,
    days: 825,
    now,
  });
  const leaf = new X509Certificate(leafPem);
  const leafDer = derOf(leafPem);

  it("makes a self-signed CA certificate for the common name, valid for the days asked", () => {
    expect(caPem).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+-----END CERTIFICATE-----\n$/);
    expect(ca.subject).toBe("CN=OpsCrew local CA");
    expect(ca.issuer).toBe("CN=OpsCrew local CA");
    expect(ca.ca).toBe(true);
    expect(ca.verify(createPublicKey(caKey))).toBe(true);
    expect(ca.checkIssued(ca)).toBe(true);
    expect(new Date(ca.validFrom).toISOString()).toBe("2026-10-22T08:09:10.000Z");
    expect(new Date(ca.validTo).toISOString()).toBe("2036-10-19T08:09:10.000Z");
    expect(ca.serialNumber).toMatch(/^[0-9A-F]{32}$/);
  });

  it("gives the CA basicConstraints CA:TRUE pathlen 0 and keyUsage keyCertSign and cRLSign, critical", () => {
    // basicConstraints, critical, SEQUENCE { BOOLEAN TRUE, INTEGER 0 }.
    expect(caDer.includes(Buffer.from("30120603551d130101ff040830060101ff020100", "hex"))).toBe(
      true,
    );
    // keyUsage, critical, bits 5 and 6 (0x06, one unused bit).
    expect(caDer.includes(Buffer.from("300e0603551d0f0101ff040403020106", "hex"))).toBe(true);
    // The subject key identifier is the SHA-1 of the public key's point.
    const point = createPublicKey(caKey).export({ format: "der", type: "spki" }).subarray(-65);
    expect(keyIdAfter(caDer, SKI)).toBe(createHash("sha1").update(point).digest("hex"));
  });

  it("signs a leaf for a.localhost and staging.a.localhost that the CA issued", () => {
    expect(leafPem).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+-----END CERTIFICATE-----\n$/);
    expect(leaf.issuer).toBe("CN=OpsCrew local CA");
    expect(leaf.subject).toBe("CN=a.localhost");
    expect(leaf.subjectAltName).toBe("DNS:a.localhost, DNS:staging.a.localhost");
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.verify(createPublicKey(leafKey))).toBe(false);
    expect(leaf.publicKey.export({ format: "der", type: "spki" })).toEqual(
      createPublicKey(leafKey).export({ format: "der", type: "spki" }),
    );
    expect(leaf.ca).toBe(false);
    expect(leaf.checkHost("staging.a.localhost")).toBe("staging.a.localhost");
    expect(leaf.serialNumber).not.toBe(ca.serialNumber);
  });

  it("gives the leaf digitalSignature, serverAuth and the CA's key identifier", () => {
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    // basicConstraints CA:false and keyUsage digitalSignature, both critical.
    expect(leafDer.includes(Buffer.from("300c0603551d130101ff04023000", "hex"))).toBe(true);
    expect(leafDer.includes(Buffer.from("300e0603551d0f0101ff040403020780", "hex"))).toBe(true);
    expect(keyIdAfter(leafDer, AKI)).toBe(keyIdAfter(caDer, SKI));
    expect(keyIdAfter(leafDer, SKI)).not.toBe(keyIdAfter(caDer, SKI));
  });

  it("is valid for the days asked, but never past the CA", () => {
    expect(new Date(leaf.validFrom).toISOString()).toBe("2026-10-22T08:09:10.000Z");
    expect(new Date(leaf.validTo).toISOString()).toBe("2029-01-24T08:09:10.000Z");
    const long = new X509Certificate(
      signedLeafCertificate({
        caKey,
        caCertificate: caPem,
        key: leafKey,
        hostnames,
        days: 99_999,
        now,
      }),
    );
    expect(long.validTo).toBe(ca.validTo);
    const later = new Date("2037-01-01T00:00:00Z");
    expect(() =>
      signedLeafCertificate({
        caKey,
        caCertificate: caPem,
        key: leafKey,
        hostnames,
        days: 1,
        now: later,
      }),
    ).toThrow(/local CA expired on 2036-10-19T08:09:10\.000Z/);
  });

  it("refuses a CA key that is not the certificate's, no hostname, and a bad hostname", () => {
    const sign = (o: { caKey?: KeyObject; hostnames?: string[] }) => () =>
      signedLeafCertificate({
        caKey: o.caKey ?? caKey,
        caCertificate: caPem,
        key: leafKey,
        hostnames: o.hostnames ?? hostnames,
        days: 1,
        now,
      });
    expect(sign({ caKey: leafKey })).toThrow(/CA key does not match the CA certificate/);
    expect(sign({ hostnames: [] })).toThrow(/at least one hostname/);
    expect(sign({ hostnames: ["a.localhost", "A.localhost"] })).toThrow(
      /"A\.localhost" is not a lower-case hostname, so it cannot go in a certificate\./,
    );
    expect(() =>
      localCaCertificate(createPublicKey(caKey), { commonName: "x", days: 1, now }),
    ).toThrow(/not an ECDSA P-256 private key/);
  });

  it("puts no private key in either certificate", () => {
    for (const pem of [caPem, leafPem]) {
      expect(pem).not.toMatch(/PRIVATE/);
      expect(pem.match(/-----BEGIN /g)).toHaveLength(1);
      const der = derOf(pem);
      expect(der.includes(privateScalar(caKey))).toBe(false);
      expect(der.includes(privateScalar(leafKey))).toBe(false);
    }
  });

  it.skipIf(OPENSSL === undefined)(
    "passes openssl verify -CAfile, with the extensions openssl reads",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "opscrew-local-ca-"));
      try {
        await writeFile(join(dir, "ca.pem"), caPem);
        await writeFile(join(dir, "leaf.pem"), leafPem);
        const verify = openssl(
          [
            "verify",
            "-x509_strict",
            "-purpose",
            "sslserver",
            "-CAfile",
            join(dir, "ca.pem"),
            "-attime",
            String(Math.floor(now.getTime() / 1000) + 60),
            join(dir, "leaf.pem"),
          ],
          "",
        );
        expect(verify.status, verify.out).toBe(0);
        expect(verify.out).toMatch(/leaf\.pem: OK/);
        const caText = openssl(["x509", "-noout", "-text"], caPem);
        expect(caText.out).toMatch(/X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
        expect(caText.out).toMatch(/X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign\s*\n/);
        const leafText = openssl(["x509", "-noout", "-text"], leafPem);
        expect(leafText.out).toMatch(/X509v3 Key Usage: critical\s+Digital Signature\s*\n/);
        expect(leafText.out).toMatch(/X509v3 Extended Key Usage:\s+TLS Web Server Authentication/);
        expect(leafText.out).toContain("DNS:a.localhost, DNS:staging.a.localhost");
        expect(leafText.out).toMatch(/X509v3 Authority Key Identifier:/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("buildCsr", () => {
  const key = generateP256();
  const hostnames = ["app.example.com", "www.app.example.com"];
  const csr = buildCsr({ key: key.privateKey, hostnames });

  it("is a PEM certificate request with the first hostname as CN and every hostname as a SAN", () => {
    expect(csr).toMatch(
      /^-----BEGIN CERTIFICATE REQUEST-----\n[\s\S]+-----END CERTIFICATE REQUEST-----\n$/,
    );
    const der = derOf(csr);
    // The extensionRequest attribute, and each hostname as a dNSName ([2] IMPLICIT IA5String).
    expect(der.includes(Buffer.from("06092a864886f70d01090e", "hex"))).toBe(true);
    for (const name of hostnames) {
      expect(der.includes(Buffer.concat([Buffer.of(0x82, name.length), Buffer.from(name)]))).toBe(
        true,
      );
    }
  });

  it.skipIf(OPENSSL === undefined)("passes openssl req -verify, which shows the SANs", () => {
    const verify = openssl(["req", "-verify", "-noout"], csr);
    expect(verify.status, verify.out).toBe(0);
    expect(verify.out).toMatch(/verify OK/i);
    const text = openssl(["req", "-noout", "-text"], csr);
    expect(text.status, text.out).toBe(0);
    expect(text.out).toMatch(/Subject: ?CN ?= ?app\.example\.com/);
    expect(text.out).toContain("DNS:app.example.com, DNS:www.app.example.com");
    expect(text.out).toMatch(/Signature Algorithm: ecdsa-with-SHA256/);
    expect(text.out).toMatch(/ASN1 OID: prime256v1/);
  });

  it("refuses no hostname and more than 100", () => {
    expect(() => buildCsr({ key: key.privateKey, hostnames: [] })).toThrow(/1 to 100 hostnames/);
    const many = Array.from({ length: MAX_CSR_HOSTNAMES + 1 }, (_, i) => `h${i}.example.com`);
    expect(() => buildCsr({ key: key.privateKey, hostnames: many })).toThrow(/given 101/);
    expect(() => buildCsr({ key: key.privateKey, hostnames: many.slice(1) })).not.toThrow();
  });

  it("refuses a hostname that is not lower-case ASCII, and a common name over 64 characters", () => {
    const csr = (names: string[]) => () => buildCsr({ key: key.privateKey, hostnames: names });
    for (const bad of [
      "App.example.com",
      "bücher.example",
      "*.example.com",
      "a_b.example.com",
      "a..b",
      "-a.example.com",
      "a.example.com.",
      "a b",
      "",
    ]) {
      expect(csr(["ok.example.com", bad]), bad).toThrow(/is not a lower-case hostname/);
    }
    expect(csr(["xn--bcher-kva.example", "a-b.example.com"])).not.toThrow();
    const label = "a".repeat(52);
    const long = `${label}.example.com`; // 64 characters
    expect(long).toHaveLength(64);
    expect(csr([long])).not.toThrow();
    expect(csr([`a${long}`])).toThrow(/at most 64 characters; a{53}\.example\.com has 65/);
    expect(csr(["app.example.com", `a${long}`])).not.toThrow();
  });

  it("refuses a key that is not P-256, without repeating it", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    let message = "";
    try {
      buildCsr({ key: rsa, hostnames });
    } catch (error) {
      message = `${String(error)} ${(error as { hint?: string }).hint}`;
    }
    expect(message).toMatch(/not an ECDSA P-256 private key/);
    expect(message).not.toContain(rsa.split("\n")[1]);
  });
});
