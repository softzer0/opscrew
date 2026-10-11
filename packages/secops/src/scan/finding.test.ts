import { createHash } from "node:crypto";
import type { Finding, Severity } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { countFindings, createFinding, findingId, SEVERITY_RANK, sortFindings } from "./finding";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "0000000000000000",
    ruleId: "secrets/github-token",
    title: "t",
    severity: "high",
    category: "secret",
    description: "d",
    remediation: "r",
    source: "opscrew-secrets",
    ...overrides,
  };
}

describe("findingId", () => {
  it("is the first 16 hex of sha256(ruleId|file|line|sha256(rawMatch))", () => {
    const expected = sha256(`secrets/x|src/a.ts|3|${sha256("raw")}`).slice(0, 16);
    expect(findingId("secrets/x", "src/a.ts", 3, "raw")).toBe(expected);
  });

  it("is stable and changes with every input", () => {
    const base = findingId("secrets/x", "a.ts", 1, "raw");
    expect(findingId("secrets/x", "a.ts", 1, "raw")).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    const variants = [
      findingId("secrets/y", "a.ts", 1, "raw"),
      findingId("secrets/x", "b.ts", 1, "raw"),
      findingId("secrets/x", "a.ts", 2, "raw"),
      findingId("secrets/x", "a.ts", 1, "other"),
      findingId("secrets/x", undefined, undefined, "raw"),
    ];
    expect(new Set([base, ...variants]).size).toBe(6);
  });
});

describe("createFinding", () => {
  it("adds the id, drops the raw match and omits undefined optional fields", () => {
    const result = createFinding({
      ruleId: "config/x",
      title: "t",
      severity: "low",
      category: "config",
      file: "Dockerfile",
      line: undefined,
      description: "d",
      remediation: "r",
      source: "opscrew-config",
      rawMatch: "secret-value-123",
    });
    expect(result.id).toBe(findingId("config/x", "Dockerfile", undefined, "secret-value-123"));
    expect(Object.keys(result)).not.toContain("line");
    expect(Object.keys(result)).not.toContain("rawMatch");
    expect(JSON.stringify(result)).not.toContain("secret-value-123");
  });
});

describe("SEVERITY_RANK", () => {
  it("orders critical above info", () => {
    const order: Severity[] = ["critical", "high", "medium", "low", "info"];
    const ranks = order.map((severity) => SEVERITY_RANK[severity]);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(5);
  });
});

describe("sortFindings", () => {
  it("sorts by severity, then file, then line, with file-less findings last", () => {
    const input = [
      finding({ id: "1", severity: "low", file: "a", line: 1 }),
      finding({ id: "2", severity: "critical", file: "b", line: 10 }),
      finding({ id: "3", severity: "critical", file: "b", line: 2 }),
      finding({ id: "4", severity: "critical" }),
      finding({ id: "5", severity: "critical", file: "a", line: 99 }),
      finding({ id: "6", severity: "high", file: "a" }),
      finding({ id: "7", severity: "high", file: "a", line: 1 }),
    ];
    const sorted = sortFindings(input);
    expect(sorted.map((f) => f.id)).toEqual(["5", "3", "2", "4", "7", "6", "1"]);
    expect(input[0]?.id).toBe("1");
  });
});

describe("countFindings", () => {
  it("counts every severity, including zeros", () => {
    const counts = countFindings([
      finding({ severity: "critical" }),
      finding({ severity: "critical" }),
      finding({ severity: "low" }),
    ]);
    expect(counts).toEqual({ critical: 2, high: 0, medium: 0, low: 1, info: 0 });
  });
});
