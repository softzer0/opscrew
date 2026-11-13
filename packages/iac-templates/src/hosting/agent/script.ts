import { BASELINE_HEADERS, HSTS } from "../../runtime/services";

/** The security headers of OpsCrew's `.htaccess` block (FR-1442's), as `printf` arguments. */
const HEADER_LINES = BASELINE_HEADERS.map(
  ([name, value]) => `'Header always set ${name} "${value}"'`,
).join(" ");

/**
 * The agent (027 plan 3, ADR 0030): a bash script, the same for every app, that cron runs every
 * minute as a hosting account's user from `~/opscrew/<app>-<env>/agent.sh`, its output appended to
 * `state/agent.log` (kept to 1,000 lines). It reads `settings.sh` beside it (`renderAgentSettings`)
 * and runs under `flock -n state/lock`. The files it writes are key=value lines the CLI validates:
 * - `state/report`, on the first run, beside its new read-only GitHub key `keys/github`:
 *   `public_key` (empty without `ssh-keygen`); for each PHP CLI found (the account's, alt-php,
 *   MultiPHP, Plesk's and DirectAdmin's), `php.<n>.path`, `php.<n>.version` (`-v`'s first line)
 *   and `php.<n>.modules` (`-m`, comma-separated); then `yes` or `no` for
 *   `tool.<git|openssl|flock|mysqldump|tar|curl|ssh|ssh-keygen>`, `github.22` and `github.443`.
 * - `state/status`: `running` (a release's id, `<run id>-<attempt>`; empty before the first),
 *   `previous` (the newest kept release older than the running one), `kept` (the others kept,
 *   comma-separated, newest first), and the last attempt: `attempt`, `result` (`deployed`,
 *   `refused` or `failed`), `reason` and `at` (UTC).
 * - `state/<sha256>.result` for each request: `result` (`done`, `refused` or `failed`), `reason`,
 *   then for a snapshot `dump=<file in dumps/>` and `shared=<file in dumps/>` (each when it has
 *   that part), for a restore `saved=<the id of the snapshot taken first>` (when there was anything
 *   to copy).
 * - A snapshot `<id>` (`snapshot-<UTC time>`), taken on a `snapshot` request and before a
 *   `restore`: the app's database, when it has one, dumped into `dumps/<id>.sql.gz` and, when
 *   `shared/` holds more than the settings files (`.env`, `.env.next`, `env.php`, `mysql.cnf`),
 *   those others in `dumps/<id>.shared.tar.gz`. A restore of `<id>` puts back the parts it holds
 *   (a release's dump `dumps/<release>.sql.gz` is one too), and leaves the settings files as they
 *   are.
 *
 * A request is `requests/<SHA-256 of its bytes>.req`, at most 4 KB of `key=value` lines whose
 * values hold letters, digits, `.`, `_` and `-` only: `kind`, `hash` (the approved plan's) and
 * `expires` (UTC epoch seconds), then by kind `release` and `restore` (`yes` or `no`) for
 * `rollback`, `snapshot` (a snapshot's id) for `restore`, `action` (`create` or `destroy`) for
 * `app`, nothing more for `env` and `snapshot`.
 *
 * A Node.js or Python app (027 plan 8) runs through CloudLinux's selector, its app root the link
 * `current` (`opscrew/<app>-<env>/current` from the home folder), served at the hostname's root
 * from the release's `public/` (made when the release has none), so its source is never under the
 * document root. An `app` request with `action=create` makes it with the settings' version and
 * startup file, then hands the selector the values of `shared/.env` (`set --env-vars`), as an
 * `env` request does again; the file is linked into each release too. The header of the section
 * the selector added to `~/.cl.selector/htaccess_cache` is kept in
 * `state/selector-section` (empty when none, or more than one, was added). Each release carries the
 * selector's `node_modules` link, and its `.htaccess` the selector's Passenger block; when its
 * package files differ from the running release's, the selector installs them into the app's one
 * environment before the switch (an answer that the install was performed but the selector's own
 * check of the app failed is a note: the agent's health check decides); then `tmp/restart.txt`. `action=destroy` runs the selector's
 * `destroy`, removes the empty `~/nodevenv/<app root>` (`~/virtualenv/` for Python) and the section
 * of `htaccess_cache` whose header it kept, every other byte as it was; a `note=` in its answer
 * says what it left and why.
 *
 * A release is the newest commit of the release branch with one line `OpsCrew-Release: <run
 * id> <attempt> <env> <signature>`, the signature `openssl dgst -sha256 -sign`'s (ECDSA P-256, DER,
 * base64 on one line) over `<tree id> <run id> <attempt> <env>`, checked with `keys/release.pub`.
 * Its `.htaccess` sends `X-OpsCrew-Release: <run id>-<attempt>`. A request's answer is written
 * `failed` before it starts, so one a run stopped in is never carried out again.
 */
export const AGENT_SH = `#!/bin/bash
# OpsCrew's agent on a hosting account (ADR 0030), the same for every app and environment. Cron
# runs it every minute as the account's user, from the app's folder ~/opscrew/<app>-<env>/, with
# its output appended to state/agent.log. It reads settings.sh beside it (quoted values OpsCrew
# rendered, no secret), deploys the releases GitHub Actions publishes on its release branch
# (opscrew/release/<env>, or opscrew/release/<key>-<env> for a further app), signed with the
# deploy environment's key, and carries out the one-time requests the opscrew CLI writes into
# requests/. Nothing from a release, the panel or a request is ever run as shell code. Only
# definitions come before the last line, which runs main and exits, so a new copy written during a
# run can't change the run.
set -eu
set -o pipefail

# A line in the log, after the time in UTC.
say() {
  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# Stops the run with a message.
fail() {
  say "$1"
  exit 1
}

# $1 on one line: carriage returns and newlines become spaces.
line_of() {
  printf '%s' "$1" | tr '\\r\\n' '  '
}

# Writes standard input to the file $1 through a temporary file beside it, renamed over it.
put() {
  cat > "$1.partial"
  mv -f "$1.partial" "$1"
}

# File $1, ending with a newline; nothing when it is empty or missing.
lines_of() {
  [ -s "$1" ] || return 0
  cat "$1"
  [ -z "$(tail -c 1 "$1")" ] || printf '\\n'
}

# The value of key $2 in the key=value file $1; empty when the file or the key is missing.
value_of() {
  [ ! -f "$1" ] || sed -n "s/^$2=//p" "$1"
}

# Keeps state/agent.log to its last 1,000 lines. The file is rewritten in place, so cron's
# descriptor, which appends, keeps writing into it.
trim_log() {
  local log=state/agent.log
  [ -f "$log" ] || return 0
  [ "$(wc -l < "$log")" -gt 1000 ] || return 0
  tail -n 1000 "$log" > "$log.trim"
  cat "$log.trim" > "$log"
  rm -f "$log.trim"
}

# The app's PHP: the CLI the plan chose (cron's PATH finds the account's own), with the app's
# settings loaded for a plain PHP app. The release command reaches it as php.
php() {
  if [ -f "$DIR/shared/env.php" ]; then
    "$PHP_CLI" -d "auto_prepend_file=$DIR/shared/env.php" "$@"
  else
    "$PHP_CLI" "$@"
  fi
}

# yes when GitHub answers over SSH as $1 on port $2 ("Permission denied (publickey)" before the
# deploy key is added counts), no otherwise.
reach() {
  local said
  said=$(timeout 60 "\${SSH[@]}" -p "$2" -T "$1" 2>&1 < /dev/null) || true
  case $said in
    *"Permission denied (publickey)"* | *"successfully authenticated"*) printf yes ;;
    *) printf no ;;
  esac
}

# The first run: the agent's own read-only GitHub key, then state/report (key=value) with its
# public half, each PHP CLI on the account (its -v's first line and its -m's modules: the
# account's, CloudLinux's alt-php, cPanel's MultiPHP, Plesk's and DirectAdmin's versions), the
# tools it finds, and whether GitHub answers over SSH on 22 and on ssh.github.com:443. Where a
# panel runs cron jobs chrooted and a tool is missing, the report still says so.
first_run() {
  local bin n=0 tool
  if [ ! -f keys/github ] && command -v ssh-keygen > /dev/null; then
    ssh-keygen -q -t ed25519 -N '' -C "opscrew-$APP-$ENVIRONMENT" -f keys/github
  fi
  {
    printf 'public_key=%s\\n' "$(cat keys/github.pub 2> /dev/null)"
    for bin in /usr/local/bin/php /opt/alt/php*/usr/bin/php /opt/cpanel/ea-php*/root/usr/bin/php \\
      /opt/plesk/php/*/bin/php /usr/local/php*/bin/php; do
      [ -x "$bin" ] || continue
      n=$((n + 1))
      printf 'php.%s.path=%s\\n' "$n" "$bin"
      printf 'php.%s.version=%s\\n' "$n" "$(line_of "$("$bin" -v 2>&1 | head -n 1)")"
      printf 'php.%s.modules=%s\\n' "$n" "$("$bin" -m 2>/dev/null | tr -d '\\r' | grep -v -e '^\\[' -e '^$' | paste -s -d , -)"
    done
    for tool in git openssl flock mysqldump tar curl ssh ssh-keygen; do
      if command -v "$tool" > /dev/null; then printf 'tool.%s=yes\\n' "$tool"; else printf 'tool.%s=no\\n' "$tool"; fi
    done
    printf 'github.22=%s\\n' "$(reach git@github.com 22)"
    printf 'github.443=%s\\n' "$(reach git@ssh.github.com 443)"
  } | put state/report
  say "First run: the deploy key is made and state/report written."
}

# The running release's id, from the link current; empty without one.
running_id() {
  local target
  target=$(readlink current 2> /dev/null) || return 0
  case $target in releases/*) printf '%s' "\${target#releases/}" ;; esac
}

# The releases kept, newest first: <run id>-<attempt> folders, by run id then attempt.
releases_newest_first() {
  ls releases | grep -E '^[1-9][0-9]*-[1-9][0-9]*$' | sort -t - -k 1,1nr -k 2,2nr || true
}

# True when release $1 is newer than release $2; any release is newer than none.
newer() {
  [ -n "$2" ] || return 0
  local r1=\${1%-*} a1=\${1#*-} r2=\${2%-*} a2=\${2#*-}
  ((10#$r1 > 10#$r2 || (10#$r1 == 10#$r2 && 10#$a1 > 10#$a2)))
}

# Writes state/status: the running release, the one before it (rollback's default), the others
# kept, and the last attempt (its release, its result, deployed, refused or failed, its reason and
# when). Without arguments the last attempt stays as it was.
write_status() {
  local running previous="" kept="" id attempt result reason at
  if [ $# -gt 0 ]; then
    attempt=$1 result=$2 reason=$(line_of "$3") at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  else
    attempt=$(value_of state/status attempt) result=$(value_of state/status result)
    reason=$(value_of state/status reason) at=$(value_of state/status at)
  fi
  running=$(running_id)
  [ "$running" != 0-0 ] || running=""
  for id in $(releases_newest_first); do
    [ "$id" != "$running" ] || continue
    kept=\${kept:+$kept,}$id
    if [ -z "$previous" ] && [ -n "$running" ] && newer "$running" "$id"; then previous=$id; fi
  done
  printf 'running=%s\\nprevious=%s\\nkept=%s\\nattempt=%s\\nresult=%s\\nreason=%s\\nat=%s\\n' \\
    "$running" "$previous" "$kept" "$attempt" "$result" "$reason" "$at" | put state/status
}

# The address the agent asks the hostname on: HTTPS once its certificate verifies, HTTP before.
site_url() {
  if [ -f state/https ]; then printf 'https://%s' "$HOST_NAME"; else printf 'http://%s' "$HOST_NAME"; fi
}

# The status line and headers of a GET of $1, the body dropped. Fails when curl can't connect or
# the certificate doesn't verify.
fetch() {
  curl -sS -o /dev/null -D - --max-time 30 "$1"
}

# The value of header $2 in the answer $1, without its carriage return.
header_of() {
  printf '%s\\n' "$1" | tr -d '\\r' | sed -n "s/^$2:[[:space:]]*//Ip" | tail -n 1
}

# OpsCrew's .htaccess block for release $1 (plan 5): every other hostname refused, HTTPS forced
# once the certificate verifies, no listings, dotfiles refused (and with the web root ".", the
# app's packages and its storage), the security headers and the release's, the PHP handler, and
# the app's settings loaded before each PHP request where shared/env.php is; last, where
# fallback_needed says so, every path that is no file or folder sent to index.php.
htaccess_block() {
  local host module
  host=$(printf '%s' "$HOST_NAME" | sed 's/\\./\\\\./g')
  printf '%s\\n' '# BEGIN OpsCrew' 'RewriteEngine On' \\
    "RewriteCond %{HTTP_HOST} !^$host(:[0-9]+)?\\$ [NC]" 'RewriteRule ^ - [F]'
  if [ -f state/https ]; then
    printf '%s\\n' 'RewriteCond %{HTTPS} !=on' "RewriteRule ^ https://$HOST_NAME%{REQUEST_URI} [R=301,L]"
  fi
  if [ "$WEB_ROOT" = . ]; then
    printf '%s\\n' 'RewriteRule ^(vendor|storage|composer\\.json|composer\\.lock)(/|$) - [F]'
  fi
  printf '%s\\n' 'Options -Indexes' '<FilesMatch "^\\.">' 'Require all denied' '</FilesMatch>' \\
    ${HEADER_LINES}
  if [ -f state/https ]; then
    printf '%s\\n' 'Header always set Strict-Transport-Security "${HSTS}"'
  fi
  printf 'Header always set X-OpsCrew-Release "%s"\\n' "$1"
  if [ -n "$PHP_HANDLER" ]; then printf 'AddHandler %s .php\\n' "$PHP_HANDLER"; fi
  if [ -f shared/env.php ]; then
    for module in LiteSpeed lsapi_module php_module; do
      printf '<IfModule %s>\\nphp_value auto_prepend_file "%s"\\n</IfModule>\\n' "$module" "$DIR/shared/env.php"
    done
  fi
  if fallback_needed "$1"; then
    printf '%s\\n' 'RewriteCond %{REQUEST_FILENAME} !-f' 'RewriteCond %{REQUEST_FILENAME} !-d' \\
      'RewriteRule ^ index.php [L]'
  fi
  printf '%s\\n' '# END OpsCrew'
}

# Whether release $1 needs the fallback a server's php_fastcgi gives (research R13): its served
# folder has index.php, and the app's own .htaccess there has no RewriteRule outside comments.
# The app's own is the whole file until compose has run, then its part between the markers.
fallback_needed() {
  local file="releases/$1/$WEB_ROOT/.htaccess" rule='^[[:space:]]*RewriteRule([[:space:]]|$)'
  [ -f "releases/$1/$WEB_ROOT/index.php" ] || return 1
  [ -f "$file" ] || return 0
  if grep -qxF '# BEGIN OpsCrew' "$file"; then
    ! sed -n '/^# BEGIN OpsCrew: app$/,/^# END OpsCrew: app$/p' "$file" | grep -qiE "$rule"
  else
    ! grep -qiE "$rule" "$file"
  fi
}

# OpsCrew's .user.ini block: the app's settings loaded where PHP runs as FPM or CGI.
user_ini_block() {
  [ -f shared/env.php ] || return 0
  printf '; BEGIN OpsCrew\\nauto_prepend_file = "%s"\\n; END OpsCrew\\n' "$DIR/shared/env.php"
}

# Writes $1 as OpsCrew's block (the function $4 for release $5), then what the running release's
# copy $3 holds outside OpsCrew's parts (the panel's and the selector's blocks, byte for byte),
# then the app's own file between "$2 BEGIN OpsCrew: app" and "$2 END OpsCrew: app". $1 is the
# release's own file, or one composed before (a rollback's target), whose app part is kept. With
# $6 "own", the running copy is carried only when the app has no file of its own.
compose() {
  local file=$1 from=$3 begin="$2 BEGIN OpsCrew" end="$2 END OpsCrew"
  : > "$file.app"
  if [ -f "$file" ] && grep -qxF "$begin" "$file"; then
    sed -n "/^$begin: app\\$/,/^$end: app\\$/{//!p}" "$file" > "$file.app"
  elif [ -f "$file" ]; then
    cp "$file" "$file.app"
  fi
  : > "$file.carried"
  if [ -f "$from" ] && { [ "\${6:-}" != own ] || [ ! -s "$file.app" ]; }; then
    sed -e "/^$begin\\$/,/^$end\\$/d" -e "/^$begin: app\\$/,/^$end: app\\$/d" "$from" > "$file.carried"
  fi
  {
    "$4" "$5"
    lines_of "$file.carried"
    if [ -s "$file.app" ]; then
      printf '%s\\n' "$begin: app"
      lines_of "$file.app"
      printf '%s\\n' "$end: app"
    fi
  } > "$file.next"
  rm -f "$file.app" "$file.carried"
  if [ -s "$file.next" ]; then mv -f "$file.next" "$file"; else rm -f "$file.next" "$file"; fi
}

# Carries into release $1's served folder what the panel and the selector wrote into the running
# release's: the certificate checks' folders in .well-known/; php.ini and .user.ini where the app
# has none of its own; .htaccess composed with the app's own (the selector's Passenger block among
# what it keeps). The selector's node_modules link goes into the release itself, where it has none.
carry() {
  local to="releases/$1/$WEB_ROOT" from="current/$WEB_ROOT" check
  mkdir -p "$to"
  if [ -L current/node_modules ] && [ ! -e "releases/$1/node_modules" ] && [ ! -L "releases/$1/node_modules" ]; then
    cp -P current/node_modules "releases/$1/node_modules"
  fi
  for check in acme-challenge pki-validation; do
    if [ -d "$from/.well-known/$check" ]; then
      mkdir -p "$to/.well-known"
      cp -pR "$from/.well-known/$check" "$to/.well-known/"
    fi
  done
  if [ -f "$from/php.ini" ] && [ ! -e "$to/php.ini" ]; then cp -p "$from/php.ini" "$to/php.ini"; fi
  compose "$to/.htaccess" '#' "$from/.htaccess" htaccess_block "$1"
  compose "$to/.user.ini" ';' "$from/.user.ini" user_ini_block "$1" own
}

# Links each shared path of release folder $1 to shared/<path>. A path shared/ doesn't hold yet
# is moved there from the release first (Laravel's storage folder, for example), or made an empty
# folder when the release lacks it too (a kept folder the app fills at runtime).
link_shared() {
  local release=$1 path up
  for path in $SHARED_PATHS; do
    if [ ! -e "shared/$path" ] && [ -e "$release/$path" ]; then
      mkdir -p "$(dirname "shared/$path")"
      mv "$release/$path" "shared/$path"
    elif [ ! -e "shared/$path" ]; then
      mkdir -p "shared/$path"
    fi
    rm -rf "\${release:?}/$path"
    mkdir -p "$(dirname "$release/$path")"
    up=$(printf '%s' "$path" | sed 's|[^/]||g; s|/|../|g')
    ln -s "../../\${up}shared/$path" "$release/$path"
  done
}

# Points current at release $1 in one rename.
switch_to() {
  rm -f current.next
  ln -s "releases/$1" current.next
  mv -T current.next current
}

# Restarts the app's processes: every PHP process of the account (LiteSpeed's per-user restart,
# harmless elsewhere), or a Node.js or Python app of release $1.
restart() {
  case $APP_KIND in
    php) touch "$HOME/.lsphp_restart.txt" ;;
    node | python)
      mkdir -p "releases/$1/tmp"
      touch "releases/$1/tmp/restart.txt"
      ;;
  esac
}

# The app's root in CloudLinux's selector, from the home folder: the link current.
app_root() {
  printf 'opscrew/%s-%s/current' "$APP" "$ENVIRONMENT"
}

# Runs CloudLinux's selector's command $1 with --json and the app's interpreter, then the options
# after it; SELECTOR_SAID holds its answer on one line. Fails unless it answers success.
selector() {
  local command=$1 interpreter=nodejs success='"result": *"success"'
  shift
  if [ "$APP_KIND" = python ]; then interpreter=python; fi
  if SELECTOR_SAID=$(cloudlinux-selector "$command" --json --interpreter "$interpreter" "$@" 2>&1); then
    SELECTOR_SAID=$(line_of "$SELECTOR_SAID")
    [[ $SELECTOR_SAID =~ $success ]]
  else
    SELECTOR_SAID=$(line_of "$SELECTOR_SAID")
    return 1
  fi
}

# The package files of the app's kind: Node.js's package.json and package-lock.json, Python's
# requirements.txt; none for other apps.
package_files() {
  case $APP_KIND in
    node) printf 'package.json package-lock.json' ;;
    python) printf requirements.txt ;;
  esac
}

# Puts back the running release's package files that an install put aside in state/packages (a
# file <name>.none for one it didn't have), also after a run that stopped part-way through one.
restore_packages() {
  local saved file
  [ -d state/packages ] || return 0
  for saved in state/packages/*; do
    [ -e "$saved" ] || continue
    file=\${saved#state/packages/}
    case $file in
      *.none) rm -f "current/\${file%.none}" "$saved" ;;
      *)
        rm -f "current/$file"
        mv "$saved" "current/$file"
        ;;
    esac
  done
  rmdir state/packages
}

# CloudLinux's selector's install-modules for the app's root, the options after it. An error that
# says "The operation was performed" means the packages went in and only the selector's own check
# of the app failed (it compares the app's answers before and after, and before a first release the
# app root holds the empty placeholder): logged as a note, it counts as installed, and the agent's
# health check after the switch decides (027 research R13).
selector_modules() {
  local performed='The operation was performed'
  selector install-modules --app-root "$(app_root)" "$@" && return 0
  [[ $SELECTOR_SAID == *"$performed"* ]] || return 1
  say "Note: CloudLinux's selector installed the packages, but its own check of the app failed ($SELECTOR_SAID)."
}

# CloudLinux's selector installs the package files of release folder $1 into the app's one
# environment. The selector runs npm in the app's root, the running release, so another release's
# package files stand there while it installs, each of the running release's own put aside first
# and put back after.
selector_install() {
  local release=$1 file ok=yes
  if [ "$APP_KIND" = python ]; then
    selector_modules --requirements-file "$DIR/$release/requirements.txt"
    return
  fi
  if [ "$release" = "releases/$(running_id)" ]; then
    selector_modules
    return
  fi
  mkdir state/packages
  for file in $(package_files); do
    if [ -e "current/$file" ]; then mv "current/$file" "state/packages/$file"; else : > "state/packages/$file.none"; fi
    if [ -e "$release/$file" ]; then cp -p "$release/$file" "current/$file"; fi
  done
  selector_modules || ok=""
  restore_packages
  [ -n "$ok" ]
}

# Before release $1's switch: when its package files differ from the running release's, the
# selector installs them into the app's one environment, which the running release shares
# (INSTALLED names the release then). INSTALL_SAID says what failed.
install_modules() {
  local release=releases/$1 files file changed=""
  files=$(package_files)
  [ -n "$files" ] || return 0
  for file in $files; do
    if [ -e "$release/$file" ] || [ -e "current/$file" ]; then
      cmp -s "$release/$file" "current/$file" || changed=yes
    fi
  done
  if [ -z "$changed" ] || [ ! -e "$release/\${files%% *}" ]; then return 0; fi
  say "Release $1's packages changed: CloudLinux's selector installs them before the switch."
  if selector_install "$release"; then
    INSTALLED=$1
    return 0
  fi
  INSTALL_SAID="CloudLinux's selector couldn't install its packages (\${SELECTOR_SAID:-no answer}), so the app's environment, which the running release shares, may have changed"
  return 1
}

# After an attempt whose packages were installed (INSTALLED) didn't become the running release:
# the selector installs the running release's again. REINSTALL_SAID says when that failed.
reinstall_running() {
  local running files
  REINSTALL_SAID=""
  [ -n "\${INSTALLED:-}" ] || return 0
  INSTALLED=""
  running=$(running_id)
  files=$(package_files)
  if [ -z "$running" ] || [ ! -e "releases/$running/\${files%% *}" ]; then return 0; fi
  say "CloudLinux's selector installs release $running's packages again."
  if ! selector_install "releases/$running"; then
    REINSTALL_SAID="; installing release $running's packages again failed too (\${SELECTOR_SAID:-no answer}), so the app's environment may hold the failed release's"
  fi
}

# Empties LiteSpeed's page cache through a one-time PHP file with a random name that answers
# X-LiteSpeed-Purge: *, removed right after (ignored where the server isn't LiteSpeed).
purge() {
  local name
  name=opscrew-purge-$(openssl rand -hex 16).php
  printf '%s\\n' "<?php header('X-LiteSpeed-Purge: *');" > "current/$WEB_ROOT/$name"
  fetch "$(site_url)/$name" > /dev/null || say "The page cache purge didn't answer: cached pages may stay until they expire."
  rm -f "current/$WEB_ROOT/$name"
}

# Step 8: makes release $1, just switched to, serve.
serve() {
  restart "$1"
  if [ "$APP_KIND" = php ]; then purge; fi
}

# Step 9: asks the hostname for the health path every 5 seconds, for up to 125 seconds, until it
# answers 2xx or 3xx with release $1. Behind LiteSpeed the first such answer counts, as its restart
# makes every PHP process follow at once; elsewhere only one past PHP's realpath cache (120
# seconds), which until then can keep the old release. CHECK_SAID holds the last answer.
health_check() {
  local try answer code release
  CHECK_SAID="no answer"
  for ((try = 1; try <= 26; try++)); do
    if [ "$try" -gt 1 ]; then sleep 5; fi
    if answer=$(fetch "$(site_url)$HEALTH_PATH" 2>&1); then
      code=$(printf '%s\\n' "$answer" | head -n 1 | cut -d ' ' -f 2)
      release=$(header_of "$answer" X-OpsCrew-Release)
      CHECK_SAID="it answered $code with release \${release:-none}"
      if [[ $code =~ ^[23][0-9][0-9]$ ]] && [ "$release" = "$1" ]; then
        case $(header_of "$answer" Server) in LiteSpeed*) return 0 ;; esac
        if [ "$try" -ge 25 ]; then return 0; fi
      fi
    else
      CHECK_SAID=$(line_of "$answer")
    fi
  done
  return 1
}

# Dumps the app's database into file $1 (gzip), 0600; fails without leaving a partial file.
dump() {
  if mysqldump --defaults-extra-file=shared/mysql.cnf --single-transaction --no-tablespaces "$DATABASE" | gzip > "$1.partial"; then
    chmod 0600 "$1.partial"
    mv -f "$1.partial" "$1"
    return 0
  fi
  rm -f "$1.partial"
  return 1
}

# Replaces the app's database with the dump $1: its tables and views go first, so the ones made
# since the dump go too.
load() {
  local drops
  drops=$(mysql --defaults-extra-file=shared/mysql.cnf -N -B -e "SELECT CONCAT('DROP ', IF(table_type = 'VIEW', 'VIEW', 'TABLE'), ' IF EXISTS \\\`', REPLACE(table_name, '\\\`', '\\\`\\\`'), '\\\`;') FROM information_schema.tables WHERE table_schema = DATABASE()" "$DATABASE") || return 1
  { printf 'SET FOREIGN_KEY_CHECKS=0;\\n%s\\n' "$drops" && gunzip -c "$1"; } | mysql --defaults-extra-file=shared/mysql.cnf "$DATABASE"
}

# In release folder $1: Laravel's caches first, as they change nothing outside the release, then
# the release command; Laravel's cached config, which either can write, is made 0600 after both.
# The lock's descriptor stays out of the release command, so nothing it leaves running can hold
# the lock. A PHP app's release command needs the PHP CLI provision chose. PREPARE_SAID says what
# failed.
prepare() {
  if [ "$APP_KIND" = php ] && [ -z "$PHP_CLI" ] && { [ -f "$1/artisan" ] || [ -n "$RELEASE_COMMAND" ]; }; then
    PREPARE_SAID="no PHP CLI is chosen for the app yet, so its release command can't run (run opscrew provision)"
    return 1
  fi
  if [ "$APP_KIND" = php ] && [ -f "$1/artisan" ]; then
    (cd "$1" && php artisan optimize) || { PREPARE_SAID="Laravel's caches (php artisan optimize) failed"; return 1; }
  fi
  if [ -n "$RELEASE_COMMAND" ]; then
    (cd "$1" && bash -c "$RELEASE_COMMAND" 9>&-) || { PREPARE_SAID="the release command failed"; return 1; }
  fi
  if [ -f "$1/bootstrap/cache/config.php" ]; then chmod 0600 "$1/bootstrap/cache/config.php"; fi
}

# A release refused before anything was made for it.
refuse() {
  say "Refused release $1: $2."
  write_status "$1" refused "$2"
}

# Ends attempt $1 before its switch: its folder goes and the running release stays, its packages
# installed again when the attempt's were.
abandon() {
  reinstall_running
  rm -rf "releases/$1"
  ATTEMPT=""
  say "Release $1 failed: $2. The running release is untouched$REINSTALL_SAID."
  write_status "$1" failed "$2; the running release is untouched$REINSTALL_SAID"
}

# Points current back at the release that ran before the attempt (BEFORE), its packages installed
# again when the attempt's were, and makes it serve.
switch_back() {
  if [ -n "$BEFORE" ]; then
    switch_to "$BEFORE"
    reinstall_running
    serve "$BEFORE"
  else
    rm -f current
  fi
}

# Steps 5 to 10 for release $2 of commit $1.
deploy() {
  local id=$2 release="releases/$2"
  ATTEMPT=$id
  BEFORE=$(running_id)
  say "Deploying release $id (commit $1)."
  mkdir "$release"
  git --git-dir=cache archive --format=tar "$1" | tar -x -C "$release"
  link_shared "$release"
  carry "$id"
  if ! install_modules "$id"; then
    rm -rf "$release"
    ATTEMPT=""
    say "Release $id failed: $INSTALL_SAID. The running release stays."
    write_status "$id" failed "$INSTALL_SAID; the running release stays"
    return 0
  fi
  if [ "$SNAPSHOTS" = yes ] && [ -n "$DATABASE" ] && [ -n "$BEFORE" ] && [ "$BEFORE" != 0-0 ]; then
    if ! dump "dumps/$BEFORE.sql.gz"; then
      abandon "$id" "the database dump before it failed"
      return 0
    fi
  fi
  if ! prepare "$release"; then
    abandon "$id" "$PREPARE_SAID"
    return 0
  fi
  switch_to "$id"
  serve "$id"
  if health_check "$id"; then
    ATTEMPT=""
    prune
    say "Release $id serves."
    write_status "$id" deployed ""
    return 0
  fi
  switch_back
  rm -rf "$release"
  ATTEMPT=""
  say "Release $id failed its check ($CHECK_SAID): switched back to \${BEFORE:-nothing}$REINSTALL_SAID."
  write_status "$id" failed "$(site_url)$HEALTH_PATH didn't answer 2xx or 3xx with it ($CHECK_SAID); switched back to \${BEFORE:-nothing}$REINSTALL_SAID"
}

# Step 4 for the fetched commit $1: its OpsCrew-Release line must be signed by this environment's
# key over "<tree id> <run id> <attempt> <env>", name this environment, and be newer than the last
# release attempted (state/last, written before the attempt), so an old release pushed again is
# refused.
signed_release() {
  local re trailer run attempt env signature id tree last
  re='^OpsCrew-Release: ([1-9][0-9]{0,17}) ([1-9][0-9]{0,4}) ([a-z0-9-]{1,63}) ([A-Za-z0-9+/]{40,200}={0,2})$'
  trailer=$(git --git-dir=cache log -1 --format=%B "$1" | grep '^OpsCrew-Release: ' || true)
  if ! [[ $trailer =~ $re ]]; then
    refuse "$1" "its commit has no single OpsCrew-Release line"
    return 0
  fi
  run=\${BASH_REMATCH[1]} attempt=\${BASH_REMATCH[2]} env=\${BASH_REMATCH[3]} signature=\${BASH_REMATCH[4]}
  id=$run-$attempt
  tree=$(git --git-dir=cache rev-parse "$1^{tree}")
  printf '%s %s %s %s' "$tree" "$run" "$attempt" "$env" > state/release.message
  if ! printf '%s' "$signature" | base64 -d > state/release.signature 2> /dev/null ||
    ! openssl dgst -sha256 -verify keys/release.pub -signature state/release.signature state/release.message > /dev/null 2>&1; then
    rm -f state/release.message state/release.signature
    refuse "$id" "it isn't signed by this environment's release key"
    return 0
  fi
  rm -f state/release.message state/release.signature
  if [ "$env" != "$ENVIRONMENT" ]; then
    refuse "$id" "it was signed for the $env environment, not $ENVIRONMENT"
    return 0
  fi
  last=$(cat state/last 2> /dev/null || true)
  if ! newer "$id" "$last"; then
    refuse "$id" "it isn't newer than release $last, the last one attempted: an old release pushed again"
    return 0
  fi
  printf '%s\\n' "$id" | put state/last
  deploy "$1" "$id"
}

# Step 3: the release branch's newest commit, over SSH on 22, else on ssh.github.com:443; when it
# is one not seen yet, a shallow fetch into the bare cache, then step 4.
new_release() {
  local ref="refs/heads/$RELEASE_BRANCH" urls url latest commit
  urls=("git@github.com:$REPOSITORY.git" "ssh://git@ssh.github.com:443/$REPOSITORY.git")
  for url in "\${urls[@]}"; do
    if latest=$(git ls-remote "$url" "$ref" 2> state/ls-remote.err); then
      latest=$(printf '%s\\n' "$latest" | cut -f 1)
      if [ -z "$latest" ] || [ "$latest" = "$(cat state/commit 2> /dev/null || true)" ]; then return 0; fi
      if [ ! -d cache ]; then git init -q --bare cache; fi
      git --git-dir=cache fetch -q --depth=1 --no-tags "$url" "+$ref:refs/heads/release"
      # git writes its objects and packs 0444, which a panel's file removal skips (R13).
      chmod -R u+w cache
      commit=$(git --git-dir=cache rev-parse --verify -q 'refs/heads/release^{commit}')
      printf '%s\\n' "$commit" | put state/commit
      signed_release "$commit"
      git --git-dir=cache gc -q --prune=now
      chmod -R u+w cache
      return 0
    fi
  done
  fail "GitHub can't be reached over SSH on port 22 or 443: $(line_of "$(cat state/ls-remote.err)")"
}

# Forces HTTPS once curl verifies the hostname's certificate: later releases get the redirect, and
# the running release's block is rewritten in place.
https_check() {
  local running served
  [ ! -f state/https ] || return 0
  curl -sS -o /dev/null --max-time 30 "https://$HOST_NAME/" 2> /dev/null || return 0
  : > state/https
  say "The certificate on $HOST_NAME verifies: HTTPS is forced from now on."
  running=$(running_id)
  [ -n "$running" ] || return 0
  served="releases/$running/$WEB_ROOT/.htaccess"
  {
    htaccess_block "$running"
    if [ -f "$served" ]; then sed -e '/^# BEGIN OpsCrew$/,/^# END OpsCrew$/d' "$served"; fi
  } | put "$served"
}

# Step 10: keeps the KEEP newest releases besides the running one, and the dumps filed under a
# release still kept; a request's snapshots stay.
prune() {
  local running id kept=0 file
  running=$(running_id)
  for id in $(releases_newest_first); do
    [ "$id" != "$running" ] || continue
    kept=$((kept + 1))
    if [ "$kept" -gt "$KEEP" ]; then rm -rf "releases/$id"; fi
  done
  if [ "$running" != 0-0 ]; then rm -rf releases/0-0; fi
  for file in dumps/*.sql.gz; do
    id=\${file#dumps/}
    id=\${id%.sql.gz}
    if [[ $id =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] && [ ! -d "releases/$id" ]; then rm -f "$file"; fi
  done
}

# Answers request $1 in state/$1.result: result=$2 (done, refused or failed), reason=$3 when there
# is one, then any further key=value lines.
answer() {
  local name=$1 result=$2 reason=$3
  shift 3
  {
    printf 'result=%s\\n' "$result"
    if [ -n "$reason" ]; then printf 'reason=%s\\n' "$(line_of "$reason")"; fi
    if [ $# -gt 0 ]; then printf '%s\\n' "$@"; fi
  } | put "state/$name.result"
  say "Request $name: $result\${reason:+: $reason}."
}

# Reads request file $1 named $2 into R, checking each line, key and value; PROBLEM says why it
# is refused.
read_request() {
  local line n=0 key kind allowed
  local hash_re='^[0-9a-f]{64}$' release_re='^[1-9][0-9]*-[1-9][0-9]*$' snapshot_re='^[A-Za-z0-9][A-Za-z0-9_-]*$'
  if [ "$(sha256sum < "$1" | cut -c 1-64)" != "$2" ]; then
    PROBLEM="its content doesn't match its name: it changed after it was written"
    return 0
  fi
  if [ "$(wc -c < "$1")" -gt 4096 ]; then
    PROBLEM="it is larger than 4 KB"
    return 0
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if ! [[ $line =~ ^([a-z]+)=([A-Za-z0-9._-]*)$ ]]; then
      PROBLEM="line $n isn't a key=value line OpsCrew writes"
      return 0
    fi
    if [ -n "\${R[\${BASH_REMATCH[1]}]+set}" ]; then
      PROBLEM="the key \${BASH_REMATCH[1]} is there twice"
      return 0
    fi
    R[\${BASH_REMATCH[1]}]=\${BASH_REMATCH[2]}
  done < "$1"
  kind=\${R[kind]:-}
  case $kind in
    rollback) allowed="kind hash expires release restore" ;;
    env | snapshot) allowed="kind hash expires" ;;
    restore) allowed="kind hash expires snapshot" ;;
    app) allowed="kind hash expires action" ;;
    *)
      PROBLEM="the kind \${kind:-(none)} isn't one the agent carries out"
      return 0
      ;;
  esac
  for key in "\${!R[@]}"; do
    case " $allowed " in
      *" $key "*) ;;
      *)
        PROBLEM="the key $key doesn't belong in a $kind request"
        return 0
        ;;
    esac
  done
  for key in $allowed; do
    if [ -z "\${R[$key]+set}" ]; then
      PROBLEM="the key $key is missing"
      return 0
    fi
  done
  if ! [[ \${R[hash]} =~ $hash_re ]]; then
    PROBLEM="hash isn't a SHA-256"
  elif ! [[ \${R[expires]} =~ ^[0-9]{1,11}$ ]]; then
    PROBLEM="expires isn't a time in seconds"
  elif ((10#\${R[expires]} <= $(date +%s))); then
    PROBLEM="it expired (expires=\${R[expires]})"
  elif [ "$kind" = rollback ] && ! [[ \${R[release]} =~ $release_re ]]; then
    PROBLEM="release isn't a release's id"
  elif [ "$kind" = rollback ] && ! [[ \${R[restore]} =~ ^(yes|no)$ ]]; then
    PROBLEM="restore isn't yes or no"
  elif [ "$kind" = restore ] && ! [[ \${R[snapshot]} =~ $snapshot_re ]]; then
    PROBLEM="snapshot isn't a snapshot's id"
  elif [ "$kind" = app ] && ! [[ \${R[action]} =~ ^(create|destroy)$ ]]; then
    PROBLEM="action isn't create or destroy"
  fi
}

# A rollback to the kept release R[release]. With restore=yes the current database is dumped first,
# filed under the running release, then the target's dump is restored; a failed restore puts the
# database back.
do_rollback() {
  local name=$1 target=\${R[release]} running
  running=$(running_id)
  if [ ! -d "releases/$target" ]; then
    answer "$name" refused "release $target isn't kept on the account"
    return 0
  fi
  if [ "$target" = "$running" ]; then
    answer "$name" refused "release $target is already running"
    return 0
  fi
  if [ "\${R[restore]}" = yes ] && [ -z "$DATABASE" ]; then
    answer "$name" refused "this app has no database"
    return 0
  fi
  if [ "\${R[restore]}" = yes ] && [ ! -f "dumps/$target.sql.gz" ]; then
    answer "$name" refused "no dump is filed under release $target"
    return 0
  fi
  if ! install_modules "$target"; then
    answer "$name" failed "$INSTALL_SAID; release $running still runs"
    return 0
  fi
  if [ "\${R[restore]}" = yes ]; then
    if ! dump "dumps/$running.sql.gz"; then
      answer "$name" failed "the current database couldn't be dumped first: nothing changed"
      return 0
    fi
    if ! load "dumps/$target.sql.gz"; then
      if load "dumps/$running.sql.gz"; then
        answer "$name" failed "restoring release $target's dump failed: the database is back as it was, and release $running still runs"
      else
        answer "$name" failed "restoring release $target's dump failed, and putting the database back failed too: dumps/$running.sql.gz holds it"
      fi
      return 0
    fi
  fi
  carry "$target"
  switch_to "$target"
  serve "$target"
  write_status
  if health_check "$target"; then
    answer "$name" done ""
  else
    answer "$name" failed "switched to release $target, but $(site_url)$HEALTH_PATH didn't answer 2xx or 3xx with it ($CHECK_SAID)"
  fi
}

# A settings change: shared/.env.next renamed into place, Laravel's config cache made again, a
# Node.js or Python app's values handed to CloudLinux's selector, the app restarted.
do_env() {
  local name=$1
  if [ ! -f shared/.env.next ]; then
    answer "$name" refused "shared/.env.next isn't there"
    return 0
  fi
  chmod 0600 shared/.env.next
  mv -f shared/.env.next shared/.env
  if [ "$APP_KIND" = php ] && [ -f current/artisan ]; then
    if ! (cd current && php artisan config:cache); then
      answer "$name" failed "the settings changed, but Laravel's config cache (php artisan config:cache) failed"
      return 0
    fi
    chmod 0600 current/bootstrap/cache/config.php
  fi
  if { [ "$APP_KIND" = node ] || [ "$APP_KIND" = python ]; } && ! pass_env; then
    answer "$name" failed "the settings changed, but CloudLinux's selector refused them, so the app's environment still holds the earlier ones (the app's own file has the new ones)"
    return 0
  fi
  restart "$(running_id)"
  answer "$name" done ""
}

# A free name for a snapshot: snapshot-<UTC time>, or -2, -3… within one second.
snapshot_name() {
  local base n=1 name
  base=snapshot-$(date -u +%Y%m%dT%H%M%SZ)
  name=$base
  while [ -e "dumps/$name.sql.gz" ] || [ -e "dumps/$name.shared.tar.gz" ]; do
    n=$((n + 1))
    name=$base-$n
  done
  printf '%s' "$name"
}

# The entries of shared/ a snapshot copies, into ENTRIES (each ./<name>): all but the settings
# files (.env, .env.next, env.php and mysql.cnf), so a restore never puts back old values.
shared_entries() {
  local entry
  ENTRIES=()
  for entry in shared/* shared/.[!.]* shared/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case \${entry#shared/} in .env | .env.next | env.php | mysql.cnf) continue ;; esac
    ENTRIES+=("./\${entry#shared/}")
  done
}

# Snapshot $1: the app's database, when it has one, dumped into dumps/$1.sql.gz and, when shared/
# holds more than the settings files, those copied into dumps/$1.shared.tar.gz (0600). Makes
# nothing when there is neither; fails leaving neither.
take_snapshot() {
  if [ -n "$DATABASE" ]; then dump "dumps/$1.sql.gz" || return 1; fi
  shared_entries
  [ "\${#ENTRIES[@]}" -gt 0 ] || return 0
  if tar -czf "dumps/$1.shared.tar.gz.partial" -C shared "\${ENTRIES[@]}"; then
    chmod 0600 "dumps/$1.shared.tar.gz.partial"
    mv -f "dumps/$1.shared.tar.gz.partial" "dumps/$1.shared.tar.gz"
    return 0
  fi
  rm -f "dumps/$1.sql.gz" "dumps/$1.shared.tar.gz.partial"
  return 1
}

# Puts the shared files back as the copy $1 holds them: every entry of shared/ but the settings
# files goes, then the copy, when there is one, is unpacked there, never over a settings file even
# if the copy holds one.
put_shared() {
  shared_entries
  if [ "\${#ENTRIES[@]}" -gt 0 ]; then (cd shared && rm -rf "\${ENTRIES[@]}") || return 1; fi
  [ ! -f "$1" ] || tar --anchored --exclude=./.env --exclude=./.env.next --exclude=./env.php \\
    --exclude=./mysql.cnf -xzf "$1" -C shared
}

# A snapshot (take_snapshot) under a new name, answered with its parts (dump= and shared=);
# refused for an app with no database and no shared files besides its settings.
do_snapshot() {
  local name=$1 snapshot parts=()
  shared_entries
  if [ -z "$DATABASE" ] && [ "\${#ENTRIES[@]}" -eq 0 ]; then
    answer "$name" refused "this app has no database and no shared files besides its settings"
    return 0
  fi
  snapshot=$(snapshot_name)
  if ! take_snapshot "$snapshot"; then
    answer "$name" failed "the database dump or the copy of the shared files failed"
    return 0
  fi
  if [ -f "dumps/$snapshot.sql.gz" ]; then parts+=("dump=$snapshot.sql.gz"); fi
  if [ -f "dumps/$snapshot.shared.tar.gz" ]; then parts+=("shared=$snapshot.shared.tar.gz"); fi
  answer "$name" done "" "\${parts[@]}"
}

# A restore of snapshot R[snapshot]: the current database and shared files are copied first as a
# snapshot (saved=, when there was anything to copy); then the database goes back when the
# snapshot holds its dump, then the shared files when it holds their copy (the settings files stay
# as they are). A failure puts back what was copied first.
do_restore() {
  local name=$1 id=\${R[snapshot]} saved back extra=()
  local db_file=dumps/\${R[snapshot]}.sql.gz files_copy=dumps/\${R[snapshot]}.shared.tar.gz
  if [ ! -f "$db_file" ] && [ ! -f "$files_copy" ]; then
    answer "$name" refused "the snapshot $id isn't in dumps/"
    return 0
  fi
  if [ -f "$db_file" ] && [ -z "$DATABASE" ]; then
    answer "$name" refused "the snapshot $id holds a database dump, and this app has no database"
    return 0
  fi
  saved=$(snapshot_name)
  if ! take_snapshot "$saved"; then
    answer "$name" failed "the current database and shared files couldn't be copied first: nothing changed"
    return 0
  fi
  if [ -f "dumps/$saved.sql.gz" ] || [ -f "dumps/$saved.shared.tar.gz" ]; then extra=("saved=$saved"); fi
  if [ -f "$db_file" ] && ! load "$db_file"; then
    if load "dumps/$saved.sql.gz"; then
      answer "$name" failed "the restore failed: the database is back as it was" \${extra[@]+"\${extra[@]}"}
    else
      answer "$name" failed "the restore failed, and putting the database back failed too: the snapshot $saved in dumps/ holds it" \${extra[@]+"\${extra[@]}"}
    fi
    return 0
  fi
  if [ -f "$files_copy" ] && ! put_shared "$files_copy"; then
    back="the shared files are"
    if [ -f "$db_file" ]; then back="the database and the shared files are"; fi
    if { [ ! -f "$db_file" ] || load "dumps/$saved.sql.gz"; } && put_shared "dumps/$saved.shared.tar.gz"; then
      answer "$name" failed "putting the shared files back failed: $back back as they were" \${extra[@]+"\${extra[@]}"}
    else
      answer "$name" failed "putting the shared files back failed, and putting things back as they were failed too: the snapshot $saved in dumps/ holds them" \${extra[@]+"\${extra[@]}"}
    fi
    return 0
  fi
  answer "$name" done "" \${extra[@]+"\${extra[@]}"}
}

# The header lines of the sections of the selector's ~/.cl.selector/htaccess_cache.
cache_headers() {
  local cache=$HOME/.cl.selector/htaccess_cache
  if [ -f "$cache" ]; then grep '^\\[' "$cache" || true; fi
}

# Makes the app in CloudLinux's selector, its root the link current, served at the hostname's root;
# keeps the header of the section the selector added to htaccess_cache (empty when it added none,
# or more than one). When the selector made the app but refused its settings, the answer is done,
# its note saying so.
app_create() {
  local name=$1 mode=() added
  if [ "$APP_KIND" = node ]; then mode=(--app-mode production); fi
  cache_headers > state/selector.before
  if ! selector create --version "$RUNTIME_VERSION" --app-root "$(app_root)" --app-uri / \${mode[@]+"\${mode[@]}"} --domain "$HOST_NAME" --startup-file "$STARTUP_FILE"; then
    rm -f state/selector.before
    answer "$name" failed "CloudLinux's selector didn't make the app: \${SELECTOR_SAID:-no answer}"
    return 0
  fi
  cache_headers | grep -vxF -f state/selector.before > state/selector.added || true
  added=$(wc -l < state/selector.added)
  if [ "$added" -eq 1 ]; then
    mv -f state/selector.added state/selector-section
  else
    : > state/selector-section
  fi
  rm -f state/selector.before state/selector.added
  if ! pass_env; then
    answer "$name" done "" "note=CloudLinux's selector made the app but refused its settings, so the app gets them only from its .env file until a settings change hands them over again"
    return 0
  fi
  answer "$name" done ""
}

# Decodes value $1 of a line of shared/.env as OpsCrew writes it (bare; in single quotes; or in
# double quotes with \\\\ \\" \\n \\r \\t and \\$ escaped) into ENV_VALUE.
env_value() {
  local v=$1 i c
  ENV_VALUE=""
  case $v in
    \\'*\\')
      ENV_VALUE=\${v:1:\${#v}-2}
      return 0
      ;;
    \\"*\\") v=\${v:1:\${#v}-2} ;;
    *)
      ENV_VALUE=$v
      return 0
      ;;
  esac
  for ((i = 0; i < \${#v}; i++)); do
    c=\${v:i:1}
    if [ "$c" = '\\' ] && [ $((i + 1)) -lt \${#v} ]; then
      i=$((i + 1))
      case \${v:i:1} in
        n) c=$'\\n' ;;
        r) c=$'\\r' ;;
        t) c=$'\\t' ;;
        *) c=\${v:i:1} ;;
      esac
    fi
    ENV_VALUE+=$c
  done
}

# Appends $1 to ENV_JSON as a JSON string.
json_string() {
  local v=$1 i c
  ENV_JSON+='"'
  for ((i = 0; i < \${#v}; i++)); do
    c=\${v:i:1}
    case $c in
      '"') ENV_JSON+='\\"' ;;
      '\\') ENV_JSON+='\\\\' ;;
      $'\\n') ENV_JSON+='\\n' ;;
      $'\\r') ENV_JSON+='\\r' ;;
      $'\\t') ENV_JSON+='\\t' ;;
      [[:cntrl:]]) ENV_JSON+=$(printf '\\\\u%04x' "'$c") ;;
      *) ENV_JSON+=$c ;;
    esac
  done
  ENV_JSON+='"'
}

# Hands the app's settings in shared/.env to CloudLinux's selector as one JSON object, which it
# gives the app's process as its environment (the file is linked into each release too). Nothing
# when the app has no settings file. The values stay in memory: only the selector gets them.
pass_env() {
  local line name sep=""
  [ -f shared/.env ] || return 0
  ENV_JSON="{"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name=\${BASH_REMATCH[1]}
    env_value "\${BASH_REMATCH[2]}"
    ENV_JSON+="$sep\\"$name\\":"
    json_string "$ENV_VALUE"
    sep=,
  done < shared/.env
  ENV_JSON+="}"
  ENV_VALUE=""
  # The selector's answer may repeat the values: it is dropped, never logged or answered.
  if selector set --app-root "$(app_root)" --env-vars "$ENV_JSON"; then
    ENV_JSON="" SELECTOR_SAID=""
    return 0
  fi
  ENV_JSON="" SELECTOR_SAID=""
  return 1
}

# Removes the section of ~/.cl.selector/htaccess_cache whose header state/selector-section kept,
# from its header to the next one, every other byte of the file as it was. CACHE_SAID says why the
# file stays as it is, when it can't tell which section is the app's.
forget_cache_section() {
  local cache=$HOME/.cl.selector/htaccess_cache header count start next
  CACHE_SAID=""
  [ -f state/selector-section ] || return 0
  header=$(cat state/selector-section)
  if [ -z "$header" ]; then
    CACHE_SAID="~/.cl.selector/htaccess_cache stays as it is: the selector added no section, or more than one, to it when it made the app, so OpsCrew can't tell which is the app's"
    return 0
  fi
  count=0
  if [ -f "$cache" ]; then count=$(grep -cxF -- "$header" "$cache" || true); fi
  if [ "$count" -gt 1 ]; then
    CACHE_SAID="~/.cl.selector/htaccess_cache stays as it is: the app's section $header is in it more than once, so OpsCrew can't tell which is the app's"
    return 0
  fi
  if [ "$count" -eq 1 ]; then
    start=$(grep -nxF -- "$header" "$cache" | cut -d : -f 1)
    next=$(tail -n +"$((start + 1))" "$cache" | grep -n -m 1 '^\\[' | cut -d : -f 1 || true)
    cp -p "$cache" "$cache.opscrew"
    {
      head -n "$((start - 1))" "$cache"
      if [ -n "$next" ]; then tail -n +"$((start + next))" "$cache"; fi
    } > "$cache.opscrew"
    mv -f "$cache.opscrew" "$cache"
  fi
  rm -f state/selector-section
}

# Removes the app from CloudLinux's selector, then what the selector leaves of it: its empty
# environment folder (~/nodevenv/<app root>, ~/virtualenv/ for Python) and its section of
# htaccess_cache. The answer's note says what stays, and why.
app_destroy() {
  local name=$1 venv=nodevenv note=""
  if [ "$APP_KIND" = python ]; then venv=virtualenv; fi
  if ! selector destroy --app-root "$(app_root)"; then
    answer "$name" failed "CloudLinux's selector didn't remove the app: \${SELECTOR_SAID:-no answer}"
    return 0
  fi
  if [ -d "$HOME/$venv/$(app_root)" ]; then
    (cd "$HOME/$venv" && rmdir -p "$(app_root)" 2> /dev/null) || true
    if [ -d "$HOME/$venv/$(app_root)" ]; then note="~/$venv/$(app_root) isn't empty, so it stays"; fi
  fi
  forget_cache_section
  if [ -n "$CACHE_SAID" ]; then note="\${note:+$note; }$CACHE_SAID"; fi
  if [ -n "$note" ]; then answer "$name" done "" "note=$note"; else answer "$name" done ""; fi
}

# An app request: the app made in CloudLinux's selector, or removed from it (R[action]).
do_app() {
  case $APP_KIND in
    node | python) "app_\${R[action]}" "$1" ;;
    *) answer "$1" refused "this app isn't a Node.js or Python app, which CloudLinux's selector runs" ;;
  esac
}

# Request $1 (requests/$1.req), carried out at most once: its answer is written before it starts,
# so a run that stops part-way never starts it again.
request() {
  local name=$1
  local -A R=()
  PROBLEM=""
  read_request "requests/$name.req" "$name"
  if [ -n "$PROBLEM" ]; then
    answer "$name" refused "$PROBLEM"
    return 0
  fi
  say "Request $name: \${R[kind]}."
  printf 'result=failed\\nreason=the agent stopped while carrying it out\\n' | put "state/$name.result"
  "do_\${R[kind]}" "$name"
}

# Step 2: each request named by the SHA-256 of its bytes, carried out once, then removed. Other
# files (one being written under a temporary name) are left alone.
requests() {
  local file name
  for file in requests/*.req; do
    [ -f "$file" ] || continue
    name=\${file#requests/}
    name=\${name%.req}
    [[ $name =~ ^[0-9a-f]{64}$ ]] || continue
    if [ ! -f "state/$name.result" ]; then request "$name"; fi
    rm -f "$file"
  done
}

# On a stop during an attempt: current goes back to the release before it if it was switched
# already (the running release's package files, and its packages when the attempt's were
# installed, back too), the attempt's folder goes once it doesn't serve, and the status says so.
stopped() {
  local code=$? now
  if [ "$code" -eq 0 ] || [ -z "\${ATTEMPT:-}" ]; then return 0; fi
  rm -f current.next
  restore_packages || true
  if [ "$(running_id)" = "$ATTEMPT" ]; then switch_back || true; else reinstall_running || true; fi
  now=$(running_id)
  if [ "$now" != "$ATTEMPT" ]; then rm -rf "releases/$ATTEMPT"; fi
  write_status "$ATTEMPT" failed "the agent stopped while deploying it (exit $code), and \${now:-no release} runs$REINSTALL_SAID: see opscrew logs"
}

main() {
  umask 022
  cd "$(dirname "$0")"
  DIR=$PWD
  . ./settings.sh
  # CloudLinux's selector is in /usr/sbin, which cron's PATH lacks.
  PATH=$PATH:/usr/sbin
  mkdir -p keys state requests dumps releases shared
  chmod 0700 keys state requests dumps
  chmod 0711 . releases shared
  exec 9>> state/lock
  if command -v flock > /dev/null && ! flock -n 9; then
    say "Another run of the agent holds the lock: this one stops."
    return 0
  fi
  trim_log
  SSH=(ssh -F /dev/null -i "$DIR/keys/github" -o IdentitiesOnly=yes -o "UserKnownHostsFile=$DIR/keys/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20)
  if [ ! -f state/report ]; then first_run; fi
  command -v flock > /dev/null || fail "flock is missing on this account, and the agent doesn't deploy without it: ask the host for util-linux's flock."
  if [ ! -e current ] && [ ! -L current ]; then
    mkdir -p "releases/0-0/$WEB_ROOT"
    ln -s releases/0-0 current
  fi
  # A run that stopped while the selector installed another release's packages left them there.
  restore_packages
  GIT_SSH_COMMAND=$(printf '%q ' "\${SSH[@]}")
  export DIR PHP_CLI GIT_SSH_COMMAND GIT_TERMINAL_PROMPT=0
  export -f php
  ATTEMPT="" BEFORE="" INSTALLED="" REINSTALL_SAID=""
  trap stopped EXIT
  requests
  https_check
  new_release
}

main "$@"; exit
`;
