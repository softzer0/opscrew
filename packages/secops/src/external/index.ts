import type { Scanner } from "@opscrew/contracts";

/** Placeholders until task T105 lands; they report themselves unavailable. */
export function createGitleaksScanner(): Scanner {
  return { id: "gitleaks", kind: "external", isAvailable: async () => false, scan: async () => [] };
}
export function createOsvScannerCli(): Scanner {
  return {
    id: "osv-scanner",
    kind: "external",
    isAvailable: async () => false,
    scan: async () => [],
  };
}
export function createTrivyScanner(): Scanner {
  return { id: "trivy", kind: "external", isAvailable: async () => false, scan: async () => [] };
}
