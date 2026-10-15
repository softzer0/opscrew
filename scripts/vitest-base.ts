import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";

/**
 * Test options every package's `vitest.config.ts` spreads into its `test` block: one temporary
 * folder per run, removed afterwards (see `scripts/vitest-global-setup.ts`).
 */
export const sharedTestOptions = {
  globalSetup: [fileURLToPath(new URL("./vitest-global-setup.ts", import.meta.url))],
} satisfies NonNullable<ViteUserConfig["test"]>;
