import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
    snapshotSerializers: [fileURLToPath(new URL("./src/pin-snapshots.ts", import.meta.url))],
  },
});
