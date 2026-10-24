import { describe, expect, it } from "vitest";
import { promotedText } from "./text";

describe("promotedText", () => {
  it("names a site's build by its run and SHA-256, a rollback's version, or the image", () => {
    const sha256 = "a".repeat(64);
    expect(promotedText({ build: { runId: 102, sha256 } })).toBe(
      `the build of run 102 (SHA-256 ${sha256})`,
    );
    expect(promotedText({ version: "v-old" })).toBe("version v-old");
    const digest = `sha256:${"b".repeat(64)}`;
    expect(promotedText({ digest })).toBe(digest);
  });
});
