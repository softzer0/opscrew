/**
 * A live service's maintenance window (feature 018, FR-1809), once the deploy runs its new copy on
 * `move.to` next to the old one on `move.from`, which the app still uses. It reuses retarget's
 * server operations (ADR 0007's window), each on the server it concerns. The app's settings on its
 * server say where the app is: once they use the new copy, the move only goes forward.
 */
import type { ApprovalRecord } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { appDir, DEPLOY_SECRETS, deploySecretName, edgeProxy } from "@opscrew/iac-templates";
import type { DeployPlan, Move } from "@opscrew/plan-schema";
import { type CheckPauseTarget, changeCheckPause } from "../check/pause";
import type { PhaseDeps } from "../context";
import { failureReason } from "../destroy/deletion";
import { type GitHubSetup, setupGitHub } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import {
  copyDump,
  databaseSize,
  dumpDatabase,
  dumpPath,
  recreateDatabase,
  removeDump,
  restoreDatabase,
  type ServerOpOptions,
  serverOps,
  startService,
  stopService,
  verifyDump,
  waitAppHealthy,
} from "../retarget/server-ops";
import { downtimeMinutes, MAINTENANCE_WINDOW_TITLE, sizeText } from "../retarget/texts";
import { requireGitRepo, serverWords, writePlanIfChanged } from "../shared";
import { codeOf, hintOf } from "../shared/errors";
import { type SwitchedEnv, storeAppEnv, switchedEnv, writeAppEnv, writeMask } from "./app-env";
import { withDeploysPaused } from "./deploys";
import { type MoveShell, runningServices } from "./shells";

/** The command that continues a move. */
export const MOVE_COMMAND = "opscrew provision";
/** The command that deletes a moved service's old copy once the app runs on the new one. */
export const FINISH_COMMAND = "opscrew provision --finish-move";

/** What a run of a move works with. */
export interface MoveRun {
  deps: PhaseDeps;
  /** The plan with `move`. */
  plan: DeployPlan;
  move: Move;
  services: ProvisionServices;
  /** The app's server, and the servers the service leaves and goes to (deploy's shells). */
  app: MoveShell;
  from: MoveShell;
  to: MoveShell;
}

/** The plan with `move`, written to `opscrew/plan.yaml`. */
export async function saveMove(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  plan: DeployPlan,
  move: Move,
): Promise<DeployPlan> {
  const next = { ...plan, move };
  await writePlanIfChanged(deps, next);
  return next;
}

/** Audits a change the window made on the server `server`, or (`refused`) its failure. */
function audited(
  deps: Pick<PhaseDeps, "audit">,
  action: string,
  server: string,
  detail?: string,
  decision: "approved" | "refused" = "approved",
) {
  return deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action,
    phase: "provision",
    target: `server ${server}`,
    decision,
    ...(detail !== undefined ? { detail } : {}),
  });
}

/** What the window's steps share: the server operations' options and the repository. */
interface WindowSetup {
  ops: ServerOpOptions;
  github: GitHubSetup;
  /** Where the scheduled check is paused. */
  target: CheckPauseTarget;
}

async function windowSetup(run: MoveRun): Promise<WindowSetup> {
  const { deps, plan, move, services } = run;
  const github = await setupGitHub(deps, await requireGitRepo(deps), services);
  return {
    ops: { ...serverOps(plan, deps.redactor), database: move.service, command: MOVE_COMMAND },
    github,
    target: { api: github.api, owner: github.owner, repo: github.repo },
  };
}

/**
 * The window, from `deployed` to `switched`:
 * - before any change: the app's settings on its server read and their switch prepared (refused
 *   when they don't hold the database's address as OpsCrew writes it), the app started on the old
 *   copy when an earlier window stopped it before the switch, and for a copy the database's size
 *   (`move.sizeBytes`) and both servers' SSH port;
 * - a `remote-exec` approval listing every step (its title starts with the maintenance window's,
 *   so scripts approve it as retarget's), which also covers the pauses of the check and deploys;
 * - the app's deploys paused, and the window waits until none runs ({@link withDeploysPaused});
 *   the check paused; the app, its workers and cron stopped on the app's server;
 * - for `dump`: dumped on `from`, copied with `scp -3`, checked on both servers, the new database
 *   emptied and restored on `to`; for `empty`: nothing;
 * - once the app is seen still stopped: the app's settings with the new address on the app's
 *   server (with Grafana Alloy's masking file) and in `OPSCREW_APP_ENV`;
 * - the app, its workers and cron started, healthy, then `switched` (once the app's settings are
 *   seen on the new copy), the old copy stopped, and the check and the deploys resumed.
 *
 * Before the app starts on the new copy, any failure puts the app's settings back, starts the app
 * on the old copy and stops with the cause and the next step; the step stays `deployed`. Once it
 * has started there, the move only goes forward ({@link forwardFailure}), as does a window that
 * stopped after it switched the settings ({@link rollForward}).
 */
export async function moveWindow(run: MoveRun): Promise<DeployPlan> {
  const { deps, move, app, from, to } = run;
  let { plan } = run;
  const setup = await windowSetup(run);
  const { ops, github, target } = setup;
  const env = await switchedEnv(deps, app, plan, move);
  if (env.switched) return rollForward(run, setup, env);
  const changes = env.after !== env.before;
  if (!changes && move.copy === "dump") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's settings (app.env) on the app's server don't hold ${move.service}'s address as OpsCrew writes it, so OpsCrew can't point the app at its copy on ${serverWords(to.name)}. Nothing was changed.`,
      {
        hint: `Let the deploy of the files \`${MOVE_COMMAND}\` writes finish, so the app's server has the settings OpsCrew keeps in GitHub, then run \`${MOVE_COMMAND}\` again.`,
      },
    );
  }
  if (!(await runningServices(app, plan)).includes("app")) {
    deps.reporter.warn(
      "An earlier run stopped during the maintenance window, before the app's settings were switched. OpsCrew starts the app on the old copy again first; the window is repeated.",
    );
    await startService(app.remote, "app", ops);
    await audited(deps, "start app", app.name, "the app runs again on the old copy");
  }
  const copies = move.copy === "dump";
  let size = 0;
  if (copies) {
    requireOnePort(run);
    deps.reporter.step(`Measuring ${move.service}'s database on ${serverWords(from.name)}`);
    size = await databaseSize(from.remote, ops);
    plan = await saveMove(deps, plan, { ...move, sizeBytes: size });
  }
  const sized = { ...run, plan };
  const approval = await approveWindow(sized, ops, env, copies ? size : undefined);
  return withDeploysPaused(deps, github, plan, run.services, async () => {
    // The scheduled check opens no issue while the app is offline for the window.
    await changeCheckPause(deps, target, plan, "retarget", "provision", approval);
    // Each flag is set before its change: a change that fails half way is undone too.
    const done = { envWritten: false, secretSet: false, appStarted: false };
    try {
      deps.reporter.step(`Stopping ${plan.app.name} on the app's server`);
      await stopService(app.remote, "app", ops);
      await audited(deps, "stop app", app.name);
      if (copies) await copyDatabase(sized, ops, size);
      if (changes) {
        // Whatever started the app meanwhile wrote to the old copy after its dump.
        if ((await runningServices(app, plan)).includes("app")) {
          throw new OpsCrewError(
            "COMMAND_FAILED",
            `${plan.app.name} started again on the app's server during the window, so its writes since may be missing from the copy`,
            { hint: "Check what started it (a deploy, or someone on the server)." },
          );
        }
        done.envWritten = true;
        await writeAppEnv(app, plan, env.after, deps.redactor);
        await audited(deps, "switch the app's settings", app.name, `${move.service} on ${to.name}`);
        await writeMask(app, plan, deps.redactor);
        done.secretSet = true;
        await storeAppEnv(deps, github, plan, env.after);
      }
      await startOnNewCopy(sized, ops, done);
    } catch (error) {
      if (done.appStarted) throw await forwardFailure(sized, setup, approval, error);
      throw await rollBack(sized, error, { ...setup, env, approval, ...done });
    }
    return switched(sized, setup, approval, env);
  });
}

/**
 * A move recorded as `switched` whose app does not answer on the app's server, with its settings
 * there on the new copy (`env`): a window, or its roll forward, stopped before the app ran there.
 * It only goes forward.
 */
export async function finishSwitch(run: MoveRun, env: SwitchedEnv): Promise<DeployPlan> {
  return rollForward(run, await windowSetup(run), env);
}

/**
 * A window that stopped after it switched the app's settings to the new copy: the data is there,
 * and the app may have written to it since, so the move only goes forward. Under the window's
 * approval and with the deploys paused, the settings go to GitHub and the app starts against the
 * new copy. A failure stops with the error and leaves the settings and both copies as they are,
 * for the next provision to go on.
 */
async function rollForward(
  run: MoveRun,
  setup: WindowSetup,
  env: SwitchedEnv,
): Promise<DeployPlan> {
  const { deps, plan, move, app, to } = run;
  const { ops, github, target } = setup;
  deps.reporter.warn(
    `An earlier run stopped during the maintenance window after it switched the app's settings to ${move.service} on ${serverWords(to.name)}, where its data was copied. OpsCrew finishes the switch.`,
  );
  const approval = await approveWindow(run, ops, { ...env, switched: true }, undefined);
  return withDeploysPaused(deps, github, plan, run.services, async () => {
    await changeCheckPause(deps, target, plan, "retarget", "provision", approval);
    try {
      if (env.after !== env.before) await storeAppEnv(deps, github, plan, env.after);
      await writeMask(app, plan, deps.redactor);
      await startOnNewCopy(run, ops, { appStarted: false });
    } catch (error) {
      throw await forwardFailure(run, setup, approval, error);
    }
    return switched(run, setup, approval, env);
  });
}

/**
 * The error of a failure once the app's settings or the app itself are on the new copy: audited,
 * the check resumed, and the settings and both copies left as they are, for the next provision to
 * go forward ({@link finishSwitch}).
 */
async function forwardFailure(
  run: MoveRun,
  setup: WindowSetup,
  approval: ApprovalRecord,
  error: unknown,
): Promise<OpsCrewError> {
  const { deps, plan, move, app, to } = run;
  await audited(
    deps,
    "maintenance window",
    app.name,
    `the switch failed and goes forward: ${failureReason(error)}`,
    "refused",
  );
  await resumeCheck(deps, setup.target, plan, approval);
  return new OpsCrewError(
    codeOf(error),
    `The maintenance window failed: ${failureReason(error)}. The app's settings use ${move.service} on ${serverWords(to.name)}, where its data was copied, so OpsCrew does not go back to the old copy.`,
    { hint: `${hintOf(error)}Then run \`${MOVE_COMMAND}\` again: it finishes the switch.` },
  );
}

/**
 * Starts the app, its workers and cron on the app's server, and waits until it is healthy;
 * `done.appStarted` is set just before the start.
 */
async function startOnNewCopy(
  { deps, plan, move, app, to, services }: MoveRun,
  ops: ServerOpOptions,
  done: { appStarted: boolean },
) {
  deps.reporter.step(
    `Starting ${plan.app.name} against ${move.service} on ${serverWords(to.name)}`,
  );
  done.appStarted = true;
  await startService(app.remote, "app", ops);
  await audited(deps, "start app", app.name);
  await waitAppHealthy(app.remote, plan.app.port, plan.app.healthPath, {
    ...ops,
    edge: edgeProxy(plan),
    ...(services.sleep !== undefined ? { sleep: services.sleep } : {}),
    ...(services.now !== undefined ? { now: services.now } : {}),
  });
}

/**
 * Once the app answers on the new copy, and its settings on the app's server are seen there
 * (unless none names the service): records the switch, stops the old copy and resumes the check.
 * @throws OpsCrewError `COMMAND_FAILED` when the settings no longer use the new copy: the secret
 * gets the server's settings again, nothing is recorded and the old copy keeps running.
 */
async function switched(
  run: MoveRun,
  setup: WindowSetup,
  approval: ApprovalRecord,
  env: SwitchedEnv,
): Promise<DeployPlan> {
  const { deps, move, app, from, to } = run;
  const reread = env.after === env.before ? env : await switchedEnv(deps, app, run.plan, move);
  if (!reread.switched && reread.after !== reread.before) {
    // The secret follows the server, so a deploy writes what the app runs on now.
    let secret = "";
    try {
      await storeAppEnv(deps, setup.github, run.plan, reread.before);
    } catch (error) {
      secret = ` OpsCrew could not store them in the GitHub secret ${deploySecretName(run.plan, DEPLOY_SECRETS.appEnv)} either (${failureReason(error)}), so the secret and the server may disagree.`;
    }
    await resumeCheck(deps, setup.target, run.plan, approval);
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The app answers, but its settings (app.env) on the app's server no longer use ${move.service} on ${serverWords(to.name)}: something wrote them during the window. OpsCrew recorded nothing and keeps the old copy running.${secret}`,
      { hint: `Run \`${MOVE_COMMAND}\` again: it reads the settings and goes on from there.` },
    );
  }
  const plan = await saveMove(deps, run.plan, { ...(run.plan.move ?? move), step: "switched" });
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "move switched",
    phase: "provision",
    target: `server ${to.name}`,
    detail: `${move.service} runs on ${to.name}; its old copy stays on ${from.name}`,
  });
  await stopOldCopy(run);
  await resumeCheck(deps, setup.target, plan, approval);
  deps.reporter.success(
    `${move.service} runs on ${serverWords(to.name)} now, and the app answers there. Its old copy stays, stopped, on ${serverWords(from.name)}.`,
  );
  deps.reporter.info(
    `Run \`${MOVE_COMMAND}\` again: its pull request takes the old copy out of the deployment files. Then \`${FINISH_COMMAND}\` deletes the old copy's data on ${serverWords(from.name)}, after you type ${move.service}.`,
  );
  return plan;
}

/**
 * `scp -3` reaches both servers on one SSH port.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change, when their ports differ.
 */
function requireOnePort({ move, from, to }: MoveRun): void {
  if (from.port === to.port) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew copies ${move.service}'s database from ${serverWords(from.name)} to ${serverWords(to.name)} with \`scp -3\` through this computer, which reaches both servers on one SSH port, but theirs differ (${from.port} and ${to.port}). Nothing was changed.`,
    {
      hint: `Let SSH answer on the same port on both servers, then run \`${MOVE_COMMAND}\` again.`,
    },
  );
}

/**
 * The window's `remote-exec` approval, listing its steps (`size`: the database's, when it is
 * copied).
 * @throws OpsCrewError `APPROVAL_REFUSED` when it is refused.
 */
async function approveWindow(
  run: MoveRun,
  ops: ServerOpOptions,
  env: SwitchedEnv,
  size: number | undefined,
): Promise<ApprovalRecord> {
  const { deps, plan, move, from, to } = run;
  const db = move.service;
  const processes = ["app", ...(ops.processes ?? [])].join(" ");
  const secret = deploySecretName(plan, DEPLOY_SECRETS.appEnv);
  const downtime = `about ${downtimeMinutes(size ?? 0)} minutes of downtime`;
  const title = env.switched
    ? `${MAINTENANCE_WINDOW_TITLE} finish moving ${db} to ${serverWords(to.name)} and start ${plan.app.name} against it`
    : `${MAINTENANCE_WINDOW_TITLE} stop ${plan.app.name} and move ${db} from ${serverWords(from.name)} to ${serverWords(to.name)} (${size !== undefined ? `its database of ${sizeText(size)}, ` : ""}${downtime})`;
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title,
    details: [
      ...(plan.observability?.check?.enabled === true
        ? ["The scheduled check is paused for the window and resumed afterwards."]
        : []),
      `The app's deploys are paused for the window (the repository variable OPSCREW_DEPLOY_PAUSED; a deploy started meanwhile skips its deploy job), and the window waits until none runs.`,
      ...(env.switched
        ? [
            `An earlier run copied ${db} to ${serverWords(to.name)}, switched the app's settings to it (${ops.folder}/app.env on the app's server, and now the GitHub secret ${secret}) and stopped before the end. Nothing is copied again, and the app does not go back to the old copy.`,
          ]
        : [
            `On the app's server, in ${ops.folder}:`,
            `  docker compose stop ${processes}`,
            ...(size !== undefined
              ? copyCommands(run, ops)
              : [`${db} starts empty on ${serverWords(to.name)}: nothing is copied.`]),
            ...(env.after !== env.before
              ? [
                  `The app's settings get ${db}'s address on ${serverWords(to.name)}: ${ops.folder}/app.env on the app's server, and the GitHub secret ${secret}.`,
                ]
              : []),
          ]),
      ...(plan.observability?.grafanaCloud?.enabled === true
        ? [
            `Grafana Alloy's masking file (${ops.folder}/mask.re) is rewritten from the new app.env.`,
          ]
        : []),
      `On the app's server: docker compose up -d ${processes}, then a health check of http://app:${plan.app.port}${plan.app.healthPath}`,
      `On ${serverWords(from.name)}: docker compose stop ${db} (the old copy stays, stopped, until \`${FINISH_COMMAND}\` deletes it)`,
      env.switched
        ? "If the app does not start, OpsCrew stops with the error and keeps the settings: the app's data is on the new copy."
        : "If any of these fails before the app starts on the new copy, OpsCrew puts the app's settings back and starts the app on the old copy; once it has started there, OpsCrew only goes forward.",
    ].join("\n"),
  });
  if (approval.approved) return approval;
  throw new OpsCrewError(
    "APPROVAL_REFUSED",
    env.switched
      ? `The maintenance window was not approved. The app's settings already use ${db} on ${serverWords(to.name)}, where an earlier run copied it, so the app starts there only once you approve.`
      : `The maintenance window was not approved. Nothing was changed; the app keeps running on ${db} on ${serverWords(from.name)}.`,
    { hint: `Run \`${MOVE_COMMAND}\` again when the downtime is acceptable.` },
  );
}

/** The commands of the database's copy, as the window's approval lists them. */
function copyCommands({ move, from, to }: MoveRun, ops: ServerOpOptions): string[] {
  const db = move.service;
  const dump = dumpPath(ops.folder);
  return [
    `On ${serverWords(from.name)} (the old copy), in ${ops.folder}:`,
    `  docker compose exec -T ${db} pg_dump -U app -Fc app > ${dump}`,
    "Between the servers, through this computer (OpenSSH):",
    `  scp -3 deploy@${from.remote.host}:${dump} deploy@${to.remote.host}:${dump}`,
    `On both servers, before anything is dropped: docker compose exec -T ${db} pg_restore --list < ${dump} > /dev/null && sha256sum ${dump}`,
    "  (the copy must be readable and match the dump it was copied from)",
    `On ${serverWords(to.name)} (the new copy), in ${ops.folder}:`,
    `  docker compose exec -T ${db} psql -U app -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app OWNER app'`,
    `  docker compose exec -T ${db} pg_restore -U app -d app --no-owner --single-transaction < ${dump}`,
    `  rm -f ${dump} (on both servers)`,
  ];
}

/**
 * Copies the database from the old copy to the new one: dump on `from`, `scp -3`, the copy checked
 * against the dump before anything is dropped, the new database emptied and restored, both dumps
 * deleted.
 */
async function copyDatabase(run: MoveRun, ops: ServerOpOptions, size: number): Promise<void> {
  const { deps, move, from, to } = run;
  deps.reporter.step(
    `Copying ${move.service}'s database (${sizeText(size)}) from ${serverWords(from.name)} to ${serverWords(to.name)}`,
  );
  await dumpDatabase(from.remote, size, ops);
  await audited(deps, "dump database", from.name);
  const dumped = await verifyDump(from.remote, size, ops);
  await copyDump(deps.runner, {
    ...ops,
    from: from.remote.host,
    to: to.remote.host,
    keyFile: deps.paths.files.deployKey,
    knownHostsFile: deps.paths.files.knownHosts,
    sizeBytes: size,
    port: from.port,
  });
  await audited(deps, "copy database dump", to.name, `from server ${from.name}`);
  if ((await verifyDump(to.remote, size, ops)) !== dumped) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The database dump copied to ${serverWords(to.name)} differs from the one on ${serverWords(from.name)}.`,
      {
        hint: `Check the free disk space on both servers (\`df -h ${ops.folder}\`); \`${MOVE_COMMAND}\` makes and copies a new dump.`,
      },
    );
  }
  await recreateDatabase(to.remote, ops);
  await audited(deps, "empty database", to.name);
  await restoreDatabase(to.remote, size, ops);
  await audited(deps, "restore database", to.name);
  await removeDump(from.remote, ops);
  await removeDump(to.remote, ops);
}

/** What the window changed before it failed, and what undoing it needs. */
interface WindowDone extends WindowSetup {
  env: SwitchedEnv;
  approval: ApprovalRecord;
  envWritten: boolean;
  secretSet: boolean;
}

/**
 * Undoes a failed window and returns the error to throw, with the cause and the next step: the
 * dumps deleted, the GitHub secret put back first, then the app's settings on its server (with
 * Grafana Alloy's masking file), the app started on the old copy and the check resumed. When the
 * secret or the settings can't be put back, the settings stay on the new copy, where the next
 * provision goes on: until then the secret and the server may disagree.
 */
async function rollBack(run: MoveRun, cause: unknown, done: WindowDone): Promise<OpsCrewError> {
  const { deps, plan, move, app } = run;
  await audited(
    deps,
    "maintenance window",
    app.name,
    `the maintenance window failed: ${failureReason(cause)}`,
    "refused",
  );
  const old = `the old copy of ${move.service} on ${serverWords(move.from)}`;
  deps.reporter.warn(
    `The maintenance window failed: ${failureReason(cause)}. OpsCrew puts the app's settings back and starts the app on ${old}.`,
  );
  if (move.copy === "dump") {
    for (const shell of [run.from, run.to]) await removeDumpQuietly(deps, shell, done.ops);
  }
  const failed = async (what: string, error: unknown) => {
    await resumeCheck(deps, done.target, plan, done.approval);
    return new OpsCrewError(
      "COMMAND_FAILED",
      `The maintenance window failed (${failureReason(cause)}), and OpsCrew could not put ${what} back: ${failureReason(error)}. The app's settings on its server stay on ${move.service}'s copy on ${serverWords(move.to)}, and the app may be offline; until \`${MOVE_COMMAND}\` runs again, the GitHub secret ${deploySecretName(plan, DEPLOY_SECRETS.appEnv)} and the server may disagree.`,
      { hint: `Run \`${MOVE_COMMAND}\` again: it finishes the move on the new copy.` },
    );
  };
  if (done.secretSet) {
    try {
      await storeAppEnv(deps, done.github, plan, done.env.before);
    } catch (error) {
      return failed("the GitHub secret with the app's settings", error);
    }
  }
  if (done.envWritten) {
    try {
      await writeAppEnv(app, plan, done.env.before, deps.redactor);
    } catch (error) {
      return failed("the app's settings on its server", error);
    }
    try {
      await writeMask(app, plan, deps.redactor);
    } catch (error) {
      // The settings are back on the old copy, but the logs wouldn't mask them: the app stays
      // stopped until the next provision starts it and repeats the window.
      await resumeCheck(deps, done.target, plan, done.approval);
      return new OpsCrewError(
        "COMMAND_FAILED",
        `The maintenance window failed (${failureReason(cause)}). The app's settings are back on ${old}, but OpsCrew could not rewrite Grafana Alloy's masking file for them: ${failureReason(error)}. The app stays stopped until \`${MOVE_COMMAND}\` runs again.`,
        {
          hint: `Run \`${MOVE_COMMAND}\` again: it starts the app on the old copy and repeats the maintenance window.`,
        },
      );
    }
  }
  try {
    await startService(app.remote, "app", done.ops);
  } catch (error) {
    await resumeCheck(deps, done.target, plan, done.approval);
    return new OpsCrewError(
      "COMMAND_FAILED",
      `The maintenance window failed (${failureReason(cause)}), and OpsCrew could not start the app on ${old} again: ${failureReason(error)}. Your app may be offline.`,
      {
        hint: `Run \`${MOVE_COMMAND}\` again: it starts the app first. To start it yourself: \`ssh deploy@${app.remote.host} 'cd ${appDir(plan)} && docker compose up -d app'\`.`,
      },
    );
  }
  await audited(deps, "start app", app.name, "the app runs again on the old copy");
  await resumeCheck(deps, done.target, plan, done.approval);
  return new OpsCrewError(
    codeOf(cause),
    `The maintenance window failed: ${failureReason(cause)}. The app runs again on ${old}; the new copy on ${serverWords(move.to)} is not used.`,
    {
      hint: `${hintOf(cause)}Then run \`${MOVE_COMMAND}\` again: it repeats the maintenance window.`,
    },
  );
}

/** Deletes the dump on a server; a failure is only a warning. */
async function removeDumpQuietly(
  deps: Pick<PhaseDeps, "reporter">,
  shell: MoveShell,
  ops: ServerOpOptions,
): Promise<void> {
  try {
    await removeDump(shell.remote, ops);
  } catch {
    deps.reporter.warn(
      `OpsCrew could not delete the database dump ${dumpPath(ops.folder)} on ${serverWords(shell.name)}. Delete it yourself.`,
    );
  }
}

/** Stops the old copy once the app uses the new one; a failure is only a warning. */
async function stopOldCopy({ deps, plan, move, from }: MoveRun): Promise<void> {
  let reason: string;
  try {
    const result = await from.remote.run(
      `cd ${appDir(plan)} && docker compose stop ${move.service}`,
      { timeoutMs: 120_000 },
    );
    if (result.exitCode === 0) {
      await audited(deps, `stop ${move.service}`, from.name, "the old copy stays, stopped");
      return;
    }
    reason = `exit code ${result.exitCode}`;
  } catch (error) {
    reason = failureReason(error);
  }
  deps.reporter.warn(
    `OpsCrew could not stop the old copy of ${move.service} on ${serverWords(from.name)} (${reason}). The app no longer uses it; its container stays until \`${FINISH_COMMAND}\` deletes it.`,
  );
}

/** Resumes the scheduled check under the window's approval; a failure is only a warning. */
async function resumeCheck(
  deps: PhaseDeps,
  target: CheckPauseTarget,
  plan: DeployPlan,
  approval: ApprovalRecord,
): Promise<void> {
  try {
    await changeCheckPause(deps, target, plan, undefined, "provision", approval);
  } catch (error) {
    deps.reporter.warn(
      `OpsCrew could not resume the scheduled check (${failureReason(error)}); \`${MOVE_COMMAND}\` resumes it.`,
    );
  }
}
