/**
 * `opscrew snapshot` and `opscrew restore` for an app on a hosting account (027 plan 9, US6
 * scenario 3, ADR 0030 D5): one-time requests (`requests.ts`) the agent carries out under its lock,
 * between releases, so a snapshot never races a deploy. A snapshot stays on the account in the
 * app's `dumps/` folder, where the panel's File Manager downloads it: the database's dump
 * `<id>.sql.gz` when the app has a database, and `<id>.shared.tar.gz` when `shared/` holds more
 * than the settings files. A restore puts back the parts a snapshot holds, the settings files
 * staying as they are, after an approval like a destroy's (`allowDestroy`, the hostname typed);
 * the agent copies what is there first, and puts that copy back if the restore fails.
 */
import { canonicalJson, listText, OpsCrewError, realSleep, sha256Hex } from "@opscrew/core";
import { NOTHING_CHANGED } from "../promote/shared";
import { hasDeployment } from "../shared";
import type { RestoredSnapshot, RestoreSnapshotOptions } from "../snapshot/restore-checks";
import { NOTHING_TAKEN, type SnapshotRun } from "../snapshot/run";
import type { TakenSnapshot, TakeSnapshotOptions } from "../snapshot/types";
import { hostingFolder, hostingTarget } from "./provision-plans";
import { recordedObject } from "./record";
import { type RequestResult, sendRequest } from "./requests";
import {
  type HostingAccountServices,
  type HostingReach,
  reachHostingAccount,
  requireFiles,
} from "./status";

/** What the snapshot commands reach the account with, each replaceable in tests. */
export interface HostingSnapshotServices extends HostingAccountServices {
  /** How a wait for the agent's answer sleeps (default: real time). */
  sleep?: (ms: number) => Promise<void>;
}

/** A snapshot's id on the account: its files' name without `.sql.gz` or `.shared.tar.gz`. */
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A snapshot's id from one of its files' names. */
const idOf = (file: string) => file.replace(/\.sql\.gz$|\.shared\.tar\.gz$/, "");

/** Where the snapshots stay, and how to keep one elsewhere. */
function downloadNote(folder: string): string {
  return `Snapshots stay on the hosting account in ~/${folder}/dumps/: download one from the panel's File Manager to keep a copy elsewhere.`;
}

/**
 * The account with its files, after the refusals every snapshot command shares: before provision,
 * and an SFTP host, which runs no agent. `database` is the app's database's full name, if any.
 */
async function reachDumps(
  run: SnapshotRun,
  services: HostingSnapshotServices,
  nothing: string,
): Promise<HostingReach & { database?: string; files: NonNullable<HostingReach["files"]> }> {
  const { deps, plan, environment, flags } = run;
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The hosting account isn't set up for ${environment} yet. ${nothing}`,
      { hint: `\`opscrew provision${flags}\` sets it up.` },
    );
  }
  const target = hostingTarget(plan);
  if (target.panel === "sftp") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} is on an SFTP host, where no agent of OpsCrew's runs to take or restore snapshots. ${nothing}`,
      {
        hint: "Copy the app's shared files over SFTP, and back up the database where your host keeps it.",
      },
    );
  }
  const reach = await reachHostingAccount(deps, plan, services);
  const files = requireFiles(reach, "reach its snapshots");
  if (target.database === undefined) return { ...reach, files };
  // Its full name, the account's prefix included, as provision recorded it.
  const database = recordedObject(reach.record, "database")?.key ?? target.database.name;
  return { ...reach, files, database };
}

/**
 * The stop for an answer of the agent other than `done`: `what` it refused (`nothing` then says
 * what stayed as it was) or didn't finish (`after` then says where the data is).
 */
function agentFailure(
  run: SnapshotRun,
  answer: RequestResult,
  input: { what: string; nothing: string; after?: string },
): OpsCrewError {
  const refused = answer.result === "refused";
  const then = refused ? input.nothing : (input.after ?? "");
  return new OpsCrewError(
    "COMMAND_FAILED",
    run.deps.redactor.redact(
      `The agent on the hosting account ${refused ? "refused" : "didn't finish"} ${input.what}: ${answer.reason ?? "it gave no reason"}.${then === "" ? "" : ` ${then}`}`,
    ),
    { hint: `\`opscrew logs${run.flags}\` shows the agent's lines.` },
  );
}

/** A snapshot's parts in words: `the database acct_notes and the shared files`. */
function partsWords(database: string | undefined, shared: boolean): string {
  return listText([
    ...(database === undefined ? [] : [`the database ${database}`]),
    ...(shared ? ["the shared files"] : []),
  ]);
}

/**
 * `opscrew snapshot` on a hosting account (see the module's comment): a `snapshot` request, named
 * with the plan's hash (a snapshot changes nothing, so it asks no approval). `--skip` is refused:
 * the database and the shared files go together. The agent refuses an app with neither a database
 * nor shared files besides its settings.
 * @throws OpsCrewError `INVALID_INPUT` for `--skip`, `PHASE_PRECONDITION` before provision or on
 * an SFTP host, `COMMAND_FAILED` when the agent refuses or fails.
 */
export async function takeHostingSnapshot(
  run: SnapshotRun,
  options: Pick<TakeSnapshotOptions, "skip">,
  services: HostingSnapshotServices = {},
): Promise<TakenSnapshot> {
  const { deps, plan, environment, flags } = run;
  if ((options.skip ?? []).length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--skip leaves a service out of a server's snapshot; on a hosting account a snapshot is the database and the shared files, taken together. ${NOTHING_TAKEN}`,
      { hint: `Run \`opscrew snapshot${flags}\` without --skip.` },
    );
  }
  const { files, folder, database } = await reachDumps(run, services, NOTHING_TAKEN);
  deps.reporter.step("Asking the agent on the account for a snapshot");
  const answer = await sendRequest(
    files,
    folder,
    { kind: "snapshot" },
    {
      hash: sha256Hex(canonicalJson(plan)),
      now: deps.clock.now(),
      sleep: services.sleep ?? realSleep,
    },
  );
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "ask the agent for a snapshot",
    target: "hosting account",
    decision: "allow",
    detail: answer.result,
  });
  if (answer.result !== "done") {
    throw agentFailure(run, answer, { what: "the snapshot", nothing: NOTHING_TAKEN });
  }
  const named = answer.dump ?? answer.shared;
  if (named === undefined || !SNAPSHOT_ID.test(idOf(named))) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      "The agent took the snapshot but named no file of it.",
      {
        hint: `\`opscrew logs${flags}\` shows the agent's lines; the snapshot is in ~/${folder}/dumps/.`,
      },
    );
  }
  const id = idOf(named);
  const dumped = answer.dump === undefined ? undefined : database;
  const shared = answer.shared !== undefined;
  const filesOf = [answer.dump, answer.shared].filter((file) => file !== undefined);
  deps.reporter.success(
    `Took the snapshot ${id} of ${environment} on the hosting account: ${partsWords(dumped, shared)} (${filesOf.join(", ")}) in ~/${folder}/dumps/.`,
  );
  deps.reporter.info(downloadNote(folder));
  const engine = hostingTarget(plan).database?.engine ?? "mariadb";
  return {
    id,
    where: `on the hosting account (~/${folder}/dumps/)`,
    services: [
      ...(dumped === undefined ? [] : [{ name: dumped, kind: engine, state: "copied" as const }]),
      { name: "files", kind: "files", state: shared ? "copied" : "skipped" },
    ],
  };
}

/**
 * `opscrew restore <id>` on a hosting account (see the module's comment): `<id>` is a snapshot or
 * a release's dump the account keeps in `dumps/`, whose parts go back after the approval, bound
 * to the environment, the account's folder, the snapshot's parts and the plan's hash; then the
 * `restore` request. `--from offsite` and `--only` are refused: the snapshots stay on the account,
 * and a snapshot's parts go back together.
 * @throws OpsCrewError `INVALID_INPUT` for those or an id that can't be one,
 * `PHASE_PRECONDITION` for a snapshot the account doesn't keep or a dump with no database to go
 * back into, `APPROVAL_REFUSED`, and `COMMAND_FAILED` when the agent refuses or fails (the data
 * put back as it was).
 */
export async function restoreHostingSnapshot(
  run: SnapshotRun,
  id: string,
  options: RestoreSnapshotOptions,
  services: HostingSnapshotServices = {},
): Promise<RestoredSnapshot> {
  const { deps, plan, environment, flags } = run;
  if (options.from !== undefined || options.only !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      options.from !== undefined
        ? `A hosting account's snapshots stay on the account: there is no copy elsewhere to restore from. ${NOTHING_CHANGED}`
        : `--only puts back one service of a server's snapshot; on a hosting account a restore puts back the database and the shared files together. ${NOTHING_CHANGED}`,
      { hint: `Run \`opscrew restore ${id}${flags}\` without it.` },
    );
  }
  if (!SNAPSHOT_ID.test(id)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${id} is no snapshot's id on a hosting account: an id has letters, digits, _ and - only, like snapshot-20261112T120000Z. ${NOTHING_CHANGED}`,
      { hint: downloadNote(hostingFolder(plan)) },
    );
  }
  const { files, folder, database, hostname } = await reachDumps(run, services, NOTHING_CHANGED);
  const names = (await files.list(`${folder}/dumps`)) ?? [];
  const kept = [
    ...new Set(names.filter((name) => /\.sql\.gz$|\.shared\.tar\.gz$/.test(name)).map(idOf)),
  ].sort();
  if (!kept.includes(id)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The hosting account keeps no snapshot ${id} of ${environment}${kept.length === 0 ? "" : `; it keeps ${listText(kept)}`}. ${NOTHING_CHANGED}`,
      { hint: `\`opscrew snapshot${flags}\` takes one. ${downloadNote(folder)}` },
    );
  }
  const dumped = names.includes(`${id}.sql.gz`);
  const shared = names.includes(`${id}.shared.tar.gz`);
  if (dumped && database === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The snapshot ${id} holds a database dump, and ${environment} has no database on the hosting account to put it back into. ${NOTHING_CHANGED}`,
    );
  }
  const parts = partsWords(dumped ? database : undefined, shared);
  const hash = sha256Hex(
    canonicalJson({
      environment,
      folder,
      snapshot: id,
      dump: dumped,
      shared,
      planHash: sha256Hex(canonicalJson(plan)),
    }),
  );
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Restore the snapshot ${id} of ${environment} on the hosting account`,
    details: [
      `The snapshot ${id} in ~/${folder}/dumps/ (${[dumped ? `${id}.sql.gz` : "", shared ? `${id}.shared.tar.gz` : ""].filter(Boolean).join(" and ")}).`,
      `It puts back ${parts} as ${shared ? "they were" : "it was"} then; the settings files (.env, env.php, mysql.cnf) stay as they are now.`,
      `What is lost: everything written to ${parts} since.`,
      "The agent on the account first copies the database and the shared files as they are now into a new snapshot, and puts that copy back if the restore fails.",
      `Typing ${hostname} approves it.`,
      `Restore hash: ${hash}`,
    ].join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: hostname,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The snapshot ${id} was not restored${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`opscrew restore ${id}${flags}\` again and type ${hostname} (in a script: --confirm ${hostname} --approve ${hash}).`,
      },
    );
  }
  deps.reporter.step(`Asking the agent on the account to restore the snapshot ${id}`);
  const answer = await sendRequest(
    files,
    folder,
    { kind: "restore", snapshot: id },
    { hash, now: deps.clock.now(), sleep: services.sleep ?? realSleep },
  );
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `ask the agent to restore the snapshot ${id}`,
    target: hash,
    decision: answer.result === "done" ? "approved" : "refused",
    detail: answer.result,
  });
  const { saved } = answer;
  const before =
    saved === undefined ? "" : `The data as it was just before is the snapshot ${saved}.`;
  if (answer.result !== "done") {
    throw agentFailure(run, answer, {
      what: `the restore of the snapshot ${id}`,
      nothing: NOTHING_CHANGED,
      after: before,
    });
  }
  deps.reporter.success(
    `Restored the snapshot ${id} of ${environment} on the hosting account: ${parts} ${shared ? "are as they were" : "is as it was"} then, and the settings files as they are now. ${before}`.trimEnd(),
  );
  return {
    id,
    where: `on the hosting account (~/${folder}/dumps/)`,
    services: [
      ...(dumped && database !== undefined ? [{ name: database }] : []),
      ...(shared ? [{ name: "files" }] : []),
    ],
    saved: saved === undefined ? {} : { app: saved },
  };
}
