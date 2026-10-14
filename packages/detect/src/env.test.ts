import { describe, expect, it } from "vitest";
import { extractEnvReads } from "./env";
import {
  extractEnvReferences,
  isClientExposed,
  isEnvExampleFile,
  isSecretLikely,
  parseEnvExampleKeys,
} from "./index";

describe("extractEnvReferences", () => {
  it("finds JS, Vite, Deno and Python references", () => {
    const text = [
      "const a = process.env.API_URL;",
      'const b = process.env["STRIPE_KEY"];',
      "const c = import.meta.env.VITE_URL;",
      'const d = Deno.env.get("DENO_VAR");',
      'x = os.environ["PY_ONE"]',
      "y = os.environ.get('PY_TWO', 'x')",
      'z = os.getenv("PY_THREE")',
      "const { DESTRUCT_A, DESTRUCT_B: b2, DESTRUCT_C = 1, ...rest } = process.env;",
      "if (process.env.NODE_ENV === 'production' && import.meta.env.DEV) {}",
    ].join("\n");
    expect(extractEnvReferences(text)).toEqual([
      "API_URL",
      "DENO_VAR",
      "DESTRUCT_A",
      "DESTRUCT_B",
      "DESTRUCT_C",
      "PY_ONE",
      "PY_THREE",
      "PY_TWO",
      "STRIPE_KEY",
      "VITE_URL",
    ]);
  });
});

describe("extractEnvReads", () => {
  const defaults = (text: string) =>
    Object.fromEntries(extractEnvReads(text).map((read) => [read.name, read.hasDefault]));

  it("records Python reads with a default", () => {
    const text = [
      'SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]',
      'DEBUG = os.environ.get("DJANGO_DEBUG") == "1"',
      'ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")',
      'PORT = int(os.getenv("PY_PORT", 8000))',
      "LEVEL = environ.get(\n    'LOG_LEVEL',\n    'info',\n)",
      'URL = getenv("SERVICE_URL") or "http://localhost"',
      'MODE = os.environ.get("MODE_FLAG") in ("1", "true")',
      'TOKEN = os.getenv("API_TOKEN")',
      'NAME = os.environ.get("APP_NAME")',
      'X = os.environ["INDEXED"] or "x"',
      'host = request.environ.get("HTTP_HOST", "")',
    ].join("\n");
    expect(defaults(text)).toEqual({
      API_TOKEN: false,
      APP_NAME: false,
      DJANGO_ALLOWED_HOSTS: true,
      DJANGO_DEBUG: true,
      DJANGO_SECRET_KEY: false,
      INDEXED: false,
      LOG_LEVEL: true,
      MODE_FLAG: true,
      PY_PORT: true,
      SERVICE_URL: true,
    });
  });

  it("records JavaScript and TypeScript reads with a default", () => {
    const text = [
      'const a = process.env.API_URL ?? "http://localhost";',
      "const b = process.env.LOG_LEVEL || 'info';",
      'const c = process.env["FEATURE"] ?? "off";',
      'const d = process.env.DEBUG_FLAG === "1";',
      "const e = process.env.STRIPE_KEY;",
      'const f = import.meta.env.VITE_TITLE ?? "Shop";',
      'const g = Deno.env.get("DENO_PORT") ?? "8000";',
      'const { DESTRUCT_A, DESTRUCT_B: b2 = "x", DESTRUCT_C = 1 } = process.env;',
      "if (process.env.REQUIRED_FLAG === undefined) throw new Error();",
    ].join("\n");
    expect(defaults(text)).toEqual({
      API_URL: true,
      DEBUG_FLAG: true,
      DENO_PORT: true,
      DESTRUCT_A: false,
      DESTRUCT_B: true,
      DESTRUCT_C: true,
      FEATURE: true,
      LOG_LEVEL: true,
      REQUIRED_FLAG: false,
      STRIPE_KEY: false,
      VITE_TITLE: true,
    });
  });

  it.each([
    'const key = process.env.STRIPE_SECRET_KEY || "";',
    "const key = process.env.STRIPE_SECRET_KEY || '';",
    "const key = process.env.STRIPE_SECRET_KEY ?? ``;",
    'const key = process.env.STRIPE_SECRET_KEY ?? "";',
    "const key = process.env.STRIPE_SECRET_KEY ?? null;",
    "const key = process.env.STRIPE_SECRET_KEY ?? undefined;",
    'const key = process.env.STRIPE_SECRET_KEY ?? missing("STRIPE_SECRET_KEY");',
    'const key = process.env.STRIPE_SECRET_KEY ?? (() => { throw new Error("x"); })();',
    'const key = process.env.STRIPE_SECRET_KEY ?? throw new Error("x");',
    'const key = import.meta.env.STRIPE_SECRET_KEY || "";',
    'const { STRIPE_SECRET_KEY = "" } = process.env;',
    "const { STRIPE_SECRET_KEY: key = '' } = process.env;",
    'key = os.getenv("STRIPE_SECRET_KEY", None)',
    'key = os.environ.get("STRIPE_SECRET_KEY", "")',
    'key = os.environ.get("STRIPE_SECRET_KEY", default="")',
    'key = os.environ.get("STRIPE_SECRET_KEY") or ""',
    'key = os.environ.get("STRIPE_SECRET_KEY") or None',
  ])("a placeholder fallback is not a default: %s", (text) => {
    expect(extractEnvReads(text)).toEqual([{ name: "STRIPE_SECRET_KEY", hasDefault: false }]);
  });

  it("keeps real literal defaults, including a keyword argument", () => {
    const text = [
      'key = os.environ.get("SIGNING_KEY", "dev-insecure")',
      'level = os.getenv("LOG_LEVEL", default="info")',
      "const port = process.env.PORT_NUMBER || 3000;",
    ].join("\n");
    expect(extractEnvReads(text)).toEqual([
      { name: "LOG_LEVEL", hasDefault: true },
      { name: "PORT_NUMBER", hasDefault: true },
      { name: "SIGNING_KEY", hasDefault: true },
    ]);
  });

  it("treats a negated read as a guard that makes the variable required", () => {
    const text = [
      'if (!process.env.DATABASE_URL || process.env.DATABASE_URL === "") throw new Error();',
      'if not os.environ.get("API_TOKEN") or len(os.environ.get("API_TOKEN", "x")) < 8:',
      "    raise RuntimeError()",
    ].join("\n");
    expect(extractEnvReads(text)).toEqual([
      { name: "API_TOKEN", hasDefault: false },
      { name: "DATABASE_URL", hasDefault: false },
    ]);
  });

  it("treats a variable read once with and once without a default as required", () => {
    const text = [
      'const a = process.env.API_URL ?? "http://localhost";',
      "fetch(process.env.API_URL);",
      'x = os.environ.get("PY_VAR", "x")',
      'y = os.environ["PY_VAR"]',
    ].join("\n");
    expect(extractEnvReads(text)).toEqual([
      { name: "API_URL", hasDefault: false },
      { name: "PY_VAR", hasDefault: false },
    ]);
  });
});

describe("classification", () => {
  it.each([
    ["VITE_SUPABASE_URL", true, false],
    ["VITE_SUPABASE_ANON_KEY", true, false],
    ["VITE_SUPABASE_SERVICE_ROLE_KEY", true, true],
    ["NEXT_PUBLIC_STRIPE_SECRET", true, true],
    ["REACT_APP_ADMIN_PASSWORD", true, true],
    ["EXPO_PUBLIC_PRIVATE_KEY", true, true],
    ["PUBLIC_SITE", true, false],
    ["NUXT_PUBLIC_API", true, false],
    ["GATSBY_TOKEN", true, false],
    ["DATABASE_URL", false, true],
    ["SENTRY_DSN", false, true],
    ["GITHUB_TOKEN", false, true],
    ["OPENAI_API_KEY", false, true],
    ["GOOGLE_CREDENTIALS", false, true],
    ["DB_PASSWD", false, true],
    ["PORT", false, false],
    ["REDIS_URL", false, false],
    // Server-side keys are secret unless public by design (a dev default must not make them optional).
    ["SIGNING_KEY", false, true],
    ["ENCRYPTION_KEY", false, true],
    ["STRIPE_KEY", false, true],
    ["MAPBOX_APIKEY", false, true],
    ["STRIPE_PUBLISHABLE_KEY", false, false],
    ["TURNSTILE_SITE_KEY", false, false],
    ["KEYCLOAK_URL", false, false],
  ])("%s → clientExposed %s, secretLikely %s", (name, client, secret) => {
    expect(isClientExposed(name)).toBe(client);
    expect(isSecretLikely(name)).toBe(secret);
  });

  it.each([
    // AI providers: any key or token shipped to the browser can be used to run up the bill.
    "VITE_OPENAI_API_KEY",
    "VITE_OPENAI_KEY",
    "NEXT_PUBLIC_ANTHROPIC_API_KEY",
    "REACT_APP_GEMINI_API_KEY",
    "VITE_GROQ_API_KEY",
    "EXPO_PUBLIC_OPENROUTER_API_KEY",
    "VITE_HF_TOKEN",
    "VITE_HUGGINGFACE_ACCESS_TOKEN",
    "VITE_ELEVENLABS_API_KEY",
    // Payment, cloud and messaging secrets.
    "NEXT_PUBLIC_STRIPE_SECRET_KEY",
    "VITE_STRIPE_RESTRICTED_KEY",
    "VITE_AWS_SECRET_ACCESS_KEY",
    "VITE_AWS_ACCESS_KEY",
    "NEXT_PUBLIC_GITHUB_TOKEN",
    "VITE_SENDGRID_API_KEY",
    "VITE_RESEND_API_KEY",
    "VITE_TWILIO_AUTH_TOKEN",
    "PUBLIC_SLACK_BOT_TOKEN",
    "VITE_DISCORD_BOT_TOKEN",
    "VITE_TELEGRAM_BOT_TOKEN",
    "NEXT_PUBLIC_CLOUDFLARE_API_TOKEN",
    "VITE_HCLOUD_TOKEN",
    "VITE_AIRTABLE_API_KEY",
    "VITE_NOTION_API_KEY",
    "VITE_PINECONE_API_KEY",
  ])("%s is a secret exposed to the browser", (name) => {
    expect(isClientExposed(name)).toBe(true);
    expect(isSecretLikely(name)).toBe(true);
  });

  it.each([
    // Public by design: meant to be shipped to browsers.
    "VITE_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "VITE_STRIPE_PUBLIC_KEY",
    "VITE_STRIPE_KEY",
    "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
    "VITE_GOOGLE_API_KEY",
    "NEXT_PUBLIC_POSTHOG_KEY",
    "NEXT_PUBLIC_POSTHOG_API_KEY",
    "NEXT_PUBLIC_SEGMENT_WRITE_KEY",
    "VITE_MAPBOX_ACCESS_TOKEN",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "VITE_SENTRY_DSN",
    "NEXT_PUBLIC_ALGOLIA_SEARCH_API_KEY",
    "VITE_RECAPTCHA_SITE_KEY",
    "NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY",
    // Identifiers and settings of secret-bearing providers, not the secrets themselves.
    "VITE_AWS_ACCESS_KEY_ID",
    "VITE_AWS_REGION",
    "NEXT_PUBLIC_GITHUB_CLIENT_ID",
    "VITE_OPENAI_MODEL",
    "VITE_OPENAI_BASE_URL",
    "VITE_SLACK_CHANNEL",
    "VITE_STRIPE_PRICE_ID",
    "VITE_PAYPAL_CLIENT_ID",
    // Generic tokens without a known secret-bearing provider stay unflagged (too noisy).
    "GATSBY_TOKEN",
    "VITE_API_KEY",
    "VITE_CSRF_TOKEN_HEADER",
  ])("%s is client-exposed but not flagged as a secret", (name) => {
    expect(isClientExposed(name)).toBe(true);
    expect(isSecretLikely(name)).toBe(false);
  });
});

describe("env example files", () => {
  it("recognises example files only", () => {
    expect(isEnvExampleFile(".env.example")).toBe(true);
    expect(isEnvExampleFile("apps/web/.env.sample")).toBe(true);
    expect(isEnvExampleFile(".env.local.example")).toBe(true);
    expect(isEnvExampleFile(".env.template")).toBe(true);
    expect(isEnvExampleFile(".env")).toBe(false);
    expect(isEnvExampleFile(".env.local")).toBe(false);
  });

  it("parses keys only (CRLF, export, comments)", () => {
    const text =
      "# comment\r\nexport API_URL=http://x\r\nEMPTY=\r\n  SPACED = 1\r\nNODE_ENV=dev\r\nnot a line\r\n";
    expect(parseEnvExampleKeys(text)).toEqual(["API_URL", "EMPTY", "SPACED"]);
  });
});
