import { Readable } from "node:stream";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { portainerClient } from "./client";
import type { PinnedRequest, PinnedStream, PinnedStreamInit } from "./pinned";

const endpoint = { url: "https://nas.lan:9443", certFingerprint: `SHA256:${"AB".repeat(32)}` };
const token = fakeSecret("hcloud-token", "portainer-api-key");

const noRequest: PinnedRequest = () => Promise.reject(new Error("no buffered request expected"));

function proxySetup(stream: PinnedStream) {
  const redactor = new Redactor();
  const client = portainerClient(endpoint, token, { request: noRequest, stream, redactor });
  return { client, redactor };
}

describe("dockerProxyTransport", () => {
  it("sends Docker requests below the environment's proxy with X-API-Key, streaming both ways", async () => {
    const seen: PinnedStreamInit[] = [];
    const answer = Readable.from([Buffer.from("tar bytes")]);
    const { client } = proxySetup(async (init) => {
      seen.push(init);
      return { status: 200, headers: { "content-type": "application/x-tar" }, body: answer };
    });
    const transport = client.dockerProxyTransport(3);
    const upload = Readable.from([Buffer.from("archive")]);
    const signal = new AbortController().signal;
    const response = await transport.request({
      method: "PUT",
      path: "/containers/abc/archive?path=%2F",
      headers: { "Content-Type": "application/x-tar" },
      body: upload,
      signal,
    });
    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "application/x-tar" },
      body: answer,
    });
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.path).toBe("/api/endpoints/3/docker/containers/abc/archive?path=%2F");
    expect(seen[0]?.headers["X-API-Key"]).toBe(token);
    expect(seen[0]?.headers["Content-Type"]).toBe("application/x-tar");
    expect(seen[0]?.headers["User-Agent"]).toMatch(/^opscrew-connector-portainer\//);
    expect(seen[0]?.body).toBe(upload);
    expect(seen[0]?.signal).toBe(signal);
    // A status other than 2xx is the caller's to read: Docker's error body streams back.
    await transport.request({ method: "HEAD", path: "/containers/abc/archive?path=%2Fdata" });
    expect(seen[1]?.body).toBeUndefined();
  });

  it("refuses an environment id or a path that could leave the proxy, before sending", async () => {
    const seen: PinnedStreamInit[] = [];
    const { client } = proxySetup(async (init) => {
      seen.push(init);
      return { status: 200, headers: {}, body: Readable.from([]) };
    });
    expect(() => client.dockerProxyTransport(0)).toThrow(/positive whole numbers/);
    const transport = client.dockerProxyTransport(3);
    for (const path of ["containers/json", "/../../users", "/containers/x/../../../api"]) {
      await expect(transport.request({ method: "GET", path }), path).rejects.toThrow(
        /Docker API path/,
      );
    }
    expect(seen).toEqual([]);
  });

  it("never puts the token in an error (leak test)", async () => {
    const { client } = proxySetup(async () => {
      // A failure that echoes the token, as a broken proxy might.
      throw new OpsCrewError("PROVIDER_ERROR", `Portainer failed with key ${token}.`, {
        hint: `Check ${token}.`,
      });
    });
    const error = (await client
      .dockerProxyTransport(3)
      .request({ method: "GET", path: "/containers/json" })
      .catch((caught: unknown) => caught)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(`${error.message} ${error.hint} ${error.stack}`).not.toContain(token);
    expect(error.message).toContain("[REDACTED:PORTAINER_API_KEY]");
  });
});
