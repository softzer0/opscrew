import { join } from "node:path";
import { isRecord, readTextIfExists } from "@opscrew/core";
import { normalizeAppDir } from "./app-dir";
import { parseJson } from "./manifests";

/**
 * What a PHP app needs from the PHP it runs on, as Composer states it (feature 027, plan 5): what
 * a hosting account's PHP versions are checked against when OpsCrew sets the account up.
 */
export interface PhpNeeds {
  /** `composer.json`'s PHP constraint (`require.php`), as written; absent when it names none. */
  php?: string;
  /**
   * The extensions `composer.json` and every package `composer.lock` installs require (`ext-*`,
   * lower-case, without the prefix), sorted and deduplicated, without {@link PHP_8_EXTENSIONS}.
   * Development packages are left out: a release is installed without them.
   */
  extensions: string[];
  /**
   * The WebSocket servers `composer.json` requires (`laravel/reverb`, `cboden/ratchet`, …), sorted:
   * each needs a PHP process that keeps running.
   */
  websockets: string[];
}

/**
 * The extensions every PHP 8 build has: compiled in for good (`core`, `date`, `hash`, `json`,
 * `pcre`, `random`, `reflection`, `spl`, `standard`) or on in every build (`ctype`, `filter`). An
 * app's need for them is met wherever PHP 8 runs.
 */
export const PHP_8_EXTENSIONS: ReadonlySet<string> = new Set([
  "core",
  "ctype",
  "date",
  "filter",
  "hash",
  "json",
  "pcre",
  "random",
  "reflection",
  "spl",
  "standard",
]);

/** Packages that serve WebSockets from PHP, in a process of their own. */
const WEBSOCKET_SERVERS: ReadonlySet<string> = new Set([
  "beyondcode/laravel-websockets",
  "cboden/ratchet",
  "laravel/reverb",
  "workerman/workerman",
]);

/** A manifest's `require` mapping, or an empty one when it has none. */
function requireOf(manifest: unknown): Record<string, unknown> {
  return isRecord(manifest) && isRecord(manifest.require) ? manifest.require : {};
}

/**
 * The PHP needs ({@link PhpNeeds}) of the app in `appDir` (repo-relative, default the repository
 * root): its `composer.json` and the `composer.lock` beside it, from the app's folder, else from
 * the repository root. Without a readable `composer.json` the app needs nothing OpsCrew can tell.
 */
export async function detectPhpNeeds(root: string, appDir = "."): Promise<PhpNeeds> {
  const dir = normalizeAppDir(appDir);
  const folders = dir === "." ? ["."] : [dir, "."];
  let folder: string | undefined;
  let manifest: string | undefined;
  for (const candidate of folders) {
    manifest = await readTextIfExists(join(root, candidate, "composer.json"));
    if (manifest !== undefined) {
      folder = candidate;
      break;
    }
  }
  if (folder === undefined) return { extensions: [], websockets: [] };
  const require = requireOf(parseJson(manifest));
  const lock = parseJson(await readTextIfExists(join(root, folder, "composer.lock")));
  const packages = isRecord(lock) && Array.isArray(lock.packages) ? lock.packages : [];
  const extensions = new Set<string>();
  for (const requirements of [require, ...packages.map(requireOf)]) {
    for (const name of Object.keys(requirements)) {
      const extension = /^ext-(.+)$/i.exec(name)?.[1]?.toLowerCase();
      if (extension !== undefined && !PHP_8_EXTENSIONS.has(extension)) extensions.add(extension);
    }
  }
  const php = require.php;
  return {
    ...(typeof php === "string" && php.trim() !== "" ? { php: php.trim() } : {}),
    extensions: [...extensions].sort(),
    websockets: Object.keys(require)
      .map((name) => name.toLowerCase())
      .filter((name) => WEBSOCKET_SERVERS.has(name))
      .sort(),
  };
}
