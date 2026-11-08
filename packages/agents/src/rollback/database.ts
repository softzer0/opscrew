/**
 * The database on a rollback (US8, plan.md 12.3 and 12.5, ADR 0028; 024 US7): what the rollback
 * offers once the version is chosen (the snapshot taken when that version stopped running, down
 * migrations, or keeping the data as it is), read from the app's folder on its servers or this
 * computer, and the one-time approval the start script, and on each extra server that holds part
 * of the snapshot the workflow's restore there, need to change data (D10).
 */
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "@opscrew/contracts";
import { listText, OpsCrewError, upperFirst } from "@opscrew/core";
import {
  appDir,
  DATABASE_CHANGED,
  migratedParts,
  OTHERS_HELD,
  portainerStackTemplatePath,
  ROLLBACK_APPROVAL_FILE,
  rollbackApprovalLine,
  rollbackServers,
  schemaRecordPath,
  shellQuote,
  snapshotAboutPath,
  snapshotParts,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  keepSnapshotsOf,
  MIGRATION_TOOLS,
  type Migrations,
  ONLINE_SNAPSHOT_KINDS,
  onOneServer,
  snapshotsOn,
} from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { appFolder } from "../localhost/services";
import { NOTHING_CHANGED } from "../promote/shared";
import { serverWords } from "../shared/server-address";
import { type About, aboutOf } from "../snapshot/store";
import { serverShell } from "../status/servers";
import type { RollbackServices } from "./index";
import { type PortainerRestore, portainerRestore, readPortainerSnapshot } from "./portainer";
import type { DatabaseBinding, DatabaseChoice, DatabaseRecord } from "./record";
import type { RollbackRepository, RollbackRun } from "./run";

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

/** How long the start script accepts the one-time approval. */
export const APPROVAL_SECONDS = 30 * 60;

/** The 64 hex digits of the digest a digest or an image reference ends with, as the files name it. */
export function hexOf(image: string): string | undefined {
  return /sha256:([0-9a-f]{64})$/.exec(image)?.[1];
}

/**
 * The app's folder on the app's server or this computer. Every path is fixed text with checked
 * hex, and every line written is checked words: never text a user typed.
 */
interface AppFolder {
  /** The text of each of `paths` that exists, trimmed; `undefined` when the server did not answer. */
  read(paths: readonly string[]): Promise<Map<string, string> | undefined>;
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
  return `set -e; cd ${shellQuote(dir)}; umask 077; printf '%s\\n' ${shellQuote(line)} > ${ROLLBACK_APPROVAL_FILE}; chmod 600 ${ROLLBACK_APPROVAL_FILE}; if [ "$(id -u)" = 0 ]; then chown --reference=. ${ROLLBACK_APPROVAL_FILE}; fi`;
}

/** Removes the one-time approval, if any. */
export function removeScript(dir: string): string {
  return `cd ${shellQuote(dir)} || exit 3; rm -f ${ROLLBACK_APPROVAL_FILE}`;
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
 * The app's folder on its server `server` (the app's, or an extra one), through the login `logs`
 * uses ({@link serverShell}): the deploy user on a server OpsCrew created, the admin login on the
 * user's own, through `sudo -n` when it reaches Docker only that way. Nothing it reads is ever
 * shown.
 */
async function serverFolder(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: RollbackServices,
  server: string,
): Promise<AppFolder> {
  const { docker } = await serverShell(deps, plan, server, services);
  const dir = appDir(plan);
  const where = serverWords(server);
  const answered = (result: CommandResult) => result.exitCode !== 255 && result.timedOut !== true;
  return {
    async read(paths) {
      const result = await docker.run(readScript(dir, paths), { timeoutMs: 60_000 });
      if (!answered(result)) return undefined;
      if (result.exitCode !== 0) {
        throw new OpsCrewError(
          "COMMAND_FAILED",
          `OpsCrew could not read the database's snapshots and migration records on ${where} (exit code ${result.exitCode}). ${NOTHING_CHANGED}`,
          { hint: "Run `opscrew status` to see what runs there, then try again." },
        );
      }
      return readSections(result.stdout, paths);
    },
    async approval(line) {
      const script = line === undefined ? removeScript(dir) : writeScript(dir, line);
      const result = await docker.run(script, { timeoutMs: 60_000 });
      if (result.exitCode === 0) return;
      const what = `${line === undefined ? "remove" : "leave"} the one-time approval of the database step`;
      const said = answered(result)
        ? `OpsCrew could not ${what} on ${where} (exit code ${result.exitCode}).`
        : `${upperFirst(where)} did not answer over SSH, so OpsCrew could not ${what}.`;
      throw new OpsCrewError("COMMAND_FAILED", said, {
        hint: "Check that the server is on and answers (`opscrew status`), then try again.",
      });
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
      const file = join(folder, ROLLBACK_APPROVAL_FILE);
      if (line === undefined) {
        await rm(file, { force: true });
        return;
      }
      await writeFile(file, `${line}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
    },
  };
}

/**
 * The app's folder of `run`'s target on `server` (the app's by default, or an extra one): on its
 * server or this computer; none in a Portainer.
 */
async function folderOf(run: RollbackRun, server = APP_SERVER): Promise<AppFolder | undefined> {
  const { deps, plan, services } = run;
  if (plan.target.provider === "localhost") return localFolder(deps, plan);
  return onOneServer(plan.target.provider) ? serverFolder(deps, plan, services, server) : undefined;
}

/**
 * The extra servers whose data `plan`'s rollback changes from the runner, each after its own
 * one-time approval (plan.md D7, D13): for `choice`, or for either.
 */
function otherServers(plan: DeployPlan, choice?: "snapshot" | "migrations"): string[] {
  return plan.target.provider === "localhost" ? [] : rollbackServers(plan, choice);
}

/**
 * Removes the one-time approval in each of `folders` (the app's server's first), each tried
 * whatever the others did; a folder this computer can't reach counts as an error. Throws the
 * first error once all were tried.
 */
async function removeApprovals(
  folders: readonly (() => Promise<AppFolder | undefined>)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const folder of folders) {
    await folder()
      .then((reached) => reached?.approval(undefined))
      .catch((error: unknown) => errors.push(error));
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * Removes the one-time approval of the database step from the app's folder of `run`'s target, if
 * it has one, then from each extra server's whose data the rollback changes: a run that waited
 * for a reviewer ended without using them.
 */
export async function removeDatabaseApproval(run: RollbackRun): Promise<void> {
  await removeApprovals(
    [APP_SERVER, ...otherServers(run.plan)].map((server) => () => folderOf(run, server)),
  );
}

/** The app's folder of `run`'s target on `server`, or `undefined` when this computer can't reach it. */
function reachFolder(run: RollbackRun, server: string): Promise<AppFolder | undefined> {
  return folderOf(run, server).catch((error: unknown) => {
    if (error instanceof OpsCrewError) return undefined;
    throw error;
  });
}

/** What a rollback that couldn't put the data on extra servers back left ({@link earlierChange}). */
export interface EarlierChange {
  /** The app's `.env` names the version that rollback went to: its start step had switched. */
  switched: boolean;
  /** The extra servers whose data it changed, by their markers, in plan order, with its choice. */
  servers: { name: string; choice: "snapshot" | "migrations" }[];
}

/** A line `<name>=<value>` of `text`, or `undefined`. */
function field(text: string, name: string): string | undefined {
  return new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1];
}

/**
 * What an earlier rollback of `run`'s target left when it stopped with the data on extra servers
 * changed (plan.md D7): the app's server's record that a run held the app for them
 * ({@link OTHERS_HELD}, which a rollback that finished removes) and the extra servers'
 * {@link DATABASE_CHANGED} markers of that run, which saved its copy under the running version
 * (`running`, by the environment's label) and say their data changed. Either the app's `.env`
 * still names the running version, or it names the version each of those markers went to
 * (`switched`). `undefined` without them, when this computer can't reach the servers, or when the
 * files don't tell one rollback's story.
 */
export async function earlierChange(
  run: RollbackRun,
  running: string,
): Promise<EarlierChange | undefined> {
  const servers = otherServers(run.plan);
  const runningHex = hexOf(running);
  if (servers.length === 0 || runningHex === undefined) return undefined;
  const app = await (await reachFolder(run, APP_SERVER))?.read([".env", OTHERS_HELD]);
  if (app?.has(OTHERS_HELD) !== true) return undefined;
  const marks: { name: string; choice: "snapshot" | "migrations"; target: string }[] = [];
  for (const server of servers) {
    const marker = (await (await reachFolder(run, server))?.read([DATABASE_CHANGED]))?.get(
      DATABASE_CHANGED,
    );
    if (marker === undefined || field(marker, "changed") !== "1") continue;
    if (field(marker, "saved") !== runningHex) continue;
    const choice = field(marker, "choice");
    if (choice !== "snapshot" && choice !== "migrations") continue;
    marks.push({ name: server, choice, target: field(marker, "target") ?? "" });
  }
  if (marks.length === 0) return undefined;
  const image = field(app.get(".env") ?? "", "APP_IMAGE");
  const envHex = image === undefined ? undefined : hexOf(image);
  const changed = marks.map(({ name, choice }) => ({ name, choice }));
  if (envHex === runningHex) return { switched: false, servers: changed };
  if (envHex !== undefined && marks.every((mark) => mark.target === envHex)) {
    return { switched: true, servers: changed };
  }
  return undefined;
}

/**
 * The hint of a rollback to the running version refused after `earlier` stopped before its start
 * step switched: the app's server still runs that version, and each changed server's copy from
 * before it goes back with a restore of each part it holds (the down migrations' copy holds only
 * the databases).
 */
export function restoreHint(run: RollbackRun, earlier: EarlierChange, running: string): string {
  const hex = hexOf(running) ?? running;
  const commands = earlier.servers.flatMap(({ name, choice }) =>
    (choice === "snapshot" ? snapshotParts(run.plan, name) : migratedParts(run.plan, name)).map(
      (part) => `\`opscrew restore${run.flags} ${hex} --only ${part.name}\``,
    ),
  );
  const where = listText(earlier.servers.map(({ name }) => serverWords(name)));
  return `The rollback that failed changed the data on ${where} before the app switched, so ${run.environment}'s app server still runs this version on its own data. Once each of those servers is fixed, run ${listText(commands)}: each puts the copy that rollback saved before changing anything back on its server.`;
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

/**
 * The services a snapshot holds no copy of on each server (`abouts`, by server), which its restore
 * keeps as they are, each with its reason: the SQLite volume was empty; its copy failed; a
 * stop-only service `deploy.snapshotStop` doesn't name; or any other had no container yet. In the
 * user's Portainer, also a stop-only service the snapshot doesn't list: the snapshot before a
 * release there copies only what it can copy while it runs (D3).
 */
function leftOutLines(plan: DeployPlan, abouts: ReadonlyMap<string, About>): string[] {
  const stop = plan.deploy.snapshotStop ?? [];
  const items = [...abouts].flatMap(([server, about]) =>
    about.services
      .filter((service) => "skipped" in service || "failed" in service)
      .map((service) => {
        const on = server === APP_SERVER ? "" : ` on server ${server}`;
        if (service.kind === "sqlite") return `the app's SQLite files${on} (the volume was empty)`;
        if (service.kind === "files")
          return `the app's kept folder${on} (its volume did not exist yet)`;
        const why =
          "failed" in service
            ? "its copy failed"
            : !ONLINE_SNAPSHOT_KINDS.some((kind) => kind === service.kind) &&
                !stop.includes(service.name)
              ? "it must stop for its copy, and deploy.snapshotStop doesn't name it"
              : "it had no container yet";
        return `${service.name}${on} (${why})`;
      }),
  );
  if (plan.target.provider === "portainer") {
    const listed = abouts.get(APP_SERVER)?.services.map((service) => service.name) ?? [];
    for (const part of snapshotParts(plan)) {
      if (part.online || listed.includes(part.name)) continue;
      items.push(
        `${part.name} (it must stop for its copy, which the snapshot before a release in your Portainer never does)`,
      );
    }
  }
  if (items.length === 0) return [];
  return [`Kept as they are, since the snapshot holds no copy of them: ${listText(items)}.`];
}

/** What the approval says when the database stays as it is. */
const KEEP_LINE =
  "The data, the database schema and the app's settings and secrets stay as they are now: the earlier version must work with them. The release command does not run.";

/** What a rollback in the user's Portainer gives its database step. */
export interface PortainerFacts {
  /** The GitHub environment whose required reviewer GitHub asks before the deploy job. */
  reviewed?: string;
  /** The stack template on the dispatch branch is the committed one, by its blob. */
  templateApplied: boolean;
  /** The image references running now and of the target. */
  images: { current: string; target: string };
  /** The repository, whose deploy branch the undo reads. */
  github: RollbackRepository;
}

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
   * when it expires (ISO); for keep, removes an earlier one where the folder is reachable, and
   * never fails.
   */
  leave(): Promise<string | undefined>;
  /** Removes the one-time approval of a choice that changes data once no run can use it. */
  clear(): Promise<void>;
  /**
   * In the user's Portainer, the snapshot's restore, which `leave` runs before the dispatch (D19):
   * finished once the run succeeded, undone once it failed or never started.
   */
  portainer?: PortainerRestore;
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
 * computer's image references), the target named `words` (FR-1924; 024 US7):
 * 1. with snapshots on (`snapshotsOn`) or down migrations in the plan (`app.migrations`), it reads
 *    the target's snapshot (its `about.json`) and both versions' records with a fixed read-only
 *    script, through the access `logs --failed` uses, or locally on this computer, and the
 *    target's `about.json` on each extra server that holds part of the snapshot (Portainer:
 *    below);
 * 2. it offers the snapshot when every server that holds part of it has the target's complete
 *    snapshot (a folder without `about.json`, such as 0.2.4's, is none), down migrations when both
 *    records exist and a count tool's count did not grow going back, and keep, always;
 * 3. it takes `--database`, refusing a choice not offered with its reason (`PHASE_PRECONDITION`,
 *    nothing changed); else, with several offers, asks `chooseDatabase`; else the default: the
 *    snapshot on an environment other than prod, keep otherwise.
 *
 * When this computer cannot reach the app's server (no address or login here, or no answer), it
 * offers only keep and says why, and the rollback goes on through GitHub as without snapshots; an
 * extra server it cannot reach leaves the snapshot out.
 *
 * A choice that changes data leaves its one-time approval on each extra server whose data it
 * changes (plan.md D7, D13: for the down migrations, those with a database), then on the app's
 * server, and removes them all when one fails; its `clear` tries every one, the app's server's
 * first. Keep's `leave` removes a one-time approval an earlier run left, where the folders are
 * reachable, so the deploy neither changes this rollback's data nor stops on an expired one; it
 * never stops the rollback.
 *
 * In the user's Portainer (D14, D19) it reads the target's snapshot in the stack's snapshots
 * volume ({@link readPortainerSnapshot}) and offers it, or keep, the default answer there; down
 * migrations aren't run there.
 * The rollback's switch runs in the workflow, so this computer restores the snapshot before the
 * dispatch (`leave`, {@link portainerRestore}, from `portainer.images.current` to
 * `portainer.images.target`), and the app stays stopped until the run starts the target. The
 * snapshot is not offered with a required reviewer on the environment (`portainer.reviewed`), nor
 * when the stack template on the dispatch branch is not the committed one
 * (`portainer.templateApplied`), whose guard keeps other versions off the restored data.
 */
export async function databaseStep(
  run: RollbackRun,
  input: {
    current: string;
    target: string;
    words: string;
    /** What the user's Portainer needs ({@link databaseStep}). */
    portainer?: PortainerFacts;
  },
): Promise<DatabaseStep> {
  const { deps, options, plan, environment } = run;
  // Down migrations aren't run by a rollback in the user's Portainer.
  const portainer = plan.target.provider === "portainer";
  const snapshots = snapshotsOn(plan);
  const migrations = portainer ? undefined : plan.app.migrations;
  // The extra servers that hold part of the snapshot, each restored from the runner.
  const restoring = snapshots ? otherServers(plan, "snapshot") : [];
  /** The app's folder on `server`, or `undefined` without an address or login for it here. */
  const reach = (server: string) => reachFolder(run, server);
  const keepOffer: DatabaseOffer = {
    choice: "keep",
    text: `Keep it as it is: ${input.words} runs against today's schema.`,
  };
  const keep = (binding?: DatabaseBinding, reachable = true) => {
    const step: DatabaseStep = {
      choice: "keep",
      ...(binding !== undefined ? { binding } : {}),
      lines: [KEEP_LINE],
      flags: binding !== undefined ? " --database keep" : "",
      record: { choice: "keep" },
      outcome: databaseOutcome({ choice: "keep" }, plan, input.words),
      // An approval an earlier run left must not change this one's data, nor stop it: best effort.
      leave: async () => {
        if (!reachable) return undefined;
        const servers = [APP_SERVER, ...otherServers(plan)];
        await removeApprovals(servers.map((server) => () => folderOf(run, server))).catch(
          () => undefined,
        );
        return undefined;
      },
      clear: async () => {},
    };
    return step;
  };
  // The only choice that needs nothing of the server, and why the others are not offered.
  const keepOnly = (reason: (choice: "snapshot" | "migrations") => string, warn?: string) => {
    const asked = options.database;
    if (asked !== undefined && asked !== "keep") throw notOffered(run, reason(asked), [keepOffer]);
    if (warn !== undefined) deps.reporter.warn(warn);
  };

  // 1. Nothing to read: the database stays as it is.
  if (!snapshots && migrations === undefined) {
    keepOnly((choice) => unreadReason(run, choice));
    // Connected only after the approval, to remove an earlier one-time approval.
    return keep();
  }
  if (portainer) return portainerStep(run, input, { keep, keepOnly, keepOffer });
  const targetHex = hexOf(input.target);
  const currentHex = hexOf(input.current);
  const about = targetHex === undefined ? undefined : snapshotAboutPath(targetHex);
  const paths = [
    ...(targetHex !== undefined ? [snapshotAboutPath(targetHex), schemaRecordPath(targetHex)] : []),
    ...(currentHex !== undefined ? [schemaRecordPath(currentHex)] : []),
  ];
  deps.reporter.step(`Reading ${environment}'s database snapshots and migration records`);
  // No address or login for the server on this computer, or no answer from it.
  const folder = await reach(APP_SERVER);
  const files = await folder?.read(paths);
  if (folder === undefined || files === undefined) {
    const unreachable = `This computer can't reach ${environment}'s app server, so OpsCrew offers only to keep the database as it is: the snapshot and down migrations need this computer to reach the server (the computer that deployed it, or one restored from the recovery copy).`;
    keepOnly(() => unreachable, unreachable);
    return keep(undefined, false);
  }
  // Each server's part of the target's snapshot: its `about.json`.
  const abouts = new Map<string, About>();
  const missing: string[] = [];
  const unreached: string[] = [];
  const folders = new Map<string, AppFolder>();
  if (snapshots && about !== undefined) {
    // A folder without about.json (0.2.4's) holds no complete snapshot.
    const text = snapshotParts(plan).length > 0 ? files.get(about) : undefined;
    const own = text === undefined ? undefined : aboutOf(text);
    if (own !== undefined) abouts.set(APP_SERVER, own);
    else if (snapshotParts(plan).length > 0) missing.push(APP_SERVER);
    for (const server of restoring) {
      const extra = await reach(server);
      const read = await extra?.read([about]);
      if (extra === undefined || read === undefined) {
        unreached.push(server);
        continue;
      }
      folders.set(server, extra);
      const partText = read.get(about);
      const part = partText === undefined ? undefined : aboutOf(partText);
      if (part !== undefined) abouts.set(server, part);
      else missing.push(server);
    }
  }
  const taken = abouts.get(APP_SERVER)?.taken ?? [...abouts.values()][0]?.taken;
  const targetRecord = targetHex === undefined ? undefined : files.get(schemaRecordPath(targetHex));
  const currentRecord =
    currentHex === undefined ? undefined : files.get(schemaRecordPath(currentHex));

  // 2. The offers, and why each other one is not.
  const offers: DatabaseOffer[] = [];
  const why: Partial<Record<DatabaseChoice, string>> = {};
  if (!snapshots) {
    why.snapshot = unreadReason(run, "snapshot");
  } else if (unreached.length > 0) {
    why.snapshot = `This computer can't reach ${listText(unreached.map(serverWords))}, which holds part of the snapshot of ${input.words}, so OpsCrew can't restore it.`;
  } else if (missing.length > 0 || taken === undefined) {
    const listed = listText(missing.map(serverWords));
    const where = restoring.length === 0 ? "The server" : upperFirst(listed);
    const each = restoring.length === 0 ? "the server keeps" : "each server keeps";
    why.snapshot = `${where} ${missing.length > 1 ? "keep" : "keeps"} no complete snapshot of ${input.words}: a deploy takes one when it replaces a version, and ${each} those of the last ${keepSnapshotsOf(plan)}.`;
  } else {
    offers.push(snapshotOffer(taken, input.words));
  }
  if (migrations === undefined) {
    why.migrations = unreadReason(run, "migrations");
  } else if (currentRecord === undefined || targetRecord === undefined) {
    const absent =
      currentRecord === undefined && targetRecord === undefined
        ? "of either version"
        : currentRecord === undefined
          ? "of the version running now"
          : `of ${input.words}`;
    why.migrations = `The server holds no record of the migrations ${absent}: each deploy records them after its release command.`;
  } else if (countGrew(migrations.tool, targetRecord, currentRecord)) {
    why.migrations = `${input.words} has more migrations applied than the version running now, or a record of them is unreadable, so migrating down would not reach its schema.`;
  } else {
    offers.push({
      choice: "migrations",
      text: `Migrate it down with ${migrations.tool} to ${input.words}'s migrations. The tables and columns added since are dropped, with their data.`,
    });
  }
  offers.push(keepOffer);

  // 3. The choice: by default the snapshot outside prod (whose plan names no environment).
  const choice = await choose(
    run,
    offers,
    why,
    plan.environment?.name !== undefined && offers[0]?.choice === "snapshot" ? "snapshot" : "keep",
  );
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
  // The approval is also left on each extra server whose data the choice changes, before the app's
  // server's, so the deploy finds the app's only once every other is there.
  const changing = otherServers(plan, choice);
  /** The app's folder on an extra server: as read for the snapshot, or reached now. */
  const extra = (server: string) => async () => folders.get(server) ?? folderOf(run, server);
  const where =
    changing.length > 0 ? ` on the app's server and on ${listText(changing.map(serverWords))}` : "";
  const clear = () => removeApprovals([async () => folder, ...changing.map(extra)]);
  return {
    choice,
    binding,
    lines: [
      `Database: ${offer.text}`,
      ...(choice === "snapshot" ? leftOutLines(plan, abouts) : []),
      "The app's settings and secrets stay as they are now. The release command does not run.",
      `Typing ${name} approves it. OpsCrew then leaves a one-time approval in the app's folder${where}, valid for ${APPROVAL_SECONDS / 60} minutes, which the deploy uses once.`,
    ],
    confirmPhrase: name,
    flags: ` --database ${choice} --confirm ${name}`,
    record,
    outcome: databaseOutcome(record, plan, input.words),
    leave: async () => {
      const expiry = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
      const line = rollbackApprovalLine(hex, choice, expiry);
      try {
        for (const server of changing) await (await extra(server)())?.approval(line);
        await folder.approval(line);
      } catch (error) {
        // None of them may stay usable without the others.
        await clear().catch(() => undefined);
        throw error;
      }
      return new Date(expiry * 1000).toISOString();
    },
    clear,
  };
}

/**
 * The database step in the user's Portainer, with snapshots on ({@link databaseStep}): the target's
 * snapshot in the stack's snapshots volume, unless a required reviewer would hold the stopped app,
 * or keep; `shared` holds `databaseStep`'s keep, its refusal of other choices and keep's offer.
 */
async function portainerStep(
  run: RollbackRun,
  input: Parameters<typeof databaseStep>[1],
  shared: {
    keep: (binding?: DatabaseBinding) => DatabaseStep;
    keepOnly: (reason: () => string, warn: string) => void;
    keepOffer: DatabaseOffer;
  },
): Promise<DatabaseStep> {
  const { deps, plan, environment } = run;
  const { words } = input;
  const facts = input.portainer;
  if (facts === undefined) {
    throw new OpsCrewError("INTERNAL", "The rollback in Portainer was given no Portainer facts.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  // A Portainer target's versions are digests.
  const hex = hexOf(input.target) as string;
  let read: Awaited<ReturnType<typeof readPortainerSnapshot>>;
  if (facts.reviewed !== undefined) {
    read = { why: reviewerReason(run, facts.reviewed, hex, words) };
  } else {
    deps.reporter.step(`Reading ${environment}'s snapshot of ${words} in your Portainer`);
    read = await readPortainerSnapshot(run, hex, words);
  }
  if ("unreachable" in read) {
    const unreachable = read.why;
    shared.keepOnly(() => unreachable, unreachable);
    return shared.keep();
  }
  // A snapshot there is offered only with the stack's guard merged on the dispatch branch.
  if ("snapshot" in read && !facts.templateApplied) read = { why: templateReason(run) };
  const offers: DatabaseOffer[] = [];
  const why: Partial<Record<DatabaseChoice, string>> = {
    migrations: unreadReason(run, "migrations"),
  };
  if ("snapshot" in read) offers.push(snapshotOffer(read.snapshot.about.taken, words));
  else why.snapshot = read.why;
  offers.push(shared.keepOffer);
  // Keep by default: the restore stops the app before the run.
  const choice = await choose(run, offers, why, "keep");
  const snapshot = "snapshot" in read ? read.snapshot : undefined;
  const binding: DatabaseBinding = {
    choice,
    taken: snapshot?.about.taken ?? null,
    currentRecord: null,
    targetRecord: null,
  };
  if (choice !== "snapshot" || snapshot === undefined) return shared.keep(binding);
  const restore = portainerRestore(run, {
    hex,
    words,
    snapshot,
    images: facts.images,
    github: facts.github,
  });
  const record: DatabaseRecord = { choice, taken: snapshot.about.taken };
  const name = plan.app.name;
  return {
    choice,
    binding,
    lines: [
      `Database: ${(offers[0] as DatabaseOffer).text}`,
      ...leftOutLines(plan, new Map([[APP_SERVER, snapshot.about]])),
      "The app's settings and secrets stay as they are now. The release command does not run.",
      `Typing ${name} approves it. OpsCrew then stops the app in your Portainer, copies its data as it is now, restores the snapshot and starts the rollback's run, which starts ${words}: until the rollback ends, no other version starts on that data. If the run fails, OpsCrew puts the copy back and starts the version that runs now again.`,
    ],
    confirmPhrase: name,
    flags: ` --database snapshot --confirm ${name}`,
    record,
    outcome: databaseOutcome(record, plan, words),
    leave: async () => {
      await restore.leave();
      return undefined;
    },
    clear: async () => {},
    portainer: restore,
  };
}

/** The offer of the snapshot taken `taken` (ISO), when the target named `words` stopped running. */
function snapshotOffer(taken: string, words: string): DatabaseOffer {
  return {
    choice: "snapshot",
    text: `Restore the snapshot taken ${formatUtc(taken)}, when ${words} stopped running. Everything written since is lost.`,
  };
}

/**
 * The choice among `offers` (keep last), `why` saying why each other one is not offered:
 * `--database`, refused with its reason when not offered (`PHASE_PRECONDITION`, nothing changed);
 * else, with several offers, the terminal's `chooseDatabase`; else the default, `fallback`.
 */
async function choose(
  run: RollbackRun,
  offers: readonly DatabaseOffer[],
  why: Partial<Record<DatabaseChoice, string>>,
  fallback: DatabaseChoice,
): Promise<DatabaseChoice> {
  const { options } = run;
  if (options.database !== undefined) {
    const reason = why[options.database];
    if (reason !== undefined) throw notOffered(run, reason, offers);
    return options.database;
  }
  if (offers.length > 1 && options.chooseDatabase !== undefined) {
    return options.chooseDatabase({ offers: [...offers], default: fallback });
  }
  return fallback;
}

/**
 * Why the snapshot is not offered in the user's Portainer with a required reviewer (`reviewed`):
 * the restore runs before the dispatch, and the app would stay stopped until someone approved.
 */
function reviewerReason(run: RollbackRun, reviewed: string, hex: string, words: string): string {
  return `GitHub asks a required reviewer of the GitHub environment ${reviewed} before ${run.environment}'s rollback run deploys, and in your Portainer OpsCrew restores the snapshot before that run starts, so the app would stay stopped until someone approved it. Roll back with --database keep, then, once the rollback is done, run \`opscrew restore ${hex}${run.flags}\` to put the snapshot of ${words} back.`;
}

/**
 * Why the snapshot is not offered in the user's Portainer when the stack template on the dispatch
 * branch is not the committed one: its guard may not keep other versions off the restored data.
 */
function templateReason(run: RollbackRun): string {
  const path = portainerStackTemplatePath(run.plan);
  return `The stack template on the branch the rollback's run deploys from (${path}) is not the one committed here, so the stack may not keep other versions off the restored data. Merge the deploy-setup pull request \`opscrew provision${run.flags}\` opened (or run it, if none is open) first.`;
}

/** Why `choice` is not offered when the plan has neither snapshots nor its kind of change. */
function unreadReason(run: RollbackRun, choice: "snapshot" | "migrations"): string {
  const { plan, environment } = run;
  if (plan.target.provider === "portainer" && choice === "migrations") {
    return "A rollback in your Portainer runs no down migrations.";
  }
  if (choice === "migrations") {
    return `${environment}'s plan has no app.migrations, so OpsCrew knows no down migrations for its app. It sets them for Rails, Django, Alembic, Flask-Migrate, Knex, Sequelize, TypeORM and Laravel.`;
  }
  // On, as snapshotsOn reads deploy.snapshots, but with nothing to copy.
  if (plan.deploy.snapshots ?? plan.environment?.name !== undefined) {
    return `${environment} has nothing a snapshot before each release copies: no PostgreSQL, MySQL, MariaDB, MongoDB, Valkey, Redis or Dragonfly, no SQLite files, no kept folder, and no other service named in deploy.snapshotStop, so OpsCrew takes no snapshots there.`;
  }
  return `${environment} takes no snapshots before its releases: deploy.snapshots is off in its plan (prod takes them only with deploy.snapshots: true).`;
}
