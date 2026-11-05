/**
 * The carrier against the local Docker, through `docker system dial-stdio` processes that core's
 * `NodeStreamRunner` starts: a volume of a few MB with owners, modes and a link is read, written
 * into a second volume that held other files, and the two digests match. It pulls the pinned
 * busybox, so it runs only with OPSCREW_DOCKER_TESTS=1, and removes what it made (the image too,
 * when it wasn't there before).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { NodeStreamRunner } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { volumeCarrier } from "./carrier";
import { type DockerClient, dockerClient } from "./client";
import { dialStdioTransport } from "./dial-stdio";

/** `IMAGES.busybox` in iac-templates' pins (this package doesn't depend on iac-templates). */
const BUSYBOX =
  "busybox:1.38.0@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4";
const BUSYBOX_BY_DIGEST = BUSYBOX.replace(/:[^:@]+@/, "@");

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[connector-docker] skipping the carrier against Docker: ${reason}`);

const SEED = `set -e
dd if=/dev/urandom of=/data/big.bin bs=1048576 count=4 2>/dev/null
mkdir -p /data/app/cache
echo "port=8080" > /data/app/config.txt
head -c 200000 /dev/urandom > /data/app/cache/blob
chown -R 1000:1001 /data/app
chmod 640 /data/app/config.txt
chown 999:999 /data/app/cache/blob
chmod 600 /data/app/cache/blob
ln -s app/config.txt /data/link
chown -h 1000:1000 /data/link
chmod 750 /data`;

const STALE = `set -e
echo old > /data/stale.txt
mkdir /data/old
chmod 700 /data`;

describe.skipIf(reason !== undefined)("the carrier against the local Docker", () => {
  it("copies a volume with owners, modes and a link into another, and the digests match", async () => {
    const run = randomBytes(4).toString("hex");
    const source = `opscrew-test-${run}-source`;
    const target = `opscrew-test-${run}-target`;
    const hadImage = spawnSync("docker", ["image", "inspect", BUSYBOX_BY_DIGEST]).status === 0;
    const runner = new NodeStreamRunner();
    const transports = [1, 2].map(() =>
      dialStdioTransport(() => runner.open("docker", ["system", "dial-stdio"])),
    );
    const [here, there] = transports.map(dockerClient) as [DockerClient, DockerClient];
    const helpers: string[] = [];

    /** Runs `script` in a busybox with `volume` at /data, and fails with its output if it fails. */
    async function shell(volume: string, script: string): Promise<void> {
      const id = await here.createContainer({
        image: BUSYBOX,
        cmd: ["sh", "-c", script],
        binds: [`${volume}:/data`],
        labels: { "opscrew.test": run },
        network: "none",
      });
      helpers.push(id);
      await here.startContainer(id);
      const exitCode = await here.waitContainer(id);
      expect({ exitCode, logs: await here.containerLogs(id) }).toMatchObject({ exitCode: 0 });
      await here.removeContainer(id);
    }

    try {
      await here.pullImage(BUSYBOX);
      for (const name of [source, target]) await here.createVolume(name, { "opscrew.test": run });
      await shell(source, SEED);
      await shell(target, STALE);

      const reader = volumeCarrier(here, BUSYBOX);
      const writer = volumeCarrier(there, BUSYBOX);
      const digest = await reader.volumeDigest(source);
      expect(await writer.volumeDigest(target)).not.toBe(digest);

      const started = Date.now();
      await writer.writeVolume(target, await reader.readVolume(source));
      const copied = await writer.volumeDigest(target);
      console.info(
        `[connector-docker] copied ${source} in ${Date.now() - started} ms; digests ${digest} and ${copied}`,
      );
      expect(copied).toBe(digest);

      expect((await here.listVolumes([`opscrew.test=${run}`])).map((v) => v.name).sort()).toEqual(
        [source, target].sort(),
      );
      expect((await here.volumeSizes()).get(source)).toBeGreaterThan(4 * 1024 * 1024);
      for (const volume of [source, target]) {
        expect(await here.listContainers([`opscrew.carrier=${volume}`])).toEqual([]);
      }

      await shell(target, "chmod 644 /data/app/cache/blob");
      expect(await writer.volumeDigest(target)).not.toBe(digest);
    } finally {
      for (const id of helpers) await here.removeContainer(id).catch(() => {});
      for (const name of [source, target]) await here.removeVolume(name).catch(() => {});
      for (const transport of transports) await transport.close?.();
      if (!hadImage) spawnSync("docker", ["image", "rm", BUSYBOX_BY_DIGEST]);
    }
  }, 300_000);
});
