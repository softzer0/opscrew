import { describe, expect, it } from "vitest";
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
