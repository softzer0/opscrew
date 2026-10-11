import { parse as parseToml } from "smol-toml";
import { isRecord, type LockedPackage, PackageSet } from "./types";

/** PEP 503 normalised project name (`Django_REST.framework` → `django-rest-framework`). */
export function normalizePythonName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

const PYTHON_VERSION = /^[0-9][0-9A-Za-z.!+-]*$/;

function addPython(set: PackageSet, file: string, name: unknown, version: unknown): void {
  if (typeof name !== "string" || typeof version !== "string") return;
  if (!PYTHON_VERSION.test(version)) return;
  set.add({ ecosystem: "PyPI", name: normalizePythonName(name), version, file });
}

/** `requirements*.txt`: only exact pins (`name==1.2.3`, extras and markers allowed); hashes ignored. */
export function parseRequirements(file: string, text: string): LockedPackage[] {
  const set = new PackageSet();
  const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const raw of logical) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || line.startsWith("-")) continue;
    const spec = line.split(/\s+--/)[0]?.split(";")[0]?.trim() ?? "";
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*===?\s*([^\s,*]+)$/.exec(spec);
    if (match) addPython(set, file, match[1], match[2]);
  }
  return set.values();
}

/** `poetry.lock`: every `[[package]]` except directory, file, git and URL sources. */
export function parsePoetryLock(file: string, text: string): LockedPackage[] {
  const doc = parseToml(text) as Record<string, unknown>;
  const set = new PackageSet();
  const packages = Array.isArray(doc.package) ? doc.package : [];
  for (const entry of packages) {
    if (!isRecord(entry)) continue;
    const source = isRecord(entry.source) ? entry.source.type : undefined;
    if (typeof source === "string" && ["directory", "file", "git", "url"].includes(source)) {
      continue;
    }
    addPython(set, file, entry.name, entry.version);
  }
  return set.values();
}

/** `uv.lock`: every `[[package]]` resolved from a registry (the project itself and paths skipped). */
export function parseUvLock(file: string, text: string): LockedPackage[] {
  const doc = parseToml(text) as Record<string, unknown>;
  const set = new PackageSet();
  const packages = Array.isArray(doc.package) ? doc.package : [];
  for (const entry of packages) {
    if (!isRecord(entry) || !isRecord(entry.source) || !("registry" in entry.source)) continue;
    addPython(set, file, entry.name, entry.version);
  }
  return set.values();
}
