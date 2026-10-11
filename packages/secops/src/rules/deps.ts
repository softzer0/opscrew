import type { Scanner } from "@opscrew/contracts";

/** Placeholder until task T105 lands; reports itself unavailable so scans skip it. */
export function createOsvScanner(): Scanner {
  return { id: "osv", kind: "builtin", isAvailable: async () => false, scan: async () => [] };
}
