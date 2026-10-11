/**
 * Default tool policy: the boundary between a language model and the user's machine
 * (FR-009, plan decision 4, constitution I and IV).
 *
 * The policy fails closed: unknown tools, unparseable input and anything it cannot verify are
 * denied (or, for Bash commands that are not clearly dangerous, sent to a human as `ask`).
 * It is pure and synchronous; the host platform only decides how paths are compared.
 */
import path from "node:path";
import type {
  BuiltinTool,
  ToolCall,
  ToolDecision,
  ToolPolicy,
  ToolProfile,
} from "@opscrew/contracts";

// =============================================================================================
// Profiles
// =============================================================================================

/** Built-in tools each profile enables. `MultiEdit` is treated as `Edit`. */
export const PROFILE_TOOLS: Readonly<Record<ToolProfile, readonly BuiltinTool[]>> = Object.freeze({
  none: Object.freeze([]),
  "read-only": Object.freeze(["Read", "Glob", "Grep"]),
  "edit-repo": Object.freeze(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]),
} satisfies Record<ToolProfile, readonly BuiltinTool[]>);

const KNOWN_BUILTINS = new Set<string>(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);

const ALWAYS_DENIED: Record<string, string> = {
  WebFetch: "Web access is not available to OpsCrew agents.",
  WebSearch: "Web access is not available to OpsCrew agents.",
  Task: "Sub-agents are not available to OpsCrew agents.",
  Agent: "Sub-agents are not available to OpsCrew agents.",
  NotebookEdit: "Notebook editing is not available to OpsCrew agents.",
  KillShell: "Managing background shells is not available to OpsCrew agents.",
};

// =============================================================================================
// Secret paths
// =============================================================================================

const SECRET_DIR_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".terraform",
  ".opscrew",
  ".git",
  ".kube",
  ".azure",
  ".terraform.d",
]);
/** Tool config directories under `.config/` that hold API tokens. */
const CONFIG_SECRET_DIRS = new Set(["gh", "hcloud", "gcloud", "doctl"]);
const SECRET_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "known_hosts",
  ".pgpass",
  ".envrc",
  "credentials.tfrc.json",
]);
const SECRET_NAME_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
const SECRET_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".tfvars",
  ".tfvars.json",
  ".ppk",
];
const ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist"]);

/** Lower-cases and strips the trailing dots/spaces that Windows ignores (keeps `.` and `..`). */
function normalizeSegment(segment: string): string {
  const lower = segment.toLowerCase();
  const stripped = lower.replace(/[. ]+$/, "");
  return stripped === "" ? lower : stripped;
}

function isSecretBasename(base: string): boolean {
  if (base === ".env") return true;
  if (base.startsWith(".env.")) return !ENV_TEMPLATE_SUFFIXES.has(base.slice(5));
  if (SECRET_NAMES.has(base)) return true;
  if (SECRET_NAME_PREFIXES.some((prefix) => base.startsWith(prefix))) return true;
  if (base.includes(".tfstate")) return true;
  return SECRET_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/**
 * True when `p` names a file or directory that may hold secrets: `.env` files (except
 * `.env.example|sample|template|dist`), keys and certificates, Terraform state and variables,
 * SSH keys, package-registry and git credentials, anything under `.ssh`, `.aws`, `.gnupg`,
 * `.docker`, `.terraform`, `.opscrew`, `.git` (but not `.gitignore`/`.gitattributes`), `.kube`,
 * `.azure`, `.terraform.d` and token-holding `.config/` directories. Accepts `/` and `\`
 * separators and compares case-insensitively.
 */
export function isSecretPath(p: string): boolean {
  if (typeof p !== "string" || p === "") return false;
  const segments = p
    .split(/[\\/]+/)
    .filter((segment) => segment !== "")
    .map(normalizeSegment);
  const base = segments.at(-1);
  if (base === undefined) return false;
  for (const [i, segment] of segments.entries()) {
    if (SECRET_DIR_SEGMENTS.has(segment)) return true;
    if (segment === ".config" && CONFIG_SECRET_DIRS.has(segments[i + 1] ?? "")) return true;
  }
  if (isSecretBasename(base)) return true;
  // NTFS alternate data streams: `.env::$DATA` reads `.env`.
  const colon = base.indexOf(":");
  return colon > 0 && isSecretBasename(normalizeSegment(base.slice(0, colon)));
}

// =============================================================================================
// Globs
// =============================================================================================

const SECRET_FILE_SAMPLES = [
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  "server.pem",
  "tls.key",
  "cert.p12",
  "cert.pfx",
  "store.jks",
  "release.keystore",
  "terraform.tfstate",
  "terraform.tfstate.backup",
  "prod.tfvars",
  "prod.tfvars.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "deploy.ppk",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  "known_hosts",
  "credentials",
  "credentials.tfrc.json",
];
const SECRET_DIR_SAMPLES = [...SECRET_DIR_SEGMENTS];
const NEUTRAL_FILE_SAMPLES = [
  "index.ts",
  "main.go",
  "app.py",
  "README.md",
  "package.json",
  "style.css",
  "Makefile",
];
const NEUTRAL_DIR_SAMPLES = ["src", "lib", "app", "test"];
const MAX_BRACE_EXPANSION = 64;

function splitTopLevelCommas(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

/** Expands `{a,b}` alternatives. Returns `undefined` when the expansion is too large. */
function expandBraces(s: string): string[] | undefined {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
    } else if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth !== 0) continue;
      const parts = splitTopLevelCommas(s.slice(open + 1, i));
      if (parts.length > 1) {
        const out: string[] = [];
        for (const part of parts) {
          const expanded = expandBraces(s.slice(0, open) + part + s.slice(i + 1));
          if (expanded === undefined) return undefined;
          out.push(...expanded);
          if (out.length > MAX_BRACE_EXPANSION) return undefined;
        }
        return out;
      }
    }
  }
  return [s];
}

/** Regex for one glob path segment (`*`, `?`, `[...]`), case-insensitive. */
function segmentRegex(segment: string): RegExp {
  let re = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else if (c === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let body = segment.slice(i + 1, close).replace(/\\/g, "\\\\");
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body}]`;
      i = close;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${re}$`, "i");
  } catch {
    return /^/; // unparseable class: assume it matches everything (fail closed)
  }
}

interface GlobRisk {
  /** The glob could expand to a secret file or directory. */
  mayMatchSecret: boolean;
  /** The glob singles out secrets (matches secret samples but no ordinary file). */
  targetsSecret: boolean;
}

/**
 * Estimates whether a glob reaches secrets by matching it against representative secret and
 * ordinary names. `shellDotRule` applies the shell rule that wildcards do not match a leading dot.
 */
function globRisk(glob: string, shellDotRule: boolean): GlobRisk {
  const alternatives = expandBraces(glob);
  if (alternatives === undefined) return { mayMatchSecret: true, targetsSecret: true };
  const risk: GlobRisk = { mayMatchSecret: false, targetsSecret: false };
  for (const alternative of alternatives) {
    if (isSecretPath(alternative)) {
      risk.mayMatchSecret = true;
      risk.targetsSecret = true;
      continue;
    }
    const segments = alternative.split(/[\\/]+/).filter((s) => s !== "");
    for (const [i, segment] of segments.entries()) {
      if (!/[*?[]/.test(segment)) continue;
      const last = i === segments.length - 1;
      const rx = segmentRegex(segment);
      const fits = (name: string) =>
        (!shellDotRule || !name.startsWith(".") || segment.startsWith(".")) && rx.test(name);
      const secrets = last ? [...SECRET_FILE_SAMPLES, ...SECRET_DIR_SAMPLES] : SECRET_DIR_SAMPLES;
      if (!secrets.some(fits)) continue;
      risk.mayMatchSecret = true;
      if (!(last ? NEUTRAL_FILE_SAMPLES : NEUTRAL_DIR_SAMPLES).some(fits)) {
        risk.targetsSecret = true;
      }
    }
  }
  return risk;
}

// =============================================================================================
// Paths
// =============================================================================================

interface PathContext {
  win: boolean;
  api: typeof path.posix;
  /** Resolved absolute project root. */
  root: string;
}

type Resolution =
  | { status: "inside"; rel: string }
  | { status: "outside" }
  | { status: "unknown"; why: string };

const WIN_DRIVE_RELATIVE = /^[a-zA-Z]:(?![\\/])/;
const WIN_DEVICE_PATH = /^[\\/]{2}[?.][\\/]/;
const WIN_SHORT_NAME = /~\d/;

function makePathContext(projectRoot: unknown, win: boolean): PathContext | undefined {
  if (typeof projectRoot !== "string" || projectRoot === "" || projectRoot.includes("\0")) {
    return undefined;
  }
  const api = win ? path.win32 : path.posix;
  if (!api.isAbsolute(projectRoot)) return undefined;
  if (win && !/^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/?.])/.test(projectRoot)) return undefined;
  return { win, api, root: api.resolve(projectRoot) };
}

function locate(ctx: PathContext, absolute: string): Resolution {
  const key = (s: string) => (ctx.win ? s.toLowerCase() : s);
  const root = key(ctx.root);
  const target = key(absolute);
  if (target === root) return { status: "inside", rel: "" };
  const prefix = root.endsWith(ctx.api.sep) ? root : root + ctx.api.sep;
  if (!target.startsWith(prefix)) return { status: "outside" };
  return { status: "inside", rel: ctx.api.relative(ctx.root, absolute) };
}

/** Resolves a path string against the project root without touching the filesystem. */
function resolvePath(ctx: PathContext, raw: string): Resolution {
  if (raw.includes("\0")) return { status: "unknown", why: "contains a NUL byte" };
  if (raw.startsWith("~")) return { status: "unknown", why: "is relative to a home directory" };
  if (ctx.win) {
    if (WIN_DRIVE_RELATIVE.test(raw)) return { status: "unknown", why: "is drive-relative" };
    if (WIN_DEVICE_PATH.test(raw)) return { status: "unknown", why: "uses a device path" };
  }
  return locate(ctx, ctx.api.resolve(ctx.root, raw));
}

/** Project-relative locations agents may never write. */
function protectedWriteReason(rel: string): string | undefined {
  const segments = rel
    .split(/[\\/]+/)
    .filter((s) => s !== "")
    .map(normalizeSegment);
  if (segments.includes(".git")) return "git internals (.git/) are never edited by agents";
  if (segments.includes(".opscrew")) return "OpsCrew state (.opscrew/) is never edited by agents";
  if (segments[0] === "opscrew") {
    return "OpsCrew artefacts (opscrew/) are written by validated code, not by agents";
  }
  const joined = segments.join("/");
  if (
    joined === ".github/workflows/opscrew-deploy.yml" ||
    joined === ".github/workflows/opscrew-deploy.yaml"
  ) {
    return "the OpsCrew deploy workflow is rendered by OpsCrew, not edited by agents";
  }
  return undefined;
}

// =============================================================================================
// Shell lexing
// =============================================================================================

interface Lexed {
  segments: string[];
  /** Set when quotes are unbalanced. */
  error?: string;
  /** Unquoted `(` or `)` was seen (sub-shells, groups, function definitions). */
  grouping: boolean;
}

/** Index of the closing quote of an ANSI-C `$'...'` string starting at `start` (the `'`). */
function ansiCEnd(s: string, start: number): number {
  for (let j = start + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "'") return j;
  }
  return -1;
}

function doubleQuoteEnd(s: string, start: number): number {
  for (let j = start + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === '"') return j;
  }
  return -1;
}

function lexCommand(command: string): Lexed {
  const segments: string[] = [];
  let current = "";
  let grouping = false;
  let error: string | undefined;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed !== "") segments.push(trimmed);
    current = "";
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    const next = command[i + 1];
    if (c === "\\") {
      if (next === "\n") {
        i += 2;
      } else if (next === "\r" && command[i + 2] === "\n") {
        i += 3;
      } else {
        current += command.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || (c === "$" && next === "'")) {
      const open = c === "$" ? i + 1 : i;
      const end =
        c === "'"
          ? command.indexOf("'", i + 1)
          : c === '"'
            ? doubleQuoteEnd(command, i)
            : ansiCEnd(command, open);
      if (end < 0) {
        error = "it has an unterminated quote";
        current += command.slice(i);
        break;
      }
      current += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "\n" || c === "\r" || c === ";") {
      push();
      i++;
    } else if (c === "(" || c === ")") {
      grouping = true;
      push();
      i++;
    } else if (c === "&") {
      if (next === "&") {
        push();
        i += 2;
      } else if (next === ">") {
        current += "&>";
        i += 2;
      } else {
        push();
        i++;
      }
    } else if (c === "|") {
      push();
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (c === ">" || c === "<") {
      current += c;
      i++;
      const follow = command[i];
      if (follow !== undefined && (c === ">" ? ">|&" : "<>&").includes(follow)) {
        current += follow;
        i++;
      }
    } else {
      current += c;
      i++;
    }
  }
  push();
  return error === undefined ? { segments, grouping } : { segments, grouping, error };
}

/**
 * Splits a shell command into simple-command segments on the control operators `&&`, `||`, `;`,
 * `|`, `|&`, `&` and newlines (plus sub-shell parentheses). Quotes, escapes and redirections such
 * as `2>&1`, `&>` and `>|` are respected; empty segments are dropped. Line continuations are
 * joined.
 */
export function splitShellCommand(command: string): string[] {
  return lexCommand(command).segments;
}

interface Word {
  /** Value after quote removal. */
  value: string;
  /** Contains a parameter, ANSI-C or locale expansion (`$x`, `${x}`, `$'..'`, `$".."`). */
  dynamic: boolean;
  /** Contains an unquoted glob character (`*`, `?`, `[`). */
  glob: boolean;
  /** Contains unquoted braces (brace expansion). */
  brace: boolean;
  /** Starts with an unquoted `~` (home expansion). */
  tilde: boolean;
  /** Any part was quoted or escaped. */
  quoted: boolean;
}

interface Redirect {
  op: string;
  target: Word;
}

interface ParsedSegment {
  words: Word[];
  redirects: Redirect[];
  error?: string;
}

const EXPANSION_START = /[A-Za-z_{(0-9@*#?$!-]/;

function readWord(s: string, start: number): { word: Word; next: number; error?: string } {
  const word: Word = {
    value: "",
    dynamic: false,
    glob: false,
    brace: false,
    tilde: false,
    quoted: false,
  };
  let i = start;
  while (i < s.length) {
    const c = s[i] as string;
    const next = s[i + 1];
    if (c === " " || c === "\t" || c === "<" || c === ">" || c === "&") break;
    if (c === "\\") {
      if (next === undefined) {
        word.value += c;
        i++;
      } else if (next === "\n") {
        i += 2;
      } else {
        word.value += next;
        word.quoted = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return { word, next: s.length, error: "it has an unterminated quote" };
      word.value += s.slice(i + 1, end);
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === "$" && next === "'") {
      const end = ansiCEnd(s, i + 1);
      if (end < 0) return { word, next: s.length, error: "it has an unterminated quote" };
      word.value += s.slice(i, end + 1);
      word.dynamic = true;
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        const d = s[j] as string;
        const after = s[j + 1];
        if (d === "\\" && after !== undefined && '$`"\\\n'.includes(after)) {
          if (after !== "\n") word.value += after;
          j += 2;
          continue;
        }
        if (d === "$" && after !== undefined && EXPANSION_START.test(after)) word.dynamic = true;
        word.value += d;
        j++;
      }
      if (j >= s.length) return { word, next: s.length, error: "it has an unterminated quote" };
      word.quoted = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && next !== undefined && (EXPANSION_START.test(next) || next === '"')) {
      word.dynamic = true;
    } else if (c === "*" || c === "?" || c === "[") {
      word.glob = true;
    } else if (c === "{" || c === "}") {
      word.brace = true;
    } else if (c === "~" && word.value === "" && !word.quoted) {
      word.tilde = true;
    }
    word.value += c;
    i++;
  }
  return { word, next: i };
}

function parseSegment(segment: string): ParsedSegment {
  const words: Word[] = [];
  const redirects: Redirect[] = [];
  let i = 0;
  const skipBlanks = () => {
    while (segment[i] === " " || segment[i] === "\t") i++;
  };
  while (true) {
    skipBlanks();
    if (i >= segment.length) break;
    const c = segment[i];
    if (c === "<" || c === ">" || (c === "&" && segment[i + 1] === ">")) {
      let op: string;
      if (c === "&") {
        op = segment[i + 2] === ">" ? "&>>" : "&>";
      } else {
        const follow = segment[i + 1];
        op = follow !== undefined && (c === ">" ? ">|&" : "<>&").includes(follow) ? c + follow : c;
      }
      i += op.length;
      skipBlanks();
      if (i >= segment.length || "<>&".includes(segment[i] as string)) {
        return { words, redirects, error: "a redirection has no target" };
      }
      const { word, next, error } = readWord(segment, i);
      if (error !== undefined) return { words, redirects, error };
      redirects.push({ op, target: word });
      i = next;
      continue;
    }
    if (c === "&") {
      return { words, redirects, error: "it has an unexpected `&`" };
    }
    const { word, next, error } = readWord(segment, i);
    if (error !== undefined) return { words, redirects, error };
    i = next;
    // `2>file`: an unquoted all-digit word directly before a redirection is a file descriptor.
    const follow = segment[i];
    const isFd = !word.quoted && /^\d+$/.test(word.value) && (follow === "<" || follow === ">");
    if (!isFd) words.push(word);
  }
  return { words, redirects };
}

// =============================================================================================
// Bash rules
// =============================================================================================

type Verdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

const REASON = {
  infra:
    "infrastructure and cloud CLIs are not available to agents; OpsCrew changes infrastructure only through a reviewed plan and an explicit approval",
  network:
    "network and remote-access tools are blocked because they can send project data off this machine",
  privilege: "changing users, privileges or file ownership is not allowed",
  packages: "downloading and running packages ad hoc is not allowed",
  environment:
    "reading or changing the shell environment, or evaluating dynamic code, is not allowed",
  shell: "starting another shell or inline interpreter is not allowed",
  system: "system administration commands are not allowed",
  git: "publishing, rewriting history and changing git configuration or credentials is not allowed",
  gitWrite:
    "changing commits, branches or the index is done by OpsCrew after you review the diff, not by agents",
  docker: "running, publishing or deleting containers and images is not allowed",
  registry: "publishing packages or managing registry credentials is not allowed",
  delete: "recursive deletes of the project root, parent, home or wildcard targets are not allowed",
  find: "find actions that execute commands, delete files or write files are not allowed",
  database: "dropping database tables or databases is not allowed",
};

const DENY_COMMANDS = new Map<string, string>();
const addDeny = (reason: string, names: string[]) => {
  for (const name of names) DENY_COMMANDS.set(name, reason);
};
addDeny(REASON.infra, [
  "terraform",
  "tofu",
  "terragrunt",
  "pulumi",
  "hcloud",
  "doctl",
  "aws",
  "gcloud",
  "gsutil",
  "az",
  "kubectl",
  "helm",
  "wrangler",
  "flyctl",
  "vercel",
  "netlify",
  "heroku",
  "ansible",
  "ansible-playbook",
  "vault",
  "packer",
]);
addDeny(REASON.network, [
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "ftp",
  "tftp",
  "gh",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
]);
addDeny(REASON.privilege, ["sudo", "su", "doas", "chown"]);
addDeny(REASON.packages, ["npx", "bunx"]);
addDeny(REASON.environment, [
  "env",
  "printenv",
  "set",
  "export",
  "eval",
  "source",
  ".",
  "declare",
  "typeset",
]);
addDeny(REASON.shell, ["powershell", "pwsh", "cmd", "iex", "invoke-expression", "wsl", "busybox"]);
addDeny(REASON.system, [
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "kill",
  "pkill",
  "killall",
  "crontab",
  "history",
]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh"]);
const PYTHONS = new Set(["python", "python3", "python2", "py", "pypy", "pypy3"]);
const JS_RUNTIMES = new Set(["node", "nodejs", "deno", "bun"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const REGISTRY_SUBCOMMANDS = new Set([
  "publish",
  "unpublish",
  "login",
  "adduser",
  "token",
  "owner",
  "deprecate",
]);
const GIT_DENIED_SUBCOMMANDS = new Set([
  "push",
  "remote",
  "config",
  "filter-branch",
  "filter-repo",
  "clean",
  "send-email",
  "daemon",
]);
/** Git subcommands that change commits, branches, the index or the working tree. OpsCrew
 * performs these itself after the user reviews the diff, so agents may only read history. */
const GIT_WRITE_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "commit",
  "merge",
  "mv",
  "notes",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "update-index",
  "update-ref",
  "worktree",
]);
const FIND_DENIED_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
/** Commands whose path arguments are written, moved or deleted. */
const WRITE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "tee",
  "touch",
  "ln",
  "truncate",
  "install",
  "shred",
  "mkdir",
  "chmod",
]);

const SHELL_KEYWORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "in",
]);

/** Commands that run another command; values are options that take a separate argument. */
const WRAPPERS: Record<string, { valueOptions: string[]; positionals?: number }> = {
  command: { valueOptions: [] },
  builtin: { valueOptions: [] },
  exec: { valueOptions: ["-a"] },
  nohup: { valueOptions: [] },
  time: { valueOptions: ["-f", "-o", "--format", "--output"] },
  nice: { valueOptions: ["-n", "--adjustment"] },
  timeout: { valueOptions: ["-s", "--signal", "-k", "--kill-after"], positionals: 1 },
  stdbuf: { valueOptions: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: {
    valueOptions: [
      "-I",
      "-i",
      "-n",
      "-P",
      "-L",
      "-l",
      "-s",
      "-d",
      "-E",
      "-e",
      "-a",
      "--max-args",
      "--max-procs",
      "--max-lines",
      "--max-chars",
      "--delimiter",
      "--eof",
      "--arg-file",
      "--replace",
    ],
  },
  watch: { valueOptions: ["-n", "--interval"] },
  ionice: { valueOptions: ["-c", "-n", "-p", "--class", "--classdata", "--pid"] },
  setsid: { valueOptions: [] },
  unbuffer: { valueOptions: [] },
  chronic: { valueOptions: [] },
  caffeinate: { valueOptions: ["-t", "-w"] },
  strace: { valueOptions: ["-o", "-e", "-p", "-s", "-u"] },
  ltrace: { valueOptions: ["-o", "-e", "-p", "-s", "-u"] },
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SQL_DROP = /\bdrop\s+(table|database|schema)\b/i;

/** Lower-cased basename of a command word without Windows executable extensions. */
function commandName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq < 0 ? token : token.slice(0, eq);
}

/** A single-dash option cluster such as `-rf` containing one of `letters`. */
function shortClusterHas(token: string, letters: RegExp): boolean {
  return /^-[A-Za-z]+$/.test(token) && letters.test(token.slice(1));
}

interface GitInvocation {
  sub: string | undefined;
  rest: string[];
  configOverride: boolean;
  globalOptions: boolean;
}

function parseGit(args: string[]): GitInvocation {
  let i = 0;
  let configOverride = false;
  while (i < args.length) {
    const t = args[i] as string;
    if (t === "-c" || t === "--config-env") {
      configOverride = true;
      i += 2;
    } else if ((t.startsWith("-c") && t.length > 2) || t.startsWith("--config-env=")) {
      configOverride = true;
      i++;
    } else if (["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(t)) {
      i += 2;
    } else if (t.startsWith("-")) {
      i++;
    } else {
      break;
    }
  }
  return {
    sub: args[i]?.toLowerCase(),
    rest: args.slice(i + 1),
    configOverride,
    globalOptions: i > 0,
  };
}

function isRecursiveFlag(token: string): boolean {
  return token === "--recursive" || shortClusterHas(token, /[rR]/);
}

/** Deny-list rules for one simple command. Returns a reason when the command is denied. */
function denyRule(name: string, args: Word[], segment: string): string | undefined {
  const a = args.map((w) => w.value);
  const listed = DENY_COMMANDS.get(name);
  if (listed !== undefined) return listed;
  if (name.startsWith("mkfs")) return REASON.system;
  if (SHELLS.has(name)) {
    // Inline code (`-c`), or commands read from standard input (no script, or `-s`).
    const inline = a.some((t) => t === "--command" || shortClusterHas(t, /[cs]/));
    if (inline || !a.some((t) => !t.startsWith("-"))) return REASON.shell;
  }
  if ((PYTHONS.has(name) || JS_RUNTIMES.has(name)) && a.includes("-")) return REASON.shell;
  if (PYTHONS.has(name) && a.some((t) => shortClusterHas(t, /c/))) return REASON.shell;
  if (
    JS_RUNTIMES.has(name) &&
    a.some(
      (t) =>
        ["-e", "-p", "--eval", "--print"].includes(flagName(t)) ||
        (name === "deno" && t === "eval"),
    )
  ) {
    return REASON.shell;
  }
  if ((name === "perl" || name === "ruby") && a.some((t) => shortClusterHas(t, /[eE]/))) {
    return REASON.shell;
  }
  if ((name === "php" && a.includes("-r")) || (name === "osascript" && a.includes("-e"))) {
    return REASON.shell;
  }
  if ((name === "echo" || name === "printf") && segment.includes("$")) return REASON.environment;
  if (name === "dd" && a.some((t) => /^(if|of)=/i.test(t))) return REASON.system;
  if (name === "chmod" && a.some((t) => /^0?777$/.test(t) || /^[ugoa]*\+rwx$/.test(t))) {
    return "making files writable and executable by everyone (chmod 777) is not allowed";
  }
  if (name === "find" && a.some((t) => FIND_DENIED_ACTIONS.has(t))) return REASON.find;

  if (name === "git") {
    const git = parseGit(a);
    if (git.configOverride) return REASON.git;
    const sub = git.sub ?? "";
    if (GIT_DENIED_SUBCOMMANDS.has(sub) || sub.startsWith("credential")) return REASON.git;
    if (sub === "reset" && git.rest.includes("--hard")) return REASON.git;
    if (GIT_WRITE_SUBCOMMANDS.has(sub)) return REASON.gitWrite;
  }

  if (name === "docker" || name === "podman") {
    const [sub, second] = [a[0], a[1]];
    if (["push", "login", "run", "exec", "rm", "rmi"].includes(sub ?? "")) return REASON.docker;
    if (sub === "system" && second === "prune") return REASON.docker;
    if (sub === "volume" && (second === "rm" || second === "prune")) return REASON.docker;
    if (sub === "container" && ["run", "exec", "rm", "prune"].includes(second ?? "")) {
      return REASON.docker;
    }
    if (sub === "image" && ["push", "rm", "prune"].includes(second ?? "")) return REASON.docker;
    if ((sub === "build" || sub === "buildx") && a.some((t) => flagName(t) === "--push")) {
      return REASON.docker;
    }
  }

  if (PACKAGE_MANAGERS.has(name)) {
    const sub = a[0] ?? "";
    if (REGISTRY_SUBCOMMANDS.has(sub)) return REASON.registry;
    if ((name === "pnpm" || name === "yarn") && sub === "dlx") return REASON.packages;
    if (name === "npm" && (sub === "exec" || sub === "x")) return REASON.packages;
    if (name === "bun" && sub === "x") return REASON.packages;
  }
  return undefined;
}

// --- Allow list (edit-repo) ------------------------------------------------------------------

const PM_SUBCOMMANDS = new Set(["install", "ci", "i", "test"]);
const PM_SCRIPTS = new Set(["build", "lint", "test", "typecheck", "check", "format"]);
const PM_BLOCKED_FLAGS = new Set([
  "-g",
  "--global",
  "--location",
  "--prefix",
  "--dir",
  "-C",
  "--cwd",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--script-shell",
  "--node-options",
  "--config",
  "--unsafe-perm",
]);
const PIP_BLOCKED_FLAGS = new Set([
  "-i",
  "--index-url",
  "--extra-index-url",
  "-f",
  "--find-links",
  "-t",
  "--target",
  "--prefix",
  "--root",
  "--user",
  "-e",
  "--editable",
  "--src",
  "--trusted-host",
  "--global-option",
  "--install-option",
]);
const GO_BLOCKED_FLAGS = new Set(["-exec", "--exec", "-toolexec", "--toolexec", "-overlay"]);
const GIT_BLOCKED_FLAGS = new Set(["--output", "--upload-pack", "--receive-pack", "--exec"]);

/**
 * Package-manager options: flags only (no package names). With `passthrough` (test and run
 * scripts), anything after `--` is handed to the script.
 */
function pmFlagsOnly(rest: string[], passthrough: boolean): boolean {
  for (const t of rest) {
    if (t === "--") return passthrough;
    if (!t.startsWith("-")) return false;
    if (PM_BLOCKED_FLAGS.has(flagName(t)) || shortClusterHas(t, /[gC]/)) return false;
  }
  return true;
}

function flagsOnly(rest: string[]): boolean {
  return rest.every((t) => t.startsWith("-"));
}

/** `-r <file>` (at least once) plus harmless flags; no package names or index overrides. */
function requirementsOnly(rest: string[]): boolean {
  let hasRequirements = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] as string;
    if (t === "-r" || t === "--requirement") {
      const file = rest[i + 1];
      if (file === undefined || file.startsWith("-")) return false;
      hasRequirements = true;
      i++;
    } else if (t.startsWith("--requirement=") || (/^-r./.test(t) && !t.startsWith("--"))) {
      hasRequirements = true;
    } else if (
      !t.startsWith("-") ||
      PIP_BLOCKED_FLAGS.has(flagName(t)) ||
      shortClusterHas(t, /[itef]/)
    ) {
      return false;
    }
  }
  return hasRequirements;
}

function gitAllowed(args: string[]): boolean {
  const git = parseGit(args);
  if (git.globalOptions || git.configOverride || git.sub === undefined) return false;
  const rest = git.rest;
  if (rest.some((t) => GIT_BLOCKED_FLAGS.has(flagName(t)))) return false;
  switch (git.sub) {
    case "status":
    case "diff":
    case "log":
    case "show":
    case "rev-parse":
    case "ls-files":
      return true;
    default:
      return false;
  }
}

/**
 * Commands that execute code from the repository (package scripts, install hooks, Dockerfiles,
 * build files, tests). An agent with edit rights could have changed that code, so these always
 * need a human decision (ask) and are never pre-approved.
 */
const PROJECT_CODE_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "docker",
  "podman",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "pipenv",
  "go",
  "make",
  "cargo",
  "gradle",
  "mvn",
  "dotnet",
  "composer",
  "bundle",
  "rake",
  "deno",
  "pytest",
  "tox",
  "nox",
  "just",
]);

function isAllowListed(name: string, args: string[]): boolean {
  const [first, second] = [args[0], args[1]];
  switch (name) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (PM_SUBCOMMANDS.has(first ?? "")) return pmFlagsOnly(args.slice(1), first === "test");
      if (first === "run" && PM_SCRIPTS.has(second ?? "")) return pmFlagsOnly(args.slice(2), true);
      return false;
    case "node":
      return args.length === 1 && (first === "--version" || first === "-v");
    case "git":
      return gitAllowed(args);
    case "ls":
    case "pwd":
    case "cat":
    case "head":
    case "tail":
    case "wc":
    case "find":
      return true;
    case "tree":
      return !args.some((t) => t === "-o");
    case "grep":
      return !args.some(
        (t, i) =>
          isRecursiveFlag(t) ||
          t === "--dereference-recursive" ||
          t === "--directories=recurse" ||
          (t === "-d" && args[i + 1] === "recurse"),
      );
    case "docker":
      return (
        first === "build" &&
        !args.some((t) => t === "-o" || flagName(t) === "--output" || flagName(t) === "--push")
      );
    case "python":
    case "python3":
      if (first !== "-m") return false;
      if (second === "pytest") return true;
      return second === "pip" && args[2] === "install" && requirementsOnly(args.slice(3));
    case "pip":
    case "pip3":
      return first === "install" && requirementsOnly(args.slice(1));
    case "uv":
      if (first === "sync") return flagsOnly(args.slice(1));
      return first === "pip" && second === "install" && requirementsOnly(args.slice(2));
    case "poetry":
      return first === "install" && flagsOnly(args.slice(1));
    case "mkdir":
      return first === "-p" && args.length > 1 && args.slice(1).every((t) => !t.startsWith("-"));
    case "go":
      if (first === "build" || first === "test") {
        return !args.some((t) => GO_BLOCKED_FLAGS.has(flagName(t)));
      }
      return first === "mod" && second === "tidy" && flagsOnly(args.slice(2));
    default:
      return false;
  }
}

// --- Segment evaluation ----------------------------------------------------------------------

/** Values inside a word that might name a file: the word and its `=`, `:` and `,` pieces. */
function secretCandidates(value: string): string[] {
  const alternatives = expandBraces(value) ?? [value];
  const out: string[] = [];
  for (const alternative of alternatives) {
    out.push(alternative, ...alternative.split(/[=:,]/));
  }
  return out;
}

/** The part of an argument that is a path, if any (`--file=x` → `x`, `-C/dir` → `/dir`). */
function pathPart(value: string): string | undefined {
  if (!value.startsWith("-") || value === "-") return value;
  const eq = value.indexOf("=");
  if (eq >= 0) return value.slice(eq + 1);
  if (!value.startsWith("--") && value.length > 2) {
    const attached = value.slice(2);
    if (/[\\/~]|^\./.test(attached)) return attached;
  }
  return undefined;
}

function wordResolution(ctx: PathContext, word: Word, raw: string): Resolution {
  if (word.dynamic) return { status: "unknown", why: "uses a variable" };
  if (word.tilde) return { status: "unknown", why: "is relative to a home directory" };
  return resolvePath(ctx, raw);
}

/** A write target: denied unless it resolves to an unprotected location inside the root. */
function writeVerdict(ctx: PathContext, word: Word, raw: string, what: string): Verdict {
  const location = wordResolution(ctx, word, raw);
  if (location.status === "unknown") {
    return { kind: "deny", reason: `${what} \`${raw}\` cannot be verified (it ${location.why}).` };
  }
  if (location.status === "outside") {
    return { kind: "deny", reason: `${what} \`${raw}\` is outside the project root.` };
  }
  const protectedReason = protectedWriteReason(location.rel);
  if (protectedReason !== undefined) {
    return { kind: "deny", reason: `${what} \`${raw}\` is protected: ${protectedReason}.` };
  }
  return { kind: "allow" };
}

function redirectVerdict(ctx: PathContext, redirect: Redirect): Verdict {
  const { op, target } = redirect;
  const value = target.value;
  if ((op === ">&" || op === "<&") && /^(\d+|-)$/.test(value)) return { kind: "allow" };
  if (value === "/dev/null" && !target.dynamic) return { kind: "allow" };
  if (op === "<" || op === "<&") {
    const location = wordResolution(ctx, target, value);
    if (location.status !== "inside") {
      return { kind: "ask", reason: `it reads \`${value}\`, which is outside the project root` };
    }
    return { kind: "allow" };
  }
  if (target.glob || target.brace) {
    return { kind: "deny", reason: `The redirection target \`${value}\` cannot be verified.` };
  }
  return writeVerdict(ctx, target, value, "The redirection target");
}

function rmVerdict(ctx: PathContext, args: Word[]): Verdict | undefined {
  if (!args.some((w) => isRecursiveFlag(w.value))) return undefined;
  for (const word of args) {
    if (word.value.startsWith("-") && word.value !== "-") continue;
    if (word.glob || word.brace || word.dynamic || word.tilde) {
      return { kind: "deny", reason: `Blocked \`rm\`: ${REASON.delete}.` };
    }
    const location = resolvePath(ctx, word.value);
    if (location.status !== "inside" || location.rel === "") {
      return { kind: "deny", reason: `Blocked \`rm\`: ${REASON.delete}.` };
    }
  }
  return undefined;
}

function evaluateSegment(segment: string, ctx: PathContext): Verdict {
  const parsed = parseSegment(segment);
  if (parsed.error !== undefined) {
    return {
      kind: "deny",
      reason: `The command \`${segment}\` cannot be parsed: ${parsed.error}.`,
    };
  }
  const { words, redirects } = parsed;

  // Secret references anywhere in the segment.
  for (const word of [...words, ...redirects.map((r) => r.target)]) {
    const hit = secretCandidates(word.value).find((candidate) => isSecretPath(candidate));
    if (hit !== undefined) {
      return {
        kind: "deny",
        reason: `The command references \`${word.value}\`, which may contain secrets.`,
      };
    }
  }

  // Redirections.
  let pending: Verdict | undefined;
  for (const redirect of redirects) {
    const verdict = redirectVerdict(ctx, redirect);
    if (verdict.kind === "deny") return verdict;
    if (verdict.kind === "ask") pending ??= verdict;
  }

  // Strip keywords, assignments and wrappers to find the command that really runs.
  let index = 0;
  let wrapped = false;
  while (index < words.length) {
    const word = words[index] as Word;
    if (!word.quoted && SHELL_KEYWORDS.has(word.value)) {
      index++;
      wrapped = true;
      continue;
    }
    if (ASSIGNMENT.test(word.value)) {
      index++;
      wrapped = true;
      continue;
    }
    const wrapper = word.dynamic ? undefined : WRAPPERS[commandName(word.value)];
    if (wrapper === undefined) break;
    wrapped = true;
    index++;
    while (index < words.length) {
      const option = (words[index] as Word).value;
      if (option === "--") {
        index++;
        break;
      }
      if (!option.startsWith("-") || option === "-") break;
      index += wrapper.valueOptions.includes(option) ? 2 : 1;
    }
    index += wrapper.positionals ?? 0;
  }

  const commandWord = words[index];
  if (commandWord === undefined) {
    return pending ?? { kind: "ask", reason: `\`${segment}\` is not a plain command` };
  }
  const isTestBracket = commandWord.value === "[" || commandWord.value === "[[";
  if (
    commandWord.dynamic ||
    commandWord.brace ||
    (commandWord.glob && !isTestBracket) ||
    commandWord.value === ""
  ) {
    return {
      kind: "deny",
      reason: `The command name \`${commandWord.value}\` is computed at run time, so it cannot be checked.`,
    };
  }
  const name = commandName(commandWord.value);
  const args = words.slice(index + 1);

  const denied = denyRule(name, args, segment);
  if (denied !== undefined) return { kind: "deny", reason: `Blocked \`${name}\`: ${denied}.` };

  if (name === "rm") {
    const verdict = rmVerdict(ctx, args);
    if (verdict !== undefined) return verdict;
  }
  if (WRITE_COMMANDS.has(name) || (name === "sed" && args.some((w) => /^-[a-z]*i/.test(w.value)))) {
    for (const word of args) {
      const part = pathPart(word.value);
      if (part === undefined || part === "" || /^\d+$/.test(part)) continue;
      if (name === "chmod" && /^[ugoa]*[+=-][rwxXst]*$|^\d{3,4}$/.test(part)) continue;
      const verdict = writeVerdict(ctx, word, part, `\`${name}\` target`);
      if (verdict.kind === "deny") return verdict;
    }
  }

  // Allow list.
  if (wrapped) {
    return {
      kind: "ask",
      reason: `\`${segment}\` uses a shell keyword, variable assignment or command wrapper`,
    };
  }
  if (PROJECT_CODE_RUNNERS.has(name)) {
    return {
      kind: "ask",
      reason: `\`${segment}\` runs code from the project (package scripts, install hooks or a Dockerfile), which an agent could have edited`,
    };
  }
  if (
    !isAllowListed(
      name,
      args.map((w) => w.value),
    )
  ) {
    return { kind: "ask", reason: `\`${segment}\` is not on the list of pre-approved commands` };
  }
  if (pending !== undefined) return pending;
  for (const word of args) {
    if (word.dynamic) return { kind: "ask", reason: `\`${segment}\` uses a variable` };
    if (word.brace) return { kind: "ask", reason: `\`${segment}\` uses brace expansion` };
    if (word.glob && globRisk(word.value, true).mayMatchSecret) {
      return { kind: "ask", reason: `the wildcard \`${word.value}\` could match secret files` };
    }
    const part = pathPart(word.value);
    if (part === undefined) continue;
    if (ctx.win && name !== "git" && WIN_SHORT_NAME.test(part)) {
      return { kind: "ask", reason: `\`${part}\` may be a Windows short file name` };
    }
    const location = wordResolution(ctx, word, part);
    if (location.status !== "inside") {
      return {
        kind: "ask",
        reason: `\`${segment}\` refers to \`${part}\` outside the project root`,
      };
    }
  }
  return { kind: "allow" };
}

function evaluateBash(command: unknown, ctx: PathContext): ToolDecision {
  if (typeof command !== "string" || command.trim() === "") {
    return deny("Bash was called without a command.");
  }
  if (command.includes("\0")) return deny("The command contains a NUL byte.");
  if (command.includes("$(") || command.includes("`")) {
    return deny("Command substitution (`$(...)` or backticks) is not allowed.");
  }
  if (command.includes("<(") || command.includes(">(")) {
    return deny("Process substitution (`<(...)`, `>(...)`) is not allowed.");
  }
  if (command.includes("<<")) return deny("Here-documents and here-strings are not allowed.");
  if (/\/dev\/(tcp|udp)\//i.test(command)) {
    return deny("Redirecting to network sockets (/dev/tcp, /dev/udp) is not allowed.");
  }
  if (SQL_DROP.test(command)) return deny(`Blocked: ${REASON.database}.`);

  const lexed = lexCommand(command);
  if (lexed.error !== undefined) {
    return deny(`The command cannot be parsed safely: ${lexed.error}.`);
  }
  if (lexed.segments.length === 0) return deny("Bash was called without a command.");

  let ask: string | undefined;
  for (const segment of lexed.segments) {
    const verdict = evaluateSegment(segment, ctx);
    if (verdict.kind === "deny") return deny(verdict.reason);
    if (verdict.kind === "ask") ask ??= verdict.reason;
  }
  if (ask !== undefined) return { decision: "ask", reason: `Needs approval: ${ask}.` };
  if (lexed.grouping) {
    return { decision: "ask", reason: "Needs approval: the command uses sub-shells or groups." };
  }
  return { decision: "allow" };
}

// =============================================================================================
// File tools
// =============================================================================================

type FileMode = "read" | "write";

function evaluateFilePath(ctx: PathContext, raw: unknown, mode: FileMode, field: string) {
  if (typeof raw !== "string" || raw === "") {
    return deny(`The \`${field}\` argument is missing or not a string.`);
  }
  if (ctx.win) {
    const afterDrive = raw.replace(/^[a-zA-Z]:/, "");
    if (afterDrive.includes(":")) {
      return deny(`\`${raw}\` uses an NTFS alternate data stream, which is not allowed.`);
    }
    if (raw.split(/[\\/]+/).some((segment) => WIN_SHORT_NAME.test(segment))) {
      return deny(`\`${raw}\` looks like a Windows short file name, which is not allowed.`);
    }
  }
  const location = resolvePath(ctx, raw);
  if (location.status === "unknown")
    return deny(`\`${raw}\` ${location.why}, which is not allowed.`);
  if (location.status === "outside") return deny(`\`${raw}\` is outside the project root.`);
  if (isSecretPath(location.rel)) {
    return deny(`\`${raw}\` may contain secrets, so agents cannot access it.`);
  }
  if (mode === "write") {
    if (location.rel === "") return deny("Agents cannot write the project root itself.");
    const reason = protectedWriteReason(location.rel);
    if (reason !== undefined) return deny(`\`${raw}\` is protected: ${reason}.`);
  }
  return undefined;
}

/** Glob patterns must stay inside the root; `secrets` additionally denies secret-targeting globs. */
function evaluatePattern(ctx: PathContext, pattern: string, field: string, secrets: boolean) {
  const alternatives = expandBraces(pattern);
  if (alternatives === undefined) return deny(`The \`${field}\` pattern is too complex to check.`);
  for (const alternative of alternatives) {
    const escapes =
      alternative.startsWith("~") ||
      ctx.api.isAbsolute(alternative) ||
      (ctx.win && (WIN_DRIVE_RELATIVE.test(alternative) || alternative.includes(":"))) ||
      alternative.split(/[\\/]+/).includes("..");
    if (escapes)
      return deny(`The \`${field}\` pattern \`${pattern}\` reaches outside the project root.`);
  }
  if (secrets && globRisk(pattern, false).targetsSecret) {
    return deny(`The \`${field}\` pattern \`${pattern}\` targets files that may contain secrets.`);
  }
  return undefined;
}

function evaluateFileTool(tool: string, input: Record<string, unknown>, ctx: PathContext) {
  switch (tool) {
    case "Read":
      return evaluateFilePath(ctx, input.file_path, "read", "file_path") ?? allow();
    case "Edit":
    case "MultiEdit":
    case "Write":
      return evaluateFilePath(ctx, input.file_path, "write", "file_path") ?? allow();
    case "Glob": {
      if (typeof input.pattern !== "string" || input.pattern === "") {
        return deny("The `pattern` argument is missing or not a string.");
      }
      const pathDecision =
        input.path === undefined ? undefined : evaluateFilePath(ctx, input.path, "read", "path");
      return pathDecision ?? evaluatePattern(ctx, input.pattern, "pattern", false) ?? allow();
    }
    case "Grep": {
      const pathDecision =
        input.path === undefined ? undefined : evaluateFilePath(ctx, input.path, "read", "path");
      if (pathDecision !== undefined) return pathDecision;
      if (input.glob === undefined) return allow();
      if (typeof input.glob !== "string") return deny("The `glob` argument is not a string.");
      return evaluatePattern(ctx, input.glob, "glob", true) ?? allow();
    }
    default:
      return deny(`Unknown tool \`${tool}\` is not allowed.`);
  }
}

// =============================================================================================
// Policy
// =============================================================================================

function allow(): ToolDecision {
  return { decision: "allow" };
}

function deny(reason: string): ToolDecision {
  return { decision: "deny", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DefaultToolPolicyOptions {
  /** Name of OpsCrew's in-process MCP server; its tools (`mcp__<name>__*`) are allowed. */
  mcpServerName?: string;
  /** Platform whose path rules apply. Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform;
}

/**
 * The default OpsCrew tool policy. Decides, in order: OpsCrew MCP tools (allow; other MCP
 * servers deny), `TodoWrite` (allow), never-allowed and unknown tools (deny), profile membership,
 * file-path rules for `Read`/`Edit`/`MultiEdit`/`Write`/`Glob`/`Grep`, and Bash command rules
 * (deny list, allow list, otherwise `ask`). Any internal error denies the call.
 */
export class DefaultToolPolicy implements ToolPolicy {
  readonly #mcpPrefix: string;
  readonly #win: boolean;

  constructor(options: DefaultToolPolicyOptions = {}) {
    this.#mcpPrefix = `mcp__${options.mcpServerName ?? "opscrew"}__`;
    this.#win = (options.platform ?? process.platform) === "win32";
  }

  evaluate(call: ToolCall): ToolDecision {
    try {
      return this.#evaluate(call);
    } catch {
      return deny("The tool policy could not evaluate this call, so it was denied.");
    }
  }

  #evaluate(call: ToolCall): ToolDecision {
    const tool = call.tool;
    if (typeof tool !== "string" || tool === "") return deny("The tool name is missing.");

    if (tool.startsWith("mcp__")) {
      return tool.startsWith(this.#mcpPrefix) && tool.length > this.#mcpPrefix.length
        ? allow()
        : deny(`\`${tool}\` is not an OpsCrew tool; other MCP servers are not available.`);
    }
    if (tool === "TodoWrite") return allow();
    const never = Object.hasOwn(ALWAYS_DENIED, tool) ? ALWAYS_DENIED[tool] : undefined;
    if (never !== undefined) return deny(never);

    const builtin = tool === "MultiEdit" ? "Edit" : tool;
    if (!KNOWN_BUILTINS.has(builtin)) return deny(`Unknown tool \`${tool}\` is not allowed.`);

    const profile = call.profile;
    const tools = Object.hasOwn(PROFILE_TOOLS, profile) ? PROFILE_TOOLS[profile] : undefined;
    if (tools === undefined) return deny(`Unknown tool profile \`${String(profile)}\`.`);
    if (!tools.includes(builtin as BuiltinTool)) {
      return deny(`${tool} is not allowed in the ${profile} profile.`);
    }

    const ctx = makePathContext(call.projectRoot, this.#win);
    if (ctx === undefined) return deny("The project root is not an absolute path.");
    const input = isRecord(call.input) ? call.input : {};

    if (tool === "Bash") return evaluateBash(input.command, ctx);
    return evaluateFileTool(tool, input, ctx);
  }
}
