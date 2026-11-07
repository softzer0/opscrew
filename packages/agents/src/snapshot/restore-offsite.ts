/**
 * The off-server copies' bucket from this computer (024 plan.md 6.–7., D4, FR-2403, FR-2407):
 * - its objects are listed, read and deleted by rclone run here (the pinned image in local Docker,
 *   or this computer's rclone), the bucket's key only in rclone's environment;
 * - each object is decrypted here with the recovery copy's age key ({@link ageDecryptStream}), as
 *   it streams: no server ever holds the key;
 * - a copy goes back as the snapshot's folder: into the app's snapshots folder on a server through
 *   its Docker API over SSH, or into the snapshots volume of the user's Portainer, by a busybox
 *   one-off that receives it as an archive (`putArchive`), streamed.
 */
import { pipeline, Readable, Transform } from "node:stream";
import {
  type DockerClient,
  dialStdioTransport,
  dockerClient,
  type MountSpec,
  runOneOff,
  type TarEntry,
  tarStream,
} from "@opscrew/connector-docker";
import type { CommandResult, DockerTransport } from "@opscrew/contracts";
import { ageDecryptStream, NodeStreamRunner, OpsCrewError } from "@opscrew/core";
import { appDir, IMAGES, OFFSITE_PREFIX, RCLONE_PROVIDERS } from "@opscrew/iac-templates";
import { APP_SERVER, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { setupCloudflare } from "../provision/credentials";
import { requireOffsiteKey } from "../provision/storage";
import type { CloudflareApi } from "../provision/types";
import { privateReach, r2Endpoint, STORAGE_ENDPOINTS, sshArgs } from "../shared";
import { serverShell } from "../status/servers";
import { hostFailure, READ_TIMEOUT_MS, type ScriptHost } from "./hosts";
import { DIR, failed, ONE_OFF_LABEL, type PortainerPlace } from "./portainer";
import type { SnapshotRun } from "./run";
import { type About, aboutOf, SERVER_SNAPSHOTS, SNAPSHOT_ID } from "./store";
import type { SnapshotServices } from "./types";

/** The collaborators of `opscrew restore` and of the bucket's copies, besides the snapshots'. */
export interface RestoreServices extends SnapshotServices {
  /** The Docker API of the server `server` (default: `docker system dial-stdio` over its login). */
  docker?: (server: string) => DockerTransport;
  /** Cloudflare's API, for an R2 bucket's account (default: its connector with the token). */
  cloudflare?: CloudflareApi | null;
}

/** The bucket of the off-server copies as rclone on this computer reaches it. */
export interface OffsiteBucket {
  /** The bucket's name, for messages and audit entries. */
  name: string;
  /** Where the copies are, as rclone names it: `offsite:<bucket>/backups`. */
  root: string;
  /** rclone's command line here, before its own arguments. */
  command: string;
  prefix: string[];
  /** The child's whole environment: this one's without `RCLONE_*`, with the bucket's settings. */
  env: Record<string, string | undefined>;
}

/** How long a listing or a deletion in the bucket may take. */
const BUCKET_TIMEOUT_MS = 5 * 60_000;
/** rclone's exit code for a path that is not there. */
const NOT_FOUND = 3;
/** The most bytes an `about.json` may take. */
const MAX_ABOUT_BYTES = 1024 * 1024;
/** A record's object in the bucket, written last (plan.md 1.). */
const ABOUT_OBJECT = "about.json.age";

/** rclone here: the pinned image in local Docker, else this computer's rclone. */
async function rcloneHere(
  run: SnapshotRun,
  names: readonly string[],
): Promise<{ command: string; prefix: string[] }> {
  const { runner } = run.deps;
  const answered = (result: CommandResult | undefined) => result?.exitCode === 0;
  const docker = await runner
    .run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (answered(docker)) {
    const env = names.flatMap((name) => ["-e", name]);
    return { command: "docker", prefix: ["run", "--rm", "-i", ...env, IMAGES.rclone.ref] };
  }
  const local = await runner
    .run("rclone", ["version"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (answered(local)) return { command: "rclone", prefix: [] };
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew reads the off-server copies with rclone on this computer, and finds neither Docker (which runs the pinned rclone image) nor rclone here. Nothing was changed.",
    { hint: "Start Docker, or install rclone (https://rclone.org/install/), then try again." },
  );
}

/**
 * The bucket of `run`'s off-server copies (`snapshots.offsite`), reached from this computer with
 * its key ({@link requireOffsiteKey}: from the environment or the kept key, never asked here) and,
 * for R2, the zone's account (provision's read-only Cloudflare lookup); `undefined` without the
 * off-server copy. `command` is the one the key's hint names.
 * @throws OpsCrewError `CREDENTIALS_MISSING` without the key, `PHASE_PRECONDITION` without rclone.
 */
export async function offsiteBucket(
  run: SnapshotRun,
  services: RestoreServices,
  command: string,
): Promise<OffsiteBucket | undefined> {
  const { deps, plan } = run;
  const offsite = snapshotOffsiteOf(plan);
  if (offsite === undefined) return undefined;
  const key = await requireOffsiteKey(deps, plan, {}, { command });
  let endpoint: string;
  if (offsite.provider === "r2") {
    const cloudflare = await setupCloudflare(
      deps,
      plan,
      { ...(services.cloudflare === undefined ? {} : { cloudflare: services.cloudflare }) },
      { foreignRecords: "report" },
    );
    if (cloudflare === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "The off-server copies are on Cloudflare R2, but the app has no domain on Cloudflare, so OpsCrew can't tell which account holds their bucket. Nothing was changed.",
        {
          hint: "Give the app its domain on Cloudflare again (`opscrew dns --domain <hostname>`), then try again.",
        },
      );
    }
    endpoint = r2Endpoint(cloudflare.accountId);
  } else {
    endpoint = STORAGE_ENDPOINTS[offsite.provider]?.(offsite.region) ?? "";
  }
  const settings: Record<string, string> = {
    RCLONE_CONFIG_OFFSITE_TYPE: "s3",
    RCLONE_CONFIG_OFFSITE_PROVIDER: RCLONE_PROVIDERS[offsite.provider],
    RCLONE_CONFIG_OFFSITE_REGION: offsite.region,
    RCLONE_CONFIG_OFFSITE_ENDPOINT: endpoint,
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: key.accessKeyId,
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: key.secretAccessKey,
    // The bucket exists: rclone never tries to create it.
    RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
  };
  const tool = await rcloneHere(run, Object.keys(settings));
  const own = Object.entries(deps.env).filter(([name]) => !/^RCLONE_/i.test(name));
  return {
    name: offsite.bucket,
    root: `offsite:${offsite.bucket}/${OFFSITE_PREFIX}`,
    ...tool,
    env: { ...Object.fromEntries(own), ...settings },
  };
}

/** The plain error of an rclone command in the bucket that failed, its words redacted. */
function bucketFailure(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  what: string,
  result: CommandResult,
) {
  const said = run.deps.redactor.redact(result.stderr.trim().split(/\r?\n/).at(-1)?.trim() ?? "");
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `OpsCrew could not ${what} in the bucket ${bucket.name} (exit code ${result.exitCode})${said === "" ? "." : `: ${said.slice(0, 300)}`}`,
    { hint: "Check the bucket's key and that the bucket is there, then try again." },
  );
}

/** rclone's `args` in the bucket, its output read whole; `NOT_FOUND` is returned, not thrown. */
async function rclone(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  args: readonly string[],
  what: string,
): Promise<CommandResult> {
  const result = await run.deps.runner.run(bucket.command, [...bucket.prefix, ...args], {
    env: bucket.env,
    timeoutMs: BUCKET_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 && result.exitCode !== NOT_FOUND) {
    throw bucketFailure(run, bucket, what, result);
  }
  return result;
}

/** The objects under `under` (`<id>`, or none for every copy), their paths relative to it. */
export async function bucketObjects(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  under = "",
): Promise<string[]> {
  const path = under === "" ? bucket.root : `${bucket.root}/${under}`;
  const result = await rclone(run, bucket, ["lsf", "-R", "--files-only", path], "list the copies");
  if (result.exitCode === NOT_FOUND) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The servers whose part of each copy in the bucket is complete (its `about.json.age`, written
 * last), by the copy's id: `app` for the objects right under it (also a Portainer's), else the
 * extra server whose folder they are in.
 */
export function bucketCopies(objects: readonly string[]): Map<string, string[]> {
  const copies = new Map<string, string[]>();
  for (const object of objects) {
    const [id = "", second = "", third] = object.split("/");
    if (!SNAPSHOT_ID.test(id)) continue;
    const server =
      third === undefined
        ? second === ABOUT_OBJECT
          ? APP_SERVER
          : undefined
        : third === ABOUT_OBJECT
          ? second
          : undefined;
    if (server === undefined) continue;
    copies.set(id, [...(copies.get(id) ?? []), server]);
  }
  return copies;
}

/** The servers whose part of the copy `id` the bucket holds whole ({@link bucketCopies}). */
export async function bucketServers(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  id: string,
): Promise<string[]> {
  const objects = await bucketObjects(run, bucket, id);
  return bucketCopies(objects.map((object) => `${id}/${object}`)).get(id) ?? [];
}

/** Where `server`'s part of the copy `id` is in the bucket, under the root. */
export function partPath(id: string, server: string, file: string): string {
  return server === APP_SERVER ? `${id}/${file}.age` : `${id}/${server}/${file}.age`;
}

/**
 * The object `path` as it streams out of the bucket, still encrypted: the stream fails when rclone
 * fails, its words redacted, and destroyed before rclone ended, it kills rclone.
 */
export function bucketRead(run: SnapshotRun, bucket: OffsiteBucket, path: string): Readable {
  const streams = run.deps.streams ?? new NodeStreamRunner();
  const child = streams.open(bucket.command, [...bucket.prefix, "cat", `${bucket.root}/${path}`], {
    env: bucket.env,
  });
  child.stream.end();
  let ended = false;
  const out = new Transform({
    transform: (chunk, _encoding, done) => done(null, chunk),
    flush: (done) => {
      child.exit.then(({ exitCode, stderr }) => {
        ended = true;
        done(
          exitCode === 0
            ? null
            : bucketFailure(run, bucket, `read ${path}`, { exitCode, stdout: "", stderr }),
        );
      }, done);
    },
    destroy: (error, done) => {
      if (!ended) child.kill();
      done(error);
    },
  });
  child.stream.on("error", (error: Error) => out.destroy(error));
  return child.stream.pipe(out);
}

/** Registers the age key `identity` holds (the key, or its key file's text) with the redactor. */
export function hideIdentity(run: SnapshotRun, identity: string | undefined): void {
  for (const line of identity?.split(/\r?\n/) ?? []) {
    const key = line.trim();
    if (key.startsWith("AGE-SECRET-KEY-1")) run.deps.redactor.addLiteral(key, "age-identity");
  }
}

/**
 * The object `path`, decrypted with `identity` as it streams. A chunk that doesn't check, a
 * download that fails, or a reader that stops early (a file longer than its size) ends both, and
 * with them the rclone child.
 */
export function bucketDecrypted(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  identity: string,
  path: string,
): Readable {
  // The error reaches the reader through the decrypted stream, which the pipeline destroys.
  return pipeline(bucketRead(run, bucket, path), ageDecryptStream(identity), () => {});
}

/** One part's record in the bucket: its `about.json`, as read, and its bytes. */
export interface BucketAbout {
  about: About;
  text: string;
}

/**
 * `server`'s `about.json` of the copy `id`, decrypted here.
 * @throws OpsCrewError `ARTIFACT_INVALID` when it doesn't read as the store's contract or names
 * another id, `SECRETS_KEY_REJECTED` for another key.
 */
export async function bucketAbout(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  identity: string,
  id: string,
  server: string,
): Promise<BucketAbout> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of bucketDecrypted(
    run,
    bucket,
    identity,
    partPath(id, server, "about.json"),
  )) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_ABOUT_BYTES) throw unreadable(id);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  const about = aboutOf(text);
  if (about === undefined || about.id !== id) throw unreadable(id);
  return { about, text };
}

/** The refusal of a record in the bucket that does not read as the store's contract. */
function unreadable(id: string): OpsCrewError {
  return new OpsCrewError(
    "ARTIFACT_INVALID",
    `The record of the copy ${id} in the off-server bucket could not be read, so OpsCrew did not use it. Nothing was changed.`,
    { hint: "Restore another copy (`opscrew snapshot list`), or take a new snapshot." },
  );
}

/** Deletes the copy `id` in the bucket: `already gone` when nothing was there. */
export async function bucketDelete(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  id: string,
): Promise<"deleted" | "already gone"> {
  const result = await rclone(
    run,
    bucket,
    ["purge", `${bucket.root}/${id}`],
    `delete the copy ${id}`,
  );
  return result.exitCode === NOT_FOUND ? "already gone" : "deleted";
}

/** One file of a copy to put back: its name in the snapshot's folder and its size. */
export interface CopyFile {
  file: string;
  size: number;
}

/** The files a record names, with their sizes. */
export function filesOf(about: About): CopyFile[] {
  return about.services.flatMap((entry) =>
    "file" in entry ? [{ file: entry.file, size: entry.size }] : [],
  );
}

/** What a copy from the bucket puts in its snapshot's folder: every file its record names. */
export interface CopyInput {
  id: string;
  /** The server whose part it is (`app` in a Portainer). */
  server: string;
  record: BucketAbout;
}

/**
 * A stream that opens its source only when it is first read, one download at a time; destroyed, it
 * destroys the source, which ends its download.
 */
function lazy(open: () => Readable): Readable {
  let source: Readable | undefined;
  return new Readable({
    read() {
      if (source !== undefined) {
        source.resume();
        return;
      }
      source = open();
      source.on("data", (chunk: Buffer) => {
        if (!this.push(chunk)) source?.pause();
      });
      source.on("end", () => this.push(null));
      source.on("error", (error) => this.destroy(error));
    },
    destroy(error, done) {
      source?.destroy();
      done(error);
    },
  });
}

/**
 * The archive of `<id>.taking/`: each file decrypted as it streams (of exactly its size), `taken`,
 * `offsite.done` (the copy is in the bucket) and `about.json` last, owned by `uid`:`gid`, files
 * 600 and the folder 700 (plan.md 1.).
 */
function copyArchive(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  identity: string,
  input: CopyInput & { uid: number; gid: number },
): Readable {
  const { id, server, record, uid, gid } = input;
  // At the archive's root, as the one-off mounts the snapshots at {@link DIR}.
  const folder = `${DIR.slice(1)}/${id}.taking`;
  const owned = { uid, gid };
  const entries: TarEntry[] = [
    { name: `${folder}/`, type: "dir", mode: 0o700, ...owned },
    ...filesOf(record.about).map(
      (part): TarEntry => ({
        name: `${folder}/${part.file}`,
        type: "file",
        mode: 0o600,
        ...owned,
        size: part.size,
        stream: lazy(() => bucketDecrypted(run, bucket, identity, partPath(id, server, part.file))),
      }),
    ),
    {
      name: `${folder}/taken`,
      type: "file",
      mode: 0o600,
      ...owned,
      data: Buffer.from(`${record.about.taken}\n`),
    },
    { name: `${folder}/offsite.done`, type: "file", mode: 0o600, ...owned, data: Buffer.alloc(0) },
    {
      name: `${folder}/about.json`,
      type: "file",
      mode: 0o600,
      ...owned,
      data: Buffer.from(`${record.text}\n`),
    },
  ];
  return tarStream(entries);
}

/**
 * Receives `archive` in a busybox one-off with `mount` at {@link DIR}, before it starts, then
 * renames `<id>.taking` to `<id>`, in place of a folder `<id>` without `about.json` (an earlier
 * copy that never completed): the copy appears whole, or not at all. A folder `<id>` with an
 * `about.json` stays as it is, and the copy goes ({@link PRESENT}).
 */
async function receive(
  docker: DockerClient,
  mount: MountSpec,
  id: string,
  archive: Readable,
): Promise<number> {
  const result = await runOneOff(
    docker,
    {
      image: IMAGES.busybox.ref,
      cmd: [
        "sh",
        "-c",
        `if [ -e ${DIR}/${id}/about.json ]; then rm -rf ${DIR}/${id}.taking; exit ${PRESENT}; fi; rm -rf ${DIR}/${id} && mv ${DIR}/${id}.taking ${DIR}/${id}`,
      ],
      labels: { [ONE_OFF_LABEL]: mount.source },
      mounts: [mount],
      network: "none",
    },
    (container) => docker.putArchive(container, "/", archive),
  );
  return result.exitCode;
}

/**
 * The exit code of a copy's preparation or its one-off when the snapshot's folder holds an
 * `about.json` already: one the restore could not read, since it reads the folder's own first.
 */
const PRESENT = 6;

/**
 * The refusal to replace `folder` (in words), whose `about.json` the restore could not read: only
 * the user can tell what it holds, so it is not deleted.
 */
function unreadableFolder(folder: string, id: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${folder} has an about.json that OpsCrew can't read, so it did not put the bucket's copy of the snapshot ${id} in its place. Nothing was changed.`,
    {
      hint: "Fix that about.json, or remove the folder by hand if you want the bucket's copy instead, then try again.",
    },
  );
}

/**
 * The Docker API of the server `server` of `run`'s plan: `services.docker`'s, else `docker system
 * dial-stdio` over the login `opscrew logs` uses (through `sudo -n` where that login reaches
 * Docker only so), at the address that login reaches, registered with the redactor.
 */
async function serverDocker(
  run: SnapshotRun,
  services: RestoreServices,
  server: string,
): Promise<{ client: DockerClient; close(): Promise<void> }> {
  const { deps, plan } = run;
  const injected = services.docker?.(server);
  const transport =
    injected ??
    (await (async () => {
      const { login, sudo } = await serverShell(deps, plan, server, services);
      const reach = (await privateReach(deps, plan, server, login)) ?? login;
      deps.redactor.addName(reach.host, "server-address");
      const streams = deps.streams ?? new NodeStreamRunner();
      const args = [
        ...sshArgs({
          host: reach.host,
          port: reach.port,
          user: login.user,
          ...(login.keyFile === undefined ? {} : { keyFile: login.keyFile }),
          knownHostsFile: deps.paths.files.knownHosts,
          fresh: true,
          // A copy's stream can stay quiet while the next object starts downloading.
          keepAliveSeconds: 15,
        }),
        sudo ? "sudo -n docker system dial-stdio" : "docker system dial-stdio",
      ];
      return dialStdioTransport(() => streams.open("ssh", args));
    })());
  return {
    client: dockerClient(transport),
    close: async () => {
      await transport.close?.();
    },
  };
}

/**
 * Puts the copy `input` from the bucket into the app's snapshots folder on `host` (a server), as
 * the deploy user's: the folder made if needed, then received whole through the server's Docker
 * API. Changes nothing when the snapshot's folder holds an `about.json` already
 * ({@link unreadableFolder}); a copy that fails part-way leaves nothing.
 */
export async function copyToServer(
  run: SnapshotRun,
  services: RestoreServices,
  bucket: OffsiteBucket,
  identity: string,
  host: ScriptHost,
  input: CopyInput,
): Promise<void> {
  const { id } = input;
  const dir = SERVER_SNAPSHOTS;
  const prepared = await host.run(
    `mkdir -p ${dir} && chmod 700 ${dir} && rm -rf ${dir}/${id}.taking && if [ -e ${dir}/${id}/about.json ]; then exit ${PRESENT}; fi; echo "owner $(id -u) $(id -g)"`,
    READ_TIMEOUT_MS,
  );
  const owner = /^owner (\d+) (\d+)$/m.exec(prepared.stdout);
  const folder = `The folder ${dir}/${id} in the app's folder ${host.where}`;
  if (prepared.exitCode === PRESENT) throw unreadableFolder(folder, id);
  if (prepared.exitCode !== 0 || owner === null) {
    throw hostFailure(run, host, prepared, `make room for the copy ${id}`);
  }
  const docker = await serverDocker(run, services, host.server);
  try {
    const archive = copyArchive(run, bucket, identity, {
      ...input,
      uid: Number(owner[1]),
      gid: Number(owner[2]),
    });
    const mount: MountSpec = { type: "bind", source: `${appDir(run.plan)}/${dir}`, target: DIR };
    const exitCode = await receive(docker.client, mount, id, archive);
    if (exitCode === PRESENT) throw unreadableFolder(folder, id);
    if (exitCode !== 0) throw failedHere(host.where, id, exitCode);
  } catch (error) {
    await host.run(`rm -rf ${dir}/${id}.taking`, READ_TIMEOUT_MS).catch(() => undefined);
    throw error;
  } finally {
    await docker.close();
  }
}

/** The error of a copy that a busybox one-off could not put in place. */
function failedHere(where: string, id: string, exitCode: number): OpsCrewError {
  return new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not put the copy ${id} from the bucket in place ${where} (exit code ${exitCode}).`,
    { hint: "Check the free disk there, then try again." },
  );
}

/**
 * Puts the copy `input` from the bucket into the snapshots volume of the user's Portainer, root's
 * as Portainer's snapshots are, received whole through its Docker API.
 */
export async function copyToPortainer(
  run: SnapshotRun,
  bucket: OffsiteBucket,
  identity: string,
  place: PortainerPlace,
  input: CopyInput,
): Promise<void> {
  const { id } = input;
  const mount: MountSpec = { type: "volume", source: place.volume, target: DIR };
  const archive = copyArchive(run, bucket, identity, { ...input, uid: 0, gid: 0 });
  const exitCode = await receive(place.docker, mount, id, archive).catch(async (error: unknown) => {
    await runOneOff(place.docker, {
      image: IMAGES.busybox.ref,
      cmd: ["rm", "-rf", `${DIR}/${id}.taking`],
      labels: { [ONE_OFF_LABEL]: place.volume },
      mounts: [mount],
      network: "none",
    }).catch(() => undefined);
    throw error;
  });
  if (exitCode === PRESENT) {
    throw unreadableFolder(
      `The folder ${id} in your Portainer's snapshots volume ${place.volume}`,
      id,
    );
  }
  if (exitCode !== 0) throw failed(`put the copy ${id} from the bucket in place`, exitCode);
}
