/**
 * The phases below read cloud provider facts from the registry (`@opscrew/providers`, ADR 0029,
 * FR-2601): no code in them names Hetzner's or DigitalOcean's id, except the object-storage code,
 * where they are bucket providers, a choice of its own (026 plan 3).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** The folders that read cloud provider facts from the registry, not from tables. */
const FOLDERS = [
  "providers",
  "design",
  "interview",
  "init",
  "shared",
  "retarget",
  "provision",
  "destroy",
  "advise",
  "rotate",
  "snapshot",
  "secure",
  "environments",
  "drift",
  "verify",
  "status",
  "serverless",
  "runners",
  "monitoring",
  "logs",
  "localhost",
];

/** The object-storage code: `hetzner` and `digitalocean` are bucket providers there. */
const OBJECT_STORAGE = new Set([
  "design/storage.ts",
  "provision/storage.ts",
  "retarget/bucket.ts",
  "snapshot/offsite.ts",
]);

/** True for code: not a test, a test's fakes or a fixture. */
function isCode(path: string): boolean {
  return (
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".fakes.ts") &&
    !path.includes("__fixtures__/")
  );
}

/** Each line of code that quotes a cloud provider's id: `file: line`. */
function quotedIds(): string[] {
  return FOLDERS.flatMap((folder) =>
    readdirSync(join(SRC, folder), { recursive: true, encoding: "utf8" })
      .map((file) => `${folder}/${file.replaceAll("\\", "/")}`)
      .filter((file) => isCode(file) && !OBJECT_STORAGE.has(file))
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
  it("are never quoted outside the object-storage code", () => {
    expect(quotedIds()).toEqual([
      // A bucket at Hetzner or DigitalOcean (Spaces) stays wherever the app runs.
      'design/components.ts: old.provider === "hetzner" ||',
      'design/components.ts: old.provider === "digitalocean");',
      // Spaces signs with us-east-1, whatever the bucket's region.
      'shared/s3.ts: region: bucket.provider === "digitalocean" ? "us-east-1" : bucket.region,',
    ]);
  });
});
