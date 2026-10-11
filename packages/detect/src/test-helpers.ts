/** Test-only helpers: build small file trees in a temporary directory. Not exported. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Creates a temp directory containing `files` (POSIX relative paths → contents). */
export async function makeTree(files: Record<string, string>, prefix = "tree"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `opscrew-detect-${prefix}-`));
  await writeTree(root, files);
  return root;
}

/** Writes `files` below `root`, creating directories as needed. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** Removes a tree created by {@link makeTree}. */
export async function removeTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
