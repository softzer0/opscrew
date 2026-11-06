// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import {
  type DeployPlan,
  MIGRATION_TOOLS,
  type Migrations,
  type MigrationTool,
} from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";
import { planFilePath, printfFormat, RELEASE_LOG, runbookFilePath, serverLogNote } from "./shared";

/** The migration records' folder in the app's folder (plan.md 12.3). */
export const SCHEMA_DIR = ".schema";

/**
 * Version `<hex>`'s migration record: `version=<v>`, `database=<name> <v>` lines (Rails with several
 * databases), `count=<n>`, or `app=<app> <name>` lines.
 */
export function schemaRecordPath(hex: string): string {
  return `${SCHEMA_DIR}/${hex}`;
}

/** How many records the deploy keeps, the newest. */
const KEEP_RECORDS = 20;

/**
 * The awk program that turns each tool's status output (research R9, as the tools print it without
 * a terminal) into its record. It exits 1 when the output holds nothing it knows, or a line it
 * doesn't know where every line counts, and 2 when it shows more than one version
 * ({@link SEVERAL}):
 * - Rails (detection's `rails runner` status, printed as `db:version` does): `database: <name>`,
 *   the database.yml entry `db:migrate:<name>` takes, then `Current version: <v>` (0 when none
 *   ran); one pair per database. One database records `version=<v>`, several a
 *   `database=<name> <v>` line each, in database.yml's order; a name that isn't a value makes the
 *   output unknown;
 * - Alembic and Flask-Migrate `current`: `<revision> (head)`, one per head, nothing at all when
 *   none ran (`base`);
 * - Django `showmigrations --plan`: `[X]  <app>.<name>` for each applied migration, in the order
 *   they ran; the record keeps each app's last, ordered by when it ran;
 * - Knex `migrate:list`: `Found <n> Completed Migration file/files.`, or `No Completed Migration
 *   files Found.`;
 * - sequelize-cli `db:migrate:status`: `up <file>` and `down <file>`;
 * - TypeORM `migration:show`: `[X] <id> <name>` and `[ ] <name>`;
 * - Laravel `migrate:status`: the `Migration name` heading, then `<name> .... [<batch>] Ran` or
 *   `<name> .... Pending`.
 */
const NORMALIZE: Record<MigrationTool, string> = {
  rails: [
    "/^database: / { db = substr($0, 11) }",
    '/^Current version: [0-9]+$/ { name[++n] = db; version[n] = $3; db = "" }',
    'END { if (n == 1) print "version=" version[1]; else for (i = 1; i <= n; i++) { if (name[i] !~ /^[A-Za-z0-9_.:-]+$/) exit 1; print "database=" name[i] " " version[i] } exit !n }',
  ].join(" "),
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
  laravel: countOf("/ (\\[[0-9]+\\] Ran|Pending) *$/", "/\\[[0-9]+\\] Ran *$/"),
};

/**
 * Alembic's `current`: the one revision it prints (letters, digits and `_.:-`), `base` when it
 * prints none; any other line makes the output unknown.
 */
function alembicCurrent(): string {
  return 'NF == 0 { next } /^[A-Za-z0-9_.:-]+( \\(.*\\))?$/ { print "version=" $1; n++; next } { bad = 1 } END { if (bad) exit 1; if (n > 1) exit 2; if (n == 0) print "version=base" }';
}

/**
 * `count=<rows matching applied>` from the tool's list of migrations, each a `row`, applied or
 * not; an output without a row is unknown.
 */
function countOf(row: string, applied: string): string {
  return `${row} { rows++ } ${applied} { n++ } END { if (rows) print "count=" n + 0; exit !rows }`;
}

/**
 * Why a tool's status shows more than one version: a version tool's down migrations go back to
 * one version, so these get no record.
 */
const SEVERAL: Partial<Record<MigrationTool, string>> = {
  alembic:
    "Alembic shows several heads (branches of migrations), and OpsCrew's down migrations handle a single head only for now",
  "flask-migrate":
    "Alembic shows several heads (branches of migrations), and OpsCrew's down migrations handle a single head only for now",
};

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
 * the log: its errors go to `release.log`. A failure only warns, and leaves no record: down
 * migrations are then not offered for this version. None without `app.migrations`, and for an
 * image without a digest (provision's first start on this computer).
 */
export function migrationRecord(plan: DeployPlan): string[] {
  const migrations = plan.app.migrations;
  if (migrations === undefined) return [];
  const record = `${SCHEMA_DIR}/"$schema_hex"`;
  const several = SEVERAL[migrations.tool];
  return [
    'case "$1" in *@sha256:*)',
    '  schema_hex="${1##*@sha256:}"',
    "  schema_status=1",
    `  if schema_out="$(docker compose run --rm --no-deps -T release sh -c ${shellQuote(migrations.status)} < /dev/null 2>> ${RELEASE_LOG})"; then`,
    `    (umask 077 && mkdir -p ${SCHEMA_DIR} && printf '%s\\n' "$schema_out" | awk ${shellQuote(NORMALIZE[migrations.tool])} > ${record}) && schema_status=0 || schema_status=$?`,
    "  fi",
    '  case "$schema_status" in',
    "    0)",
    `      ls -t ${SCHEMA_DIR} | sed '1,${KEEP_RECORDS}d' | while read -r old; do rm -f ${SCHEMA_DIR}/"$old"; done ;;`,
    ...(several === undefined
      ? []
      : [
          "    2)",
          `      rm -f ${record}`,
          `      echo ${shellQuote(`::warning::OpsCrew records no database migrations for this version, because ${several}, so a rollback from this version can't migrate the database down.`)} ;;`,
        ]),
    "    *)",
    `      rm -f ${record}`,
    `      printf ${printfFormat(recordFailed(plan))} "$PWD" ;;`,
    "  esac ;;",
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
 * calls `invalid`; `fail(text)` is the line that prints `text` as an error and exits 1.
 */
function downScript(
  plan: DeployPlan,
  { tool, down }: Migrations,
  fail: (text: string) => string,
): string[] {
  const unit = MIGRATION_TOOLS[tool].unit;
  switch (unit) {
    case "version": {
      const one = [
        'version="$(sed -n \'s/^version=//p\' "$was_record")"',
        `case "$version" in ${NOT_A_VALUE}) invalid ;; esac`,
        'script=""',
        `if [ "$version" != "$(sed -n 's/^version=//p' "$now_record")" ]; then script=${filled(down)}; fi`,
      ];
      return tool === "rails" ? railsDown(plan, down, one, fail) : one;
    }
    case "apps":
      return perItem("app", "name", "zero", down);
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
 * The lines that set `$script` to `command` once per `<item>=<key> <value>` line of the running
 * record, newest first, with the shell variables `$<item>` the key and `$<value>` the earlier
 * record's value for it, or `none` when that has none. A key already there, or only in the earlier
 * record, is left alone. A line that isn't `<item>=<key> <value>`, each a value, calls `invalid`.
 */
function perItem(item: string, value: string, none: string, command: string): string[] {
  return [
    `pairs="$(awk ${shellQuote(
      [
        `!/^${item}=[A-Za-z0-9_.:-]+ [A-Za-z0-9_.:-]+$/ { bad = 1; next }`,
        `{ key = substr($1, ${item.length + 2}) }`,
        "FILENAME == ARGV[1] { was[key] = $2; next }",
        `{ to = (key in was) ? was[key] : "${none}"; if (to != $2) pair[++n] = key " " to }`,
        "END { if (bad) exit 1; for (i = n; i > 0; i--) print pair[i] }",
      ].join(" "),
    )} "$was_record" "$now_record")" || invalid`,
    'script=""',
    "set -- $pairs",
    'while [ "$#" -ge 2 ]; do',
    `  ${item}="$1"; ${value}="$2"; shift 2`,
    `  script="\${script:+$script && }("${filled(command)}")"`,
    "done",
  ];
}

/** `db:migrate` as a word of its own, followed by a space: what Rails' `down` points at a database. */
const DB_MIGRATE = /(?<=^|\s)db:migrate(?= )/;

/**
 * Rails' down lines: `one` when the running record has one database (`version=`); with several
 * (`database=<name> <v>` lines), `down` with its `db:migrate` turned into `db:migrate:<name>` for
 * each database of the running record, newest first ({@link perItem}), with `{version}` the
 * earlier record's for that database, or `0` when it has none. Records of different shapes, or
 * several databases and a `down` without `db:migrate `, exit 1 before any change.
 */
function railsDown(
  plan: DeployPlan,
  down: string,
  one: readonly string[],
  fail: (text: string) => string,
): string[] {
  const shapes = `{ ${fail(`The version rolled back to and the version running now record a different number of databases (their records in ${SCHEMA_DIR} on the server), so OpsCrew can't tell which to undo and nothing was migrated down.`)} }`;
  return [
    "several() { grep -q '^database=' \"$1\"; }",
    'if several "$now_record"; then',
    ...(DB_MIGRATE.test(down)
      ? [
          `  several "$was_record" || ${shapes}`,
          ...perItem(
            "database",
            "version",
            "0",
            down.replace(DB_MIGRATE, "db:migrate:{database}"),
          ).map((line) => `  ${line}`),
        ]
      : [
          `  ${fail(`The app has several databases, and app.migrations.down in ${planFilePath(plan)} has no \`db:migrate \` for OpsCrew to turn into each database's \`db:migrate:<name>\`, so nothing was migrated down.`)}`,
        ]),
    "else",
    `  several "$was_record" && ${shapes}`,
    ...one.map((line) => `  ${line}`),
    "fi",
  ];
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
 *   `0` for Rails, when none had run); for Rails with several databases, `down` as
 *   `db:migrate:<name>` per database of the running record, newest first ({@link railsDown});
 * - `count`: `down` once with `{count}`, the running count less the earlier one;
 * - `each`: `down` that many times;
 * - `apps` (Django): `down` for each app of the running record, newest first, with `{app}` and the
 *   earlier record's `{name}`, or `zero` when it has none for that app.
 *
 * Every value from a record is checked against `^[A-Za-z0-9_.:-]+$` before use. A missing record,
 * a value that isn't one, or a count that grew going back exits non-zero before any change. The
 * command runs in one one-off of the running version's image (the `release` service with the
 * image `.env` names: `APP_IMAGE` is `$1`'s, the earlier version's, in the script), its output in
 * `release.log`, never printed.
 */
export function migrationDown(plan: DeployPlan, migrations: Migrations): string[] {
  const { tool } = migrations;
  const error = (text: string) => `echo ${shellQuote(`::error::${text}`)}; exit 1;`;
  return [
    `was_record=${SCHEMA_DIR}/"$target"`,
    `now_record=${SCHEMA_DIR}/"$running"`,
    `invalid() { ${error(`A migration record in ${SCHEMA_DIR} on the server holds a value OpsCrew won't put in a command, so nothing was migrated down.`)} }`,
    `grew() { ${error(`The version rolled back to has more migrations applied than the version running now (their records in ${SCHEMA_DIR} on the server), so migrating down can't reach its schema and nothing was migrated down.`)} }`,
    'if [ ! -f "$was_record" ] || [ ! -f "$now_record" ]; then',
    `  ${error(`The server holds no record of the migrations of the version running now or of the version rolled back to (in ${SCHEMA_DIR}), so OpsCrew can't tell which to undo and nothing was migrated down.`)}`,
    "fi",
    ...downScript(plan, migrations, error),
    'if [ -z "$script" ]; then',
    `  echo ${shellQuote("The database already has the migrations of the version rolled back to: there is nothing to migrate down.")}`,
    "  exit 0",
    "fi",
    "image=\"$(sed -n 's/^APP_IMAGE=//p' .env)\"",
    `if ! (umask 077; APP_IMAGE="$image" docker compose run --rm --no-deps -T release sh -c "$script" < /dev/null > ${RELEASE_LOG} 2>&1); then`,
    `  printf ${printfFormat(`::error::The down migrations with ${tool} failed. Their output ${serverLogNote(plan, RELEASE_LOG)}`)} "$PWD"`,
    "  exit 1",
    "fi",
    `echo ${shellQuote(`OpsCrew migrated the database down with ${tool} to the migrations of the version rolled back to.`)}`,
  ];
}
