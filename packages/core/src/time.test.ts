import { describe, expect, it } from "vitest";
import { realSleep, systemClock } from "./time";

describe("systemClock", () => {
  it("tells the current time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("realSleep", () => {
  it("resolves after the wait", async () => {
    const start = Date.now();
    await expect(realSleep(20)).resolves.toBeUndefined();
    // Timers may fire a millisecond early on some platforms.
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
