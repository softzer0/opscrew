/**
 * `opscrew restore <id> [--only <service>] [--allow-other-version] [--from offsite]` (US3, US6,
 * FR-2404, FR-2407; 024 plan.md 6., D8, D13, D18): puts a data snapshot back where its data lives.
 * - **Before any change:** the snapshot's records (`about.json`) and what runs are read, the
 *   version and the stop-only services' images checked ({@link checkVersion}, {@link checkImages}),
 *   then the restore is approved like a destroy ({@link approveRestore}).
 * - **Servers and this computer:** each machine's `snapshot.sh restore`, after the one-time
 *   approval file the script requires; it holds the requests, stops the app, copies the data as it
 *   is now and puts that copy back on failure. With parts on extra servers, the app's server's
 *   `snapshot.sh hold` runs first and `snapshot.sh resume` after, also on failure (D8). A
 *   pre-release snapshot is restored by its digest the same way (D18: `restore <hex> --only <s>`).
 * - **The user's Portainer:** through its Docker API ({@link restoreInPortainer}).
 * - **`--from offsite`:** the copy is downloaded and decrypted on this computer and streamed into
 *   the snapshots' folder first ({@link copyToServer}); the servers never hold the key.
 * Nothing it prints, audits or asks holds a password, a key, an address or data.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import {
  RESTORE_APPROVAL_FILE,
  restoreApprovalLine,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER, snapshotOffsiteOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { APPROVAL_SECONDS } from "../rollback/database";
import {
  computerHost,
  dataServers,
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
  bucketCopies,
  bucketObjects,
  copyToServer,
  hideIdentity,
  type OffsiteBucket,
  offsiteBucket,
  type RestoreServices,
} from "./restore-offsite";
import { restoreInPortainer } from "./restore-portainer";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { type About, AboutSchema, SERVER_SNAPSHOTS, SNAPSHOT_ID, versionLine } from "./store";

/** How long one machine's restore may take: its copy first, then the restore. */
const RESTORE_TIMEOUT_MS = 6 * 60 * 60_000;

/** The running version's digest on a machine, as `snapshot_running` reads it: `version <hex>`. */
const VERSION_COMMAND = `if [ -f .env ]; then sed -n 's/^APP_IMAGE=.*@sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' .env; elif [ -f .running ]; then sed -n 's/^[^=]*@sha256:\\([0-9a-f]\\{64\\}\\)$/version \\1/p' .running; fi`;

/** What one machine says before the approval, read-only. */
interface Probe {
  /** The snapshot's record there, with its bytes. */
  record?: BucketAbout;
  /** True when its folder is there (complete or not). */
  present: boolean;
  /** The running version (`sha256:<hex>`), or empty. */
  version: string;
  /** The image each of its services' containers runs, by service. */
  images: Map<string, string>;
}

/**
 * Reads, in one command on `host` and changing nothing: the snapshot `id`'s `about.json` through
 * `snapshot.sh list` (with `list`, a machine with parts), whether its folder is there, the version
 * that runs, and the image of each of `services`' containers.
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
    `if [ -e ${SERVER_SNAPSHOTS}/${id} ]; then echo present; fi`,
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
    present: /^present$/m.test(result.stdout),
    version: versionLine(result.stdout),
    images,
  };
}

/** The record of `id` among the `about.json` lines `stdout` holds. */
function recordOf(stdout: string, id: string): { record?: BucketAbout } {
  for (const raw of stdout.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const about = AboutSchema.safeParse(parsed);
    if (about.success && about.data.id === id) return { record: { about: about.data, text } };
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

/** The servers whose part of the copy `id` the bucket holds whole ({@link bucketCopies}). */
async function bucketServers(run: SnapshotRun, bucket: OffsiteBucket, id: string) {
  const objects = await bucketObjects(run, bucket, id);
  return bucketCopies(objects.map((object) => `${id}/${object}`)).get(id) ?? [];
}

/** The one-time approval of the restore, written in the app's folder as the deploy user's. */
function approvalCommand(line: string): string {
  const file = RESTORE_APPROVAL_FILE;
  return `umask 077 && printf '%s\\n' ${shellQuote(line)} > ${file} && chmod 600 ${file}`;
}

/** The id of the copy a restore took just before, as `snapshot.sh restore` says it. */
function savedOf(stderr: string): string | undefined {
  return /The data from just before the restore is the snapshot ([0-9A-Za-z]+)\./.exec(stderr)?.[1];
}

/**
 * The restore on the app's servers or this computer (plan.md 6., D8): the records read on each
 * machine with data (or in the bucket with `--from offsite`), checked and approved; then, with
 * `--from offsite`, each copy put in place; then each machine's `snapshot.sh restore` after its
 * one-time approval, the extra servers first, the app held around them (`hold`, `resume`, also on
 * failure). A machine that fails stops the restore: what the others did is said, with the copies
 * that put them back.
 */
async function restoreOnHosts(
  run: SnapshotRun,
  services: RestoreServices,
  id: string,
  options: RestoreSnapshotOptions,
  local: boolean,
): Promise<RestoredSnapshot> {
  const { deps, plan, environment, flags } = run;
  const servers = local ? [APP_SERVER] : dataServers(plan);
  const hosts = new Map<string, ScriptHost>();
  for (const server of servers) {
    hosts.set(server, local ? await computerHost(run) : await serverHost(run, server));
  }
  const app = hosts.get(APP_SERVER) ?? (await serverHost(run, APP_SERVER));
  const partsOf = (server: string): SnapshotPart[] =>
    local ? snapshotParts(plan) : snapshotParts(plan, server);
  // 1. What each machine holds and runs, read-only.
  const probes = new Map<string, Probe>();
  for (const server of servers) {
    const named = partsOf(server).filter((part) => part.image !== undefined);
    probes.set(
      server,
      await probe(
        run,
        hosts.get(server) as ScriptHost,
        id,
        named.map((part) => part.name),
        true,
      ),
    );
  }
  const running = (probes.get(APP_SERVER) ?? (await probe(run, app, id, [], false))).version;
  // 2. The records: on the machines, or in the bucket.
  let bucket: OffsiteBucket | undefined;
  const records = new Map<string, BucketAbout>();
  if (options.from === "offsite") {
    bucket = await offsiteBucket(run, services, `opscrew restore ${id}${flags} --from offsite`);
    for (const server of await bucketServers(run, bucket as OffsiteBucket, id)) {
      if (!servers.includes(server)) continue;
      if (probes.get(server)?.present === true) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `The snapshot ${id} is on ${(hosts.get(server) as ScriptHost).name} already, so its copy in the bucket is not needed. ${NOTHING_CHANGED}`,
          { hint: `Restore it from there: \`opscrew restore ${id}${flags}\`.` },
        );
      }
      records.set(
        server,
        await bucketAbout(run, bucket as OffsiteBucket, options.identity as string, id, server),
      );
    }
  } else {
    for (const [server, read] of probes)
      if (read.record !== undefined) records.set(server, read.record);
  }
  if (records.size === 0) {
    const offsite = snapshotOffsiteOf(plan) !== undefined && options.from === undefined;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} has no snapshot ${id}${options.from === "offsite" ? " in its off-server bucket" : ""}. ${NOTHING_CHANGED}`,
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
  const where = `on ${listText(holders.map((holder) => holder.name))}`;
  await approveRestore(run, { id, holders, where, options, approvalFile: true });
  // 4. The copies from the bucket, then the restores.
  if (bucket !== undefined) {
    for (const holder of holders) {
      const host = hosts.get(holder.server) as ScriptHost;
      const record = records.get(holder.server) as BucketAbout;
      deps.reporter.step(`Copying the snapshot ${id} from the off-server bucket to ${host.name}`);
      await copyToServer(run, services, bucket, options.identity as string, host, {
        id,
        server: holder.server,
        record,
        files: filesOf(record.about),
      });
    }
  }
  const saved = await restoreEach(run, id, options, holders, hosts, app, local);
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

/** The files a record names, with their sizes. */
function filesOf(about: About): { file: string; size: number }[] {
  return about.services.flatMap((entry) =>
    "file" in entry ? [{ file: entry.file, size: entry.size }] : [],
  );
}

/**
 * Each holder's `snapshot.sh restore`, the extra servers first, each after its one-time approval;
 * with an extra server among them, the app held first and resumed after, also on failure. Returns
 * the copies taken just before, by server.
 */
async function restoreEach(
  run: SnapshotRun,
  id: string,
  options: RestoreSnapshotOptions,
  holders: readonly Holder[],
  hosts: ReadonlyMap<string, ScriptHost>,
  app: ScriptHost,
  local: boolean,
): Promise<Record<string, string>> {
  const { deps, flags } = run;
  const ordered = [
    ...holders.filter((holder) => holder.server !== APP_SERVER),
    ...holders.filter((holder) => holder.server === APP_SERVER),
  ];
  const hold = !local && ordered.some((holder) => holder.server !== APP_SERVER);
  if (hold) {
    deps.reporter.step("Holding the app's requests and stopping it on the app's server");
    const held = await app.run(scriptCommand(["hold"]), READ_TIMEOUT_MS);
    if (held.exitCode !== 0) {
      throw hostFailure(run, app, held, "hold the app's requests before the restore");
    }
  }
  const saved: Record<string, string> = {};
  const done: ScriptHost[] = [];
  let failure: OpsCrewError | undefined;
  try {
    for (const holder of ordered) {
      const host = hosts.get(holder.server) as ScriptHost;
      const expiry = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
      const written = await host.run(
        approvalCommand(restoreApprovalLine(id, options.only, expiry)),
        READ_TIMEOUT_MS,
      );
      if (written.exitCode !== 0) {
        throw hostFailure(run, host, written, "leave the restore's one-time approval");
      }
      deps.reporter.step(`Restoring the snapshot ${id} ${host.where}`);
      const args = ["restore", id, ...(options.only === undefined ? [] : ["--only", options.only])];
      const result = await host.run(scriptCommand(args), RESTORE_TIMEOUT_MS);
      await deps.audit.append({
        kind: "remote-exec",
        actor: "opscrew",
        action: "restore a snapshot",
        target: host.audit,
        decision: "approved",
        detail: `${id}: ${holder.parts.map((part) => part.name).join(", ")}: ${result.exitCode === 0 ? "restored" : "failed"}`,
      });
      if (result.exitCode !== 0) {
        const error = hostFailure(run, host, result, `restore the snapshot ${id}`);
        const back = done.map((each) =>
          saved[each.server] === undefined
            ? `${each.name} (its copy from just before is named in its snapshot list)`
            : `${each.name} (\`opscrew restore ${saved[each.server]}${flags}\` puts its data from just before back)`,
        );
        const others = done.length === 0 ? "" : ` It was restored on ${listText(back)} already.`;
        throw new OpsCrewError(error.code, `${error.message}${others}`, {
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        });
      }
      const before = savedOf(result.stderr);
      if (before !== undefined) saved[holder.server] = before;
      done.push(host);
    }
  } catch (error) {
    if (!(error instanceof OpsCrewError)) throw error;
    failure = error;
  }
  if (hold) {
    const resumed = await app.run(scriptCommand(["resume"]), READ_TIMEOUT_MS);
    if (resumed.exitCode !== 0) {
      const said = scriptSaid(resumed, deps.redactor.redact);
      const stuck = `OpsCrew could not start the app again and let its requests through on the app's server (exit code ${resumed.exitCode})${said === "" ? "" : `: ${said}`}.`;
      throw new OpsCrewError(
        failure?.code ?? "COMMAND_FAILED",
        failure === undefined ? stuck : `${failure.message} ${stuck}`,
        {
          hint: `Start it as the deploy user in the app's folder there with \`sh snapshot.sh resume\` (${run.plan.app.name}'s runbook has the SSH command), then run \`opscrew status${flags}\`.`,
        },
      );
    }
  }
  if (failure !== undefined) throw failure;
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
  if (!SNAPSHOT_ID.test(id)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${id} is no snapshot's id: an id has only letters and digits. ${NOTHING_CHANGED}`,
      { hint: "`opscrew snapshot list` shows each snapshot's id." },
    );
  }
  const services = options.services ?? {};
  const run = await snapshotRun(deps, services);
  hideIdentity(run, options.identity);
  const target = snapshotTarget(run);
  if (options.from === "offsite") requireOffsite(run, id, options);
  await requireNoDeployOrMove(run, "restore a snapshot");
  if (target === "portainer") return restoreInPortainer(run, services, id, options);
  return restoreOnHosts(run, services, id, options, target === "computer");
}
