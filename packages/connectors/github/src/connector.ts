import type { CommandRunner, Connector, CredentialCheck, FetchLike } from "@opscrew/contracts";
import { findExecutable, Redactor } from "@opscrew/core";
import { GITHUB_TOKEN_PERMISSIONS, GitHubClient } from "./github";

/**
 * GitHub token from `GITHUB_TOKEN`, `GH_TOKEN`, or the GitHub CLI (`gh auth token`), in that order.
 */
export async function resolveGitHubToken(
  env: Record<string, string | undefined>,
  runner: CommandRunner,
): Promise<string | undefined> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const gh = findExecutable("gh", env);
  if (!gh) return undefined;
  try {
    const result = await runner.run(gh, ["auth", "token"], { timeoutMs: 15_000 });
    const token = result.stdout.trim();
    return result.exitCode === 0 && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface GitHubConnectorOptions {
  /** Token already resolved with `resolveGitHubToken` (or undefined). */
  token: string | undefined;
  fetch: FetchLike;
  redactor?: Redactor;
  version?: string;
}

export interface GitHubConnector extends Connector {
  readonly client: GitHubClient | undefined;
}

/** GitHub connector: the credential check and the REST client. */
export function githubConnector(options: GitHubConnectorOptions): GitHubConnector {
  const redactor = options.redactor ?? new Redactor();
  if (options.token) redactor.addLiteral(options.token, "github-token");
  const client = options.token
    ? new GitHubClient({
        token: options.token,
        fetch: options.fetch,
        ...(options.version ? { version: options.version } : {}),
      })
    : undefined;
  return {
    id: "github",
    displayName: "GitHub",
    credentials: {
      envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
      description:
        "Fine-grained GitHub token for this repository (or log in with `gh auth login`).",
      scopes: [...GITHUB_TOKEN_PERMISSIONS],
      createUrl: "https://github.com/settings/personal-access-tokens/new",
    },
    client,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (!client)
        return { ok: false, message: "No GitHub token: set GITHUB_TOKEN or run `gh auth login`." };
      try {
        const login = await client.whoAmI();
        return {
          ok: true,
          identity: login,
          message: `GitHub token works (signed in as ${login}).`,
        };
      } catch (error) {
        return {
          ok: false,
          message: redactor.redact(error instanceof Error ? error.message : String(error)),
        };
      }
    },
  };
}
