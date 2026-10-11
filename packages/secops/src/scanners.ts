import type { Scanner } from "@opscrew/contracts";
import { createGitleaksScanner, createOsvScannerCli, createTrivyScanner } from "./external";
import { createConfigScanner } from "./rules/config";
import { createOsvScanner } from "./rules/deps";
import { createFirebaseScanner } from "./rules/firebase";
import { createSecretsScanner } from "./rules/secrets";
import { createSupabaseScanner } from "./rules/supabase";

export interface DefaultScannerOptions {
  /** Include optional external scanners (gitleaks, osv-scanner, trivy). Default true. */
  includeExternal?: boolean;
}

/**
 * The scanners `opscrew scan` runs by default. External scanners report themselves unavailable when
 * their binary is missing; the OSV API scanner reports itself skipped when `osv-scanner` is
 * installed (it supersedes the API lookup). Lead-owned registry.
 */
export function defaultScanners(options: DefaultScannerOptions = {}): Scanner[] {
  const builtin = [
    createSecretsScanner(),
    createConfigScanner(),
    createSupabaseScanner(),
    createFirebaseScanner(),
    createOsvScanner(),
  ];
  if (options.includeExternal === false) return builtin;
  return [...builtin, createGitleaksScanner(), createOsvScannerCli(), createTrivyScanner()];
}
