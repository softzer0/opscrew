import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Scanner and policy tests on real files are slow on Windows when the whole repository runs.
    testTimeout: 30_000,
  },
});
