import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { stackPlanFile } from "../provision/portainer";
import { hostPlanFile } from "./host-plan";
import { readSavedPlanChanges } from "./saved-plan";

const HASH = "ab".repeat(32);
const HINT = "Plan again.";
let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function projectPaths() {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-saved-plan-"));
  const paths = resolveProjectPaths(dir, { env: { OPSCREW_HOME: path.join(dir, "home") } });
  await mkdir(paths.files.plansDir, { recursive: true });
  return paths;
}

describe("readSavedPlanChanges", () => {
  it("is undefined only when no such plan was saved", async () => {
    const paths = await projectPaths();
    expect(await readSavedPlanChanges(paths, "host", HASH, HINT)).toBeUndefined();
    expect(await readSavedPlanChanges(paths, "stack", HASH, HINT)).toBeUndefined();
  });

  it("tells whether a saved host or stack plan changes something", async () => {
    const paths = await projectPaths();
    const host = hostPlanFile(paths, HASH);
    await writeFile(host, JSON.stringify({ steps: [{ state: "in-place" }, { state: "change" }] }));
    expect(await readSavedPlanChanges(paths, "host", HASH, HINT)).toBe(true);
    await writeFile(host, JSON.stringify({ steps: [{ state: "in-place" }] }));
    expect(await readSavedPlanChanges(paths, "host", HASH, HINT)).toBe(false);

    const stack = stackPlanFile(paths, HASH);
    await writeFile(stack, JSON.stringify({ changes: [{ state: "change" }] }));
    expect(await readSavedPlanChanges(paths, "stack", HASH, HINT)).toBe(true);
    await writeFile(stack, JSON.stringify({ changes: [{ state: "in-place" }] }));
    expect(await readSavedPlanChanges(paths, "stack", HASH, HINT)).toBe(false);
  });

  it("rethrows a read error other than a missing file instead of hiding the plan", async () => {
    const paths = await projectPaths();
    // A directory where the plan file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(hostPlanFile(paths, HASH));
    await expect(readSavedPlanChanges(paths, "host", HASH, HINT)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("stops with a plain message for a damaged plan, never taking it for no change", async () => {
    const paths = await projectPaths();
    await writeFile(hostPlanFile(paths, HASH), "{ not json");
    await expect(readSavedPlanChanges(paths, "host", HASH, HINT)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining(`The saved host plan ${HASH}`),
      hint: HINT,
    });
    // A stack plan's file read as a host plan (or any other shape) is damaged too.
    await writeFile(stackPlanFile(paths, HASH), JSON.stringify({ steps: [] }));
    await expect(readSavedPlanChanges(paths, "stack", HASH, HINT)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("is damaged"),
    });
  });
});
