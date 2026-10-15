import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Real file-system, git and rename-retry tests are slow on Windows under parallel load.
    testTimeout: 30_000,
  },
});
