import { once } from "node:events";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { DockerTransport } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { type CarrierSource, sweepCarriers, volumeCarrier } from "./carrier";
import { dockerClient } from "./client";
import { tarStream } from "./tar";
import { FakeDocker, type FakeFile } from "./testing/fake-docker";
import { parseTar } from "./testing/tar";

const IMAGE = "busybox:1.38.0@sha256:0000";
const ROOTS = ["/srv/data/"];

const FILES: Record<string, FakeFile> = {
  "": { type: "dir", mode: 0o750, uid: 0, gid: 0 },
  app: { type: "dir", mode: 0o755, uid: 1000, gid: 1001 },
  "app/config.txt": { type: "file", mode: 0o640, uid: 1000, gid: 1001, data: Buffer.from("a=1") },
  "app/blob": { type: "file", mode: 0o600, uid: 999, gid: 999, data: Buffer.alloc(70_000, 7) },
  link: { type: "symlink", mode: 0o777, uid: 0, gid: 0, target: "app/config.txt" },
};

const volume = (name: string): CarrierSource => ({ kind: "volume", name });
const folder = (path: string): CarrierSource => ({ kind: "bind", path });
const DATA = volume("example-app_data");
const PG_PATH = "/srv/data/example-app/postgres";
const PG = folder(PG_PATH);

/** A fake Docker that has the carrier image, with the volume `name` holding {@link FILES}. */
function host(name = "example-app_data") {
  const fake = new FakeDocker();
  fake.images.add(IMAGE);
  fake.addVolume(name, FILES);
  return { fake, carrier: volumeCarrier(dockerClient(fake), IMAGE, ROOTS) };
}

/** A fake Docker whose folder {@link PG_PATH} holds `files`, its parent there too. */
function folderHost(files: Record<string, FakeFile> = FILES) {
  const { fake, carrier } = host();
  fake.addFolder("/srv/data/example-app");
  fake.addFolder(PG_PATH, files);
  return { fake, carrier };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Each carrier container's command and mounts (`source:target`, `:ro` if read-only), as it starts. */
function started(fake: FakeDocker): string[][] {
  const seen: string[][] = [];
  fake.onStart = (container) => {
    const mounts = container.mounts.map(
      (mount) => `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`,
    );
    seen.push([...container.cmd, ...mounts]);
    return undefined;
  };
  return seen;
}

describe("volumeCarrier.readVolume", () => {
  it("streams the volume from a carrier that never starts, mounted read-only, then removes it", async () => {
    const { fake, carrier } = host();
    const archive = await carrier.readVolume(DATA);
    const [created] = fake.containers.values();
    expect(created).toMatchObject({
      image: IMAGE,
      mounts: [{ type: "volume", source: "example-app_data", target: "/data", readOnly: true }],
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
    const archive = await carrier.readVolume(DATA);
    const closed = once(archive, "close");
    archive.destroy();
    await closed;
    expect(fake.containers.size).toBe(0);
  });

  it("fails plainly when the archive breaks off halfway, and removes the carrier", async () => {
    const { fake, carrier } = host();
    fake.breakNextArchive("read ECONNRESET");
    const archive = await carrier.readVolume(DATA);
    const closed = new Promise((resolve) => archive.once("close", resolve));
    await expect(readAll(archive)).rejects.toThrow(
      "Reading volume example-app_data broke off: read ECONNRESET.",
    );
    await closed;
    expect(fake.containers.size).toBe(0);
  });

  it("refuses a volume that doesn't exist, creating nothing", async () => {
    const { fake, carrier } = host();
    const missing = volume("example-app_cache");
    const error = await carrier.readVolume(missing).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: "There is no volume example-app_cache on the server.",
    });
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has("example-app_cache")).toBe(false);
    await expect(carrier.volumeDigest(missing)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(carrier.sourceSize(missing)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const source = tarStream([]);
    await expect(carrier.writeVolume(missing, source)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(source.destroyed).toBe(true);
    expect(fake.calls.filter((call) => call.startsWith("POST /containers"))).toEqual([]);
    expect(fake.volumes.has("example-app_cache")).toBe(false);
  });

  it("removes the carrier when Docker refuses the archive", async () => {
    const { fake, carrier } = host();
    fake.fail("GET", /\/archive/, 500, "the disk is gone");
    await expect(carrier.readVolume(DATA)).rejects.toThrow(
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
    await target.carrier.writeVolume(DATA, await source.carrier.readVolume(DATA));
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
    const seen = started(fake);
    await carrier.writeVolume(DATA, tarStream([]));
    expect(seen).toEqual([
      ["find", "/data", "-mindepth", "1", "-delete", "example-app_data:/data"],
    ]);
  });

  it("writes nothing when emptying fails, and removes the carrier and the source's stream", async () => {
    const { fake, carrier } = host();
    fake.onStart = () => ({ exitCode: 1, stderr: "find: /data/app: Permission denied\n" });
    const source = tarStream([]);
    const error = await carrier.writeVolume(DATA, source).catch((e: unknown) => e);
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
      target.carrier.writeVolume(DATA, await source.carrier.readVolume(DATA)),
    ).rejects.toThrow(/no space left on device/);
    expect(target.fake.containers.size).toBe(0);
    expect(source.fake.containers.size).toBe(0);
  });

  it("passes on the source's failure halfway through the upload, with both carriers removed", async () => {
    const source = host();
    const target = host();
    source.fake.breakNextArchive("read ECONNRESET");
    await expect(
      target.carrier.writeVolume(DATA, await source.carrier.readVolume(DATA)),
    ).rejects.toThrow("Reading volume example-app_data broke off: read ECONNRESET.");
    expect(target.fake.containers.size).toBe(0);
    expect(source.fake.containers.size).toBe(0);
  });
});

describe("volumeCarrier.volumeDigest", () => {
  it("hashes the volume in a read-only carrier, and the same content hashes the same", async () => {
    const a = host();
    const b = host("example-copy");
    const seen = started(a.fake);
    const digest = await a.carrier.volumeDigest(DATA);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await b.carrier.volumeDigest(volume("example-copy"))).toBe(digest);
    expect(seen[0]?.at(-1)).toBe("example-app_data:/data:ro");
    expect(seen[0]?.join(" ")).toMatch(
      /^sh -c .*stat -c '%F %a %u %g %s %N'.*sha256sum.*\| sha256sum/s,
    );
    expect(a.fake.containers.size).toBe(0);

    const blob = b.fake.volumes.get("example-copy")?.files.get("app/blob");
    if (blob === undefined) throw new Error("no blob");
    blob.mode = 0o644;
    expect(await b.carrier.volumeDigest(volume("example-copy"))).not.toBe(digest);
  });

  it("fails plainly when the carrier fails or prints no hash, and removes it", async () => {
    const { fake, carrier } = host();
    fake.onStart = () => ({ exitCode: 2, stderr: "sha256sum: ./x: I/O error\n" });
    await expect(carrier.volumeDigest(DATA)).rejects.toThrow(
      "The carrier container could not hash volume example-app_data (exit code 2: sha256sum: ./x: I/O error).",
    );
    fake.onStart = () => ({ exitCode: 0, stdout: "nothing here\n" });
    await expect(carrier.volumeDigest(DATA)).rejects.toThrow(/did not print a hash/);
    expect(fake.containers.size).toBe(0);
  });

  it("fails when the carrier can't be removed after it succeeded", async () => {
    const { fake, carrier } = host();
    fake.fail("DELETE", /\/containers\//, 500, "device or resource busy");
    await expect(carrier.volumeDigest(DATA)).rejects.toThrow(
      /^Docker could not remove container 0+\w*: device or resource busy\.$/,
    );
    await sweepCarriers(dockerClient(fake), [DATA]);
    expect(fake.containers.size).toBe(0);
  });
});

describe("volumeCarrier.sourceSize", () => {
  it("reads a volume's size from Docker, with no carrier", async () => {
    const { fake, carrier } = host();
    expect(await carrier.sourceSize(DATA)).toBe(70_003);
    expect(fake.calls).toEqual(["GET /system/df?type=volume"]);
  });

  it("measures a folder, or a volume whose size Docker can't tell, with `du -sb`", async () => {
    const { fake, carrier } = folderHost();
    const seen = started(fake);
    expect(await carrier.sourceSize(PG)).toBe(70_003);
    expect(seen.at(-1)).toEqual(["du", "-sb", "/data", `${PG_PATH}:/data:ro`]);
    expect(fake.containers.size).toBe(0);

    const unknownSize: DockerTransport = {
      request: async (request) =>
        request.path.startsWith("/system/df")
          ? {
              status: 200,
              headers: {},
              body: Readable.from([
                JSON.stringify({
                  Volumes: [{ Name: "example-app_data", UsageData: { Size: -1 } }],
                }),
              ]),
            }
          : fake.request(request),
    };
    expect(await volumeCarrier(dockerClient(unknownSize), IMAGE).sourceSize(DATA)).toBe(70_003);
    expect(seen.at(-1)).toEqual(["du", "-sb", "/data", "example-app_data:/data:ro"]);
  });
});

describe("volumeCarrier: bound folders", () => {
  it("refuses a folder that isn't a plain absolute path under the allowed roots, before any call", async () => {
    const fake = new FakeDocker();
    const docker = dockerClient(fake);
    const carriers = [
      volumeCarrier(docker, IMAGE, ROOTS),
      volumeCarrier(docker, IMAGE, ["/srv/data"]),
    ];
    const paths = [
      "srv/data/example-app/postgres",
      "/srv/data/example-app/../../../etc",
      "/srv/data/./example-app",
      "/srv/data//example-app",
      "/srv/data/example-app/",
      "/srv/data/example-app:/etc",
      "/srv/data",
      "/srv/database/example-app",
      "/etc/example-app",
    ];
    for (const carrier of carriers) {
      for (const path of paths) {
        for (const attempt of [
          () => carrier.readVolume(folder(path)),
          () => carrier.volumeDigest(folder(path)),
          () => carrier.sourceSize(folder(path)),
          () => carrier.writeVolume(folder(path), tarStream([])),
        ]) {
          await expect(attempt(), path).rejects.toMatchObject({ code: "INVALID_INPUT" });
        }
      }
    }
    await expect(volumeCarrier(docker, IMAGE).readVolume(PG)).rejects.toThrow(
      `The folder ${PG_PATH} is outside the folders OpsCrew may copy here.`,
    );
    await expect(carriers[0]?.readVolume(folder("/etc/example-app"))).rejects.toThrow(
      "The folder /etc/example-app is outside the folders OpsCrew may copy here (/srv/data/).",
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses a missing folder, or a missing parent, as Docker does, creating nothing", async () => {
    const { fake, carrier } = host();
    fake.addFolder("/srv/data/example-app");
    const seen = started(fake);
    const error = await carrier.readVolume(PG).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: `There is no folder ${PG_PATH} on the server.`,
    });
    // Only the symbolic link check ran, with the parent mounted read-only.
    expect(seen).toEqual([
      ["test", "!", "-L", "/parent/postgres", "/srv/data/example-app:/parent:ro"],
    ]);
    expect(fake.folders.has(PG_PATH)).toBe(false);
    expect(fake.containers.size).toBe(0);
    const source = tarStream([]);
    await expect(carrier.writeVolume(PG, source)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(source.destroyed).toBe(true);
    expect(seen.some(([program]) => program === "find")).toBe(false);

    const bare = host();
    await expect(bare.carrier.volumeDigest(PG)).rejects.toThrow(
      `There is no folder ${PG_PATH} on the server.`,
    );
    expect([...bare.fake.folders.keys()]).toEqual([]);
    expect(bare.fake.containers.size).toBe(0);
  });

  it("refuses a folder that is a symbolic link, touching nothing", async () => {
    const { fake, carrier } = folderHost();
    fake.symlinks.add(PG_PATH);
    const seen = started(fake);
    for (const attempt of [
      () => carrier.readVolume(PG),
      () => carrier.volumeDigest(PG),
      () => carrier.sourceSize(PG),
      () => carrier.writeVolume(PG, tarStream([])),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: `The folder ${PG_PATH} on the server is a symbolic link, which OpsCrew doesn't follow.`,
      });
    }
    expect(seen.every(([program]) => program === "test")).toBe(true);
    expect(Object.fromEntries(fake.folders.get(PG_PATH)?.files ?? [])).toEqual(FILES);
    expect(fake.containers.size).toBe(0);
  });

  it("mounts volumes and folders through Docker's Mounts, never as Binds", async () => {
    const { fake, carrier } = folderHost();
    const mounts: unknown[] = [];
    fake.onStart = (container) => {
      expect(container.binds).toEqual([]);
      mounts.push(...container.mounts);
      return undefined;
    };
    await carrier.volumeDigest(PG);
    await carrier.volumeDigest(DATA);
    expect(mounts).toEqual([
      { type: "bind", source: "/srv/data/example-app", target: "/parent", readOnly: true },
      { type: "bind", source: PG_PATH, target: "/data", readOnly: true },
      { type: "volume", source: "example-app_data", target: "/data", readOnly: true },
    ]);
  });

  it("copies a folder into another server's, through binds, and the digests match", async () => {
    const source = folderHost();
    const target = folderHost({
      stale: { type: "file", mode: 0o644, uid: 0, gid: 0, data: Buffer.from("old") },
    });
    const reads = started(source.fake);
    const writes = started(target.fake);
    await target.carrier.writeVolume(PG, await source.carrier.readVolume(PG));
    expect(Object.fromEntries(target.fake.folders.get(PG_PATH)?.files ?? [])).toEqual(FILES);
    expect(await target.carrier.volumeDigest(PG)).toBe(await source.carrier.volumeDigest(PG));
    expect(source.fake.containers.size + target.fake.containers.size).toBe(0);
    expect(
      [...source.fake.calls].filter((call) => call.startsWith("POST /containers/create")),
    ).toHaveLength(4);
    expect(reads[0]).toEqual([
      "test",
      "!",
      "-L",
      "/parent/postgres",
      "/srv/data/example-app:/parent:ro",
    ]);
    expect(writes[1]).toEqual(["find", "/data", "-mindepth", "1", "-delete", `${PG_PATH}:/data`]);
    expect(reads.at(-1)?.at(-1)).toBe(`${PG_PATH}:/data:ro`);
  });

  it("reads a folder from a carrier with it bound read-only, labelled with its path", async () => {
    const { fake, carrier } = folderHost();
    const archive = await carrier.readVolume(PG);
    expect([...fake.containers.values()][0]).toMatchObject({
      mounts: [{ type: "bind", source: PG_PATH, target: "/data", readOnly: true }],
      labels: { "opscrew.carrier": PG_PATH },
      state: "created",
    });
    archive.resume();
    await finished(archive);
  });

  it("empties a folder but keeps the folder itself, with its owner and mode", async () => {
    const { fake, carrier } = folderHost({
      "": { type: "dir", mode: 0o700, uid: 999, gid: 999 },
      "base/1": { type: "file", mode: 0o600, uid: 999, gid: 999, data: Buffer.from("x") },
    });
    await carrier.writeVolume(PG, tarStream([]));
    expect(Object.fromEntries(fake.folders.get(PG_PATH)?.files ?? [])).toEqual({
      "": { type: "dir", mode: 0o700, uid: 999, gid: 999 },
    });
  });

  it("copies between a volume and a folder, and the digests match", async () => {
    const source = host();
    const target = folderHost({});
    await target.carrier.writeVolume(PG, await source.carrier.readVolume(DATA));
    expect(await target.carrier.volumeDigest(PG)).toBe(await source.carrier.volumeDigest(DATA));
  });

  it("names the folder when the carrier fails", async () => {
    const { fake, carrier } = folderHost();
    fake.onStart = (container) =>
      container.cmd[0] === "find"
        ? { exitCode: 1, stderr: "find: /data/base: Permission denied\n" }
        : undefined;
    await expect(carrier.writeVolume(PG, tarStream([]))).rejects.toThrow(
      `The carrier container could not empty folder ${PG_PATH} (exit code 1: find: /data/base: Permission denied).`,
    );
    expect(fake.containers.size).toBe(0);
  });
});

describe("sweepCarriers", () => {
  it("removes the carriers left for the given volumes and folders, and nothing else", async () => {
    const { fake } = host();
    fake.addVolume("other-app_data");
    fake.addFolder(PG_PATH);
    const docker = dockerClient(fake);
    const carrierOf = (type: "volume" | "bind", source: string) =>
      docker.createContainer({
        image: IMAGE,
        labels: { "opscrew.carrier": source },
        mounts: [{ type, source, target: "/data", readOnly: true }],
      });
    const leftovers = [
      await carrierOf("volume", "example-app_data"),
      await carrierOf("bind", PG_PATH),
    ];
    const otherMove = await carrierOf("volume", "other-app_data");
    const service = await docker.createContainer({
      image: IMAGE,
      mounts: [{ type: "volume", source: "example-app_data", target: "/var/lib/data" }],
    });
    await sweepCarriers(docker, [DATA, PG]);
    expect([...fake.containers.keys()].sort()).toEqual([otherMove, service].sort());
    for (const id of leftovers) expect(fake.containers.has(id)).toBe(false);
  });
});

describe("volumeCarrier: the carrier image", () => {
  it("pulls the image when the host lacks it", async () => {
    const fake = new FakeDocker();
    fake.addVolume("example-app_data", FILES);
    const carrier = volumeCarrier(dockerClient(fake), IMAGE);
    expect(await carrier.volumeDigest(DATA)).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.calls.filter((call) => call.startsWith("POST /images/create"))).toHaveLength(1);
    await carrier.volumeDigest(DATA);
    expect(fake.calls.filter((call) => call.startsWith("POST /images/create"))).toHaveLength(1);
  });

  it("labels each carrier with its volume, so a leftover one can be found", async () => {
    const { fake, carrier } = host();
    const archive = await carrier.readVolume(DATA);
    expect([...fake.containers.values()][0]?.labels).toEqual({
      "opscrew.carrier": "example-app_data",
    });
    archive.resume();
    await finished(archive);
  });
});
