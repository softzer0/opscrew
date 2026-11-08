/**
 * What `opscrew restore` decides before anything changes, the same on servers, this computer and
 * the user's Portainer (024 plan.md 6., FR-2404): which parts go back, the version check, the
 * stop-only services' images, and the destroy-grade approval bound to the snapshot's hash.
 */
import { canonicalJson, listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import { type SnapshotPart, serviceSpec } from "@opscrew/iac-templates";
import { APP_SERVER } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { NOTHING_CHANGED } from "../promote/shared";
import { APPROVAL_SECONDS } from "../rollback/database";
import { shortDigest } from "../rollback/versions";
import { type Relogin, reloginLines } from "./generations";
import type { RestoreServices } from "./restore-offsite";
import type { SnapshotRun } from "./run";
import { type About, KIND_WORDS } from "./store";

/** `opscrew restore`'s options. */
export interface RestoreSnapshotOptions {
  /** `--only <service>`: the one service put back; every one the snapshot holds by default. */
  only?: string;
  /**
   * `--allow-other-version`: restores the data alone of a snapshot taken while another version
   * ran, or one that records no version or no service's image.
   */
  allowOtherVersion?: boolean;
  /** `--from offsite`: the copy in the off-server bucket, downloaded and decrypted here. */
  from?: "offsite";
  /** The recovery copy's age key, or its key file's text, for `--from offsite`. */
  identity?: string;
  services?: RestoreServices;
}

/** A snapshot `opscrew restore` put back. */
export interface RestoredSnapshot {
  id: string;
  /** Where it was restored, in words. */
  where: string;
  /** The services put back, each with its server (absent on this computer and in Portainer). */
  services: { name: string; server?: string }[];
  /** The snapshot each machine took of its data just before, by server (`app` for one machine). */
  saved: Record<string, string>;
}

/** One machine's part of a snapshot to restore: its record, what runs there, what goes back. */
export interface Holder {
  /** `app`, or an extra server's name. */
  server: string;
  /** The machine in words: `the app's server`, `server data`, `your Portainer`. */
  name: string;
  about: About;
  /** `about.json`'s bytes, as read: the approval's hash covers them. */
  text: string;
  /** The image the service's container there runs now, by service. */
  images: ReadonlyMap<string, string>;
  /** Every part the plan has there. */
  planParts: readonly SnapshotPart[];
  /** The parts the restore puts back there. */
  parts: SnapshotPart[];
}

/**
 * A part in words: `db (PostgreSQL)`, `sqlite (the app's SQLite files)`, `files (the app's kept
 * folder)`.
 */
export function partWords(part: Pick<SnapshotPart, "name" | "kind">): string {
  const kind =
    part.kind === "sqlite"
      ? "the app's SQLite files"
      : part.kind === "files"
        ? "the app's kept folder"
        : serviceSpec(part.kind).title;
  return `${part.name} (${kind})`;
}

/**
 * The parts each holder puts back: those its record holds a copy of that the plan still has
 * there, only `only` with `--only`.
 * @throws OpsCrewError `INVALID_INPUT` for an `--only` of no service with data,
 * `PHASE_PRECONDITION` when the snapshot holds no copy of it, or of anything the plan has.
 */
export function chooseParts(
  run: SnapshotRun,
  id: string,
  holders: readonly Omit<Holder, "parts">[],
  only: string | undefined,
): Holder[] {
  const { environment, flags } = run;
  const chosen = holders
    .map((holder) => {
      const copied = new Set(
        holder.about.services.filter((entry) => "file" in entry).map((entry) => entry.name),
      );
      const parts = holder.planParts.filter(
        (part) => copied.has(part.name) && (only === undefined || part.name === only),
      );
      return { ...holder, parts };
    })
    .filter((holder) => holder.parts.length > 0);
  if (chosen.length > 0) return chosen;
  const names = holders.flatMap((holder) => holder.planParts.map((part) => part.name));
  if (only !== undefined && !names.includes(only)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${only} is no service with data in ${environment}. ${NOTHING_CHANGED}`,
      {
        hint: `Name one of ${listText(names)} with --only, then run \`opscrew restore ${id}${flags}\` again.`,
      },
    );
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The snapshot ${id} holds no copy of ${only ?? `any service ${environment} has now`}. ${NOTHING_CHANGED}`,
    { hint: `\`opscrew snapshot list${flags}\` shows what each snapshot holds.` },
  );
}

/**
 * Refuses, before any change, a snapshot of another version than `running` (the app's server's,
 * `sha256:<hex>`; empty when unknown), naming the rollback that restores it with its version, and
 * one that records no version; `--allow-other-version` restores the data alone.
 */
export function checkVersion(
  run: SnapshotRun,
  id: string,
  version: string,
  running: string,
  allow: boolean,
): void {
  if (allow || (version !== "" && version === running)) return;
  const { flags } = run;
  const alone = `to restore its data alone under the version that runs now, run \`opscrew restore ${id}${flags} --allow-other-version\``;
  if (version === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The snapshot ${id} records no version: no version was known when it was taken (before a first deploy, or with an older OpsCrew), so OpsCrew can't tell whether its data fits the version that runs now. ${NOTHING_CHANGED}`,
      { hint: `If you know it does, ${alone}.` },
    );
  }
  if (run.plan.target.provider === "localhost") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The snapshot ${id} was taken while another build ran on this computer (image ${shortDigest(version)}) than the one that runs now (${running === "" ? "unknown" : `image ${shortDigest(running)}`}). A local build gets a new image ID each time it is rebuilt, even from the same code, so its data may well fit. ${NOTHING_CHANGED}`,
      { hint: `If it does, ${alone}.` },
    );
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The snapshot ${id} was taken while another version ran (${shortDigest(version)}) than the one that runs now (${running === "" ? "unknown" : shortDigest(running)}), so its data may not fit it. ${NOTHING_CHANGED}`,
    {
      hint: `To go back to that version with its data, run \`opscrew rollback --to ${shortDigest(version)}${flags} --database snapshot\`; ${alone}.`,
    },
  );
}

/** An image reference's `sha256:` digest, or the reference itself without one. */
function digestOf(image: string): string {
  return /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] ?? image;
}

/**
 * Refuses, before any change, a stop-only service whose image now (its container's, or the plan's
 * pin without one) is not the one its copy was taken with, by their digests: its files may not open
 * in another version (Meilisearch's need the very same one). A copy that records no image is
 * refused unless `--allow-other-version`.
 */
export function checkImages(
  run: SnapshotRun,
  id: string,
  holders: readonly Holder[],
  allow: boolean,
): void {
  for (const holder of holders) {
    for (const part of holder.parts.filter((each) => !each.online)) {
      const entry = holder.about.services.find((each) => each.name === part.name);
      const then = entry !== undefined && "image" in entry ? entry.image : undefined;
      const now = holder.images.get(part.name) ?? part.image;
      if (then === undefined) {
        if (allow) continue;
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `The snapshot ${id} does not record the image ${partWords(part)} ran when it was copied, and its files may open only in that very version. ${NOTHING_CHANGED}`,
          {
            hint: `If ${part.name} still runs the same version (${now}), run \`opscrew restore ${id}${run.flags} --allow-other-version\`; or leave it out and restore the others one at a time with --only.`,
          },
        );
      }
      if (now !== undefined && digestOf(then) === digestOf(now)) continue;
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${partWords(part)} ran ${then} when the snapshot ${id} was copied, and runs ${now} now: its files may not open in another version (Meilisearch's need the very same one), so OpsCrew does not put them back. ${NOTHING_CHANGED}`,
        { hint: "Restore the other services one at a time with --only, or take a new snapshot." },
      );
    }
  }
}

/** The restore's facts that change nothing but the approval's words. */
export interface RestoreApproval {
  id: string;
  holders: readonly Holder[];
  /** Where it is restored, in words: `on the app's server and server data`. */
  where: string;
  options: RestoreSnapshotOptions;
  /** True on servers and this computer, where a one-time approval file guards the script. */
  approvalFile: boolean;
  /** The restored services rotated since their copy, given their current values once back. */
  relogins?: readonly Relogin[];
}

/**
 * The SHA-256 the restore's approval is bound to: the environment, the snapshot's id, the services
 * put back on each machine, each machine's `about.json` bytes, where the copy comes from, and each
 * restored service rotated since with the generations it goes from and to (no value).
 */
export function restoreHash(run: SnapshotRun, input: RestoreApproval): string {
  return sha256Hex(
    canonicalJson({
      environment: run.environment,
      id: input.id,
      from: input.options.from ?? "machines",
      allowOtherVersion: input.options.allowOtherVersion === true,
      parts: input.holders.map((holder) => ({
        server: holder.server,
        services: holder.parts.map((part) => part.name),
        about: holder.text,
      })),
      ...(input.relogins === undefined || input.relogins.length === 0
        ? {}
        : {
            relogins: input.relogins.map(({ server, service, from, to }) => ({
              server,
              service,
              from,
              to,
            })),
          }),
    }),
  );
}

/**
 * Asks the restore's destroy-grade approval (`allowDestroy`, the environment's app name typed:
 * `--confirm` with `--approve <hash>` in a script, never `--yes`), its text naming what is lost:
 * everything written since the snapshot.
 * @throws OpsCrewError `APPROVAL_REFUSED` when it is not given.
 */
export async function approveRestore(run: SnapshotRun, input: RestoreApproval): Promise<void> {
  const { deps, plan, environment, flags } = run;
  const { id, holders, where, options } = input;
  const about = holders[0]?.about as About;
  const parts = holders.flatMap((holder) =>
    holder.parts.map((part) =>
      holders.length > 1 ? `${partWords(part)} on ${holder.name}` : partWords(part),
    ),
  );
  const names = holders.flatMap((holder) => holder.parts.map((part) => part.name));
  const hash = restoreHash(run, input);
  const name = plan.app.name;
  const lines = [
    `The snapshot ${id} ${KIND_WORDS[about.kind]}, ${formatUtc(about.taken)}${options.from === "offsite" ? ", from its copy in the off-server bucket" : ""}.`,
    `It puts back exactly as they were then: ${listText(parts)}.`,
    `What is lost: everything written to ${listText(names)} since ${formatUtc(about.taken)}.`,
    ...(options.from === "offsite"
      ? [
          `This computer downloads the copy and decrypts it with your key, then sends it ${where}; the key never leaves this computer.`,
        ]
      : []),
    ...(options.allowOtherVersion === true
      ? ["Only the data goes back (--allow-other-version): the version that runs now stays."]
      : []),
    ...reloginLines(input.relogins ?? []),
    "While it runs, the app's requests wait and the app stops until its data is back. OpsCrew first copies the data as it is now, and puts that copy back if the restore fails.",
    ...(holders.length > 1
      ? [
          "If the restore fails on one machine, OpsCrew puts back what it restored on the others too, under this approval.",
        ]
      : []),
    input.approvalFile
      ? `Typing ${name} approves it. OpsCrew then leaves a one-time approval in the app's folder on each server that holds a part, valid for ${APPROVAL_SECONDS / 60} minutes, which the restore uses once.`
      : `Typing ${name} approves it.`,
    `Restore hash: ${hash}`,
  ];
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Restore the snapshot ${id} of ${environment} ${where}`,
    details: lines.join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: name,
  });
  if (approval.approved) return;
  const again = [
    `opscrew restore ${id}${flags}`,
    ...(options.only === undefined ? [] : [`--only ${options.only}`]),
    ...(options.allowOtherVersion === true ? ["--allow-other-version"] : []),
    ...(options.from === undefined ? [] : [`--from ${options.from}`]),
  ].join(" ");
  throw new OpsCrewError(
    "APPROVAL_REFUSED",
    `The snapshot ${id} was not restored${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
    {
      hint: `Run \`${again}\` again and type ${name} (in a script: --confirm ${name} --approve ${hash}).`,
    },
  );
}

/** The version a snapshot recorded: its part's on the app's server, else any part's. */
export function snapshotVersion(holders: readonly Pick<Holder, "server" | "about">[]): string {
  const app = holders.find((holder) => holder.server === APP_SERVER)?.about.version;
  return app !== undefined && app !== ""
    ? app
    : (holders.find((holder) => holder.about.version !== "")?.about.version ?? "");
}
