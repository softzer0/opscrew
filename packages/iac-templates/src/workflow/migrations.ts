// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { type DeployPlan, MIGRATION_TOOLS, type MigrationTool } from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";
import { planFilePath, runbookFilePath } from "./shared";

/** The migration records' folder in the app's folder (plan.md 12.3). */
export const SCHEMA_DIR = ".schema";

/** Version `<hex>`'s migration record: `version=<v>`, `count=<n>`, or `app=<app> <name>` lines. */
export function schemaRecordPath(hex: string): string {
  return `${SCHEMA_DIR}/${hex}`;
}

/** How many records the deploy keeps, the newest. */
const KEEP_RECORDS = 20;

/**
 * Where the release command's output stays, in the app's folder (`switch.ts`); the record's errors
 * and the down migrations' output go there too, never to the workflow's log.
 */
const RELEASE_LOG = "release.log";

/**
 * The awk program that turns each tool's status output (research R9, as the tools print it without
 * a terminal) into its record, and exits non-zero when the output holds nothing it knows:
 * - Rails `db:version`: `Current version: <v>` (0 when none ran), after `database: <name>`;
 * - Alembic and Flask-Migrate `current`: `<revision> (head)`, nothing at all when none ran
 *   (`base`);
 * - Django `showmigrations --plan`: `[X]  <app>.<name>` for each applied migration, in the order
 *   they ran; the record keeps each app's last, ordered by when it ran;
 * - Knex `migrate:list`: `Found <n> Completed Migration file/files.`, or `No Completed Migration
 *   files Found.`;
 * - sequelize-cli `db:migrate:status`: `up <file>` and `down <file>`;
 * - TypeORM `migration:show`: `[X] <id> <name>` and `[ ] <name>`;
 * - Laravel `migrate:status`: the `Migration name` heading, then `<name> .... [<batch>] Ran` or
 *   `Pending`.
 */
const NORMALIZE: Record<MigrationTool, string> = {
  rails: '/^Current version: [0-9]+$/ { print "version=" $3; found = 1 } END { exit !found }',
  alembic: alembicCurrent(),
  "flask-migrate": alembicCurrent(),
  django: [
    '$1 == "[X]" && split($2, part, ".") == 2 { name[part[1]] = part[2]; last[part[1]] = NR; app[NR] = part[1] }',
    'END { for (i = 1; i <= NR; i++) if ((i in app) && last[app[i]] == i) { print "app=" app[i] " " name[app[i]]; found = 1 } exit !found }',
  ].join(" "),
  knex: [
    '/^Found [0-9]+ Completed Migration/ { print "count=" $2; found = 1 }',
    '/^No Completed Migration files Found/ { print "count=0"; found = 1 }',
    "END { exit !found }",
  ].join(" "),
  sequelize: countOf("/^(up|down) /", "/^up /"),
  typeorm: countOf("/^\\[[X ]\\] /", "/^\\[X\\] /"),
  laravel: countOf("/^ *Migration name /", "/\\[[0-9]+\\] Ran *$/"),
};

/** Alembic's `current`: each revision it prints, `base` when it prints none. */
function alembicCurrent(): string {
  return '/^[0-9A-Za-z_]+( \\(.*\\))?$/ { print "version=" $1; found = 1 } END { if (!found) print "version=base" }';
}

/** `count=<lines matching applied>`, when any line matches `known` (the tool's own lines). */
function countOf(known: string, applied: string): string {
  return `${known} { found = 1 } ${applied} { n++ } END { if (found) print "count=" n + 0; exit !found }`;
}

/** Shown when the record fails; `%s` is the app's folder. */
function recordFailed(plan: DeployPlan): string {
  return `::warning::OpsCrew could not record which database migrations this version has (app.migrations.status in ${planFilePath(plan)} failed, or printed nothing OpsCrew can read), so a rollback from this version can't migrate the database down. The command's errors are on the server in %s/${RELEASE_LOG} (${runbookFilePath(plan)} has the SSH command).`;
}

/**
 * The start script's lines that record the database's migrations under the new version's digest
 * (plan.md 12.3, 12.4), in `MODE` `deploy` right after the release command succeeded: `app.
 * migrations.status` runs in a one-off of the new image (the `release` service, which `$1` names),
 * its output is turned into {@link schemaRecordPath}'s lines ({@link NORMALIZE}) and the newest
 * {@link KEEP_RECORDS} records stay. Folder 0700, files 0600. Nothing the command prints reaches
 * the log: its errors go to `release.log`. A failure only warns. None without `app.migrations`,
 * and none for an image without a digest (provision's first start on this computer).
 */
export function migrationRecord(plan: DeployPlan): string[] {
  const migrations = plan.app.migrations;
  if (migrations === undefined) return [];
  const record = `${SCHEMA_DIR}/"$schema_hex"`;
  return [
    'case "$1" in *@sha256:*)',
    '  schema_hex="${1##*@sha256:}"',
    `  if schema_out="$(docker compose run --rm --no-deps -T release sh -c ${shellQuote(migrations.status)} < /dev/null 2>> ${RELEASE_LOG})" && (umask 077 && mkdir -p ${SCHEMA_DIR} && printf '%s\\n' "$schema_out" | awk ${shellQuote(NORMALIZE[migrations.tool])} > ${record}); then`,
    `    ls -t ${SCHEMA_DIR} | sed '1,${KEEP_RECORDS}d' | while read -r old; do rm -f ${SCHEMA_DIR}/"$old"; done`,
    "  else",
    `    rm -f ${record}`,
    `    printf ${shellQuote(`${recordFailed(plan)}\\n`)} "$PWD"`,
    "  fi ;;",
    "esac",
  ];
}

/**
 * `command` as one shell word in which each `{placeholder}` is the shell variable of that name
 * (`"$version"`), set from a checked record value.
 */
function filled(command: string): string {
  return command
    .split(/(\{[a-z]+\})/)
    .filter((part) => part !== "")
    .map((part) => (/^\{[a-z]+\}$/.test(part) ? `"$${part.slice(1, -1)}"` : shellQuote(part)))
    .join("");
}

/** A record value OpsCrew puts in a command: `^[A-Za-z0-9_.:-]+$`, as a `case` pattern. */
const NOT_A_VALUE = '"" | *[!A-Za-z0-9_.:-]*';

/**
 * The lines that set `$script`, the down command, from the earlier version's record
 * (`$was_record`) and the running one's (`$now_record`), by the tool's unit; empty when there is
 * nothing to undo. Commands that run several times are `&&`-joined, each in a subshell, so a
 * `cd <folder> &&` prefix holds for each. A count that grew calls `grew`; a value that isn't one
 * calls `invalid`.
 */
function downScript(tool: MigrationTool, down: string): string[] {
  const unit = MIGRATION_TOOLS[tool].unit;
  switch (unit) {
    case "version":
      return [
        'version="$(sed -n \'s/^version=//p\' "$was_record")"',
        `case "$version" in ${NOT_A_VALUE}) invalid ;; esac`,
        'script=""',
        `if [ "$version" != "$(sed -n 's/^version=//p' "$now_record")" ]; then script=${filled(down)}; fi`,
      ];
    case "apps":
      // Each app of the running record, newest first, goes back to its migration in the earlier
      // record, or to `zero` when that has none; an app already there is left alone.
      return [
        `pairs="$(awk ${shellQuote(
          [
            "!/^app=[A-Za-z0-9_.:-]+ [A-Za-z0-9_.:-]+$/ { bad = 1; next }",
            "{ app = substr($1, 5) }",
            "FILENAME == ARGV[1] { was[app] = $2; next }",
            '{ to = (app in was) ? was[app] : "zero"; if (to != $2) pair[++n] = app " " to }',
            "END { if (bad) exit 1; for (i = n; i > 0; i--) print pair[i] }",
          ].join(" "),
        )} "$was_record" "$now_record")" || invalid`,
        'script=""',
        "set -- $pairs",
        'while [ "$#" -ge 2 ]; do',
        '  app="$1"; name="$2"; shift 2',
        `  script="\${script:+$script && }("${filled(down)}")"`,
        "done",
      ];
    case "count":
    case "each":
      return [
        'now="$(sed -n \'s/^count=//p\' "$now_record")"',
        'was="$(sed -n \'s/^count=//p\' "$was_record")"',
        'case "$now" in "" | *[!0-9]*) invalid ;; esac',
        'case "$was" in "" | *[!0-9]*) invalid ;; esac',
        'if [ "$was" -gt "$now" ]; then grew; fi',
        "count=$((now - was))",
        'script=""',
        ...(unit === "count"
          ? [`if [ "$count" -gt 0 ]; then script=${filled(down)}; fi`]
          : [
              `down=${shellQuote(down)}`,
              'while [ "$count" -gt 0 ]; do script="${script:+$script && }($down)"; count=$((count - 1)); done',
            ]),
      ];
  }
}

/**
 * The rollback's down migrations (plan.md 12.4, step 4 `migrations`): a script fragment that runs
 * in a subshell of the start script's database step, inside an `if` condition, so `set -e` doesn't
 * apply there and every command that can fail exits the fragment non-zero itself. A non-zero exit
 * puts the database back as it was before the rollback.
 *
 * From the records of the version rolled back to (`$target`) and the running one (`$running`), by
 * the tool's unit ({@link MIGRATION_TOOLS}):
 * - `version`: `down` to the earlier record's `{version}` (`base` for Alembic and Flask-Migrate,
 *   `0` for Rails, when none had run);
 * - `count`: `down` once with `{count}`, the running count less the earlier one;
 * - `each`: `down` that many times;
 * - `apps` (Django): `down` for each app of the running record, newest first, with `{app}` and the
 *   earlier record's `{name}`, or `zero` when it has none for that app.
 *
 * Every value from a record is checked against `^[A-Za-z0-9_.:-]+$` before use. A missing record,
 * a value that isn't one, or a count that grew going back exits non-zero before any change. The
 * command runs in one one-off of the running version's image (the `release` service with the
 * image `.env` names: `APP_IMAGE` is `$1`'s, the earlier version's, in the script), its output in
 * `release.log`, never printed. Without `app.migrations`, it always exits non-zero.
 */
export function migrationDown(plan: DeployPlan): string[] {
  const migrations = plan.app.migrations;
  if (migrations === undefined) {
    return [
      `echo ${shellQuote("::error::Down migrations aren't available for this app.")}`,
      "exit 1",
    ];
  }
  const { tool, down } = migrations;
  const error = (text: string) => `echo ${shellQuote(`::error::${text}`)}; exit 1;`;
  return [
    `was_record=${SCHEMA_DIR}/"$target"`,
    `now_record=${SCHEMA_DIR}/"$running"`,
    `invalid() { ${error(`A migration record in ${SCHEMA_DIR} on the server holds a value OpsCrew won't put in a command, so nothing was migrated down.`)} }`,
    `grew() { ${error(`The version rolled back to has more migrations applied than the version running now (their records in ${SCHEMA_DIR} on the server), so migrating down can't reach its schema and nothing was migrated down.`)} }`,
    'if [ ! -f "$was_record" ] || [ ! -f "$now_record" ]; then',
    `  ${error(`The server holds no record of the migrations of the version running now or of the version rolled back to (in ${SCHEMA_DIR}), so OpsCrew can't tell which to undo and nothing was migrated down.`)}`,
    "fi",
    ...downScript(tool, down),
    'if [ -z "$script" ]; then',
    `  echo ${shellQuote("The database already has the migrations of the version rolled back to: there is nothing to migrate down.")}`,
    "  exit 0",
    "fi",
    "image=\"$(sed -n 's/^APP_IMAGE=//p' .env)\"",
    `if ! (umask 077; APP_IMAGE="$image" docker compose run --rm --no-deps -T release sh -c "$script" < /dev/null > ${RELEASE_LOG} 2>&1); then`,
    `  printf ${shellQuote(`::error::The down migrations with ${tool} failed. Their output stays on the server in %s/${RELEASE_LOG} (it can quote data from the database, so it is not printed here; ${runbookFilePath(plan)} has the SSH command).\\n`)} "$PWD"`,
    "  exit 1",
    "fi",
    `echo ${shellQuote(`OpsCrew migrated the database down with ${tool} to the migrations of the version rolled back to.`)}`,
  ];
}
