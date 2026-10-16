import { isRecord } from "@opscrew/core";
import { parse as parseYaml } from "yaml";
import { type LockedPackage, PackageSet } from "./types";

/** Exact npm versions only (`1.2.3`, `1.2.3-beta.1`); ranges, tags, URLs and paths are skipped. */
const NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

function addNpm(set: PackageSet, file: string, name: unknown, version: unknown): void {
  if (typeof name !== "string" || typeof version !== "string") return;
  if (!NPM_VERSION.test(version)) return;
  set.add({ ecosystem: "npm", name, version, file });
}

/** Splits `name@rest` where `name` may be scoped (`@scope/name@rest`). */
function splitAt(descriptor: string): [string, string] | undefined {
  const at = descriptor.indexOf("@", 1);
  if (at <= 0) return undefined;
  return [descriptor.slice(0, at), descriptor.slice(at + 1)];
}

/** `package-lock.json` / `npm-shrinkwrap.json`: v2/v3 `packages`, falling back to v1 `dependencies`. */
export function parsePackageLock(file: string, text: string): LockedPackage[] {
  const json: unknown = JSON.parse(text);
  const set = new PackageSet();
  if (!isRecord(json)) return set.values();
  if (isRecord(json.packages)) {
    for (const [key, entry] of Object.entries(json.packages)) {
      if (!isRecord(entry) || entry.link === true) continue;
      const marker = key.lastIndexOf("node_modules/");
      if (marker === -1) continue; // the root project or a workspace folder
      const name =
        typeof entry.name === "string" ? entry.name : key.slice(marker + "node_modules/".length);
      addNpm(set, file, name, entry.version);
    }
    return set.values();
  }
  const walk = (dependencies: unknown): void => {
    if (!isRecord(dependencies)) return;
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!isRecord(entry)) continue;
      const version = entry.version;
      if (typeof version === "string" && version.startsWith("npm:")) {
        const alias = splitAt(version.slice(4));
        if (alias) addNpm(set, file, alias[0], alias[1]);
      } else {
        addNpm(set, file, name, version);
      }
      walk(entry.dependencies);
    }
  };
  walk(json.dependencies);
  return set.values();
}

/**
 * `pnpm-lock.yaml`: v6–v9 keys (`/name@1.2.3(peer@1)`, `name@1.2.3`) and v5 keys (`/name/1.2.3_peer@1`).
 * Entries with explicit `name`/`version` (tarball and git dependencies) use those.
 */
export function parsePnpmLock(file: string, text: string): LockedPackage[] {
  const doc: unknown = parseYaml(text);
  const set = new PackageSet();
  if (!isRecord(doc) || !isRecord(doc.packages)) return set.values();
  const lockVersion = Number.parseFloat(String(doc.lockfileVersion ?? "9"));
  const legacy = Number.isFinite(lockVersion) && lockVersion < 6;
  for (const [rawKey, entry] of Object.entries(doc.packages)) {
    const details = isRecord(entry) ? entry : {};
    if (typeof details.name === "string" && typeof details.version === "string") {
      addNpm(set, file, details.name, details.version);
      continue;
    }
    let key = rawKey.startsWith("/") ? rawKey.slice(1) : rawKey;
    const paren = key.indexOf("(");
    if (paren > 0) key = key.slice(0, paren);
    if (legacy) {
      const slash = key.lastIndexOf("/");
      if (slash <= 0) continue;
      const version = key.slice(slash + 1).split("_")[0];
      addNpm(set, file, key.slice(0, slash), version);
    } else {
      const parts = splitAt(key);
      if (parts) addNpm(set, file, parts[0], parts[1]);
    }
  }
  return set.values();
}

/** `yarn.lock`, classic (v1) and berry (v2+, `__metadata`) formats. */
export function parseYarnLock(file: string, text: string): LockedPackage[] {
  const set = new PackageSet();
  let descriptor: string | undefined;
  let version: string | undefined;
  let resolution: string | undefined;

  const flush = (): void => {
    if (descriptor === undefined) return;
    if (resolution !== undefined) {
      // berry: `name@npm:1.2.3`; other protocols (workspace:, patch:, link:, git) are skipped
      const parts = splitAt(resolution);
      if (parts?.[1].startsWith("npm:")) addNpm(set, file, parts[0], version ?? parts[1].slice(4));
    } else {
      const parts = splitAt(descriptor);
      if (parts) {
        let name = parts[0];
        const range = parts[1];
        if (range.startsWith("npm:")) {
          const alias = splitAt(range.slice(4));
          if (alias) name = alias[0];
        }
        if (!/^(?:workspace|patch|link|portal|file|exec):/.test(range)) {
          addNpm(set, file, name, version);
        }
      }
    }
    descriptor = undefined;
    version = undefined;
    resolution = undefined;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      flush();
      if (!line.endsWith(":") || line.startsWith("__metadata")) continue;
      const first = line.slice(0, -1).split(",")[0]?.trim() ?? "";
      descriptor = first.replace(/^"|"$/g, "");
      continue;
    }
    const field = /^ {2}(version|resolution):? +"?([^"]+?)"?\s*$/.exec(line);
    if (!field || descriptor === undefined) continue;
    if (field[1] === "version") version = field[2];
    else resolution = field[2];
  }
  flush();
  return set.values();
}
