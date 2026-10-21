import type { ProvisionOptions } from "../provision";

/** The tokens of the user's Portainer that `--replace-token` sends again after a rotation. */
export const REPLACEABLE_TOKENS = ["repository", "registry"] as const;
/** One value of `--replace-token`. */
export type ReplaceableToken = (typeof REPLACEABLE_TOKENS)[number];

/**
 * Why the stack plan of the user's Portainer comes only after a `--plan-only` run's plans are
 * applied, as the end of "The stack plan for your Portainer follows once …", or undefined when it
 * came with them: the app's stack gets the key of a bucket still to create, its Caddy needs the
 * origin certificate the Cloudflare plan creates (`stackFollowsOriginTls`, set only when the
 * stack waits for nothing else), or it needs the token of the Cloudflare Tunnel the saved
 * infrastructure plan (`infrastructurePlan`) creates.
 */
export function stackFollowsReason(
  result: { stackPlanHash?: string; storagePlanHash?: string; stackFollowsOriginTls?: true },
  infrastructurePlan: boolean,
): string | undefined {
  if (result.stackPlanHash !== undefined) return undefined;
  if (result.storagePlanHash !== undefined) {
    return "the app's bucket exists, because the app's stack gets the bucket's key";
  }
  if (result.stackFollowsOriginTls === true) {
    return "this Cloudflare plan is applied, because the stack's Caddy needs the origin certificate it creates";
  }
  return infrastructurePlan
    ? "this infrastructure plan is applied, because it needs the Cloudflare Tunnel's token"
    : undefined;
}

/** The flags of a planning run that the command applying its plans must repeat. */
export interface ApplyCommandFlags {
  engine?: "tofu" | "terraform";
  /** `--host-key SHA256:…` of the user's own server. */
  hostKey?: string;
  passwordLogins?: "off" | "keep";
  /** `--public-image` (true) or `--private-image` (false): the stack plan's hash depends on it. */
  publicImage?: boolean;
  replaceTokens?: readonly ReplaceableToken[];
  /** False for `--no-push`. */
  push?: boolean;
  yes?: boolean;
  /** `--confirm <app>`, for a plan that deletes or replaces resources. */
  confirm?: string;
  /** `--key-out <file>`: the file the planning run named for the recovery copy's first age key. */
  keyOut?: string;
}

/**
 * `value` as one word of a command OpsCrew suggests, for a POSIX shell: as it is when it holds only
 * plain characters, otherwise in single quotes (a `'` inside written as `'\''`). `%`, `=` and `,`
 * are quoted too: PowerShell splits `a,b` into two words.
 */
export function shellWord(value: string): string {
  return /^[\w./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A file path as one word of a suggested command: `/` separators, quoted like {@link shellWord}. */
export function pathWord(path: string): string {
  return shellWord(path.replaceAll("\\", "/"));
}

/**
 * `opscrew <command> --approve <hash>…`: the command that applies exactly the plans with these
 * hashes, one `--approve` each, with the flags of the run that made them.
 */
export function applyCommand(
  command: string,
  hashes: readonly string[],
  flags: ApplyCommandFlags = {},
): string {
  return [
    `opscrew ${command}`,
    ...hashes.map((hash) => `--approve ${hash}`),
    ...(flags.engine === undefined ? [] : [`--engine ${flags.engine}`]),
    ...(flags.hostKey === undefined ? [] : [`--host-key ${flags.hostKey}`]),
    ...(flags.passwordLogins === undefined ? [] : [`--password-logins ${flags.passwordLogins}`]),
    ...(flags.publicImage === true ? ["--public-image"] : []),
    ...(flags.publicImage === false ? ["--private-image"] : []),
    ...(flags.replaceTokens ?? []).map((token) => `--replace-token ${token}`),
    ...(flags.push === false ? ["--no-push"] : []),
    ...(flags.yes === true ? ["--yes"] : []),
    ...(flags.confirm === undefined ? [] : [`--confirm ${flags.confirm}`]),
    ...(flags.keyOut === undefined ? [] : [`--key-out ${pathWord(flags.keyOut)}`]),
  ].join(" ");
}

/**
 * `publicImage` and `replaceTokens` of {@link ProvisionOptions} from the image choice (absent:
 * the remembered one applies) and the tokens to send again.
 */
export function portainerImageOptions(
  publicImage: boolean | undefined,
  tokens: readonly ReplaceableToken[] = [],
): Pick<ProvisionOptions, "publicImage" | "replaceTokens"> {
  return {
    ...(publicImage === undefined ? {} : { publicImage }),
    ...(tokens.length === 0
      ? {}
      : {
          replaceTokens: {
            ...(tokens.includes("repository") ? { repository: true } : {}),
            ...(tokens.includes("registry") ? { registry: true } : {}),
          },
        }),
  };
}
