/**
 * age encryption for tests: what the servers' pinned age writes for a snapshot's off-server copy
 * (age-encryption.org/v1), so `ageDecryptStream` is tested against age's format with a key a test
 * generates. Production never encrypts on this computer.
 */
import {
  createCipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  AGE_VERSION,
  bech32Decode,
  CHUNK_BYTES,
  hkdf,
  isAgeRecipient,
  X25519_INFO,
  X25519_SPKI_PREFIX,
} from "../crypto/age";
import { OpsCrewError } from "../errors";

/** `bytes` as unpadded standard base64, as age writes it. */
function base64Text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

/** ChaCha20-Poly1305's sealing of `plain`, its tag last. */
function seal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/**
 * `plain` encrypted to the X25519 `recipients` (`age1…`) in age's format: a random file key wrapped
 * for each recipient through an ephemeral share, the header's MAC, a random nonce, and the payload
 * in 64 KiB STREAM chunks, the last one flagged. Whole in memory.
 * @throws OpsCrewError `INVALID_INPUT` for a recipient that is no age X25519 recipient.
 */
export function ageEncrypt(plain: Buffer, recipients: readonly string[]): Buffer {
  const fileKey = randomBytes(16);
  const stanzas = recipients.map((recipient) => {
    const decoded = bech32Decode(recipient);
    if (!isAgeRecipient(recipient) || decoded === undefined) {
      throw new OpsCrewError("INVALID_INPUT", "That is not an age recipient.", {
        hint: "An age recipient is one line that starts with age1.",
      });
    }
    const theirs = Buffer.from(decoded.bytes);
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const share = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const shared = diffieHellman({
      privateKey,
      publicKey: createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, theirs]),
        format: "der",
        type: "spki",
      }),
    });
    const wrap = hkdf(shared, Buffer.concat([share, theirs]), X25519_INFO);
    return `-> X25519 ${base64Text(share)}\n${base64Text(seal(wrap, Buffer.alloc(12), fileKey))}\n`;
  });
  const covered = `${AGE_VERSION}\n${stanzas.join("")}---`;
  const mac = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header"))
    .update(covered)
    .digest();
  const nonce = randomBytes(16);
  const key = hkdf(fileKey, nonce, "payload");
  const count = Math.max(1, Math.ceil(plain.length / CHUNK_BYTES));
  const chunks = Array.from({ length: count }, (_, index) => {
    const chunkNonce = Buffer.alloc(12);
    chunkNonce.writeUIntBE(index, 5, 6);
    chunkNonce[11] = index === count - 1 ? 1 : 0;
    return seal(key, chunkNonce, plain.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  });
  return Buffer.concat([Buffer.from(`${covered} ${base64Text(mac)}\n`), nonce, ...chunks]);
}
