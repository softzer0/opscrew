import { readFile } from "node:fs/promises";
import { sha256Hex } from "@opscrew/core";

/** SHA-256 hex digest (lowercase) of the file's bytes. Approvals bind to this value. */
export async function hashFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}
