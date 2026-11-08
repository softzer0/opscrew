import { describe, expect, it } from "vitest";
import { encryptionSecrets, hclString, stateKeyName, tofuEncryptionEnv } from "./encryption";

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

  it("without previous, is exactly the single key provider and method", () => {
    expect(tofuEncryptionEnv("correct-horse-battery-staple")).toBe(
      [
        'key_provider "pbkdf2" "opscrew" {',
        '  passphrase = "correct-horse-battery-staple"',
        "}",
        'method "aes_gcm" "opscrew" {',
        "  keys = key_provider.pbkdf2.opscrew",
        "}",
        "state {",
        "  method = method.aes_gcm.opscrew",
        "}",
        "plan {",
        "  method = method.aes_gcm.opscrew",
        "}",
        "",
      ].join("\n"),
    );
    expect(tofuEncryptionEnv("correct-horse-battery-staple", {})).toBe(
      tofuEncryptionEnv("correct-horse-battery-staple"),
    );
  });

  it("with previous, writes with a new key provider and method and reads the old as fallback", () => {
    expect(tofuEncryptionEnv("the-new-passphrase-2", { previous: "the-old-passphrase-1" })).toBe(
      [
        'key_provider "pbkdf2" "opscrew" {',
        '  passphrase = "the-old-passphrase-1"',
        "}",
        'method "aes_gcm" "opscrew" {',
        "  keys = key_provider.pbkdf2.opscrew",
        "}",
        'key_provider "pbkdf2" "opscrew_next" {',
        '  passphrase = "the-new-passphrase-2"',
        "}",
        'method "aes_gcm" "opscrew_next" {',
        "  keys = key_provider.pbkdf2.opscrew_next",
        "}",
        "state {",
        "  method = method.aes_gcm.opscrew_next",
        "  fallback {",
        "    method = method.aes_gcm.opscrew",
        "  }",
        "}",
        "plan {",
        "  method = method.aes_gcm.opscrew_next",
        "  fallback {",
        "    method = method.aes_gcm.opscrew",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("under the name opscrew_next, uses it alone, and with previous writes under opscrew", () => {
    expect(tofuEncryptionEnv("correct-horse-battery-staple", { name: "opscrew_next" })).toBe(
      tofuEncryptionEnv("correct-horse-battery-staple").replaceAll("opscrew", "opscrew_next"),
    );
    expect(tofuEncryptionEnv("correct-horse-battery-staple", { name: "opscrew" })).toBe(
      tofuEncryptionEnv("correct-horse-battery-staple"),
    );
    expect(
      tofuEncryptionEnv("the-new-passphrase-2", {
        name: "opscrew_next",
        previous: "the-old-passphrase-1",
      }),
    ).toBe(
      [
        'key_provider "pbkdf2" "opscrew_next" {',
        '  passphrase = "the-old-passphrase-1"',
        "}",
        'method "aes_gcm" "opscrew_next" {',
        "  keys = key_provider.pbkdf2.opscrew_next",
        "}",
        'key_provider "pbkdf2" "opscrew" {',
        '  passphrase = "the-new-passphrase-2"',
        "}",
        'method "aes_gcm" "opscrew" {',
        "  keys = key_provider.pbkdf2.opscrew",
        "}",
        "state {",
        "  method = method.aes_gcm.opscrew",
        "  fallback {",
        "    method = method.aes_gcm.opscrew_next",
        "  }",
        "}",
        "plan {",
        "  method = method.aes_gcm.opscrew",
        "  fallback {",
        "    method = method.aes_gcm.opscrew_next",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("with previous, escapes both passphrases and registers both as secrets", () => {
    const previous = `old"\${x} long enough`;
    const value = tofuEncryptionEnv("new-passphrase-long", { previous });
    expect(value).toContain('passphrase = "old\\"$${x} long enough"');
    expect(encryptionSecrets(value)).toEqual(
      expect.arrayContaining([previous, "new-passphrase-long"]),
    );
  });

  it("rejects a previous passphrase shorter than 16 characters", () => {
    expect(() => tofuEncryptionEnv("new-passphrase-long", { previous: "short" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
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

describe("stateKeyName", () => {
  const encrypted = (keys: string[]) =>
    JSON.stringify({
      serial: 3,
      lineage: "l",
      meta: Object.fromEntries(keys.map((k) => [k, "bWV0YQ=="])),
      encrypted_data: "ZGF0YQ==",
      encryption_version: "v0",
    });

  it("names the key provider in the encrypted state's meta", () => {
    expect(stateKeyName(encrypted(["key_provider.pbkdf2.opscrew"]))).toBe("opscrew");
    expect(stateKeyName(encrypted(["key_provider.pbkdf2.opscrew_next"]))).toBe("opscrew_next");
  });

  it("is opscrew_next for a meta naming both", () => {
    expect(
      stateKeyName(encrypted(["key_provider.pbkdf2.opscrew", "key_provider.pbkdf2.opscrew_next"])),
    ).toBe("opscrew_next");
  });

  it("is opscrew for no state, an unencrypted state or a meta naming neither", () => {
    expect(stateKeyName(undefined)).toBe("opscrew");
    expect(stateKeyName(JSON.stringify({ version: 4, resources: [] }))).toBe("opscrew");
    expect(stateKeyName(encrypted(["key_provider.pbkdf2.other"]))).toBe("opscrew");
  });

  it("refuses text that is not JSON", () => {
    expect(() => stateKeyName("not json")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
