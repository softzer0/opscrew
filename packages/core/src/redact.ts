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

/** Built-in rules (spec FR-007). Order matters: specific prefixes first, generic rules last. */
export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: "pem-private-key",
    // A block cut off before its END line (truncated output) is masked to the end of the text.
    pattern:
      /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g,
  },
  { id: "github-token", pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,251}(?![A-Za-z0-9])/g },
  { id: "github-pat", pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,255}/g },
  { id: "anthropic-api-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: "openai-api-key",
    pattern:
      /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,}(?![A-Za-z0-9_-]))/g,
  },
  { id: "aws-access-key-id", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  {
    id: "aws-secret-access-key",
    pattern: /aws_?secret_?access_?key["']?\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
  },
  {
    id: "stripe-secret-key",
    pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  { id: "slack-token", pattern: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  // DigitalOcean personal access (`dop_`), OAuth (`doo_`) and refresh (`dor_`) tokens.
  {
    id: "digitalocean-token",
    pattern: /(?<![A-Za-z0-9_])do[por]_v1_[0-9a-f]{64}(?![A-Za-z0-9_])/g,
  },
  { id: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  {
    id: "jwt",
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
  },
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
 * then registered names (whole names only). `redact` and `redactDeep` are bound and can be passed
 * around as plain functions.
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
    let out = text;
    for (const [literal, replacement] of this.literalsByLength()) {
      if (out.includes(literal)) out = out.split(literal).join(replacement);
    }
    for (const rule of this.rules) out = applyRule(out, rule);
    const names = this.namesPattern();
    if (names !== undefined) out = out.replace(names, (name) => this.nameReplacement(name));
    return out;
  };

  /**
   * Returns a copy of `value` with every string (inside arrays and plain objects, recursively)
   * redacted. Other values are returned as they are; the input is never mutated.
   */
  readonly redactDeep = <T>(value: T): T => this.deep(value, new WeakMap()) as T;

  private deep(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") return this.redact(value);
    if (typeof value !== "object" || value === null) return value;
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const item of value) copy.push(this.deep(item, seen));
      return copy;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) copy[key] = this.deep(item, seen);
    return copy;
  }

  private namesPattern(): RegExp | undefined {
    if (this.namePattern === undefined) this.namePattern = namesPattern(this.names.keys()) ?? null;
    return this.namePattern ?? undefined;
  }

  private literalsByLength(): Array<[string, string]> {
    this.sortedLiterals ??= [...this.literals].sort(([a], [b]) => b.length - a.length);
    return this.sortedLiterals;
  }
}

/** Masked form for display: first 4 chars + `…(N chars)`; values < 12 chars show only the length. */
export function maskSecret(value: string): string {
  const suffix = `…(${value.length} chars)`;
  return value.length < 12 ? suffix : `${value.slice(0, 4)}${suffix}`;
}

/** Environment variables that always hold secrets. */
export const SECRET_ENV_NAMES = [
  "HCLOUD_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "DIGITALOCEAN_TOKEN",
  "NAMECHEAP_API_KEY",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "GODADDY_API_TOKEN",
  "OPSCREW_STATE_PASSPHRASE",
  "TF_ENCRYPTION",
] as const;

const SECRET_ENV_SUFFIXES = [
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_PASSWD",
  "_API_KEY",
  "_PRIVATE_KEY",
];
const SECRET_ENV_NAME_SET: ReadonlySet<string> = new Set(SECRET_ENV_NAMES);

/**
 * Registers the values of secret-looking environment variables (`SECRET_ENV_NAMES` plus names
 * ending in `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PASSWD`, `_API_KEY`, `_PRIVATE_KEY`; matched
 * case-insensitively) as literals labelled with the variable name. Values shorter than 8 characters
 * are skipped. Returns the number of variables registered.
 */
export function registerEnvSecrets(
  redactor: Redactor,
  env: Record<string, string | undefined>,
): number {
  let count = 0;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8) continue;
    const upper = name.toUpperCase();
    const isSecret =
      SECRET_ENV_NAME_SET.has(upper) ||
      SECRET_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
    if (!isSecret) continue;
    redactor.addLiteral(value, name);
    count++;
  }
  return count;
}
