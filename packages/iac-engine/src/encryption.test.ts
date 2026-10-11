import { describe, expect, it } from "vitest";
import { encryptionSecrets, hclString, tofuEncryptionEnv } from "./encryption";

describe("tofuEncryptionEnv", () => {
  it("produces pbkdf2 + aes_gcm for state and plan", () => {
    const value = tofuEncryptionEnv("correct-horse-battery-staple");
    expect(value).toContain('key_provider "pbkdf2" "opscrew" {');
    expect(value).toContain('  passphrase = "correct-horse-battery-staple"');
    expect(value).toContain('method "aes_gcm" "opscrew" {');
    expect(value).toContain("keys = key_provider.pbkdf2.opscrew");
    expect(value).toMatch(/state \{\n {2}method = method\.aes_gcm\.opscrew\n\}/);
    expect(value).toMatch(/plan \{\n {2}method = method\.aes_gcm\.opscrew\n\}/);
  });

  it("escapes quotes, backslashes, newlines and template sequences", () => {
    const passphrase = `a"b\\c\nd \${var.x} %{if} long enough`;
    const value = tofuEncryptionEnv(passphrase);
    expect(value).toContain('passphrase = "a\\"b\\\\c\\nd $${var.x} %%{if} long enough"');
    expect(encryptionSecrets(value)).toContain(passphrase);
  });

  it("rejects passphrases shorter than 16 characters", () => {
    expect(() => tofuEncryptionEnv("short")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("hclString escapes control characters", () => {
    expect(hclString("a\u0001b\tc")).toBe('"a\\u0001b\\tc"');
  });
});
