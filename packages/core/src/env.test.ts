import { describe, expect, it } from "vitest";
import { PROVIDER_SECRET_ENV, sanitizeAgentEnv } from "./env";

const FAKE = "fake-value-for-tests";

const NAMED = [
  "HCLOUD_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "DIGITALOCEAN_TOKEN",
  "DIGITALOCEAN_ACCESS_TOKEN",
  "NAMECHEAP_API_KEY",
  "NAMECHEAP_API_USER",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "GODADDY_API_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "TF_ENCRYPTION",
  "OPSCREW_STATE_PASSPHRASE",
];

describe("PROVIDER_SECRET_ENV", () => {
  it("lists every named provider secret", () => {
    expect([...PROVIDER_SECRET_ENV].sort()).toEqual([...NAMED].sort());
  });
});

describe("sanitizeAgentEnv", () => {
  it("removes every named provider secret", () => {
    const env = Object.fromEntries(NAMED.map((name) => [name, FAKE]));
    expect(sanitizeAgentEnv({ ...env, PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it.each([
    "TF_VAR_hcloud_token",
    "TF_VAR_region",
    "CONTABO_CLIENT_ID",
    "ARM_CLIENT_ID",
    "ARM_SUBSCRIPTION_ID",
    "AZURE_CLIENT_ID",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CREDENTIALS",
    "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
    "STRIPE_API_KEY",
    "SENTRY_AUTH_TOKEN",
    "SESSION_SECRET",
    "DB_PASSWORD",
    "SMTP_PASSWD",
    "JWT_PRIVATE_KEY",
    "OPENAI_API_KEY",
    "OPSCREW_E2E_HCLOUD_TOKEN",
    "STRIPE_SECRET_KEY",
    "CLIENT_SECRET_VALUE",
    "AWS_SECRET_ACCESS_KEY",
    "GITLAB_ACCESS_KEY",
    "NPM_CONFIG__AUTHTOKEN",
    "SSH_AUTH_SOCK",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "VSCODE_GIT_ASKPASS_MAIN",
    "VSCODE_GIT_IPC_HANDLE",
    "github_token",
    "Hcloud_Token",
  ])("removes %s", (name) => {
    expect(sanitizeAgentEnv({ [name]: FAKE, HOME: "/home/dev" })).toEqual({ HOME: "/home/dev" });
  });

  it("keeps model credentials and ordinary variables", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-api03-FAKE",
      ANTHROPIC_AUTH_TOKEN: "fake-auth-token",
      ANTHROPIC_BASE_URL: "https://example.test",
      ANTHROPIC_MODEL: "claude-opus-5-5",
      PATH: "/usr/bin",
      HOME: "/home/dev",
      NODE_ENV: "test",
      LANG: "en_US.UTF-8",
      CI: "1",
      TOKENIZERS_PARALLELISM: "false",
      KEYBOARD_LAYOUT: "us",
      OPSCREW_DEBUG: "1",
    };
    expect(sanitizeAgentEnv(env)).toEqual(env);
  });

  it("keeps AWS_* only when Bedrock is enabled", () => {
    const env = {
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE",
      AWS_SECRET_ACCESS_KEY: FAKE,
      AWS_SESSION_TOKEN: FAKE,
      AWS_BEARER_TOKEN_BEDROCK: FAKE,
    };
    expect(sanitizeAgentEnv({ ...env, CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual({
      ...env,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(sanitizeAgentEnv({ ...env, CLAUDE_CODE_USE_BEDROCK: "0" })).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "0",
    });
    expect(sanitizeAgentEnv({ ...env, CLAUDE_CODE_USE_BEDROCK: "true" })).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "true",
    });
  });

  it("keeps Google credentials only when Vertex is enabled", () => {
    const env = {
      GOOGLE_APPLICATION_CREDENTIALS: "/home/dev/fake-sa.json",
      GOOGLE_CREDENTIALS: FAKE,
      CLOUDSDK_CORE_PROJECT: "demo",
      ANTHROPIC_VERTEX_PROJECT_ID: "demo",
      CLOUD_ML_REGION: "us-east5",
    };
    expect(sanitizeAgentEnv({ ...env, CLAUDE_CODE_USE_VERTEX: "1" })).toEqual({
      ...env,
      CLAUDE_CODE_USE_VERTEX: "1",
    });
    expect(sanitizeAgentEnv(env)).toEqual({
      ANTHROPIC_VERTEX_PROJECT_ID: "demo",
      CLOUD_ML_REGION: "us-east5",
    });
  });

  it("keeps AZURE_* and the Foundry key only when Foundry is enabled", () => {
    const env = {
      AZURE_CLIENT_ID: "fake-id",
      AZURE_CLIENT_SECRET: FAKE,
      ANTHROPIC_FOUNDRY_API_KEY: FAKE,
      ANTHROPIC_FOUNDRY_RESOURCE: "demo",
    };
    expect(sanitizeAgentEnv({ ...env, CLAUDE_CODE_USE_FOUNDRY: "1" })).toEqual({
      ...env,
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });
    expect(sanitizeAgentEnv(env)).toEqual({ ANTHROPIC_FOUNDRY_RESOURCE: "demo" });
  });

  it("never keeps provider secrets, TF_VAR_* or ARM_* even with a cloud model provider enabled", () => {
    const result = sanitizeAgentEnv({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      HCLOUD_TOKEN: FAKE,
      GITHUB_TOKEN: FAKE,
      TF_VAR_token: FAKE,
      ARM_CLIENT_SECRET: FAKE,
      CONTABO_CLIENT_SECRET: FAKE,
      DB_PASSWORD: FAKE,
    });
    expect(result).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });
  });

  it("drops undefined values and returns a new object without mutating the input", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      EMPTY: "",
      MISSING: undefined,
      GITHUB_TOKEN: FAKE,
    };
    const result = sanitizeAgentEnv(env);
    expect(result).toEqual({ PATH: "/usr/bin", EMPTY: "" });
    expect(Object.hasOwn(result, "MISSING")).toBe(false);
    expect(result).not.toBe(env);
    expect(env.GITHUB_TOKEN).toBe(FAKE);
  });

  it("does not let a crafted __proto__ key change the result's prototype", () => {
    const env = JSON.parse('{"__proto__": "x", "PATH": "/usr/bin"}') as Record<string, string>;
    const result = sanitizeAgentEnv(env);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.PATH).toBe("/usr/bin");
  });
});
