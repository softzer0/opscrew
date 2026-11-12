import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // The real-binary tests set up their engines in hooks (a provider install, an init), which passed
    // the 10 s default while other suites ran on the machine.
    hookTimeout: 120_000,
  },
});
