/**
 * Repo-relative POSIX path helpers. Detection works on POSIX paths relative to the repository
 * root (`apps/web/package.json`, `.` for the root) on every platform; only `toFsPath` converts back
 * to a native path for filesystem access.
 */
import { join } from "node:path";

/** Joins a repo-relative directory and a child name (`.` + `a` → `a`). */
export function joinRel(dir: string, name: string): string {
  return dir === "." || dir === "" ? name : `${dir}/${name}`;
}

/** Directory part of a repo-relative path (`a/b.txt` → `a`, `b.txt` → `.`). */
export function dirnameRel(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

/** Last segment of a repo-relative path. */
export function basenameRel(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True when `path` is `dir` itself or lies below it. */
export function isWithin(dir: string, path: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

/** `path` relative to `dir` (which must contain it). */
export function relativeTo(dir: string, path: string): string {
  if (dir === ".") return path;
  return path === dir ? "." : path.slice(dir.length + 1);
}

/** Number of directory levels in a repo-relative path (`a.txt` → 0, `a/b.txt` → 1). */
export function depthOf(path: string): number {
  return path === "." ? 0 : path.split("/").length - 1;
}

/** Native filesystem path for a repo-relative POSIX path. */
export function toFsPath(root: string, rel: string): string {
  return rel === "." || rel === "" ? root : join(root, ...rel.split("/"));
}

/** Sorts strings by UTF-16 code units (the order the zod schemas check). */
export function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Sorted, de-duplicated copy of `values`. */
export function uniqueSorted(values: Iterable<string>): string[] {
  return sortStrings(new Set(values));
}
