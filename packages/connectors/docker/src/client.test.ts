import { Readable } from "node:stream";
import type { DockerRequest, DockerResponse, DockerTransport } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { DockerApiError, dockerClient } from "./client";
import { tarStream } from "./tar";
import { FakeDocker } from "./testing/fake-docker";
import { parseTar } from "./testing/tar";

const IMAGE = "busybox:test";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** A transport that records each request and answers `status` with `body`. */
function answering(status: number, body: string): DockerTransport & { requests: DockerRequest[] } {
  const requests: DockerRequest[] = [];
  return {
    requests,
    request: async (request): Promise<DockerResponse> => {
      requests.push(request);
      return { status, headers: {}, body: Readable.from([Buffer.from(body)]) };
    },
  };
}

describe("dockerClient: containers", () => {
  it("creates a container with its command, environment, labels, mounts and network", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    const docker = dockerClient(fake);
    const mounts = [
      { type: "volume", source: "example-data", target: "/data", readOnly: true },
    ] as const;
    const id = await docker.createContainer({
      image: IMAGE,
      cmd: ["sh", "-c", "true"],
      env: { MODE: "copy" },
      labels: { "opscrew.test": "1" },
      mounts,
      network: "none",
    });
    expect(fake.containers.get(id)).toMatchObject({
      image: IMAGE,
      cmd: ["sh", "-c", "true"],
      env: ["MODE=copy"],
      labels: { "opscrew.test": "1" },
      mounts,
      network: "none",
    });
  });

  it("mounts through Docker's Mounts, and Docker refuses a bound folder that isn't there", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    fake.addFolder("/srv/data/example-app/postgres");
    const docker = dockerClient(fake);
    const mounts = [
      { type: "volume", source: "example-data", target: "/data", readOnly: true },
      { type: "bind", source: "/srv/data/example-app/postgres", target: "/pg" },
    ] as const;
    const id = await docker.createContainer({ image: IMAGE, mounts });
    expect(fake.containers.get(id)).toMatchObject({ binds: [], mounts });
    expect(fake.volumes.has("example-data")).toBe(true);
    await expect(
      docker.createContainer({
        image: IMAGE,
        mounts: [{ type: "bind", source: "/srv/data/example-app/redis", target: "/data" }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("bind source path does not exist"),
    });
    expect(fake.folders.has("/srv/data/example-app/redis")).toBe(false);
  });

  it("lists containers, running or not, by labels", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    const docker = dockerClient(fake);
    const web = await docker.createContainer({
      image: IMAGE,
      labels: { "com.docker.compose.project": "example-app", "com.docker.compose.service": "web" },
    });
    // Compose names its containers; Docker reports the name.
    Object.assign(fake.containers.get(web) ?? {}, { name: "example-app-web-1" });
    await docker.createContainer({
      image: IMAGE,
      labels: { "com.docker.compose.project": "other" },
    });
    const found = await docker.listContainers(["com.docker.compose.project=example-app"]);
    expect(found).toEqual([
      {
        id: web,
        name: "example-app-web-1",
        image: IMAGE,
        state: "created",
        labels: {
          "com.docker.compose.project": "example-app",
          "com.docker.compose.service": "web",
        },
        mounts: [],
      },
    ]);
    expect(fake.calls.at(-1)).toContain("all=1");
    expect(await docker.listContainers(["com.docker.compose.service"])).toHaveLength(1);
  });

  it("reports each container's mounts: named volumes, bound folders and others", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    fake.addFolder("/srv/data/example-app/postgres");
    const docker = dockerClient(fake);
    await docker.createContainer({
      image: IMAGE,
      labels: { "com.docker.compose.project": "example-app" },
      mounts: [
        { type: "volume", source: "example-app_data", target: "/var/lib/data" },
        {
          type: "bind",
          source: "/srv/data/example-app/postgres",
          target: "/var/lib/postgresql/data",
          readOnly: true,
        },
      ],
    });
    const [container] = await docker.listContainers(["com.docker.compose.project=example-app"]);
    expect(container?.mounts).toEqual([
      {
        type: "volume",
        name: "example-app_data",
        source: "/var/lib/docker/volumes/example-app_data/_data",
        destination: "/var/lib/data",
      },
      {
        type: "bind",
        source: "/srv/data/example-app/postgres",
        destination: "/var/lib/postgresql/data",
      },
    ]);

    const raw = answering(
      200,
      JSON.stringify([
        {
          Id: "abc",
          Names: ["/example-app-web-1"],
          Image: IMAGE,
          State: "running",
          Labels: {},
          Mounts: [{ Type: "tmpfs", Destination: "/run", Mode: "", RW: true }],
        },
        { Id: "def", Names: null, Image: IMAGE, State: "created", Labels: null },
      ]),
    );
    const listed = await dockerClient(raw).listContainers([]);
    expect(listed.map((entry) => entry.mounts)).toEqual([
      [{ type: "tmpfs", source: "", destination: "/run" }],
      [],
    ]);
  });

  it("starts, waits for, reads the logs of and removes a container", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    fake.onStart = () => ({ exitCode: 3, stdout: "out line\n", stderr: "err line\n" });
    const docker = dockerClient(fake);
    const id = await docker.createContainer({ image: IMAGE });
    await docker.startContainer(id);
    expect(await docker.waitContainer(id)).toBe(3);
    expect(await docker.containerLogs(id)).toEqual({ stdout: "out line\n", stderr: "err line\n" });
    await docker.removeContainer(id);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.calls.at(-1)).toBe(`DELETE /containers/${id}?force=1`);
  });

  it("takes an already started or stopped container as done, and passes the stop timeout", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    const docker = dockerClient(fake);
    const id = await docker.createContainer({ image: IMAGE });
    const container = fake.containers.get(id);
    if (container === undefined) throw new Error("no container");
    container.state = "running";
    await docker.startContainer(id);
    await docker.stopContainer(id, 30);
    expect(fake.calls.at(-1)).toBe(`POST /containers/${id}/stop?t=30`);
    expect(container.state).toBe("exited");
    await docker.stopContainer(id);
    expect(fake.calls.at(-1)).toBe(`POST /containers/${id}/stop`);
  });

  it("reads log frames split anywhere, and fails on a cut frame", async () => {
    const frames = Buffer.concat([
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 5]),
      Buffer.from("hello"),
      Buffer.from([2, 0, 0, 0, 0, 0, 0, 3]),
      Buffer.from("bad"),
    ]);
    const split: DockerTransport = {
      request: async () => ({
        status: 200,
        headers: {},
        body: Readable.from([frames.subarray(0, 3), frames.subarray(3, 10), frames.subarray(10)]),
      }),
    };
    expect(await dockerClient(split).containerLogs("abc")).toEqual({
      stdout: "hello",
      stderr: "bad",
    });
    const cut = answering(200, frames.subarray(0, 10).toString("latin1"));
    await expect(dockerClient(cut).containerLogs("abc")).rejects.toThrow(OpsCrewError);
  });

  it("fails plainly when a wait reports an error", async () => {
    const transport = answering(200, JSON.stringify({ StatusCode: 0, Error: { Message: "lost" } }));
    await expect(dockerClient(transport).waitContainer("abc")).rejects.toThrow(
      /Docker could not wait for container abc: lost\./,
    );
  });
});

describe("dockerClient: archives", () => {
  it("hands back an archive as a stream, and streams one in unread", async () => {
    const fake = new FakeDocker();
    fake.images.add(IMAGE);
    fake.addVolume("example-data", {
      "notes.txt": { type: "file", mode: 0o640, uid: 1000, gid: 1001, data: Buffer.from("hi") },
    });
    const docker = dockerClient(fake);
    const reader = await docker.createContainer({
      image: IMAGE,
      mounts: [{ type: "volume", source: "example-data", target: "/data", readOnly: true }],
    });
    const archive = await docker.getArchive(reader, "/data");
    expect(archive).toBeInstanceOf(Readable);
    const entries = parseTar(await readAll(archive));
    expect(entries.map((entry) => entry.name)).toEqual(["data/", "data/notes.txt"]);

    fake.addVolume("example-copy");
    const writer = await docker.createContainer({
      image: IMAGE,
      mounts: [{ type: "volume", source: "example-copy", target: "/data" }],
    });
    const upload = tarStream(entries);
    await docker.putArchive(writer, "/", upload);
    expect(fake.streamedBodies).toEqual([upload]);
    expect(fake.volumes.get("example-copy")?.files.get("notes.txt")).toMatchObject({
      mode: 0o640,
      uid: 1000,
      gid: 1001,
    });
  });

  it("sends an archive as a tar to the given path", async () => {
    const transport = answering(200, "");
    await dockerClient(transport).putArchive("abc", "/", tarStream([]));
    expect(transport.requests[0]).toMatchObject({
      method: "PUT",
      path: "/containers/abc/archive?path=%2F",
      headers: { "Content-Type": "application/x-tar" },
    });
  });
});

describe("dockerClient: volumes and images", () => {
  it("lists volumes with their labels, creates and removes them", async () => {
    const fake = new FakeDocker();
    const docker = dockerClient(fake);
    await docker.createVolume("example-app_data");
    fake.addVolume("example-app_cache", {}, { "com.docker.compose.volume": "cache" });
    fake.addVolume("unrelated");
    expect(await docker.listVolumes(["com.docker.compose.volume=cache"])).toEqual([
      { name: "example-app_cache", labels: { "com.docker.compose.volume": "cache" } },
    ]);
    expect((await docker.listVolumes()).map((volume) => volume.name)).toEqual([
      "example-app_data",
      "example-app_cache",
      "unrelated",
    ]);
    await docker.removeVolume("example-app_data");
    expect(fake.volumes.has("example-app_data")).toBe(false);
  });

  it("tells whether a volume exists, and fails on any other refusal", async () => {
    const fake = new FakeDocker();
    fake.addVolume("example-app_data");
    const docker = dockerClient(fake);
    expect(await docker.volumeExists("example-app_data")).toBe(true);
    expect(await docker.volumeExists("example-app_cache")).toBe(false);
    expect(fake.calls.at(-1)).toBe("GET /volumes/example-app_cache");
    fake.fail("GET", /\/volumes\//, 500, "the daemon is restarting");
    await expect(docker.volumeExists("example-app_data")).rejects.toMatchObject({ status: 500 });
  });

  it("reads the volumes' sizes, leaving out those Docker can't tell", async () => {
    const fake = new FakeDocker();
    fake.addVolume("example-data", {
      big: { type: "file", mode: 0o644, uid: 0, gid: 0, data: Buffer.alloc(5000) },
    });
    expect(await dockerClient(fake).volumeSizes()).toEqual(new Map([["example-data", 5000]]));
    const transport = answering(
      200,
      JSON.stringify({
        LayersSize: null,
        Volumes: [
          { Name: "local", UsageData: { Size: 12, RefCount: 0 } },
          { Name: "remote", UsageData: { Size: -1, RefCount: 0 } },
        ],
      }),
    );
    expect(await dockerClient(transport).volumeSizes()).toEqual(new Map([["local", 12]]));
    expect(transport.requests[0]?.path).toBe("/system/df?type=volume");
  });

  it("pulls an image, and fails plainly when the pull's stream reports an error", async () => {
    const fake = new FakeDocker();
    const docker = dockerClient(fake);
    await docker.pullImage(IMAGE);
    expect(fake.images.has(IMAGE)).toBe(true);
    expect(fake.calls.at(-1)).toBe(`POST /images/create?fromImage=${encodeURIComponent(IMAGE)}`);
    fake.unknownImages.add("busybox:missing");
    await expect(docker.pullImage("busybox:missing")).rejects.toThrow(
      /Docker could not pull image busybox:missing: manifest unknown\./,
    );
  });
});

describe("dockerClient: errors", () => {
  it("turns Docker's error answers into plain errors with the status", async () => {
    const fake = new FakeDocker();
    fake.addVolume("example-data");
    fake.images.add(IMAGE);
    const docker = dockerClient(fake);
    await docker.createContainer({
      image: IMAGE,
      mounts: [{ type: "volume", source: "example-data", target: "/data" }],
    });
    const error = await docker.removeVolume("example-data").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DockerApiError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", status: 409 });
    expect((error as DockerApiError).message).toMatch(
      /^Docker could not remove volume example-data: remove example-data: volume is in use/,
    );
    expect((error as DockerApiError).hint).toBeTruthy();
    await expect(docker.startContainer("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an answer of an unexpected shape", async () => {
    const transport = answering(200, JSON.stringify({ Volumes: "many" }));
    await expect(dockerClient(transport).listVolumes()).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("Docker returned an unexpected answer"),
    });
    await expect(dockerClient(answering(200, "not json")).listVolumes()).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
});
