import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Unit tests sit next to the code; the end-to-end flow over `examples/` lives in test/e2e;
    // test/live runs against real clouds and skips itself unless OPSCREW_E2E_* is set (docs/e2e.md).
    include: ["src/**/*.test.ts", "test/e2e/**/*.test.ts", "test/live/**/*.test.ts"],
    // Real git and file-system tests are slow on Windows under parallel load, and the full flows
    // (retarget, own servers) run several times slower when every package is tested at once.
    testTimeout: 60_000,
  },
});
