import { type Readable, Transform } from "node:stream";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import { DockerApiError, type DockerClient } from "./client";

/** Where a carrier mounts its volume; a volume's archive holds its files under `data/`. */
const MOUNT = "/data";

/** The label on every carrier container, with its volume's name as the value. */
const CARRIER_LABEL = "opscrew.carrier";

/**
 * Hashes the volume at {@link MOUNT}: each path's type, mode, owner, group and link target, the
 * size of everything but folders (a folder's size depends on the file system, not its content),
 * and each file's SHA-256, sorted and reduced to one SHA-256.
 */
const DIGEST_SCRIPT = `set -e
cd ${MOUNT}
find . -type d -exec stat -c '%F %a %u %g %N' {} + > /tmp/listing
find . ! -type d -exec stat -c '%F %a %u %g %s %N' {} + >> /tmp/listing
find . -type f -exec sha256sum {} + >> /tmp/listing
sort /tmp/listing | sha256sum`;

/**
 * Removes the carriers left behind for `volumes` on `docker`'s host, such as after a lost
 * connection. Call it before removing those volumes: Docker refuses to remove a volume in use.
 * Other volumes' carriers, which may belong to another app's move, stay.
 */
export async function sweepCarriers(docker: DockerClient, volumes: readonly string[]) {
  for (const volume of volumes) {
    for (const carrier of await docker.listContainers([`${CARRIER_LABEL}=${volume}`])) {
      await docker.removeContainer(carrier.id);
    }
  }
}

/** Reads, writes and hashes Docker volumes through short-lived carrier containers. */
export interface VolumeCarrier {
  /**
   * The volume as a tar stream, its files under `data/`, from a carrier that is created with the
   * volume mounted read-only and never started. The carrier is removed before the stream ends,
   * or before it closes when it is destroyed early.
   */
  readVolume(volume: string): Promise<Readable>;
  /**
   * Replaces the volume's content with `archive` (as {@link readVolume} streams it): a carrier
   * empties the volume and exits, then the archive is unpacked into the stopped carrier, owners
   * and modes kept. On failure `archive` is destroyed, and the call settles once it has closed.
   */
  writeVolume(volume: string, archive: Readable): Promise<void>;
  /** One SHA-256 (hex) over the volume's paths, types, modes, owners, sizes and contents. */
  volumeDigest(volume: string): Promise<string>;
}

/**
 * The carrier operations on `docker`'s host, with `image` as the carrier (a pinned busybox,
 * pulled when the host lacks it). Each operation refuses a volume that doesn't exist, and removes
 * its carrier, also when it fails.
 */
export function volumeCarrier(docker: DockerClient, image: string): VolumeCarrier {
  async function create(volume: string, readOnly: boolean, cmd?: string[]): Promise<string> {
    // A bind of a missing volume would create it, empty.
    if (!(await docker.volumeExists(volume))) {
      throw new OpsCrewError("INVALID_INPUT", `There is no volume ${volume} on the server.`, {
        hint: "Check the volume's name with `docker volume ls` on the server, then try again.",
      });
    }
    const spec = {
      image,
      ...(cmd === undefined ? {} : { cmd }),
      labels: { [CARRIER_LABEL]: volume },
      binds: [`${volume}:${MOUNT}${readOnly ? ":ro" : ""}`],
      network: "none",
    };
    try {
      return await docker.createContainer(spec);
    } catch (error) {
      if (!(error instanceof DockerApiError && error.status === 404)) throw error;
      await docker.pullImage(image);
      return docker.createContainer(spec);
    }
  }

  /** Runs `use` with a new carrier, then removes it; a failure of `use` wins over the removal's. */
  async function withCarrier<T>(
    volume: string,
    readOnly: boolean,
    cmd: string[],
    use: (id: string) => Promise<T>,
  ): Promise<T> {
    const id = await create(volume, readOnly, cmd);
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

  /** Starts carrier `id`, waits for it and returns its stdout; a failure says it could not `act`. */
  async function run(id: string, act: string, volume: string): Promise<string> {
    await docker.startContainer(id);
    const exitCode = await docker.waitContainer(id);
    const logs = await docker.containerLogs(id);
    if (exitCode !== 0) {
      const said = logs.stderr.trim().split("\n").at(-1)?.trim();
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `The carrier container could not ${act} volume ${volume} (exit code ${exitCode}${said ? `: ${said}` : ""}).`,
        { hint: "Check the volume and the server's disk, then try again." },
      );
    }
    return logs.stdout;
  }

  return {
    async readVolume(volume) {
      const id = await create(volume, true);
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
            `Reading volume ${volume} broke off: ${errorMessage(error).replace(/\.$/, "")}.`,
            { hint: "Check the connection to the server, then try again." },
          ),
        );
      });
      return archive.pipe(out);
    },

    async writeVolume(volume, archive) {
      // The archive's failure surfaces through the upload, or is outrun by an earlier one; this
      // keeps one that comes while the volume is being emptied from going unhandled.
      archive.on("error", () => {});
      try {
        await withCarrier(
          volume,
          false,
          ["find", MOUNT, "-mindepth", "1", "-delete"],
          async (id) => {
            await run(id, "empty", volume);
            await docker.putArchive(id, "/", archive);
          },
        );
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

    async volumeDigest(volume) {
      const stdout = await withCarrier(volume, true, ["sh", "-c", DIGEST_SCRIPT], (id) =>
        run(id, "hash", volume),
      );
      const digest = /^([0-9a-f]{64})\s/.exec(stdout)?.[1];
      if (digest === undefined) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `The carrier container did not print a hash of volume ${volume}.`,
          { hint: "Check that the carrier image is the one OpsCrew pins, then try again." },
        );
      }
      return digest;
    },
  };
}
