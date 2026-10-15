import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Real git and file-system tests are slow on Windows under parallel load.
    testTimeout: 30_000,
  },
});
