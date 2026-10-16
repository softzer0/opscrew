import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, isRecord, sha256Hex } from "./values";

describe("isRecord", () => {
  it("is true for objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it("gives the same text whatever order the keys were written in", () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe(canonicalJson({ b: [1, 2], a: 1 }));
  });

  it("writes scalars and undefined array items as JSON does", () => {
    expect(canonicalJson([undefined, null, "x", 1.5, true])).toBe('[null,null,"x",1.5,true]');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson('quote"d')).toBe('"quote\\"d"');
  });
});

describe("sha256Hex", () => {
  it("hashes text as UTF-8 and bytes as they are, in lower-case hex", () => {
    const expected = createHash("sha256").update("grüße", "utf8").digest("hex");
    expect(sha256Hex("grüße")).toBe(expected);
    expect(sha256Hex(Buffer.from("grüße", "utf8"))).toBe(expected);
    expect(sha256Hex("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
