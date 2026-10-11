import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** SHA-256 hex digest (lowercase) of `bytes`. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 hex digest (lowercase) of the file's bytes. Approvals bind to this value. */
export async function hashFile(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}
