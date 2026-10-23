/**
 * npm's version ranges, as far as adapter peer dependencies use them (`^7.4.0`, `>=15.5.0 <17`,
 * `^2.0.0 || ^3.0.0`, `1.2 - 2`, `16.x`, `*`), for picking the adapter release that supports the
 * app's framework version. Prerelease tags are dropped: OpsCrew compares releases only.
 */

/** A version as `[major, minor, patch]`. */
export type Version = readonly [number, number, number];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** `1.2.3` (with an optional `v`, prerelease and build tag) as a {@link Version}, else undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True for a prerelease such as `15.0.0-beta.1`. */
export function isPrerelease(text: string): boolean {
  return /^v?\d+\.\d+\.\d+-/.test(text.trim());
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** `parts` with part `index` raised by one and the parts after it zero. */
function bump(parts: readonly number[], index: number): Version {
  const out = [0, 0, 0];
  for (let i = 0; i < index; i++) out[i] = parts[i] ?? 0;
  out[index] = (parts[index] ?? 0) + 1;
  return out as unknown as Version;
}

function filled(parts: readonly number[]): Version {
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

type Test = (version: Version) => boolean;

const COMPARATOR =
  /^(<=|>=|<|>|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** One comparator (`^7.4.0`, `<17`, `16.x`, `*`) as a test, or undefined when it is not one. */
function comparator(token: string): Test | undefined {
  const match = COMPARATOR.exec(token);
  if (match === null) return undefined;
  const op = match[1] ?? "";
  // The parts given, up to the first wildcard: `16.x` gives [16].
  const parts: number[] = [];
  for (const part of match.slice(2, 5)) {
    if (part === undefined || !/^\d+$/.test(part)) break;
    parts.push(Number(part));
  }
  const n = parts.length;
  const at = (low: Version, high?: Version): Test => {
    return (v) =>
      compareVersions(v, low) >= 0 && (high === undefined || compareVersions(v, high) < 0);
  };
  const zero: Version = [0, 0, 0];
  if (n === 0) return op === "<" || op === ">" ? () => false : () => true;
  switch (op) {
    case "":
    case "=":
      return at(filled(parts), bump(parts, n - 1));
    case "^": {
      const first = parts.findIndex((part) => part !== 0);
      return at(filled(parts), bump(parts, first === -1 ? n - 1 : first));
    }
    case "~":
      return at(filled(parts), bump(parts, n >= 2 ? 1 : 0));
    case ">=":
      return at(filled(parts));
    case ">":
      return at(bump(parts, n - 1));
    case "<":
      return at(zero, filled(parts));
    default:
      // `<=`: up to the end of what is given (`<=1.2` is `<1.3.0`).
      return at(zero, bump(parts, n - 1));
  }
}

/**
 * Whether `version` (an exact release) is inside the npm `range`; undefined when either cannot be
 * read (a tag such as `latest`, a `workspace:` or URL spec).
 */
export function satisfiesRange(range: string, version: Version): boolean | undefined {
  const alternatives: Test[][] = [];
  for (const alternative of range.split("||")) {
    const text = alternative
      .trim()
      // A hyphen range: `1.2 - 2` is `>=1.2 <=2`.
      .replace(/^(\S+)\s+-\s+(\S+)$/, (_all, low: string, high: string) => `>=${low} <=${high}`)
      .replace(/(<=|>=|<|>|=|\^|~)\s+/g, (_all, op: string) => op);
    const tests = text === "" ? [() => true] : text.split(/\s+/).map(comparator);
    if (tests.some((test) => test === undefined)) return undefined;
    alternatives.push(tests as Test[]);
  }
  return alternatives.some((tests) => tests.every((test) => test(version)));
}

/**
 * The lowest release a dependency spec in package.json allows (`7.3.8`, `^16.4.0` → 16.4.0,
 * `~7.3` → 7.3.0, `>=7` → 7.0.0, `7.x` → 7.0.0), or undefined for one OpsCrew cannot read
 * (`latest`, `*`, `workspace:*`, a URL, an upper bound only).
 */
export function lowestAllowed(spec: string): Version | undefined {
  const match =
    /^\s*(?:\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[\w.-]+)?\s*(?:$|\s|\|\|)/.exec(
      spec,
    );
  if (match === null) return undefined;
  const parts = match
    .slice(1, 4)
    .map((part) => (part !== undefined && /^\d+$/.test(part) ? Number(part) : 0));
  return filled(parts);
}

/** A version as text: `7.3.8`. */
export function versionText(version: Version): string {
  return version.join(".");
}
