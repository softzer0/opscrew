import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { duplexPair, Readable } from "node:stream";
import type { StreamProcess } from "@opscrew/contracts";
import { NodeStreamRunner, OpsCrewError } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { volumeCarrier } from "./carrier";
import { dockerClient } from "./client";
import { dialStdioTransport } from "./dial-stdio";
import { type FakeDialStdio, fakeDialStdio } from "./testing/dial-stdio";
import { FakeDocker } from "./testing/fake-docker";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];
const dialers: FakeDialStdio[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const dialer of dialers.splice(0)) dialer.close();
});

/**
 * A stand-in for `ssh … docker system dial-stdio`: a Node.js process relaying its stdin and stdout
 * to a TCP port, which says so on stderr and exits when the server closes the connection.
 */
const RELAY = `const socket = require("node:net").connect(Number(process.argv[1]), "127.0.0.1");
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", () => {});
socket.on("close", () => process.stderr.write("relay: the server closed the connection\\n", () => process.exit(0)));`;

/** `handler`'s HTTP server on a local port, reached through {@link RELAY} processes. */
async function relayed(handler: Handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);
  const runner = new NodeStreamRunner();
  const processes: StreamProcess[] = [];
  const open = () => {
    const child = runner.open(process.execPath, ["-e", RELAY, port]);
    processes.push(child);
    return child;
  };
  return { server, open, processes };
}

/** {@link fakeDialStdio} for `docker`, closed after the test; `open` starts one of its processes. */
function dialer(docker: Parameters<typeof fakeDialStdio>[0]) {
  const fake = fakeDialStdio(docker);
  dialers.push(fake);
  return { counts: fake, open: () => fake.open("ssh", ["docker", "system", "dial-stdio"]) };
}

/** A process that exits at once, as `ssh` does when it can't log in. */
function failedLogin(stderr: string): StreamProcess {
  const [local, remote] = duplexPair();
  remote.resume();
  remote.end();
  return {
    stream: local,
    exit: Promise.resolve({ exitCode: 255, stderr }),
    kill: () => {
      local.destroy();
      remote.destroy();
    },
  };
}

async function text(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("dialStdioTransport", () => {
  it("speaks HTTP/1.1 to Docker over one process, kept for the next request", async () => {
    const fake = new FakeDocker();
    const { open, counts } = dialer(fake);
    const transport = dialStdioTransport(open);
    const docker = dockerClient(transport);
    await docker.createVolume("example-app_data");
    expect(await docker.listVolumes()).toEqual([{ name: "example-app_data", labels: {} }]);
    expect(await docker.volumeSizes()).toEqual(new Map([["example-app_data", 0]]));
    expect(counts.opened).toHaveLength(1);
    await transport.close?.();
    expect(counts.killed).toBe(1);
  });

  it("copies a volume between two hosts, streamed both ways, and the digests match", async () => {
    const hosts = [new FakeDocker(), new FakeDocker()];
    for (const fake of hosts) fake.images.add("busybox:test");
    hosts[0]?.addVolume("example-app_data", {
      big: { type: "file", mode: 0o600, uid: 999, gid: 999, data: Buffer.alloc(3 << 20, 1) },
    });
    hosts[1]?.addVolume("example-copy");
    const data = { kind: "volume", name: "example-app_data" } as const;
    const copy = { kind: "volume", name: "example-copy" } as const;
    const transports = hosts.map((fake) => dialStdioTransport(dialer(fake).open));
    const [source, target] = transports.map((transport) =>
      volumeCarrier(dockerClient(transport), "busybox:test"),
    );
    if (source === undefined || target === undefined) throw new Error("no carriers");
    await target.writeVolume(copy, await source.readVolume(data));
    expect(await target.volumeDigest(copy)).toBe(await source.volumeDigest(data));
    for (const transport of transports) await transport.close?.();
  });

  it("sends a body as it is read, and hands back an answer as it comes", async () => {
    let arrived: () => void = () => {};
    const firstBytes = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release: () => void = () => {};
    const clientRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { open } = dialer((request, response) => {
      if (request.method === "PUT") {
        expect(request.headers["transfer-encoding"]).toBe("chunked");
        let size = 0;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          arrived();
        });
        request.on("end", () => response.end(String(size)));
        return;
      }
      response.write("first;");
      void clientRead.then(() => response.end("rest"));
    });
    const transport = dialStdioTransport(open);
    // The second chunk waits until the server has the first: a buffered body would never arrive.
    const body = Readable.from(
      (async function* () {
        yield Buffer.alloc(1000, 1);
        await firstBytes;
        yield Buffer.alloc(500, 2);
      })(),
      { objectMode: false },
    );
    const put = await transport.request({ method: "PUT", path: "/upload", body });
    expect(await text(put.body)).toBe("1500");

    const get = await transport.request({ method: "GET", path: "/download" });
    const [first] = (await once(get.body, "data")) as [Buffer];
    expect(first.toString("utf8")).toBe("first;");
    release();
    expect(await text(get.body)).toBe("rest");
    await transport.close?.();
  });

  it("opens another process for a request while one is busy, and close ends them all", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { open, counts } = dialer((request, response) => {
      if (request.url === "/held") {
        response.flushHeaders();
        void held.then(() => response.end("held"));
      } else {
        response.end("quick");
      }
    });
    const transport = dialStdioTransport(open);
    const slow = await transport.request({ method: "GET", path: "/held" });
    const quick = await transport.request({ method: "GET", path: "/quick" });
    expect(await text(quick.body)).toBe("quick");
    expect(counts.opened).toHaveLength(2);
    await transport.close?.();
    expect(counts.killed).toBe(2);
    await Promise.all(counts.exits);
    release();
    slow.body.destroy();
  });

  it("opens a new process when the idle one has exited", async () => {
    const { server, open, processes } = await relayed((_request, response) => response.end("ok"));
    const transport = dialStdioTransport(open);
    expect(await text((await transport.request({ method: "GET", path: "/one" })).body)).toBe("ok");
    server.closeIdleConnections();
    await processes[0]?.exit;
    expect(await text((await transport.request({ method: "GET", path: "/two" })).body)).toBe("ok");
    expect(processes).toHaveLength(2);
    await transport.close?.();
  });

  it("fails the answer plainly when the process dies in the middle of it", async () => {
    const { open } = await relayed((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write("partial");
      setTimeout(() => response.socket?.destroy(), 50);
    });
    const transport = dialStdioTransport(open);
    const answer = await transport.request({ method: "GET", path: "/half" });
    const error = await text(answer.body).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "The connection to Docker closed during its answer: relay: the server closed the connection.",
    );
    await transport.close?.();
  });

  it("says why the connection closed, from the process's stderr", async () => {
    const transport = dialStdioTransport(() =>
      failedLogin("Warning: added host key\ndeploy@example.com: Permission denied (publickey).\n"),
    );
    const error = await transport
      .request({ method: "GET", path: "/volumes" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "The connection to Docker closed before it answered: deploy@example.com: Permission denied (publickey).",
    );
    expect((error as OpsCrewError).hint).toMatch(/SSH/);
  });

  it("passes on a program that could not start, and the body's own failure", async () => {
    const notInstalled = new OpsCrewError(
      "COMMAND_FAILED",
      "Could not run ssh: it is not installed.",
    );
    const refused = dialStdioTransport(() => {
      throw notInstalled;
    });
    await expect(refused.request({ method: "GET", path: "/volumes" })).rejects.toBe(notInstalled);

    const broken = dialStdioTransport(() => {
      const process = failedLogin("");
      queueMicrotask(() => process.stream.destroy(notInstalled));
      return process;
    });
    await expect(broken.request({ method: "GET", path: "/volumes" })).rejects.toBe(notInstalled);

    const sourceFailed = new OpsCrewError(
      "PROVIDER_ERROR",
      "Reading volume example-app_data broke off.",
    );
    const { open } = dialer((request) => request.resume());
    const transport = dialStdioTransport(open);
    const body = new Readable({ read() {} });
    const sent = transport.request({ method: "PUT", path: "/upload", body });
    body.push(Buffer.alloc(100));
    setTimeout(() => body.destroy(sourceFailed), 20);
    await expect(sent).rejects.toBe(sourceFailed);
    await transport.close?.();
  });

  it("passes on the caller's abort", async () => {
    const { open } = dialer(() => {});
    const transport = dialStdioTransport(open);
    const controller = new AbortController();
    const sent = transport.request({ method: "GET", path: "/never", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(sent).rejects.toMatchObject({ name: "AbortError" });
    await transport.close?.();
  });
});
