import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests sit next to the code; the end-to-end flow over `examples/` lives in test/e2e;
    // test/live runs against real clouds and skips itself unless OPSCREW_E2E_* is set (docs/e2e.md).
    include: ["src/**/*.test.ts", "test/e2e/**/*.test.ts", "test/live/**/*.test.ts"],
    // Real git and file-system tests are slow on Windows under parallel load.
    testTimeout: 30_000,
  },
});
