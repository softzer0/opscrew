import type { Clock } from "@opscrew/contracts";

/** This computer's clock: the default wherever a {@link Clock} can be injected. */
export const systemClock: Clock = { now: () => new Date() };

/** Waits `ms` milliseconds: the default wherever a `sleep` can be injected. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
