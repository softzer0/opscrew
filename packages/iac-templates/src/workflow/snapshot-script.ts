// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import {
  APP_SERVER,
  type DeployPlan,
  keepSnapshotsOf,
  snapshotScheduleOf,
} from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";
import { planFilePath, printfFormat } from "./shared";
import {
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
  holdRequests,
  pauseRequests,
  processServices,
  readApproval,
  recordProcesses,
  resumeRequests,
  SCRIPT_ROOTS,
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

/** Where the last scheduled snapshot's output is, in the app's folder: its id, or why it failed. */
export const SCHEDULED_LOG = `${SNAPSHOTS_DIR}/scheduled.log`;

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
 * - the version that runs is `--version`'s, or `snapshot_running`'s (`.env`, or `.running` on an
 *   extra server);
 * - the snapshot's id is `--id` (one id for the parts on several servers, D8), or the version's
 *   digest for `release`, the hour of the schedule's slot for `scheduled` (outside the schedule's
 *   hours, or once that slot is taken, it does nothing; its output goes to {@link SCHEDULED_LOG}),
 *   and the time for `manual` (a manual one never replaces another);
 * - it copies every part but those `--skip` names, and of the stop-only ones only those named for
 *   its kind (`deploy.snapshotStop`, `snapshots.schedule.stop`) or with `--stop`; the others it
 *   lists as left out.
 * On success it prints the id, then keeps only the newest release or scheduled snapshots.
 */
function takeCommand(plan: DeployPlan, server: string): string[] {
  const folder = appFolder(plan);
  const schedule = snapshotScheduleOf(plan);
  const file = planFilePath(plan);
  return [
    "snapshot_cmd_take() {",
    '  _kind="${1:-}"',
    '  case "$_kind" in manual | release | scheduled) shift ;; *) snapshot_usage; return 1 ;; esac',
    '  case "$_kind" in',
    `    release) _stop=${shellQuote(stopOnly(plan, server, plan.deploy.snapshotStop ?? []))} ;;`,
    `    scheduled) _stop=${shellQuote(stopOnly(plan, server, schedule?.stop ?? []))} ;;`,
    '    *) _stop="" ;;',
    "  esac",
    '  _skip=""; _id=""; _hex="$(snapshot_running)"',
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
          `      exec >> ${SCHEDULED_LOG} 2>&1 ;;`,
        ]),
    "    *)",
    `      if [ -n "$_id" ] && [ -e ${SNAPSHOTS_DIR}/"$_id" ]; then`,
    `        printf ${printfFormat(`There is already a snapshot %s on ${server === APP_SERVER ? "the app's server" : `the server ${server}`}.`)} "$_id" >&2`,
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
 * `snapshot_cmd_restore <id> [--only <service>]` (024 plan.md 3. and 6.): refuses before any change
 * without the one-time approval for exactly this restore ({@link RESTORE_APPROVAL_FILE}, read and
 * removed at once, as the rollback's), or when the snapshot is not complete. On the app's server
 * the app's requests wait and its web, workers and cron stop ({@link holdRequests},
 * {@link stopApp}), also after `hold` (which recorded the workers and cron that ran); then the
 * parts it restores are copied as they are now (a `manual` snapshot), and each is restored exactly.
 * When a restore fails, that copy is put back; the app starts again unless the put-back failed
 * too. Each outcome is a message on stderr. On an extra server it neither holds nor stops the app:
 * the CLI holds it first (D8).
 */
function restoreCommand(plan: DeployPlan, server: string): string[] {
  const folder = appFolder(plan);
  const app = server === APP_SERVER;
  const file = RESTORE_APPROVAL_FILE;
  const start = app ? [`    ${startApp(plan)}`] : [];
  const note = `The output of the copies and restores stays on the server in %s/${SNAPSHOT_LOG} (it can quote data, so it is not printed here).`;
  const said = (text: string) => `printf ${printfFormat(text)}`;
  return [
    "snapshot_cmd_restore() {",
    '  [ "$#" -ge 1 ] || { snapshot_usage; return 1; }',
    '  _id="$1"',
    "  shift",
    '  snapshot_id "$_id" || return 1',
    '  _only=""',
    '  if [ "$#" -gt 0 ]; then',
    '    if [ "$#" -ne 2 ] || [ "$1" != --only ]; then snapshot_usage; return 1; fi',
    '    snapshot_known "$2" || return 1',
    '    _only="$2"',
    "  fi",
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
          `  ${said("OpsCrew restores the snapshot %s: the app's requests wait, and the app stops until its data is back.")} "$_id" >&2`,
          ...recordRunning(plan).map((line) => `  ${line}`),
          ...holdRequests(plan, []).map((line) => `  ${line}`),
          `  ${stopApp(plan)}`,
        ]
      : []),
    '  _saved="$(snapshot_new_id)"',
    "  _rc=0",
    '  snapshot_take "$_saved" manual "$(snapshot_running)" $_parts || _rc=$?',
    '  if [ "$_rc" -ne 0 ]; then',
    ...start,
    '    if [ "$_rc" -eq 2 ]; then',
    `      ${said("The disk that holds %s has too little free space to copy the current data before the restore, so nothing was changed. Free some space and run opscrew restore again.")} ${folder} >&2`,
    "    else",
    `      ${said(`OpsCrew could not copy the current data before the restore, so nothing was changed. ${note}`)} ${folder} >&2`,
    "    fi",
    "    return 1",
    "  fi",
    '  if snapshot_restore "$_id" $_parts; then',
    ...start,
    `    ${said("OpsCrew restored the snapshot %s. The data from just before the restore is the snapshot %s.")} "$_id" "$_saved" >&2`,
    "    return 0",
    "  fi",
    '  if snapshot_restore "$_saved" $_parts; then',
    ...start,
    `    ${said(`Restoring the snapshot %s failed, so OpsCrew put the data back as it was before the restore (the snapshot %s)${app ? ", and the app starts again" : ""}: nothing changed. ${note}`)} "$_id" "$_saved" ${folder} >&2`,
    "    return 1",
    "  fi",
    `  ${said(`Restoring the snapshot %s failed, and putting the data back as it was before the restore failed too, so it may be partly changed${app ? ", and the app was not started" : ""}. The copy from just before the restore stays in %s/${SNAPSHOTS_DIR}/%s: restore it with opscrew restore %s once the cause is fixed. ${note}`)} "$_id" ${folder} "$_saved" "$_saved" ${folder} >&2`,
    "  return 1",
    "}",
  ];
}

/**
 * Records which workers and cron run ({@link recordProcesses}) while the web runs: after `hold`,
 * which stopped them, its record stays.
 */
function recordRunning(plan: DeployPlan): string[] {
  const record = recordProcesses(processServices(plan));
  if (record.length === 0) return [];
  return [
    'if [ -n "$(docker compose ps -q app)" ]; then',
    ...record.map((line) => `  ${line}`),
    "fi",
  ];
}

/**
 * The app's server's `snapshot_cmd_hold` and `snapshot_cmd_resume` (D8), 019's code to hold the
 * app's requests and stop its web, workers and cron ({@link pauseRequests}, {@link stopApp}), and
 * to start them again and let the requests through ({@link startApp}, {@link resumeRequests}).
 * `opscrew restore` runs them around the restores on extra servers. They change no data, so they
 * need no approval; kamal-proxy lets requests through itself after its longest hold.
 */
function holdCommands(plan: DeployPlan): string[] {
  return [
    "snapshot_cmd_hold() {",
    ...recordRunning(plan).map((line) => `  ${line}`),
    `  ${pauseRequests(plan)}`,
    `  ${stopApp(plan)}`,
    "}",
    "snapshot_cmd_resume() {",
    `  ${startApp(plan)}`,
    `  ${resumeRequests(plan)}`,
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
 * - `restore <id> [--only <service>]` (its approval: {@link restoreApprovalLine});
 * - on the app's server, `hold` and `resume` ({@link holdCommands});
 * - `list` prints each snapshot's `about.json`, one per line;
 * - `delete <id>` removes a snapshot;
 * - `offsite <id>` does nothing yet (T2406).
 * All but `list` and `offsite` first take the app's start lock, which a deploy's start script
 * holds, so none runs during a deploy and none at once. The start and rollback scripts read its
 * functions alone ({@link SNAPSHOT_FUNCTIONS}). Messages go to stderr and never quote data or a
 * secret. Empty without a part on the server ({@link snapshotParts}).
 */
export function snapshotScript(plan: DeployPlan, server: string = APP_SERVER): string[] {
  const folder = appFolder(plan);
  const functions = snapshotFunctions(plan, server, folder);
  if (functions.length === 0) return [];
  const app = server === APP_SERVER;
  const where = app ? "the app's server" : `the server ${server}`;
  const take = `take <manual|release|scheduled> [--skip <service>]... [--stop <service>]... [--id <id>] [--version sha256:<hex>]`;
  const commands = [
    take,
    "restore <id> [--only <service>]",
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
    '    snapshot_id "$2" ;;',
    `  take | restore | delete${app ? " | hold | resume" : ""})`,
    ...startLock(plan).map((line) => `    ${line}`),
    '    _command="$1"',
    "    shift",
    '    case "$_command" in',
    '      take) snapshot_cmd_take "$@" ;;',
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
