import { once } from "node:events";
import { finished } from "node:stream/promises";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { sweepCarriers, volumeCarrier } from "./carrier";
import { dockerClient } from "./client";
import { FakeDocker, type FakeFile } from "./testing/fake-docker";
import { parseTar, tarStream } from "./testing/tar";

const IMAGE = "busybox:1.38.0@sha256:0000";

const FILES: Record<string, FakeFile> = {
  "": { type: "dir", mode: 0o750, uid: 0, gid: 0 },
  app: { type: "dir", mode: 0o755, uid: 1000, gid: 1001 },
  "app/config.txt": { type: "file", mode: 0o640, uid: 1000, gid: 1001, data: Buffer.from("a=1") },
  "app/blob": { type: "file", mode: 0o600, uid: 999, gid: 999, data: Buffer.alloc(70_000, 7) },
  link: { type: "symlink", mode: 0o777, uid: 0, gid: 0, target: "app/config.txt" },
};

/** A fake Docker that has the carrier image, with `volume` holding {@link FILES}. */
function host(volume = "example-app_data") {
  const fake = new FakeDocker();
  fake.images.add(IMAGE);
  fake.addVolume(volume, FILES);
  return { fake, carrier: volumeCarrier(dockerClient(fake), IMAGE) };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("volumeCarrier.readVolume", () => {
  it("streams the volume from a carrier that never starts, mounted read-only, then removes it", async () => {
    const { fake, carrier } = host();
    const archive = await carrier.readVolume("example-app_data");
    const [created] = fake.containers.values();
    expect(created).toMatchObject({
      image: IMAGE,
      binds: ["example-app_data:/data:ro"],
      network: "none",
      state: "created",
    });
    const entries = parseTar(await readAll(archive));
    expect(entries.map((entry) => entry.name)).toEqual([
      "data/",
      "data/app/",
      "data/app/blob",
      "data/app/config.txt",
      "data/link",
    ]);
    expect(entries[2]).toMatchObject({ mode: 0o600, uid: 999, gid: 999 });
    expect(fake.containers.size).toBe(0);
    expect(fake.calls.some((call) => call.includes("/start"))).toBe(false);
  });

  it("removes the carrier when the reader stops early, and closes only once it is gone", async () => {
    const { fake, carrier } = host();
    const archive = await carrier.readVolume("example-app_data");
    const closed = once(archive, "close");
    archive.destroy();
    await closed;
    expect(fake.containers.size).toBe(0);
  });

  it("fails plainly when the archive breaks off halfway, and removes the carrier", async () => {
    const { fake, carrier } = host();
    fake.breakNextArchive("read ECONNRESET");
    const archive = await carrier.readVolume("example-app_data");
    const closed = new Promise((resolve) => archive.once("close", resolve));
    await expect(readAll(archive)).rejects.toThrow(
      "Reading volume example-app_data broke off: read ECONNRESET.",
    );
    await closed;
    expect(fake.containers.size).toBe(0);
  });

  it("refuses a volume that doesn't exist, creating nothing", async () => {
    const { fake, carrier } = host();
    const error = await carrier.readVolume("example-app_cache").catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: "There is no volume example-app_cache on the server.",
    });
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has("example-app_cache")).toBe(false);
    await expect(carrier.volumeDigest("example-app_cache")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const source = tarStream([]);
    await expect(carrier.writeVolume("example-app_cache", source)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(source.destroyed).toBe(true);
    expect(fake.calls.filter((call) => call.startsWith("POST /containers"))).toEqual([]);
    expect(fake.volumes.has("example-app_cache")).toBe(false);
  });

  it("removes the carrier when Docker refuses the archive", async () => {
    const { fake, carrier } = host();
    fake.fail("GET", /\/archive/, 500, "the disk is gone");
    await expect(carrier.readVolume("example-app_data")).rejects.toThrow(
      /Docker could not read \/data from container .*: the disk is gone\./,
    );
    expect(fake.containers.size).toBe(0);
  });
});

describe("volumeCarrier.writeVolume", () => {
  it("empties the volume, writes the archive into the stopped carrier, then removes it", async () => {
    const source = host();
    const target = host("example-app_data");
    target.fake.addVolume("example-app_data", {
      stale: { type: "file", mode: 0o644, uid: 0, gid: 0, data: Buffer.from("old") },
    });
    await target.carrier.writeVolume(
      "example-app_data",
      await source.carrier.readVolume("example-app_data"),
    );
    const order = target.fake.calls.map((call) => call.replace(/\/containers\/[0-9a-f]{64}/, "/c"));
    expect(order).toEqual([
      "GET /volumes/example-app_data",
      "POST /containers/create",
      "POST /c/start",
      "POST /c/wait",
      "GET /c/logs?stdout=1&stderr=1",
      "PUT /c/archive?path=%2F",
      "DELETE /c?force=1",
    ]);
    const files = target.fake.volumes.get("example-app_data")?.files;
    expect(files?.has("stale")).toBe(false);
    expect(Object.fromEntries(files ?? [])).toEqual(FILES);
    expect(target.fake.containers.size).toBe(0);
    expect(source.fake.containers.size).toBe(0);
  });

  it("runs `find /data -mindepth 1 -delete` in a carrier with the volume mounted read-write", async () => {
    const { fake, carrier } = host();
    const seen: string[][] = [];
    fake.onStart = (container) => {
      seen.push([...container.cmd, ...container.binds]);
      return undefined;
    };
    await carrier.writeVolume("example-app_data", tarStream([]));
    expect(seen).toEqual([
      ["find", "/data", "-mindepth", "1", "-delete", "example-app_data:/data"],
    ]);
  });

  it("writes nothing when emptying fails, and removes the carrier and the source's stream", async () => {
    const { fake, carrier } = host();
    fake.onStart = () => ({ exitCode: 1, stderr: "find: /data/app: Permission denied\n" });
    const source = tarStream([]);
    const error = await carrier.writeVolume("example-app_data", source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "The carrier container could not empty volume example-app_data (exit code 1: find: /data/app: Permission denied).",
    );
    expect(fake.calls.some((call) => call.startsWith("PUT"))).toBe(false);
    expect(fake.containers.size).toBe(0);
    expect(source.destroyed).toBe(true);
  });

  it("removes both carriers before it settles when Docker refuses the archive", async () => {
    const source = host();
    const target = host();
    target.fake.fail("PUT", /\/archive/, 500, "no space left on device");
    await expect(
      target.carrier.writeVolume(
        "example-app_data",
        await source.carrier.readVolume("example-app_data"),
      ),
    ).rejects.toThrow(/no space left on device/);
    expect(target.fake.containers.size).toBe(0);
    expect(source.fake.containers.size).toBe(0);
  });

  it("passes on the source's failure halfway through the upload, with both carriers removed", async () => {
    const source = host();
    const target = host();
    source.fake.breakNextArchive("read ECONNRESET");
    await expect(
      target.carrier.writeVolume(
        "example-app_data",
        await source.carrier.readVolume("example-app_data"),
      ),
    ).rejects.toThrow("Reading volume example-app_data broke off: read ECONNRESET.");
    expect(target.fake.containers.size).toBe(0);
    expect(source.fake.containers.size).toBe(0);
  });
});

describe("volumeCarrier.volumeDigest", () => {
  it("hashes the volume in a read-only carrier, and the same content hashes the same", async () => {
    const a = host();
    const b = host("example-copy");
    const scripts: string[] = [];
    a.fake.onStart = (container) => {
      scripts.push(container.cmd.join(" "));
      expect(container.binds).toEqual(["example-app_data:/data:ro"]);
      return undefined;
    };
    const digest = await a.carrier.volumeDigest("example-app_data");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await b.carrier.volumeDigest("example-copy")).toBe(digest);
    expect(scripts[0]).toMatch(/^sh -c .*stat -c '%F %a %u %g %s %N'.*sha256sum.*\| sha256sum/s);
    expect(a.fake.containers.size).toBe(0);

    const blob = b.fake.volumes.get("example-copy")?.files.get("app/blob");
    if (blob === undefined) throw new Error("no blob");
    blob.mode = 0o644;
    expect(await b.carrier.volumeDigest("example-copy")).not.toBe(digest);
  });

  it("fails plainly when the carrier fails or prints no hash, and removes it", async () => {
    const { fake, carrier } = host();
    fake.onStart = () => ({ exitCode: 2, stderr: "sha256sum: ./x: I/O error\n" });
    await expect(carrier.volumeDigest("example-app_data")).rejects.toThrow(
      "The carrier container could not hash volume example-app_data (exit code 2: sha256sum: ./x: I/O error).",
    );
    fake.onStart = () => ({ exitCode: 0, stdout: "nothing here\n" });
    await expect(carrier.volumeDigest("example-app_data")).rejects.toThrow(/did not print a hash/);
    expect(fake.containers.size).toBe(0);
  });

  it("fails when the carrier can't be removed after it succeeded", async () => {
    const { fake, carrier } = host();
    fake.fail("DELETE", /\/containers\//, 500, "device or resource busy");
    await expect(carrier.volumeDigest("example-app_data")).rejects.toThrow(
      /^Docker could not remove container 0+\w*: device or resource busy\.$/,
    );
    await sweepCarriers(dockerClient(fake), ["example-app_data"]);
    expect(fake.containers.size).toBe(0);
  });
});

describe("sweepCarriers", () => {
  it("removes the carriers left for the given volumes, and nothing else", async () => {
    const { fake } = host();
    fake.addVolume("other-app_data");
    const docker = dockerClient(fake);
    const leftover = await docker.createContainer({
      image: IMAGE,
      labels: { "opscrew.carrier": "example-app_data" },
      binds: ["example-app_data:/data:ro"],
    });
    const otherMove = await docker.createContainer({
      image: IMAGE,
      labels: { "opscrew.carrier": "other-app_data" },
      binds: ["other-app_data:/data:ro"],
    });
    const service = await docker.createContainer({
      image: IMAGE,
      binds: ["example-app_data:/var/lib/data"],
    });
    await sweepCarriers(docker, ["example-app_data"]);
    expect([...fake.containers.keys()].sort()).toEqual([otherMove, service].sort());
    expect(fake.containers.has(leftover)).toBe(false);
  });
});

describe("volumeCarrier: the carrier image", () => {
  it("pulls the image when the host lacks it", async () => {
    const fake = new FakeDocker();
    fake.addVolume("example-app_data", FILES);
    const carrier = volumeCarrier(dockerClient(fake), IMAGE);
    expect(await carrier.volumeDigest("example-app_data")).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.calls.filter((call) => call.startsWith("POST /images/create"))).toHaveLength(1);
    await carrier.volumeDigest("example-app_data");
    expect(fake.calls.filter((call) => call.startsWith("POST /images/create"))).toHaveLength(1);
  });

  it("labels each carrier with its volume, so a leftover one can be found", async () => {
    const { fake, carrier } = host();
    const archive = await carrier.readVolume("example-app_data");
    expect([...fake.containers.values()][0]?.labels).toEqual({
      "opscrew.carrier": "example-app_data",
    });
    archive.resume();
    await finished(archive);
  });
});
