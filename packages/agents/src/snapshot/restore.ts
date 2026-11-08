/**
 * `opscrew restore <id> [--only <service>] [--allow-other-version] [--from offsite]` (US3, US6,
 * FR-2404, FR-2407; 024 plan.md 6., D8, D13, D18): puts a data snapshot back where its data lives.
 * - **Before any change:** the snapshot's records (`about.json`) and what runs are read, the
 *   version and the stop-only services' images checked ({@link checkVersion}, {@link checkImages}),
 *   then the restore is approved like a destroy ({@link approveRestore}).
 * - **Servers and this computer:** each machine's `snapshot.sh restore`, after the one-time
 *   approval file the script requires; it copies the data as it is now and puts that copy back on
 *   failure. The app's server's `snapshot.sh hold` runs first and `snapshot.sh resume` after (D8):
 *   while held, no restore lets a request through or starts the app. A pre-release snapshot is
 *   restored by its digest the same way (D18: `restore <hex> --only <s>`). A service rotated since
 *   its copy gets its current values again once its machine's restore is done (025 plan.md 12.,
 *   {@link restoreRelogins}); when that fails, its data is put back like a failed restore's.
 * - **The user's Portainer:** through its Docker API ({@link restoreInPortainer}).
 * - **`--from offsite`:** the copy is downloaded and decrypted on this computer and streamed into
 *   the snapshots' folder first ({@link copyToServer}); the servers never hold the key.
 * Nothing it prints, audits or asks holds a password, a key, an address or data.
 */
import type { CommandResult } from "@opscrew/contracts";
import { errorMessage, listText, OpsCrewError } from "@opscrew/core";
import {
  RESTORE_APPROVAL_FILE,
  RESTORE_STUCK,
  restoreApprovalLine,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER, snapshotOffsiteOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { APPROVAL_SECONDS } from "../rollback/database";
import { type Relogin, reloginCommand, restoreRelogins } from "./generations";
import {
  dataHosts,
  hostFailure,
  READ_TIMEOUT_MS,
  type ScriptHost,
  scriptCommand,
  scriptSaid,
  serverHost,
} from "./hosts";
import {
  approveRestore,
  checkImages,
  checkVersion,
  chooseParts,
  type Holder,
  type RestoredSnapshot,
  type RestoreSnapshotOptions,
  snapshotVersion,
} from "./restore-checks";
import {
  type BucketAbout,
  bucketAbout,
  bucketServers,
  copyToServer,
  hideIdentity,
  type OffsiteBucket,
  offsiteBucket,
  type RestoreServices,
} from "./restore-offsite";
import { restoreInPortainer } from "./restore-portainer";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { aboutOf, requireSnapshotId, versionLine } from "./store";

/** How long one machine's restore may take: its copy first, then the restore. */
const RESTORE_TIMEOUT_MS = 6 * 60 * 60_000;

/** How long giving the restored services their current values may take: a service's recreation. */
const RELOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * The version that runs on a machine, as `snapshot.sh`'s `snapshot_version` records it:
 * `version <hex>` of `.env`'s digest, of `.running`'s on an extra server, or of a local build's
 * image ID on this computer.
 */
const VERSION_COMMAND = [
  "if [ -f .env ]; then",
  `  v="$(sed -n 's/^APP_IMAGE=//p' .env)"`,
  '  case "$v" in',
  `    *@sha256:*) printf '%s\\n' "$v" | sed -n 's/^.*@sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' ;;`,
  `    ?*) docker image inspect --format '{{.Id}}' "$v" 2> /dev/null | sed -n 's/^sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' ;;`,
  "  esac",
  "elif [ -f .running ]; then",
  `  sed -n 's/^[^=]*@sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' .running`,
  "fi",
].join("\n");

/** What one machine says before the approval, read-only. */
interface Probe {
  /** The snapshot's record there, with its bytes. */
  record?: BucketAbout;
  /** The running version (`sha256:<hex>`), or empty. */
  version: string;
  /** The image each of its services' containers runs, by service. */
  images: Map<string, string>;
}

/**
 * Reads, in one command on `host` and changing nothing: the snapshot `id`'s `about.json` through
 * `snapshot.sh list` (with `list`, a machine with parts), the version that runs, and the image of
 * each of `services`' containers.
 */
async function probe(
  run: SnapshotRun,
  host: ScriptHost,
  id: string,
  services: readonly string[],
  list: boolean,
): Promise<Probe> {
  const lines = [
    ...(list ? [`${scriptCommand(["list"])} || exit $?`] : []),
    VERSION_COMMAND,
    ...(services.length === 0
      ? []
      : [
          `for s in ${services.join(" ")}; do c="$(docker compose ps -q "$s" 2> /dev/null | head -n 1)"; if [ -n "$c" ]; then echo "image $s $(docker inspect --format '{{.Config.Image}}' "$c")"; fi; done`,
        ]),
    "exit 0",
  ];
  const result = await host.run(lines.join("\n"), READ_TIMEOUT_MS);
  if (result.exitCode !== 0) throw hostFailure(run, host, result, "read its snapshots");
  const images = new Map(
    [...result.stdout.matchAll(/^image ([a-z0-9-]+) (\S+)$/gm)].map(
      (match) => [match[1] ?? "", match[2] ?? ""] as const,
    ),
  );
  return {
    ...recordOf(result.stdout, id),
    version: versionLine(result.stdout),
    images,
  };
}

/** The record of `id` among the `about.json` lines `stdout` holds. */
function recordOf(stdout: string, id: string): { record?: BucketAbout } {
  for (const raw of stdout.split(/\r?\n/)) {
    const text = raw.trim();
    const about = text.startsWith("{") ? aboutOf(text) : undefined;
    if (about?.id === id) return { record: { about, text } };
  }
  return {};
}

/** The stop when `--from offsite` can't be used: no off-server copy, or no key given. */
function requireOffsite(run: SnapshotRun, id: string, options: RestoreSnapshotOptions): void {
  const { environment, flags } = run;
  if (snapshotOffsiteOf(run.plan) === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no off-server copy (snapshots.offsite in its plan), so there is no copy to restore from. ${NOTHING_CHANGED}`,
      { hint: `Restore a snapshot on its machines: \`opscrew restore ${id}${flags}\`.` },
    );
  }
  if (options.identity === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The copies in the off-server bucket are encrypted to the recovery copy's age key, and none was given, so OpsCrew can't read the copy ${id}. ${NOTHING_CHANGED}`,
      { hint: "Give the file with your age key (the one `--key-out` wrote), then try again." },
    );
  }
}

/** The one-time approval of the restore, written in the app's folder as the deploy user's. */
function approvalCommand(line: string): string {
  const file = RESTORE_APPROVAL_FILE;
  return `umask 077 && printf '%s\\n' ${shellQuote(line)} > ${file} && chmod 600 ${file}`;
}

/**
 * The restore on the app's servers or this computer (plan.md 6., D8): the records read on each
 * machine with data, checked and approved; with `--from offsite`, the bucket's record of each part
 * a machine lacks, its copy put in place once approved (a machine that holds the complete snapshot
 * already keeps its own); then each machine's restore ({@link restoreEach}).
 */
async function restoreOnHosts(
  run: SnapshotRun,
  services: RestoreServices,
  id: string,
  options: RestoreSnapshotOptions,
  local: boolean,
): Promise<RestoredSnapshot> {
  const { deps, plan, environment, flags } = run;
  const hosts = await dataHosts(run);
  const servers = [...hosts.keys()];
  const app = hosts.get(APP_SERVER) ?? (await serverHost(run, APP_SERVER));
  const partsOf = (server: string): SnapshotPart[] =>
    local ? snapshotParts(plan) : snapshotParts(plan, server);
  // 1. What each machine holds and runs, read-only.
  const probes = new Map<string, Probe>();
  for (const server of servers) {
    const named = partsOf(server).filter((part) => part.image !== undefined);
    const host = hosts.get(server) as ScriptHost;
    probes.set(
      server,
      await probe(
        run,
        host,
        id,
        named.map((part) => part.name),
        true,
      ),
    );
  }
  const running = (probes.get(APP_SERVER) ?? (await probe(run, app, id, [], false))).version;
  // 2. The records: on the machines, and in the bucket for the parts they lack.
  const records = new Map<string, BucketAbout>();
  for (const [server, read] of probes)
    if (read.record !== undefined) records.set(server, read.record);
  let bucket: OffsiteBucket | undefined;
  const copies = new Set<string>();
  if (options.from === "offsite") {
    bucket = await offsiteBucket(run, services, `opscrew restore ${id}${flags} --from offsite`);
    for (const server of await bucketServers(run, bucket as OffsiteBucket, id)) {
      // A folder without about.json there is an incomplete copy: the bucket's replaces it.
      if (!servers.includes(server) || records.has(server)) continue;
      const identity = options.identity as string;
      records.set(server, await bucketAbout(run, bucket as OffsiteBucket, identity, id, server));
      copies.add(server);
    }
  }
  if (records.size === 0) {
    const offsite = snapshotOffsiteOf(plan) !== undefined && options.from === undefined;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no snapshot ${id}${options.from === "offsite" ? ", on its machines or in its off-server bucket" : ""}. ${NOTHING_CHANGED}`,
      {
        hint: `\`opscrew snapshot list${flags}\` shows its snapshots${offsite ? `; one only in the off-server bucket is restored with \`opscrew restore ${id}${flags} --from offsite\`` : ""}.`,
      },
    );
  }
  const found = [...records].map(([server, record]) => ({
    server,
    name: (hosts.get(server) as ScriptHost).name,
    about: record.about,
    text: record.text,
    images: probes.get(server)?.images ?? new Map<string, string>(),
    planParts: partsOf(server),
  }));
  // 3. What goes back, the checks, the approval.
  const holders = chooseParts(run, id, found, options.only);
  const allow = options.allowOtherVersion === true;
  checkVersion(run, id, snapshotVersion(holders), running, allow);
  checkImages(run, id, holders, allow);
  const relogins = await restoreRelogins(run, id, holders);
  const where = `on ${listText(holders.map((holder) => holder.name))}`;
  await approveRestore(run, { id, holders, where, options, approvalFile: true, relogins });
  // 4. The copies from the bucket, then the restores.
  for (const holder of holders.filter((each) => copies.has(each.server))) {
    const host = hosts.get(holder.server) as ScriptHost;
    deps.reporter.step(`Copying the snapshot ${id} from the off-server bucket to ${host.name}`);
    await copyToServer(run, services, bucket as OffsiteBucket, options.identity as string, host, {
      id,
      server: holder.server,
      record: records.get(holder.server) as BucketAbout,
    });
  }
  const saved = await restoreEach(run, id, options, holders, hosts, app, relogins);
  const restored = holders.flatMap((holder) =>
    holder.parts.map((part) => ({
      name: part.name,
      ...(local ? {} : { server: holder.server }),
    })),
  );
  const before = Object.values(saved);
  deps.reporter.success(
    `Restored the snapshot ${id} of ${environment} ${where}.${before.length === 0 ? "" : ` The data from just before is the snapshot ${listText([...new Set(before)])}: \`opscrew restore\` puts it back.`}`,
  );
  return { id, where, services: restored, saved };
}

/** How one machine's `snapshot.sh restore` ended. */
interface Outcome {
  /** Restored; or its data as it was before (`back`); or maybe partly changed (`stuck`). */
  state: "restored" | "back" | "stuck";
  /** The copy it took just before, once it took one (`saved <id>`). */
  saved?: string;
  error?: OpsCrewError;
}

/**
 * `snapshot.sh restore <id> [--only s]` on `host` after its one-time approval, audited (`action`;
 * an audit log that can't be written only warns). A restore that did not end well, or did not end
 * at all, has its approval file removed, should it not have been read. A machine that did not
 * answer may have changed anything: `stuck`, as a failed put-back ({@link RESTORE_STUCK}).
 */
async function restoreOn(
  run: SnapshotRun,
  host: ScriptHost,
  input: {
    id: string;
    only?: string;
    parts: readonly string[];
    action: string;
    /** The services it starts without waiting for their health checks (their re-login's). */
    noWait?: readonly string[];
  },
): Promise<Outcome> {
  const { deps } = run;
  const { id, only } = input;
  const expiry = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
  const args = [
    "restore",
    id,
    ...(only === undefined ? [] : ["--only", only]),
    ...(input.noWait ?? []).flatMap((service) => ["--no-wait", service]),
  ];
  let written: CommandResult | undefined;
  let result: CommandResult | undefined;
  try {
    written = await host.run(
      approvalCommand(restoreApprovalLine(id, only, expiry)),
      READ_TIMEOUT_MS,
    );
    result =
      written.exitCode === 0 ? await host.run(scriptCommand(args), RESTORE_TIMEOUT_MS) : written;
  } finally {
    if (result?.exitCode !== 0) {
      await host.run(`rm -f ${RESTORE_APPROVAL_FILE}`, READ_TIMEOUT_MS).catch(() => undefined);
    }
  }
  const unanswered = result.exitCode === 255 || result.timedOut === true;
  const state =
    result.exitCode === 0
      ? "restored"
      : result.exitCode === RESTORE_STUCK || (unanswered && written.exitCode === 0)
        ? "stuck"
        : "back";
  await deps.audit
    .append({
      kind: "remote-exec",
      actor: "opscrew",
      action: input.action,
      target: host.audit,
      decision: "approved",
      detail: `${id}: ${input.parts.join(", ")}: ${state}`,
    })
    .catch((error: unknown) => {
      deps.reporter.warn(
        `OpsCrew could not write "${input.action}" ${host.where} in its audit log: ${deps.redactor.redact(errorMessage(error))}`,
      );
    });
  const saved = /^saved ([0-9A-Za-z]+)$/m.exec(result.stdout)?.[1];
  return {
    state,
    ...(saved === undefined ? {} : { saved }),
    ...(result.exitCode === 0
      ? {}
      : {
          error: hostFailure(
            run,
            host,
            result,
            written.exitCode === 0
              ? `restore the snapshot ${id}`
              : "leave the restore's one-time approval",
          ),
        }),
  };
}

/**
 * Gives the services of `relogins` restored on `host` their current values
 * ({@link reloginCommand}, the values on stdin), audited; returns the error when it failed. Nothing
 * runs without one.
 */
async function reloginOn(
  run: SnapshotRun,
  host: ScriptHost,
  id: string,
  relogins: readonly Relogin[],
): Promise<OpsCrewError | undefined> {
  if (relogins.length === 0) return undefined;
  const { deps } = run;
  const names = listText(relogins.map((relogin) => relogin.service));
  const their = relogins.length === 1 ? "its" : "their";
  deps.reporter.step(`Giving ${names} ${their} current passwords again ${host.where}`);
  const { command, input } = reloginCommand(relogins);
  const result = await host
    .run(command, RELOGIN_TIMEOUT_MS, input)
    .catch(
      (error: unknown): CommandResult => ({ exitCode: 255, stdout: "", stderr: String(error) }),
    );
  await deps.audit
    .append({
      kind: "remote-exec",
      actor: "opscrew",
      action: "set the current passwords of restored services",
      target: host.audit,
      decision: "approved",
      detail: `${id}: ${relogins.map((relogin) => `${relogin.service} from generation ${relogin.from} to ${relogin.to}`).join(", ")}: ${result.exitCode === 0 ? "done" : "failed"}`,
    })
    .catch((error: unknown) => {
      deps.reporter.warn(
        `OpsCrew could not write "set the current passwords of restored services" ${host.where} in its audit log: ${deps.redactor.redact(errorMessage(error))}`,
      );
    });
  if (result.exitCode === 0) return undefined;
  return hostFailure(run, host, result, `give ${names} ${their} current passwords again`);
}

/** A machine whose data may be partly changed, with its copy from just before when it is known. */
interface Stuck {
  host: ScriptHost;
  copy?: string;
}

/**
 * The error when a machine's data may be partly changed: the app stays stopped, so no version runs
 * on data that doesn't match, and each machine's copy from just before is named.
 */
function stuckError(run: SnapshotRun, cause: string, stuck: readonly Stuck[]): OpsCrewError {
  const { flags } = run;
  const each = stuck.map(({ host, copy }) =>
    copy === undefined
      ? `on ${host.name}, the newest snapshot by hand there (\`opscrew snapshot list${flags}\`)`
      : `on ${host.name}, \`opscrew restore ${copy}${flags}\``,
  );
  return new OpsCrewError(
    "COMMAND_FAILED",
    `${cause} So the data ${listText(stuck.map(({ host }) => `on ${host.name}`))} may be partly changed, and the app stays stopped: no version runs on data that doesn't match.`,
    {
      hint: `Once the cause is fixed, put the data from just before the restore back: ${listText(each)}. That starts the app again.`,
    },
  );
}

/** How the restores ended when one failed: its error, and whether the app must stay stopped. */
interface Failed {
  error: OpsCrewError;
  stuck: boolean;
}

/**
 * Each holder's restore ({@link restoreOn}), the extra servers first, each machine noted in `begun`
 * before it starts and its copy from just before in `saved`. When one fails, the machines restored
 * before it are put back too, in reverse, from the copies they took just before, under the same
 * hold and approval. `undefined` when every one was restored.
 */
async function restoreAll(
  run: SnapshotRun,
  input: {
    id: string;
    only?: string;
    ordered: readonly Holder[];
    hosts: ReadonlyMap<string, ScriptHost>;
    saved: Record<string, string>;
    begun: ScriptHost[];
    relogins: readonly Relogin[];
  },
): Promise<Failed | undefined> {
  const { deps } = run;
  const { id, only, hosts, saved, begun } = input;
  const done: Holder[] = [];
  for (const holder of input.ordered) {
    const host = hosts.get(holder.server) as ScriptHost;
    deps.reporter.step(`Restoring the snapshot ${id} ${host.where}`);
    begun.push(host);
    const relogins = input.relogins.filter((relogin) => relogin.server === holder.server);
    const outcome = await restoreOn(run, host, {
      id,
      ...(only === undefined ? {} : { only }),
      parts: holder.parts.map((part) => part.name),
      action: "restore a snapshot",
      noWait: relogins.map((relogin) => relogin.service),
    });
    if (outcome.saved !== undefined) saved[holder.server] = outcome.saved;
    let said: string;
    const left: Stuck[] = [];
    if (outcome.state === "restored") {
      done.push(holder);
      const failed = await reloginOn(run, host, id, relogins);
      if (failed === undefined) continue;
      // Its data is put back below with the others restored.
      said = failed.message;
    } else {
      said = (outcome.error as OpsCrewError).message;
      if (outcome.state === "stuck") {
        left.push({ host, ...(outcome.saved === undefined ? {} : { copy: outcome.saved }) });
      }
    }
    const failedBack: Stuck[] = [];
    for (const restored of [...done].reverse()) {
      const back = hosts.get(restored.server) as ScriptHost;
      const copy = saved[restored.server];
      deps.reporter.step(`Putting the data ${back.where} back as it was before the restore`);
      const put =
        copy === undefined
          ? undefined
          : await restoreOn(run, back, {
              id: copy,
              ...(only === undefined ? {} : { only }),
              parts: restored.parts.map((part) => part.name),
              action: "put back a restore",
            });
      if (put?.state !== "restored") {
        failedBack.push({ host: back, ...(copy === undefined ? {} : { copy }) });
      }
    }
    left.push(...failedBack);
    if (left.length > 0) {
      const cause =
        failedBack.length === 0
          ? said
          : `${said} OpsCrew could not put the data back as it was before the restore on ${listText(failedBack.map((each) => each.host.name))}, which it had restored.`;
      return { stuck: true, error: stuckError(run, cause, left) };
    }
    if (done.length === 0) return { stuck: false, error: outcome.error as OpsCrewError };
    return {
      stuck: false,
      error: new OpsCrewError(
        "COMMAND_FAILED",
        `${said} OpsCrew put the data back as it was before the restore on ${listText(done.map((each) => (hosts.get(each.server) as ScriptHost).name))} too, which it had restored: nothing changed.`,
        { hint: "Fix what it names, then try again." },
      ),
    };
  }
  return undefined;
}

/**
 * The restores of `holders` ({@link restoreAll}) between the app's server's `snapshot.sh hold` and
 * `resume` (D8): while held, no restore lets a request through or starts the app, so nothing is
 * written before every machine is done. `resume` runs on every way out, but when a machine's data
 * may be partly changed (a put-back that failed or a machine that didn't answer, or any other error
 * once a restore began): then the app stays stopped and each machine's copy is named
 * ({@link stuckError}). A hold that fails resumes best effort. Returns the copies taken just
 * before, by server.
 */
async function restoreEach(
  run: SnapshotRun,
  id: string,
  options: RestoreSnapshotOptions,
  holders: readonly Holder[],
  hosts: ReadonlyMap<string, ScriptHost>,
  app: ScriptHost,
  relogins: readonly Relogin[],
): Promise<Record<string, string>> {
  const { deps, flags } = run;
  const ordered = [
    ...holders.filter((holder) => holder.server !== APP_SERVER),
    ...holders.filter((holder) => holder.server === APP_SERVER),
  ];
  // A machine that throws counts as one that did not answer.
  const appScript = (command: "hold" | "resume") =>
    app
      .run(scriptCommand([command]), READ_TIMEOUT_MS)
      .catch(
        (error: unknown): CommandResult => ({ exitCode: 255, stdout: "", stderr: String(error) }),
      );
  const resumeApp = () => appScript("resume");
  deps.reporter.step(`Holding the app's requests and stopping it ${app.where}`);
  const held = await appScript("hold");
  if (held.exitCode !== 0) {
    // A hold that stopped part-way lets the app go again, best effort.
    await resumeApp();
    throw hostFailure(run, app, held, "hold the app's requests before the restore");
  }
  const saved: Record<string, string> = {};
  const begun: ScriptHost[] = [];
  let failed: Failed | undefined;
  let unexpected: unknown;
  try {
    failed = await restoreAll(run, {
      id,
      ...(options.only === undefined ? {} : { only: options.only }),
      ordered,
      hosts,
      saved,
      begun,
      relogins,
    });
  } catch (error) {
    if (begun.length === 0) {
      unexpected = error;
    } else {
      const said = deps.redactor.redact(errorMessage(error)).replace(/\.?$/, ".");
      const stuck = begun.map((host) => ({
        host,
        ...(saved[host.server] === undefined ? {} : { copy: saved[host.server] }),
      }));
      failed = {
        stuck: true,
        error: stuckError(run, `OpsCrew stopped during the restore: ${said}`, stuck),
      };
    }
  }
  if (failed?.stuck === true) throw failed.error;
  const resumed = await resumeApp();
  if (resumed.exitCode !== 0) {
    const said = scriptSaid(resumed, deps.redactor.redact);
    const message = `OpsCrew could not start the app again and let its requests through ${app.where} (exit code ${resumed.exitCode})${said === "" ? "" : `: ${said}`}.`;
    const before = failed?.error ?? (unexpected instanceof Error ? unexpected : undefined);
    throw new OpsCrewError(
      before instanceof OpsCrewError ? before.code : "COMMAND_FAILED",
      before === undefined ? message : `${before.message} ${message}`,
      {
        hint: `Start it as the deploy user in the app's folder there with \`sh snapshot.sh resume\` (${run.plan.app.name}'s runbook has the SSH command), then run \`opscrew status${flags}\`.`,
      },
    );
  }
  if (unexpected !== undefined) throw unexpected;
  if (failed !== undefined) throw failed.error;
  return saved;
}

/**
 * `opscrew restore <id>` on the environment `deps` belong to: refused while a deploy or a move
 * runs, for a snapshot it doesn't have, one of another version (unless `--allow-other-version`), a
 * stop-only service whose image changed, and when the approval is not given; otherwise restores it
 * where its data lives.
 * @throws OpsCrewError `INVALID_INPUT` for an id that isn't letters and digits or a wrong `--only`,
 * `PHASE_PRECONDITION` for each refusal, `CREDENTIALS_MISSING` without the bucket's key,
 * `SECRETS_KEY_REJECTED` for another age key, `APPROVAL_REFUSED`, and `COMMAND_FAILED` when a
 * restore fails (its data put back as it was).
 */
export async function restoreSnapshot(
  deps: PhaseDeps,
  id: string,
  options: RestoreSnapshotOptions = {},
): Promise<RestoredSnapshot> {
  requireSnapshotId(id);
  const services = options.services ?? {};
  const run = await snapshotRun(deps, services);
  hideIdentity(run, options.identity);
  const target = snapshotTarget(run);
  if (options.from === "offsite") requireOffsite(run, id, options);
  await requireNoDeployOrMove(run, "restore a snapshot");
  if (target === "portainer") return restoreInPortainer(run, services, id, options);
  return restoreOnHosts(run, services, id, options, target === "computer");
}
