import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Real file-system, git and rename-retry tests are slow on Windows under parallel load, and the
    // own-server flows (provision, drift, destroy, Portainer with fakes) run about four times slower
    // when the whole repository is tested at once; beside other test runs on the same machine, a test
    // that takes 40 s alone passed 90 s. A hang still fails, after 5 minutes.
    testTimeout: 300_000,
  },
});
