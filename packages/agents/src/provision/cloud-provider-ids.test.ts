/**
 * The phases outside `providers/`, `design/`, `interview/`, `init/`, `shared/` and `testing/` read
 * cloud provider facts from the registry (`@opscrew/providers`, ADR 0029, FR-2601): no code in them
 * names Hetzner's or DigitalOcean's id, except the object-storage code, where they are bucket
 * providers, a choice of its own (026 plan 3).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The folders whose provider facts T2607 moved to the registry. */
const FOLDERS = [
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
  "provision/storage.ts",
  "retarget/bucket.ts",
  "snapshot/offsite.ts",
]);

const QUOTED_ID = /"(?:hetzner|digitalocean)"/;

/** True for code: not a test, a test's fakes or a fixture. */
function isCode(path: string): boolean {
  return (
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".fakes.ts") &&
    !path.split("/").includes("__fixtures__")
  );
}

describe("cloud provider ids", () => {
  it("appear in no code of these phases outside object storage", async () => {
    const found: string[] = [];
    for (const folder of FOLDERS) {
      for (const entry of await readdir(join(SRC, folder), { recursive: true })) {
        const path = `${folder}/${entry.replaceAll("\\", "/")}`;
        if (!isCode(path) || OBJECT_STORAGE.has(path)) continue;
        const lines = (await readFile(join(SRC, path), "utf8")).split("\n");
        for (const line of lines) {
          if (QUOTED_ID.test(line)) found.push(`${path}: ${line.trim()}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
