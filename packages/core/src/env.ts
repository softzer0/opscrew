/**
 * Environment sanitiser for the agent subprocess (plan decision 7, constitution IV).
 *
 * The agent receives the parent environment minus provider credentials and anything that looks
 * like a secret. Model credentials the agent SDK needs are kept. Names are compared
 * case-insensitively because Windows environment variables are case-insensitive.
 */

/** Provider and OpsCrew secrets that are always removed from the agent environment, by name. */
export const PROVIDER_SECRET_ENV: readonly string[] = Object.freeze([
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
]);

const NAMED = new Set(PROVIDER_SECRET_ENV);

/** Variables that hand out credentials indirectly (SSH agent, git credential prompts). */
const CREDENTIAL_CHANNELS = new Set([
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "VSCODE_GIT_IPC_HANDLE",
]);

/** Always removed, whatever model provider is configured. */
const ALWAYS_PREFIXES = ["TF_VAR_", "CONTABO_", "ARM_", "VSCODE_GIT_ASKPASS_"];

const SECRET_SUFFIXES = [
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_PASSWD",
  "_PRIVATE_KEY",
  "_API_KEY",
  "_SECRET_KEY",
  "_ACCESS_KEY",
  "_AUTHTOKEN",
];
const SECRET_INFIXES = ["_TOKEN_", "_SECRET_", "_PASSWORD_", "_PRIVATE_KEY_"];

/** Model credentials the agent SDK needs; never removed. */
const MODEL_CREDENTIALS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

interface CloudFamily {
  /** Opt-in flag that routes the model through this cloud; its credentials are then kept. */
  flag: string;
  matches(name: string): boolean;
}

const CLOUD_FAMILIES: CloudFamily[] = [
  { flag: "CLAUDE_CODE_USE_BEDROCK", matches: (n) => n.startsWith("AWS_") },
  {
    flag: "CLAUDE_CODE_USE_VERTEX",
    matches: (n) =>
      n === "GOOGLE_APPLICATION_CREDENTIALS" ||
      n === "GOOGLE_CREDENTIALS" ||
      n.startsWith("CLOUDSDK_"),
  },
  {
    flag: "CLAUDE_CODE_USE_FOUNDRY",
    matches: (n) => n.startsWith("AZURE_") || n === "ANTHROPIC_FOUNDRY_API_KEY",
  },
];

function isEnabled(env: Record<string, string | undefined>, flag: string): boolean {
  return env[flag] === "1";
}

function isRemoved(name: string, env: Record<string, string | undefined>): boolean {
  const upper = name.toUpperCase();
  if (NAMED.has(upper) || CREDENTIAL_CHANNELS.has(upper)) return true;
  if (ALWAYS_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  if (MODEL_CREDENTIALS.has(upper)) return false;
  for (const family of CLOUD_FAMILIES) {
    if (family.matches(upper)) return !isEnabled(env, family.flag);
  }
  return (
    SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
    SECRET_INFIXES.some((infix) => upper.includes(infix))
  );
}

/**
 * Returns a new environment for the agent subprocess without provider tokens and secret-looking
 * variables. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are kept; `AWS_*`, Google
 * credentials/`CLOUDSDK_*` and `AZURE_*` (plus `ANTHROPIC_FOUNDRY_API_KEY`) are kept only when
 * `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` is `1`.
 * Undefined values are dropped. The input is not modified.
 */
export function sanitizeAgentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (isRemoved(name, env)) continue;
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}
