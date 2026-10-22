import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SharedRecord } from "@opscrew/connector-cloudflare";
import type { RemoteExec } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { writeCloudflareRecord } from "../provision/shared-cloudflare";
import { COPY_PATH } from "../secrets";
import { recordServerAddress } from "../shared";
import { createTestPhaseDeps, portainerPlan, type TestPhaseDeps } from "../testing";
import { SERVER, testPlan } from "../verify/__fixtures__/plan";
import type { TlsCertificateInfo, TlsConnect } from "../verify/net";
import {
  proxyCertificateHosts,
  proxyRenewalAdvice,
  recordCertificateWarnings,
  tlsStatusReport,
} from "./certificates";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const clock = { now: () => NOW };
const ZONE = "0123456789abcdef0123456789abcdef";
const SHA = "a".repeat(64);

function record(expiresAt = "2041-10-16T23:53:00.000Z", clientExpiresAt = expiresAt): SharedRecord {
  return {
    zoneId: ZONE,
    hostnames: { "opscrew-strict-tls": ["shop.example.com"] },
    createdEntrypoints: [],
    tls: {
      origin: { id: "o1", hostnames: ["shop.example.com"], expiresAt, sha256: SHA, superseded: [] },
      client: {
        id: "c1",
        expiresAt: clientExpiresAt,
        sha256: SHA,
        enabled: ["shop.example.com"],
        retiring: [],
      },
    },
  };
}

/** A DNS-only plan on the nginx edge, deployed. */
function nginxPlan(): DeployPlan {
  const base = testPlan({ proxied: false });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, edge: "nginx" },
    deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
  });
}

async function setup(plan: DeployPlan): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({ clock });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await recordServerAddress(deps.paths, SERVER);
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return deps;
}

/** A certificate expiring `days` after {@link NOW}. */
function presented(days: number): TlsConnect {
  return async (): Promise<TlsCertificateInfo> => ({
    subjectAltNames: ["shop.example.com"],
    validFrom: "2026-09-01T00:00:00.000Z",
    validTo: new Date(NOW.getTime() + days * 86_400_000 + 3_600_000).toISOString(),
    issuer: "Let's Encrypt",
  });
}

/** The deploy user's shell, answering certbot's log with `line`. */
function certbotLog(line: string) {
  const commands: string[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    async run(command) {
      commands.push(command);
      return { exitCode: 0, stdout: `${line}\n`, stderr: "" };
    },
  });
  return { remote, commands };
}

describe("tlsStatusReport (FR-1462)", () => {
  it("shows the proxy, the record's certificates and that there is no copy yet", async () => {
    const plan = testPlan();
    const deps = await setup(plan);
    await writeCloudflareRecord(deps.paths, record());
    const { lines } = await tlsStatusReport(deps, plan, {
      tlsConnect: async () => {
        throw new Error("no handshake behind Cloudflare's proxy");
      },
    });
    expect(lines).toEqual([
      "Proxy: Caddy",
      "Certificates:",
      "  Cloudflare origin certificate (shop.example.com): expires 2041-10-16",
      "  Client certificate for Cloudflare's origin pulls: expires 2041-10-16",
      "Secrets copy: none yet (`opscrew provision` makes it).",
    ]);
  });

  it("reads DNS-only certificates, warns below 30 days with certbot's reason, and shows the copy", async () => {
    const plan = nginxPlan();
    const deps = await setup(plan);
    const copy = join(deps.paths.root, COPY_PATH);
    const encrypted = fakeSecret("generic-password", "copy");
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(
      copy,
      JSON.stringify({
        files: { "state/server.json": `ENC[AES256_GCM,data:${encrypted}]` },
        sops: { lastmodified: "2026-10-20T14:03:00Z", age: [{}, {}] },
      }),
    );
    const log = certbotLog(
      "Failed to renew certificate shop with error: Some challenges have failed.",
    );
    const { lines } = await tlsStatusReport(deps, plan, {
      tlsConnect: presented(20),
      services: { remote: log.remote },
    });
    expect(lines.slice(0, 3)).toEqual([
      "Proxy: nginx",
      "Certificates:",
      "  shop.example.com (from Let's Encrypt): expires 2026-11-10 (20 days left)",
    ]);
    expect(lines).toContain(
      "  Warning: The certificate of shop.example.com expires on 2026-11-10 and has not been renewed.",
    );
    expect(lines).toContain(
      "  Warning: certbot renews certificates 45 days before they expire, so its renewal is failing: certbot's last renewal said: Some challenges have failed. Check that the hostname's DNS record points to the server and that port 80 reaches it; certbot tries again every 12 hours.",
    );
    expect(lines).toContain("Secrets copy: last updated 2026-10-20 14:03 UTC, 2 keys can open it.");
    expect(log.commands).toHaveLength(1);
    expect(log.commands[0]).toContain("label=com.docker.compose.service=certbot");
    expect(lines.join("\n")).not.toContain(encrypted);
    expect(deps.audit.entries.at(-1)).toMatchObject({
      action: "read certbot's last renewal (read-only)",
      target: "server",
    });
  });

  it("reads certbot's log only when a certificate needs it, and says what could not be read", async () => {
    const plan = nginxPlan();
    const deps = await setup(plan);
    const log = certbotLog("");
    const fine = await tlsStatusReport(deps, plan, {
      tlsConnect: presented(60),
      services: { remote: log.remote },
    });
    expect(fine.lines).toContain(
      "  shop.example.com (from Let's Encrypt): expires 2026-12-20 (60 days left)",
    );
    expect(fine.lines.some((line) => line.includes("Warning: The certificate"))).toBe(false);
    const unread = await tlsStatusReport(deps, plan, {
      tlsConnect: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      services: { remote: log.remote },
    });
    expect(unread.lines).toContain("  shop.example.com: could not be read (connect ECONNREFUSED)");
    expect(log.commands).toEqual([]);
  });
});

describe("the certificates OpsCrew manages (FR-1406)", () => {
  it("warns about the record's certificates below 30 days, with the steps for the client one", () => {
    expect(recordCertificateWarnings(testPlan(), record(), clock)).toEqual([]);
    const [origin, client] = recordCertificateWarnings(
      testPlan(),
      record("2026-11-15T00:00:00.000Z", "2026-11-01T00:00:00.000Z"),
      clock,
    );
    expect(origin).toBe(
      "The app's Cloudflare origin certificate for shop.example.com expires on 2026-11-15. Run `opscrew provision`: it replaces the certificate, and the deploy brings the server the new one.",
    );
    expect(client).toContain(
      "This app's client certificate for Cloudflare's origin pulls expires on 2026-11-01",
    );
  });

  it("sends a Portainer app to the Caddy of its stack, a server to the shared edge", () => {
    const stack = portainerPlan({ web: { mode: "caddy" } });
    expect(proxyRenewalAdvice(stack, undefined)).toContain(
      "read why in the logs of the caddy container of the stack opscrew-shop in your Portainer",
    );
    expect(proxyRenewalAdvice(stack, undefined)).not.toContain("-p opscrew-edge");
    expect(proxyRenewalAdvice(testPlan(), undefined)).toContain(
      "`docker compose -p opscrew-edge logs caddy`",
    );
  });

  it("names the DNS-only hostnames whose certificate the server's proxy gets", () => {
    expect(proxyCertificateHosts(testPlan())).toEqual([]);
    expect(proxyCertificateHosts(testPlan({ proxied: false, www: true }))).toEqual([
      "shop.example.com",
      "www.shop.example.com",
    ]);
    expect(proxyCertificateHosts(testPlan({ domain: undefined }))).toEqual([]);
  });
});
