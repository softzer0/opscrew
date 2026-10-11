/**
 * Internal helpers shared by the built-in rules (not exported from the package): file
 * classification, placeholder detection and safe text reading.
 */
import type { ScanContext } from "@opscrew/contracts";
import { isEnvExampleFile } from "@opscrew/detect";

/** Lines longer than this are treated as minified or generated and skipped by line rules. */
export const MAX_LINE_LENGTH = 5_000;

/** File extensions of binary formats that text rules never read. */
export const BINARY_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|flac|wasm|so|dylib|dll|exe|bin|pyc|sqlite3?|db)$/i;

/** Last path segment of a repo-relative POSIX path. */
export function basename(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/**
 * True for dotenv files that hold real values (`.env`, `.env.local`, `.env.production`, …), false
 * for examples/templates and encrypted `.env.vault` files that are meant to be committed.
 */
export function isEnvFile(file: string): boolean {
  const name = basename(file);
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !isEnvExampleFile(file) && name !== ".env.vault";
}

const PLACEHOLDER_WORDS = [
  "your-",
  "your_",
  "xxx",
  "changeme",
  "change-me",
  "change_me",
  "example",
  "placeholder",
  "redacted",
  "process.env",
  "import.meta.env",
  "${",
  "{{",
];

/**
 * True when `value` is a placeholder rather than a secret: it contains a placeholder word
 * (`your-`, `xxx`, `changeme`, `example`, `placeholder`, `${`, `process.env`, …), is wrapped in
 * `<…>`, consists of one repeated character, or is shorter than `minLength`.
 */
export function isPlaceholderValue(value: string, minLength = 1): boolean {
  if (value.length < minLength) return true;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return true;
  if (/<[^>]*>/.test(value)) return true;
  return /^(.)\1*$/s.test(value);
}

/** Reads a file as text; `undefined` when it cannot be read or looks binary (NUL byte). */
export async function readText(context: ScanContext, file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await context.readFile(file);
  } catch {
    return undefined;
  }
  return text.slice(0, 8_000).includes("\0") ? undefined : text;
}

/** Maps `items` with at most `limit` calls of `fn` in flight; results keep the input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Splits text into lines (handles `\r\n`). */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** 1-based line number of the character at `offset`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset; ) {
    line++;
    index = text.indexOf("\n", index + 1);
  }
  return line;
}
