import type { Scanner } from "@opscrew/contracts";

/** Placeholder until task T102 lands; reports itself unavailable so scans skip it. */
export function createConfigScanner(): Scanner {
  return {
    id: "opscrew-config",
    kind: "builtin",
    isAvailable: async () => false,
    scan: async () => [],
  };
}
