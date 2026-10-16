import { isSecretEnvName } from "./env";

/** A pattern that finds one kind of secret in free text. */
export interface RedactionRule {
  /** Stable id, used in the replacement `[REDACTED:<id>]`. */
  id: string;
  /** Pattern with the global flag. */
  pattern: RegExp;
  /** Capture group holding the secret; only that part is replaced. Defaults to the whole match. */
  group?: number;
  /** Extra check on the captured secret; return false to leave the match alone. */
  validate?(secret: string): boolean;
}

const PLACEHOLDER_PREFIX = "[REDACTED:";
const LABELLED_FORBIDDEN = /[.(){}$<>]/;

/** Shannon entropy of `value` in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const total = [...value].length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Values like `$VAR`, `${VAR}`, `<password>` or `****` are placeholders, not secrets. */
function isPlaceholder(value: string): boolean {
  return /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\*+)$/.test(value);
}

/**
 * Patterns for the token families with a recognisable shape, by id: the redactor masks them and
 * the secret scanner reports them. Each has the global flag; `aws-secret-access-key` captures the
 * key in group 1 (the match includes its label). Use them with `matchAll` or `replace`, or copy
 * them (`new RegExp(pattern)`) before calling `exec` or `test`, which keep state in `lastIndex`.
 */
export const TOKEN_PATTERNS = {
  "github-token": /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,251}(?![A-Za-z0-9])/g,
  "github-pat": /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,255}/g,
  "anthropic-api-key": /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g,
  "openai-api-key":
    /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,}(?![A-Za-z0-9_-]))/g,
  "aws-access-key-id": /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  "aws-secret-access-key":
    /aws_?secret_?access_?key["']?\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
  "stripe-secret-key": /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  "slack-token": /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /** DigitalOcean personal access (`dop_`), OAuth (`doo_`) and refresh (`dor_`) tokens. */
  "digitalocean-token": /(?<![A-Za-z0-9_])do[por]_v1_[0-9a-f]{64}(?![A-Za-z0-9_])/g,
  "google-api-key": /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  jwt: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
} as const satisfies Record<string, RegExp>;

/** Built-in rules (spec FR-007). Order matters: specific prefixes first, generic rules last. */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: "pem-private-key",
    // A block cut off before its END line (truncated output) is masked to the end of the text.
    pattern:
      /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g,
  },
  { id: "github-token", pattern: TOKEN_PATTERNS["github-token"] },
  { id: "github-pat", pattern: TOKEN_PATTERNS["github-pat"] },
  { id: "anthropic-api-key", pattern: TOKEN_PATTERNS["anthropic-api-key"] },
  { id: "openai-api-key", pattern: TOKEN_PATTERNS["openai-api-key"] },
  { id: "aws-access-key-id", pattern: TOKEN_PATTERNS["aws-access-key-id"] },
  { id: "aws-secret-access-key", pattern: TOKEN_PATTERNS["aws-secret-access-key"], group: 1 },
  { id: "stripe-secret-key", pattern: TOKEN_PATTERNS["stripe-secret-key"] },
  { id: "slack-token", pattern: TOKEN_PATTERNS["slack-token"] },
  { id: "digitalocean-token", pattern: TOKEN_PATTERNS["digitalocean-token"] },
  { id: "google-api-key", pattern: TOKEN_PATTERNS["google-api-key"] },
  { id: "jwt", pattern: TOKEN_PATTERNS.jwt },
  {
    id: "url-password",
    pattern: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:([^\s/?#@]+)@/gi,
    group: 1,
    validate: (secret) => !isPlaceholder(secret),
  },
  {
    id: "labelled-secret",
    pattern:
      // `(?=(x{0,64}))\1` consumes the rest of the key atomically and with a bound, so long
      // identifier runs cannot cause backtracking or quadratic rescans. A key that ends in `file`,
      // `path`, `dir` or `exists` (`passwordFile`, `token_path`, `SECRET_KEY_FILE`) names where a
      // secret is, not the secret: the short lookbehind after the whole key skips it.
      /(?:token|secret|password|passwd|api_key|apikey|hcloud_token|cloudflare_api_token)(?=([A-Za-z0-9_.-]{0,64}))\1(?<!file|path|dir|exists)["']?\s*(?::=|=>|[=:])\s*["']?([^\s"'`,;]+)/gi,
    group: 2,
    validate: (secret) =>
      secret.length >= 12 && !LABELLED_FORBIDDEN.test(secret) && shannonEntropy(secret) >= 3.0,
  },
];

interface CompiledRule {
  rule: RedactionRule;
  /** Copy of the rule's pattern with the `g` and `d` (match indices) flags. */
  pattern: RegExp;
}

function compile(rule: RedactionRule): CompiledRule {
  const flags = new Set([...rule.pattern.flags, "g", "d"]);
  return { rule, pattern: new RegExp(rule.pattern.source, [...flags].join("")) };
}

function applyRule(text: string, { rule, pattern }: CompiledRule): string {
  const group = rule.group ?? 0;
  pattern.lastIndex = 0;
  const spans: Array<[number, number]> = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0].length === 0) pattern.lastIndex++;
    const secret = match[group];
    const span = match.indices?.[group];
    if (secret === undefined || span === undefined || secret.length === 0) continue;
    if (secret.includes(PLACEHOLDER_PREFIX)) continue;
    if (rule.validate && !rule.validate(secret)) continue;
    spans.push(span);
  }
  if (spans.length === 0) return text;
  const replacement = `${PLACEHOLDER_PREFIX}${rule.id}]`;
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + text.slice(cursor);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A name stands alone: right after a percent-escape (`%2F%2Fnas`, `user%40nas`), or not right after
// a letter, digit, `_`, `.` or `-` (never inside a longer name) and not right after the start of a
// placeholder (`[REDACTED:nas]`); and not right before a letter, digit, `_` or `-`, nor before `.`
// and a letter, digit or `_` (`portainer.url`) or `:` and a letter or `_` (a port may follow:
// `nas:9443`).
const NAME_BEFORE = `(?:(?<=%[0-9A-Fa-f]{2})|(?<![0-9A-Za-z_.-])(?<!${escapeRegExp(PLACEHOLDER_PREFIX)}))`;
const NAME_AFTER = "(?![0-9A-Za-z_-]|\\.[0-9A-Za-z_]|:[A-Za-z_])";

/**
 * One case-insensitive pattern for `names` and their URL-encoded forms (longest first), or
 * `undefined` for none.
 */
function namesPattern(names: Iterable<string>): RegExp | undefined {
  const all = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") continue;
    all.add(name);
    all.add(encodeURIComponent(name));
  }
  const sorted = [...all].sort((a, b) => b.length - a.length).map(escapeRegExp);
  if (sorted.length === 0) return undefined;
  return new RegExp(`${NAME_BEFORE}(?:${sorted.join("|")})${NAME_AFTER}`, "gi");
}

/**
 * `text` with every one of `names` (and their URL-encoded forms) replaced by `replacement`, longest
 * first, ignoring case and only where a name stands alone (as {@link Redactor.addName} matches
 * it): a host name such as `nas` is replaced in `https://NAS:9443/api`, `host:nas`, `admin@nas` or
 * `%2F%2Fnas`, but never inside `nas.url`, `nas-agent`, `opscrew-shop-nas-tunnel` or `nas.lan`.
 */
export function replaceNames(text: string, names: readonly string[], replacement: string): string {
  const pattern = namesPattern(names);
  return pattern === undefined ? text : text.replace(pattern, () => replacement);
}

export interface RedactorOptions {
  /** Rules to apply. Defaults to `DEFAULT_REDACTION_RULES`. */
  rules?: readonly RedactionRule[];
}

/**
 * Masks secrets in text: registered literal values first (longest first), then pattern rules,
 * then registered names (whole names only). `redact`, `redactSecrets` and `redactDeep` are bound
 * and can be passed around as plain functions.
 */
export class Redactor {
  private readonly rules: CompiledRule[];
  private readonly literals = new Map<string, string>();
  private sortedLiterals: Array<[string, string]> | undefined;
  /** Registered names, lower-cased, with their placeholder. */
  private readonly names = new Map<string, string>();
  private namePattern: RegExp | null | undefined;

  constructor(options: RedactorOptions = {}) {
    this.rules = (options.rules ?? DEFAULT_REDACTION_RULES).map(compile);
  }

  /**
   * Registers a literal secret (also matched in URL-encoded form). Values shorter than 8 characters
   * are ignored because masking them would corrupt ordinary text.
   */
  addLiteral(value: string, label?: string): void {
    if (value.length < 8) return;
    const replacement = `${PLACEHOLDER_PREFIX}${label ?? "secret"}]`;
    this.literals.set(value, replacement);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.literals.set(encoded, replacement);
    this.sortedLiterals = undefined;
  }

  /**
   * Registers a name that is not a secret but must not be shown, such as a host name, masked
   * ignoring case and only where it stands alone (also in URL-encoded form): `nas` is masked in
   * `https://NAS:9443/api`, `host:nas`, `admin@nas` or `user%40nas`, but never inside a longer
   * name or word (`nas.url`,
   * `opscrew-shop-nas-tunnel`, `nas.lan`, a placeholder). Short names count too. Register secrets
   * with {@link addLiteral}: they are masked wherever they appear.
   */
  addName(value: string, label?: string): void {
    const name = value.trim();
    if (name === "") return;
    const replacement = `${PLACEHOLDER_PREFIX}${label ?? "name"}]`;
    this.names.set(name.toLowerCase(), replacement);
    this.namePattern = undefined;
  }

  /** The placeholder of a matched name, also when it matched in URL-encoded form. */
  private nameReplacement(match: string): string {
    const direct = this.names.get(match.toLowerCase());
    if (direct !== undefined) return direct;
    try {
      return (
        this.names.get(decodeURIComponent(match).toLowerCase()) ?? `${PLACEHOLDER_PREFIX}name]`
      );
    } catch {
      return `${PLACEHOLDER_PREFIX}name]`;
    }
  }

  /** Returns `text` with every registered literal, rule match and name replaced by a placeholder. */
  readonly redact = (text: string): string => {
    const out = this.redactSecrets(text);
    const names = this.namesPattern();
    return names === undefined ? out : out.replace(names, (name) => this.nameReplacement(name));
  };

  /**
   * {@link redact} without the registered names ({@link addName}): only literals and rule matches
   * are masked. For values OpsCrew saves and later runs or parses, such as a start command, where
   * hiding a name (a folder called like the server) would change the value.
   */
  readonly redactSecrets = (text: string): string => {
    let out = text;
    for (const [literal, replacement] of this.literalsByLength()) {
      if (out.includes(literal)) out = out.split(literal).join(replacement);
    }
    for (const rule of this.rules) out = applyRule(out, rule);
    return out;
  };

  /** {@link redactDeep} with this redactor. */
  readonly redactDeep = <T>(value: T): T => redactDeep(value, this.redact);

  private namesPattern(): RegExp | undefined {
    if (this.namePattern === undefined) this.namePattern = namesPattern(this.names.keys()) ?? null;
    return this.namePattern ?? undefined;
  }

  private literalsByLength(): Array<[string, string]> {
    this.sortedLiterals ??= [...this.literals].sort(([a], [b]) => b.length - a.length);
    return this.sortedLiterals;
  }
}

/**
 * `value` with every string inside arrays and plain objects (recursively) passed through
 * `redact`; other values are kept as they are. Returns `value` itself when nothing changed, and
 * new arrays and objects only where something did. The input is never mutated.
 */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) {
    const items = value.map((item) => redactDeep(item, redact));
    return (items.every((item, i) => item === value[i]) ? value : items) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).map(([key, item]) => [key, redactDeep(item, redact)]);
  return (
    entries.every(([key, item]) => item === record[key as string])
      ? value
      : Object.fromEntries(entries)
  ) as T;
}

/** Masked form for display: first 4 chars + `…(N chars)`; values < 12 chars show only the length. */
export function maskSecret(value: string): string {
  const suffix = `…(${value.length} chars)`;
  return value.length < 12 ? suffix : `${value.slice(0, 4)}${suffix}`;
}

/**
 * Registers the values of secret environment variables ({@link isSecretEnvName}) as literals
 * labelled with the variable name. Values shorter than 8 characters are skipped. Returns the
 * number of variables registered.
 */
export function registerEnvSecrets(
  redactor: Redactor,
  env: Record<string, string | undefined>,
): number {
  let count = 0;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8) continue;
    if (!isSecretEnvName(name)) continue;
    redactor.addLiteral(value, name);
    count++;
  }
  return count;
}
