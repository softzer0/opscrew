import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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
