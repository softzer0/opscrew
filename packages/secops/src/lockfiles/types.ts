/** Package ecosystems OpsCrew resolves from lockfiles, named as the OSV API names them. */
export type Ecosystem = "npm" | "PyPI";

/** One exact package version pinned by a lockfile. */
export interface LockedPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Repo-relative POSIX path of the lockfile. */
  file: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Insertion-ordered set of packages keyed by ecosystem, name and version (first file wins). */
export class PackageSet {
  readonly #items = new Map<string, LockedPackage>();

  add(pkg: LockedPackage): void {
    const key = `${pkg.ecosystem}|${pkg.name}|${pkg.version}`;
    if (!this.#items.has(key)) this.#items.set(key, pkg);
  }

  values(): LockedPackage[] {
    return [...this.#items.values()];
  }
}
