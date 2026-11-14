import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  appProgressFile,
  clearPending,
  clearSwitchProgress,
  clearWindow,
  pendingMatches,
  readAppProgress,
  readSwitchProgress,
  recordWindowStop,
  switchProgressFile,
  writePending,
  writeSwitchProgress,
} from "./progress";
import { leaksToken, twoAccounts } from "./record.fakes";

const HASH = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const SHADOW = { action: "shadow-create", environment: "prod", root: "main" } as const;

describe("the app's local file", () => {
  it("lies beside the app's prod state, for every environment of a further app", async () => {
    const first = await createTestPhaseDeps({ environment: "staging" });
    expect(appProgressFile(first.paths)).toBe(
      join(first.paths.root, ".opscrew", "cloudflare-move.json"),
    );
    const further = await createTestPhaseDeps({ app: "docs", environment: "staging" });
    expect(appProgressFile(further.paths)).toBe(
      join(further.paths.root, ".opscrew", "apps", "docs", "cloudflare-move.json"),
    );
  });

  it("keeps the plan waiting for --approve, matched by action, environment and root", async () => {
    const accounts = twoAccounts();
    const deps = await createTestPhaseDeps();
    Object.assign(deps.env, accounts.env);
    expect(await readAppProgress(deps.paths)).toEqual({});
    await writePending(deps, SHADOW, HASH.toUpperCase());
    const { pending } = await readAppProgress(deps.paths);
    expect(pending).toEqual({ ...SHADOW, planHash: HASH, savedAt: "2026-10-11T12:00:00.000Z" });
    expect(pendingMatches(pending, SHADOW, ` ${HASH.toUpperCase()} `)).toBe(true);
    expect(pendingMatches(pending, SHADOW, OTHER)).toBe(false);
    expect(pendingMatches(pending, SHADOW, undefined)).toBe(false);
    expect(pendingMatches(pending, { ...SHADOW, environment: "staging" }, HASH)).toBe(false);
    expect(pendingMatches(pending, { ...SHADOW, root: "storage" }, HASH)).toBe(false);
    expect(pendingMatches(pending, { action: "shared", environment: "prod" }, HASH)).toBe(false);

    // Another step's plan stays; this one's goes, and the file with it.
    await clearPending(deps, { action: "shared", environment: "prod" });
    expect((await readAppProgress(deps.paths)).pending).toEqual(pending);
    await clearPending(deps, SHADOW);
    expect(await readAppProgress(deps.paths)).toEqual({});
    expect(existsSync(appProgressFile(deps.paths))).toBe(false);

    // A zone-wide step names no environment or root.
    await writePending(deps, { action: "zone" }, HASH);
    const zone = (await readAppProgress(deps.paths)).pending;
    expect(pendingMatches(zone, { action: "zone" }, HASH)).toBe(true);
    expect(pendingMatches(zone, { action: "zone", environment: "prod" }, HASH)).toBe(false);
    const text = await readFile(appProgressFile(deps.paths), "utf8");
    expect(leaksToken(accounts, text)).toBe(false);
    expect(accounts.cloudflare.calls).toEqual([]);
  });

  it("keeps the window's stop beside the waiting plan", async () => {
    const deps = await createTestPhaseDeps();
    await writePending(deps, { action: "window", environment: "prod" }, HASH);
    await recordWindowStop(deps, "prod");
    const progress = await readAppProgress(deps.paths);
    expect(progress.window).toEqual({ environment: "prod", stoppedAt: "2026-10-11T12:00:00.000Z" });
    await clearPending(deps, { action: "window", environment: "prod" });
    expect(await readAppProgress(deps.paths)).toEqual({ window: progress.window });
    await clearWindow(deps);
    expect(existsSync(appProgressFile(deps.paths))).toBe(false);
  });

  it.each([
    ["not JSON", "{ pending"],
    ["another shape", JSON.stringify({ pending: { action: "zone", planHash: "x" } })],
    ["an unknown action", JSON.stringify({ pending: { action: "launch", planHash: HASH } })],
  ])("reads a damaged file (%s) as absent", async (_case, content) => {
    const deps = await createTestPhaseDeps();
    await mkdir(dirname(appProgressFile(deps.paths)), { recursive: true });
    await writeFile(appProgressFile(deps.paths), content);
    expect(await readAppProgress(deps.paths)).toEqual({});
    await writePending(deps, { action: "zone" }, HASH);
    expect((await readAppProgress(deps.paths)).pending?.planHash).toBe(HASH);
  });
});

describe("the repository's switch file", () => {
  it("round-trips the switch's times, and is deleted after its last step", async () => {
    const deps = await createTestPhaseDeps({ app: "docs", environment: "staging" });
    expect(switchProgressFile(deps.paths)).toBe(
      join(deps.paths.root, ".opscrew", "cloudflare-move-switch.json"),
    );
    expect(await readSwitchProgress(deps.paths)).toBeUndefined();
    const progress = {
      zone: "example.com",
      pending: { planHash: HASH, savedAt: "2026-11-21T08:59:00.000Z" },
      nameserversSetAt: "2026-11-21T09:00:30.000Z",
      activeAt: "2026-11-21T09:06:10.000Z",
      certificateAt: "2026-11-21T09:19:40.000Z",
      okAt: { "shop.example.com": "2026-11-21T09:20:05.000Z" },
    };
    await writeSwitchProgress(deps.paths, progress);
    expect(await readSwitchProgress(deps.paths)).toEqual(progress);
    await clearSwitchProgress(deps.paths);
    expect(existsSync(switchProgressFile(deps.paths))).toBe(false);
  });

  it("reads a damaged switch file as absent", async () => {
    const deps = await createTestPhaseDeps();
    await writeSwitchProgress(deps.paths, { zone: "example.com" });
    await writeFile(switchProgressFile(deps.paths), JSON.stringify({ zone: "example.com", x: 1 }));
    expect(await readSwitchProgress(deps.paths)).toBeUndefined();
    await writeFile(switchProgressFile(deps.paths), "nul");
    expect(await readSwitchProgress(deps.paths)).toBeUndefined();
  });
});
