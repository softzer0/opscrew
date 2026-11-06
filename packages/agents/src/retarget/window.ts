import { Readable } from "node:stream";
import { listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { portainerStackName } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  monitoringServerName,
  type Retarget,
  serviceOf,
  servicesOn,
} from "@opscrew/plan-schema";
import { changeCheckPause } from "../check/pause";
import { failureReason } from "../destroy/deletion";
import { pollUntil, readValidJson } from "../shared";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { codeOf, hintOf } from "../shared/errors";
import { assertDistinctServers } from "./servers";
import {
  auditMove,
  auditStep,
  type MoveBase,
  type MoveSession,
  moveOf,
  saveMove,
  waitsOf,
} from "./session";
import { moveSide, sideWords } from "./sides";
import {
  dumpPostgres,
  ensureDumpVolume,
  type MovePostgres,
  moveDumpVolume,
  removeDumpVolume,
  restorePostgres,
} from "./sides/postgres";
import type { MoveSide, SideDocker, SideSource } from "./sides/types";
import {
  ABORT_COMMAND,
  approveCommand,
  downtimeUntilDnsChange,
  MAINTENANCE_WINDOW_TITLE,
  manualSwitchDowntime,
  RUN_COMMAND,
  sizeText,
  untilSwitched,
  windowMinutes,
} from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";

/** Steps in order; a step at or after `migrated` has the data on the new side. */
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

const HEALTH_WAIT_MS = 5 * 60_000;

/** The stateful services on the app's server, which stop and start around the copy. */
function statefulServices(plan: DeployPlan): string[] {
  return servicesOn(plan, APP_SERVER).map((service) => service.name);
}

/**
 * True when the move copies data in its window: a service on the app's server, the app's own
 * SQLite file or monitoring on the app's server, any of them not started empty.
 */
export function copiesData(plan: DeployPlan): boolean {
  const empty = new Set(plan.retarget?.empty ?? []);
  return (
    statefulServices(plan).some((name) => !empty.has(name)) ||
    (plan.storage?.sqlite !== undefined && !empty.has("app")) ||
    (monitoringServerName(plan) === APP_SERVER && !empty.has("monitoring"))
  );
}

/** One mount the window copies, where it is on each side. */
interface MountCopy {
  owner: string;
  key: string;
  bytes: number;
  from: SideSource;
  to: SideSource;
}

/** What the window does: the mounts it copies, Postgres's dump, the services it stops. */
interface WindowPlan {
  copies: MountCopy[];
  /** The Postgres service whose database is dumped and restored, unless it starts empty. */
  postgres: string | undefined;
  /** The bytes copied, Postgres's data folder counting for its dump. */
  bytes: number;
  services: string[];
}

/** A mount in words: `db's data at /var/lib/postgresql/data`, `the app's files at /data`. */
function mountWords(mount: Pick<MountCopy, "owner" | "key">): string {
  return `${mount.owner === "app" ? "the app's" : `${mount.owner}'s`} data at ${mount.key}`;
}

/**
 * What the window copies: each data mount on the old side whose owner does not start empty,
 * paired with the new side's mount of the same owner and key (never by name). Postgres's own data
 * folder is not copied: its dump is. Stops before any change when the new side has no such mount.
 */
async function planWindow(session: MoveBase, old: MoveSide, fresh: MoveSide): Promise<WindowPlan> {
  const { plan } = session;
  const move = moveOf(session);
  const empty = new Set(move.empty);
  const db = serviceOf(plan, "postgres");
  const postgres =
    db !== undefined && (db.server ?? APP_SERVER) === APP_SERVER && !empty.has(db.name)
      ? db.name
      : undefined;
  const oldMounts = (await old.volumes(session)).filter((mount) => !empty.has(mount.owner));
  const newMounts = await fresh.volumes(session);
  const copies: MountCopy[] = [];
  const missing: string[] = [];
  let bytes = 0;
  for (const mount of oldMounts) {
    bytes += mount.bytes;
    if (mount.owner === postgres) continue;
    const to = newMounts.find((m) => m.owner === mount.owner && m.key === mount.key);
    if (to === undefined) {
      missing.push(mountWords(mount));
      continue;
    }
    copies.push({ ...mount, from: mount.source, to: to.source });
  }
  if (missing.length > 0) {
    const fresh = sideWords(plan.target, "new");
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${upperFirst(fresh)} has no place for ${listText(missing)}, so OpsCrew cannot copy it there. Nothing was changed; the app on ${sideWords(move.from.target, "old")} keeps running.`,
      {
        hint: `The app deployed there differs from the one on the old side. Run \`${RUN_COMMAND}\` again once the deploy there has finished, or start that data empty with \`--empty <service>\` (\`${ABORT_COMMAND}\` and start the move again).`,
      },
    );
  }
  return { copies, postgres, bytes, services: statefulServices(plan) };
}

/**
 * Postgres's login on one side: the app's `app` user, its generated password (registered with the
 * redactor) and the Compose project the one-off containers join (`opscrew-<app>` in Portainer,
 * `<app>` on a server).
 */
async function postgresOn(
  session: MoveBase,
  side: MoveSide,
  service: string,
): Promise<MovePostgres> {
  const { deps, plan } = session;
  const values = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
  const password = values?.dbPassword;
  if (password === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not have the database's password on this computer, so it cannot copy the database. Nothing was changed.",
      {
        hint: `Run \`${RUN_COMMAND}\` on the computer that provisioned the app (it keeps the password in OpsCrew's folder there).`,
      },
    );
  }
  deps.redactor.addLiteral(password, "app-env");
  const app = plan.app.name;
  return {
    app,
    project: side.kind === "portainer" ? portainerStackName(plan) : app,
    service,
    password,
  };
}

/** The approval's list of what the window does, on both sides (never an address). */
function windowCommands(session: MoveBase, window: WindowPlan, minutes: number): string[] {
  const { plan } = session;
  const move = moveOf(session);
  const old = sideWords(move.from.target, "old");
  const fresh = sideWords(plan.target, "new");
  const services = window.services.length > 0 ? listText(window.services) : undefined;
  const empty = move.empty;
  return [
    `About ${minutes} minutes for ${sizeText(window.bytes)} of data, copied through this computer.`,
    `On ${old}:`,
    "  stop the app, its workers and its cron",
    ...(window.postgres !== undefined
      ? [
          `  dump the PostgreSQL database (${window.postgres}) with pg_dump -Fc into the volume ${moveDumpVolume(plan.app.name)}, in a one-off postgres container`,
        ]
      : []),
    ...(services !== undefined ? [`  stop ${services} cleanly`] : []),
    `On ${fresh}:`,
    `  stop the app${services !== undefined ? ` and ${services}` : ""}`,
    "Copy, each through Docker's archive API, with a SHA-256 of it on both sides that must match:",
    ...window.copies.map((copy) => `  ${mountWords(copy)} (${sizeText(copy.bytes)})`),
    ...(window.postgres !== undefined ? ["  the database dump"] : []),
    `On ${fresh}:`,
    ...(services !== undefined ? [`  start ${services}`] : []),
    ...(window.postgres !== undefined
      ? [
          "  recreate the database empty and restore the dump into it (pg_restore --single-transaction)",
        ]
      : []),
    ...(plan.app.releaseCommand !== undefined
      ? [
          "  run the release command (app.releaseCommand), which migrates the copied data to the version deployed there",
        ]
      : []),
    ...(window.postgres !== undefined ? ["  remove the dump volume (on both sides)"] : []),
    "  start the app, then check its health route",
    ...(empty.length > 0 ? [`Starting empty there: ${listText(empty)}.`] : []),
    `If any of these fails, OpsCrew empties what it wrote on ${fresh}, removes the dump volumes and starts the services and the app on ${old} again.`,
  ];
}

/** A run that stops on purpose (nothing is broken): what to do next. */
function stopped(session: MoveSession, next: string[]): RetargetResult {
  return { step: moveOf(session).step, done: false, next };
}

/** An empty archive: writing it empties a mount. */
function emptyArchive(): Readable {
  return Readable.from([Buffer.alloc(1024)], { objectMode: false });
}

/**
 * Copies one mount: its digest on the old side, the read streamed into the write on the new side,
 * then its digest there, which must match.
 */
async function copyMount(
  session: MoveBase,
  docker: { old: SideDocker; fresh: SideDocker },
  copy: MountCopy,
): Promise<void> {
  const before = await docker.old.carrier.volumeDigest(copy.from);
  await docker.fresh.carrier.writeVolume(copy.to, await docker.old.carrier.readVolume(copy.from));
  const after = await docker.fresh.carrier.volumeDigest(copy.to);
  if (before !== after) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The copy of ${mountWords(copy)} on ${sideWords(session.plan.target, "new")} differs from the data on ${sideWords(moveOf(session).from.target, "old")}: their SHA-256 digests do not match.`,
      {
        hint: `Check the free disk space on the new side; \`${RUN_COMMAND}\` copies it again.`,
      },
    );
  }
}

/**
 * The maintenance window (plan.md "3."), when the move copies data: the data's sizes and the
 * window's minutes → one `remote-exec` approval listing both sides' steps (scripts need
 * `allowDowntime`) → the scheduled check paused → `oldAppStoppedAt` → the old app stops → Postgres
 * is dumped into the dump volume while it still runs → the old services stop → the new app and
 * services stop → each mount is copied with the carrier (digest, read, write, digest; the digests
 * must match), and the dump volume → the new services start → Postgres is recreated and restored
 * → the release command runs → the dump volumes go → the new app starts and answers → `migrated`.
 * Any failure empties the mounts written on the new side, removes the dump volumes, starts the
 * new side's services and app as they were, then the old side's services and app, and stops with
 * the cause: the step stays `deployed`. Nothing to copy: no window (`done` at once).
 */
export async function maintenanceWindow(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime">,
  /** The approved switch plan that follows the window, named again when a script must re-run. */
  switchPlanHash?: string,
): Promise<"done" | RetargetResult> {
  const { deps, plan } = session;
  // Before any command reaches a side: the window replaces the new side's data.
  assertDistinctServers(session.servers, session.command);
  const move = moveOf(session);
  const old = moveSide(session, "old");
  const fresh = moveSide(session, "new");
  const oldWords = sideWords(move.from.target, "old");
  const freshWords = sideWords(plan.target, "new");

  deps.reporter.step(`Measuring the app's data on ${oldWords}`);
  const window = await planWindow(session, old, fresh);
  if (window.copies.length === 0 && window.postgres === undefined) return "done";
  const minutes = windowMinutes(
    window.bytes,
    old.kind === "portainer" || fresh.kind === "portainer",
  );
  const downtime = `about ${minutes} minutes`;
  // Without managed DNS the old app stays stopped after the copy until the user's switch is live.
  const byHand = downtimeUntilDnsChange(plan, true);
  const warning = manualSwitchDowntime(plan, true);
  deps.reporter.info(
    byHand
      ? `The app's data is ${sizeText(window.bytes)}. Copying it takes ${downtime}; the app is offline from then ${untilSwitched(plan)}.`
      : `The app's data is ${sizeText(window.bytes)}. Copying it takes ${downtime}; the app is offline for that long.`,
  );
  if (!deps.interactive && options.allowDowntime !== true) {
    const command =
      switchPlanHash === undefined
        ? `${RUN_COMMAND} --allow-downtime`
        : approveCommand(RUN_COMMAND, switchPlanHash, ["--allow-downtime"]);
    return {
      ...stopped(session, [
        byHand
          ? `The next step stops ${plan.app.name} on ${oldWords} while its data is copied to ${freshWords} (${downtime}), and it stays stopped ${untilSwitched(plan)}.`
          : `The next step stops ${plan.app.name} on ${oldWords} for ${downtime} while its data is copied to ${freshWords}.`,
        ...warning,
        `Run \`${command}\` when that is acceptable, or \`${ABORT_COMMAND}\` to undo the move.`,
      ]),
      ...(switchPlanHash !== undefined ? { pendingPlanHash: switchPlanHash } : {}),
    };
  }
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `${MAINTENANCE_WINDOW_TITLE} stop ${plan.app.name} on ${oldWords} and copy its data (${sizeText(window.bytes)}) to ${freshWords} (${byHand ? `downtime: ${downtime} for the copy, plus ${plan.dns.domain !== undefined ? "your DNS change" : "your users' move to the new address"}` : `${downtime} of downtime`})`,
    details: [
      ...windowCommands(session, window, minutes),
      ...(byHand ? ["", ...warning] : []),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The maintenance window was not approved. Nothing was changed; the app on ${oldWords} keeps running.`,
      {
        hint: `Run \`${RUN_COMMAND}\` again when the downtime is acceptable (\`--allow-downtime\` in scripts), or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }

  // The scheduled check opens no issue while the app is offline for the window.
  if ((await changeCheckPause(deps, session.github, plan, "retarget", "retarget")) === "refused") {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The scheduled check was not paused, so it would open an issue while the app is offline for the copy. Nothing was changed; the app on ${oldWords} keeps running.`,
      {
        hint: `Run \`${RUN_COMMAND}\` again and approve the pause, or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }
  const docker = { old: await old.docker(session), fresh: await fresh.docker(session) };
  try {
    await runWindow(session, { old, fresh, docker, window, minutes });
  } finally {
    await docker.old.close();
    await docker.fresh.close();
  }
  await saveMove(session, { ...moveOf(session), step: "migrated" });
  deps.reporter.success(
    `The app's data is on ${freshWords} and the app answers there. The app on ${oldWords} stays stopped.`,
  );
  await auditStep(session, "migrated", `data copied to ${freshWords}; the old app stays stopped`);
  return "done";
}

/** The window's changes, from `oldAppStoppedAt` on; any failure rolls them back. */
async function runWindow(
  session: MoveSession,
  ctx: {
    old: MoveSide;
    fresh: MoveSide;
    docker: { old: SideDocker; fresh: SideDocker };
    window: WindowPlan;
    minutes: number;
  },
): Promise<void> {
  const { deps, plan } = session;
  const { old, fresh, docker, window } = ctx;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  await saveMove(session, { ...moveOf(session), oldAppStoppedAt: deps.clock.now().toISOString() });
  await auditMove(session, {
    kind: "remote-exec",
    action: "maintenance window",
    target: oldWords,
    decision: "approved",
    detail: `maintenance window started: ${window.bytes} bytes of data, about ${ctx.minutes} minutes`,
  });
  const audited = async (action: string, where: string, run: () => Promise<void>) => {
    await run();
    await auditMove(session, { kind: "remote-exec", action, target: where, decision: "approved" });
  };
  /** The new side's mounts that may hold part of a copy: emptied on a rollback. */
  const written: MountCopy[] = [];
  const app = plan.app.name;
  try {
    deps.reporter.step(`Stopping ${app} on ${oldWords}`);
    await audited("stop app", oldWords, () => old.stopApp(session));
    let dump: string | undefined;
    if (window.postgres !== undefined) {
      const db = window.postgres;
      deps.reporter.step(`Dumping the database (${db}) on ${oldWords}`);
      await ensureDumpVolume(docker.fresh.client, app);
      const login = await postgresOn(session, old, db);
      await audited("dump database", oldWords, async () => {
        dump = await dumpPostgres(docker.old, login);
      });
    }
    await audited("stop services", oldWords, async () => {
      await old.stopServices(session, window.services);
      await requireCleanStop(session, old, docker.old, window.services);
    });
    await audited("stop app", freshWords, () => fresh.stopApp(session));
    await audited("stop services", freshWords, () => fresh.stopServices(session, window.services));
    for (const copy of window.copies) {
      deps.reporter.step(`Copying ${mountWords(copy)} (${sizeText(copy.bytes)}) to ${freshWords}`);
      written.push(copy);
      await audited(`copy ${copy.owner} ${copy.key}`, freshWords, () =>
        copyMount(session, docker, copy),
      );
    }
    if (dump !== undefined) {
      const volume: SideSource = { kind: "volume", name: moveDumpVolume(app) };
      deps.reporter.step(`Copying the database dump to ${freshWords}`);
      await audited("copy database dump", freshWords, async () => {
        await docker.fresh.carrier.writeVolume(volume, await docker.old.carrier.readVolume(volume));
      });
    }
    await audited("start services", freshWords, () =>
      fresh.startServices(session, window.services),
    );
    if (window.postgres !== undefined && dump !== undefined) {
      const db = window.postgres;
      const login = await postgresOn(session, fresh, db);
      const sha = dump;
      deps.reporter.step(`Restoring the database (${db}) on ${freshWords}`);
      // The copy is checked against the old side's dump before the database is dropped.
      await audited("restore database", freshWords, () =>
        restorePostgres(docker.fresh, login, sha),
      );
    }
    if (plan.app.releaseCommand !== undefined) {
      deps.reporter.step(
        `Running the release command (app.releaseCommand) on the copied data, migrating it to the version on ${freshWords}`,
      );
    }
    await audited("run release command", freshWords, () => fresh.release(session, window.bytes));
    if (window.postgres !== undefined) {
      await audited("remove database dump", oldWords, () =>
        removeDumpVolume(docker.old.client, app),
      );
      await audited("remove database dump", freshWords, () =>
        removeDumpVolume(docker.fresh.client, app),
      );
    }
    deps.reporter.step(`Starting the app on ${freshWords}`);
    await audited("start app", freshWords, () => fresh.startApp(session));
    await waitHealthy(session, fresh);
  } catch (error) {
    throw await rollBackWindow(session, error, { old, fresh, docker, window, written });
  }
}

/** Docker's exit code of a container it killed: at the end of its stop timeout, or out of memory. */
const KILLED = 137;

/**
 * Stops unless each of the old side's stateful services `names` stopped cleanly (T2306): one still
 * running, or one Docker killed (exit 137: its stop timeout ran out, or it ran out of memory),
 * may have left its files half-written, so they are not copied.
 */
async function requireCleanStop(
  session: MoveBase,
  side: MoveSide,
  docker: SideDocker,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  const { plan } = session;
  const project = side.kind === "portainer" ? portainerStackName(plan) : plan.app.name;
  const unclean: string[] = [];
  for (const container of await docker.client.listContainers([
    `com.docker.compose.project=${project}`,
  ])) {
    const service = container.labels["com.docker.compose.service"] ?? "";
    if (!names.includes(service)) continue;
    if (container.state === "running") unclean.push(service);
    else if (
      container.state === "exited" &&
      (await docker.client.waitContainer(container.id)) === KILLED
    ) {
      unclean.push(service);
    }
  }
  if (unclean.length === 0) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `${listText(unclean)} did not stop cleanly on ${sideWords(moveOf(session).from.target, "old")} (Docker killed ${unclean.length === 1 ? "it" : "them"} when the 120 seconds to stop ran out, or for lack of memory), so OpsCrew does not copy ${unclean.length === 1 ? "its" : "their"} files.`,
    {
      hint: "Check the service's logs there and give it more memory if it ran out, then run the move again.",
    },
  );
}

/** Waits up to 5 minutes for the app to answer its health route on the new side. */
async function waitHealthy(session: MoveBase, fresh: MoveSide): Promise<void> {
  const healthy = await pollUntil(async () => ((await fresh.healthy(session)) ? true : undefined), {
    timeoutMs: HEALTH_WAIT_MS,
    intervalMs: 5000,
    ...waitsOf(session.services),
  });
  if (healthy) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `The app on ${sideWords(session.plan.target, "new")} did not answer on its health route (${session.plan.app.healthPath}) within 5 minutes.`,
    {
      hint: "Look at the app's logs there (as deploy: `docker compose logs --tail 200 app` in the app's folder; in Portainer: the app container's logs).",
    },
  );
}

/** Runs `act`; a failure is only a warning `what` (best effort while rolling back). */
async function quietly(session: MoveBase, what: string, act: () => Promise<void>): Promise<void> {
  try {
    await act();
  } catch (error) {
    session.deps.reporter.warn(
      session.deps.redactor.redact(`OpsCrew could not ${what}: ${failureReason(error)}.`),
    );
  }
}

/**
 * Undoes a failed window and returns the error to throw (with the cause and the next step): the
 * new side's mounts written so far are emptied, both dump volumes removed, the new side's services
 * and app started as the deploy left them, then the old side's services and app (SC-2302: the old
 * side's data was only read).
 */
async function rollBackWindow(
  session: MoveSession,
  cause: unknown,
  ctx: {
    old: MoveSide;
    fresh: MoveSide;
    docker: { old: SideDocker; fresh: SideDocker };
    window: WindowPlan;
    written: readonly MountCopy[];
  },
): Promise<OpsCrewError> {
  const { deps, plan } = session;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  const app = plan.app.name;
  await auditMove(session, {
    kind: "remote-exec",
    action: "maintenance window",
    target: oldWords,
    decision: "refused",
    detail: `maintenance window failed: ${failureReason(cause)}`,
  });
  deps.reporter.warn(
    `The maintenance window failed: ${failureReason(cause)}. OpsCrew empties what it wrote on ${freshWords} and starts the app on ${oldWords} again.`,
  );
  for (const copy of ctx.written) {
    await quietly(session, `empty ${mountWords(copy)} on ${freshWords}`, () =>
      ctx.docker.fresh.carrier.writeVolume(copy.to, emptyArchive()),
    );
  }
  await quietly(session, `remove the database dump on ${oldWords}`, () =>
    removeDumpVolume(ctx.docker.old.client, app),
  );
  await quietly(session, `remove the database dump on ${freshWords}`, () =>
    removeDumpVolume(ctx.docker.fresh.client, app),
  );
  await quietly(session, `start the services and the app on ${freshWords}`, async () => {
    await ctx.fresh.startServices(session, ctx.window.services);
    await ctx.fresh.startApp(session);
  });
  try {
    await restartOldApp(session, `The maintenance window failed (${failureReason(cause)}), and `);
  } catch (error) {
    return asOpsCrewError(error);
  }
  return new OpsCrewError(
    codeOf(cause),
    `The maintenance window failed: ${failureReason(cause)}. The app on ${oldWords} runs again with its data unchanged, and nothing else changed.`,
    {
      hint: `${hintOf(cause)}Then run \`${RUN_COMMAND}\` again (it repeats the maintenance window), or \`${ABORT_COMMAND}\` to undo the move.`,
    },
  );
}

/** What starting the old side again by hand means, without its address. */
function startByHand(session: MoveBase): string {
  const from = moveOf(session).from.target;
  const words = sideWords(from, "old");
  return from.provider === "portainer"
    ? `Start the app's stack (${portainerStackName(session.plan)}) in your Portainer`
    : `As deploy on ${words}, run \`docker compose up -d\` in the app's folder`;
}

/**
 * Starts the old side's services and its app again when OpsCrew stopped them (`oldAppStoppedAt`)
 * and clears the mark. Stops with a plain error (the mark stays, so the next run tries again first)
 * when they cannot be started: the app is offline then.
 *
 * Once the old app takes writes again, a copy made before is stale. So when the copy is done
 * (`migrated`), the move first goes back to `deployed` (keeping the mark) and only then is the app
 * started: whatever happens next (a failed start, the user starting it by hand, the process
 * dying), the next run repeats the maintenance window before any switch.
 */
export async function restartOldApp(session: MoveBase, before = ""): Promise<void> {
  let move = moveOf(session);
  if (move.oldAppStoppedAt === undefined) return;
  const { deps } = session;
  const words = sideWords(move.from.target, "old");
  const stale = move.step === "migrated";
  if (stale) {
    await saveMove(session, { ...move, step: "deployed" });
    await auditMove(session, {
      kind: "phase",
      action: "retarget deployed",
      detail:
        "the old app is started again, so the copy of its data is out of date and is made again before the switch",
    });
    move = moveOf(session);
  }
  deps.reporter.step(`Starting the app on ${words} again`);
  const old = moveSide(session, "old");
  try {
    await old.startServices(session, statefulServices(session.plan));
    await old.startApp(session);
  } catch (error) {
    await auditMove(session, {
      kind: "remote-exec",
      action: "start app",
      target: words,
      decision: "refused",
      detail: `starting the app on the old side failed: ${failureReason(error)}`,
    });
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${before}OpsCrew could not start the app on ${words} again: ${failureReason(error)}. Your app is offline until it runs again.`,
      {
        hint: `${startByHand(session)}, then run \`${RUN_COMMAND}\` (or \`${ABORT_COMMAND}\`); OpsCrew checks it again first.`,
      },
    );
  }
  const { oldAppStoppedAt: _stopped, ...rest } = move;
  await saveMove(session, rest);
  await auditMove(session, {
    kind: "remote-exec",
    action: "start app",
    target: words,
    decision: "approved",
    detail: stale
      ? "the app on the old side runs again; the copy of its data is out of date and is made again before the switch"
      : "the app on the old side runs again",
  });
  deps.reporter.success(`The app on ${words} runs again.`);
  if (stale) {
    deps.reporter.info(
      `The copy of the data on ${sideWords(session.plan.target, "new")} is out of date now; \`${RUN_COMMAND}\` copies it again (maintenance window) before switching.`,
    );
  }
}

/** Removes the dump volume on a side; a failure is only a warning (best effort). */
async function removeDumpQuietly(session: MoveBase, side: MoveSide, words: string): Promise<void> {
  await quietly(session, `remove the database dump on ${words}`, async () => {
    const docker = await side.docker(session);
    try {
      await removeDumpVolume(docker.client, session.plan.app.name);
    } finally {
      await docker.close();
    }
  });
}

/**
 * A run that finds the old app stopped by an interrupted maintenance window (`oldAppStoppedAt`
 * set, data not yet on the new side) starts the old side's services and app again first and
 * removes leftover dump volumes, so users are served while the window is repeated from a fresh
 * copy.
 */
export async function recoverInterruptedWindow(session: MoveBase): Promise<void> {
  const move = moveOf(session);
  if (move.oldAppStoppedAt === undefined || !stepBefore(move.step, "migrated")) return;
  session.deps.reporter.warn(
    "An earlier run stopped during the maintenance window, before the copy completed. OpsCrew starts the app on the old side again first; the window is repeated with a fresh copy.",
  );
  await restartOldApp(session);
  if (serviceOf(session.plan, "postgres") === undefined) return;
  await removeDumpQuietly(session, moveSide(session, "old"), sideWords(move.from.target, "old"));
  if (stepBefore(move.step, "deployed")) return;
  await removeDumpQuietly(session, moveSide(session, "new"), sideWords(session.plan.target, "new"));
}

/** `error` itself when it is an `OpsCrewError`, else a plain internal error. */
export function asOpsCrewError(error: unknown): OpsCrewError {
  if (error instanceof OpsCrewError) return error;
  return new OpsCrewError("INTERNAL", "OpsCrew stopped because of an unexpected error.", {
    hint: "This is a bug in OpsCrew; please report it.",
    cause: error,
  });
}
