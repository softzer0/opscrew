import { createHash, X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { selfSignedCertificate, type TestCertificate } from "./__fixtures__/self-signed";
import { normalizeCertFingerprint } from "./fingerprint";
import {
  fetchCertificateFingerprint,
  inspectCertificate,
  PortainerCertificateError,
  parsePortainerEndpoint,
  pinnedRequest,
} from "./pinned";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: Array<http.Server | https.Server> = [];

/** The certificate is made with Node's crypto at test time; a platform without EC P-256 skips. */
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
    `Skipping the local HTTPS pinning tests: this platform cannot make a test certificate (${certificateSupport}).`,
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

async function listen(server: http.Server | https.Server, seen: Seen[]): Promise<number> {
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Version: "2.45.2" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function httpsServer(certificate: TestCertificate) {
  const seen: Seen[] = [];
  const server = https.createServer({ key: certificate.key, cert: certificate.cert });
  const port = await listen(server, seen);
  return { seen, url: `https://127.0.0.1:${port}`, port };
}

function canonical(certificate: TestCertificate): string {
  const fingerprint = normalizeCertFingerprint(certificate.fingerprint256);
  if (fingerprint === undefined) throw new Error("bad test fingerprint");
  return fingerprint;
}

const token = fakeSecret("hcloud-token", "portainer-api-key");

describe("parsePortainerEndpoint", () => {
  it("refuses plain HTTP to any host but this computer, before connecting", () => {
    for (const url of ["http://nas.lan:9000", "http://192.168.1.10:9000", "http://example.com"]) {
      expect(() => parsePortainerEndpoint({ url }), url).toThrow(/plain HTTP/);
    }
    for (const url of ["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000"]) {
      expect(parsePortainerEndpoint({ url }).protocol, url).toBe("http:");
    }
  });

  it("refuses HTTPS without a confirmed certificate fingerprint", () => {
    expect(() => parsePortainerEndpoint({ url: "https://nas.lan:9443" })).toThrow(/certificate/);
    expect(() =>
      parsePortainerEndpoint({ url: "https://nas.lan:9443", certFingerprint: "nope" }),
    ).toThrow(/fingerprint/);
  });

  it("refuses logins, query strings and other schemes in the address", () => {
    const pin = `SHA256:${"AB".repeat(32)}`;
    for (const url of [
      "https://admin:pw@nas.lan:9443",
      "https://nas.lan:9443/?x=1",
      "https://nas.lan:9443/#frag",
      "ftp://nas.lan",
      "not a url",
    ]) {
      expect(() => parsePortainerEndpoint({ url, certFingerprint: pin }), url).toThrow();
    }
  });

  it("keeps a base path and normalises the pinned fingerprint", () => {
    const target = parsePortainerEndpoint({
      url: "https://nas.lan:9443/portainer/",
      certFingerprint: "ab".repeat(32),
    });
    expect(target.basePath).toBe("/portainer");
    expect(target.pin).toBe(normalizeCertFingerprint("ab".repeat(32)));
    expect(target.hostHeader).toBe("nas.lan:9443");
  });
});

describe.skipIf(certificateSupport !== undefined)(
  "certificate pinning against a local HTTPS server",
  () => {
    it("reads the certificate's fingerprint without trusting it and sends nothing", async () => {
      const certificate = selfSignedCertificate();
      const server = await httpsServer(certificate);
      expect(await fetchCertificateFingerprint(server.url)).toBe(canonical(certificate));
      const details = await inspectCertificate(server.url);
      const spki = new X509Certificate(certificate.cert).publicKey.export({
        type: "spki",
        format: "der",
      });
      expect(details.publicKeyPin).toBe(
        `sha256//${createHash("sha256").update(spki).digest("base64")}`,
      );
      expect(server.seen).toEqual([]);
    });

    it("sends the request with X-API-Key when the certificate matches the pin", async () => {
      const certificate = selfSignedCertificate();
      const server = await httpsServer(certificate);
      const request = pinnedRequest({
        url: server.url,
        certFingerprint: certificate.fingerprint256,
      });
      for (let i = 0; i < 2; i++) {
        const response = await request({
          method: "POST",
          path: "/api/stacks/create/standalone/string?endpointId=1",
          headers: { "X-API-Key": token, "Content-Type": "application/json" },
          body: '{"Name":"opscrew-shop-updater"}',
          timeoutMs: 10_000,
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ Version: "2.45.2" });
      }
      expect(server.seen).toHaveLength(2);
      expect(server.seen[0]?.headers["x-api-key"]).toBe(token);
      expect(server.seen[0]?.url).toBe("/api/stacks/create/standalone/string?endpointId=1");
      expect(server.seen[0]?.body).toBe('{"Name":"opscrew-shop-updater"}');
    });

    it("refuses a different certificate before sending anything, naming both fingerprints", async () => {
      const certificate = selfSignedCertificate();
      const pinned = selfSignedCertificate();
      const server = await httpsServer(certificate);
      const request = pinnedRequest({ url: server.url, certFingerprint: pinned.fingerprint256 });
      const error = await request({
        method: "GET",
        path: "/api/system/version",
        headers: { "X-API-Key": token },
        timeoutMs: 10_000,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PortainerCertificateError);
      const certError = error as PortainerCertificateError;
      expect(certError.expected).toBe(canonical(pinned));
      expect(certError.actual).toBe(canonical(certificate));
      expect(certError.message).toContain(canonical(pinned));
      expect(certError.message).toContain(canonical(certificate));
      expect(`${certError.message} ${certError.hint}`).not.toContain(token);
      expect(`${certError.message} ${certError.hint}`).not.toContain("127.0.0.1");
      expect(server.seen).toEqual([]);
    });

    it("notices a certificate that changes while the client is in use", async () => {
      const first = selfSignedCertificate();
      const server = await httpsServer(first);
      const request = pinnedRequest({ url: server.url, certFingerprint: first.fingerprint256 });
      const call = () =>
        request({ method: "GET", path: "/api/system/status", headers: {}, timeoutMs: 10_000 });
      expect((await call()).status).toBe(200);
      const second = selfSignedCertificate();
      (servers[0] as https.Server).setSecureContext({ key: second.key, cert: second.cert });
      const error = await call().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PortainerCertificateError);
      expect((error as PortainerCertificateError).actual).toBe(canonical(second));
      expect(server.seen).toHaveLength(1);
    });

    it("reports an unreachable Portainer plainly, without its address", async () => {
      const certificate = selfSignedCertificate();
      const server = await httpsServer(certificate);
      await new Promise<void>((resolve) => {
        const s = servers.pop() as https.Server;
        s.close(() => resolve());
      });
      const request = pinnedRequest({
        url: server.url,
        certFingerprint: certificate.fingerprint256,
      });
      const error = (await request({
        method: "GET",
        path: "/api/system/status",
        headers: {},
        timeoutMs: 5_000,
      }).catch((caught: unknown) => caught)) as Error & { code: string };
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toMatch(/Could not reach Portainer/);
      expect(error.message).not.toContain("127.0.0.1");
      await expect(fetchCertificateFingerprint(server.url)).rejects.toThrow(
        /Could not reach Portainer/,
      );
    });
  },
);

describe("plain HTTP to this computer", () => {
  it("works for 127.0.0.1 and sends the token only there", async () => {
    const seen: Seen[] = [];
    const port = await listen(http.createServer(), seen);
    const request = pinnedRequest({ url: `http://127.0.0.1:${port}/` });
    const response = await request({
      method: "GET",
      path: "/api/users/me",
      headers: { "X-API-Key": token },
      timeoutMs: 10_000,
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.headers["x-api-key"]).toBe(token);
    expect(seen[0]?.url).toBe("/api/users/me");
  });

  it("has no certificate to read", async () => {
    await expect(fetchCertificateFingerprint("http://localhost:9000")).rejects.toThrow(/https/);
  });
});
