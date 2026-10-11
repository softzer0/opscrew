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
    ["VITE_OPENAI_API_KEY", true, false],
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
