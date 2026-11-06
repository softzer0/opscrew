import { dataWarning, serverData } from "../../destroy/checks";
import {
  confirmDeletion,
  snapshotKeptNote,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "../../destroy/deletion";
import type { DestroyPreview } from "../../destroy/types";
import { providerProfile } from "../../providers";
import { describeChanges } from "../../shared";
import { moveProvider } from "../../shared/vps-target";
import { previousCloud, previousTarget } from "../layouts";
import {
  liftMoveProtection,
  type MoveServer,
  moveRemoval,
  previewMoveRemoval,
  removeMoveServer,
} from "../removal";
import { unknownOldServer } from "../servers";
import { type MoveSession, moveOf, serverOf, waitsOf } from "../session";
import { createStep } from "../steps";
import { providerWords } from "../texts";
import { sshSide } from "./ssh";
import type { MoveSide, SideStop } from "./types";

/** How a cloud side is made: `snapshot` is `--finish`'s choice for the old server. */
export interface CloudSideOptions {
  /** Snapshot the old server before it is deleted: `auto` (default) when data or backups were there. */
  snapshot?: "auto" | boolean;
}

/** The provider of the side's server: the plan's for the new side, the move's `from` for the old. */
function providerOf(session: Pick<MoveSession, "plan">, which: MoveServer) {
  return which === "new"
    ? moveProvider(session.plan.target)
    : previousCloud(moveOf(session)).provider;
}

/**
 * A side that is a server OpsCrew creates on a cloud provider (`which`: the old one or the new
 * one), reached over SSH as `deploy`:
 * - `prepare` creates the new server with the move's IaC plan (approved by its hash) and waits for
 *   it (today's step `created`);
 * - `deploy` waits for the app's health route and stops the edge until the switch;
 * - `remove` deletes the server with a plan bounded to its module, after the typed app name: the
 *   old one at `--finish` (after a snapshot when `options.snapshot` wants one), the new one at
 *   `--abort`.
 */
export function cloudSide(which: MoveServer, options: CloudSideOptions = {}): MoveSide {
  const ssh = sshSide({
    which,
    words: (session) => `the ${which} ${providerWords(providerOf(session, which)).noun}`,
    login: async (session) => ({
      host: serverOf(session, which).ipv4,
      port: 22,
    }),
  });
  return {
    kind: "cloud",
    ...ssh,
    prepare: createStep,
    remove: (session, confirm) =>
      which === "old" ? removeOld(session, confirm, options) : removeNew(session, confirm),
  };
}

/** The flags a scripted run repeats with each `--approve <hash>` of a removal. */
function removalFlags(app: string, snapshot: CloudSideOptions["snapshot"]): string[] {
  return [
    "--confirm",
    app,
    ...(snapshot === true ? ["--snapshot"] : snapshot === false ? ["--no-snapshot"] : []),
  ];
}

/**
 * `--finish`: the old server's removal. Previews it (only its module's resources), takes the typed
 * app name, a snapshot first when wanted, lifts Hetzner's delete protection with a plan that may
 * change nothing else, then deletes it with a plan bounded to the confirmed preview.
 */
async function removeOld(
  session: MoveSession,
  confirm: (preview: DestroyPreview) => Promise<boolean>,
  options: CloudSideOptions,
): Promise<SideStop> {
  const { deps, services } = session;
  const app = session.plan.app.name;
  const old = previousTarget(moveOf(session));
  const removal = moveRemoval(session, "old", old.provider, removalFlags(app, options.snapshot));
  const { del, words, texts } = removal;

  const preview = await previewMoveRemoval(removal);
  const { serverInState, serverIds } = preview;
  if (preview.changes.length === 0) {
    deps.reporter.info(`The old ${words.noun} is already deleted.`);
    return undefined;
  }
  // Its address names its host key and its record; without it OpsCrew stops before deleting.
  if (session.servers.from === undefined) throw unknownOldServer(session.command);
  const warning = dataWarning(session.plan, serverInState, old);
  const data = { serverData: serverData(session.plan).length > 0, backups: old.backups };
  const snapshotFirst = serverInState && snapshotWanted(options.snapshot, data);
  deps.reporter.info(
    [
      `Finishing the move deletes these resources of the old ${words.noun} on ${words.name}:`,
      ...describeChanges(preview.changes),
    ].join("\n"),
  );
  if (warning) deps.reporter.warn(warning);
  if (snapshotFirst) {
    deps.reporter.info(
      `A snapshot of the old ${words.noun} is taken first, so its data can be restored later (${texts.snapshotBilling}; \`--no-snapshot\` skips it).`,
    );
  }
  await confirmDeletion(
    del,
    {
      name: app,
      provider: old.provider,
      deleteProtection: providerProfile(old.provider).deleteProtection,
      resources: preview.changes,
      snapshot: snapshotFirst,
      ...(warning ? { dataWarning: warning } : {}),
    },
    confirm,
  );

  // After the typed name, before anything is deleted.
  const servers = services.servers?.[old.provider];
  const snapshotId = await takeSnapshotBeforeDelete(del, {
    server: { inState: serverInState, ids: serverIds },
    choice: options.snapshot ?? "auto",
    data,
    purpose: "retarget",
    ...(servers ? { servers } : {}),
    ...waitsOf(services),
  });
  const kept = snapshotKeptNote(texts, snapshotId);

  const lift = await liftMoveProtection(removal, { serverInState, kept });
  if ("stop" in lift) return lift.stop;
  const unprotected = lift.lifted
    ? ` Delete protection on the old ${words.noun} is already off; \`${session.command}\` deletes it once you confirm again.`
    : "";
  return removeMoveServer(removal, {
    preview,
    notes: [
      ...(warning ? [warning] : []),
      snapshotId !== undefined
        ? `Snapshot: ${texts.snapshotRef(snapshotId)} keeps a copy of the old ${words.noun} (${texts.snapshotBilled}; OpsCrew never deletes it).`
        : "Snapshot: none.",
    ],
    note: `${unprotected}${kept}`,
  });
}

/**
 * `--abort`: the new server's removal. Previews it (only its module's resources), takes the typed
 * app name, lifts Hetzner's delete protection with a plan that may change nothing else, then
 * deletes it with a plan bounded to the confirmed preview.
 */
async function removeNew(
  session: MoveSession,
  confirm: (preview: DestroyPreview) => Promise<boolean>,
): Promise<SideStop> {
  const { deps } = session;
  const app = session.plan.app.name;
  const provider = moveProvider(session.plan.target);
  const removal = moveRemoval(session, "new", provider, removalFlags(app, undefined));
  const { del, words } = removal;
  const preview = await previewMoveRemoval(removal);
  if (preview.changes.length === 0) {
    deps.reporter.info(`There is no new ${words.noun} to delete.`);
    return undefined;
  }
  deps.reporter.info(
    [
      `Aborting the move deletes these resources of the new ${words.noun} on ${words.name}:`,
      ...describeChanges(preview.changes),
    ].join("\n"),
  );
  await confirmDeletion(
    del,
    {
      name: app,
      provider,
      deleteProtection: providerProfile(provider).deleteProtection,
      resources: preview.changes,
      snapshot: false,
    },
    confirm,
  );
  const lift = await liftMoveProtection(removal, {
    serverInState: preview.serverInState,
    kept: "",
  });
  if ("stop" in lift) return lift.stop;
  return removeMoveServer(removal, {
    preview,
    notes: [
      `The app keeps running on the old server; the new ${words.noun} and what it holds are deleted.`,
    ],
    note: "",
    costDelta: {
      amount: -session.plan.cost.monthly.amount,
      currency: session.plan.cost.monthly.currency,
    },
  });
}
