import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { ageEncrypt } from "../testing/age";
import {
  ageDecryptStream,
  ageRecipientOf,
  bech32Decode,
  bech32Encode,
  generateAgeIdentity,
  isAgeRecipient,
} from "./age";

// age's published X25519 test key (FiloSottile/age cmd/age/testdata/x25519.txt and the C2SP age
// test kit's x25519 vectors). The identity is kept as its 32 bytes and the SHA-256 of its text, so
// no identity-shaped string is committed.
const VECTOR = {
  scalar: "ca1626252c53cf1a4dc46695e7fcc46594cb4ccadedb6712dfda0753f3ae355e",
  identitySha256: "73e7976d91fdc8fc6ebae532145ef31045826ee3ff8f5b41426fef0326f58f38",
  recipient: "age1xmwwc06ly3ee5rytxm9mflaz2u56jjj36s0mypdrwsvlul66mv4q47ryef",
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const fromVector = () => Buffer.from(VECTOR.scalar, "hex");

describe("Bech32", () => {
  it("accepts BIP 173's valid strings and rejects its invalid ones", () => {
    for (const valid of [
      "A12UEL5L",
      "a12uel5l",
      "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
      "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
      "?1ezyfcl",
    ]) {
      const decoded = bech32Decode(valid);
      expect(decoded, valid).toBeDefined();
      expect(bech32Encode(decoded?.hrp ?? "", decoded?.bytes ?? new Uint8Array())).toBe(
        valid.toLowerCase(),
      );
    }
    for (const invalid of [
      "pzry9x0s0muk",
      "1pzry9x0s0muk",
      "x1b4n0q5v",
      "li1dgmt3",
      "A1G7SGD8",
      "a12UEL5L",
    ]) {
      expect(bech32Decode(invalid), invalid).toBeUndefined();
    }
  });
});

describe("age keys", () => {
  it("matches age's published X25519 test key", () => {
    const { identity, recipient } = generateAgeIdentity(fromVector);
    expect(recipient).toBe(VECTOR.recipient);
    expect(sha256(identity)).toBe(VECTOR.identitySha256);
    expect(ageRecipientOf(identity)).toBe(VECTOR.recipient);
    expect(ageRecipientOf(`${identity}\n`)).toBe(VECTOR.recipient);
  });

  it("generates an upper-case identity and a lower-case recipient that belong together", () => {
    const first = generateAgeIdentity();
    const second = generateAgeIdentity();
    expect(first.identity).toMatch(/^AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}$/);
    expect(first.recipient).toMatch(/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/);
    expect(ageRecipientOf(first.identity)).toBe(first.recipient);
    expect(isAgeRecipient(first.recipient)).toBe(true);
    expect(second.identity).not.toBe(first.identity);
  });

  it("recognises only valid lower-case X25519 recipients", () => {
    expect(isAgeRecipient(VECTOR.recipient)).toBe(true);
    const wrongChecksum = `${VECTOR.recipient.slice(0, -1)}q`;
    for (const bad of [
      VECTOR.recipient.toUpperCase(),
      wrongChecksum,
      ` ${VECTOR.recipient}`,
      bech32Encode("age", new Uint8Array(31)),
      bech32Encode("ssh", new Uint8Array(32)),
      "age1",
      "",
    ]) {
      expect(isAgeRecipient(bad), bad).toBe(false);
    }
    expect(isAgeRecipient(bech32Encode("age", new Uint8Array(32)))).toBe(true);
  });

  it("refuses a text that is not an identity, without repeating it", () => {
    const { identity, recipient } = generateAgeIdentity();
    const mixed = `${identity.slice(0, 20)}${identity.slice(20).toLowerCase()}`;
    const changed = `${identity.slice(0, -1)}${identity.endsWith("Q") ? "P" : "Q"}`;
    for (const bad of [recipient, mixed, identity.toLowerCase(), changed, ""]) {
      let message = "";
      try {
        ageRecipientOf(bad);
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/not an age identity/);
      if (bad !== "") expect(message).not.toContain(bad.slice(16, 40));
    }
  });
});

/** `encrypted` through {@link ageDecryptStream}, written in `piece`-byte writes. */
async function decrypt(encrypted: Buffer, identity: string, piece = 1000): Promise<Buffer> {
  const pieces = function* () {
    for (let at = 0; at < encrypted.length; at += piece) yield encrypted.subarray(at, at + piece);
  };
  const out = ageDecryptStream(identity);
  const [read] = await Promise.all([buffer(out), pipeline(Readable.from(pieces()), out)]);
  return read;
}

/** The error {@link decrypt} fails with. */
async function refusal(encrypted: Buffer, identity: string): Promise<{ code?: string }> {
  return decrypt(encrypted, identity).then(
    () => ({ code: "none" }),
    (error: { code?: string }) => error,
  );
}

describe("age decryption", () => {
  const sizes = [0, 1, 65_535, 65_536, 65_537, 3 * 65_536, 3 * 65_536 + 100];

  it("opens what age's format encrypts to a key generated here, streaming every size whole", async () => {
    const { identity, recipient } = generateAgeIdentity();
    const other = generateAgeIdentity().recipient;
    for (const size of sizes) {
      const plain = randomBytes(size);
      const encrypted = ageEncrypt(plain, [other, recipient]);
      expect((await decrypt(encrypted, identity)).equals(plain), String(size)).toBe(true);
      expect((await decrypt(encrypted, `${identity}\n`, 70_000)).equals(plain)).toBe(true);
    }
    // An age key file's text, as age-keygen writes it.
    const keyFile = `# created: 2026-11-07T00:00:00Z\r\n# public key: ${recipient}\r\n${identity}\r\n`;
    const plain = randomBytes(10);
    expect((await decrypt(ageEncrypt(plain, [recipient]), keyFile)).equals(plain)).toBe(true);
  });

  it("refuses a file not encrypted to the key, without its identity in the message", async () => {
    const { identity } = generateAgeIdentity();
    const encrypted = ageEncrypt(randomBytes(100), [generateAgeIdentity().recipient]);
    const error = (await refusal(encrypted, identity)) as { code?: string; message?: string };
    expect(error.code).toBe("SECRETS_KEY_REJECTED");
    expect(error.message).not.toContain(identity.slice(16));
  });

  it("refuses a changed chunk, a changed header, a truncated file and added bytes", async () => {
    const { identity, recipient } = generateAgeIdentity();
    const plain = randomBytes(3 * 65_536 + 100);
    const encrypted = ageEncrypt(plain, [recipient]);
    const headerEnd = encrypted.indexOf("\n", encrypted.indexOf("\n--- ") + 1) + 1;
    const flip = (at: number) => {
      const copy = Buffer.from(encrypted);
      copy[at] = (copy[at] as number) ^ 1;
      return copy;
    };
    const firstChunk = headerEnd + 16;
    for (const bad of [
      flip(firstChunk + 10),
      flip(encrypted.length - 1),
      // Another version, and a stanza added: the header's MAC covers every stanza.
      Buffer.concat([
        Buffer.from(
          encrypted
            .subarray(0, headerEnd)
            .toString()
            .replace("age-encryption.org/v1", "age-encryption.org/v2"),
        ),
        encrypted.subarray(headerEnd),
      ]),
      Buffer.concat([
        Buffer.from(encrypted.subarray(0, headerEnd).toString().replace("\n---", "\n-> x\n\n---")),
        encrypted.subarray(headerEnd),
      ]),
      encrypted.subarray(0, firstChunk + 2 * 65_552),
      encrypted.subarray(0, encrypted.length - 5),
      encrypted.subarray(0, headerEnd - 3),
      Buffer.concat([encrypted, Buffer.from("more")]),
    ]) {
      const error = await refusal(bad, identity);
      expect(error.code).toBe("ARTIFACT_INVALID");
    }
    // A changed MAC itself.
    const macAt = encrypted.indexOf("\n--- ") + 6;
    const changedMac = Buffer.from(encrypted);
    changedMac[macAt] = changedMac[macAt] === 65 ? 66 : 65;
    expect((await refusal(changedMac, identity)).code).toBe("ARTIFACT_INVALID");
  });

  it("writes nothing of a chunk whose tag doesn't check", async () => {
    const { identity, recipient } = generateAgeIdentity();
    const encrypted = ageEncrypt(randomBytes(2 * 65_536 + 7), [recipient]);
    const headerEnd = encrypted.indexOf("\n", encrypted.indexOf("\n--- ") + 1) + 1;
    const bad = Buffer.from(encrypted);
    const second = headerEnd + 16 + 65_552 + 3;
    bad[second] = (bad[second] as number) ^ 1;
    const out = ageDecryptStream(identity);
    const written: Buffer[] = [];
    out.on("data", (data: Buffer) => written.push(data));
    await expect(pipeline(Readable.from([bad]), out)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
    expect(Buffer.concat(written).length).toBe(65_536);
  });

  it("refuses an identity that is not one at once", () => {
    expect(() => ageDecryptStream(generateAgeIdentity().recipient)).toThrow(/not an age identity/);
    expect(() => ageEncrypt(Buffer.from("x"), [generateAgeIdentity().identity])).toThrow(
      /not an age recipient/,
    );
  });
});
