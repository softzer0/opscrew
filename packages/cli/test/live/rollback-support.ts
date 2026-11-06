/**
 * Pure helpers of feature 019's live test (`rollback.test.ts`, docs/e2e.md "Rollback") and of the
 * site passes' rollback steps: the gates, the test's own release command, the deploy workflow's
 * job names, and what the tests read in OpsCrew's output (the rollback a script is asked to
 * approve, the run it started and where its time went, `rollback --list`'s table, `status`'
 * Deploys lines) and in the deploy pause variable, the Dockerfile change whose image never
 * answers, and `opscrew rollback` run as a script runs it (the CLI injected). The database pass's
 * (US8): its table and migrations, its SQL, and the inputs of a rollback dispatched by hand. No
 * network, no processes of their own; unit-tested in `rollback-support.test.ts`.
 */
import { environmentTag, ROLLBACK_INPUTS } from "@opscrew/iac-templates";
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import type { CliRun } from "./harness";
import { type DeployJob, duration } from "./support";

/** The test's gate. */
export const ROLLBACK_GATE = "OPSCREW_E2E_ROLLBACK";

/**
 * What the pass needs besides its gate: the Hetzner pass's variables, and the classic
 * `read:packages` token OpsCrew reads the versions from GHCR with, which may refuse the
 * fine-grained one (research R6, S2).
 */
export const ROLLBACK_VARIABLES = [
  ...ENVIRONMENT_E2E_VARIABLES,
  "OPSCREW_E2E_GHCR_READ_TOKEN",
] as const;

/** What the release output says: the test's own release command prints it on every deploy. */
export const RELEASE_MARKER = "opscrew-e2e-release";

/** `app.releaseCommand` the test sets before provision (no example has one). */
export const RELEASE_COMMAND = `echo ${RELEASE_MARKER}`;

/** SC-1901: a rollback serves the earlier version within 3 minutes of its approval. */
export const SC_1901_MS = 3 * 60_000;

/** The job that says why a run doesn't deploy while the environment's deploys are paused. */
export const PAUSED_JOB = "Report the deploy pause";

/**
 * The rollback a run without `--approve` showed: the version the printed command goes back to
 * (`--to`), its hash, the database choice and typed name it gives (`--database`, `--confirm`),
 * and the approval's `Now:` and `Back to:` lines on a server.
 */
export interface RollbackApproval {
  to: string;
  hash: string;
  database?: string;
  confirm?: string;
  now?: string;
  backTo?: string;
}

/**
 * The rollback an `opscrew rollback` run showed, from the command it printed to apply it
 * (`opscrew rollback [--app <key>] --env <env> --to <version> [--allow-old-secrets <names>]
 * [--database <choice>] [--confirm <name>] --approve <hash>`): the last one when it printed
 * several, `undefined` when none.
 */
export function rollbackApproval(output: string): RollbackApproval | undefined {
  const printed = [
    ...output.matchAll(
      /opscrew rollback\b[^\n`]*? --to (\S+)(?: --allow-old-secrets \S+)?(?: --database (\S+))?(?: --confirm (\S+))? --approve ([0-9a-f]{64})\b/g,
    ),
  ].at(-1);
  const [, to, database, confirm, hash] = printed ?? [];
  if (to === undefined || hash === undefined) return undefined;
  const line = (label: string) => new RegExp(`^\\s*${label}: (.+)$`, "m").exec(output)?.[1]?.trim();
  const now = line("Now");
  const backTo = line("Back to");
  return {
    to,
    hash,
    ...(database !== undefined ? { database } : {}),
    ...(confirm !== undefined ? { confirm } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(backTo !== undefined ? { backTo } : {}),
  };
}

/**
 * Where a rollback run's time went, for its `observed:` line: when its first job started after
 * the approval (`approvedAt`, epoch milliseconds), then each finished job's duration;
 * `undefined` when no job has started.
 */
export function jobTimes(jobs: readonly DeployJob[], approvedAt: number): string | undefined {
  const starts = jobs.flatMap((job) => (job.startedAt ? [Date.parse(job.startedAt)] : []));
  if (starts.length === 0) return undefined;
  const firstStart = Math.min(...starts);
  const each = jobs
    .filter((job) => job.startedAt && job.completedAt)
    .map(
      (job) =>
        `${job.name} ${duration(Date.parse(job.completedAt as string) - Date.parse(job.startedAt as string))}`,
    );
  return `the run's first job started ${duration(firstStart - approvedAt)} after the approval; ${each.join(", ")}`;
}

/** The workflow run an output names last (`…/actions/runs/<id>`), if any. */
export function runIdIn(output: string): number | undefined {
  const id = [...output.matchAll(/\/actions\/runs\/(\d+)\b/g)].at(-1)?.[1];
  return id === undefined ? undefined : Number(id);
}

/** One row of `opscrew rollback --list`'s table. */
export interface ListedVersion {
  /** The short digest (`sha256:` and 12 digits), or a site's version id. */
  version: string;
  /** The short commit, or `-`. */
  commit: string;
  marks: string[];
  message: string;
}

/**
 * The rows of `opscrew rollback --list`'s table, newest first, cut by its header's columns
 * (`Version  Commit  Built  Mark  Message`); none when the output has no table.
 */
export function listedVersions(output: string): ListedVersion[] {
  const lines = output.split(/\r?\n/);
  const at = lines.findIndex((line) =>
    /^\s*Version\s+Commit\s+Built\s+Mark\s+Message\s*$/.test(line),
  );
  const header = lines[at];
  if (header === undefined) return [];
  const columns = ["Commit", "Built", "Mark", "Message"].map((name) => header.indexOf(name));
  const [commitAt, builtAt, markAt, messageAt] = columns as [number, number, number, number];
  const rows: ListedVersion[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") break;
    const cell = (from: number, to?: number) => line.slice(from, to).trim();
    const marks = cell(markAt, messageAt);
    rows.push({
      version: cell(0, commitAt),
      commit: cell(commitAt, builtAt),
      marks: marks === "" ? [] : marks.split(/,\s*/),
      message: cell(messageAt),
    });
  }
  return rows;
}

/** `opscrew status`' Deploys lines: what runs (`Running: …`) and the pause (`Paused since …`). */
export function statusDeploys(output: string): { running?: string; paused?: string } {
  const running = /^\s*Running: (.+)$/m.exec(output)?.[1]?.trim();
  const paused = /^\s*(Paused since .+)$/m.exec(output)?.[1]?.trim();
  return {
    ...(running !== undefined ? { running } : {}),
    ...(paused !== undefined ? { paused } : {}),
  };
}

/** An entry of the deploy pause variable (`OPSCREW_DEPLOY_PAUSED`), as OpsCrew writes it. */
export interface PauseEntry {
  reason?: string;
  since?: string;
  image?: string;
  commit?: string;
  from?: string;
}

/**
 * The entry `key` (`<app>/<env>`) of the deploy pause variable's value, `undefined` when the
 * variable is not set or has no such entry. Throws when the value is not OpsCrew's JSON.
 */
export function pauseEntryOf(value: string | undefined, key: string): PauseEntry | undefined {
  if (value === undefined) return undefined;
  const entries = JSON.parse(value) as Record<string, PauseEntry | undefined>;
  return entries[key];
}

/**
 * The app's Dockerfile with a last `CMD` that prints `marker` and then only sleeps: the image
 * builds, its release command runs, but its copy never answers the health check.
 */
export function neverAnswering(dockerfile: string, marker: string): string {
  if (!/^[a-z0-9-]+$/.test(marker)) throw new Error(`The marker "${marker}" is not plain.`);
  const text = dockerfile.endsWith("\n") ? dockerfile : `${dockerfile}\n`;
  return `${text}CMD ["sh", "-c", "echo ${marker}; exec sleep 86400"]\n`;
}

/** What running `opscrew rollback` in a script needs of the live run. */
export interface RollbackCli {
  opscrew(...args: string[]): Promise<CliRun>;
  /** The output's last lines, scrubbed, for a message. */
  tail(text: string): string;
}

/**
 * `opscrew rollback` with `args` as a script runs it first, without `--approve`: it shows the
 * rollback and stops at its approval (exit 1), printing the command that applies it. Returns what
 * that command names and the output; throws with the output's tail otherwise.
 */
export async function shownRollback(
  cli: RollbackCli,
  args: readonly string[] = [],
): Promise<RollbackApproval & { output: string }> {
  const shown = await cli.opscrew("rollback", ...args);
  if (shown.exitCode !== 1) {
    throw new Error(
      `opscrew rollback without --approve must stop at its approval (exit 1), but exited with ${shown.exitCode}:\n${cli.tail(shown.output)}`,
    );
  }
  const approval = rollbackApproval(shown.output);
  if (approval === undefined) {
    throw new Error(`opscrew rollback printed no command to approve:\n${cli.tail(shown.output)}`);
  }
  return { ...approval, output: shown.output };
}

// ---------------------------------------------------------------------------------------------
// The database pass (US8): staging with examples/koa-knex, a table only the test writes, and v2's
// migration that adds a column to it.

/** The database pass's gate, apart from the image pass's: it pays for a deployment of its own. */
export const ROLLBACK_DATABASE_GATE = "OPSCREW_E2E_ROLLBACK_DATABASE";

/** The database pass's example: Knex migrations on PostgreSQL. */
export const DATABASE_EXAMPLE = "koa-knex";

/**
 * SC-1907: a rollback with the snapshot gives the earlier version its database within 5 minutes
 * of its approval.
 */
export const SC_1907_MS = 5 * 60_000;

/** The test's table: no route of the app writes it, so its rows are exactly the test's. */
export const ROWS_TABLE = "e2e_rows";

/** The column v2's migration adds to {@link ROWS_TABLE}. */
export const NOTE_COLUMN = "note";

/** A migration the throwaway copy gets: its path in the repository and its text. */
export interface Migration {
  path: string;
  text: string;
}

/** v1's migration, in the throwaway copy from the start: creates {@link ROWS_TABLE}. */
export const ROWS_MIGRATION: Migration = {
  path: "migrations/20261106000001_create_e2e_rows.js",
  text: [
    "// The live rollback test's table, which only the test writes.",
    `exports.up = (knex) => knex.schema.createTable("${ROWS_TABLE}", (table) => {`,
    '  table.increments("id");',
    '  table.text("label").notNullable();',
    "});",
    `exports.down = (knex) => knex.schema.dropTable("${ROWS_TABLE}");`,
    "",
  ].join("\n"),
};

/** v2's migration: adds {@link NOTE_COLUMN} to {@link ROWS_TABLE}, and its down drops it. */
export const NOTE_MIGRATION: Migration = {
  path: "migrations/20261106000002_add_e2e_note.js",
  text: [
    "// The live rollback test's v2: a column its down migration drops.",
    `exports.up = (knex) => knex.schema.alterTable("${ROWS_TABLE}", (table) => {`,
    `  table.text("${NOTE_COLUMN}");`,
    "});",
    `exports.down = (knex) => knex.schema.alterTable("${ROWS_TABLE}", (table) => {`,
    `  table.dropColumn("${NOTE_COLUMN}");`,
    "});",
    "",
  ].join("\n"),
};

/** SQL: {@link ROWS_TABLE}'s columns, in order. */
export const COLUMNS_SQL = `select column_name from information_schema.columns where table_name = '${ROWS_TABLE}' order by ordinal_position`;

/** SQL: {@link ROWS_TABLE}'s labels, in the order they were written. */
export const LABELS_SQL = `select label from ${ROWS_TABLE} order by id`;

/** `count` row labels of the run `runId`'s batch `batch` (`e2e-row-<run>-<batch><n>`). */
export function rowLabels(runId: string, batch: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `e2e-row-${runId}-${batch}${index + 1}`);
}

/**
 * SQL that writes a row of {@link ROWS_TABLE} for each of `labels`, with `note` in
 * {@link NOTE_COLUMN} when given (v2's schema). Every value must be plain: letters, digits and
 * dashes.
 */
export function insertRowsSql(labels: readonly string[], note?: string): string {
  if (labels.length === 0) throw new Error("No rows to write.");
  for (const value of [...labels, ...(note === undefined ? [] : [note])]) {
    if (!/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`The value "${value}" is not plain.`);
  }
  const rows = labels.map((label) =>
    note === undefined ? `('${label}')` : `('${label}', '${note}')`,
  );
  const columns = note === undefined ? "label" : `label, ${NOTE_COLUMN}`;
  return `insert into ${ROWS_TABLE} (${columns}) values ${rows.join(", ")}`;
}

/** The values `psql -tA` printed, one per line, without blank lines. */
export function psqlLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The inputs `opscrew rollback` dispatches the deploy workflow of `environment` with to roll back
 * to `digest`, built from `commit`: the digest, the commit tag of that environment's build, and
 * `rollback`.
 */
export function rollbackDispatchInputs(
  digest: string,
  commit: string,
  environment: string,
): Record<string, string> {
  return {
    [ROLLBACK_INPUTS.digest]: digest,
    [ROLLBACK_INPUTS.tag]: environmentTag(commit, environment),
    [ROLLBACK_INPUTS.rollback]: "true",
  };
}
