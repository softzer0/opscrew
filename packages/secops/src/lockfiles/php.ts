import { isRecord } from "@opscrew/core";
import { type LockedPackage, PackageSet } from "./types";

/**
 * `composer.lock`: every package in `packages` and `packages-dev` with a release version (the
 * leading `v` dropped, as Packagist advisories write versions); dev branches (`dev-main`) skipped.
 */
export function parseComposerLock(file: string, text: string): LockedPackage[] {
  const doc: unknown = JSON.parse(text);
  const set = new PackageSet();
  if (!isRecord(doc)) return [];
  for (const list of [doc.packages, doc["packages-dev"]]) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      if (typeof entry.version !== "string") continue;
      const version = entry.version.replace(/^v(?=\d)/, "");
      if (!/^\d/.test(version)) continue;
      set.add({ ecosystem: "Packagist", name: entry.name, version, file });
    }
  }
  return set.values();
}
