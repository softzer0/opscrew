import { describe, expect, it } from "vitest";
import { listText, normalizeHostName, plural } from "./text";

describe("listText", () => {
  it("joins items as plain English", () => {
    expect(listText([])).toBe("");
    expect(listText(["a"])).toBe("a");
    expect(listText(["a", "b"])).toBe("a and b");
    expect(listText(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("plural", () => {
  it("adds an s unless the count is 1", () => {
    expect(plural(0, "server")).toBe("0 servers");
    expect(plural(1, "server")).toBe("1 server");
    expect(plural(2, "server")).toBe("2 servers");
  });
});

describe("normalizeHostName", () => {
  it("trims, lower-cases and drops one trailing dot", () => {
    expect(normalizeHostName("  App.Example.COM. ")).toBe("app.example.com");
    expect(normalizeHostName("example.com")).toBe("example.com");
  });
});
