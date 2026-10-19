/**
 * Manifest readers. A "unit" is a directory holding at least one manifest (package.json,
 * pyproject.toml, requirements*.txt, Pipfile, Gemfile, composer.json, go.mod, Cargo.toml, pom.xml,
 * build.gradle(.kts), *.csproj); detection reasons about units rather than single files.
 */
import { isRecord, stripBom } from "@opscrew/core";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { basenameRel, dirnameRel, joinRel, sortStrings } from "./paths";

/** Where a dependency was declared (`maven` covers Gradle too: both name `group:artifact`). */
export type DependencyEcosystem = "npm" | "pypi" | "gem" | "composer" | "go" | "maven" | "nuget";

/**
 * One declared dependency, with its name normalised for its ecosystem: Go module paths lose their
 * major version suffix (`/v9`), Maven and Gradle ones are `group:artifact`, NuGet ones keep their
 * case.
 */
export interface Dependency {
  ecosystem: DependencyEcosystem;
  name: string;
  /** Version spec as written (`^18.3.1`, `==0.115.0`), when present. */
  version?: string;
  /** Declared only for development or tests (devDependencies, a test scope, group or project). */
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
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

/** True for `requirements.txt`, `requirements-dev.txt`, `requirements_prod.txt`, … */
export function isRequirementsFile(name: string): boolean {
  return /^requirements(?:[-_.][\w.-]+)?\.txt$/i.test(name);
}

function isManifest(path: string): boolean {
  const name = basenameRel(path);
  return MANIFEST_NAMES.has(name) || isRequirementsFile(name) || name.endsWith(".csproj");
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

/** True when a Gemfile group list (`:development, :test`, `[:test]`) names only those groups. */
function devGemGroups(list: string): boolean {
  const groups = [...list.matchAll(/:(\w+)|["'](\w+)["']/g)].map((match) => match[1] ?? match[2]);
  return groups.length > 0 && groups.every((group) => group === "development" || group === "test");
}

/** Gems, those of `development` and `test` groups (a block or a `group:` option) as dev. */
function readGemfile(text: string, deps: Dependency[]): void {
  // The open `do … end` (and `if`/`unless`) blocks, each true for a development or test group.
  const blocks: boolean[] = [];
  for (const line of text.split(/\r?\n/)) {
    const code = line.replace(/#.*$/, "").trim();
    const gem = /^gem\s+["']([\w.-]+)["'](?:\s*,\s*["']([^"']+)["'])?(.*)$/.exec(code);
    if (gem?.[1]) {
      const option = /\bgroups?:\s*(\[[^\]]*\]|:\w+|["']\w+["'])/.exec(gem[3] ?? "")?.[1];
      deps.push({
        ecosystem: "gem",
        name: gem[1],
        ...(gem[2] ? { version: gem[2] } : {}),
        dev: blocks.includes(true) || (option !== undefined && devGemGroups(option)),
        extras: [],
      });
      continue;
    }
    const group = /^group\s+(.+?)\s+do\b/.exec(code);
    if (group?.[1]) blocks.push(devGemGroups(group[1]));
    else if (/\bdo(?:\s*\|[^|]*\|)?$/.test(code) || /^(?:if|unless)\b/.test(code)) {
      blocks.push(false);
    } else if (/^end\b/.test(code)) blocks.pop();
  }
}

/** go.mod requirements (single-line and blocks), without `// indirect` ones. */
function readGoMod(text: string, deps: Dependency[]): void {
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    const spec = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
    if (!spec || spec.startsWith("//") || /\/\/\s*indirect\b/.test(spec)) continue;
    const match = /^(\S+)\s+(v\S+)/.exec(spec);
    if (match?.[1]) {
      const name = match[1].replace(/\/v\d+$/, "");
      deps.push({ ecosystem: "go", name, version: match[2] as string, dev: false, extras: [] });
    }
  }
}

/** The text of the first `<name>` element in `xml`, trimmed. */
function xmlElement(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] || undefined;
}

/**
 * pom.xml dependencies (`group:artifact`), `test` scope as dev. Managed versions
 * (`<dependencyManagement>`) and build plugins' dependencies are not the app's.
 */
function readPom(text: string, deps: Dependency[]): void {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
    .replace(/<build>[\s\S]*?<\/build>/g, "");
  for (const match of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const xml = match[1] ?? "";
    const group = xmlElement(xml, "groupId");
    const artifact = xmlElement(xml, "artifactId");
    if (!group || !artifact) continue;
    const version = xmlElement(xml, "version");
    deps.push({
      ecosystem: "maven",
      name: `${group}:${artifact}`,
      ...(version ? { version } : {}),
      dev: xmlElement(xml, "scope") === "test",
      extras: [],
    });
  }
}

/** Gradle configurations whose dependencies are on the app's runtime classpath. */
const GRADLE_RUNTIME = new Set(["implementation", "api", "runtimeOnly", "compile", "runtime"]);

/**
 * The libraries of a Gradle version catalog (`gradle/libs.versions.toml`) by their accessor
 * (`spring-kafka` is `libs.spring.kafka`), as `group:artifact`.
 */
export function gradleCatalog(text: string | undefined): Map<string, string> {
  const catalog = new Map<string, string>();
  const libraries = parseTomlSafe(text)?.libraries;
  if (!isRecord(libraries)) return catalog;
  for (const [alias, entry] of Object.entries(libraries)) {
    const coordinates =
      typeof entry === "string"
        ? entry
        : isRecord(entry) && typeof entry.module === "string"
          ? entry.module
          : isRecord(entry) && typeof entry.group === "string" && typeof entry.name === "string"
            ? `${entry.group}:${entry.name}`
            : undefined;
    const [group, artifact] = coordinates?.split(":") ?? [];
    if (group && artifact) catalog.set(alias.replace(/[-_.]/g, "."), `${group}:${artifact}`);
  }
  return catalog;
}

/**
 * Gradle `configuration("group:artifact:version")` and `configuration(libs.alias)` lines (through
 * `catalog`); other configurations than the runtime ones are dev. `constraints { … }` only pin
 * versions, like Maven's `<dependencyManagement>`.
 */
function readGradle(text: string, deps: Dependency[], catalog: ReadonlyMap<string, string>): void {
  const body = text.replace(/\bconstraints\s*\{[^{}]*\}/g, "");
  const add = (configuration: string, name: string, version?: string) =>
    deps.push({
      ecosystem: "maven",
      name,
      ...(version ? { version } : {}),
      dev: !GRADLE_RUNTIME.has(configuration),
      extras: [],
    });
  for (const match of body.matchAll(
    /^\s*(\w+)\s*\(?\s*["']([\w.-]+):([\w.-]+)(?::([^"'@:]+))?[^"']*["']/gm,
  )) {
    add(match[1] as string, `${match[2]}:${match[3]}`, match[4]);
  }
  for (const match of body.matchAll(/^\s*(\w+)\s*\(?\s*libs\.([\w.]+?)\s*\)?\s*$/gm)) {
    const name = catalog.get(match[2] as string);
    if (name) add(match[1] as string, name);
  }
}

/** A .NET project's package references; every one of a test project is dev. */
function readCsproj(path: string, text: string, deps: Dependency[]): void {
  const testProject =
    /\.Tests?\.csproj$/i.test(path) ||
    /<IsTestProject>\s*true\s*</i.test(text) ||
    /\bInclude\s*=\s*"Microsoft\.NET\.Test\.Sdk"/i.test(text);
  for (const match of text.matchAll(/<PackageReference\b([^>]*)>/g)) {
    const attributes = match[1] ?? "";
    const name = /\bInclude\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
    if (!name) continue;
    const version = /\bVersion\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
    deps.push({
      ecosystem: "nuget",
      name,
      ...(version ? { version } : {}),
      dev: testProject,
      extras: [],
    });
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
      } else if (name === "go.mod") {
        readGoMod(text, dependencies);
      } else if (name === "pom.xml") {
        readPom(text, dependencies);
      } else if (name.startsWith("build.gradle")) {
        const catalog =
          (await read(joinRel(dir, "gradle/libs.versions.toml"))) ??
          (await read("gradle/libs.versions.toml"));
        readGradle(text, dependencies, gradleCatalog(catalog));
      } else if (name.endsWith(".csproj")) {
        readCsproj(name, text, dependencies);
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
