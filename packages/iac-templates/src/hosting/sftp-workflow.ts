// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, isHostingTarget } from "@opscrew/plan-schema";
import { ACTIONS } from "../pins";
import { wrongTarget } from "../providers";
import { BASELINE_HEADERS, HSTS, shellQuote } from "../runtime/services";
import type { RenderContext, RenderedFile } from "../types";
import { pushPaths } from "../workflow/paths";
import { pausedJob, unpaused } from "../workflow/pause";
import {
  DISPATCH_BY_HAND,
  deploySecretName,
  environmentName,
  githubEnvironment,
  job,
  opscrew,
  promoted,
  provisionCommand,
  run,
  secret,
  workflowStart,
} from "../workflow/shared";
import { RELEASE_ARTIFACT, releaseBuildJob } from "./workflow";

/**
 * The GitHub Actions secrets (before `deploySecretName`) of an app on an SFTP-only host, which
 * `opscrew provision` sets in the deploy environment (ADR 0030 D6): where the app is
 * ({@link sftpUrl}), the key GitHub Actions logs in with (Ed25519, OpenSSH's format), and the host
 * key the user confirmed, as known_hosts lines.
 */
export const SFTP_DEPLOY_SECRETS = {
  url: "OPSCREW_SFTP_URL",
  privateKey: "OPSCREW_SFTP_PRIVATE_KEY",
  knownHosts: "OPSCREW_SFTP_KNOWN_HOSTS",
} as const;

/**
 * Where an app on an SFTP-only host is, as one URL: `sftp://<user>@<host>:<port>/<folder>`, the
 * user and each part of the folder (as SFTP shows it) percent-encoded, an absolute folder after a
 * second `/`. The deploy reads the login and the folder from it, and hides the host in its log;
 * the folder, often a plain word such as `opscrew`, stays readable there.
 */
export function sftpUrl(
  login: { host: string; port: number; user: string },
  folder: string,
): string {
  const host = login.host.includes(":") ? `[${login.host}]` : login.host;
  const path = folder.split("/").map(encodeURIComponent).join("/");
  return `sftp://${encodeURIComponent(login.user)}@${host}:${login.port}/${path}`;
}

/** How many releases the host keeps besides the running one. */
const KEEP = 3;

/**
 * The lines an app's releases get to load its settings on an SFTP-only host (027 plan 10):
 * `shared/env.htaccess`, inside OpsCrew's `.htaccess` block, and `shared/env.user.ini`, the
 * release's `.user.ini` block, both naming `envPhp` (`shared/env.php`'s path as PHP sees it).
 * `opscrew provision` writes them beside `env.php`; the deploy reads them, so no path of the
 * host's is in the repository. As the agent's on a panel account.
 */
export function renderSftpPhpLines(envPhp: string): { htaccess: string; userIni: string } {
  if (!/^\/[^"\0\r\n]*$/.test(envPhp)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `env.php's path must be absolute, without quotes or line breaks (${JSON.stringify(envPhp)}).`,
    );
  }
  return {
    htaccess: ["LiteSpeed", "lsapi_module", "php_module"]
      .map(
        (module) => `<IfModule ${module}>\nphp_value auto_prepend_file "${envPhp}"\n</IfModule>\n`,
      )
      .join(""),
    userIni: `; BEGIN OpsCrew\nauto_prepend_file = "${envPhp}"\n; END OpsCrew\n`,
  };
}

/** A `.htaccess` line that rewrites, comments aside (grep -iE). */
const REWRITE_RULE = "^[[:space:]]*RewriteRule([[:space:]]|$)";

/** A PHP app's routing where its `.htaccess` has none, as a server's php_fastcgi (research R13). */
const FALLBACK = [
  "RewriteCond %{REQUEST_FILENAME} !-f",
  "RewriteCond %{REQUEST_FILENAME} !-d",
  "RewriteRule ^ index.php [L]",
];

/** `printf '%s\n'` of each line, shell-quoted. */
const printLines = (lines: readonly string[]) =>
  `printf '%s\\n' ${lines.map((line) => shellQuote(line)).join(" ")}`;

/**
 * The deploy step's script (027 plan 10), over SFTP alone: the host's `state/status` and OpsCrew's
 * PHP lines read; the release's `.htaccess` (OpsCrew's block, then the app's own) and `.user.ini`
 * composed; the release uploaded into `releases/<run id>-<attempt>/`; `current` switched to it
 * with `ln -s` and `rename` (OpenSSH's posix-rename, one step); the hostname asked until it serves
 * the release; then the newest {@link KEEP} other releases kept, or on a failure `current`
 * switched back and the release removed; `state/status` written either way.
 */
function deployScript(plan: DeployPlan, webRoot: string, app: "static" | "php"): string[] {
  const host = plan.dns.domain as string;
  const hostPattern = host.replaceAll(".", "\\.");
  const path = plan.app.healthPath.startsWith("/")
    ? plan.app.healthPath
    : `/${plan.app.healthPath}`;
  const head = [
    "# BEGIN OpsCrew",
    "RewriteEngine On",
    `RewriteCond %{HTTP_HOST} !^${hostPattern}(:[0-9]+)?$ [NC]`,
    "RewriteRule ^ - [F]",
  ];
  const https = [
    "RewriteCond %{HTTPS} !=on",
    `RewriteRule ^ https://${host}%{REQUEST_URI} [R=301,L]`,
  ];
  const rules = [
    ...(webRoot === "."
      ? ["RewriteRule ^(vendor|storage|composer\\.json|composer\\.lock)(/|$) - [F]"]
      : []),
    "Options -Indexes",
    '<FilesMatch "^\\.">',
    "Require all denied",
    "</FilesMatch>",
    ...BASELINE_HEADERS.map(([name, value]) => `Header always set ${name} "${value}"`),
  ];
  const status = opscrew(plan, "status");
  return [
    "set -euo pipefail",
    'release="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"',
    'work="$RUNNER_TEMP/opscrew-sftp"',
    'mkdir -p "$work/release"',
    'tar -xf "$RUNNER_TEMP/release.tar" -C "$work/release"',
    "# The key and the host key the user confirmed, the runner's user's only.",
    "umask 077",
    'printf \'%s\\n\' "$SFTP_KEY" > "$work/key"',
    'printf \'%s\\n\' "$KNOWN_HOSTS" > "$work/known_hosts"',
    "umask 022",
    "# The login and the app's folder from the app's URL (sftpUrl); the host is hidden in the log.",
    "rest=${SFTP_URL#sftp://}",
    "if [[ $rest != *@*/?* ]]; then",
    `  echo "::error::The deploy environment has no SFTP URL (${deploySecretName(plan, SFTP_DEPLOY_SECRETS.url)}): run \\\`${provisionCommand(plan)}\\\`, which sets it."`,
    "  exit 1",
    "fi",
    'login="sftp://${rest%%/*}"',
    "host=${rest%%/*}",
    "host=${host#*@}",
    'echo "::add-mask::${host%:*}"',
    "FOLDER=$(printf '%b' \"$(printf '%s' \"${rest#*/}\" | sed 's/%\\([0-9A-Fa-f][0-9A-Fa-f]\\)/\\\\x\\1/g')\")",
    "# Runs the batch on its standard input on the host, with that key and host key only.",
    "on_host() {",
    '  sftp -b - -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=\\"$work/known_hosts\\"" -o IdentitiesOnly=yes -i "$work/key" "$login"',
    "}",
    "# $1 in double quotes for a batch line, its \\ and \" escaped (sftp's own quoting).",
    "q() {",
    '  printf \'"%s"\' "$(printf \'%s\' "$1" | sed \'s/[\\\\"]/\\\\&/g\')"',
    "}",
    "# $1 on one line.",
    "one_line() {",
    "  printf '%s' \"$1\" | tr '\\r\\n' '  '",
    "}",
    "# The releases on the host, newest first: <run id>-<attempt> folders, by run id then attempt.",
    "release_ids() {",
    "  local listing",
    '  listing=$(printf \'@ls -1a %s\\n\' "$(q "$FOLDER/releases")" | on_host) || return 1',
    "  printf '%s\\n' \"$listing\" | sed 's|.*/||' | grep -E '^[1-9][0-9]*-[1-9][0-9]*$' | sort -t - -k 1,1nr -k 2,2nr || true",
    "}",
    "# True when release $1 is newer than release $2.",
    "newer() {",
    "  local r1=${1%-*} a1=${1#*-} r2=${2%-*} a2=${2#*-}",
    "  ((10#$r1 > 10#$r2 || (10#$r1 == 10#$r2 && 10#$a1 > 10#$a2)))",
    "}",
    "# Points current at $1 (from the app's folder) in one rename of a new link beside it.",
    "switch_to() {",
    '  local link="$FOLDER/.opscrew-$release.link"',
    '  printf -- \'-@rm %s\\n@ln -s %s %s\\n@rename %s %s\\n\' "$(q "$link")" "$(q "$1")" "$(q "$link")" "$(q "$link")" "$(q "$FOLDER/current")" | on_host > /dev/null',
    "}",
    "# Removes the folder $1 on the host with everything in it: listed a level at a time (one",
    "# connection each, links never followed), then its files and links, then its folders deepest first.",
    "remove_tree() {",
    '  local level=("$1") folders=("$1") files=() next listing kind path i',
    '  while [ "${#level[@]}" -gt 0 ]; do',
    '    listing=$(for path in "${level[@]}"; do printf \'@ls -lan %s\\n\' "$(q "$path")"; done | on_host) || return 1',
    "    next=()",
    "    while IFS=$'\\t' read -r kind path; do",
    "      case $path in */. | */..) continue ;; esac",
    '      if [ "$kind" = d ]; then next+=("$path"); else files+=("$path"); fi',
    "    done < <(printf '%s\\n' \"$listing\" | sed -nE 's/^(.)[^ ]* +[^ ]+ +[^ ]+ +[^ ]+ +[0-9]+ +[^ ]+ +[0-9]+ +[^ ]+ (.*)$/\\1\\t\\2/p')",
    '    folders+=("${next[@]}")',
    '    level=("${next[@]}")',
    "  done",
    "  {",
    '    for path in "${files[@]}"; do printf \'@rm %s\\n\' "$(q "$path")"; done',
    '    for ((i = ${#folders[@]} - 1; i >= 0; i--)); do printf \'@rmdir %s\\n\' "$(q "${folders[i]}")"; done',
    "  } | on_host > /dev/null",
    "}",
    "# Writes state/status: the running release $1, the newest kept one older than it, the others kept,",
    "# and the attempt (release $2, its result $3, its reason $4), as the opscrew CLI reads it.",
    "write_status() {",
    '  local previous="" kept="" id ids',
    "  ids=$(release_ids) || return 1",
    "  for id in $ids; do",
    '    [ "$id" != "$1" ] || continue',
    "    kept=${kept:+$kept,}$id",
    '    if [ -z "$previous" ] && [ -n "$1" ] && newer "$1" "$id"; then previous=$id; fi',
    "  done",
    "  printf 'running=%s\\nprevious=%s\\nkept=%s\\nattempt=%s\\nresult=%s\\nreason=%s\\nat=%s\\n' \\",
    '    "$1" "$previous" "$kept" "$2" "$3" "$(one_line "$4")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$work/status.next"',
    '  local next="$FOLDER/state/status.next"',
    '  printf \'@put %s %s\\n@chmod 600 %s\\n@rename %s %s\\n\' "$(q "$work/status.next")" "$(q "$next")" "$(q "$next")" "$(q "$next")" "$(q "$FOLDER/state/status")" | on_host > /dev/null',
    "}",
    "# Ends an attempt that failed ($2 refused): says why ($1), records it, and fails the job.",
    "failed() {",
    "  local result=${2:-failed}",
    '  write_status "$running" "$release" "$result" "$1" || echo "::warning::OpsCrew couldn\'t write the host\'s state/status."',
    `  echo "::error::Release $release $result: $1. Run \\\`${status}\\\` to see what runs."`,
    "  exit 1",
    "}",
    "",
    "# 1. What runs now, and the lines that load the app's settings (none for a static site).",
    "{",
    '  printf -- \'-@get %s %s\\n\' "$(q "$FOLDER/state/status")" "$(q "$work/status")"',
    '  printf -- \'-@get %s %s\\n\' "$(q "$FOLDER/shared/env.htaccess")" "$(q "$work/env.htaccess")"',
    '  printf -- \'-@get %s %s\\n\' "$(q "$FOLDER/shared/env.user.ini")" "$(q "$work/env.user.ini")"',
    '} | on_host > /dev/null 2> "$work/sftp.err" || { cat "$work/sftp.err" >&2; exit 1; }',
    "running=$(sed -n 's/^running=//p' \"$work/status\" 2> /dev/null || true)",
    '[[ $running =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || running=""',
    "# A re-run of an earlier workflow run never deploys over a newer release (ADR 0030).",
    'if [ -n "$running" ] && ! newer "$release" "$running"; then',
    '  failed "it is older than release $running, which runs" refused',
    "fi",
    "",
    "# 2. The release's .htaccess and .user.ini: OpsCrew's block, then the app's own. HTTPS is forced",
    "# once the hostname's certificate verifies.",
    "https=no",
    `if curl -sS -o /dev/null --max-time 15 ${shellQuote(`https://${host}/`)} 2> /dev/null; then https=yes; fi`,
    `served="$work/release/"${shellQuote(webRoot)}`,
    'mkdir -p "$served"',
    "{",
    `  ${printLines(head)}`,
    `  if [ "$https" = yes ]; then ${printLines(https)}; fi`,
    `  ${printLines(rules)}`,
    `  if [ "$https" = yes ]; then ${printLines([`Header always set Strict-Transport-Security "${HSTS}"`])}; fi`,
    '  printf \'Header always set X-OpsCrew-Release "%s"\\n\' "$release"',
    '  if [ -f "$work/env.htaccess" ]; then cat "$work/env.htaccess"; fi',
    "  # A PHP app without rewrite rules of its own: a path that is no file goes to index.php.",
    `  if [ -f "$served/index.php" ] && ! grep -qiE ${shellQuote(REWRITE_RULE)} "$served/.htaccess" 2> /dev/null; then`,
    `    ${printLines(FALLBACK)}`,
    "  fi",
    "  printf '%s\\n' '# END OpsCrew'",
    '  if [ -s "$served/.htaccess" ]; then',
    "    printf '%s\\n' '# BEGIN OpsCrew: app'",
    "    sed '$a\\' \"$served/.htaccess\"",
    "    printf '%s\\n' '# END OpsCrew: app'",
    "  fi",
    '} > "$work/htaccess"',
    'mv "$work/htaccess" "$served/.htaccess"',
    'if [ -f "$work/env.user.ini" ]; then',
    "  {",
    '    cat "$work/env.user.ini"',
    '    if [ -s "$served/.user.ini" ]; then',
    "      printf '%s\\n' '; BEGIN OpsCrew: app'",
    "      sed '$a\\' \"$served/.user.ini\"",
    "      printf '%s\\n' '; END OpsCrew: app'",
    "    fi",
    '  } > "$work/user.ini"',
    '  mv "$work/user.ini" "$served/.user.ini"',
    "fi",
    "",
    "# 3. The upload into its own folder, then the switch.",
    'if ! printf \'@put -r %s %s\\n\' "$(q "$work/release")" "$(q "$FOLDER/releases/$release")" | on_host > /dev/null; then',
    '  remove_tree "$FOLDER/releases/$release" || true',
    '  failed "the upload over SFTP failed; ${running:-nothing} still runs"',
    "fi",
    "# A failed switch keeps the release: the rename may have happened before the connection broke.",
    'if ! switch_to "releases/$release"; then',
    '  failed "the switch over SFTP failed; ${running:-nothing} still runs unless the rename went through"',
    "fi",
    "",
    "# 4. The hostname asked every 5 seconds, for up to 125 seconds, until it answers 2xx or 3xx with",
    "# the release: behind LiteSpeed the first such answer counts, as does a static site's; a PHP app",
    "# elsewhere needs one past PHP's realpath cache (120 seconds), which until then can keep the old",
    "# release. CHECK_SAID holds the last answer.",
    'scheme=http; if [ "$https" = yes ]; then scheme=https; fi',
    "header_of() {",
    "  printf '%s\\n' \"$1\" | tr -d '\\r' | sed -n \"s/^$2:[[:space:]]*//Ip\" | tail -n 1",
    "}",
    "check() {",
    "  local try answer code served",
    '  CHECK_SAID="no answer"',
    "  for ((try = 1; try <= 26; try++)); do",
    '    if [ "$try" -gt 1 ]; then sleep 5; fi',
    `    if answer=$(curl -sS -o /dev/null -D - --max-time 30 "$scheme://"${shellQuote(`${host}${path}`)} 2>&1); then`,
    "      code=$(printf '%s\\n' \"$answer\" | head -n 1 | cut -d ' ' -f 2)",
    '      served=$(header_of "$answer" X-OpsCrew-Release)',
    '      CHECK_SAID="it answered $code with release ${served:-none}"',
    '      if [[ $code =~ ^[23][0-9][0-9]$ ]] && [ "$served" = "$release" ]; then',
    ...(app === "static"
      ? ["        return 0"]
      : [
          '        case $(header_of "$answer" Server) in LiteSpeed*) return 0 ;; esac',
          '        if [ "$try" -ge 25 ]; then return 0; fi',
        ]),
    "      fi",
    "    else",
    '      CHECK_SAID=$(one_line "$answer")',
    "    fi",
    "  done",
    "  return 1",
    "}",
    "if ! check; then",
    '  before="releases/${running:-0-0}"',
    '  if switch_to "$before"; then',
    '    remove_tree "$FOLDER/releases/$release" || true',
    "  else",
    '    echo "::warning::OpsCrew couldn\'t switch back to $before, so release $release stays on the host."',
    "  fi",
    `  failed ${shellQuote(`${host}${path}`)}" didn't answer 2xx or 3xx with it ($CHECK_SAID); switched back to \${running:-nothing}"`,
    "fi",
    "",
    "# The release serves: recorded first, so nothing after it can leave the status behind.",
    'write_status "$release" "$release" deployed ""',
    'echo "::notice::Release $release serves on the host."',
    "",
    `# 5. The ${KEEP} newest releases kept besides the running one; after the first, the placeholder goes.`,
    "# One the SFTP user can't remove stays, with a warning; the status then lists what is left.",
    "kept=0",
    "removed=no",
    "for id in $(release_ids); do",
    '  [ "$id" != "$release" ] || continue',
    "  kept=$((kept + 1))",
    `  [ "$kept" -gt ${KEEP} ] || continue`,
    '  if remove_tree "$FOLDER/releases/$id"; then',
    "    removed=yes",
    "  else",
    '    echo "::warning::OpsCrew couldn\'t remove release $id from the host; remove $FOLDER/releases/$id there yourself."',
    "  fi",
    "done",
    'if [ -z "$running" ]; then remove_tree "$FOLDER/releases/0-0" 2> /dev/null || true; fi',
    'if [ "$removed" = yes ]; then',
    '  write_status "$release" "$release" deployed "" || echo "::warning::OpsCrew couldn\'t list the kept releases in the host\'s state/status."',
    "fi",
  ];
}

/**
 * `cicd.workflowPath` for an app on an SFTP-only host (027 plan 10, ADR 0030 D6): on each push to
 * the deploy branch, and by hand. The build job is a panel account's ({@link releaseBuildJob});
 * the deploy job, in the deploy environment with no token permission, uploads the release and
 * switches to it over SFTP ({@link deployScript}) with the key and the host's reach from
 * {@link SFTP_DEPLOY_SECRETS}. While the environment's deploys are paused (ADR 0023), the deploy
 * job is skipped and the `paused` job says why. Static sites and plain PHP apps only.
 * @throws OpsCrewError `INVALID_INPUT` for a promoted environment; `PHASE_PRECONDITION` for any
 * target but an SFTP-only host.
 */
export function renderSftpWorkflow(
  plan: DeployPlan,
  ctx: Pick<RenderContext, "otherAppDirs"> = {},
): RenderedFile {
  const target = plan.target;
  if (
    !isHostingTarget(target) ||
    target.panel !== "sftp" ||
    (target.app !== "static" && target.app !== "php")
  ) {
    throw wrongTarget("This step only applies to a static site or a PHP app on an SFTP-only host.");
  }
  if (promoted(plan)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "An app on an SFTP-only host cannot be promoted: each environment builds its own release.",
      {
        hint: `Set environment.deploySource to { from: main } in the environment's plan, then run \`${provisionCommand(plan)}\` again.`,
      },
    );
  }
  if (plan.dns.domain === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      "OpsCrew rendered an SFTP host's workflow without the app's hostname.",
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  const environment = githubEnvironment(plan);
  const deploy = job({
    id: "deploy",
    name: `Upload the release over SFTP and switch ${plan.dns.domain} to it`,
    needs: "build",
    if: `\${{ ${unpaused(plan)} }}`,
    ...(environment === undefined ? {} : { environment }),
    permissions: [],
    steps: [
      `- uses: ${ACTIONS.downloadArtifact}`,
      "  with:",
      `    name: ${RELEASE_ARTIFACT}`,
      "    path: ${{ runner.temp }}",
      "- name: Upload, switch and check the release",
      // The check waits up to about 2 minutes, a switch back and the removals a few more.
      "  timeout-minutes: 30",
      "  env:",
      `    SFTP_URL: ${secret(plan, SFTP_DEPLOY_SECRETS.url)}`,
      `    SFTP_KEY: ${secret(plan, SFTP_DEPLOY_SECRETS.privateKey)}`,
      `    KNOWN_HOSTS: ${secret(plan, SFTP_DEPLOY_SECRETS.knownHosts)}`,
      ...run(deployScript(plan, target.webRoot, target.app)),
    ],
  });
  const lines = [
    ...workflowStart(
      plan,
      [
        `# Builds the app and uploads each release over SFTP to its own folder on your host, switches`,
        `# ${plan.dns.domain} to it in one step, checks it, and switches back on a failure. The SFTP key is`,
        `# a secret of the ${environmentName(plan)} environment's deploys, which can change every file of that SFTP user.`,
      ],
      pushPaths(plan, [], ctx),
      DISPATCH_BY_HAND,
    ),
    ...pausedJob(plan),
    "",
    ...releaseBuildJob(plan, target),
    "",
    ...deploy,
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
