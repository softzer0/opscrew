import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // The adapter's tests start local HTTPS servers; under a full-repository run on Windows they
    // take far longer than vitest's 5 s default.
    testTimeout: 30_000,
  },
});
