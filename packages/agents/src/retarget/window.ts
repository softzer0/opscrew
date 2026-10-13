import type { RemoteExec } from "@opscrew/contracts";
import { type ErrorCode, isUserFacingError, OpsCrewError } from "@opscrew/core";
import type { Retarget } from "@opscrew/plan-schema";
import {
  copyDump,
  DUMP_PATH,
  databaseSize,
  dumpDatabase,
  removeDump,
  restoreDatabase,
  startService,
  stopService,
  waitAppHealthy,
} from "./server-ops";
import {
  auditMove,
  auditStep,
  type MoveBase,
  type MoveSession,
  moveOf,
  newServer,
  redactWith,
  remoteFor,
  saveMove,
  waitsOf,
} from "./session";
import {
  ABORT_COMMAND,
  approveCommand,
  downtimeMinutes,
  downtimeUntilDnsChange,
  MAINTENANCE_WINDOW_TITLE,
  manualSwitchDowntime,
  RUN_COMMAND,
  sizeText,
  untilSwitched,
} from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";

/** Steps in order; a step at or after `migrated` has the data on the new server. */
const STEPS: readonly Retarget["step"][] = [
  "started",
  "renamed",
  "created",
  "deployed",
  "migrated",
  "switched",
];

/** Position of `step` in the move (0 = started). */
export function stepIndex(step: Retarget["step"]): number {
  return STEPS.indexOf(step);
}

/** True when `step` comes before `other`. */
export function stepBefore(step: Retarget["step"], other: Retarget["step"]): boolean {
  return stepIndex(step) < stepIndex(other);
}

/** The old server's shell. */
export function oldRemote(session: MoveBase): RemoteExec {
  return remoteFor(
    session.deps,
    session.services,
    session.deployKey.privateKeyFile,
    session.servers.from.ipv4,
  );
}

/** The new server's shell; stops (`newServer`) when its address is unknown on this computer. */
export function newRemote(session: MoveBase): RemoteExec {
  return remoteFor(
    session.deps,
    session.services,
    session.deployKey.privateKeyFile,
    newServer(session).ipv4,
  );
}

function reason(error: unknown): string {
  return (isUserFacingError(error) ? error.message : "unexpected error").replace(/[.\s]+$/, "");
}

/** Removes the dump file from a server; a failure is only a warning (best effort on rollback). */
async function removeDumpQuietly(session: MoveBase, remote: RemoteExec): Promise<void> {
  try {
    await removeDump(remote, redactWith(session.deps));
  } catch {
    session.deps.reporter.warn(
      `OpsCrew could not delete the database dump on ${remote.host}. Delete it yourself: \`ssh deploy@${remote.host} rm -f ${DUMP_PATH}\`.`,
    );
  }
}

/**
 * Starts the app on the old server again when OpsCrew stopped it (`oldAppStoppedAt`) and clears
 * the mark. Stops with a plain error (the mark stays, so the next run tries again first) when the
 * app cannot be started: the app is offline then.
 *
 * Once the old app takes writes again, a database copy made before is stale. So when the copy is
 * done (`migrated`), the move first goes back to `deployed` (keeping the mark) and only then is the
 * app started: whatever happens next (a failed start, the user starting it by hand, the process
 * dying), the next run repeats the maintenance window before any switch.
 */
export async function restartOldApp(session: MoveBase, before = ""): Promise<void> {
  let move = moveOf(session);
  if (move.oldAppStoppedAt === undefined) return;
  const { deps } = session;
  const host = session.servers.from.ipv4;
  const stale = move.step === "migrated";
  if (stale) {
    await saveMove(session, { ...move, step: "deployed" });
    await auditMove(session, {
      kind: "phase",
      action: "retarget deployed",
      detail:
        "the old app is started again, so the database copy is out of date and is made again before the switch",
    });
    move = moveOf(session);
  }
  deps.reporter.step(`Starting the app on the old server (${host}) again`);
  try {
    await startService(oldRemote(session), "app", redactWith(deps));
  } catch (error) {
    await auditMove(session, {
      kind: "remote-exec",
      action: "start app",
      target: host,
      decision: "refused",
      detail: `starting the app on the old server failed: ${reason(error)}`,
    });
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${before}OpsCrew could not start the app on the old server (${host}) again: ${reason(error)}. Your app is offline until it runs again.`,
      {
        hint: `Start it yourself with \`ssh deploy@${host} 'cd /srv/app && docker compose up -d app'\`, then run \`${RUN_COMMAND}\` (or \`${ABORT_COMMAND}\`); OpsCrew checks it again first.`,
      },
    );
  }
  const { oldAppStoppedAt: _stopped, ...rest } = move;
  await saveMove(session, rest);
  await auditMove(session, {
    kind: "remote-exec",
    action: "start app",
    target: host,
    decision: "approved",
    detail: stale
      ? "the app on the old server runs again; the database copy is out of date and is made again before the switch"
      : "the app on the old server runs again",
  });
  deps.reporter.success(`The app on the old server (${host}) runs again.`);
  if (stale) {
    deps.reporter.info(
      `The database copy on the new server is out of date now; \`${RUN_COMMAND}\` copies it again (maintenance window) before switching.`,
    );
  }
}

/**
 * A run that finds the old app stopped by an interrupted maintenance window (`oldAppStoppedAt`
 * set, data not yet on the new server) starts it again first and deletes leftover dump files, so
 * users are served while the window is repeated from a fresh dump.
 */
export async function recoverInterruptedWindow(session: MoveBase): Promise<void> {
  const move = moveOf(session);
  if (move.oldAppStoppedAt === undefined || !stepBefore(move.step, "migrated")) return;
  session.deps.reporter.warn(
    "An earlier run stopped during the maintenance window, before the database copy completed. OpsCrew starts the app on the old server again first; the window is repeated with a fresh copy.",
  );
  await restartOldApp(session);
  await removeDumpQuietly(session, oldRemote(session));
  if (session.servers.next !== undefined) await removeDumpQuietly(session, newRemote(session));
}

/** The commands of the window, listed in its approval. */
function windowCommands(oldHost: string, newHost: string, port: number, path: string): string[] {
  return [
    `On the old server (${oldHost}), in /srv/app:`,
    "  docker compose stop app",
    `  docker compose exec -T db pg_dump -U app -Fc app > ${DUMP_PATH}`,
    "Between the servers, through this computer (OpenSSH):",
    `  scp -3 deploy@${oldHost}:${DUMP_PATH} deploy@${newHost}:${DUMP_PATH}`,
    `On the new server (${newHost}), in /srv/app:`,
    "  docker compose stop app",
    `  docker compose exec -T db pg_restore -U app -d app --clean --if-exists --no-owner --single-transaction < ${DUMP_PATH}`,
    `  rm -f ${DUMP_PATH} (on both servers)`,
    `  docker compose up -d app, then a health check of http://app:${port}${path}`,
    "If any of these fails, OpsCrew deletes the dump files and starts the app on the old server again.",
  ];
}

/** A run that stops on purpose (nothing is broken): what to do next. */
function stopped(session: MoveSession, next: string[]): RetargetResult {
  return { step: moveOf(session).step, done: false, next };
}

/**
 * The maintenance window (self-hosted Postgres only): database size and expected downtime →
 * `remote-exec` approval listing the commands (scripts need `allowDowntime`) → `oldAppStoppedAt`
 * → stop the old app → dump → copy server to server → stop the new app → restore → delete both
 * dumps → start the new app → health check → `migrated`. Any failure deletes the dumps, starts the
 * old app again, clears `oldAppStoppedAt` and stops with the cause (the step stays `deployed`).
 */
export async function maintenanceWindow(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime">,
  /** The approved switch plan that follows the window, named again when a script must re-run. */
  switchPlanHash?: string,
): Promise<"done" | RetargetResult> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const next = session.servers.next;
  if (next === undefined) return stopped(session, [`Run \`${RUN_COMMAND}\` again.`]);
  const old = oldRemote(session);
  const fresh = newRemote(session);
  const ops = redactWith(deps);

  deps.reporter.step("Measuring the database on the old server");
  const size = await databaseSize(old, ops);
  const minutes = downtimeMinutes(size);
  const downtime = `about ${minutes} minutes`;
  // Without managed DNS the old app stays stopped after the copy until the user's switch is live.
  const byHand = downtimeUntilDnsChange(plan);
  const warning = manualSwitchDowntime(plan);
  deps.reporter.info(
    byHand
      ? `The database is ${sizeText(size)}. Copying it takes ${downtime}; the app is offline from then ${untilSwitched(plan)}.`
      : `The database is ${sizeText(size)}. Copying it takes ${downtime}; the app is offline for that long.`,
  );
  if (!deps.interactive && options.allowDowntime !== true) {
    const command =
      switchPlanHash === undefined
        ? `${RUN_COMMAND} --allow-downtime`
        : approveCommand(RUN_COMMAND, switchPlanHash, ["--allow-downtime"]);
    return {
      ...stopped(session, [
        byHand
          ? `The next step stops ${plan.app.name} on the old server while its database is copied to the new server (${downtime}), and it stays stopped ${untilSwitched(plan)}.`
          : `The next step stops ${plan.app.name} on the old server for ${downtime} while its database is copied to the new server.`,
        ...warning,
        `Run \`${command}\` when that is acceptable, or \`${ABORT_COMMAND}\` to undo the move.`,
      ]),
      ...(switchPlanHash !== undefined ? { pendingPlanHash: switchPlanHash } : {}),
    };
  }
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `${MAINTENANCE_WINDOW_TITLE} stop ${plan.app.name} on the old server and copy its database (${sizeText(size)}) to the new server (${byHand ? `downtime: ${downtime} for the copy, plus ${plan.dns.domain !== undefined ? "your DNS change" : "your users' move to the new address"}` : `${downtime} of downtime`})`,
    details: [
      ...windowCommands(session.servers.from.ipv4, next.ipv4, plan.app.port, plan.app.healthPath),
      ...(byHand ? ["", ...warning] : []),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The maintenance window was not approved. Nothing was changed; the app on the old server keeps running.",
      {
        hint: `Run \`${RUN_COMMAND}\` again when the downtime is acceptable (\`--allow-downtime\` in scripts), or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }

  const at = deps.clock.now().toISOString();
  await saveMove(session, { ...move, oldAppStoppedAt: at });
  await auditMove(session, {
    kind: "remote-exec",
    action: "maintenance window",
    target: session.servers.from.ipv4,
    decision: "approved",
    detail: `maintenance window started: database of ${size} bytes, ${downtime}`,
  });
  const audited = async (action: string, host: string, run: () => Promise<void>) => {
    await run();
    await auditMove(session, { kind: "remote-exec", action, target: host, decision: "approved" });
  };
  let newAppStopped = false;
  try {
    deps.reporter.step(`Stopping ${plan.app.name} on the old server`);
    await audited("stop app", old.host, () => stopService(old, "app", ops));
    deps.reporter.step(`Copying the database (${sizeText(size)}) to the new server`);
    await audited("dump database", old.host, () => dumpDatabase(old, size, ops));
    await audited("copy database dump", `${old.host} -> ${fresh.host}`, () =>
      copyDump(session.services.runner ?? deps.runner, {
        ...ops,
        from: old.host,
        to: fresh.host,
        keyFile: session.deployKey.privateKeyFile,
        knownHostsFile: deps.paths.files.knownHosts,
        sizeBytes: size,
      }),
    );
    // The new app's database connections would block `pg_restore --clean`.
    newAppStopped = true;
    await audited("stop app", fresh.host, () => stopService(fresh, "app", ops));
    await audited("restore database", fresh.host, () => restoreDatabase(fresh, size, ops));
    await audited("remove database dump", old.host, () => removeDump(old, ops));
    await audited("remove database dump", fresh.host, () => removeDump(fresh, ops));
    deps.reporter.step("Starting the app on the new server");
    await audited("start app", fresh.host, () => startService(fresh, "app", ops));
    newAppStopped = false;
    await waitAppHealthy(fresh, plan.app.port, plan.app.healthPath, {
      ...ops,
      ...waitsOf(session.services),
    });
  } catch (error) {
    throw await rollBackWindow(session, error, { old, fresh, newAppStopped });
  }
  await saveMove(session, { ...moveOf(session), step: "migrated" });
  deps.reporter.success(
    "The database is on the new server and the app answers there. The app on the old server stays stopped.",
  );
  await auditStep(session, "migrated", "database copied to the new server; old app stays stopped");
  return "done";
}

/** Undoes a failed window and returns the error to throw (with the cause and the next step). */
async function rollBackWindow(
  session: MoveSession,
  cause: unknown,
  ctx: { old: RemoteExec; fresh: RemoteExec; newAppStopped: boolean },
): Promise<OpsCrewError> {
  const { deps } = session;
  await auditMove(session, {
    kind: "remote-exec",
    action: "maintenance window",
    target: ctx.old.host,
    decision: "refused",
    detail: `maintenance window failed: ${reason(cause)}`,
  });
  deps.reporter.warn(
    `The maintenance window failed: ${reason(cause)}. OpsCrew deletes the dump files and starts the app on the old server again.`,
  );
  await removeDumpQuietly(session, ctx.old);
  await removeDumpQuietly(session, ctx.fresh);
  if (ctx.newAppStopped) {
    await startService(ctx.fresh, "app", redactWith(deps)).catch(() => undefined);
  }
  try {
    await restartOldApp(session, `The maintenance window failed (${reason(cause)}), and `);
  } catch (error) {
    return asOpsCrewError(error);
  }
  return new OpsCrewError(
    codeOf(cause),
    `The maintenance window failed: ${reason(cause)}. The app on the old server runs again and nothing else changed.`,
    {
      hint: `${hintOf(cause)}Then run \`${RUN_COMMAND}\` again (it repeats the maintenance window), or \`${ABORT_COMMAND}\` to undo the move.`,
    },
  );
}

/** The error's code when it is OpsCrew's, else `COMMAND_FAILED`. */
export function codeOf(error: unknown): ErrorCode {
  return error instanceof OpsCrewError ? error.code : "COMMAND_FAILED";
}

/** The error's hint followed by a space, or nothing. */
export function hintOf(error: unknown): string {
  return isUserFacingError(error) && error.hint ? `${error.hint} ` : "";
}

/** `error` itself when it is an `OpsCrewError`, else a plain internal error. */
export function asOpsCrewError(error: unknown): OpsCrewError {
  if (error instanceof OpsCrewError) return error;
  return new OpsCrewError("INTERNAL", "OpsCrew stopped because of an unexpected error.", {
    hint: "This is a bug in OpsCrew; please report it.",
    cause: error,
  });
}
