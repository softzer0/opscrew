import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** The folders that read cloud provider facts from the registry (ADR 0029), not from tables. */
const FOLDERS = ["providers", "design", "interview", "init", "shared"];

/** The object-storage choice, whose bucket providers are a separate choice (026's plan 3). */
const BUCKET_CHOICE = "design/storage.ts";

/** Each line, outside tests and fixtures, that quotes a cloud provider's id: `file: line`. */
function quotedIds(): string[] {
  return FOLDERS.flatMap((folder) =>
    readdirSync(join(SRC, folder), { recursive: true, encoding: "utf8" })
      .map((file) => `${folder}/${file.replaceAll("\\", "/")}`)
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.includes("__fixtures__/") &&
          file !== BUCKET_CHOICE,
      )
      .sort()
      .flatMap((file) =>
        readFileSync(join(SRC, file), "utf8")
          .split("\n")
          .filter((line) => /"(hetzner|digitalocean)"/.test(line))
          .map((line) => `${file}: ${line.trim()}`),
      ),
  );
}

describe("cloud provider ids", () => {
  it("are never quoted outside the object-storage choice", () => {
    expect(quotedIds()).toEqual([
      // A bucket at Hetzner or DigitalOcean (Spaces) stays wherever the app runs.
      'design/components.ts: old.provider === "hetzner" ||',
      'design/components.ts: old.provider === "digitalocean");',
      // Spaces signs with us-east-1, whatever the bucket's region.
      'shared/s3.ts: region: bucket.provider === "digitalocean" ? "us-east-1" : bucket.region,',
    ]);
  });
});
