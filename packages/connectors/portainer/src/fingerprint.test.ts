import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeCertFingerprint, sameCertFingerprint } from "./fingerprint";

const digest = createHash("sha256").update("opscrew test certificate").digest();
const hex = digest.toString("hex").toUpperCase();
const pairs = hex.match(/../g)?.join(":") ?? "";
const canonical = `SHA256:${pairs}`;

describe("normalizeCertFingerprint", () => {
  it("keeps the canonical form: SHA256: and upper-case colon-separated hex pairs", () => {
    expect(normalizeCertFingerprint(canonical)).toBe(canonical);
  });

  it("accepts every form server.json accepts and the forms people copy", () => {
    const forms = [
      `SHA256:${hex}`,
      `SHA256:${hex.toLowerCase()}`,
      `SHA256:${pairs.toLowerCase()}`,
      `SHA256:${digest.toString("base64").replace(/=+$/, "")}`,
      `SHA256:${digest.toString("base64")}`,
      pairs,
      hex,
      `sha256 Fingerprint=${pairs}`,
      `SHA-256: ${pairs}`,
      `  ${canonical}\n`,
      pairs.replaceAll(":", " "),
    ];
    for (const form of forms) expect(normalizeCertFingerprint(form), form).toBe(canonical);
  });

  it("refuses anything that is not a SHA-256 fingerprint", () => {
    for (const bad of [
      "",
      "SHA256:",
      "SHA1:AB:CD",
      `SHA256:${hex.slice(2)}`,
      `SHA256:${hex}00`,
      `SHA256:${hex.slice(0, 62)}ZZ`,
      "SHA256:not-base64-at-all-not-base64-at-all-not-base",
      `MD5:${pairs}`,
    ]) {
      expect(normalizeCertFingerprint(bad), bad).toBeUndefined();
    }
  });

  it("compares fingerprints whatever form they were written in", () => {
    expect(sameCertFingerprint(canonical, hex.toLowerCase())).toBe(true);
    expect(sameCertFingerprint(canonical, `SHA256:${digest.toString("base64")}`)).toBe(true);
    const other = createHash("sha256").update("another").digest("hex");
    expect(sameCertFingerprint(canonical, other)).toBe(false);
    expect(sameCertFingerprint(canonical, "garbage")).toBe(false);
  });
});
