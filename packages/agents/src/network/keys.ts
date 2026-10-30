import { generateKeyPairSync } from "node:crypto";

/** A WireGuard key pair, each key the base64 of 32 bytes as `wg genkey` and `wg pubkey` print them. */
export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

/** Makes a new WireGuard key pair (default {@link x25519KeyPair}; tests inject a deterministic one). */
export type KeyMaker = () => WireGuardKeyPair;

/** base64url (a JWK field) to the standard base64 WireGuard uses. */
function base64(base64url: string): string {
  return Buffer.from(base64url, "base64url").toString("base64");
}

/**
 * A new WireGuard key pair from Node's `x25519`: the JWK's `d` and `x` turned from base64url into
 * base64, which `wg pubkey` agrees with (research R5a).
 */
export const x25519KeyPair: KeyMaker = () => {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.d === undefined || jwk.x === undefined) {
    throw new Error("Node's x25519 key has no private or public part.");
  }
  return { privateKey: base64(jwk.d), publicKey: base64(jwk.x) };
};
