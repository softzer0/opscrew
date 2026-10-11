import type { Scanner } from "@opscrew/contracts";

/** Placeholder until task T102 lands; reports itself unavailable so scans skip it. */
export function createSecretsScanner(): Scanner {
  return {
    id: "opscrew-secrets",
    kind: "builtin",
    isAvailable: async () => false,
    scan: async () => [],
  };
}
