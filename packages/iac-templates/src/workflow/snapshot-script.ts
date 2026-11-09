// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import {
  APP_SERVER,
  type DeployPlan,
  keepSnapshotsOf,
  snapshotOffsiteOf,
  snapshotScheduleOf,
  targetArch,
} from "@opscrew/plan-schema";
import { offsiteExpires } from "../infra/storage";
import { AGE_BINARY, ageFunctions, OFFSITE_PREFIX, rcloneSettings } from "../offsite";
import { IMAGES } from "../pins";
import { PORTAINER_OFFSITE_VARIABLES } from "../portainer-target/snapshots";
import { extraServer } from "../runtime/components";
import { shellQuote } from "../runtime/services";
import { planFilePath, printfFormat, said } from "./shared";
import {
  holdsData,
  SNAPSHOT_LOG,
  SNAPSHOT_SCRIPT,
  SNAPSHOTS_DIR,
  scheduleHours,
  snapshotFunctions,
  snapshotParts,
} from "./snapshots";
import {
  appFolder,
  approvalExpiry,
  EDGE_FUNCTION,
  holdApp,
  holdRequests,
  RESTORE_HELD,
  readApproval,
  recordRunning,
  resumeApp,
  rotationHeldFunction,
  SCRIPT_ROOTS,
  serverWords,
  startApp,
  startLock,
  stopApp,
} from "./switch";

/**
 * The one-time approval of `snapshot.sh restore` (024 plan.md 6.), in the app's folder on the
 * server the restore runs on; `opscrew restore` writes it after the user's approval, and the
 * script reads and removes it before any change.
 */
export const RESTORE_APPROVAL_FILE = ".restore-snapshot";

/**
 * The line of {@link RESTORE_APPROVAL_FILE}, without its newline: the snapshot's id, the one
 * service `--only` restores (`-` for every one) and the time it expires, in Unix seconds.
 */
export function restoreApprovalLine(
  id: string,
  only: string | undefined,
  expiresAt: number,
): string {
  return `${id} ${only ?? "-"} ${expiresAt}`;
}

/**
 * The exit code of `snapshot.sh restore` when the restore failed and putting the data back as it
 * was before failed too: the data may be partly changed, and the app was not started.
 */
export const RESTORE_STUCK = 5;

/** Where the last scheduled snapshot's output is, in the app's folder: its id, or why it failed. */
export const SCHEDULED_LOG = `${SNAPSHOTS_DIR}/scheduled.log`;

/**
 * The off-server copy's env file in the app's folder on each server with data (mode 600, 024
 * plan.md 7.), as the deploy writes it from {@link OFFSITE_ENV_SECRET}: `NAME=value` lines of
 * Portainer's variables (`PORTAINER_OFFSITE_VARIABLES`: the bucket's S3 endpoint, its key and the
 * recovery copy's age recipient). It reaches the upload's container only through `docker run
 * --env-file`, never a command line.
 */
export const OFFSITE_ENV_FILE = "offsite.env";

/** The GitHub Actions secret holding {@link OFFSITE_ENV_FILE}; `opscrew provision` sets it. */
export const OFFSITE_ENV_SECRET = "OPSCREW_OFFSITE_ENV";

/**
 * The last off-server copy's output, in the app's folder. Only its last error line
 * ({@link OFFSITE_ERROR_LINES}) is printed, in the failure's message.
 */
export const OFFSITE_LOG = `${SNAPSHOTS_DIR}/offsite.log`;

/**
 * The lines of {@link OFFSITE_LOG} that say what failed (`grep -E`): rclone's errors and its
 * `Failed to …` summary, Docker's, age's and the script's own. rclone and Docker never print the
 * key they were given.
 */
const OFFSITE_ERROR_LINES = "(ERROR|CRITICAL) *: |Failed to |^OpsCrew: |^docker: |^age: ";

/** The folder in the app's folder where the script keeps the age release archive it fetched. */
const AGE_DIR = ".offsite";

/**
 * How many more times, and how far apart, the upload sends what a node that does not know the
 * bucket yet refused: for 15 minutes, the time some of Hetzner's nodes take to know a new bucket.
 */
const LATE_BUCKET_TRIES = 15;
const LATE_BUCKET_WAIT_SECONDS = 60;

/**
 * The off-server copy's functions (024 plan.md 7., D10, D16) on `server`, when `snapshots.offsite`
 * is on; none otherwise.
 *
 * `snapshot_offsite <id>` copies the complete snapshot `.snapshots/<id>` to the bucket, from a
 * one-off of the pinned rclone image as the deploy user, with {@link OFFSITE_ENV_FILE} as its
 * environment and the plan's region:
 * - age of the server's architecture is made ready (`ageFunctions`: its release archive in
 *   {@link AGE_DIR} checked against its pinned SHA-256, fetched when missing or changed, and its
 *   binary unpacked for this upload only);
 * - the id's `about.json.age` goes first, so a copy that fails part-way never looks complete;
 * - each file `about.json` names, then `about.json`, streams through `age -r <recipient>` into
 *   `rclone rcat` as `backups/<id>/<file>.age` (an extra server's under `backups/<id>/<server>/`);
 * - for up to 15 minutes, a minute apart, the deletion and each file are sent again while the
 *   bucket answers NoSuchBucket, or rclone's read of an upload finds no object: some of Hetzner's
 *   nodes know a new bucket only that long after it is created;
 * - where the bucket expires nothing itself ({@link offsiteExpires}), the copies older than
 *   `snapshots.offsite.days` are deleted after the upload.
 * Then the snapshot gets `offsite.done`. A snapshot that holds no file has nothing to copy. The
 * output goes to {@link OFFSITE_LOG}; a failure is a message on stderr, with the log's last error
 * line, and returns 1, and a failed deletion only warns.
 *
 * `snapshot_offsite_pending` copies, newest first, each complete snapshot by hand or on the
 * schedule that holds a file, has no `offsite.done` yet and was taken within the retention, and
 * stops at the first that fails (the others would fail alike): a failed copy is tried again at the
 * next `take`. Snapshots before a release stay on the server for the rollback.
 */
function offsiteFunctions(plan: DeployPlan, server: string): string[] {
  const copy = snapshotOffsiteOf(plan);
  if (copy === undefined) return [];
  const folder = appFolder(plan);
  const where = serverWords(server);
  // An extra server's architecture, as `targetArch` reads the app's: an own server's, else amd64.
  const extra = server === APP_SERVER ? undefined : extraServer(plan, server).target;
  const arch =
    extra === undefined ? targetArch(plan.target) : "arch" in extra ? extra.arch : "amd64";
  const v = PORTAINER_OFFSITE_VARIABLES;
  const remote = `offsite:${copy.bucket}/${OFFSITE_PREFIX}`;
  const login = [
    `RCLONE_CONFIG_OFFSITE_ENDPOINT="$${v.endpoint}"`,
    `RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$${v.accessKeyId}"`,
    `RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$${v.secretAccessKey}"`,
  ];
  const days = offsiteExpires(copy.provider) ? undefined : copy.days;
  // One line: the deploy embeds the script in its YAML one line at a time. `$1` is the objects'
  // folder under the prefix, the others the snapshot's files; exit 4: only the deletion failed.
  const upload = [
    "set -o pipefail",
    "umask 077",
    `export HOME=/tmp ${login.join(" ")}`,
    ...ageFunctions(arch),
    "age_ready || exit 1",
    'to="$1"',
    "shift",
    // `late` runs its command again while a node that does not know the new bucket yet answers:
    // NoSuchBucket, or no object when rclone reads an upload back. Any other failure returns.
    `late() { n=0; until "$@" 2> /tmp/rclone.log; do rc=$?; cat /tmp/rclone.log >&2; grep -qE 'NoSuchBucket|object not found' /tmp/rclone.log && [ "$n" -lt ${LATE_BUCKET_TRIES} ] || return "$rc"; n=$((n + 1)); sleep ${LATE_BUCKET_WAIT_SECONDS}; done; cat /tmp/rclone.log >&2; }`,
    // rclone exits 4 when the object to delete is not there.
    `unmark() { rclone deletefile ${shellQuote(`${remote}/`)}"$to/about.json.age" || [ "$?" -eq 4 ]; }`,
    `put() { ${AGE_BINARY} -r "$${v.recipient}" < /snapshot/"$1" | rclone rcat ${shellQuote(`${remote}/`)}"$to/$1.age"; }`,
    "late unmark || exit 1",
    'for f in "$@" about.json; do late put "$f" || exit 1; done',
    ...(days === undefined
      ? []
      : [`rclone delete --min-age ${days}d ${shellQuote(remote)} || exit 4`]),
  ].join("; ");
  const to = server === APP_SERVER ? '"$1"' : `"$1"/${server}`;
  // `%s` and `%s`: the app's folder, then `; its last error: <line>` or `.`.
  const log = `The upload's output is in %s/${OFFSITE_LOG}%s`;
  const environment = Object.entries(rcloneSettings(copy)).flatMap(([name, value]) => [
    "-e",
    shellQuote(`${name}=${value}`),
  ]);
  return [
    "snapshot_offsite() {",
    `  if [ ! -f ${OFFSITE_ENV_FILE} ]; then`,
    `    ${said(`The off-server copy is on, but ${where} has no ${OFFSITE_ENV_FILE} with its bucket's key yet, so the snapshot %s was not copied off the server. Run opscrew provision, then deploy again.`)} "$1" >&2`,
    "    return 1",
    "  fi",
    '  if ! snapshot_complete "$1"; then',
    `    ${said(`The snapshot %s is not complete on ${where}, so it was not copied off the server.`)} "$1" >&2`,
    "    return 1",
    "  fi",
    `  _offsite_files="$(grep -o '"file":"[^"]*"' ${SNAPSHOTS_DIR}/"$1"/about.json | cut -d '"' -f 4 || :)"`,
    '  if [ -z "$_offsite_files" ]; then',
    `    ${said(`The snapshot %s holds no copy of any service on ${where}, so there is nothing to copy off the server.`)} "$1" >&2`,
    "    return 0",
    "  fi",
    `  (umask 077 && mkdir -p ${AGE_DIR} && : > ${OFFSITE_LOG}) || return 1`,
    `  rm -f ${SNAPSHOTS_DIR}/"$1"/offsite.done`,
    "  _offsite_rc=0",
    `  docker run --rm --env-file ${OFFSITE_ENV_FILE} ${environment.join(" ")} --user "$(id -u):$(id -g)" -v ${folder}/${SNAPSHOTS_DIR}/"$1":/snapshot:ro -v ${folder}/${AGE_DIR}:/tools --entrypoint sh ${IMAGES.rclone.ref} -c ${shellQuote(upload)} sh ${to} $_offsite_files < /dev/null >> ${OFFSITE_LOG} 2>&1 || _offsite_rc=$?`,
    '  if [ "$_offsite_rc" -ne 0 ]; then',
    `    _offsite_error="$(grep -E ${shellQuote(OFFSITE_ERROR_LINES)} ${OFFSITE_LOG} | tail -n 1 | cut -c 1-500 || :)"`,
    '    if [ -n "$_offsite_error" ]; then _offsite_error="; its last error: $_offsite_error"; else _offsite_error="."; fi',
    "  fi",
    '  if [ "$_offsite_rc" -ne 0 ] && [ "$_offsite_rc" -ne 4 ]; then',
    `    ${said(`Copying the snapshot %s off the server failed, so the bucket has no complete copy of it yet; the snapshot itself stays on ${where}, and the next snapshot tries again. ${log}`)} "$1" ${folder} "$_offsite_error" >&2`,
    "    return 1",
    "  fi",
    `  (umask 077 && : > ${SNAPSHOTS_DIR}/"$1"/offsite.done) || return 1`,
    ...(days === undefined
      ? []
      : [
          '  if [ "$_offsite_rc" -eq 4 ]; then',
          `    ${said(`OpsCrew copied the snapshot %s off the server, but could not delete the copies there older than ${days} days. ${log}`)} "$1" ${folder} "$_offsite_error" >&2`,
          "  fi",
        ]),
    "}",
    "snapshot_offsite_pending() {",
    `  _pending_since=$(( $(date +%s) - ${copy.days * 86_400} ))`,
    `  for _pending in ${SNAPSHOTS_DIR}/*/about.json; do`,
    '    _pending_dir="${_pending%/about.json}"',
    '    case "$_pending_dir" in *.partial | *.taking) continue ;; esac',
    '    if [ -e "$_pending_dir"/offsite.done ] || [ ! -f "$_pending_dir"/taken ]; then continue; fi',
    `    if grep -qF '"kind":"release"' "$_pending" || ! grep -qF '"file":' "$_pending"; then continue; fi`,
    `    echo "$(cat "$_pending_dir"/taken) \${_pending_dir#${SNAPSHOTS_DIR}/}"`,
    "  done | sort -r | while read -r _pending_taken _pending_id; do",
    '    if [ "$(date -u -d "$_pending_taken" +%s)" -ge "$_pending_since" ]; then',
    '      snapshot_offsite "$_pending_id" || break',
    "    fi",
    "  done",
    "}",
  ];
}

/** The services of the stop-only kinds on `server` among `names`, in the plan's order. */
function stopOnly(plan: DeployPlan, server: string, names: readonly string[]): string {
  return snapshotParts(plan, server)
    .filter((part) => !part.online && names.includes(part.name))
    .map((part) => part.name)
    .join(" ");
}

/** The lines that keep the newest `keep` release snapshots (named by their image digest). */
function pruneReleases(keep: number): string[] {
  return [
    `  for _each in ${SNAPSHOTS_DIR}/*/taken; do`,
    '    _folder="${_each%/taken}"',
    `    case "\${_folder#${SNAPSHOTS_DIR}/}" in *[!0-9a-f]*) continue ;; esac`,
    '    if [ -f "$_each" ]; then echo "$(cat "$_each") $_folder"; fi',
    `  done | sort -r | sed '1,${keep}d' | while read -r _ _folder; do rm -rf "$_folder"; done`,
  ];
}

/** The lines that keep the newest `keep` scheduled snapshots (named by their time). */
function pruneScheduled(keep: number): string[] {
  return [
    `  for _each in ${SNAPSHOTS_DIR}/*/about.json; do`,
    `    if grep -qF '"kind":"scheduled"' "$_each" 2> /dev/null; then echo "\${_each%/about.json}"; fi`,
    `  done | sort -r | sed '1,${keep}d' | while read -r _folder; do rm -rf "$_folder"; done`,
  ];
}

/**
 * `snapshot_cmd_take <manual|release|scheduled> [--skip <service>]... [--stop <service>]...
 * [--id <id>] [--version sha256:<hex>]`:
 * - the version that runs is `--version`'s, or `snapshot_version`'s (`.env`'s digest, `.running`
 *   on an extra server, or a local build's image ID on this computer);
 * - the snapshot's id is `--id` (one id for the parts on several servers, D8), or the version's
 *   digest for `release`, the hour of the schedule's slot for `scheduled` (outside the schedule's
 *   hours, or once that slot is taken, it does nothing; its output goes to {@link SCHEDULED_LOG}),
 *   and the time for `manual` (a manual one never replaces another);
 * - it copies every part but those `--skip` names, and of the stop-only ones only those named for
 *   its kind (`deploy.snapshotStop`, `snapshots.schedule.stop`) or with `--stop`; the others it
 *   lists as left out.
 * While a credential rotation holds the app, one by hand is refused and a scheduled one is skipped
 * with a warning in its log (T2514): the services' data may be part-way between two values.
 * On success it keeps only the newest release or scheduled snapshots and prints the id.
 */
function takeCommand(plan: DeployPlan, server: string): string[] {
  const folder = appFolder(plan);
  const schedule = snapshotScheduleOf(plan);
  const file = planFilePath(plan);
  return [
    "snapshot_cmd_take() {",
    '  _kind="${1:-}"',
    '  case "$_kind" in manual | release | scheduled) shift ;; *) snapshot_usage; return 1 ;; esac',
    `  if [ "$_kind" = manual ] && snapshot_rotation_held ${shellQuote("OpsCrew took no snapshot: ")}; then return 1; fi`,
    '  case "$_kind" in',
    `    release) _stop=${shellQuote(stopOnly(plan, server, plan.deploy.snapshotStop ?? []))} ;;`,
    `    scheduled) _stop=${shellQuote(stopOnly(plan, server, schedule?.stop ?? []))} ;;`,
    '    *) _stop="" ;;',
    "  esac",
    '  _skip=""; _id=""; _hex="$(snapshot_version)"',
    '  while [ "$#" -gt 0 ]; do',
    '    [ "$#" -ge 2 ] || { snapshot_usage; return 1; }',
    '    case "$1" in',
    '      --skip) snapshot_known "$2" || return 1; _skip="$_skip $2" ;;',
    "      --stop)",
    '        snapshot_known "$2" || return 1',
    '        case " $SNAPSHOT_ONLINE " in *" $2 "*)',
    `          printf ${printfFormat("%s is copied while it runs, so it never stops: leave out --stop %s.")} "$2" "$2" >&2`,
    "          return 1 ;;",
    "        esac",
    '        _stop="$_stop $2" ;;',
    '      --id) snapshot_id "$2" || return 1; _id="$2" ;;',
    "      --version)",
    '        case "$2" in sha256:*) _hex="${2#sha256:}" ;; *) _hex="" ;; esac',
    '        case "$_hex" in *[!0-9a-f]*) _hex="" ;; esac',
    '        if [ "${#_hex}" -ne 64 ]; then',
    `          echo ${shellQuote("--version needs an image digest: sha256: and 64 lower-case hexadecimal digits.")} >&2`,
    "          return 1",
    "        fi ;;",
    "      *) snapshot_usage; return 1 ;;",
    "    esac",
    "    shift 2",
    "  done",
    '  case "$_kind" in',
    "    release)",
    '      if [ -z "$_hex" ]; then',
    `        echo ${shellQuote("No version runs here by its image digest (the app's .env, or .running on an extra server), and no --version names one, so there is no release to take a snapshot of.")} >&2`,
    "        return 1",
    "      fi",
    '      _id="${_id:-$_hex}" ;;',
    "    scheduled)",
    ...(schedule === undefined
      ? [
          `      echo ${shellQuote(`Scheduled snapshots are off (snapshots.schedule in ${file}).`)} >&2`,
          "      return 1 ;;",
        ]
      : [
          "      _hour=$(( $(date +%s) / 3600 ))",
          `      if [ $(( _hour % ${scheduleHours(schedule.every)} )) -ne 0 ]; then return 0; fi`,
          '      _id="${_id:-$(date -u -d "@$(( _hour * 3600 ))" +%Y%m%dT%H%M%SZ)}"',
          // A deploy held the lock past the slot's tick, or the slot ran already.
          `      if [ -e ${SNAPSHOTS_DIR}/"$_id" ]; then return 0; fi`,
          `      (umask 077 && mkdir -p ${SNAPSHOTS_DIR} && : > ${SCHEDULED_LOG})`,
          `      exec >> ${SCHEDULED_LOG} 2>&1`,
          `      if snapshot_rotation_held ${shellQuote("Warning: OpsCrew skipped this scheduled snapshot: ")}; then return 0; fi ;;`,
        ]),
    "    *)",
    `      if [ -n "$_id" ] && [ -e ${SNAPSHOTS_DIR}/"$_id" ]; then`,
    `        ${said(`There is already a snapshot %s on ${serverWords(server)}.`)} "$_id" >&2`,
    "        return 1",
    "      fi",
    '      _id="${_id:-$(snapshot_new_id)}" ;;',
    "  esac",
    '  _parts=""',
    "  for _each in $SNAPSHOT_PARTS; do",
    '    case " $_skip " in *" $_each "*) continue ;; esac',
    '    case " $SNAPSHOT_ONLINE $_stop " in *" $_each "*) _parts="$_parts $_each"; continue ;; esac',
    '    case "$_kind" in',
    `      manual) printf ${printfFormat("%s was left out: it must stop for its copy. Name it with --stop %s to stop it for its copy.")} "$_each" "$_each" >&2 ;;`,
    `      release) printf ${printfFormat(`%s was left out of the snapshot before this release: it must stop for its copy. Name it in deploy.snapshotStop in ${file} to copy it before each release.`)} "$_each" >&2 ;;`,
    `      scheduled) printf ${printfFormat(`%s was left out of the scheduled snapshot: it must stop for its copy. Name it in snapshots.schedule.stop in ${file} to copy it on the schedule.`)} "$_each" >&2 ;;`,
    "    esac",
    "  done",
    "  _rc=0",
    '  snapshot_take "$_id" "$_kind" "$_hex" $_parts || _rc=$?',
    '  if [ "$_rc" -eq 2 ]; then',
    `    printf ${printfFormat("The disk that holds %s has less than 1 GiB or 10%% free, so OpsCrew took no snapshot. Free some space, or delete snapshots you no longer need (opscrew snapshot delete).")} ${folder} >&2`,
    "    return 2",
    "  fi",
    '  if [ "$_rc" -ne 0 ]; then',
    `    printf ${printfFormat(`OpsCrew took no snapshot. The output of the copies stays on the server in %s/${SNAPSHOT_LOG} (it can quote data, so it is not printed here).`)} ${folder} >&2`,
    "    return 1",
    "  fi",
    '  case "$_kind" in',
    "    release)",
    ...pruneReleases(keepSnapshotsOf(plan)).map((line) => `    ${line}`),
    "      ;;",
    ...(schedule === undefined
      ? []
      : [
          "    scheduled)",
          ...pruneScheduled(schedule.keep).map((line) => `    ${line}`),
          "      ;;",
        ]),
    "  esac",
    '  echo "$_id"',
    "}",
  ];
}

/**
 * `snapshot_cmd_restore <id> [--only <service>] [--no-wait <service>]...` (024 plan.md 3. and 6.): refuses before any change
 * without the one-time approval for exactly this restore ({@link RESTORE_APPROVAL_FILE}, read and
 * removed at once, as the rollback's), while a credential rotation holds the app
 * ({@link ROTATION_STOP}), or when the snapshot is not complete. On the app's server
 * the app's requests wait and its web, workers and cron stop ({@link holdRequests},
 * {@link stopApp}); after `hold` ({@link RESTORE_HELD}) they stay held, and the app is not started again
 * by the restore either way. Then the parts it restores are copied as they are now (a `manual`
 * snapshot), and each is restored exactly. Once that copy is taken, `saved <id>` on stdout names
 * it. When a restore fails, that copy is put back (exit 1); the app starts again, unless held or the
 * put-back failed too ({@link RESTORE_STUCK}). Each outcome is a message on stderr. On an extra
 * server it neither holds nor stops the app: the CLI holds it first (D8).
 */
function restoreCommand(plan: DeployPlan, server: string): string[] {
  const folder = appFolder(plan);
  const app = server === APP_SERVER;
  const file = RESTORE_APPROVAL_FILE;
  const start = app ? [`    if [ -z "$_held" ]; then ${startApp(plan)}; fi`] : [];
  const note = `The output of the copies and restores stays on the server in %s/${SNAPSHOT_LOG} (it can quote data, so it is not printed here).`;
  return [
    "snapshot_cmd_restore() {",
    '  [ "$#" -ge 1 ] || { snapshot_usage; return 1; }',
    '  _id="$1"',
    "  shift",
    '  snapshot_id "$_id" || return 1',
    '  _only=""; _nowait=""',
    '  while [ "$#" -gt 0 ]; do',
    '    [ "$#" -ge 2 ] || { snapshot_usage; return 1; }',
    '    snapshot_known "$2" || return 1',
    '    case "$1" in',
    '      --only) [ -z "$_only" ] || { snapshot_usage; return 1; }; _only="$2" ;;',
    '      --no-wait) _nowait="$_nowait $2" ;;',
    "      *) snapshot_usage; return 1 ;;",
    "    esac",
    "    shift 2",
    "  done",
    `  if [ ! -f ${file} ]; then`,
    `    echo ${shellQuote(`A restore needs its one-time approval on this server (${file}), which opscrew restore writes once you approve it, so nothing was changed. Run opscrew restore.`)} >&2`,
    "    return 1",
    "  fi",
    ...readApproval(file).map((line) => `  ${line}`),
    '  if [ "$approved" != "$_id" ] || [ "$choice" != "${_only:--}" ]; then',
    `    echo ${shellQuote(`The one-time approval on this server (${file}) is for another restore, so OpsCrew removed it and changed nothing. Run opscrew restore again.`)} >&2`,
    "    return 1",
    "  fi",
    ...approvalExpiry([
      `echo ${shellQuote("The one-time approval of this restore expired before it started, so nothing was changed. Run opscrew restore again.")} >&2`,
      "return 1",
    ]).map((line) => `  ${line}`),
    `  ${ROTATION_STOP}`,
    '  if ! snapshot_complete "$_id"; then',
    `    ${said("The snapshot %s is not complete on this server, so nothing was changed.")} "$_id" >&2`,
    "    return 1",
    "  fi",
    '  if [ -z "$_only" ]; then',
    '    _parts="$(snapshot_parts "$_id")"',
    `  elif [ -f ${SNAPSHOTS_DIR}/"$_id"/"$(part_file "$_only")" ]; then`,
    '    _parts="$_only"',
    "  else",
    `    ${said("The snapshot %s holds no copy of %s, so nothing was changed.")} "$_id" "$_only" >&2`,
    "    return 1",
    "  fi",
    ...(app
      ? [
          `  _held=""; if [ -f ${RESTORE_HELD} ]; then _held=1; fi`,
          '  _starts=", and the app starts again"',
          `  if [ -n "$_held" ]; then _starts=", and the app stays stopped while opscrew restore holds it"; fi`,
          `  ${said("OpsCrew restores the snapshot %s: the app's requests wait, and the app stops until its data is back.")} "$_id" >&2`,
          '  if [ -z "$_held" ]; then',
          ...recordRunning(plan).map((line) => `    ${line}`),
          ...holdRequests(plan, []).map((line) => `    ${line}`),
          "  fi",
          `  ${stopApp(plan)}`,
        ]
      : []),
    '  _saved="$(snapshot_new_id)"',
    "  _rc=0",
    '  snapshot_take "$_saved" manual "$(snapshot_version)" $_parts || _rc=$?',
    '  if [ "$_rc" -ne 0 ]; then',
    ...start,
    '    if [ "$_rc" -eq 2 ]; then',
    `      ${said("The disk that holds %s has too little free space to copy the current data before the restore, so nothing was changed. Free some space and run opscrew restore again.")} ${folder} >&2`,
    "    else",
    `      ${said(`OpsCrew could not copy the current data before the restore, so nothing was changed. ${note}`)} ${folder} >&2`,
    "    fi",
    "    return 1",
    "  fi",
    '  echo "saved $_saved"',
    // The services opscrew restore gives their current values start without waiting for their
    // health checks, which log in; it waits for them once their values are set (T2514).
    '  SNAPSHOT_NO_WAIT="$_nowait"',
    '  if snapshot_restore "$_id" $_parts; then',
    '    SNAPSHOT_NO_WAIT=""',
    ...start,
    `    ${said("OpsCrew restored the snapshot %s. The data from just before the restore is the snapshot %s.")} "$_id" "$_saved" >&2`,
    "    return 0",
    "  fi",
    '  SNAPSHOT_NO_WAIT=""',
    '  if snapshot_restore "$_saved" $_parts; then',
    ...start,
    `    ${said(`Restoring the snapshot %s failed, so OpsCrew put the data back as it was before the restore (the snapshot %s)${app ? "%s" : ""}: nothing changed. ${note}`)} "$_id" "$_saved" ${app ? '"$_starts" ' : ""}${folder} >&2`,
    "    return 1",
    "  fi",
    `  ${said(`Restoring the snapshot %s failed, and putting the data back as it was before the restore failed too, so it may be partly changed${app ? ", and the app was not started" : ""}. The copy from just before the restore stays in %s/${SNAPSHOTS_DIR}/%s: restore it with opscrew restore %s once the cause is fixed. ${note}`)} "$_id" ${folder} "$_saved" "$_saved" ${folder} >&2`,
    `  return ${RESTORE_STUCK}`,
    "}",
  ];
}

/**
 * The line that stops `snapshot.sh hold`, `resume` and `restore` before any change while a
 * credential rotation holds the app, naming it and the way out ({@link rotationHeldFunction}): its
 * hold is not theirs to replace or remove.
 */
const ROTATION_STOP = `if snapshot_rotation_held ${shellQuote("OpsCrew changed nothing: ")}; then return 1; fi`;

/**
 * The app's server's `snapshot_cmd_hold` and `snapshot_cmd_resume` (D8), the pieces of the
 * workflow's hold script (`appHoldCommands`): which workers and cron run is recorded while the web
 * runs ({@link recordRunning}), then the app is held ({@link holdApp}); `resume` ends the hold
 * ({@link resumeApp}). `hold` leaves {@link RESTORE_HELD}, which `resume` removes; while a rotation
 * holds the app, both refuse ({@link ROTATION_STOP}). `opscrew restore` runs them around its
 * restores. They change no data, so they need no approval; kamal-proxy lets requests through itself
 * after its longest hold, to the stopped app.
 */
function holdCommands(plan: DeployPlan): string[] {
  return [
    "snapshot_cmd_hold() {",
    `  ${ROTATION_STOP}`,
    `  (umask 077 && mkdir -p ${SNAPSHOTS_DIR} && : > ${RESTORE_HELD})`,
    ...recordRunning(plan).map((line) => `  ${line}`),
    ...holdApp(plan).map((line) => `  ${line}`),
    "}",
    "snapshot_cmd_resume() {",
    `  ${ROTATION_STOP}`,
    ...resumeApp(plan).map((line) => `  ${line}`),
    `  rm -f ${RESTORE_HELD}`,
    "}",
  ];
}

/**
 * {@link SNAPSHOT_SCRIPT} for `server` (the app's by default, or an extra server's name), rendered
 * from the plan (024 plan.md 1.–3.): POSIX sh that runs in the app's folder there, with
 * {@link snapshotFunctions} and these commands:
 * - `take <manual|release|scheduled> [--skip <service>]... [--stop <service>]... [--id <id>]
 *   [--version sha256:<hex>]` prints the new snapshot's id; exits 1 when a copy failed, 2 when the
 *   disk is too full;
 * - `restore <id> [--only <service>] [--no-wait <service>]...` (its approval: {@link restoreApprovalLine});
 * - on the app's server, `hold` and `resume` ({@link holdCommands});
 * - `list` prints each snapshot's `about.json`, one per line;
 * - `delete <id>` removes a snapshot;
 * - `offsite <id>` copies a snapshot off the server ({@link offsiteFunctions}); without
 *   `snapshots.offsite` it does nothing.
 * All but `list` and `offsite` first take the app's start lock, which a deploy's start script
 * holds, so none runs during a deploy and none at once. With `snapshots.offsite`, `take manual`
 * and `take scheduled` release it once the snapshot is taken, then copy off the server each
 * snapshot not copied yet (D16): an upload never holds a deploy, and a snapshot before a release
 * is never uploaded. The start and rollback scripts read its
 * functions alone ({@link SNAPSHOT_FUNCTIONS}). Messages go to stderr and never quote data or a
 * secret. Without a part on the server ({@link snapshotParts}) it is empty, except on the app's
 * server when an extra server holds data (D13): then it has only `hold` and `resume`
 * ({@link holdScript}).
 */
export function snapshotScript(plan: DeployPlan, server: string = APP_SERVER): string[] {
  const folder = appFolder(plan);
  const functions = snapshotFunctions(plan, server, folder);
  const app = server === APP_SERVER;
  if (functions.length === 0) return app ? holdScript(plan) : [];
  const where = serverWords(server);
  const take = `take <manual|release|scheduled> [--skip <service>]... [--stop <service>]... [--id <id>] [--version sha256:<hex>]`;
  const commands = [
    take,
    "restore <id> [--only <service>] [--no-wait <service>]...",
    ...(app ? ["hold", "resume"] : []),
    "list",
    "delete <id>",
    "offsite <id>",
  ];
  return [
    `# OpsCrew's snapshots of ${plan.app.name}'s data on ${where}, generated from ${planFilePath(plan)}; each deploy uploads it.`,
    ...commands.map((command) => `#   sh ${SNAPSHOT_SCRIPT} ${command}`),
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${folder}`,
    ...(app ? [EDGE_FUNCTION] : []),
    ...functions,
    "snapshot_usage() {",
    `  echo ${shellQuote(`Usage: sh ${SNAPSHOT_SCRIPT} ${commands.join(" | ")}`)} >&2`,
    "}",
    "snapshot_id() {",
    '  case "$1" in',
    `    "" | *[!0-9A-Za-z]*) echo ${shellQuote("A snapshot's id has only letters and digits.")} >&2; return 1 ;;`,
    "  esac",
    "}",
    "snapshot_known() {",
    '  case " $SNAPSHOT_PARTS " in *" $1 "*) return 0 ;; esac',
    `  printf ${printfFormat(`%s is no service with data on ${where}.`)} "$1" >&2`,
    "  return 1",
    "}",
    // A snapshot by hand never replaces another of the same second, such as the one it restores.
    "snapshot_new_id() {",
    '  _new="$(date -u +%Y%m%dT%H%M%SZ)"',
    `  while [ -e ${SNAPSHOTS_DIR}/"$_new" ]; do sleep 1; _new="$(date -u +%Y%m%dT%H%M%SZ)"; done`,
    '  echo "$_new"',
    "}",
    ...rotationHeldFunction(plan),
    ...offsiteFunctions(plan, server),
    ...takeCommand(plan, server),
    ...restoreCommand(plan, server),
    ...(app ? holdCommands(plan) : []),
    // Read by the start and rollback scripts for these functions alone.
    'if [ "${OPSCREW_SNAPSHOT_FUNCTIONS:-}" = 1 ]; then return 0; fi',
    'case "${1:-}" in',
    "  list)",
    `    for _each in ${SNAPSHOTS_DIR}/*/about.json; do`,
    // A snapshot being taken has no place in the list.
    '      case "$_each" in *.partial/* | *.taking/*) continue ;; esac',
    '      if [ -f "$_each" ]; then cat "$_each"; fi',
    "    done ;;",
    "  offsite)",
    '    [ "$#" -eq 2 ] || { snapshot_usage; exit 1; }',
    // Without the off-server copy there is nothing to copy, and the script stays as it was.
    ...(snapshotOffsiteOf(plan) === undefined
      ? ['    snapshot_id "$2" ;;']
      : ['    snapshot_id "$2"', '    snapshot_offsite "$2" ;;']),
    `  take | restore | delete${app ? " | hold | resume" : ""})`,
    ...startLock(plan).map((line) => `    ${line}`),
    '    _command="$1"',
    "    shift",
    '    case "$_command" in',
    ...(snapshotOffsiteOf(plan) === undefined
      ? ['      take) snapshot_cmd_take "$@" ;;']
      : [
          "      take)",
          '        snapshot_cmd_take "$@"',
          // The start lock goes before the uploads, which may take long.
          "        exec 7>&-",
          '        case "${1:-}" in manual | scheduled) snapshot_offsite_pending ;; esac ;;',
        ]),
    '      restore) snapshot_cmd_restore "$@" ;;',
    ...(app
      ? [
          '      hold) [ "$#" -eq 0 ] || { snapshot_usage; exit 1; }; snapshot_cmd_hold ;;',
          '      resume) [ "$#" -eq 0 ] || { snapshot_usage; exit 1; }; snapshot_cmd_resume ;;',
        ]
      : []),
    "      delete)",
    '        [ "$#" -eq 1 ] || { snapshot_usage; exit 1; }',
    '        snapshot_id "$1"',
    `        if [ ! -d ${SNAPSHOTS_DIR}/"$1" ]; then`,
    `          printf ${printfFormat(`There is no snapshot %s on ${where}.`)} "$1" >&2`,
    "          exit 1",
    "        fi",
    `        rm -rf ${SNAPSHOTS_DIR}/"$1" ;;`,
    "    esac ;;",
    "  *)",
    "    snapshot_usage",
    "    exit 1 ;;",
    "esac",
  ];
}

/**
 * {@link SNAPSHOT_SCRIPT} on the app's server when it holds no data but an extra server does (D13):
 * only `hold` and `resume` ({@link holdCommands}), under the app's start lock, so `opscrew restore`
 * can hold the app around the restores there. Empty when no server holds data.
 */
function holdScript(plan: DeployPlan): string[] {
  if (!holdsData(plan)) return [];
  const usage = `Usage: sh ${SNAPSHOT_SCRIPT} hold | resume`;
  return [
    `# OpsCrew's hold of ${plan.app.name} on the app's server while its data on the other servers is restored, generated from ${planFilePath(plan)}; each deploy uploads it.`,
    `#   sh ${SNAPSHOT_SCRIPT} hold`,
    `#   sh ${SNAPSHOT_SCRIPT} resume`,
    ...SCRIPT_ROOTS,
    "set -eu",
    `cd ${appFolder(plan)}`,
    EDGE_FUNCTION,
    ...rotationHeldFunction(plan),
    ...holdCommands(plan),
    'case "${1:-}" in',
    "  hold | resume)",
    `    [ "$#" -eq 1 ] || { echo ${shellQuote(usage)} >&2; exit 1; }`,
    ...startLock(plan).map((line) => `    ${line}`),
    '    snapshot_cmd_"$1" ;;',
    "  *)",
    `    echo ${shellQuote(usage)} >&2`,
    "    exit 1 ;;",
    "esac",
  ];
}
