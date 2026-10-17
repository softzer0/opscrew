import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestPhaseDeps, ScriptedRunner } from "../testing";
import { readValidJson } from "./files";
import { githubClientFromToken, requireGitRepo, trackedFiles } from "./github";

describe("requireGitRepo", () => {
  it("stops with the one hint when the project is not a git repository", async () => {
    const runner = new ScriptedRunner(() => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    }));
    const deps = await createTestPhaseDeps({ runner });
    const error = await requireGitRepo(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "This project is not a git repository.",
      hint: "Run OpsCrew from a clone of your GitHub repository, or run `git init`, commit your code and add your GitHub remote, then try again.",
    });
  });

  it("returns the client of the project's repository", async () => {
    const runner = new ScriptedRunner(() => ({ exitCode: 0, stdout: "true\n", stderr: "" }));
    const deps = await createTestPhaseDeps({ runner });
    const git = await requireGitRepo(deps);
    expect(git.cwd).toBe(deps.paths.root);
    expect(runner.calls[0]?.args).toEqual([
      "-C",
      deps.paths.root,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
  });
});

describe("githubClientFromToken", () => {
  it("registers the token with the redactor before it makes the client", async () => {
    const token = fakeSecret("github-pat");
    const deps = await createTestPhaseDeps({ env: { GITHUB_TOKEN: token } });
    expect(await githubClientFromToken(deps)).toBeDefined();
    expect(deps.redactor.redact(`token ${token}`)).not.toContain(token);
  });

  it("is undefined without a token", async () => {
    // No GITHUB_TOKEN, GH_TOKEN or GitHub CLI on this PATH.
    const deps = await createTestPhaseDeps({ env: { PATH: "" } });
    expect(await githubClientFromToken(deps)).toBeUndefined();
  });
});

describe("trackedFiles", () => {
  it("lists what git tracks under the paths, and only the deleted ones when asked", async () => {
    const runner = new ScriptedRunner(() => ({
      exitCode: 0,
      stdout: "opscrew/infra/main.tf\n\nopscrew/infra/modules/dns/main.tf\n",
      stderr: "",
    }));
    const deps = await createTestPhaseDeps({ runner });
    expect(await trackedFiles(deps, ["opscrew/infra"], { deleted: true })).toEqual([
      "opscrew/infra/main.tf",
      "opscrew/infra/modules/dns/main.tf",
    ]);
    expect(runner.calls[0]).toMatchObject({
      command: "git",
      args: ["-C", deps.paths.root, "ls-files", "--deleted", "--", "opscrew/infra"],
    });
  });

  it("asks git nothing for no paths (which would list every file), and lists none when git fails", async () => {
    const runner = new ScriptedRunner(() => ({ exitCode: 128, stdout: "x\n", stderr: "fatal" }));
    const deps = await createTestPhaseDeps({ runner });
    expect(await trackedFiles(deps, [])).toEqual([]);
    expect(runner.calls).toHaveLength(0);
    expect(await trackedFiles(deps, ["Dockerfile"])).toEqual([]);
  });
});

describe("readValidJson", () => {
  const Schema = z.object({ planHash: z.string() });

  it("reads valid content; missing, broken or other content is undefined", async () => {
    const deps = await createTestPhaseDeps();
    const file = (name: string) => join(deps.paths.root, name);
    await writeFile(file("ok.json"), '{"planHash":"abc","extra":1}');
    await writeFile(file("broken.json"), "{ not json");
    await writeFile(file("other.json"), '{"planHash":42}');
    expect(await readValidJson(file("ok.json"), Schema)).toEqual({ planHash: "abc" });
    expect(await readValidJson(file("missing.json"), Schema)).toBeUndefined();
    expect(await readValidJson(file("broken.json"), Schema)).toBeUndefined();
    expect(await readValidJson(file("other.json"), Schema)).toBeUndefined();
  });

  it("throws any other read error instead of reading it as missing", async () => {
    const deps = await createTestPhaseDeps();
    const dir = join(deps.paths.root, "a-folder.json");
    await mkdir(dir);
    await expect(readValidJson(dir, Schema)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
