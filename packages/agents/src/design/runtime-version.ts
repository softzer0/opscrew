import { RUNTIME_DEFAULTS } from "@opscrew/iac-templates";
import type { AppBuild, ProjectFacts, RuntimeLanguage } from "@opscrew/plan-schema";

/** A language that has a version (every one except `other`). */
export type VersionedLanguage = Exclude<RuntimeLanguage, "other">;

/** Display names of the runtime languages. */
export const RUNTIME_NAMES: Readonly<Record<RuntimeLanguage, string>> = {
  node: "Node.js",
  python: "Python",
  ruby: "Ruby",
  go: "Go",
  java: "Java",
  dotnet: ".NET",
  php: "PHP",
  rust: "Rust",
  other: "this language",
};

/**
 * The oldest release line that still gets security fixes, per language OpsCrew warns for (FR-1228
 * rule 1), as of 2026-10:
 * - Node: 20 ended in 2026-04, so 22 is the oldest maintained LTS (nodejs.org/en/about/previous-releases);
 * - Python: 3.9 ended in 2025-10 (devguide.python.org/versions);
 * - Go: the two newest releases, 1.27 and 1.26, are supported (go.dev/doc/devel/release);
 * - Ruby: 3.2 ended in 2026-03 (ruby-lang.org/en/downloads/branches);
 * - PHP: 8.1 ended in 2025-12 (php.net/supported-versions.php);
 * - .NET: 8.0 (LTS) and 9.0 are supported until 2026-11 (dotnet.microsoft.com/platform/support/policy).
 * Java and Rust have no entry: Java's maintained LTS lines (8, 11, 17, 21, 25) are not one
 * threshold, and Rust supports only its latest stable release.
 */
export const OLDEST_MAINTAINED: Readonly<Partial<Record<VersionedLanguage, string>>> = {
  node: "22",
  python: "3.10",
  go: "1.26",
  ruby: "3.3",
  php: "8.2",
  dotnet: "8.0",
};

/** Node's LTS codenames as nvm writes them (`lts/iron`), with their majors (nodejs.org). */
const NODE_LTS_CODENAMES: Readonly<Record<string, string>> = {
  argon: "4",
  boron: "6",
  carbon: "8",
  dubnium: "10",
  erbium: "12",
  fermium: "14",
  gallium: "16",
  hydrogen: "18",
  iron: "20",
  jod: "22",
  krypton: "24",
};

type Parts = number[];

/** Parts of a version (`v20.11.1` → `[20, 11, 1]`), or `undefined` when it is not one. */
function partsOf(text: string): Parts | undefined {
  const match = /^v?(\d+(?:\.\d+){0,2})$/.exec(text);
  return match?.[1]?.split(".").map(Number);
}

function compare(a: Parts, b: Parts): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `version` starts with every part of `prefix` (`3.4` covers `3.4.10`, not `3.40`). */
function covers(prefix: Parts, version: Parts): boolean {
  return prefix.every((part, i) => version[i] === part);
}

/** `parts` with part `index` raised by one and everything after it dropped. */
function bump(parts: Parts, index: number): Parts {
  return [...parts.slice(0, index), (parts[index] ?? 0) + 1];
}

/** The release line a builder is given: the major for Node, major.minor for the others. */
function precision(language: VersionedLanguage): number {
  return language === "node" ? 1 : 2;
}

const text = (parts: Parts) => parts.join(".");

type Comparator =
  | { op: "prefix" | "not" | ">=" | ">" | "<"; v: Parts }
  | { op: "range"; low: Parts; high: Parts };

/**
 * One comparator of a range (`>=3.10`, `^8.2`, `~> 3.3`, `20.x`, `<=20.x`, `==3.12.*`), or
 * `undefined` for text that is not one. A wildcard tail is dropped, and `<=` a partial version
 * covers its whole line (`<=20` is `<21`).
 */
function comparator(token: string): Comparator | undefined {
  const match = /^(>=|<=|>|<|===|==|=|!=|~=|~>|~|\^)?v?(\d+(?:\.\d+)*)(?:\.[x*])*$/i.exec(token);
  if (match === null) return undefined;
  const [, op = "", digits = ""] = match;
  const v = digits.split(".").map(Number);
  if (v.length > 3) return undefined;
  switch (op) {
    case "":
    case "=":
    case "==":
    case "===":
      return { op: "prefix", v };
    case "!=":
      return { op: "not", v };
    case ">=":
    case ">":
    case "<":
      return { op, v };
    case "<=":
      return { op: "<", v: bump(v, v.length - 1) };
    case "~=":
    case "~>":
      // PEP 440 and RubyGems: `~=3.11` is `>=3.11, <4`; `~> 3.3.1` is `>=3.3.1, <3.4`.
      return { op: "range", low: v, high: v.length > 1 ? bump(v, v.length - 2) : bump(v, 0) };
    case "~":
      return { op: "range", low: v, high: bump(v, v.length > 1 ? 1 : 0) };
    default: {
      // `^`: up to the next change of the first non-zero part.
      const first = v.findIndex((part) => part !== 0);
      return { op: "range", low: v, high: bump(v, first === -1 ? v.length - 1 : first) };
    }
  }
}

/**
 * A range as alternatives of comparators that must all hold (`>=18 <23 || 24`, `18 - 20`), or
 * `undefined` when any part is not understood.
 */
function parseRange(spec: string): Comparator[][] | undefined {
  const alternatives = spec.split(/\|\|?/).map((alternative) =>
    alternative
      .trim()
      // A hyphen range: `18 - 20` is `>=18 <=20`.
      .replace(/^(\S+)\s+-\s+(\S+)$/, ">=$1 <=$2")
      .replace(/(>=|<=|>|<|==|!=|~=|~>|~|\^|=)\s+/g, "$1")
      .split(/[\s,]+/)
      .filter((token) => token !== "")
      .map(comparator),
  );
  if (alternatives.some((list) => list.length === 0 || list.includes(undefined))) return undefined;
  return alternatives as Comparator[][];
}

function holds(c: Comparator, v: Parts): boolean {
  switch (c.op) {
    case "prefix":
      return covers(c.v, v);
    case "not":
      return !covers(c.v, v);
    case ">=":
      return compare(v, c.v) >= 0;
    case ">":
      return compare(v, c.v) > 0;
    case "<":
      return compare(v, c.v) < 0;
    case "range":
      return compare(v, c.low) >= 0 && compare(v, c.high) < 0;
  }
}

const inside = (range: Comparator[][], v: Parts) =>
  range.some((all) => all.every((c) => holds(c, v)));

/** The release just below an exclusive bound: `<23` → 22, `<3.13` → 3.12, `<9.0.0` → 8. */
function below(bound: Parts): Parts | undefined {
  const parts = [...bound];
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  const last = parts[parts.length - 1] ?? 0;
  return last > 0 ? [...parts.slice(0, -1), last - 1] : undefined;
}

/**
 * The versions a range names itself: its lower bounds (the next patch above a `>` bound) and the
 * release below each upper bound.
 */
function bounds(alternatives: Comparator[][]): Parts[] {
  const named: Parts[] = [];
  for (const c of alternatives.flat()) {
    if (c.op === "prefix" || c.op === ">=") named.push(c.v);
    if (c.op === ">") named.push(bump([...c.v, 0, 0].slice(0, 3), 2));
    if (c.op === "range") named.push(c.low);
    const upper = c.op === "<" ? c.v : c.op === "range" ? c.high : undefined;
    const under = upper === undefined ? undefined : below(upper);
    if (under !== undefined) named.push(under);
  }
  return named;
}

/** A version as declared without its tool prefix (`ruby-3.3.0`, `python-3.12`, `go1.22`). */
function stripPrefix(language: VersionedLanguage, value: string): string {
  const trimmed = value.trim().replace(/^(?:ruby-|python-|go(?=\d))/i, "");
  // Java's old release levels: `1.8` is Java 8.
  return language === "java" ? trimmed.replace(/^1\.(\d+)$/, "$1") : trimmed;
}

/** How a declared value reads: an exact version, a range, or neither (`node`, `stable`). */
type Declaration = { exact: string } | { range: Comparator[][] } | undefined;

function declaration(language: VersionedLanguage, value: string): Declaration {
  let stripped = stripPrefix(language, value);
  if (language === "node") {
    // nvm's LTS aliases: `lts/*` is the current LTS, OpsCrew's default.
    const lts = /^lts\/(\*|[a-z]+)$/i.exec(stripped)?.[1]?.toLowerCase();
    if (lts !== undefined)
      stripped = lts === "*" ? RUNTIME_DEFAULTS.node : (NODE_LTS_CODENAMES[lts] ?? "");
  }
  const exact = partsOf(stripped);
  if (exact !== undefined && language === "go") {
    // go.mod's `go` and `toolchain` lines are minimums within their release line.
    return { range: [[{ op: "range", low: exact, high: bump(exact, 1) }]] };
  }
  if (exact !== undefined) return { exact: stripped.replace(/^v/, "") };
  const range = parseRange(stripped);
  return range === undefined ? undefined : { range };
}

function satisfies(range: Comparator[][], version: string): boolean {
  const parts = partsOf(version);
  return parts !== undefined && inside(range, parts);
}

/**
 * The newest version inside `range` (rule 2): the newest offered one when a builder offers one
 * there, recorded at the language's release line; else the newest of OpsCrew's default and the
 * versions the range names itself, at the release line, or as precise as found when the builder's
 * offers miss the range (so the version reads as not offered). `undefined` when none is inside.
 */
function newestInside(
  language: VersionedLanguage,
  range: Comparator[][],
  offers: readonly string[],
): string | undefined {
  const within = (versions: (Parts | undefined)[]) =>
    versions.filter((v): v is Parts => v !== undefined && inside(range, v)).sort(compare);
  const offer = within(offers.map(partsOf)).at(-1);
  if (offer !== undefined) return text(offer.slice(0, precision(language)));
  const newest = within([partsOf(RUNTIME_DEFAULTS[language]), ...bounds(range)]).at(-1);
  if (newest === undefined) return undefined;
  return text(offers.length > 0 ? newest : newest.slice(0, precision(language)));
}

/** A declared value resolved: exact as declared, else the newest inside its range. */
function resolveDeclared(
  language: VersionedLanguage,
  declared: Declaration,
  offers: readonly string[],
): string | undefined {
  if (declared === undefined) return undefined;
  if ("exact" in declared) return declared.exact;
  return newestInside(language, declared.range, offers);
}

/** Evidence sources that count as one: every CI workflow of the repository. */
const sourceGroup = (source: string) =>
  source.startsWith(".github/workflows/") ? ".github/workflows" : source;

/** The newest version the first evidence source gives (every workflow and matrix value counts). */
function fromEvidence(
  language: VersionedLanguage,
  facts: ProjectFacts,
  offers: readonly string[],
): string | undefined {
  const evidence =
    language === "node" || language === "python" ? (facts.runtimeEvidence?.[language] ?? []) : [];
  for (const group of [...new Set(evidence.map((e) => sourceGroup(e.source)))]) {
    const versions = evidence
      .filter((e) => sourceGroup(e.source) === group)
      .map((e) => resolveDeclared(language, declaration(language, e.value), offers))
      .filter((v): v is string => v !== undefined)
      .sort((a, b) => compare(partsOf(a) ?? [], partsOf(b) ?? []));
    const newest = versions.at(-1);
    if (newest !== undefined) return newest;
  }
  return undefined;
}

/** The release line of a version (`24.1.0` → `24`, `3.12.4` → `3.12`). */
function line(language: VersionedLanguage, version: string): string {
  return text((partsOf(version) ?? []).slice(0, precision(language)));
}

/** The runtime a builder is given, and warnings about it. */
export interface ResolvedRuntime {
  runtime: AppBuild["runtime"];
  /** Plain-English warnings: an end of life, a change of release line, an unreadable declaration. */
  warnings: string[];
}

/**
 * The runtime version for `language` (FR-1228): a version the app declares exactly is kept as
 * declared; a declared range (go.mod's minimum is one) keeps the version `plan.yaml` recorded when
 * it is inside, else gives the newest offered, default or named version inside it; with nothing
 * declared, the version `plan.yaml` recorded is kept, else the evidence (CI, `.tool-versions`, …)
 * applies, else {@link RUNTIME_DEFAULTS}. `offers` are the versions the builder provides
 * (Buildpacks), matched by prefix. Warns when the version is past its end of life, when the app's
 * declaration moves the recorded version to another release line, when `plan.yaml` asks for a
 * newer release line than the app's evidence or OpsCrew's default, and when a declaration cannot
 * be read or has no version inside it.
 */
export function resolveRuntime(
  language: RuntimeLanguage,
  facts: ProjectFacts,
  recorded: AppBuild["runtime"] | undefined,
  offers: readonly string[] = [],
): ResolvedRuntime {
  if (language === "other") return { runtime: { language }, warnings: [] };
  const name = RUNTIME_NAMES[language];
  const kept = recorded?.language === language ? recorded.version : undefined;
  const raw = facts.runtimeVersions[language]?.trim();
  const declared = raw === undefined ? undefined : declaration(language, raw);
  const resolved = resolveDeclared(language, declared, offers);
  const warnings: string[] = [];

  let version: string;
  if (declared !== undefined && resolved !== undefined) {
    const keepRecorded =
      "range" in declared && kept !== undefined && satisfies(declared.range, kept);
    version = keepRecorded ? (kept as string) : resolved;
    if (kept !== undefined && line(language, kept) !== line(language, version)) {
      warnings.push(
        `The app declares ${name} ${raw}, so OpsCrew moves it from ${name} ${kept} (recorded in opscrew/plan.yaml) to ${version}. A new release line can break the app's libraries: test the app on it before you deploy.`,
      );
    }
  } else {
    const derived = fromEvidence(language, facts, offers) ?? RUNTIME_DEFAULTS[language];
    version = kept ?? derived;
    if (raw !== undefined) {
      // FR-1228 rules 1, 2 and 7: a declaration OpsCrew cannot follow is never passed over silently.
      const problem =
        declared === undefined
          ? `OpsCrew cannot read the ${name} version the app declares ("${raw}")`
          : `No ${name} version fits the range the app declares ("${raw}")`;
      const which = kept === undefined ? "" : " (recorded in opscrew/plan.yaml)";
      warnings.push(
        `${problem}, so OpsCrew uses ${name} ${version}${which}. To pin a version, set app.build.runtime.version in opscrew/plan.yaml or declare an exact version in the app.`,
      );
    } else if (
      compare(partsOf(line(language, version)) ?? [], partsOf(line(language, derived)) ?? []) > 0
    ) {
      warnings.push(
        `opscrew/plan.yaml asks for ${name} ${version}, a newer release line than ${derived}. A new release line can break the app's libraries: test the app on it before you deploy.`,
      );
    }
  }

  const oldest = OLDEST_MAINTAINED[language];
  if (oldest !== undefined && compare(partsOf(version) ?? [], partsOf(oldest) ?? []) < 0) {
    warnings.push(
      `${name} ${version} is past its end of life and gets no security fixes. OpsCrew keeps it because the app uses it; move the app to ${name} ${oldest} or newer when you can.`,
    );
  }
  return { runtime: { language, version }, warnings };
}

/** True when one of `offers` is `version` at its precision (`3.4` matches `3.4.10`, `4.0.7` not `4.0.6`). */
export function offered(version: string, offers: readonly string[]): boolean {
  const wanted = partsOf(version);
  return (
    wanted !== undefined &&
    offers.some((offer) => {
      const parts = partsOf(offer);
      return parts !== undefined && covers(wanted, parts);
    })
  );
}
