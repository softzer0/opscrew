/**
 * The database on a rollback (US8, plan.md 12.3 and 12.5, ADR 0028): what the rollback offers once
 * the version is chosen (the snapshot taken when that version stopped running, down migrations, or
 * keeping the database as it is), read from the app's folder on its server or this computer, and
 * the one-time approval the start script needs to change data (D10).
 */
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listText, OpsCrewError } from "@opscrew/core";
import { appDir, shellQuote } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  keepSnapshotsOf,
  MIGRATION_TOOLS,
  type Migrations,
  onOneServer,
  SNAPSHOT_KINDS,
  servicesOn,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { appFolder } from "../localhost/services";
import { NOTHING_CHANGED } from "../promote/shared";
import { serverShell } from "../status/servers";
import type { RollbackServices } from "./index";
import type { DatabaseBinding, DatabaseChoice, DatabaseRecord } from "./record";
import type { RollbackRun } from "./run";

/** One answer to "How should the rollback treat the database?", in the order offered. */
export interface DatabaseOffer {
  choice: DatabaseChoice;
  /** What it does and what it loses, in plain words. */
  text: string;
}

/** The question a terminal asks: the offers (keep is always one) and the default. */
export interface DatabaseQuestion {
  offers: DatabaseOffer[];
  default: DatabaseChoice;
}

/** The one-time approval in the app's folder (plan.md 12.3): `<hex> <choice> <expiry epoch>`. */
export const APPROVAL_FILE = ".rollback-database";

/** How long the start script accepts the one-time approval. */
const APPROVAL_SECONDS = 30 * 60;

/** The 64 hex digits of the digest a digest or an image reference ends with, as the files name it. */
export function hexOf(image: string): string | undefined {
  return /sha256:([0-9a-f]{64})$/.exec(image)?.[1];
}

/** A version's complete snapshot: written last, so it exists only once every dump is in. */
function takenFile(hex: string): string {
  return `.snapshots/${hex}/taken`;
}

/** A version's migration record. */
function recordFile(hex: string): string {
  return `.schema/${hex}`;
}

/**
 * The app's folder on the app's server or this computer. Every path is fixed text with checked
 * hex, and every line written is checked words: never text a user typed.
 */
interface AppFolder {
  /** The text of each of `paths` that exists, trimmed. */
  read(paths: readonly string[]): Promise<Map<string, string>>;
  /** Writes the one-time approval `line` (mode 600, the folder's owner's), or removes it. */
  approval(line: string | undefined): Promise<void>;
}

/** The read-only script: each existing file's path after `== `, then its text. */
export function readScript(dir: string, paths: readonly string[]): string {
  return `cd ${shellQuote(dir)} || exit 3; for f in ${paths.join(" ")}; do if [ -f "$f" ]; then echo "== $f"; cat "$f"; echo; fi; done`;
}

/**
 * Writes the one-time approval, mode 600 from the start. As root (a login through sudo), it hands
 * the file to the folder's owner, the deploy user, whose start script reads it.
 */
export function writeScript(dir: string, line: string): string {
  return `set -e; cd ${shellQuote(dir)}; umask 077; printf '%s\\n' ${shellQuote(line)} > ${APPROVAL_FILE}; chmod 600 ${APPROVAL_FILE}; if [ "$(id -u)" = 0 ]; then chown --reference=. ${APPROVAL_FILE}; fi`;
}

/** Removes the one-time approval, if any. */
export function removeScript(dir: string): string {
  return `cd ${shellQuote(dir)} || exit 3; rm -f ${APPROVAL_FILE}`;
}

/** The files {@link readScript} printed, by path; a path it did not print does not exist. */
export function readSections(stdout: string, paths: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const chunk of stdout.split(/^== /m).slice(1)) {
    const end = chunk.indexOf("\n");
    const path = end === -1 ? chunk : chunk.slice(0, end);
    if (paths.includes(path)) files.set(path, end === -1 ? "" : chunk.slice(end + 1).trim());
  }
  return files;
}

/**
 * The app's folder on its server, through the login `logs` uses ({@link serverShell}): the deploy
 * user on a server OpsCrew created, the admin login on the user's own, through `sudo -n` when it
 * reaches Docker only that way. Nothing it reads is ever shown.
 */
async function serverFolder(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: RollbackServices,
): Promise<AppFolder> {
  const { docker } = await serverShell(deps, plan, APP_SERVER, services);
  const dir = appDir(plan);
  const run = async (script: string, what: string): Promise<string> => {
    const result = await docker.run(script, { timeoutMs: 60_000 });
    if (result.exitCode === 0) return result.stdout;
    throw new OpsCrewError(
      "COMMAND_FAILED",
      result.exitCode === 255 || result.timedOut === true
        ? `The app's server did not answer over SSH, so OpsCrew could not ${what}.`
        : `OpsCrew could not ${what} on the app's server (exit code ${result.exitCode}).`,
      { hint: "Check that the server is on and answers (`opscrew status`), then try again." },
    );
  };
  return {
    read: async (paths) =>
      readSections(
        await run(readScript(dir, paths), "read the database's snapshots and migration records"),
        paths,
      ),
    approval: async (line) => {
      await run(
        line === undefined ? removeScript(dir) : writeScript(dir, line),
        line === undefined
          ? "remove the one-time approval of the database step"
          : "leave the one-time approval of the database step",
      );
    },
  };
}

/** The app's folder on this computer. */
function localFolder(deps: PhaseDeps, plan: DeployPlan): AppFolder {
  const folder = appFolder(deps.paths, plan);
  return {
    async read(paths) {
      const files = new Map<string, string>();
      for (const path of paths) {
        try {
          files.set(path, (await readFile(join(folder, path), "utf8")).trim());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return files;
    },
    async approval(line) {
      const file = join(folder, APPROVAL_FILE);
      if (line === undefined) {
        await rm(file, { force: true });
        return;
      }
      await writeFile(file, `${line}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
    },
  };
}

/** The app's folder of `run`'s target: on its server or this computer; none in a Portainer. */
async function folderOf(run: RollbackRun): Promise<AppFolder | undefined> {
  const { deps, plan, services } = run;
  if (plan.target.provider === "localhost") return localFolder(deps, plan);
  return onOneServer(plan.target.provider) ? serverFolder(deps, plan, services) : undefined;
}

/**
 * Removes the one-time approval of the database step from the app's folder of `run`'s target, if
 * it has one: a run that waited for a reviewer ended without using it.
 */
export async function removeDatabaseApproval(run: RollbackRun): Promise<void> {
  await (await folderOf(run))?.approval(undefined);
}

/**
 * What the result says the rollback did with the database (`record`), the target named `words`
 * and its migration tool `plan`'s.
 */
export function databaseOutcome(record: DatabaseRecord, plan: DeployPlan, words: string): string {
  if (record.choice === "snapshot") {
    return `The database was restored from the snapshot taken ${formatUtc(record.taken ?? "")}.`;
  }
  if (record.choice === "migrations") {
    return `The database was migrated down with ${plan.app.migrations?.tool ?? "its migration tool"} to ${words}'s migrations.`;
  }
  return "The database stayed as it was.";
}

/** A complete snapshot's `taken`: an ISO time. */
const TakenSchema = z.iso.datetime({ offset: true });

/** A count tool's record: `count=<n>`. */
function countOf(record: string): number | undefined {
  const match = /^count=(\d+)$/m.exec(record);
  return match === null ? undefined : Number(match[1]);
}

/**
 * True when `tool` counts its migrations and the earlier version's count is higher than the
 * running one's, or either record has none: the history is not a straight line back.
 */
function countGrew(tool: Migrations["tool"], target: string, current: string): boolean {
  const unit = MIGRATION_TOOLS[tool].unit;
  if (unit !== "count" && unit !== "each") return false;
  const before = countOf(target);
  const now = countOf(current);
  return before === undefined || now === undefined || before > now;
}

/** The data a snapshot does not cover, kept as it is, and that snapshots of it come later (FR-1930). */
function keptLines(plan: DeployPlan): string[] {
  const portainer = plan.target.provider === "portainer";
  const elsewhere = plan.services.filter(
    (service) =>
      service.enabled &&
      SNAPSHOT_KINDS.has(service.kind) &&
      (portainer || (service.server ?? APP_SERVER) !== APP_SERVER),
  );
  const items = [
    ...elsewhere.map((service) =>
      portainer ? service.name : `${service.name} on server ${service.server}`,
    ),
    ...(plan.storage?.sqlite !== undefined ? ["the app's own files"] : []),
  ];
  if (items.length === 0) return [];
  return [
    portainer
      ? `Kept as they are in your Portainer: ${listText(items)}. Snapshots there come in a later release.`
      : `Kept as they are: ${listText(items)}. Snapshots of ${items.length === 1 ? "it" : "them"} come in a later release.`,
  ];
}

/** What the approval says when the database stays as it is. */
const KEEP_LINE =
  "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.";

/** The database step of one rollback, once chosen ({@link databaseStep}). */
export interface DatabaseStep {
  choice: DatabaseChoice;
  /** What the hash binds; absent when the plan has neither snapshots nor down migrations. */
  binding?: DatabaseBinding;
  /** The approval's lines on the data. */
  lines: string[];
  /** The name typed to approve a choice that changes data: the one `destroy --env` asks for. */
  confirmPhrase?: string;
  /** The flags that make the same choice in a script: ` --database <choice>`, ` --confirm <name>`. */
  flags: string;
  /** What `rollback.json` records. */
  record: DatabaseRecord;
  /** What the result says once the earlier version runs. */
  outcome: string;
  /**
   * Before the deploy runs: leaves the one-time approval of a choice that changes data and returns
   * when it expires (ISO), or removes an earlier one; nothing without {@link binding}.
   */
  leave(): Promise<string | undefined>;
  /** Removes the one-time approval once no run can use it; nothing without {@link binding}. */
  clear(): Promise<void>;
}

/** The refusal of a choice not offered, with why and what is offered, before any change. */
function notOffered(
  run: RollbackRun,
  reason: string,
  offers: readonly DatabaseOffer[],
): OpsCrewError {
  const flags = offers.map((offer) => `--database ${offer.choice}`);
  return new OpsCrewError("PHASE_PRECONDITION", `${reason} ${NOTHING_CHANGED}`, {
    hint: `Run \`${run.command}\` with ${flags.length === 1 ? flags[0] : `one of ${listText(flags)}`}.`,
  });
}

/**
 * The database step of `run`'s rollback from the image `current` to `target` (digests, or this
 * computer's image references), the target named `words` (FR-1924):
 * 1. with snapshots on (`snapshotsOn`) or down migrations in the plan (`app.migrations`), it reads
 *    the target's snapshot (`taken`) and both versions' records with a fixed read-only script,
 *    through the access `logs --failed` uses, or locally on this computer; Portainer has neither;
 * 2. it offers the snapshot when the target has a complete one, down migrations when both records
 *    exist and a count tool's count did not grow going back, and keep, always;
 * 3. it takes `--database`, refusing a choice not offered with its reason (`PHASE_PRECONDITION`,
 *    nothing changed); else, with several offers, asks `chooseDatabase`; else the default: the
 *    snapshot on an environment other than prod, keep otherwise.
 *
 * On a server or this computer, keep's `leave` removes any one-time approval an earlier run left,
 * so the start script neither changes this rollback's data nor stops on an expired one.
 */
export async function databaseStep(
  run: RollbackRun,
  input: { current: string; target: string; words: string },
): Promise<DatabaseStep> {
  const { deps, options, plan, environment } = run;
  const snapshots = snapshotsOn(plan);
  const migrations = plan.target.provider === "portainer" ? undefined : plan.app.migrations;
  const kept = keptLines(plan);
  const keepOffer: DatabaseOffer = {
    choice: "keep",
    text: `Keep it as it is: ${input.words} runs against today's schema.`,
  };
  // Connected before the approval, so a server OpsCrew cannot reach stops before any change.
  const folder = await folderOf(run);
  const keep = (binding?: DatabaseBinding): DatabaseStep => ({
    choice: "keep",
    ...(binding !== undefined ? { binding } : {}),
    lines: [KEEP_LINE, ...kept],
    flags: binding !== undefined ? " --database keep" : "",
    record: { choice: "keep" },
    outcome: databaseOutcome({ choice: "keep" }, plan, input.words),
    // A one-time approval an earlier run left must not change the data of this one, nor stop it.
    leave: async () => {
      await folder?.approval(undefined);
      return undefined;
    },
    clear: async () => {},
  });

  // 1. Nothing to read (or nowhere to read it): the database stays as it is.
  if (folder === undefined || (!snapshots && migrations === undefined)) {
    const asked = options.database;
    if (asked !== undefined && asked !== "keep") {
      throw notOffered(run, unreadReason(run, asked), [keepOffer]);
    }
    return keep();
  }
  const targetHex = hexOf(input.target);
  const currentHex = hexOf(input.current);
  const paths = [
    ...(targetHex !== undefined ? [takenFile(targetHex), recordFile(targetHex)] : []),
    ...(currentHex !== undefined ? [recordFile(currentHex)] : []),
  ];
  deps.reporter.step(`Reading ${environment}'s database snapshots and migration records`);
  const files = paths.length > 0 ? await folder.read(paths) : new Map<string, string>();
  const takenText = targetHex === undefined ? undefined : files.get(takenFile(targetHex));
  const taken = TakenSchema.safeParse(takenText).success ? takenText : undefined;
  const targetRecord = targetHex === undefined ? undefined : files.get(recordFile(targetHex));
  const currentRecord = currentHex === undefined ? undefined : files.get(recordFile(currentHex));

  // 2. The offers, and why each other one is not.
  const offers: DatabaseOffer[] = [];
  const why: Partial<Record<DatabaseChoice, string>> = {};
  if (!snapshots) {
    why.snapshot = unreadReason(run, "snapshot");
  } else if (taken === undefined) {
    why.snapshot = `The server keeps no complete snapshot of ${input.words}: a deploy takes one when it replaces a version, and the server keeps those of the last ${keepSnapshotsOf(plan)}.`;
  } else {
    offers.push({
      choice: "snapshot",
      text: `Restore the snapshot taken ${formatUtc(taken)}, when ${input.words} stopped running. Everything written since is lost.`,
    });
  }
  if (migrations === undefined) {
    why.migrations = unreadReason(run, "migrations");
  } else if (currentRecord === undefined || targetRecord === undefined) {
    const missing =
      currentRecord === undefined && targetRecord === undefined
        ? "of either version"
        : currentRecord === undefined
          ? "of the version running now"
          : `of ${input.words}`;
    why.migrations = `The server holds no record of the migrations ${missing}: each deploy records them after its release command.`;
  } else if (countGrew(migrations.tool, targetRecord, currentRecord)) {
    why.migrations = `${input.words} has more migrations applied than the version running now, or a record of them is unreadable, so migrating down would not reach its schema.`;
  } else {
    offers.push({
      choice: "migrations",
      text: `Migrate it down with ${migrations.tool} to ${input.words}'s migrations. The tables and columns added since are dropped, with their data.`,
    });
  }
  offers.push(keepOffer);

  // 3. The choice.
  // Prod's plan names no environment.
  const fallback =
    plan.environment?.name !== undefined && offers[0]?.choice === "snapshot" ? "snapshot" : "keep";
  let choice: DatabaseChoice = fallback;
  if (options.database !== undefined) {
    const reason = why[options.database];
    if (reason !== undefined) throw notOffered(run, reason, offers);
    choice = options.database;
  } else if (offers.length > 1 && options.chooseDatabase !== undefined) {
    choice = await options.chooseDatabase({ offers, default: fallback });
  }
  const binding: DatabaseBinding = {
    choice,
    taken: taken ?? null,
    currentRecord: currentRecord ?? null,
    targetRecord: targetRecord ?? null,
  };
  if (choice === "keep") return keep(binding);

  // Only a target with a digest has a snapshot or a record to offer.
  const hex = targetHex as string;
  const offer = offers.find((candidate) => candidate.choice === choice) as DatabaseOffer;
  // The name `destroy --env` asks for: the environment's app (`<app>-<env>` outside prod).
  const name = plan.app.name;
  const record: DatabaseRecord =
    choice === "snapshot" ? { choice, taken: taken as string } : { choice };
  return {
    choice,
    binding,
    lines: [
      `Database: ${offer.text}`,
      ...(choice === "snapshot" ? kept : []),
      "The app's settings and secrets stay as they are now. The release command does not run.",
      `Typing ${name} approves it. OpsCrew then leaves a one-time approval in the app's folder, valid for 30 minutes, which the deploy's start step uses once.`,
    ],
    confirmPhrase: name,
    flags: ` --database ${choice} --confirm ${name}`,
    record,
    outcome: databaseOutcome(record, plan, input.words),
    leave: async () => {
      const expiry = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
      await folder.approval(`${hex} ${choice} ${expiry}`);
      return new Date(expiry * 1000).toISOString();
    },
    clear: () => folder.approval(undefined),
  };
}

/** Why `choice` is not offered when the plan has neither snapshots nor its kind of change. */
function unreadReason(run: RollbackRun, choice: "snapshot" | "migrations"): string {
  const { plan, environment } = run;
  if (plan.target.provider === "portainer") {
    return "In your Portainer, a rollback keeps the database as it is: snapshots and down migrations there come in a later release.";
  }
  if (choice === "migrations") {
    return `${environment}'s plan has no app.migrations, so OpsCrew knows no down migrations for its app. It sets them for Rails, Django, Alembic, Flask-Migrate, Knex, Sequelize, TypeORM and Laravel.`;
  }
  if (!servicesOn(plan, APP_SERVER).some((service) => SNAPSHOT_KINDS.has(service.kind))) {
    return `No PostgreSQL, MySQL, MariaDB or MongoDB runs on ${environment}'s app server, so OpsCrew takes no snapshots there.`;
  }
  return `${environment} takes no snapshots before its releases: deploy.snapshots is off in its plan (prod takes them only with deploy.snapshots: true).`;
}
