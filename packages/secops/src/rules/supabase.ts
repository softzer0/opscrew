import type { Scanner } from "@opscrew/contracts";

/** Placeholder until task T104 lands; reports itself unavailable so scans skip it. */
export function createSupabaseScanner(): Scanner {
  return {
    id: "opscrew-supabase",
    kind: "builtin",
    isAvailable: async () => false,
    scan: async () => [],
  };
}
