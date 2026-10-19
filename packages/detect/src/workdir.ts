/** What detection reads from the app's own Dockerfile beyond its port. */
import { posix } from "node:path";

/**
 * The working directory of a Dockerfile's last stage, where the app runs in the image: its last
 * `WORKDIR`, a relative one resolved against the one before it in the same stage. Undefined when
 * the stage sets none, when a relative one has nothing in the stage to resolve against (it would
 * follow the base image's), or when the value holds a variable (`$APP_HOME`).
 */
export function dockerfileWorkdir(text: string): string | undefined {
  // One instruction per line: continuations joined, comments dropped.
  const instructions = text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const lastFrom = instructions.findLastIndex((line) => /^FROM\s/i.test(line));
  let workdir: string | undefined;
  for (const line of instructions.slice(lastFrom + 1)) {
    const match = /^WORKDIR\s+(.+)$/i.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value.includes("$")) workdir = undefined;
    else if (value.startsWith("/")) workdir = value;
    else workdir = workdir === undefined ? undefined : posix.join(workdir, value);
  }
  if (workdir === undefined) return undefined;
  const clean = posix.normalize(workdir).replace(/(.)\/+$/, "$1");
  return /\s/.test(clean) ? undefined : clean;
}
