import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real git and file-system tests are slow on Windows under parallel load.
    testTimeout: 30_000,
  },
});
