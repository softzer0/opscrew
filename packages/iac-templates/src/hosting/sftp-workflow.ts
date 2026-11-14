// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { escapeRegExp, OpsCrewError } from "@opscrew/core";
import { cleanRepoPath, type DeployPlan, isHostingTarget } from "@opscrew/plan-schema";
import { wrongTarget } from "../providers";
import { shellQuote } from "../runtime/services";
import type { RenderContext, RenderedFile } from "../types";
import { unpaused } from "../workflow/pause";
import {
  deploySecretName,
  environmentName,
  githubEnvironment,
  healthPath,
  job,
  opscrew,
  provisionCommand,
  run,
  secret,
} from "../workflow/shared";
import {
  FALLBACK,
  HEADER_OF,
  HOSTING_KEEP,
  HSTS_LINE,
  HTACCESS_RULES,
  healthCheck,
  NEWER,
  NEWEST_FIRST,
  ONE_LINE,
  PACKAGES_REFUSED,
  PHP_MODULES,
  printLines,
  REVALIDATE_PATH,
  REWRITE_RULE,
  STATUS_LINES,
} from "./shell";
import { DOWNLOAD_RELEASE, hostingDomain, hostingWorkflowFile } from "./workflow";

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

/**
 * The app's kept folders on a hosting account, relative to its release: the plan's
 * `storage.files.dir` and `storage.sqlite.dir`, which a server keeps in volumes. Each lives in the
 * app's `shared/` and is linked into every release, so what the app writes there outlives it: by
 * the agent on a panel account (its shared paths), by the deploy on an SFTP-only host.
 */
export function hostingKeptFolders(plan: Pick<DeployPlan, "storage">): string[] {
  return [plan.storage?.files?.dir, plan.storage?.sqlite?.dir].flatMap((dir) =>
    dir === undefined ? [] : [cleanRepoPath(dir)],
  );
}

/**
 * The PHP lines a PHP app's releases get on an SFTP-only host (027 plan 10):
 * `shared/env.htaccess`, inside OpsCrew's `.htaccess` block, and `shared/env.user.ini`, the
 * release's `.user.ini` block. Each turns `opcache.revalidate_path` on, so a switch reaches every
 * PHP process once PHP's path cache expires (research R16), and loads the app's settings from
 * `envPhp` (`shared/env.php`'s path as PHP sees it). `opscrew provision` writes them beside
 * `env.php`; the deploy reads them, so no path of the host's is in the repository. As the agent's
 * on a panel account.
 */
export function renderSftpPhpLines(envPhp: string): { htaccess: string; userIni: string } {
  if (!/^\/[^"\0\r\n]*$/.test(envPhp)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `env.php's path must be absolute, without quotes or line breaks (${JSON.stringify(envPhp)}).`,
    );
  }
  return {
    htaccess: PHP_MODULES.map(
      (module) =>
        `<IfModule ${module}>\n${REVALIDATE_PATH.htaccess}\nphp_value auto_prepend_file "${envPhp}"\n</IfModule>\n`,
    ).join(""),
    userIni: `; BEGIN OpsCrew\n${REVALIDATE_PATH.userIni}\nauto_prepend_file = "${envPhp}"\n; END OpsCrew\n`,
  };
}

/**
 * The deploy step's lines for the app's kept folders ({@link hostingKeptFolders}), none without
 * one, as the agent's shared paths on a panel account. Before the upload (`prepare`), a folder
 * `shared/` holds already is left out of the release, and one it doesn't hold yet is in it (an
 * empty one when the app has none). After the upload (`link`), each new one is renamed into
 * `shared/` (a rename never replaces a folder that holds files), and the release gets every kept
 * folder as a relative link to `shared/<folder>`, as the agent's `../../shared/<folder>`.
 */
function keptFolderLines(kept: readonly string[]): { prepare: string[]; link: string[] } {
  if (kept.length === 0) return { prepare: [], link: [] };
  return {
    prepare: [
      "# The app's kept folders, as a server's volumes: one shared/ holds already stays out of the",
      "# release, which links it; on the first deploy the release's folder (or an empty one) moves there.",
      `kept=(${kept.map(shellQuote).join(" ")})`,
      "new=()",
      'for dir in "${kept[@]}"; do',
      '  if printf \'@ls -1a %s\\n\' "$(q "$FOLDER/shared/$dir")" | on_host > /dev/null 2>&1; then',
      '    rm -rf "${work:?}/release/$dir"',
      '    mkdir -p "$(dirname "$work/release/$dir")"',
      "  else",
      '    mkdir -p "$work/release/$dir"',
      '    new+=("$dir")',
      "  fi",
      "done",
    ],
    link: [
      "# The new kept folders moved into shared/ (its parents made first), then each linked from the",
      "# release, relative: releases/<id>/<folder> leads to ../../shared/<folder>, one ../ more per /.",
      "link_kept() {",
      "  local dir path left up",
      "  {",
      '    for dir in "${new[@]}"; do',
      '      path="$FOLDER/shared"',
      "      left=$dir",
      "      while [[ $left == */* ]]; do",
      '        path="$path/${left%%/*}"',
      "        left=${left#*/}",
      '        printf -- \'-@mkdir %s\\n\' "$(q "$path")"',
      "      done",
      '      printf \'@rename %s %s\\n\' "$(q "$FOLDER/releases/$release/$dir")" "$(q "$FOLDER/shared/$dir")"',
      "    done",
      '    for dir in "${kept[@]}"; do',
      "      up=$(printf '%s' \"$dir\" | sed 's|[^/]||g; s|/|../|g')",
      '      printf \'@ln -s %s %s\\n\' "$(q "../../${up}shared/$dir")" "$(q "$FOLDER/releases/$release/$dir")"',
      "    done",
      '  } | on_host > /dev/null 2> "$work/sftp.err" || { cat "$work/sftp.err" >&2; return 1; }',
      "}",
      "if ! link_kept; then",
      '  remove_tree "$FOLDER/releases/$release" || true',
      "  failed \"the app's kept folders couldn't be moved into or linked from shared/ over SFTP; ${running:-nothing} still runs\"",
      "fi",
    ],
  };
}

/**
 * The deploy step's script (027 plan 10), over SFTP alone: the host's `state/status` and OpsCrew's
 * PHP lines read; the release's `.htaccess` (OpsCrew's block, then the app's own) and `.user.ini`
 * composed; the release uploaded into `releases/<run id>-<attempt>/`, with the app's kept folders
 * ({@link keptFolderLines}) linked from `shared/`; `current` switched to it
 * with `ln -s` and `rename` (OpenSSH's posix-rename, one step); the hostname asked until it serves
 * the release ({@link healthCheck}); then the newest {@link HOSTING_KEEP} other releases kept, or on
 * a failure `current` switched back and the release removed; `state/status` written either way.
 */
function deployScript(
  plan: DeployPlan,
  host: string,
  webRoot: string,
  app: "static" | "php",
): string[] {
  const url = shellQuote(`${host}${healthPath(plan)}`);
  const head = [
    "# BEGIN OpsCrew",
    "RewriteEngine On",
    `RewriteCond %{HTTP_HOST} !^${escapeRegExp(host)}(:[0-9]+)?$ [NC]`,
    "RewriteRule ^ - [F]",
  ];
  const https = [
    "RewriteCond %{HTTPS} !=on",
    `RewriteRule ^ https://${host}%{REQUEST_URI} [R=301,L]`,
  ];
  const rules = [...(webRoot === "." ? [PACKAGES_REFUSED] : []), ...HTACCESS_RULES];
  const status = opscrew(plan, "status");
  const kept = keptFolderLines(hostingKeptFolders(plan));
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
    ...ONE_LINE.split("\n"),
    ...NEWEST_FIRST.split("\n"),
    "# The releases on the host, newest first.",
    "release_ids() {",
    "  local listing",
    '  listing=$(printf \'@ls -1a %s\\n\' "$(q "$FOLDER/releases")" | on_host) || return 1',
    "  printf '%s\\n' \"$listing\" | sed 's|.*/||' | newest_first",
    "}",
    ...NEWER.split("\n"),
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
    ...STATUS_LINES.split("\n"),
    "# Writes state/status (status_lines) for the running release $1 and the attempt: release $2, its",
    "# result $3 and its reason $4.",
    "write_status() {",
    '  local ids next="$FOLDER/state/status.next"',
    "  ids=$(release_ids) || return 1",
    '  status_lines "$1" "$2" "$3" "$4" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" $ids > "$work/status.next"',
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
    "# 1. What runs now, and the PHP lines provision wrote (none for a static site).",
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
    `  if [ "$https" = yes ]; then ${printLines([HSTS_LINE])}; fi`,
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
    ...kept.prepare,
    'if ! printf \'@put -r %s %s\\n\' "$(q "$work/release")" "$(q "$FOLDER/releases/$release")" | on_host > /dev/null; then',
    '  remove_tree "$FOLDER/releases/$release" || true',
    '  failed "the upload over SFTP failed; ${running:-nothing} still runs"',
    "fi",
    ...kept.link,
    "# A failed switch keeps the release: the rename may have happened before the connection broke.",
    'if ! switch_to "releases/$release"; then',
    '  failed "the switch over SFTP failed; ${running:-nothing} still runs unless the rename went through"',
    "fi",
    "",
    "# 4. The check on the hostname, with the PHP lines' opcache.revalidate_path for a PHP app.",
    'scheme=http; if [ "$https" = yes ]; then scheme=https; fi',
    ...HEADER_OF.split("\n"),
    ...healthCheck(`"$scheme://"${url}`, app === "php").split("\n"),
    'if ! health_check "$release"; then',
    '  before="releases/${running:-0-0}"',
    '  if switch_to "$before"; then',
    '    remove_tree "$FOLDER/releases/$release" || true',
    "  else",
    '    echo "::warning::OpsCrew couldn\'t switch back to $before, so release $release stays on the host."',
    "  fi",
    `  failed ${url}" didn't answer 2xx or 3xx with it ($CHECK_SAID); switched back to \${running:-nothing}"`,
    "fi",
    "",
    "# The release serves: recorded first, so nothing after it can leave the status behind.",
    'write_status "$release" "$release" deployed ""',
    'echo "::notice::Release $release serves on the host."',
    "",
    `# 5. The ${HOSTING_KEEP} newest releases kept besides the running one; after the first, the placeholder goes.`,
    "# One the SFTP user can't remove stays, with a warning; the status then lists what is left.",
    "kept=0",
    "removed=no",
    "for id in $(release_ids); do",
    '  [ "$id" != "$release" ] || continue',
    "  kept=$((kept + 1))",
    `  [ "$kept" -gt ${HOSTING_KEEP} ] || continue`,
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
 * the deploy branch, and by hand. The build job is a panel account's ({@link hostingWorkflowFile});
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
  const domain = hostingDomain(plan, "an SFTP-only host");
  const environment = githubEnvironment(plan);
  const deploy = job({
    id: "deploy",
    name: `Upload the release over SFTP and switch ${domain} to it`,
    needs: "build",
    if: `\${{ ${unpaused(plan)} }}`,
    ...(environment === undefined ? {} : { environment }),
    permissions: [],
    steps: [
      ...DOWNLOAD_RELEASE,
      "- name: Upload, switch and check the release",
      // The check waits up to about 2 minutes, a switch back and the removals a few more.
      "  timeout-minutes: 30",
      "  env:",
      `    SFTP_URL: ${secret(plan, SFTP_DEPLOY_SECRETS.url)}`,
      `    SFTP_KEY: ${secret(plan, SFTP_DEPLOY_SECRETS.privateKey)}`,
      `    KNOWN_HOSTS: ${secret(plan, SFTP_DEPLOY_SECRETS.knownHosts)}`,
      ...run(deployScript(plan, domain, target.webRoot, target.app)),
    ],
  });
  return hostingWorkflowFile(
    plan,
    ctx,
    [
      `# Builds the app and uploads each release over SFTP to its own folder on your host, switches`,
      `# ${domain} to it in one step, checks it, and switches back on a failure. The SFTP key is`,
      `# a secret of the ${environmentName(plan)} environment's deploys, which can change every file of that SFTP user.`,
    ],
    target,
    [deploy],
  );
}
