// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, not JavaScript templates.
import { BASELINE_HEADERS, HSTS, shellQuote } from "../runtime/services";

// What the hosting agent (`agent/script.ts`) and the SFTP deploy job (`sftp-workflow.ts`) share:
// bash functions, the health check after a switch, and the static lines of OpsCrew's `.htaccess`
// and `.user.ini` blocks. Each bash text is as bash reads it: `String.raw` where it has a
// backslash, a template with `\${` where bash has `${`.

/** How many releases a hosting account or an SFTP-only host keeps besides the running one. */
export const HOSTING_KEEP = 3;

/** `one_line`: $1 on one line. */
export const ONE_LINE = String.raw`# $1 on one line: carriage returns and newlines become spaces.
one_line() {
  printf '%s' "$1" | tr '\r\n' '  '
}`;

/** `newest_first`: the release ids among the names on its standard input, newest first. */
export const NEWEST_FIRST = `# The names on standard input that are a release's id, <run id>-<attempt>, newest first: by run
# id, then attempt.
newest_first() {
  grep -E '^[1-9][0-9]*-[1-9][0-9]*$' | sort -t - -k 1,1nr -k 2,2nr || true
}`;

/** `newer`: whether one release is newer than another. */
export const NEWER = `# True when release $1 is newer than release $2; any release is newer than none.
newer() {
  [ -n "$2" ] || return 0
  local r1=\${1%-*} a1=\${1#*-} r2=\${2%-*} a2=\${2#*-}
  ((10#$r1 > 10#$r2 || (10#$r1 == 10#$r2 && 10#$a1 > 10#$a2)))
}`;

/** `status_lines`: `state/status`'s lines, as the opscrew CLI reads them. Needs `newer` and `one_line`. */
export const STATUS_LINES = `# The lines of state/status, as the opscrew CLI reads them: the running release $1 (empty before
# the first), the newest release kept that is older than it (rollback's default), the others kept,
# and the last attempt: its release $2, its result $3 (deployed, refused or failed), its reason $4
# and its time $5 (UTC). The releases there follow, newest first.
status_lines() {
  local running=$1 attempt=$2 result=$3 reason=$4 at=$5 previous="" kept="" id
  shift 5
  for id in "$@"; do
    [ "$id" != "$running" ] || continue
    kept=\${kept:+$kept,}$id
    if [ -z "$previous" ] && [ -n "$running" ] && newer "$running" "$id"; then previous=$id; fi
  done
  printf 'running=%s\\nprevious=%s\\nkept=%s\\nattempt=%s\\nresult=%s\\nreason=%s\\nat=%s\\n' \\
    "$running" "$previous" "$kept" "$attempt" "$result" "$(one_line "$reason")" "$at"
}`;

/** `header_of`: a header's value in an answer's status line and headers. */
export const HEADER_OF = String.raw`# The value of header $2 in the answer $1, without its carriage return.
header_of() {
  printf '%s\n' "$1" | tr -d '\r' | sed -n "s/^$2:[[:space:]]*//Ip" | tail -n 1
}`;

/**
 * `health_check`, the check after a switch: `url` (a bash word) asked until it answers 2xx or 3xx
 * with release $1, as the comment in it says. `php` is whether the app is a PHP app: `true`,
 * `false`, or a bash test of it. Needs `one_line` and `header_of`.
 */
export function healthCheck(url: string, php: boolean | string): string {
  const counts =
    php === false
      ? ["return 0"]
      : [
          ...(php === true ? [] : [`if ! ${php}; then return 0; fi`]),
          'case $(header_of "$answer" Server) in LiteSpeed*) return 0 ;; esac',
          'if [ "$try" -ge 27 ]; then return 0; fi',
        ];
  return [
    "# Asks the health path every 5 seconds, for up to 135 seconds, until it answers 2xx or 3xx with",
    "# release $1. The first such answer counts for any app but a PHP app, and for a PHP app behind",
    "# LiteSpeed, whose restart makes every PHP process follow at once; elsewhere a PHP app's counts",
    "# only from try 27, 130 seconds after the switch, as PHP may run the release before until its",
    "# path cache expires (120 s, with opcache.revalidate_path on; research R16). CHECK_SAID holds the",
    "# last answer.",
    "health_check() {",
    "  local try answer code served",
    '  CHECK_SAID="no answer"',
    "  for ((try = 1; try <= 28; try++)); do",
    '    if [ "$try" -gt 1 ]; then sleep 5; fi',
    `    if answer=$(curl -sS -o /dev/null -D - --max-time 30 ${url} 2>&1); then`,
    "      code=$(printf '%s\\n' \"$answer\" | head -n 1 | cut -d ' ' -f 2)",
    '      served=$(header_of "$answer" X-OpsCrew-Release)',
    '      CHECK_SAID="it answered $code with release ${served:-none}"',
    '      if [[ $code =~ ^[23][0-9][0-9]$ ]] && [ "$served" = "$1" ]; then',
    ...counts.map((line) => `        ${line}`),
    "      fi",
    "    else",
    '      CHECK_SAID=$(one_line "$answer")',
    "    fi",
    "  done",
    "  return 1",
    "}",
  ].join("\n");
}

/** `printf '%s\n'` of each line, shell-quoted. */
export function printLines(lines: readonly string[]): string {
  return `printf '%s\\n' ${lines.map(shellQuote).join(" ")}`;
}

/** OpsCrew's `.htaccess` line where the web root is the release itself: the app's packages and storage refused. */
export const PACKAGES_REFUSED = String.raw`RewriteRule ^(vendor|storage|composer\.json|composer\.lock)(/|$) - [F]`;

/** OpsCrew's `.htaccess` lines after its rewrites: no listings, dotfiles refused, the security headers (FR-1442's). */
export const HTACCESS_RULES: readonly string[] = [
  "Options -Indexes",
  '<FilesMatch "^\\.">',
  "Require all denied",
  "</FilesMatch>",
  ...BASELINE_HEADERS.map(([name, value]) => `Header always set ${name} "${value}"`),
];

/** OpsCrew's `.htaccess` line once the hostname's certificate verifies. */
export const HSTS_LINE = `Header always set Strict-Transport-Security "${HSTS}"`;

/** The modules a PHP app's settings are set in, each in its own `<IfModule>` of OpsCrew's `.htaccess` block. */
export const PHP_MODULES: readonly string[] = ["LiteSpeed", "lsapi_module", "php_module"];

/**
 * `opcache.revalidate_path` on, in `.htaccess` and in `.user.ini`: a switch then reaches each PHP
 * process once its path cache expires (research R16).
 */
export const REVALIDATE_PATH = {
  htaccess: "php_flag opcache.revalidate_path on",
  userIni: "opcache.revalidate_path = 1",
} as const;

/** A `.htaccess` line that rewrites, comments aside (`grep -iE`). */
export const REWRITE_RULE = "^[[:space:]]*RewriteRule([[:space:]]|$)";

/** A PHP app's routing where its `.htaccess` has none, as a server's php_fastcgi (research R13). */
export const FALLBACK: readonly string[] = [
  "RewriteCond %{REQUEST_FILENAME} !-f",
  "RewriteCond %{REQUEST_FILENAME} !-d",
  "RewriteRule ^ index.php [L]",
];
