/**
 * Manifest readers. A "unit" is a directory holding at least one manifest (package.json,
 * pyproject.toml, requirements*.txt, Pipfile, Gemfile, composer.json, go.mod, Cargo.toml);
 * detection reasons about units rather than single files.
 */
import { isRecord, stripBom } from "@opscrew/core";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { basenameRel, dirnameRel, sortStrings } from "./paths";

/** Where a dependency was declared. */
export type DependencyEcosystem = "npm" | "pypi" | "gem" | "composer";

/** One declared dependency, with its name normalised for its ecosystem. */
export interface Dependency {
  ecosystem: DependencyEcosystem;
  name: string;
  /** Version spec as written (`^18.3.1`, `==0.115.0`), when present. */
  version?: string;
  /** Declared only for development (devDependencies). */
  dev: boolean;
  /** Python extras such as `redis` in `celery[redis]`. */
  extras: string[];
}

/** The subset of package.json that detection uses. */
export interface PackageJson {
  name?: string;
  main?: string;
  scripts: Record<string, string>;
  workspaces?: string[];
  engineNode?: string;
  voltaNode?: string;
  packageManager?: string;
}

/** The subset of Python project metadata that detection uses. */
export interface PythonProject {
  name?: string;
  requiresPython?: string;
  usesPoetry: boolean;
  /** Python version from Pipfile `[requires]`. */
  pipfilePython?: string;
}

/** A directory with one or more manifests. */
export interface Unit {
  /** Repo-relative directory (`.` for the root). */
  dir: string;
  /** Manifest files found directly in `dir` (repo-relative). */
  manifests: string[];
  packageJson?: PackageJson;
  python?: PythonProject;
  dependencies: Dependency[];
}

/** Reads a repo-relative text file; `undefined` when missing or unreadable. */
export type ReadText = (path: string) => Promise<string | undefined>;

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "Pipfile",
  "Gemfile",
  "composer.json",
  "go.mod",
  "Cargo.toml",
]);

/** True for `requirements.txt`, `requirements-dev.txt`, `requirements_prod.txt`, … */
export function isRequirementsFile(name: string): boolean {
  return /^requirements(?:[-_.][\w.-]+)?\.txt$/i.test(name);
}

function isManifest(path: string): boolean {
  const name = basenameRel(path);
  return MANIFEST_NAMES.has(name) || isRequirementsFile(name);
}

/** Normalises a PyPI project name (PEP 503): lower case, runs of `-_.` become `-`. */
export function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Parses JSON text, tolerating a BOM; `undefined` when invalid. */
export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripBom(text));
  } catch {
    return undefined;
  }
}

/** Parses TOML text, tolerating a BOM; `undefined` when invalid. */
export function parseTomlSafe(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    return parseToml(stripBom(text)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Parses YAML text; `undefined` when invalid. */
export function parseYamlSafe(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

function readPackageJson(data: unknown, dependencies: Dependency[]): PackageJson | undefined {
  if (!isRecord(data)) return undefined;
  const pkg: PackageJson = { scripts: stringRecord(data.scripts) };
  const name = nonEmpty(data.name);
  if (name) pkg.name = name;
  const main = nonEmpty(data.main);
  if (main) pkg.main = main;
  const workspaces = isRecord(data.workspaces)
    ? stringArray(data.workspaces.packages)
    : stringArray(data.workspaces);
  if (workspaces) pkg.workspaces = workspaces;
  const engineNode = isRecord(data.engines) ? nonEmpty(data.engines.node) : undefined;
  if (engineNode) pkg.engineNode = engineNode;
  const voltaNode = isRecord(data.volta) ? nonEmpty(data.volta.node) : undefined;
  if (voltaNode) pkg.voltaNode = voltaNode;
  const packageManager = nonEmpty(data.packageManager);
  if (packageManager) pkg.packageManager = packageManager;

  const groups: [unknown, boolean][] = [
    [data.dependencies, false],
    [data.optionalDependencies, false],
    [data.devDependencies, true],
  ];
  for (const [group, dev] of groups) {
    for (const [depName, version] of Object.entries(stringRecord(group))) {
      dependencies.push({ ecosystem: "npm", name: depName, version, dev, extras: [] });
    }
  }
  return pkg;
}

/** Parses one PEP 508 requirement (`celery[redis]>=5 ; python_version>"3"`). */
export function parseRequirement(line: string): Omit<Dependency, "ecosystem" | "dev"> | undefined {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*([^;#@]*)/.exec(line);
  if (!match?.[1]) return undefined;
  const extras = (match[2] ?? "")
    .split(",")
    .map((extra) => normalizePythonName(extra.trim()))
    .filter(Boolean);
  const spec = (match[3] ?? "").trim().replace(/\s+/g, "");
  const pinned = /^===?([^,]+)$/.exec(spec)?.[1];
  const version = pinned ?? (spec || undefined);
  return {
    name: normalizePythonName(match[1]),
    ...(version ? { version } : {}),
    extras,
  };
}

/** Dependencies listed in a requirements file (options, includes and URLs are skipped). */
export function parseRequirementsFile(text: string): Omit<Dependency, "ecosystem" | "dev">[] {
  const out: Omit<Dependency, "ecosystem" | "dev">[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) continue;
    const requirement = parseRequirement(line);
    if (requirement) out.push(requirement);
  }
  return out;
}

function addPython(
  dependencies: Dependency[],
  requirement: Omit<Dependency, "ecosystem" | "dev"> | undefined,
  dev = false,
): void {
  if (requirement) dependencies.push({ ecosystem: "pypi", dev, ...requirement });
}

function addPoetryTable(dependencies: Dependency[], table: unknown, dev: boolean): void {
  if (!isRecord(table)) return;
  for (const [name, value] of Object.entries(table)) {
    if (name.toLowerCase() === "python") continue;
    const version = typeof value === "string" ? value : isRecord(value) ? value.version : undefined;
    const extras = isRecord(value) ? (stringArray(value.extras) ?? []) : [];
    dependencies.push({
      ecosystem: "pypi",
      name: normalizePythonName(name),
      ...(typeof version === "string" && version !== "*" ? { version } : {}),
      dev,
      extras: extras.map(normalizePythonName),
    });
  }
}

function readPyproject(data: Record<string, unknown>, deps: Dependency[], py: PythonProject): void {
  const project = isRecord(data.project) ? data.project : {};
  const tool = isRecord(data.tool) ? data.tool : {};
  const poetry = isRecord(tool.poetry) ? tool.poetry : undefined;
  py.name ??= nonEmpty(project.name) ?? nonEmpty(poetry?.name);
  py.requiresPython ??= nonEmpty(project["requires-python"]);
  for (const requirement of stringArray(project.dependencies) ?? []) {
    addPython(deps, parseRequirement(requirement));
  }
  if (poetry) {
    py.usesPoetry = true;
    const poetryDeps = poetry.dependencies;
    if (isRecord(poetryDeps)) py.requiresPython ??= nonEmpty(poetryDeps.python);
    addPoetryTable(deps, poetryDeps, false);
    addPoetryTable(deps, poetry["dev-dependencies"], true);
    if (isRecord(poetry.group)) {
      for (const group of Object.values(poetry.group)) {
        if (isRecord(group)) addPoetryTable(deps, group.dependencies, true);
      }
    }
  }
}

function readPipfile(data: Record<string, unknown>, deps: Dependency[], py: PythonProject): void {
  addPoetryTable(deps, data.packages, false);
  addPoetryTable(deps, data["dev-packages"], true);
  const requires = isRecord(data.requires) ? data.requires : {};
  py.pipfilePython ??= nonEmpty(requires.python_full_version) ?? nonEmpty(requires.python_version);
}

function readGemfile(text: string, deps: Dependency[]): void {
  for (const match of text.matchAll(/^\s*gem\s+["']([\w.-]+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) {
    if (match[1]) {
      deps.push({
        ecosystem: "gem",
        name: match[1],
        ...(match[2] ? { version: match[2] } : {}),
        dev: false,
        extras: [],
      });
    }
  }
}

function readComposer(data: unknown, deps: Dependency[]): void {
  if (!isRecord(data)) return;
  for (const [group, dev] of [
    [data.require, false],
    [data["require-dev"], true],
  ] as const) {
    for (const [name, version] of Object.entries(stringRecord(group))) {
      deps.push({ ecosystem: "composer", name: name.toLowerCase(), version, dev, extras: [] });
    }
  }
}

/** Keeps one entry per (ecosystem, name); a runtime declaration wins over a dev one. */
function dedupeDependencies(dependencies: Dependency[]): Dependency[] {
  const byKey = new Map<string, Dependency>();
  for (const dep of dependencies) {
    const key = `${dep.ecosystem}:${dep.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...dep, extras: [...dep.extras] });
      continue;
    }
    if (existing.dev && !dep.dev) {
      existing.dev = false;
      if (dep.version) existing.version = dep.version;
    }
    existing.version ??= dep.version;
    existing.extras = sortStrings(new Set([...existing.extras, ...dep.extras]));
  }
  return [...byKey.values()].sort((a, b) =>
    a.ecosystem === b.ecosystem ? (a.name < b.name ? -1 : 1) : a.ecosystem < b.ecosystem ? -1 : 1,
  );
}

/** Groups manifest files by directory and reads each unit (sorted by directory). */
export async function readUnits(files: readonly string[], read: ReadText): Promise<Unit[]> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    if (!isManifest(file)) continue;
    const dir = dirnameRel(file);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }

  const units: Unit[] = [];
  for (const dir of sortStrings(byDir.keys())) {
    const manifests = sortStrings(byDir.get(dir) ?? []);
    const dependencies: Dependency[] = [];
    const unit: Unit = { dir, manifests, dependencies: [] };
    const python: PythonProject = { usesPoetry: false };
    let hasPython = false;

    for (const manifest of manifests) {
      const name = basenameRel(manifest);
      const text = await read(manifest);
      if (text === undefined) continue;
      if (name === "package.json") {
        const pkg = readPackageJson(parseJson(text), dependencies);
        if (pkg) unit.packageJson = pkg;
      } else if (name === "pyproject.toml") {
        hasPython = true;
        const data = parseTomlSafe(text);
        if (data) readPyproject(data, dependencies, python);
      } else if (name === "Pipfile") {
        hasPython = true;
        const data = parseTomlSafe(text);
        if (data) readPipfile(data, dependencies, python);
      } else if (isRequirementsFile(name)) {
        hasPython = true;
        const dev = /dev|test|lint/i.test(name);
        for (const requirement of parseRequirementsFile(text)) {
          addPython(dependencies, requirement, dev);
        }
      } else if (name === "Gemfile") {
        readGemfile(text, dependencies);
      } else if (name === "composer.json") {
        readComposer(parseJson(text), dependencies);
      }
    }
    if (hasPython) unit.python = python;
    unit.dependencies = dedupeDependencies(dependencies);
    units.push(unit);
  }
  return units;
}

/** Finds a dependency of a unit by ecosystem and (normalised) name. */
export function findDependency(
  unit: Unit,
  ecosystem: DependencyEcosystem,
  name: string,
): Dependency | undefined {
  const wanted = ecosystem === "pypi" ? normalizePythonName(name) : name;
  return unit.dependencies.find((dep) => dep.ecosystem === ecosystem && dep.name === wanted);
}

/** Workspace globs from package.json `workspaces`, `pnpm-workspace.yaml` or `lerna.json`. */
export function workspacePatterns(
  rootPackage: PackageJson | undefined,
  pnpmWorkspace: string | undefined,
  lernaJson: string | undefined,
): string[] {
  const patterns = new Set<string>(rootPackage?.workspaces ?? []);
  const pnpm = parseYamlSafe(pnpmWorkspace);
  if (isRecord(pnpm)) for (const p of stringArray(pnpm.packages) ?? []) patterns.add(p);
  const lerna = parseJson(lernaJson);
  if (isRecord(lerna)) for (const p of stringArray(lerna.packages) ?? []) patterns.add(p);
  return [...patterns];
}

function globToRegExp(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i] as string;
    if (char === "*" && clean[i + 1] === "*") {
      i++;
      if (clean[i + 1] === "/") {
        source += "(?:.*/)?";
        i++;
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when `dir` matches the workspace globs (`!pattern` excludes). */
export function matchesWorkspace(dir: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(dir)) return false;
    } else if (globToRegExp(pattern).test(dir)) {
      matched = true;
    }
  }
  return matched;
}
