import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";

export interface GitStatusEntry {
  /** Two-letter porcelain status, e.g. ` M`, `??`, `A `. */
  code: string;
  path: string;
}

export interface GitClientOptions {
  cwd: string;
  runner: CommandRunner;
  env?: Record<string, string | undefined>;
  git?: string;
  redactor?: Redactor;
}

/** `owner`/`repo` from a GitHub remote URL (https, ssh or scp-like), if it is a GitHub URL. */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return undefined;
  return { owner: match[1] as string, repo: match[2] as string };
}

/** Git operations through the injected command runner (`git -C <cwd> …`, never interactive). */
export class GitClient {
  readonly cwd: string;
  readonly #runner: CommandRunner;
  readonly #env: Record<string, string | undefined>;
  readonly #git: string;
  readonly #redactor: Redactor;

  constructor(options: GitClientOptions) {
    this.cwd = options.cwd;
    this.#runner = options.runner;
    this.#env = {
      ...(options.env ?? process.env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    this.#git = options.git ?? "git";
    this.#redactor = options.redactor ?? new Redactor();
  }

  async #run(args: string[], allowFailure = false): Promise<CommandResult> {
    const result = await this.#runner.run(this.#git, ["-C", this.cwd, ...args], {
      env: this.#env,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0 && !allowFailure) {
      const detail = this.#redactor.redact(
        (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" "),
      );
      if (/Please tell me who you are|empty ident/i.test(result.stderr)) {
        throw new OpsCrewError(
          "COMMAND_FAILED",
          "git does not know who you are, so it cannot commit.",
          {
            hint: 'Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`.',
          },
        );
      }
      throw new OpsCrewError(
        "COMMAND_FAILED",
        `git ${args[0]} failed: ${detail || `exit code ${result.exitCode}`}`,
      );
    }
    return result;
  }

  async isRepo(): Promise<boolean> {
    try {
      const result = await this.#run(["rev-parse", "--is-inside-work-tree"], true);
      return result.exitCode === 0 && result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async root(): Promise<string> {
    return (await this.#run(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  /** Current branch name, or `HEAD` when detached. */
  async currentBranch(): Promise<string> {
    return (await this.#run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  }

  async headSha(): Promise<string> {
    return (await this.#run(["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Working-tree status (porcelain v1, NUL-separated, renames reported with the new path). */
  async status(): Promise<GitStatusEntry[]> {
    const out = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .stdout;
    const parts = out.split("\0").filter((p) => p.length > 0);
    const entries: GitStatusEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      const code = part.slice(0, 2);
      entries.push({ code, path: part.slice(3) });
      if (code.startsWith("R") || code.startsWith("C")) i++; // skip the original path of a rename/copy
    }
    return entries;
  }

  /** True when nothing outside the ignored path prefixes is modified or untracked. */
  async isClean(options: { ignore?: string[] } = {}): Promise<boolean> {
    const ignore = (options.ignore ?? []).map((p) => p.replace(/\/?$/, "/"));
    const entries = await this.status();
    return entries.every((e) =>
      ignore.some((prefix) => e.path === prefix.slice(0, -1) || e.path.startsWith(prefix)),
    );
  }

  async branchExists(name: string): Promise<boolean> {
    return (
      (await this.#run(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], true))
        .exitCode === 0
    );
  }

  async createBranch(name: string): Promise<void> {
    await this.#run(["checkout", "-b", name]);
  }

  async checkout(name: string): Promise<void> {
    await this.#run(["checkout", name]);
  }

  /** Renames local branch `from` to `to` (refuses when `to` exists; never forced). */
  async renameBranch(from: string, to: string): Promise<void> {
    await this.#run(["branch", "-m", "--", from, to]);
  }

  /** Subject line of commit `ref` (default `HEAD`). */
  async commitSubject(ref = "HEAD"): Promise<string> {
    return (await this.#run(["log", "-1", "--format=%s", ref, "--"])).stdout.trim();
  }

  async add(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.#run(["add", "--", ...paths]);
  }

  /** Commits the staged changes and returns the new commit sha. */
  async commit(message: string): Promise<string> {
    await this.#run(["commit", "-m", message]);
    return this.headSha();
  }

  async push(
    branch: string,
    options: { setUpstream?: boolean; remote?: string } = {},
  ): Promise<void> {
    await this.#run([
      "push",
      ...(options.setUpstream ? ["-u"] : []),
      options.remote ?? "origin",
      branch,
    ]);
  }

  /**
   * Commit sha of `branch` where `push` would send it (the remote's push URL), or undefined when
   * the remote has no such branch. Reaches the remote; throws `COMMAND_FAILED` when it cannot.
   */
  async remoteBranchSha(branch: string, remote = "origin"): Promise<string | undefined> {
    const url = (await this.#run(["remote", "get-url", "--push", remote])).stdout.trim();
    // A URL that looks like an option is never passed as one; the remote name is used instead.
    const target = url === "" || url.startsWith("-") ? remote : url;
    const ref = `refs/heads/${branch}`;
    const out = (await this.#run(["ls-remote", "--heads", target, ref])).stdout;
    for (const line of out.split(/\r?\n/)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
    return undefined;
  }

  /** True when commit `ancestor` is in the history of `ref` (false when either is unknown here). */
  async isAncestor(ancestor: string, ref: string): Promise<boolean> {
    return (await this.#run(["merge-base", "--is-ancestor", ancestor, ref], true)).exitCode === 0;
  }

  /** `git diff --stat` against HEAD including staged changes. */
  async diffStat(): Promise<string> {
    return (await this.#run(["diff", "--stat", "HEAD"], true)).stdout.trim();
  }

  async remoteUrl(name = "origin"): Promise<string | undefined> {
    const result = await this.#run(["remote", "get-url", name], true);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /** The remote's default branch (`origin/HEAD`), falling back to `main`. */
  async defaultBranch(): Promise<string> {
    const result = await this.#run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true);
    const ref = result.stdout.trim();
    return result.exitCode === 0 && ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : "main";
  }
}
