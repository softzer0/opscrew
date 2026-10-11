import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real file-system, git and rename-retry tests are slow on Windows under parallel load.
    testTimeout: 30_000,
  },
});
