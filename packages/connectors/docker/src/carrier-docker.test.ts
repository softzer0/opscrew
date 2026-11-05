/**
 * The carrier against the local Docker, through `docker system dial-stdio` processes that core's
 * `NodeStreamRunner` starts: a volume of a few MB with owners, modes and a link is read, written
 * into a second volume that held other files, and the two digests match; the same for a folder
 * bound from the Docker host, and for a volume written into that folder. It pulls the pinned
 * busybox, so it runs only with OPSCREW_DOCKER_TESTS=1, and removes what it made (the image too,
 * when it wasn't there before).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { NodeStreamRunner } from "@opscrew/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  const run = randomBytes(4).toString("hex");
  const runner = new NodeStreamRunner();
  const transports = [1, 2].map(() =>
    dialStdioTransport(() => runner.open("docker", ["system", "dial-stdio"])),
  );
  const [here, there] = transports.map(dockerClient) as [DockerClient, DockerClient];
  const helpers: string[] = [];
  let hadImage = false;

  /** Runs `script` in a busybox with `bind`, and fails with its output if it fails. */
  async function shell(bind: string, script: string): Promise<void> {
    const id = await here.createContainer({
      image: BUSYBOX,
      cmd: ["sh", "-c", script],
      binds: [bind],
      labels: { "opscrew.test": run },
      network: "none",
    });
    helpers.push(id);
    await here.startContainer(id);
    const exitCode = await here.waitContainer(id);
    expect({ exitCode, logs: await here.containerLogs(id) }).toMatchObject({ exitCode: 0 });
    await here.removeContainer(id);
  }

  beforeAll(async () => {
    hadImage = spawnSync("docker", ["image", "inspect", BUSYBOX_BY_DIGEST]).status === 0;
    await here.pullImage(BUSYBOX);
  }, 120_000);

  afterAll(async () => {
    for (const id of helpers) await here.removeContainer(id).catch(() => {});
    for (const transport of transports) await transport.close?.();
    if (!hadImage) spawnSync("docker", ["image", "rm", BUSYBOX_BY_DIGEST]);
  }, 60_000);

  it("copies a volume with owners, modes and a link into another, and the digests match", async () => {
    const source = { kind: "volume", name: `opscrew-test-${run}-source` } as const;
    const target = { kind: "volume", name: `opscrew-test-${run}-target` } as const;
    try {
      for (const { name } of [source, target])
        await here.createVolume(name, { "opscrew.test": run });
      await shell(`${source.name}:/data`, SEED);
      await shell(`${target.name}:/data`, STALE);

      const reader = volumeCarrier(here, BUSYBOX);
      const writer = volumeCarrier(there, BUSYBOX);
      const digest = await reader.volumeDigest(source);
      expect(await writer.volumeDigest(target)).not.toBe(digest);

      const started = Date.now();
      await writer.writeVolume(target, await reader.readVolume(source));
      const copied = await writer.volumeDigest(target);
      console.info(
        `[connector-docker] copied volume ${source.name} in ${Date.now() - started} ms; digests ${digest} and ${copied}`,
      );
      expect(copied).toBe(digest);

      expect((await here.listVolumes([`opscrew.test=${run}`])).map((v) => v.name).sort()).toEqual(
        [source.name, target.name].sort(),
      );
      expect(await reader.sourceSize(source)).toBeGreaterThan(4 * 1024 * 1024);
      for (const { name } of [source, target]) {
        expect(await here.listContainers([`opscrew.carrier=${name}`])).toEqual([]);
      }

      await shell(`${target.name}:/data`, "chmod 644 /data/app/cache/blob");
      expect(await writer.volumeDigest(target)).not.toBe(digest);
    } finally {
      for (const { name } of [source, target]) await here.removeVolume(name).catch(() => {});
    }
  }, 300_000);

  it("copies a folder bound from the host into another, and a volume into it, and the digests match", async () => {
    // The folders are on the Docker host (with Docker Desktop, in its Linux VM), so busybox
    // containers with the host's /tmp bound in make and remove them.
    const base = `opscrew-carrier-test-${run}`;
    const root = `/tmp/${base}/`;
    const source = { kind: "bind", path: `${root}source` } as const;
    const target = { kind: "bind", path: `${root}target` } as const;
    const volume = { kind: "volume", name: `opscrew-test-${run}-volume` } as const;
    try {
      await shell("/tmp:/host-tmp", `mkdir -p /host-tmp/${base}/source /host-tmp/${base}/target`);
      await shell(`${source.path}:/data`, SEED);
      await shell(`${target.path}:/data`, STALE);

      const reader = volumeCarrier(here, BUSYBOX, [root]);
      const writer = volumeCarrier(there, BUSYBOX, [root]);
      const digest = await reader.volumeDigest(source);
      expect(await writer.volumeDigest(target)).not.toBe(digest);

      const started = Date.now();
      await writer.writeVolume(target, await reader.readVolume(source));
      const copied = await writer.volumeDigest(target);
      console.info(
        `[connector-docker] copied folder ${source.path} in ${Date.now() - started} ms; digests ${digest} and ${copied}`,
      );
      expect(copied).toBe(digest);
      expect(await reader.sourceSize(source)).toBeGreaterThan(4 * 1024 * 1024);

      await here.createVolume(volume.name, { "opscrew.test": run });
      await shell(`${volume.name}:/data`, SEED);
      await writer.writeVolume(target, await reader.readVolume(volume));
      expect(await writer.volumeDigest(target)).toBe(await reader.volumeDigest(volume));

      const missing = { kind: "bind", path: `${root}missing` } as const;
      await expect(reader.readVolume(missing)).rejects.toThrow(
        `There is no folder ${missing.path} on the server.`,
      );
      await shell("/tmp:/host-tmp", `test ! -e /host-tmp/${base}/missing`);

      const link = { kind: "bind", path: `${root}link` } as const;
      await shell("/tmp:/host-tmp", `ln -s source /host-tmp/${base}/link`);
      await expect(writer.writeVolume(link, await reader.readVolume(source))).rejects.toThrow(
        `The folder ${link.path} on the server is a symbolic link, which OpsCrew doesn't follow.`,
      );
      expect(await reader.volumeDigest(source)).toBe(digest);
      for (const { path } of [source, target, missing, link]) {
        expect(await here.listContainers([`opscrew.carrier=${path}`])).toEqual([]);
      }
    } finally {
      await shell("/tmp:/host-tmp", `rm -rf /host-tmp/${base}`).catch(() => {});
      await here.removeVolume(volume.name).catch(() => {});
    }
  }, 300_000);
});
