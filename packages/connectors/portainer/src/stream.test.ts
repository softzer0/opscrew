import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { selfSignedCertificate, type TestCertificate } from "./__fixtures__/self-signed";
import { PortainerCertificateError, pinnedStream } from "./pinned";

/** What the local server saw of one request: its headers and its body's size and SHA-256. */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  bytes: number;
  sha256: string;
}

const servers: Array<http.Server | https.Server> = [];

const certificateSupport = (() => {
  try {
    selfSignedCertificate();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
})();
if (certificateSupport !== undefined) {
  console.warn(
    `Skipping the local HTTPS streaming tests: this platform cannot make a test certificate (${certificateSupport}).`,
  );
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

/** `count` chunks of `size` random bytes, and their SHA-256. */
function chunks(count: number, size: number): { parts: Buffer[]; sha256: string } {
  const parts = Array.from({ length: count }, () => randomBytes(size));
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return { parts, sha256: hash.digest("hex") };
}

/**
 * Serves every request by hashing its body, then answering with `answer` streamed in its chunks
 * (or holding the answer back when `hold` is set).
 */
async function serve(
  server: http.Server | https.Server,
  answer: Buffer[],
  options: { hold?: boolean } = {},
): Promise<{ seen: Seen[]; port: number }> {
  const seen: Seen[] = [];
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const hash = createHash("sha256");
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        bytes,
        sha256: hash.digest("hex"),
      });
      if (options.hold === true) return;
      res.writeHead(200, { "Content-Type": "application/x-tar", "X-Docker-Test": "yes" });
      const queue = [...answer];
      const next = () => {
        const part = queue.shift();
        if (part === undefined) res.end();
        else res.write(part, next);
      };
      next();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: (server.address() as AddressInfo).port };
}

async function read(body: Readable): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

const token = fakeSecret("hcloud-token", "portainer-api-key");

describe.skipIf(certificateSupport !== undefined)("pinnedStream over HTTPS", () => {
  let certificate: TestCertificate;

  it("streams a chunked upload and a download, with X-API-Key, to the pinned certificate", async () => {
    certificate = selfSignedCertificate();
    const upload = chunks(40, 64 * 1024);
    const download = chunks(30, 64 * 1024);
    const server = await serve(
      https.createServer({ key: certificate.key, cert: certificate.cert }),
      download.parts,
    );
    const stream = pinnedStream({
      url: `https://127.0.0.1:${server.port}`,
      certFingerprint: certificate.fingerprint256,
    });
    const response = await stream({
      method: "PUT",
      path: "/api/endpoints/3/docker/containers/abc/archive?path=%2F",
      headers: { "X-API-Key": token, "Content-Type": "application/x-tar" },
      body: Readable.from(upload.parts),
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-tar");
    expect(response.headers["x-docker-test"]).toBe("yes");
    expect(await read(response.body)).toEqual({
      bytes: 30 * 64 * 1024,
      sha256: download.sha256,
    });
    const [seen] = server.seen;
    expect(seen?.method).toBe("PUT");
    expect(seen?.url).toBe("/api/endpoints/3/docker/containers/abc/archive?path=%2F");
    expect(seen?.headers["x-api-key"]).toBe(token);
    expect(seen?.headers["transfer-encoding"]).toBe("chunked");
    expect(seen?.headers["content-length"]).toBeUndefined();
    expect(seen?.bytes).toBe(40 * 64 * 1024);
    expect(seen?.sha256).toBe(upload.sha256);
  });

  it("sends a text body with its length", async () => {
    certificate = selfSignedCertificate();
    const server = await serve(
      https.createServer({ key: certificate.key, cert: certificate.cert }),
      [Buffer.from("{}")],
    );
    const stream = pinnedStream({
      url: `https://127.0.0.1:${server.port}`,
      certFingerprint: certificate.fingerprint256,
    });
    const body = '{"Image":"busybox"}';
    const response = await stream({
      method: "POST",
      path: "/api/endpoints/3/docker/containers/create",
      headers: { "X-API-Key": token, "Content-Type": "application/json" },
      body,
    });
    expect(await read(response.body)).toMatchObject({ bytes: 2 });
    expect(server.seen[0]?.headers["content-length"]).toBe(String(body.length));
    expect(server.seen[0]?.sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("refuses a different certificate before sending anything", async () => {
    certificate = selfSignedCertificate();
    const pinned = selfSignedCertificate();
    const server = await serve(
      https.createServer({ key: certificate.key, cert: certificate.cert }),
      [],
    );
    const stream = pinnedStream({
      url: `https://127.0.0.1:${server.port}`,
      certFingerprint: pinned.fingerprint256,
    });
    const error = await stream({
      method: "PUT",
      path: "/api/endpoints/3/docker/containers/abc/archive?path=%2F",
      headers: { "X-API-Key": token },
      body: Readable.from([randomBytes(1024)]),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PortainerCertificateError);
    expect(String((error as Error).message)).not.toContain(token);
    expect(server.seen).toEqual([]);
  });

  it("has no fixed timeout: only the signal stops a request", async () => {
    certificate = selfSignedCertificate();
    const server = await serve(
      https.createServer({ key: certificate.key, cert: certificate.cert }),
      [],
      { hold: true },
    );
    const stream = pinnedStream({
      url: `https://127.0.0.1:${server.port}`,
      certFingerprint: certificate.fingerprint256,
    });
    const controller = new AbortController();
    const pending = stream({
      method: "GET",
      path: "/api/endpoints/3/docker/containers/abc/archive?path=%2Fdata",
      headers: { "X-API-Key": token },
      signal: controller.signal,
    });
    const settled = await Promise.race([
      pending.then(
        () => "answered",
        () => "failed",
      ),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 1_000)),
    ]);
    expect(settled).toBe("waiting");
    controller.abort();
    const error = (await pending.catch((caught: unknown) => caught)) as Error;
    expect(error.name).toBe("AbortError");
    expect(server.seen).toHaveLength(1);
  });
});

describe("pinnedStream over plain HTTP to this computer", () => {
  it("streams the answer and refuses paths outside /api/", async () => {
    const download = chunks(4, 1024);
    const server = await serve(http.createServer(), download.parts);
    const stream = pinnedStream({ url: `http://127.0.0.1:${server.port}` });
    const response = await stream({
      method: "GET",
      path: "/api/endpoints/3/docker/containers/abc/archive?path=%2Fdata",
      headers: {},
    });
    expect(await read(response.body)).toEqual({ bytes: 4096, sha256: download.sha256 });
    await expect(stream({ method: "GET", path: "/other", headers: {} })).rejects.toThrow(/\/api\//);
  });

  it("reports an unreachable Portainer without its address or the token", async () => {
    const server = await serve(http.createServer(), []);
    await new Promise<void>((resolve) => (servers.pop() as http.Server).close(() => resolve()));
    const stream = pinnedStream({ url: `http://127.0.0.1:${server.port}` });
    const error = (await stream({
      method: "PUT",
      path: "/api/endpoints/3/docker/containers/abc/archive?path=%2F",
      headers: { "X-API-Key": token },
      body: Readable.from([randomBytes(16)]),
    }).catch((caught: unknown) => caught)) as Error & { code: string; hint?: string };
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/Could not reach Portainer/);
    expect(`${error.message} ${error.hint}`).not.toContain("127.0.0.1");
    expect(`${error.message} ${error.hint}`).not.toContain(token);
  });
});
