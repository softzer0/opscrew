import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles, SKIPPED_DIRECTORIES } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "files");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

describe("listProjectFiles", () => {
  it("returns sorted, POSIX, repo-relative paths", async () => {
    const root = await tree({
      "src/b.ts": "b",
      "src/a/z.ts": "z",
      "a-file.txt": "a",
      "README.md": "r",
    });
    const { files, truncated } = await listProjectFiles(root);
    expect(files).toEqual(["README.md", "a-file.txt", "src/a/z.ts", "src/b.ts"]);
    expect(truncated).toBe(false);
    for (const file of files) {
      expect(file).not.toContain("\\");
      expect(file).not.toMatch(/^(?:\/|[A-Za-z]:)/);
    }
  });

  it("skips the always-skipped directories at any depth", async () => {
    const files: Record<string, string> = { "keep.js": "k", "nested/keep.js": "k" };
    for (const dir of SKIPPED_DIRECTORIES) {
      files[`${dir}/x.js`] = "x";
      files[`nested/${dir}/x.js`] = "x";
    }
    const root = await tree(files);
    expect((await listProjectFiles(root)).files).toEqual(["keep.js", "nested/keep.js"]);
  });

  it("honours .gitignore files at every level, including negation and CRLF", async () => {
    const root = await tree({
      ".gitignore": "*.log\r\nsecret/\r\n/root-only.txt\r\n",
      "app.log": "x",
      "root-only.txt": "x",
      "secret/key.txt": "x",
      "sub/.gitignore": "local.txt\n!keep.log\nout/\n",
      "sub/root-only.txt": "kept: anchored pattern applies to the root only",
      "sub/local.txt": "x",
      "sub/keep.log": "re-included",
      "sub/other.log": "x",
      "sub/out/file.js": "x",
      "sub/deeper/local.txt": "x",
      "sub/deeper/ok.txt": "ok",
      "other/local.txt": "not ignored here",
    });
    const { files } = await listProjectFiles(root);
    expect(files).toEqual([
      ".gitignore",
      "other/local.txt",
      "sub/.gitignore",
      "sub/deeper/ok.txt",
      "sub/keep.log",
      "sub/root-only.txt",
    ]);
  });

  it("applies extra ignore patterns", async () => {
    const root = await tree({ "a.txt": "a", "fixtures/b.txt": "b", "c.md": "c" });
    const { files } = await listProjectFiles(root, { extraIgnores: ["fixtures/", "*.md"] });
    expect(files).toEqual(["a.txt"]);
  });

  it("skips files larger than maxFileBytes", async () => {
    const root = await tree({ "small.txt": "1234", "big.txt": "x".repeat(50) });
    const { files } = await listProjectFiles(root, { maxFileBytes: 10 });
    expect(files).toEqual(["small.txt"]);
  });

  it("stops at maxFiles and reports truncation", async () => {
    const root = await tree({
      "a.txt": "",
      "b.txt": "",
      "c/d.txt": "",
      "c/e.txt": "",
      "f.txt": "",
    });
    const limited = await listProjectFiles(root, { maxFiles: 3 });
    expect(limited.files).toHaveLength(3);
    expect(limited.truncated).toBe(true);
    const exact = await listProjectFiles(root, { maxFiles: 5 });
    expect(exact.files).toHaveLength(5);
    expect(exact.truncated).toBe(false);
  });

  it("returns an empty list for a missing directory", async () => {
    const root = await tree({});
    expect(await listProjectFiles(`${root}/missing`)).toEqual({ files: [], truncated: false });
  });
});
