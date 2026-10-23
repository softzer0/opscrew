import { describe, expect, it } from "vitest";
import { lowestAllowed, parseVersion, satisfiesRange, type Version } from "./npm-range";

const v = (text: string) => parseVersion(text) as Version;

describe("satisfiesRange", () => {
  // The shapes the four adapters' peer dependencies use, and npm's rules for each.
  const cases: [string, string, boolean][] = [
    ["^7.4.0", "7.4.0", true],
    ["^7.4.0", "7.9.1", true],
    ["^7.4.0", "7.3.8", false],
    ["^7.4.0", "8.0.0", false],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.4", false],
    ["~7.3.0", "7.3.9", true],
    ["~7.3.0", "7.4.0", false],
    ["~7", "7.9.0", true],
    [">=15.5.0 <17", "16.4.2", true],
    [">=15.5.0 <17", "17.0.0", false],
    [">=15.5.0 <17", "15.4.9", false],
    [">= 15.5.0 < 17.0.0", "16.0.0", true],
    ["^14.2.35 || ~15.0.7 || ^16.0.10", "15.0.8", true],
    ["^14.2.35 || ~15.0.7 || ^16.0.10", "15.1.0", false],
    ["^14.2.35 || ~15.0.7 || ^16.0.10", "16.4.2", true],
    ["^2.0.0 || ^3.0.0", "3.0.1", true],
    ["16.x", "16.4.2", true],
    ["16.x", "17.0.0", false],
    ["16", "16.9.9", true],
    ["7.3.8", "7.3.8", true],
    ["7.3.8", "7.3.9", false],
    ["1.2 - 2", "2.9.0", true],
    ["1.2 - 2", "3.0.0", false],
    ["1.2 - 2", "1.1.9", false],
    ["<=16.4", "16.4.9", true],
    ["<=16.4", "16.5.0", false],
    [">16", "16.9.9", false],
    [">16", "17.0.0", true],
    [">16.4.2", "16.4.3", true],
    ["*", "1.0.0", true],
    ["", "1.0.0", true],
    [">=16.0.0-canary.1", "16.0.0", true],
  ];
  it.each(cases)("%s with %s is %s", (range, version, expected) => {
    expect(satisfiesRange(range, v(version))).toBe(expected);
  });

  it("cannot read tags, workspace specs or URLs", () => {
    for (const range of ["latest", "workspace:*", "github:withastro/adapters", "^7.4.0 || next"]) {
      expect(satisfiesRange(range, v("7.4.0")), range).toBeUndefined();
    }
  });
});

describe("lowestAllowed", () => {
  it("reads the lowest release a package.json spec allows", () => {
    expect(lowestAllowed("7.3.8")).toEqual([7, 3, 8]);
    expect(lowestAllowed("^16.4.0")).toEqual([16, 4, 0]);
    expect(lowestAllowed("~7.3")).toEqual([7, 3, 0]);
    expect(lowestAllowed(">=7")).toEqual([7, 0, 0]);
    expect(lowestAllowed("7.x")).toEqual([7, 0, 0]);
    expect(lowestAllowed("16.0.0-canary.4")).toEqual([16, 0, 0]);
    expect(lowestAllowed(">=7 <8")).toEqual([7, 0, 0]);
  });

  it("gives nothing for a spec without a lowest release", () => {
    for (const spec of ["latest", "*", "workspace:*", "<8", "github:vercel/next.js"]) {
      expect(lowestAllowed(spec), spec).toBeUndefined();
    }
  });
});
