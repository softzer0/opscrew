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

/** Directory of a repo-relative POSIX path (`""` for the repository root). */
export function dirname(file: string): string {
  const at = file.lastIndexOf("/");
  return at < 0 ? "" : file.slice(0, at);
}

/** Lower-case extension of a file name without the dot (`""` for none and for dotfiles). */
export function extension(file: string): string {
  const name = basename(file);
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at + 1).toLowerCase();
}

/** True for every dotenv file name: `.env` and `.env.<anything>` (examples and vaults too). */
export function isDotenvFile(file: string): boolean {
  const name = basename(file);
  return name === ".env" || name.startsWith(".env.");
}

/**
 * True for dotenv files that hold real values (`.env`, `.env.local`, `.env.production`, …), false
 * for examples/templates and encrypted `.env.vault` files that are meant to be committed.
 */
export function isEnvFile(file: string): boolean {
  return isDotenvFile(file) && !isEnvExampleFile(file) && basename(file) !== ".env.vault";
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

/** A function from a character offset in `text` to its 1-based line number. */
export function lineLocator(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** `text` on one line (whitespace runs become one space), cut to `max` characters with `…`. */
export function compact(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
