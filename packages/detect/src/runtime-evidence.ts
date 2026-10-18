import { isRecord } from "@opscrew/core";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { parse as parseYaml } from "yaml";
import { findDependency, parseTomlSafe, type ReadText, type Unit } from "./manifests";
import { basenameRel, dirnameRel, sortStrings } from "./paths";

type RuntimeEvidence = NonNullable<ProjectFacts["runtimeEvidence"]>;
type Language = keyof RuntimeEvidence;
type Evidence = NonNullable<RuntimeEvidence[Language]>[number];

const LANGUAGES: readonly Language[] = ["node", "python"];

/** The setup action and its version input in a GitHub workflow step, per language. */
const SETUP_ACTIONS: Record<Language, { action: string; input: string }> = {
  node: { action: "actions/setup-node", input: "node-version" },
  python: { action: "actions/setup-python", input: "python-version" },
};

/** Tool names in `.tool-versions` and `mise.toml`, per language. */
const TOOL_NAMES: Record<Language, readonly string[]> = {
  node: ["node", "nodejs"],
  python: ["python"],
};

/**
 * Python versions each Django release supports, as a PEP 440 range. Source: the Django FAQ, "What
 * Python version can I use with Django?" (docs.djangoproject.com/en/stable/faq/install/), as of
 * 2026-10: 4.2 supports 3.8–3.12, 5.0 3.10–3.12, 5.1 3.10–3.13, 5.2 3.10–3.14, 6.0 3.12–3.14.
 */
const DJANGO_PYTHON: Readonly<Record<string, string>> = {
  "4.2": ">=3.8,<3.13",
  "5.0": ">=3.10,<3.13",
  "5.1": ">=3.10,<3.14",
  "5.2": ">=3.10,<3.15",
  "6.0": ">=3.12,<3.15",
};

/** Workflow YAML with every scalar kept as a string, so `3.10` stays `3.10`. */
function parseWorkflow(text: string): unknown {
  try {
    return parseYaml(text, { schema: "failsafe" });
  } catch {
    return undefined;
  }
}

/** False for values that name no version: the system's own Python, or another implementation. */
function isVersion(value: string): boolean {
  return value !== "system" && !/^(?:pypy|graalpy)/.test(value);
}

/** The values of a setup step's version input, following a `${{ matrix.X }}` reference. */
function stepVersions(value: unknown, matrix: Record<string, unknown>): string[] {
  if (typeof value !== "string") return [];
  const reference = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value.trim())?.[1];
  if (reference !== undefined) {
    const listed = Array.isArray(matrix[reference]) ? (matrix[reference] as unknown[]) : [];
    const included = Array.isArray(matrix.include)
      ? matrix.include.map((entry) => (isRecord(entry) ? entry[reference] : undefined))
      : [];
    return [...listed, ...included].filter(
      (v): v is string => typeof v === "string" && isVersion(v),
    );
  }
  if (value.includes("${{")) return [];
  // setup-python takes several versions, one per line.
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && isVersion(line));
}

/** Versions the workflow's setup steps for `language` use, every matrix value included. */
export function workflowVersions(text: string, language: Language): string[] {
  const { action, input } = SETUP_ACTIONS[language];
  const doc = parseWorkflow(text);
  const jobs = isRecord(doc) && isRecord(doc.jobs) ? Object.values(doc.jobs) : [];
  const out: string[] = [];
  for (const job of jobs) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const matrix =
      isRecord(job.strategy) && isRecord(job.strategy.matrix) ? job.strategy.matrix : {};
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.uses !== "string") continue;
      if (!step.uses.startsWith(`${action}@`)) continue;
      out.push(...stepVersions(isRecord(step.with) ? step.with[input] : undefined, matrix));
    }
  }
  return out;
}

/** The version `.tool-versions` selects for `language`: the first real one its line lists. */
export function toolVersions(text: string, language: Language): string[] {
  for (const raw of text.split(/\r?\n/)) {
    const [tool, ...versions] = raw.replace(/#.*$/, "").trim().split(/\s+/);
    if (!tool || !TOOL_NAMES[language].includes(tool)) continue;
    const version = versions.find(isVersion);
    return version ? [version] : [];
  }
  return [];
}

/** The versions `mise.toml`'s `[tools]` gives `language`: a string, a list or `{ version }`. */
export function miseVersions(text: string, language: Language): string[] {
  const tools = parseTomlSafe(text)?.tools;
  if (!isRecord(tools)) return [];
  const out: string[] = [];
  for (const name of TOOL_NAMES[language]) {
    const value = tools[name];
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const version = isRecord(entry) ? entry.version : entry;
      if (typeof version === "string" && version.trim() !== "") out.push(version.trim());
    }
  }
  return out;
}

/**
 * The version in the last `FROM node:…` / `FROM python:…` of a Dockerfile, the stage that runs
 * (`20` for `node:20-alpine`), with global `ARG` defaults substituted. A tag without a leading
 * version (`lts`, none) gives none.
 */
export function dockerfileVersions(text: string, language: Language): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const firstFrom = lines.findIndex((line) => /^FROM\s/i.test(line));
  const args = new Map<string, string>();
  for (const line of lines.slice(0, Math.max(firstFrom, 0))) {
    const arg = /^ARG\s+([\w]+)=["']?([^"'\s]+)["']?/i.exec(line);
    if (arg?.[1] && arg[2]) args.set(arg[1], arg[2]);
  }
  let tag: string | undefined;
  for (const line of lines) {
    const image = /^FROM\s+(?:--\S+\s+)*(\S+)/i.exec(line)?.[1];
    if (!image) continue;
    const resolved = image
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => args.get(a ?? b) ?? all)
      .replace(/@.*$/, "");
    const slash = resolved.lastIndexOf("/");
    const colon = resolved.indexOf(":", slash + 1);
    const name = resolved.slice(slash + 1, colon < 0 ? undefined : colon);
    if (name === language) tag = colon < 0 ? "" : resolved.slice(colon + 1);
  }
  const version = /^\d+(?:\.\d+)*/.exec(tag ?? "")?.[0];
  return version ? [version] : [];
}

/** The major version of an npm version spec (`^20.11.0` gives `20`). */
function majorOf(spec: string | undefined): string | undefined {
  return /\d+/.exec(spec ?? "")?.[0];
}

/**
 * The Django release (`5.2`) a pip version spec names first as its version or lower bound
 * (`==5.2.1`, `>=5.2,<6`, `~=5.2`). Upper bounds and exclusions (`<`, `<=`, `!=`) are skipped, so
 * `django<5.2` gives none.
 */
function djangoRelease(spec: string | undefined): string | undefined {
  for (const clause of (spec ?? "").split(",")) {
    const match = /^\s*(?:={2,3}|~=|>=?|\^|~)?\s*(\d+)(?:\.(\d+))?/.exec(clause);
    if (match) return `${match[1]}.${match[2] ?? "0"}`;
  }
  return undefined;
}

/**
 * The Node and Python version evidence of FR-1228 rule 3, in its order, or `undefined` when there
 * is none. `files` are the repository files in scope, `find` gives a file by name in the app's
 * folder or the repository root (nearest first), `dockerfile` is the app's Dockerfile, and `units`
 * are the app's manifest folder and the root's.
 */
export async function runtimeEvidence(input: {
  files: readonly string[];
  find: (name: string) => string | undefined;
  read: ReadText;
  dockerfile: string | undefined;
  units: readonly Unit[];
}): Promise<RuntimeEvidence | undefined> {
  const { files, find, read, dockerfile, units } = input;
  const found: Record<Language, Evidence[]> = { node: [], python: [] };
  const add = (language: Language, values: Iterable<string>, source: string) => {
    for (const value of values) {
      if (!found[language].some((e) => e.value === value && e.source === source)) {
        found[language].push({ value, source });
      }
    }
  };
  const fromFile = async (
    path: string | undefined,
    parse: (text: string, language: Language) => string[],
  ) => {
    const text = path === undefined ? undefined : await read(path);
    if (path === undefined || text === undefined) return;
    for (const language of LANGUAGES) add(language, parse(text, language), path);
  };

  const workflows = sortStrings(
    files.filter((f) => dirnameRel(f) === ".github/workflows" && /\.ya?ml$/.test(basenameRel(f))),
  );
  for (const path of workflows) await fromFile(path, workflowVersions);
  await fromFile(find(".tool-versions"), toolVersions);
  await fromFile(find("mise.toml"), miseVersions);
  await fromFile(dockerfile, dockerfileVersions);

  for (const unit of units) {
    const typesNode = majorOf(findDependency(unit, "npm", "@types/node")?.version);
    const packageJson = unit.manifests.find((m) => basenameRel(m) === "package.json");
    if (typesNode && packageJson) add("node", [typesNode], packageJson);
  }
  for (const unit of units) {
    const release = djangoRelease(findDependency(unit, "pypi", "django")?.version);
    const range = release === undefined ? undefined : DJANGO_PYTHON[release];
    if (range) add("python", [range], `Django ${release}`);
  }

  const evidence: RuntimeEvidence = {};
  for (const language of LANGUAGES) {
    if (found[language].length > 0) evidence[language] = found[language];
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}
