import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import type { KeyMaker, WireGuardKeyPair } from "../network";

/** The PKCS #8 header of a raw x25519 private key (RFC 8410). */
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

/** The WireGuard key pair whose private key is `seed`'s SHA-256: a real pair, the same every run. */
export function testKeyPair(seed: string): WireGuardKeyPair {
  const d = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, d]),
    format: "der",
    type: "pkcs8",
  });
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x ?? "";
  return {
    privateKey: d.toString("base64"),
    publicKey: Buffer.from(x, "base64url").toString("base64"),
  };
}

/**
 * A key maker for tests: real WireGuard key pairs, numbered from 1, the same every run (see
 * {@link testKeyPair}). `made` lists the pairs it gave.
 */
export function testKeyMaker(prefix = "opscrew-test-key"): KeyMaker & { made: WireGuardKeyPair[] } {
  const made: WireGuardKeyPair[] = [];
  const maker = () => {
    const pair = testKeyPair(`${prefix}-${made.length + 1}`);
    made.push(pair);
    return pair;
  };
  return Object.assign(maker, { made });
}
