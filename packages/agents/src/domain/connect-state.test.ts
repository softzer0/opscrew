import { describe, expect, it } from "vitest";
import { dsWaitSeconds, laterSwitch } from "./connect-state";

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

describe("laterSwitch", () => {
  const state = {
    domain: "example.com",
    registrar: "porkbun" as const,
    switchAfter: "2026-10-12T14:00:00.000Z",
    waitSeconds: 86_400,
  };

  it("only ever moves the switch time later", () => {
    expect(laterSwitch(state, Date.parse("2026-10-13T15:00:00.000Z"))).toBe(
      "2026-10-13T15:00:00.000Z",
    );
    expect(laterSwitch(state, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "2026-10-12T14:00:00.000Z",
    );
    expect(laterSwitch(undefined, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "2026-10-12T13:00:00.000Z",
    );
    const seen = { ...state, switchAfter: undefined, dsSeen: "2026-10-11T12:00:00.000Z" };
    expect(laterSwitch(seen, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "2026-10-12T13:00:00.000Z",
    );
  });
});
