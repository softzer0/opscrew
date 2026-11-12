import { describe, expect, it } from "vitest";
import { PHP_BRANCHES, PHP_BRANCHES_READ, phpSupport } from "./php";

const on = (day: string) => new Date(`${day}T12:00:00Z`);

describe("PHP's supported versions", () => {
  it("is dated, newest first, each branch's bug fixes ending before its security fixes", () => {
    expect(PHP_BRANCHES_READ).toBe("2026-11-12");
    const branches = PHP_BRANCHES.map((b) => b.branch);
    expect(branches).toEqual([
      "8.5",
      "8.4",
      "8.3",
      "8.2",
      "8.1",
      "8.0",
      "7.4",
      "7.3",
      "7.2",
      "7.1",
      "7.0",
      "5.6",
    ]);
    for (const branch of PHP_BRANCHES) {
      if (branch.activeUntil !== undefined) {
        expect(branch.activeUntil < branch.securityUntil).toBe(true);
      }
    }
  });

  it("tells active support, security fixes only and end of life apart on a day", () => {
    const now = on(PHP_BRANCHES_READ);
    expect(phpSupport("8.5", now)).toMatchObject({ state: "active" });
    expect(phpSupport("8.4.14", now)).toMatchObject({ state: "active" });
    expect(phpSupport("8.3", now)).toMatchObject({
      state: "security",
      branch: { securityUntil: "2027-12-31" },
    });
    expect(phpSupport("8.2", now)).toMatchObject({ state: "security" });
    expect(phpSupport("8.1", now)).toMatchObject({ state: "end-of-life" });
    expect(phpSupport("7.0.33", now)).toMatchObject({
      state: "end-of-life",
      branch: { securityUntil: "2019-01-10" },
    });
    // The last day of a branch's fixes still counts; the day after doesn't.
    expect(phpSupport("8.2", on("2026-12-31"))).toMatchObject({ state: "security" });
    expect(phpSupport("8.2", on("2027-01-01"))).toMatchObject({ state: "end-of-life" });
    expect(phpSupport("8.4", on("2027-01-01"))).toMatchObject({ state: "security" });
  });

  it("knows no branch the table doesn't list", () => {
    expect(phpSupport("9.0", on("2026-11-12"))).toEqual({ state: "unknown" });
    expect(phpSupport("5.4", on("2026-11-12"))).toEqual({ state: "unknown" });
    expect(phpSupport("latest", on("2026-11-12"))).toEqual({ state: "unknown" });
  });
});
