import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectPaths } from "@opscrew/core";

/** Every audit log entry the project's tool calls wrote (`<OPSCREW_HOME>/audit/*`), as one text. */
export async function auditText(
  root: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const dir = resolveProjectPaths(root, { env }).auditDir;
  const names = await readdir(dir).catch(() => [] as string[]);
  const texts = await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")));
  return texts.join("\n");
}
