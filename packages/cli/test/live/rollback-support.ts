/**
 * Pure helpers of feature 019's live test (`rollback.test.ts`, docs/e2e.md "Rollback") and of the
 * site passes' rollback steps: the gate, the test's own release command, the deploy workflow's job
 * names, and what the tests read in OpsCrew's output (the rollback a script is asked to approve,
 * the run it started, `rollback --list`'s table, `status`' Deploys lines) and in the deploy pause
 * variable, the Dockerfile change whose image never answers, and `opscrew rollback` run as a script
 * runs it (the CLI injected). No network, no processes of their own; unit-tested in
 * `rollback-support.test.ts`.
 */
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import type { CliRun } from "./harness";

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

/** SC-1901: a rollback serves the earlier version within 2 minutes of its approval. */
export const SC_1901_MS = 2 * 60_000;

/** The job that says why a run doesn't deploy while the environment's deploys are paused. */
export const PAUSED_JOB = "Report the deploy pause";

/**
 * The rollback a run without `--approve` showed: the version the printed command goes back to
 * (`--to`), its hash, and the approval's `Now:` and `Back to:` lines on a server.
 */
export interface RollbackApproval {
  to: string;
  hash: string;
  now?: string;
  backTo?: string;
}

/**
 * The rollback an `opscrew rollback` run showed, from the command it printed to apply it
 * (`opscrew rollback [--app <key>] --env <env> --to <version> [--allow-old-secrets <names>]
 * --approve <hash>`): the last one when it printed several, `undefined` when none.
 */
export function rollbackApproval(output: string): RollbackApproval | undefined {
  const printed = [
    ...output.matchAll(
      /opscrew rollback\b[^\n`]*? --to (\S+)(?: --allow-old-secrets \S+)? --approve ([0-9a-f]{64})\b/g,
    ),
  ].at(-1);
  const [, to, hash] = printed ?? [];
  if (to === undefined || hash === undefined) return undefined;
  const line = (label: string) => new RegExp(`^\\s*${label}: (.+)$`, "m").exec(output)?.[1]?.trim();
  const now = line("Now");
  const backTo = line("Back to");
  return {
    to,
    hash,
    ...(now !== undefined ? { now } : {}),
    ...(backTo !== undefined ? { backTo } : {}),
  };
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
