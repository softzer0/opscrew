import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, inject, it, vi } from "vitest";
import {
  RUN_DIR_PREFIX,
  RUN_MARKER_FILE,
  removeRunFolder,
  sweepStaleRunFolders,
  TEMP_DIR_VARIABLES,
} from "../../../../scripts/vitest-global-setup";

const execFileAsync = promisify(execFile);

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const runDir = inject("opscrewTestRunDir");

describe("shared Vitest global setup", () => {
  it("creates one run folder under OPSCREW_TEST_TMP or the system temp folder", async () => {
    expect(basename(runDir).startsWith(RUN_DIR_PREFIX)).toBe(true);
    expect((await stat(runDir)).isDirectory()).toBe(true);
    const configured = process.env.OPSCREW_TEST_TMP;
    if (configured) expect(dirname(runDir)).toBe(resolve(configured));
  });

  it("points os.tmpdir() and the temp variables inside a test file at the run folder", async () => {
    for (const name of TEMP_DIR_VARIABLES) expect(process.env[name]).toBe(runDir);
    expect(isInside(runDir, tmpdir())).toBe(true);
    const made = await mkdtemp(join(tmpdir(), "opscrew-redirect-"));
    try {
      expect(isInside(runDir, made)).toBe(true);
    } finally {
      await rm(made, { recursive: true, force: true });
    }
  });

  it("hands the run folder to child processes", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      "process.stdout.write(require('node:os').tmpdir())",
    ]);
    expect(isInside(runDir, stdout)).toBe(true);
  });
});

describe("sweepStaleRunFolders", () => {
  it("removes only run folders whose process on this machine has ended", async () => {
    const parent = await mkdtemp(join(tmpdir(), "opscrew-sweep-"));
    try {
      const make = async (name: string, marker?: object) => {
        await mkdir(join(parent, name));
        if (marker) await writeFile(join(parent, name, RUN_MARKER_FILE), JSON.stringify(marker));
      };
      await make(`${RUN_DIR_PREFIX}dead`, { pid: 111, hostname: "here" });
      await make(`${RUN_DIR_PREFIX}alive`, { pid: 222, hostname: "here" });
      await make(`${RUN_DIR_PREFIX}elsewhere`, { pid: 111, hostname: "other" });
      await make(`${RUN_DIR_PREFIX}nomarker`);
      await make("opscrew-unrelated", { pid: 111, hostname: "here" });
      await writeFile(join(parent, `${RUN_DIR_PREFIX}file`), "not a folder");

      const removed = await sweepStaleRunFolders(parent, {
        hostname: "here",
        isAlive: (pid) => pid === 222,
        rm,
        warn: vi.fn(),
      });

      expect(removed).toEqual([join(parent, `${RUN_DIR_PREFIX}dead`)]);
      expect((await readdir(parent)).sort()).toEqual(
        [
          `${RUN_DIR_PREFIX}alive`,
          `${RUN_DIR_PREFIX}elsewhere`,
          `${RUN_DIR_PREFIX}file`,
          `${RUN_DIR_PREFIX}nomarker`,
          "opscrew-unrelated",
        ].sort(),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("marks the current run folder with this process", async () => {
    const marker = JSON.parse(await readFile(join(runDir, RUN_MARKER_FILE), "utf8"));
    expect(marker).toMatchObject({ pid: expect.any(Number), hostname: expect.any(String) });
  });
});

describe("removeRunFolder", () => {
  it("removes the folder and everything in it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-remove-"));
    await mkdtemp(join(dir, "nested-"));
    const warn = vi.fn();
    expect(await removeRunFolder(dir, { rm, warn })).toBe(true);
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("prints one warning line naming the folder and does not throw when removal fails", async () => {
    const failingRm = vi.fn(async () => {
      throw Object.assign(new Error("resource busy\nsecond line"), { code: "EBUSY" });
    });
    const warn = vi.fn();
    const dir = join(tmpdir(), "opscrew-test-run-locked");
    expect(await removeRunFolder(dir, { rm: failingRm as unknown as typeof rm, warn })).toBe(false);
    expect(failingRm).toHaveBeenCalledWith(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(dir);
    expect(line).toContain("EBUSY");
    expect(line).not.toContain("\n");
  });
});
