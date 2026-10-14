/**
 * Environment-variable reference extraction and classification. Only variable names are ever
 * collected; values (including those in `.env.example`) are never kept.
 */
import { basenameRel } from "./paths";

/** Prefixes that bundlers inline into client-side code. */
export const CLIENT_EXPOSED_PREFIXES = [
  "VITE_",
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "PUBLIC_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
] as const;

const SECRET_MARKERS = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PRIVATE",
  "CREDENTIAL",
  "API_KEY",
  "DSN",
  "DATABASE_URL",
  "SERVICE_ROLE",
] as const;

/** Markers that make a client-exposed name dangerous (a secret shipped to browsers). */
const CLIENT_SECRET_MARKERS = [
  "SECRET",
  "SERVICE_ROLE",
  "PRIVATE",
  "PASSWORD",
  "RESTRICTED_KEY",
] as const;

/**
 * Providers whose API keys and tokens are always secret: anyone who reads them from the browser
 * can spend the owner's money or act as the owner. Providers with keys that are public by design
 * (Firebase web keys, Google Maps, Supabase anon, Stripe publishable, PostHog, Segment, Mapbox,
 * Algolia search) are deliberately absent.
 */
const SECRET_KEY_PROVIDERS = new Set([
  // AI and speech APIs
  "OPENAI",
  "ANTHROPIC",
  "CLAUDE",
  "GEMINI",
  "GROQ",
  "MISTRAL",
  "COHERE",
  "DEEPSEEK",
  "OPENROUTER",
  "PERPLEXITY",
  "REPLICATE",
  "TOGETHER",
  "FIREWORKS",
  "XAI",
  "HF",
  "HUGGINGFACE",
  "ELEVENLABS",
  "DEEPGRAM",
  "ASSEMBLYAI",
  // Cloud, code hosting and infrastructure
  "AWS",
  "GITHUB",
  "GITLAB",
  "HCLOUD",
  "HETZNER",
  "CLOUDFLARE",
  "DIGITALOCEAN",
  "VERCEL",
  "NETLIFY",
  // Messaging and email
  "SLACK",
  "DISCORD",
  "TELEGRAM",
  "TWILIO",
  "SENDGRID",
  "RESEND",
  "MAILGUN",
  "POSTMARK",
  "BREVO",
  "MAILCHIMP",
  // Data services with secret API keys
  "AIRTABLE",
  "NOTION",
  "PINECONE",
]);
/** Final name segments that hold a key or token. */
const KEY_SEGMENTS = new Set(["KEY", "APIKEY", "TOKEN"]);
/** Segments that mark a key as public by design (Turnstile/reCAPTCHA site keys, publishable keys). */
const PUBLIC_KEY_SEGMENTS = new Set(["PUBLIC", "PUBLISHABLE", "ANON", "SITE"]);

/** Names never reported: set by every runtime, or Vite built-ins on `import.meta.env`. */
const IGNORED_NAMES = new Set(["NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

/** True when bundlers expose the variable to browser code. */
export function isClientExposed(name: string): boolean {
  const upper = name.toUpperCase();
  return CLIENT_EXPOSED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * True for a client-exposed name that holds a secret: it contains `SECRET`, `SERVICE_ROLE`,
 * `PRIVATE`, `PASSWORD` or `RESTRICTED_KEY`, or it is the API key or token of a provider whose keys
 * are always secret (`VITE_OPENAI_API_KEY`, `NEXT_PUBLIC_GITHUB_TOKEN`). Generic names such as
 * `VITE_API_KEY` and public-by-design keys are not flagged, to keep false positives low.
 */
function isClientSecret(upper: string): boolean {
  if (CLIENT_SECRET_MARKERS.some((marker) => upper.includes(marker))) return true;
  const prefix = CLIENT_EXPOSED_PREFIXES.filter((p) => upper.startsWith(p)).sort(
    (a, b) => b.length - a.length,
  )[0];
  const segments = upper
    .slice(prefix?.length ?? 0)
    .split("_")
    .filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  if (last === undefined || !KEY_SEGMENTS.has(last)) return false;
  if (segments.some((segment) => PUBLIC_KEY_SEGMENTS.has(segment))) return false;
  return segments.some((segment) => SECRET_KEY_PROVIDERS.has(segment));
}

/**
 * True when the name looks like it holds a secret. Client-exposed names count only in the
 * dangerous case: a secret marker or a known secret-bearing provider's key (see `isClientSecret`).
 * Server-side names ending in `_KEY` count too (`SIGNING_KEY`, `ENCRYPTION_KEY`) unless they are
 * public by design, so a dev default in the code never makes such a key optional.
 */
export function isSecretLikely(name: string): boolean {
  const upper = name.toUpperCase();
  if (isClientExposed(name)) return isClientSecret(upper);
  if (SECRET_MARKERS.some((marker) => upper.includes(marker))) return true;
  const segments = upper.split("_").filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  return (
    (last === "KEY" || last === "APIKEY") &&
    !segments.some((segment) => PUBLIC_KEY_SEGMENTS.has(segment))
  );
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const QUOTE = "[\"'`]";

/**
 * How a read can fall back to a default: `member`/`index` reads are followed by an operator
 * (`?? x`, `|| x`, `== "1"`); `call` reads also have one as a second argument (`get("X", x)`);
 * `raising` reads (`os.environ["X"]`) fail when the variable is unset, so they never have one.
 */
type ReadKind = "member" | "call" | "raising";

const REFERENCE_PATTERNS: Array<{ pattern: RegExp; kind: ReadKind }> = [
  { pattern: new RegExp(`process\\.env\\.(${NAME})`, "g"), kind: "member" },
  {
    pattern: new RegExp(`process\\.env\\[\\s*${QUOTE}(${NAME})${QUOTE}\\s*\\]`, "g"),
    kind: "member",
  },
  { pattern: new RegExp(`import\\.meta\\.env\\.(${NAME})`, "g"), kind: "member" },
  {
    pattern: new RegExp(`import\\.meta\\.env\\[\\s*${QUOTE}(${NAME})${QUOTE}\\s*\\]`, "g"),
    kind: "member",
  },
  { pattern: new RegExp(`Deno\\.env\\.get\\(\\s*${QUOTE}(${NAME})${QUOTE}`, "g"), kind: "call" },
  // `os.environ` or a bare `environ` (`from os import environ`), never `request.environ`.
  {
    pattern: new RegExp(`(?<![\\w.])(?:os\\.)?environ\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
    kind: "raising",
  },
  {
    pattern: new RegExp(`(?<![\\w.])(?:os\\.)?environ\\.get\\(\\s*["'](${NAME})["']`, "g"),
    kind: "call",
  },
  {
    pattern: new RegExp(`(?<![\\w.])(?:os\\.)?getenv\\(\\s*["'](${NAME})["']`, "g"),
    kind: "call",
  },
];
/** `const { A, B: b, C = "x" } = process.env` */
const DESTRUCTURING = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g;
/** A fallback operator after a read: `?? x`, `|| x`, Python `or x`. */
const FALLBACK_OPERATOR = /^\s*(?:\?\?|\|\||or\b)/;
/**
 * What follows a read that makes it safe to leave unset: a comparison with a string literal
 * (`== "1"`, `!== "true"`) or a membership test (`in ("1", "true")`).
 */
const COMPARISON_AFTER = /^\s*(?:in\b|[=!]==?\s*["'`])/;
/**
 * Fallback values that are placeholders, not defaults: empty strings, `None`/`null`/`undefined`,
 * `throw`, and calls or IIFEs (`missing("X")`), which usually fail or compute a stand-in. A
 * variable whose only fallback is one of these still needs a production value.
 */
const PLACEHOLDER = /^\s*(?:""|''|``|None\b|null\b|undefined\b|throw\b|\(|[A-Za-z_$][\w$.]*\s*\()/;
/** Text just before a read that negates it (`!process.env.X`, `not os.getenv("X")`): a guard. */
const NEGATED_BEFORE = /(?:!|\bnot\s+)$/;

/** True when `value` (the text after a fallback operator or `=`) is a real default. */
function isRealDefault(value: string): boolean {
  return !PLACEHOLDER.test(value);
}

/** True when the text after a read gives it a real default or makes it safe to leave unset. */
function defaultAfter(after: string): boolean {
  if (COMPARISON_AFTER.test(after)) return true;
  const operator = FALLBACK_OPERATOR.exec(after);
  return operator !== null && isRealDefault(after.slice(operator[0].length));
}

/** One environment variable read in source text. */
export interface EnvRead {
  name: string;
  /** True when every read of the variable in the text falls back to a default when it is unset. */
  hasDefault: boolean;
}

function readHasDefault(kind: ReadKind, after: string): boolean {
  if (kind === "raising") return false;
  if (kind === "call") {
    const argument = /^\s*,\s*(?:default\s*=\s*)?/.exec(after);
    if (argument !== null) return isRealDefault(after.slice(argument[0].length));
    const close = /^\s*\)/.exec(after);
    return close !== null && defaultAfter(after.slice(close[0].length));
  }
  return defaultAfter(after);
}

/**
 * Environment variables read in source text (sorted by name, unique), each with whether it has a
 * default where it is read (`os.environ.get("X", …)`, `process.env.X ?? …`). A variable read once
 * with and once without a default has none: the read without one needs a value.
 */
export function extractEnvReads(text: string): EnvRead[] {
  const reads = new Map<string, boolean>();
  const add = (name: string, hasDefault: boolean) =>
    reads.set(name, (reads.get(name) ?? true) && hasDefault);
  for (const { pattern, kind } of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (!name) continue;
      // A negated read is a guard (`if (!process.env.X || …) throw`): the variable is required.
      const negated = NEGATED_BEFORE.test(text.slice(Math.max(0, match.index - 8), match.index));
      // Enough of what follows to see the default (multi-line calls included).
      const end = match.index + match[0].length;
      add(name, !negated && readHasDefault(kind, text.slice(end, end + 200)));
    }
  }
  for (const match of text.matchAll(DESTRUCTURING)) {
    for (const part of (match[1] ?? "").split(",")) {
      if (part.trim().startsWith("...")) continue;
      const parsed = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*[\w$]+)?\s*(=)?/.exec(part);
      if (!parsed?.[1]) continue;
      add(parsed[1], parsed[2] !== undefined && isRealDefault(part.slice(parsed[0].length)));
    }
  }
  return [...reads.entries()]
    .filter(([name]) => !IGNORED_NAMES.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, hasDefault]) => ({ name, hasDefault }));
}

/** Environment-variable names referenced in source text (sorted, unique). */
export function extractEnvReferences(text: string): string[] {
  return extractEnvReads(text).map((read) => read.name);
}

/** True for example env files such as `.env.example`, `.env.sample` or `.env.local.example`. */
export function isEnvExampleFile(path: string): boolean {
  return /^\.env(?:\.[\w-]+)*\.(?:example|sample|template)$/i.test(basenameRel(path));
}

/** Keys declared in an example env file (`KEY=…` or `export KEY=…`); values are ignored. */
export function parseEnvExampleKeys(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (name && !IGNORED_NAMES.has(name)) names.add(name);
  }
  return [...names].sort();
}
