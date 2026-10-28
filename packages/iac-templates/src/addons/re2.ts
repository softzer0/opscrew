import { TOKEN_PATTERNS } from "@opscrew/core";

/** One of OpsCrew's token patterns as Alloy's `stage.replace` takes it. */
export interface Re2TokenPattern {
  id: keyof typeof TOKEN_PATTERNS;
  /** RE2 syntax with exactly one capture group: the part `stage.replace` masks. */
  expression: string;
}

/** A leading negative lookbehind on one character class: `(?<![…])`. */
const LOOKBEHIND = /^\(\?<!\[([^\]]+)\]\)/;
/** A negative lookahead on one character class: `(?![…])`. */
const LOOKAHEAD = /\(\?!\[[^\]]+\]\)/g;

/**
 * {@link TOKEN_PATTERNS} in RE2 syntax, for Alloy's `stage.replace` (Go's `regexp`, which has no
 * lookaround). `stage.replace` masks only capture groups, so each token is the one capture group:
 * - a leading lookbehind becomes a non-capturing `(?:^|[^…])` before the group;
 * - a lookahead is dropped, which can only mask more (the greedy run before it already stops at
 *   the characters it refused), never less;
 * - a pattern that masks a group of its own (the AWS secret key's value) keeps it;
 * - the `i` flag becomes `(?i)`.
 * @throws Error for a pattern this conversion doesn't cover, so a new pattern in core fails here.
 */
export function re2TokenPatterns(): Re2TokenPattern[] {
  return Object.entries(TOKEN_PATTERNS).map(([id, pattern]) => {
    let source = pattern.source;
    let prefix = "";
    const behind = LOOKBEHIND.exec(source);
    if (behind) {
      prefix = `(?:^|[^${behind[1]}])`;
      source = source.slice(behind[0].length);
    }
    source = source.replace(LOOKAHEAD, "");
    if (/\(\?<?[=!]/.test(source)) {
      throw new Error(`The token pattern ${id} has a lookaround RE2 can't run: ${pattern.source}`);
    }
    const ownGroup = /\((?!\?)/.test(source);
    const flags = pattern.flags.includes("i") ? "(?i)" : "";
    return {
      id: id as Re2TokenPattern["id"],
      expression: `${flags}${prefix}${ownGroup ? source : `(${source})`}`,
    };
  });
}
