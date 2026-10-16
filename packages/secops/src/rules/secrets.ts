import type { Finding, ScanContext, Scanner, Severity } from "@opscrew/contracts";
import { maskSecret, shannonEntropy, TOKEN_PATTERNS } from "@opscrew/core";
import { createFinding } from "../scan/finding";
import {
  BINARY_EXTENSION,
  basename,
  isEnvFile,
  isPlaceholderValue,
  lineLocator,
  MAX_LINE_LENGTH,
  mapConcurrent,
  readText,
  splitLines,
} from "../scan/text";

const SOURCE = "opscrew-secrets";

const ROTATE =
  "Revoke or rotate it now, remove it from the code and load it from an environment variable or " +
  "a secret store instead. Deleting the line is not enough once it was committed: the value stays " +
  "in git history, so treat it as leaked.";

/**
 * A token family with a recognisable shape (spec 000 FR-007); the shapes the redactor also masks
 * come from core's {@link TOKEN_PATTERNS}. JWTs are left to the Supabase rules.
 */
interface TokenRule {
  id: string;
  title: string;
  severity: Severity | ((secret: string) => Severity);
  pattern: RegExp;
  /** Capture group holding the secret (default: whole match). */
  group?: number;
  /** Shortest value that can be real. */
  minLength?: number;
  validate?(secret: string, match: RegExpExecArray): boolean;
  description: string;
}

const DEV_PASSWORDS = new Set([
  "password",
  "postgres",
  "secret",
  "root",
  "admin",
  "pass",
  "test",
  "mysql",
  "redis",
  "user",
  "guest",
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const TOKEN_RULES: readonly TokenRule[] = [
  {
    id: "github-token",
    title: "GitHub token",
    severity: "critical",
    pattern: new RegExp(
      `${TOKEN_PATTERNS["github-token"].source}|${TOKEN_PATTERNS["github-pat"].source}`,
      "g",
    ),
    description:
      "A GitHub access token is written in this file. Anyone who can read it can act as its owner on GitHub.",
  },
  {
    id: "anthropic-api-key",
    title: "Anthropic API key",
    severity: "critical",
    pattern: TOKEN_PATTERNS["anthropic-api-key"],
    description:
      "An Anthropic API key is written in this file. Anyone who can read it can spend on your account.",
  },
  {
    id: "openai-api-key",
    title: "OpenAI API key",
    severity: "critical",
    pattern: TOKEN_PATTERNS["openai-api-key"],
    description:
      "An OpenAI API key is written in this file. Anyone who can read it can spend on your account.",
  },
  {
    id: "aws-access-key-id",
    title: "AWS access key id",
    severity: "high",
    pattern: TOKEN_PATTERNS["aws-access-key-id"],
    description:
      "An AWS access key id is written in this file. It is usually stored next to its secret key, which together give access to your AWS account.",
  },
  {
    id: "aws-secret-access-key",
    title: "AWS secret access key",
    severity: "critical",
    pattern: TOKEN_PATTERNS["aws-secret-access-key"],
    group: 1,
    description:
      "An AWS secret access key is written in this file. It gives access to your AWS account.",
  },
  {
    id: "stripe-secret-key",
    title: "Stripe secret key",
    severity: (secret) => (secret.includes("_live_") ? "critical" : "medium"),
    pattern: TOKEN_PATTERNS["stripe-secret-key"],
    description:
      "A Stripe secret or restricted key is written in this file. Live keys can create charges and refunds and read customer data.",
  },
  {
    id: "slack-token",
    title: "Slack token",
    severity: "critical",
    pattern: TOKEN_PATTERNS["slack-token"],
    description:
      "A Slack token is written in this file. It can read or post messages in your workspace.",
  },
  {
    id: "google-api-key",
    title: "Google API key",
    severity: "medium",
    pattern: TOKEN_PATTERNS["google-api-key"],
    description:
      "A Google API key is written in this file. Firebase web keys are public by design, but unrestricted keys can be abused for paid Google APIs.",
  },
  {
    id: "url-credentials",
    title: "Password in a connection URL",
    severity: "high",
    pattern:
      /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@'"`]*:([^\s/?#@'"`]+)@([^\s/?#:'"`]+)/gi,
    group: 1,
    minLength: 6,
    validate: (secret, match) =>
      !DEV_PASSWORDS.has(secret.toLowerCase()) &&
      !LOCAL_HOSTS.has((match[2] ?? "").toLowerCase()) &&
      !/[{}$%]/.test(secret),
    description: "A connection URL in this file contains a password.",
  },
  {
    id: "hcloud-token",
    title: "Hetzner Cloud API token",
    severity: "critical",
    pattern:
      /(?:hcloud|hetzner)[A-Za-z0-9_]{0,40}token["']?\s*(?::=|=>|[=:])\s*["']?([A-Za-z0-9]{64})(?![A-Za-z0-9])/gi,
    group: 1,
    description:
      "A Hetzner Cloud API token is written in this file. It can create, change and delete servers in your Hetzner project.",
  },
  {
    id: "cloudflare-api-token",
    title: "Cloudflare API token",
    severity: "critical",
    pattern:
      /(?:cloudflare|(?<![A-Za-z0-9])cf)_?api_?token["']?\s*(?::=|=>|[=:])\s*["']?([A-Za-z0-9_-]{40})(?![A-Za-z0-9_-])/gi,
    group: 1,
    description:
      "A Cloudflare API token is written in this file. Depending on its scope it can change your DNS, TLS and firewall settings.",
  },
  {
    id: "digitalocean-token",
    title: "DigitalOcean API token",
    severity: "critical",
    pattern: TOKEN_PATTERNS["digitalocean-token"],
    description:
      "A DigitalOcean API token is written in this file. Depending on its scopes it can create, change and delete Droplets, firewalls and other resources in your DigitalOcean team.",
  },
];

/** Names that suggest the assigned value is a secret. */
const SECRET_NAME =
  /secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|signing[_-]?key|encryption[_-]?key|credential/i;
/** Names that contain a secret marker but describe metadata, not the secret itself. */
const NON_SECRET_NAME_SUFFIX =
  /(?:url|uri|path|file|dir|name|type|field|length|len|min|max|ttl|expiry|expires|expiresat|endpoint|header|prefix|label|hint|placeholder|regex|pattern|count|id|ids|enabled|required|limit|timeout|policy|hash|salt|rounds|key_?id|env|var)$/i;
/** `name = value`, `name: value`, `"name": "value"`, `name := value`, `name => value`. */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_$])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1\s*(?::=|=>|=(?!=)|:)\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|([^\s"'`,;]+))/g;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const SUPABASE_SECRET_KEY = /^sb_secret_/;
const GENERIC_MIN_LENGTH = 12;
const GENERIC_MIN_ENTROPY = 3.0;

const PEM_BLOCK =
  /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----([\s\S]{0,20000}?)-----END \1PRIVATE KEY\2-----/g;
/** Binary key stores that cannot be inspected as text. */
const KEY_CONTAINER = /\.(?:p12|pfx)$/i;

const SKIPPED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);
const DOC_EXTENSION = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

function hasCharacterMix(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(value)).length;
  return classes >= 2;
}

/** True when a value assigned to a secret-like name looks like a real secret. */
function isGenericSecret(value: string, quoted: boolean, envFile: boolean): boolean {
  if (isPlaceholderValue(value, GENERIC_MIN_LENGTH)) return false;
  if (/[\s(){}$<>]/.test(value)) return false;
  if (!quoted && /[.[\]]/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:\.{0,2}\/|~\/)/.test(value)) return false;
  // JWTs and Supabase `sb_secret_` keys are the Supabase scanner's (it reports them with context).
  if (JWT_SHAPE.test(value) || SUPABASE_SECRET_KEY.test(value)) return false;
  if (!quoted && !envFile && /^[A-Za-z_][A-Za-z_]*$/.test(value)) return false;
  if (!hasCharacterMix(value)) return false;
  return shannonEntropy(value) >= GENERIC_MIN_ENTROPY;
}

interface Span {
  start: number;
  end: number;
}

const overlaps = (spans: readonly Span[], span: Span) =>
  spans.some((other) => span.start < other.end && other.start < span.end);

function tokenFinding(rule: TokenRule, file: string, line: number, secret: string): Finding {
  const severity = typeof rule.severity === "function" ? rule.severity(secret) : rule.severity;
  return createFinding({
    ruleId: `secrets/${rule.id}`,
    title: `${rule.title} in source`,
    severity,
    category: "secret",
    file,
    line,
    evidence: maskSecret(secret),
    description: rule.description,
    remediation: ROTATE,
    source: SOURCE,
    rawMatch: secret,
  });
}

/** Token families and generic assignments, line by line (minified lines are skipped). */
function scanLines(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const envFile = isEnvFile(file);
  const docs = DOC_EXTENSION.test(file);
  const lines = splitLines(text);
  for (const [index, lineText] of lines.entries()) {
    if (lineText.length > MAX_LINE_LENGTH || lineText.length < 8) continue;
    const line = index + 1;
    const spans: Span[] = [];
    for (const rule of TOKEN_RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      for (let match = pattern.exec(lineText); match !== null; match = pattern.exec(lineText)) {
        const secret = match[rule.group ?? 0];
        if (!secret) continue;
        const start = match.index + match[0].lastIndexOf(secret);
        const span = { start, end: start + secret.length };
        if (overlaps(spans, span)) continue;
        if (isPlaceholderValue(secret, rule.minLength ?? 1)) continue;
        if (rule.validate && !rule.validate(secret, match)) continue;
        spans.push(span);
        findings.push(tokenFinding(rule, file, line, secret));
      }
    }
    if (docs) continue;
    for (const match of lineText.matchAll(ASSIGNMENT)) {
      const name = match[2] ?? "";
      if (!SECRET_NAME.test(name) || NON_SECRET_NAME_SUFFIX.test(name)) continue;
      const quotedValue = match[3] ?? match[4] ?? match[5];
      const value = quotedValue ?? match[6] ?? "";
      if (!isGenericSecret(value, quotedValue !== undefined, envFile)) continue;
      const start = (match.index ?? 0) + match[0].lastIndexOf(value);
      const span = { start, end: start + value.length };
      if (overlaps(spans, span)) continue;
      spans.push(span);
      findings.push(
        createFinding({
          ruleId: "secrets/generic-high-entropy",
          title: `Hard-coded secret in "${name}"`,
          severity: "high",
          category: "secret",
          file,
          line,
          evidence: `${name}=${maskSecret(value)}`,
          description: `A random-looking value is assigned to "${name}", which looks like a password, token or key written directly in the file.`,
          remediation: ROTATE,
          source: SOURCE,
          rawMatch: value,
        }),
      );
    }
  }
  return findings;
}

/** PEM private-key blocks anywhere in the text (also inside long or JSON-escaped lines). */
function scanPrivateKeys(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lineAt = lineLocator(text);
  for (const match of text.matchAll(PEM_BLOCK)) {
    const body = (match[3] ?? "").replace(/\\[nr]/g, "").replace(/^[A-Za-z-]+:.*$/gm, "");
    const base64 = body.replace(/[^A-Za-z0-9+/=]/g, "");
    if (base64.length < 64 || isPlaceholderValue(base64)) continue;
    const block = match[0];
    const kind = (match[1] ?? "").trim();
    // Passphrase-protected keys (PKCS#8 `ENCRYPTED` or legacy `Proc-Type: 4,ENCRYPTED`) still leak,
    // but cannot be used without the passphrase.
    const encrypted = kind === "ENCRYPTED" || /Proc-Type:\s*4,ENCRYPTED/.test(match[3] ?? "");
    findings.push(
      createFinding({
        ruleId: "secrets/private-key",
        title: `${kind && kind !== "ENCRYPTED" ? `${kind} private key` : "Private key"} in source`,
        severity: encrypted ? "high" : "critical",
        category: "secret",
        file,
        line: lineAt(match.index),
        evidence: maskSecret(block),
        description:
          "A private key is stored in this file. Anyone with a copy can impersonate the server, user or service it belongs to.",
        remediation: `${ROTATE} Generate a new key pair and replace the public key wherever the old one was trusted.`,
        source: SOURCE,
        rawMatch: block,
      }),
    );
  }
  return findings;
}

interface EnvAssignment {
  name: string;
  line: number;
}

/** Variables in a dotenv file that have a real (non-placeholder) value. */
function envAssignments(text: string): EnvAssignment[] {
  const assignments: EnvAssignment[] = [];
  for (const [index, lineText] of splitLines(text).entries()) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(lineText);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (value === "" || isPlaceholderValue(value)) continue;
    assignments.push({ name: match[1] ?? "", line: index + 1 });
  }
  return assignments;
}

function envFinding(context: ScanContext, file: string, text: string): Finding | undefined {
  const assignments = envAssignments(text);
  const first = assignments[0];
  if (!first) return undefined;
  const names = assignments.map((assignment) => assignment.name);
  const shown = names.slice(0, 5).join(", ");
  const evidence = names.length > 5 ? `${shown} (+${names.length - 5} more)` : shown;
  const count = `${assignments.length} value${assignments.length === 1 ? "" : "s"}`;
  const tracked = context.gitTracked?.has(file) === true;
  return createFinding({
    ruleId: tracked ? "secrets/committed-env" : "secrets/env-not-ignored",
    title: tracked ? `Committed .env file with ${count}` : `.env file with ${count} is not ignored`,
    severity: tracked ? "critical" : "high",
    category: "secret",
    file,
    line: first.line,
    evidence,
    description: tracked
      ? `"${basename(file)}" is committed to git and sets ${evidence}. Everyone with access to the repository, its forks and its history can read these values.`
      : `"${basename(file)}" sets ${evidence} and is not listed in .gitignore, so the next "git add ." will commit it.`,
    remediation: tracked
      ? `Rotate every secret in the file, then stop tracking it: "git rm --cached ${file}", add ".env*" (with "!.env.example") to .gitignore and commit. The old values stay in git history, so rotation is required.`
      : `Add ".env*" (with "!.env.example") to .gitignore and keep only variable names in a committed .env.example.`,
    source: SOURCE,
    rawMatch: `${file}\n${names.join("\n")}`,
  });
}

/** Files to inspect: the project's files plus committed dotenv files hidden by `.gitignore`. */
function filesToScan(context: ScanContext): string[] {
  const files = new Set(context.files);
  for (const file of context.gitTracked ?? []) {
    if (isEnvFile(file)) files.add(file);
  }
  return [...files].sort();
}

async function scanFile(context: ScanContext, file: string): Promise<Finding[]> {
  const name = basename(file);
  if (SKIPPED_FILES.has(name)) return [];
  if (KEY_CONTAINER.test(name)) {
    return [
      createFinding({
        ruleId: "secrets/private-key",
        title: "Private key store in the repository",
        severity: "high",
        category: "secret",
        file,
        evidence: name,
        description:
          "A PKCS#12 key store (certificate plus private key) is stored in the repository. Even password-protected stores can be brute-forced offline.",
        remediation: `Remove "${file}" from the repository, keep it in a secret store, and reissue the certificate if the file was ever committed.`,
        source: SOURCE,
        rawMatch: file,
      }),
    ];
  }
  if (BINARY_EXTENSION.test(name)) return [];
  const text = await readText(context, file);
  if (text === undefined) return [];
  const findings = [...scanPrivateKeys(file, text), ...scanLines(file, text)];
  if (isEnvFile(file)) {
    const env = envFinding(context, file, text);
    if (env) findings.push(env);
  }
  return findings;
}

const READ_CONCURRENCY = 16;

/**
 * Built-in secret scanner (`opscrew-secrets`): FR-007 token families (GitHub, Anthropic, OpenAI,
 * AWS, Stripe, Slack, Google, labelled Hetzner and Cloudflare tokens, DigitalOcean tokens, URL passwords), generic
 * high-entropy values assigned to secret-like names, PEM private keys and key stores, and dotenv
 * files with values (git-tracked → critical `secrets/committed-env`; present but not ignored → high
 * `secrets/env-not-ignored`). JWTs and `sb_secret_` keys are left to the Supabase scanner, which
 * can tell service-role keys from public anon keys and reports them in client and server code.
 * Evidence is always masked with `maskSecret`.
 */
export function createSecretsScanner(): Scanner {
  return {
    id: SOURCE,
    kind: "builtin",
    isAvailable: async () => true,
    async scan(context) {
      const results = await mapConcurrent(filesToScan(context), READ_CONCURRENCY, (file) =>
        scanFile(context, file),
      );
      return results.flat();
    },
  };
}
