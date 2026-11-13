import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    // Tests that read every snapshot file or run shell scripts passed the 5 s default while other test
    // runs shared the machine (the pin-snapshot scan takes under 2 s alone).
    testTimeout: 60_000,
    snapshotSerializers: [fileURLToPath(new URL("./src/pin-snapshots.ts", import.meta.url))],
  },
});
