import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson, isRecord, sha256Hex, zodIssues } from "./values";

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

describe("zodIssues", () => {
  const Schema = z.object({ a: z.string(), b: z.number(), c: z.boolean(), d: z.string() });
  const error = Schema.safeParse({}).error as z.ZodError;

  it("names the first three problems by field path", () => {
    expect(zodIssues(error)).toBe(
      "a: Invalid input: expected string, received undefined; b: Invalid input: expected number, received undefined; c: Invalid input: expected boolean, received undefined",
    );
  });

  it("takes another maximum and a path in front", () => {
    expect(zodIssues(error, 1, ["items", 2])).toBe(
      "items.2.a: Invalid input: expected string, received undefined",
    );
    expect(zodIssues(error, Number.POSITIVE_INFINITY).split("; ")).toHaveLength(4);
  });

  it("calls a problem with the value itself (root)", () => {
    expect(zodIssues(z.string().safeParse(1).error as z.ZodError)).toBe(
      "(root): Invalid input: expected string, received number",
    );
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
