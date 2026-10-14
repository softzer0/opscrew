import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostPlanFile } from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { hostPlanChanges } from "./provision";

const HASH = "ab".repeat(32);
let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function paths() {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-host-plan-"));
  const resolved = resolveProjectPaths(dir, { env: { OPSCREW_HOME: path.join(dir, "home") } });
  await mkdir(resolved.files.plansDir, { recursive: true });
  return { paths: resolved };
}

describe("hostPlanChanges", () => {
  it("is false only when no host plan was saved", async () => {
    expect(await hostPlanChanges(await paths(), HASH)).toBe(false);
  });

  it("tells whether a saved host plan changes something", async () => {
    const deps = await paths();
    const file = hostPlanFile(deps.paths, HASH);
    await writeFile(file, JSON.stringify({ steps: [{ state: "in-place" }, { state: "change" }] }));
    expect(await hostPlanChanges(deps, HASH)).toBe(true);
    await writeFile(file, JSON.stringify({ steps: [{ state: "in-place" }] }));
    expect(await hostPlanChanges(deps, HASH)).toBe(false);
  });

  it("rethrows a read error other than a missing file instead of hiding the plan", async () => {
    const deps = await paths();
    // A directory where the plan file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(hostPlanFile(deps.paths, HASH));
    await expect(hostPlanChanges(deps, HASH)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("stops with a plain message for a damaged host plan", async () => {
    const deps = await paths();
    await writeFile(hostPlanFile(deps.paths, HASH), "{ not json");
    await expect(hostPlanChanges(deps, HASH)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("is damaged"),
    });
  });
});
