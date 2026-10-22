import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalCa, issueLeaf, type LocalCa } from "./ca";
import { nodeLocalRequest } from "./https";

/**
 * The real request function against an HTTPS server on 127.0.0.1 (no other network), serving a
 * leaf of a local CA made for the test: only that CA is trusted, and only for the leaf's name.
 */
describe("nodeLocalRequest", () => {
  let ca: LocalCa;
  let server: Server;
  let port: number;
  const hosts: (string | undefined)[] = [];

  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), "opscrew-local-https-"));
    // TLS checks the certificates' dates against the real clock.
    ca = await ensureLocalCa({ homeDir: home }, { computerName: "test", now: new Date() });
    const leaf = issueLeaf(ca, "shop.localhost", new Date());
    server = createServer({ cert: leaf.certificate, key: leaf.key }, (request, response) => {
      hosts.push(request.headers.host);
      response.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const ask = (hostname: string, trusted: boolean) =>
    nodeLocalRequest({
      scheme: "https",
      port,
      hostname,
      path: "/api/health",
      ...(trusted ? { ca: ca.certificate } : {}),
      timeoutMs: 5000,
    });

  it("reaches the app through 127.0.0.1 with its hostname, trusting the local CA", async () => {
    const answer = await ask("shop.localhost", true);
    expect(answer.status).toBe(200);
    expect(answer.certificate?.subjectAltName).toBe("DNS:shop.localhost");
    expect(answer.certificate?.validTo).toMatch(/GMT$/);
    expect(hosts).toEqual([`shop.localhost:${port}`]);
  });

  it("refuses the leaf without the local CA, and for another hostname", async () => {
    await expect(ask("shop.localhost", false)).rejects.toThrow();
    await expect(ask("other.localhost", true)).rejects.toThrow(/other\.localhost/);
    expect(hosts).toHaveLength(1);
  });
});
