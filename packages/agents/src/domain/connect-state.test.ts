import { describe, expect, it } from "vitest";
import { dsWaitSeconds, switchSafeAt } from "./connect-state";

describe("dsWaitSeconds", () => {
  it.each([
    [undefined, 86_400],
    [60, 86_400],
    [7200, 86_400],
    [86_400, 86_400],
    [108_000, 108_000],
    [172_800, 172_800],
    [604_800, 172_800],
  ])("waits %s seconds of TTL as %i seconds: at least 24 hours, at most 48", (ttl, wait) => {
    expect(dsWaitSeconds(ttl)).toBe(wait);
  });
});

describe("switchSafeAt", () => {
  const base = { domain: "example.com", registrar: "porkbun" as const, dsTtlSeconds: 86_400 };

  it("counts from the later of the removal and the public gone time; a removal adds an hour", () => {
    expect(switchSafeAt({ ...base, dsRemovedAt: "2026-10-11T12:00:00.000Z" })?.toISOString()).toBe(
      "2026-10-12T13:00:00.000Z",
    );
    expect(
      switchSafeAt({
        ...base,
        dsRemovedAt: "2026-10-11T12:00:00.000Z",
        dsGoneSeenAt: "2026-10-11T13:00:00.000Z",
      })?.toISOString(),
    ).toBe("2026-10-12T14:00:00.000Z");
    expect(switchSafeAt({ ...base, dsGoneSeenAt: "2026-10-11T15:00:00.000Z" })?.toISOString()).toBe(
      "2026-10-12T15:00:00.000Z",
    );
    expect(switchSafeAt({ ...base, dsSeenAt: "2026-10-11T12:00:00.000Z" })).toBeUndefined();
  });
});
