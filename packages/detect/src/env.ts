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
 */
export function isSecretLikely(name: string): boolean {
  const upper = name.toUpperCase();
  if (isClientExposed(name)) return isClientSecret(upper);
  return SECRET_MARKERS.some((marker) => upper.includes(marker));
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const QUOTE = "[\"'`]";
const REFERENCE_PATTERNS: RegExp[] = [
  new RegExp(`process\\.env\\.(${NAME})`, "g"),
  new RegExp(`process\\.env\\[\\s*${QUOTE}(${NAME})${QUOTE}\\s*\\]`, "g"),
  new RegExp(`import\\.meta\\.env\\.(${NAME})`, "g"),
  new RegExp(`import\\.meta\\.env\\[\\s*${QUOTE}(${NAME})${QUOTE}\\s*\\]`, "g"),
  new RegExp(`Deno\\.env\\.get\\(\\s*${QUOTE}(${NAME})${QUOTE}`, "g"),
  new RegExp(`os\\.environ\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  new RegExp(`os\\.environ\\.get\\(\\s*["'](${NAME})["']`, "g"),
  new RegExp(`os\\.getenv\\(\\s*["'](${NAME})["']`, "g"),
];
/** `const { A, B: b, C = "x" } = process.env` */
const DESTRUCTURING = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g;

/** Environment-variable names referenced in source text (sorted, unique). */
export function extractEnvReferences(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  for (const match of text.matchAll(DESTRUCTURING)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = /^\s*(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1];
      if (name && !part.trim().startsWith("...")) names.add(name);
    }
  }
  return [...names].filter((name) => !IGNORED_NAMES.has(name)).sort();
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
