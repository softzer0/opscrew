import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scanner and policy tests on real files are slow on Windows when the whole repository runs.
    testTimeout: 30_000,
  },
});
