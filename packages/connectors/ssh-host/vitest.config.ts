import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The host scripts run in a real shell; under a full-repository run on Windows they take far
    // longer than vitest's 5 s default.
    testTimeout: 30_000,
  },
});
