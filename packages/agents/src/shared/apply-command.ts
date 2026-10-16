import type { ProvisionOptions } from "../provision";

/** The tokens of the user's Portainer that `--replace-token` sends again after a rotation. */
export const REPLACEABLE_TOKENS = ["repository", "registry"] as const;
/** One value of `--replace-token`. */
export type ReplaceableToken = (typeof REPLACEABLE_TOKENS)[number];

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
}

/**
 * `value` as one word of a command OpsCrew suggests, for a POSIX shell: as it is when it holds only
 * plain characters, otherwise in single quotes (a `'` inside written as `'\''`).
 */
export function shellWord(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
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
