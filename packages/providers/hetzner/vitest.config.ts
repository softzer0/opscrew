import { defineConfig } from "vitest/config";
import { sharedTestOptions } from "../../../scripts/vitest-base";

export default defineConfig({
  test: {
    ...sharedTestOptions,
  },
});
