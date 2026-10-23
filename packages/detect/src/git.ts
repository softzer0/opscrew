import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ProjectFacts } from "@opscrew/plan-schema";

/** A parsed git remote URL with any credentials removed. */
export interface GitRemote {
  /** The remote URL without user name, password or token (`git@` is kept for SSH shorthand). */
  remoteUrl: string;
  /** Lower-case host name, when the URL has one. */
  host?: string;
  /** Owner path (`acme`, or `group/subgroup` for nested GitLab groups). */
  owner?: string;
  /** Repository name without a `.git` suffix. */
  repo?: string;
}

function ownerAndRepo(path: string): { owner?: string; repo?: string } {
  const segments = path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  const repo = segments.at(-1);
  if (!repo) return {};
  const owner = segments.slice(0, -1).join("/");
  return owner ? { owner, repo } : { repo };
}

/**
 * Parses a git remote URL (`https://`, `ssh://`, `git://`, scp-like `git@host:owner/repo.git`,
 * local paths) and strips credentials: user info in URL forms (`https://user:token@host/…`),
 * any query string or fragment, and every scp-like user except the conventional `git@`.
 */
export function parseGitRemote(url: string): GitRemote {
  const raw = url.trim();

  const withScheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s.exec(raw);
  if (withScheme) {
    const protocol = (withScheme[1] ?? "").toLowerCase();
    const rest = (withScheme[2] ?? "").replace(/[?#].*$/s, "");
    const slash = rest.indexOf("/");
    let authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? "" : rest.slice(slash);
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    const remoteUrl = `${protocol}://${authority}${path}`;
    if (protocol === "file") return { remoteUrl };
    const host = authority.replace(/:\d*$/, "").toLowerCase();
    return { remoteUrl, ...(host ? { host } : {}), ...ownerAndRepo(path) };
  }

  // Local paths: POSIX absolute/relative, Windows drive letters and UNC paths.
  if (/^(?:[A-Za-z]:[\\/]|[\\/.~])/.test(raw)) return { remoteUrl: raw };

  // scp-like: [user@]host:path, where the ':' comes before any '/'.
  const firstSlash = raw.indexOf("/");
  const head = firstSlash < 0 ? raw : raw.slice(0, firstSlash);
  const at = head.lastIndexOf("@");
  const user = at >= 0 ? raw.slice(0, at) : undefined;
  const afterUser = raw.slice(at + 1);
  const colon = afterUser.indexOf(":");
  const slashAfterUser = afterUser.indexOf("/");
  if (colon <= 0 || (slashAfterUser >= 0 && slashAfterUser < colon)) {
    return { remoteUrl: afterUser };
  }
  const host = afterUser.slice(0, colon);
  const path = afterUser.slice(colon + 1);
  const remoteUrl = `${user === "git" ? "git@" : ""}${host}:${path}`;
  return { remoteUrl, host: host.toLowerCase(), ...ownerAndRepo(path) };
}

/** Parses a git config value: quotes, backslash escapes and trailing `#`/`;` comments. */
function parseConfigValue(text: string): string {
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\\" && i + 1 < text.length) {
      const next = text[++i] as string;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      value += char;
    }
  }
  return value.trim();
}

/** Returns `remote name → url` in file order (first `url` per remote wins). */
export function parseGitConfigRemotes(text: string): Map<string, string> {
  const remotes = new Map<string, string>();
  let remote: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      const name = (section[1] ?? "").toLowerCase();
      remote = name === "remote" && section[2] !== undefined ? section[2] : undefined;
      continue;
    }
    if (remote === undefined) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(line);
    if (entry && (entry[1] ?? "").toLowerCase() === "url" && !remotes.has(remote)) {
      const value = parseConfigValue(entry[2] ?? "");
      if (value) remotes.set(remote, value);
    }
  }
  return remotes;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Locates the git directory and the common directory (they differ for linked worktrees). */
async function resolveGitDirs(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = join(root, ".git");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  let gitDir = dotGit;
  if (info.isFile()) {
    // Linked worktree or submodule: `.git` is a file containing `gitdir: <path>`.
    const text = (await readText(dotGit)) ?? "";
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!match?.[1]) return null;
    gitDir = isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
  } else if (!info.isDirectory()) {
    return null;
  }
  const common = (await readText(join(gitDir, "commondir")))?.trim();
  const commonDir = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
  return { gitDir, commonDir };
}

function symbolicRef(text: string | undefined, prefix: string): string | undefined {
  const match = /^ref:\s*(\S+)/.exec(text?.trim() ?? "");
  const ref = match?.[1];
  return ref?.startsWith(prefix) && ref.length > prefix.length
    ? ref.slice(prefix.length)
    : undefined;
}

/** True when the remote-tracking ref `ref` exists, as a loose file or a line of `packed-refs`. */
async function hasRef(commonDir: string, ref: string, packedRefs: string): Promise<boolean> {
  if ((await readText(join(commonDir, ...ref.split("/")))) !== undefined) return true;
  return packedRefs.split(/\r?\n/).some((line) => line.split(" ")[1] === ref);
}

/**
 * Reads git facts straight from the `.git` directory (no git binary): the `origin` remote (or the
 * first remote) with credentials stripped, its owner/repo, the default branch and the current
 * branch from `HEAD`. The default branch is the one `refs/remotes/<remote>/HEAD` points at; a
 * repository pushed rather than cloned has none, and then it is `main` or else `master` when the
 * remote has that branch (a loose ref or one in `packed-refs`). Supports `.git` files that point
 * at a linked worktree or submodule git directory. Returns `{}` when `root` is not a git checkout.
 */
export async function readGitInfo(root: string): Promise<ProjectFacts["git"]> {
  const dirs = await resolveGitDirs(root);
  if (!dirs) return {};
  const git: ProjectFacts["git"] = {};

  const config =
    (await readText(join(dirs.commonDir, "config"))) ??
    (await readText(join(dirs.gitDir, "config"))) ??
    "";
  const remotes = parseGitConfigRemotes(config);
  const remoteName = remotes.has("origin") ? "origin" : [...remotes.keys()][0];
  const url = remoteName === undefined ? undefined : remotes.get(remoteName);
  if (remoteName !== undefined && url) {
    const remote = parseGitRemote(url);
    if (remote.remoteUrl) git.remoteUrl = remote.remoteUrl;
    if (remote.owner) git.owner = remote.owner;
    if (remote.repo) git.repo = remote.repo;
    const remoteHead = await readText(join(dirs.commonDir, "refs", "remotes", remoteName, "HEAD"));
    const defaultBranch = symbolicRef(remoteHead, `refs/remotes/${remoteName}/`);
    if (defaultBranch) {
      git.defaultBranch = defaultBranch;
    } else {
      const packedRefs = (await readText(join(dirs.commonDir, "packed-refs"))) ?? "";
      for (const name of ["main", "master"]) {
        if (await hasRef(dirs.commonDir, `refs/remotes/${remoteName}/${name}`, packedRefs)) {
          git.defaultBranch = name;
          break;
        }
      }
    }
  }

  const currentBranch = symbolicRef(await readText(join(dirs.gitDir, "HEAD")), "refs/heads/");
  if (currentBranch) git.currentBranch = currentBranch;
  return git;
}
