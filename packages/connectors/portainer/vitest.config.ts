import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The adapter's tests start local HTTPS servers; under a full-repository run on Windows they
    // take far longer than vitest's 5 s default.
    testTimeout: 30_000,
  },
});
