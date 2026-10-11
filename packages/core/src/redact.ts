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
    pattern: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g,
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
      // identifier runs cannot cause backtracking or quadratic rescans.
      /(?:token|secret|password|passwd|api_key|apikey|hcloud_token|cloudflare_api_token)(?=([A-Za-z0-9_.-]{0,64}))\1["']?\s*(?::=|=>|[=:])\s*["']?([^\s"'`,;]+)/gi,
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

export interface RedactorOptions {
  /** Rules to apply. Defaults to `DEFAULT_REDACTION_RULES`. */
  rules?: readonly RedactionRule[];
}

/**
 * Masks secrets in text: registered literal values first (longest first), then pattern rules.
 * `redact` and `redactDeep` are bound and can be passed around as plain functions.
 */
export class Redactor {
  private readonly rules: CompiledRule[];
  private readonly literals = new Map<string, string>();
  private sortedLiterals: Array<[string, string]> | undefined;

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

  /** Returns `text` with every registered literal and rule match replaced by a placeholder. */
  readonly redact = (text: string): string => {
    let out = text;
    for (const [literal, replacement] of this.literalsByLength()) {
      if (out.includes(literal)) out = out.split(literal).join(replacement);
    }
    for (const rule of this.rules) out = applyRule(out, rule);
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
