import {
  GitClient,
  GitHubClient,
  parseGitHubRepo,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";

/** What the git and GitHub helpers need from the phase. */
type GitDeps = Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">;

/** The project's git repository (`git -C <root> …`, never interactive); `git` is the binary. */
export function gitClient(deps: GitDeps, git?: string): GitClient {
  return new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
    ...(git !== undefined ? { git } : {}),
  });
}

/** {@link gitClient}, after stopping plainly when the project is not a git repository. */
export async function requireGitRepo(deps: GitDeps, git?: string): Promise<GitClient> {
  const client = gitClient(deps, git);
  if (!(await client.isRepo())) {
    throw new OpsCrewError("PHASE_PRECONDITION", "This project is not a git repository.", {
      hint: "Run OpsCrew from a clone of your GitHub repository, or run `git init`, commit your code and add your GitHub remote, then try again.",
    });
  }
  return client;
}

/** `owner`/`repo` of the `origin` remote; stops when there is no GitHub remote. */
export async function githubCoordinates(git: GitClient): Promise<{ owner: string; repo: string }> {
  const remote = await git.remoteUrl("origin");
  const coordinates = remote ? parseGitHubRepo(remote) : undefined;
  if (!coordinates) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This repository has no GitHub remote named origin, so there is nowhere to build and deploy from.",
      {
        hint: "Create the repository on GitHub, run `git remote add origin https://github.com/<owner>/<repo>.git`, push, then try again.",
      },
    );
  }
  return coordinates;
}

/**
 * A GitHub client with the user's token (`GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI's login),
 * which is registered with the redactor first; `undefined` when there is no token.
 */
export async function githubClientFromToken(
  deps: Pick<PhaseDeps, "env" | "runner" | "redactor" | "fetch" | "version">,
): Promise<GitHubClient | undefined> {
  const token = await resolveGitHubToken(deps.env, deps.runner);
  if (!token) return undefined;
  deps.redactor.addLiteral(token, "github-token");
  return new GitHubClient({
    token,
    fetch: deps.fetch,
    version: deps.version,
    redactor: deps.redactor,
  });
}

/**
 * Whether the project's GitHub repository (the `origin` remote) is private, from GitHub's
 * repository API with the user's token; `undefined` when that is unknown (no GitHub remote, no
 * token, or GitHub did not answer). The interview's signing question then says what signing makes
 * public (FR-1219).
 */
export async function repositoryPrivate(
  deps: GitDeps & Pick<PhaseDeps, "fetch" | "version">,
): Promise<boolean | undefined> {
  try {
    const { owner, repo } = await githubCoordinates(gitClient(deps));
    const github = await githubClientFromToken(deps);
    return github === undefined ? undefined : (await github.getRepo(owner, repo)).private;
  } catch {
    return undefined;
  }
}

/**
 * The paths git tracks under `paths` (`git ls-files`; with `deleted`, only those deleted in the
 * working copy), as git lists them. None when `paths` is empty or git fails.
 */
export async function trackedFiles(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  paths: readonly string[],
  options: { deleted?: boolean } = {},
): Promise<string[]> {
  if (paths.length === 0) return [];
  const listed = await deps.runner.run("git", [
    "-C",
    deps.paths.root,
    "ls-files",
    ...(options.deleted === true ? ["--deleted"] : []),
    "--",
    ...paths,
  ]);
  if (listed.exitCode !== 0) return [];
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
