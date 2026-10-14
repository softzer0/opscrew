/**
 * Shell helpers: every remote command is a fixed script template whose parameters are assigned,
 * shell-quoted, at the top. No command text ever comes from a model or from the server's output.
 */

import { MAX_SCRIPT_BYTES } from "./constants";

/** How the admin login becomes root: it is root, or it uses passwordless `sudo -n`. */
export type Privilege = "root" | "sudo";

/** Quotes `value` for a POSIX shell (single quotes; embedded quotes become `'\''`). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const PREAMBLE = [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "LC_ALL=C",
  "LANG=C",
  "DEBIAN_FRONTEND=noninteractive",
  "export PATH LC_ALL LANG DEBIAN_FRONTEND",
  "umask 022",
];

/** First line of every OpsCrew host script: `# opscrew-host: <name>`. */
export const SCRIPT_HEADER = "# opscrew-host:";

export type ScriptParams = Readonly<Record<string, string | number | boolean>>;

const PARAM_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Builds a host script: header, `set -eu` (or `set -u` for read-only scripts that must survive
 * failing probes), a fixed environment, the quoted parameters, then the fixed body.
 */
export function buildScript(
  name: string,
  params: ScriptParams,
  body: string,
  options: { tolerant?: boolean } = {},
): string {
  const lines = [`${SCRIPT_HEADER} ${name}`, options.tolerant ? "set -u" : "set -eu", ...PREAMBLE];
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM_NAME_RE.test(key)) throw new Error(`Invalid script parameter name: ${key}`);
    if (typeof value === "string" && /[\0\r\n]/.test(value)) {
      throw new Error(`Script parameter ${key} must be a single line`);
    }
    lines.push(`${key}=${shellQuote(String(value))}`);
  }
  lines.push(body.trim(), "");
  const script = lines.join("\n");
  if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) {
    throw new Error(`Host script ${name} is too large to send as one command`);
  }
  return script;
}

/** The command that runs `script` as root through the admin login's shell. */
export function asRoot(privilege: Privilege, script: string): string {
  const inner = `sh -c ${shellQuote(script)}`;
  return privilege === "root" ? inner : `sudo -n ${inner}`;
}

/** Runs `script` as the admin login itself (no privilege change). */
export function asLogin(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

/** Shell lines shared by scripts that install packages: apt waits for other apt runs. */
export const APT_FUNCTIONS = `apt_get() {
  apt-get -q -y -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}
is_installed() {
  dpkg-query -W -f='\${Status}' "$1" 2>/dev/null | grep -q ' installed$'
}
fail() {
  printf 'opscrew: %s\\n' "$1" >&2
  exit "\${2:-3}"
}`;
