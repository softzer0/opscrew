import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // The host scripts run in a real shell; under a full-repository run on Windows, with other
    // suites in parallel, they take far longer than vitest's 5 s default (30 s was passed too).
    testTimeout: 120_000,
  },
});
