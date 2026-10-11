import type { ScanContext } from "@opscrew/contracts";
import { parsePackageLock, parsePnpmLock, parseYarnLock } from "./npm";
import { parsePoetryLock, parseRequirements, parseUvLock } from "./python";
import { type LockedPackage, PackageSet } from "./types";

export { parsePackageLock, parsePnpmLock, parseYarnLock } from "./npm";
export { normalizePythonName, parsePoetryLock, parseRequirements, parseUvLock } from "./python";
export type { Ecosystem, LockedPackage } from "./types";

type LockfileParser = (file: string, text: string) => LockedPackage[];

/** Lockfile names OpsCrew understands, for user-facing messages. */
export const SUPPORTED_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements*.txt",
  "poetry.lock",
  "uv.lock",
] as const;

function parserFor(file: string): LockfileParser | undefined {
  const name = file.slice(file.lastIndexOf("/") + 1);
  switch (name) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return parsePackageLock;
    case "pnpm-lock.yaml":
      return parsePnpmLock;
    case "yarn.lock":
      return parseYarnLock;
    case "poetry.lock":
      return parsePoetryLock;
    case "uv.lock":
      return parseUvLock;
    default:
      return /^requirements[^/]*\.txt$/i.test(name) ? parseRequirements : undefined;
  }
}

/** True when the repo-relative path is a lockfile OpsCrew can parse. */
export function isLockfile(file: string): boolean {
  return !file.split("/").includes("node_modules") && parserFor(file) !== undefined;
}

/** Parses one lockfile by its name. Throws on malformed JSON, YAML or TOML. */
export function parseLockfile(file: string, text: string): LockedPackage[] {
  const parser = parserFor(file);
  return parser ? parser(file, text) : [];
}

/**
 * Every pinned package in the project's lockfiles, de-duplicated by ecosystem, name and version
 * (the first lockfile in path order wins). Unreadable or malformed lockfiles are skipped.
 */
export async function collectLockedPackages(context: ScanContext): Promise<LockedPackage[]> {
  const set = new PackageSet();
  const files = context.files.filter(isLockfile).sort();
  for (const file of files) {
    try {
      for (const pkg of parseLockfile(file, await context.readFile(file))) set.add(pkg);
    } catch {
      // a broken lockfile must not stop the scan; other scanners still run
    }
  }
  return set.values();
}
