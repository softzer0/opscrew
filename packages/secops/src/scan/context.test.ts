import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandRunner } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScanContext } from "./context";
import { failingRunner, gitRunner, noFetch } from "./test-utils";

const GIT = findExecutable("git");

/**
 * Real git, isolated from the environment: no inherited `GIT_*` variables (as set inside git
 * hooks) and no repository above the temporary folder.
 */
function isolatedGit(): CommandRunner {
  const runner = new NodeCommandRunner();
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  return { run: (command, args, options) => runner.run(command, args, { ...options, env }) };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "opscrew-context-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "README.md"), "# hello\n");
  await writeFile(path.join(root, ".env"), "PORT=3000\n");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "ignored.txt"), "x\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createScanContext", () => {
  it("lists gitignore-aware files including dotfiles", async () => {
    const context = await createScanContext(root, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
    });
    expect(context.rootDir).toBe(path.resolve(root));
    expect(context.files).toEqual([".env", ".gitignore", "README.md", "src/a.ts"]);
    expect(context.offline).toBe(true);
    expect(context.gitTracked).toBeUndefined();
  });

  it("respects maxFiles", async () => {
    const context = await createScanContext(root, {
      offline: false,
      fetch: noFetch,
      runner: failingRunner,
      maxFiles: 2,
    });
    expect(context.files).toHaveLength(2);
    expect(context.offline).toBe(false);
  });

  it("reads git-tracked files with git ls-files -z when .git exists", async () => {
    await mkdir(path.join(root, ".git"));
    const runner = gitRunner(["src/a.ts", "README.md", "ignored.txt"]);
    const context = await createScanContext(root, { offline: true, fetch: noFetch, runner });
    expect(runner.calls).toEqual([
      { command: "git", args: ["ls-files", "-z"], cwd: path.resolve(root) },
    ]);
    expect([...(context.gitTracked ?? [])].sort()).toEqual([
      "README.md",
      "ignored.txt",
      "src/a.ts",
    ]);
  });

  it("asks git from a subfolder of a repository, so it sees what is tracked there", async () => {
    await mkdir(path.join(root, ".git"));
    const sub = path.join(root, "src");
    // `git ls-files` run in a subfolder lists paths relative to that folder.
    const runner = gitRunner(["a.ts"]);
    const context = await createScanContext(sub, { offline: true, fetch: noFetch, runner });
    expect(runner.calls).toEqual([
      { command: "git", args: ["ls-files", "-z"], cwd: path.resolve(sub) },
    ]);
    expect([...(context.gitTracked ?? [])]).toEqual(["a.ts"]);
  });

  it("does not run git when neither the folder nor a parent has a .git entry", async () => {
    const runner = gitRunner(["src/a.ts"]);
    const context = await createScanContext(root, { offline: true, fetch: noFetch, runner });
    expect(runner.calls).toEqual([]);
    expect(context.gitTracked).toBeUndefined();
  });

  it.skipIf(GIT === undefined)(
    "sees a committed .env when scanning a nested folder of a real repository",
    async () => {
      const app = path.join(root, "apps", "web");
      await mkdir(app, { recursive: true });
      await writeFile(path.join(app, ".env"), "API_TOKEN=committed-by-mistake\n");
      await writeFile(path.join(app, "index.js"), "console.log(1);\n");
      const runner = isolatedGit();
      const git = async (...args: string[]) => {
        const result = await runner.run(
          GIT ?? "git",
          ["-c", "user.name=OpsCrew Test", "-c", "user.email=test@opscrew.invalid", ...args],
          { cwd: root, timeoutMs: 30_000 },
        );
        expect(result.exitCode, result.stderr).toBe(0);
      };
      await git("init", "-q");
      await git("add", "-A");
      await git("commit", "-q", "-m", "initial");
      const context = await createScanContext(app, { offline: true, fetch: noFetch, runner });
      expect([...(context.gitTracked ?? [])].sort()).toEqual([".env", "index.js"]);
    },
    60_000,
  );

  it.skipIf(GIT === undefined)("leaves gitTracked undefined outside a git repository", async () => {
    const context = await createScanContext(root, {
      offline: true,
      fetch: noFetch,
      runner: isolatedGit(),
    });
    // The temp folder is not inside a repository (git exits non-zero).
    expect(context.gitTracked).toBeUndefined();
  });

  it("warns when the file listing stops at maxFiles, and stays quiet otherwise", async () => {
    const warnings: string[] = [];
    const onWarning = (message: string) => warnings.push(message);
    await createScanContext(root, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      onWarning,
    });
    expect(warnings).toEqual([]);
    const context = await createScanContext(root, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      maxFiles: 2,
      onWarning,
    });
    expect(context.files).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/more than 2 files.*not checked/);
    expect(warnings[0]).not.toContain(root);
  });

  it("leaves gitTracked undefined when git is missing or fails", async () => {
    await mkdir(path.join(root, ".git"));
    const throwing: CommandRunner = {
      run: async () => {
        throw new Error("spawn git ENOENT");
      },
    };
    for (const runner of [failingRunner, throwing]) {
      const context = await createScanContext(root, { offline: true, fetch: noFetch, runner });
      expect(context.gitTracked).toBeUndefined();
    }
  });

  it("reads UTF-8 relative to the root and refuses paths outside it", async () => {
    await writeFile(path.join(root, "src", "u.txt"), "héllo ✓\n", "utf8");
    const context = await createScanContext(root, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
    });
    expect(await context.readFile("src/u.txt")).toBe("héllo ✓\n");
    await expect(context.readFile("../outside.txt")).rejects.toThrow(/inside the project/);
    await expect(context.readFile(path.resolve(root, "src/a.ts"))).rejects.toThrow(
      /inside the project/,
    );
  });

  it("uses an explicit file list when given", async () => {
    const context = await createScanContext(root, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      files: ["src/a.ts"],
    });
    expect(context.files).toEqual(["src/a.ts"]);
  });

  it("fails with a plain-English error when the root is not a directory", async () => {
    await expect(
      createScanContext(path.join(root, "missing"), {
        offline: true,
        fetch: noFetch,
        runner: failingRunner,
      }),
    ).rejects.toThrow(/is not a directory/);
  });
});
