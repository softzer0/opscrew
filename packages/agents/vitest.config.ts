import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real file-system, git and rename-retry tests are slow on Windows under parallel load, and the
    // own-server flows (provision, drift, destroy, Portainer with fakes) run about four times slower
    // when the whole repository is tested at once.
    testTimeout: 90_000,
  },
});
