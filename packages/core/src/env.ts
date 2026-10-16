/**
 * Environment variable names that hold secrets, and the sanitiser for the agent subprocess (plan
 * decision 7, constitution IV).
 *
 * The agent receives the parent environment minus provider credentials and anything that looks
 * like a secret. Model credentials the agent SDK needs are kept. Names are compared
 * case-insensitively because Windows environment variables are case-insensitive.
 */

/** Secrets whose names have no secret-looking suffix, matched by name. */
const SECRET_NAMES = new Set(["TF_ENCRYPTION", "OPSCREW_STATE_PASSPHRASE"]);

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

/**
 * True when the variable `name` holds a secret (compared case-insensitively): `TF_ENCRYPTION`,
 * `OPSCREW_STATE_PASSPHRASE`, and names ending in `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PASSWD`,
 * `_PRIVATE_KEY`, `_API_KEY`, `_SECRET_KEY`, `_ACCESS_KEY` or `_AUTHTOKEN` or containing `_TOKEN_`,
 * `_SECRET_`, `_PASSWORD_` or `_PRIVATE_KEY_`. The redactor masks the values of these variables
 * and the agent environment leaves them out.
 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SECRET_NAMES.has(upper) ||
    SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
    SECRET_INFIXES.some((infix) => upper.includes(infix))
  );
}

/**
 * Never given to the agent although they are not secrets: the account half of a provider
 * credential, and variables that hand out credentials indirectly (SSH agent, credential prompts).
 */
const CREDENTIAL_PARTS = new Set([
  "CLOUDFLARE_EMAIL",
  "NAMECHEAP_API_USER",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "VSCODE_GIT_IPC_HANDLE",
]);

/** Always removed, whatever model provider is configured. */
const ALWAYS_PREFIXES = ["TF_VAR_", "CONTABO_", "ARM_", "VSCODE_GIT_ASKPASS_"];

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

function isRemoved(name: string, env: Record<string, string | undefined>): boolean {
  const upper = name.toUpperCase();
  if (CREDENTIAL_PARTS.has(upper)) return true;
  if (ALWAYS_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  if (MODEL_CREDENTIALS.has(upper)) return false;
  for (const family of CLOUD_FAMILIES) {
    if (family.matches(upper)) return env[family.flag] !== "1";
  }
  return isSecretEnvName(upper);
}

/**
 * Returns a new environment for the agent subprocess without secrets ({@link isSecretEnvName}),
 * `TF_VAR_*`, `ARM_*`, `CONTABO_*`, the account names of provider credentials (`CLOUDFLARE_EMAIL`,
 * `NAMECHEAP_API_USER`) and credential channels such as `SSH_AUTH_SOCK`.
 * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are kept; `AWS_*`, Google
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
