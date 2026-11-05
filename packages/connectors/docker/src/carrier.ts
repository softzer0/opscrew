import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import { DockerApiError, type DockerClient, type MountSpec } from "./client";

/** Where a carrier mounts its source; an archive holds the source's files under `data/`. */
const MOUNT = "/data";

/** Where the carrier that checks a folder is no symbolic link mounts the folder's parent. */
const PARENT_MOUNT = "/parent";

/** The label on every carrier container, with its source's volume name or folder path. */
const CARRIER_LABEL = "opscrew.carrier";

/**
 * Hashes what is at {@link MOUNT}: each path's type, mode, owner, group and link target, the size
 * of everything but folders (a folder's size depends on the file system, not its content), and
 * each file's SHA-256, sorted and reduced to one SHA-256.
 */
const DIGEST_SCRIPT = `set -e
cd ${MOUNT}
find . -type d -exec stat -c '%F %a %u %g %N' {} + > /tmp/listing
find . ! -type d -exec stat -c '%F %a %u %g %s %N' {} + >> /tmp/listing
find . -type f -exec sha256sum {} + >> /tmp/listing
sort /tmp/listing | sha256sum`;

/**
 * What a carrier copies: a named Docker volume, or a folder on the server bound into a service
 * (`/srv/data/<app>/<service>` on a server OpsCrew deploys to over SSH).
 */
export type CarrierSource = { kind: "volume"; name: string } | { kind: "bind"; path: string };

/** A source's volume name or folder path: the left side of its bind, and its carriers' label. */
function located(source: CarrierSource): string {
  return source.kind === "volume" ? source.name : source.path;
}

/** A source in a message: `volume <name>` or `folder <path>`. */
function described(source: CarrierSource): string {
  return `${source.kind === "volume" ? "volume" : "folder"} ${located(source)}`;
}

/**
 * Refuses a folder a carrier must not bind: one whose path isn't absolute and plain (no `.`, `..`
 * or empty parts, no trailing slash, no `:`, which would end the bind's path), or isn't under one
 * of `roots`.
 */
function checkFolder(folder: string, roots: readonly string[]): void {
  const parts = folder.split("/");
  if (
    parts[0] !== "" ||
    folder.includes(":") ||
    parts.slice(1).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new OpsCrewError("INVALID_INPUT", `The folder ${folder} is not a plain absolute path.`, {
      hint: 'Give an absolute path without ".", "..", empty parts, a trailing slash or ":", then try again.',
    });
  }
  if (!roots.some((root) => folder.startsWith(root.endsWith("/") ? root : `${root}/`))) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The folder ${folder} is outside the folders OpsCrew may copy here${roots.length > 0 ? ` (${roots.join(", ")})` : ""}.`,
      {
        hint: "OpsCrew copies only the app's data folders; check the service's folder, then try again.",
      },
    );
  }
}

/**
 * Removes the carriers left behind for `sources` on `docker`'s host, such as after a lost
 * connection. Call it before removing those volumes or folders: Docker refuses to remove a volume
 * in use. Other sources' carriers, which may belong to another app's move, stay.
 */
export async function sweepCarriers(docker: DockerClient, sources: readonly CarrierSource[]) {
  for (const source of sources) {
    for (const carrier of await docker.listContainers([`${CARRIER_LABEL}=${located(source)}`])) {
      await docker.removeContainer(carrier.id);
    }
  }
}

/** Reads, writes, hashes and measures volumes and folders through short-lived carrier containers. */
export interface VolumeCarrier {
  /**
   * The source as a tar stream, its files under `data/`, from a carrier that is created with the
   * source mounted read-only and never started. The carrier is removed before the stream ends,
   * or before it closes when it is destroyed early.
   */
  readVolume(source: CarrierSource): Promise<Readable>;
  /**
   * Replaces the source's content with `archive` (as {@link readVolume} streams it): a carrier
   * empties it (a folder itself stays, with its owner and mode) and exits, then the archive is
   * unpacked into the stopped carrier, owners and modes kept. On failure `archive` is destroyed,
   * and the call settles once it has closed.
   */
  writeVolume(source: CarrierSource, archive: Readable): Promise<void>;
  /** One SHA-256 (hex) over the source's paths, types, modes, owners, sizes and contents. */
  volumeDigest(source: CarrierSource): Promise<string>;
  /**
   * The source's size in bytes: a volume's from Docker's disk usage, a folder's (and a volume's
   * Docker can't tell) from the carrier's `du -sb`.
   */
  sourceSize(source: CarrierSource): Promise<number>;
}

/**
 * The carrier operations on `docker`'s host, with `image` as the carrier (a pinned busybox,
 * pulled when the host lacks it). A folder is bound only when it is under one of `allowedRoots`
 * (such as `/srv/data/`); with none, only volumes are. Each operation refuses a source that
 * doesn't exist and a folder that is a symbolic link, before touching anything, and removes its
 * carriers, also when it fails.
 */
export function volumeCarrier(
  docker: DockerClient,
  image: string,
  allowedRoots: readonly string[] = [],
): VolumeCarrier {
  /** How a carrier mounts `source` at {@link MOUNT}. */
  const mounted = (source: CarrierSource, readOnly: boolean): MountSpec => ({
    type: source.kind,
    source: located(source),
    target: MOUNT,
    readOnly,
  });

  function missing(source: CarrierSource): OpsCrewError {
    return new OpsCrewError("INVALID_INPUT", `There is no ${described(source)} on the server.`, {
      hint:
        source.kind === "volume"
          ? "Check the volume's name with `docker volume ls` on the server, then try again."
          : "Check the service's data folder on the server, then try again.",
    });
  }

  /**
   * Creates a carrier for `source` with `mounts` (Docker's `Mounts`, so a folder that isn't there
   * is refused, never created) and `cmd`, pulling the image when the host lacks it.
   */
  async function create(
    source: CarrierSource,
    mounts: MountSpec[],
    cmd?: string[],
  ): Promise<string> {
    const spec = {
      image,
      ...(cmd === undefined ? {} : { cmd }),
      labels: { [CARRIER_LABEL]: located(source) },
      mounts,
      network: "none",
    };
    const attempt = () =>
      docker.createContainer(spec).catch((error: unknown) => {
        // Docker's refusal of a missing folder, or of the parent the link check mounts.
        const absent = /bind source path does not exist/.test(errorMessage(error));
        throw error instanceof DockerApiError && absent ? missing(source) : error;
      });
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 404)) throw error;
      await docker.pullImage(image);
      return attempt();
    }
  }

  /** Runs `use` with a new carrier, then removes it; a failure of `use` wins over the removal's. */
  async function withCarrier<T>(
    source: CarrierSource,
    mounts: MountSpec[],
    cmd: string[],
    use: (id: string) => Promise<T>,
  ): Promise<T> {
    const id = await create(source, mounts, cmd);
    let result: T;
    try {
      result = await use(id);
    } catch (error) {
      await docker.removeContainer(id).catch(() => {});
      throw error;
    }
    await docker.removeContainer(id);
    return result;
  }

  /** Starts carrier `id`, waits for it, and returns its exit code and output. */
  async function finish(id: string) {
    await docker.startContainer(id);
    const exitCode = await docker.waitContainer(id);
    return { exitCode, ...(await docker.containerLogs(id)) };
  }

  function failed(act: string, source: CarrierSource, exitCode: number, stderr: string) {
    const said = stderr.trim().split("\n").at(-1)?.trim();
    return new OpsCrewError(
      "PROVIDER_ERROR",
      `The carrier container could not ${act} ${described(source)} (exit code ${exitCode}${said ? `: ${said}` : ""}).`,
      { hint: "Check the volume or folder and the server's disk, then try again." },
    );
  }

  /** {@link finish}, failing plainly unless the carrier exits 0; returns its stdout. */
  async function succeed(id: string, act: string, source: CarrierSource): Promise<string> {
    const { exitCode, stdout, stderr } = await finish(id);
    if (exitCode !== 0) throw failed(act, source, exitCode, stderr);
    return stdout;
  }

  /** The number the carrier printed first, or a plain failure saying it printed no `what`. */
  function printed(pattern: RegExp, stdout: string, what: string, source: CarrierSource) {
    const value = pattern.exec(stdout)?.[1];
    if (value === undefined) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The carrier container did not print ${what} of ${described(source)}.`,
        { hint: "Check that the carrier image is the one OpsCrew pins, then try again." },
      );
    }
    return value;
  }

  /**
   * Refuses a source a carrier must not mount, before anything is touched: a missing volume (a
   * mount would create it, empty), and a folder outside the rules or that is a symbolic link. A
   * missing folder is refused by Docker when the carrier is created.
   */
  async function check(source: CarrierSource): Promise<void> {
    if (source.kind === "volume") {
      if (!(await docker.volumeExists(source.name))) throw missing(source);
      return;
    }
    checkFolder(source.path, allowedRoots);
    // Docker follows a link in a bind's source, so a linked folder would be read, emptied and
    // written wherever it points; no bind option refuses one. A carrier with the parent mounted
    // read-only looks at the folder itself (`test ! -L` exits 1 for a link).
    const parent: MountSpec = {
      type: "bind",
      source: path.posix.dirname(source.path),
      target: PARENT_MOUNT,
      readOnly: true,
    };
    const look = ["test", "!", "-L", `${PARENT_MOUNT}/${path.posix.basename(source.path)}`];
    const { exitCode, stderr } = await withCarrier(source, [parent], look, finish);
    if (exitCode === 1) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The folder ${source.path} on the server is a symbolic link, which OpsCrew doesn't follow.`,
        { hint: "Bind the service to the folder the link points to, then try again." },
      );
    }
    if (exitCode !== 0) throw failed("look at", source, exitCode, stderr);
  }

  return {
    async readVolume(source) {
      await check(source);
      const id = await create(source, [mounted(source, true)]);
      let archive: Readable;
      try {
        archive = await docker.getArchive(id, MOUNT);
      } catch (error) {
        await docker.removeContainer(id).catch(() => {});
        throw error;
      }
      let removal: Promise<void> | undefined;
      const remove = () => {
        removal ??= docker.removeContainer(id);
        return removal;
      };
      const out = new Transform({
        transform: (chunk, _encoding, callback) => callback(null, chunk),
        // The stream ends once the carrier is gone; a removal that fails fails the stream.
        flush: (callback) => {
          remove().then(() => callback(), callback);
        },
        // Destroyed early, the stream closes once the removal settled. A carrier it couldn't
        // remove is left for sweepCarriers.
        destroy: (error, callback) => {
          archive.destroy();
          remove().then(
            () => callback(error),
            () => callback(error),
          );
        },
      });
      archive.on("error", (error) => {
        out.destroy(
          new OpsCrewError(
            "PROVIDER_ERROR",
            `Reading ${described(source)} broke off: ${errorMessage(error).replace(/\.$/, "")}.`,
            { hint: "Check the connection to the server, then try again." },
          ),
        );
      });
      return archive.pipe(out);
    },

    async writeVolume(source, archive) {
      // The archive's failure surfaces through the upload, or is outrun by an earlier one; this
      // keeps one that comes while the source is being emptied from going unhandled.
      archive.on("error", () => {});
      try {
        await check(source);
        const empty = ["find", MOUNT, "-mindepth", "1", "-delete"];
        await withCarrier(source, [mounted(source, false)], empty, async (id) => {
          await succeed(id, "empty", source);
          await docker.putArchive(id, "/", archive);
        });
      } catch (error) {
        // A read carrier's archive closes once its carrier is removed: wait for that, so the
        // source's connection can be closed right after.
        if (!archive.closed) {
          const closed = new Promise((resolve) => archive.once("close", resolve));
          archive.destroy();
          await closed;
        }
        throw error;
      }
    },

    async volumeDigest(source) {
      await check(source);
      const stdout = await withCarrier(
        source,
        [mounted(source, true)],
        ["sh", "-c", DIGEST_SCRIPT],
        (id) => succeed(id, "hash", source),
      );
      return printed(/^([0-9a-f]{64})\s/, stdout, "a hash", source);
    },

    async sourceSize(source) {
      if (source.kind === "volume") {
        const bytes = (await docker.volumeSizes()).get(source.name);
        if (bytes !== undefined) return bytes;
      }
      // A folder, or a volume whose size Docker can't tell (another volume driver's).
      await check(source);
      const stdout = await withCarrier(
        source,
        [mounted(source, true)],
        ["du", "-sb", MOUNT],
        (id) => succeed(id, "measure", source),
      );
      return Number(printed(/^(\d+)\s/, stdout, "a size", source));
    },
  };
}
