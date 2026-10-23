import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedRunner } from "../testing";
import { updateLockfile } from "./lockfile";

/** A project with `files`, and a PATH holding stand-ins for the package managers in `tools`. */
async function project(files: Record<string, string>, tools: string[] = ["npm", "pnpm", "yarn"]) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-lockfile-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const bin = join(root, ".bin");
  await mkdir(bin);
  for (const tool of tools) {
    await writeFile(join(bin, tool), "", { mode: 0o755 });
    await writeFile(join(bin, `${tool}.cmd`), "", { mode: 0o755 });
  }
  return { root, env: { PATH: bin, PATHEXT: ".CMD", OPSCREW_HOME: join(root, ".home") } };
}

describe("updateLockfile", () => {
  it("runs npm in lockfile-only mode with scripts off, in the app's folder", async () => {
    const { root, env } = await project({ "package.json": "{}", "package-lock.json": "{}" });
    const runner = new ScriptedRunner();
    const deps = await createTestPhaseDeps({ root, env, runner });
    expect(await updateLockfile(deps, ".", "npm")).toEqual({
      status: "updated",
      lockfile: "package-lock.json",
      note: "npm updated package-lock.json.",
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual([
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(runner.calls[0]?.command).toMatch(/npm(?:\.cmd)?$/i);
    expect(runner.calls[0]?.options?.cwd).toBe(root);
  });

  it("updates a workspace's lockfile at the root above the app", async () => {
    const { root, env } = await project({
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "apps/web/package.json": "{}",
    });
    const runner = new ScriptedRunner();
    const deps = await createTestPhaseDeps({ root, env, runner });
    expect(await updateLockfile(deps, "apps/web", "pnpm")).toMatchObject({
      status: "updated",
      lockfile: "pnpm-lock.yaml",
    });
    expect(runner.calls[0]?.args).toEqual(["install", "--lockfile-only", "--ignore-scripts"]);
    expect(runner.calls[0]?.options?.cwd).toBe(join(root, "."));
  });

  it("tells Yarn 2+ from Yarn 1 by the lockfile", async () => {
    const berry = await project({ "yarn.lock": "__metadata:\n  version: 8\n" });
    const runner = new ScriptedRunner();
    await updateLockfile(await createTestPhaseDeps({ ...berry, runner }), ".", "yarn");
    expect(runner.calls[0]?.args).toEqual(["install", "--mode", "update-lockfile"]);
    const classic = await project({ "yarn.lock": "# yarn lockfile v1\n" });
    const classicRunner = new ScriptedRunner();
    await updateLockfile(
      await createTestPhaseDeps({ ...classic, runner: classicRunner }),
      ".",
      "yarn",
    );
    expect(classicRunner.calls[0]?.args).toEqual(["install", "--ignore-scripts"]);
  });

  it("does nothing without a lockfile", async () => {
    const { root, env } = await project({ "package.json": "{}" });
    const runner = new ScriptedRunner();
    expect(
      await updateLockfile(await createTestPhaseDeps({ root, env, runner }), ".", "npm"),
    ).toEqual({ status: "none" });
    expect(runner.calls).toEqual([]);
  });

  it("names the command to run when the package manager is missing or fails", async () => {
    const missing = await project({ "bun.lock": "{}" }, []);
    expect(await updateLockfile(await createTestPhaseDeps(missing), ".", "bun")).toEqual({
      status: "failed",
      lockfile: "bun.lock",
      note: "OpsCrew could not update bun.lock: bun is not installed here. Run `bun install --lockfile-only --ignore-scripts` and commit bun.lock to this branch, or the deploy job's install fails.",
    });

    const failing = await project({ "apps/web/package-lock.json": "{}" });
    const runner = new ScriptedRunner(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree",
    }));
    expect(
      await updateLockfile(await createTestPhaseDeps({ ...failing, runner }), "apps/web", "npm"),
    ).toEqual({
      status: "failed",
      lockfile: "apps/web/package-lock.json",
      note: "OpsCrew could not update apps/web/package-lock.json: npm failed (npm error ERESOLVE unable to resolve dependency tree). Run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` in apps/web and commit apps/web/package-lock.json to this branch, or the deploy job's install fails.",
    });

    const unstartable = await project({ "package-lock.json": "{}" });
    const refusing = new ScriptedRunner(() => {
      throw new OpsCrewError("COMMAND_FAILED", "Could not start npm.");
    });
    expect(
      await updateLockfile(
        await createTestPhaseDeps({ ...unstartable, runner: refusing }),
        ".",
        "npm",
      ),
    ).toMatchObject({
      status: "failed",
      note: expect.stringContaining(": Could not start npm. Run"),
    });
  });
});
