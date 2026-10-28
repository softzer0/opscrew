import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SharedRecord } from "@opscrew/connector-cloudflare";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { CheckResult, CommandResult, FetchLike, RemoteExec } from "@opscrew/contracts";
import { generateP256, selfSignedClientCertificate } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { writeCloudflareRecord } from "../provision/shared-cloudflare";
import { COPY_PATH } from "../secrets";
import { recordServerAddress } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import { createTestPhaseDeps, fakeSharedCloudflare, ScriptedRunner } from "../testing";
import { SERVER, testPlan } from "../verify/__fixtures__/plan";
import { runSecure } from "./run";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const KEY = generateP256().privateKey;
const ORIGIN_CA = "CloudFlare Origin SSL ECC Certificate Authority";

/** A certificate issued by `issuer` (self-signed), valid for `days` from now. */
function certificate(issuer: string, days: number): string {
  return selfSignedClientCertificate({ key: KEY, commonName: issuer, days, now: NOW });
}

/** `openssl s_client`'s output with the proxy's certificate, then what followed. */
function sClient(pem: string | undefined, after = ""): string {
  return [
    "CONNECTED(00000003)",
    "---",
    ...(pem === undefined ? [] : [pem.trim()]),
    "---",
    after,
  ].join("\n");
}

const CADDY_REFUSED = sClient(certificate(ORIGIN_CA, 5475), "tlsv13 alert certificate required");
const NGINX_REFUSED = sClient(
  certificate(ORIGIN_CA, 5475),
  "HTTP/1.1 400 Bad Request\r\n\r\n<center>No required SSL certificate was sent</center>",
);
const UNKNOWN_REFUSED = "CONNECTED(00000003)\ntlsv1 unrecognized name\n";

interface Server {
  /** What `openssl s_client` prints for the app's hostname. */
  site?: string;
  /** certbot's last line about the app's certificate. */
  certbot?: string;
  /** Valkey's answer to a ping without its password. */
  ping?: string;
}

/** The deploy user's shell: the TLS checks, certbot's log and Valkey answer; the rest fails. */
function server(o: Server = {}) {
  const commands: string[] = [];
  const remote: RemoteExec = {
    host: SERVER.ipv4,
    async run(command): Promise<CommandResult> {
      commands.push(command);
      const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: "" });
      if (command.includes("unknown.opscrew.invalid")) return ok(UNKNOWN_REFUSED, 1);
      if (command.includes("openssl s_client")) return ok(o.site ?? CADDY_REFUSED, 1);
      if (command.includes("service=certbot")) return ok(o.certbot ?? "");
      if (command.includes("valkey-cli PING"))
        return ok(o.ping ?? "NOAUTH Authentication required.");
      return ok("", 1);
    },
  };
  return { remote, commands };
}

function record(tls: SharedRecord["tls"] = defaultTls()): SharedRecord {
  return {
    zoneId: FAKE_ZONE_ID,
    hostnames: { "opscrew-strict-tls": ["shop.example.com"] },
    createdEntrypoints: [],
    ...(tls !== undefined ? { tls } : {}),
  };
}

function defaultTls(): NonNullable<SharedRecord["tls"]> {
  return {
    origin: {
      id: "o1",
      hostnames: ["shop.example.com"],
      expiresAt: "2041-10-16T23:53:00.000Z",
      sha256: "a".repeat(64),
      superseded: [],
    },
    client: {
      id: "c1",
      expiresAt: "2041-10-16T23:58:23.000Z",
      sha256: "b".repeat(64),
      enabled: ["shop.example.com"],
      retiring: [],
    },
  };
}

/** A deployed plan for `shop.example.com` (proxied by default) on `edge`. */
function deployedPlan(o: { proxied?: boolean; edge?: "caddy" | "nginx"; valkey?: boolean } = {}) {
  const base = testPlan({ proxied: o.proxied ?? true });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, edge: o.edge ?? "caddy" },
    services: [
      ...base.services,
      ...(o.valkey
        ? [
            {
              kind: "valkey",
              version: "8",
              memoryMb: 128,
              options: { mode: "cache" },
              reason: "redis",
              licence: "BSD-3-Clause",
            },
          ]
        : []),
    ],
    deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
  });
}

async function setup(plan: DeployPlan, o: { fetch?: FetchLike; github?: boolean } = {}) {
  const deps = await createTestPhaseDeps({
    clock: { now: () => NOW },
    runner: new ScriptedRunner((command, args) =>
      command === "git" && args.includes("get-url")
        ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "unexpected command" },
    ),
    ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
  });
  if (o.github) deps.env.GITHUB_TOKEN = fakeSecret("github-token");
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await recordServerAddress(deps.paths, SERVER);
  await mkdir(dirname(deps.paths.files.deployKey), { recursive: true });
  await writeFile(deps.paths.files.deployKey, "placeholder for the deploy key file\n");
  return deps;
}

function find(checks: readonly CheckResult[], id: string): CheckResult {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}: ${checks.map((c) => c.id).join(", ")}`);
  return check;
}

const secure = (deps: Awaited<ReturnType<typeof setup>>, remote: RemoteExec, zone?: FakeZone) =>
  runSecure(deps, {
    scanners: [],
    offline: true,
    remote,
    tcpConnect: async (_host, port) => [22, 80, 443].includes(port),
    ...(zone !== undefined ? { cloudflare: fakeSharedCloudflare(zone) } : {}),
  });

describe("secure's origin check from the server (FR-1423)", () => {
  it.each([
    ["Caddy refuses the handshake", "caddy" as const, CADDY_REFUSED],
    ["nginx answers HTTP 400", "nginx" as const, NGINX_REFUSED],
  ])("counts it as refused when %s", async (_case, edge, site) => {
    const deps = await setup(deployedPlan({ edge }));
    await writeCloudflareRecord(deps.paths, record());
    const { remote, commands } = server({ site });
    const result = await secure(deps, remote, new FakeZone());
    expect(find(result.hostChecks, "origin-tls-shop.example.com")).toMatchObject({
      status: "pass",
    });
    expect(find(result.hostChecks, "origin-unknown-hostname")).toMatchObject({ status: "pass" });
    expect(commands).toContain(
      "printf 'GET / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n' 'shop.example.com' | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername 'shop.example.com' -tls1_3 -ign_eof 2>&1",
    );
    expect(result.report).toContain("refuses connections without Cloudflare's client certificate");
  });

  it("fails a hostname the server answers without the client certificate", async () => {
    const deps = await setup(deployedPlan());
    await writeCloudflareRecord(deps.paths, record());
    const { remote } = server({
      site: sClient(certificate(ORIGIN_CA, 5475), "HTTP/1.1 200 OK\r\n\r\nshop"),
    });
    const result = await secure(deps, remote, new FakeZone());
    expect(find(result.hostChecks, "origin-tls-shop.example.com")).toMatchObject({
      status: "fail",
      severity: "high",
    });
    expect(result.passed).toBe(false);
  });

  it("checks no origin TLS without it in the record, nor before the first deploy", async () => {
    const deps = await setup(deployedPlan());
    const { remote, commands } = server();
    const result = await secure(deps, remote);
    expect(result.hostChecks.some((c) => c.id.startsWith("origin-"))).toBe(false);
    const base = testPlan();
    await writeArtifact("plan", deps.paths.files.plan, base);
    await writeCloudflareRecord(deps.paths, record());
    await secure(deps, remote, new FakeZone());
    expect(commands.some((c) => c.includes("openssl"))).toBe(false);
  });
});

describe("secure's certificate warnings (FR-1406, FR-1445)", () => {
  it("warns below 30 days on a DNS-only certificate with certbot's reason, read from the server", async () => {
    const deps = await setup(deployedPlan({ proxied: false, edge: "nginx" }));
    const { remote } = server({
      site: sClient(certificate("R13", 20)),
      certbot: "Failed to renew certificate shop with error: Some challenges have failed.",
    });
    const result = await secure(deps, remote);
    const check = find(result.hostChecks, "certificate-shop.example.com");
    expect(check).toMatchObject({ status: "warn" });
    expect(check.message).toContain("(20 days left) and has not been renewed");
    expect(check.remediation).toContain(
      "certbot's last renewal said: Some challenges have failed. Check",
    );
  });

  it("warns when the record's client certificate nears its expiry, with the manual steps", async () => {
    const deps = await setup(deployedPlan());
    const tls = defaultTls();
    if (tls.client) tls.client.expiresAt = "2026-11-01T00:00:00.000Z";
    await writeCloudflareRecord(deps.paths, record(tls));
    const result = await secure(deps, server().remote, new FakeZone());
    const check = find(result.settings, "origin-tls-certificates");
    expect(check.status).toBe("warn");
    expect(check.message).toContain(
      "This app's client certificate for Cloudflare's origin pulls expires on 2026-11-01, and OpsCrew does not replace it by itself",
    );
    expect(result.report).toContain("## TLS and the secrets copy");
  });
});

describe("secure's Cloudflare and secrets copy checks", () => {
  it("reports the permission gap and the zone's minimum TLS advice", async () => {
    const deps = await setup(deployedPlan());
    await writeCloudflareRecord(deps.paths, { ...record(undefined), tls: { gap: "permission" } });
    const zone = new FakeZone();
    zone.addDnsRecord({ type: "A", name: "blog.example.com", proxied: true });
    const result = await secure(deps, server().remote, zone);
    expect(find(result.settings, "origin-tls-permission")).toMatchObject({
      status: "warn",
      remediation:
        "Edit the token at https://dash.cloudflare.com/profile/api-tokens and give it Zone → SSL and Certificates → Edit for this zone, then run `opscrew provision`.",
    });
    const minTls = find(result.settings, "min-tls");
    expect(minTls.status).toBe("warn");
    expect(minTls.message).toContain("blog.example.com");
    expect(zone.writes()).toEqual([]);
  });

  it("reports CAA records that are not OpsCrew's, and advises CAA for a DNS-only app on the apex", async () => {
    const sub = await setup(deployedPlan({ proxied: false }));
    await writeCloudflareRecord(sub.paths, record(undefined));
    const zone = new FakeZone();
    zone.dnsRecords.push(
      { id: "1", type: "CAA", name: "shop.example.com", content: '0 issue "digicert.com"', ttl: 1 },
      {
        id: "2",
        type: "CAA",
        name: "shop.example.com",
        content: '0 issue "letsencrypt.org"',
        ttl: 1,
        comment: "Managed by OpsCrew",
      },
    );
    const result = await secure(sub, server().remote, zone);
    const caa = find(result.settings, "caa-records");
    expect(caa.status).toBe("warn");
    expect(caa.message).toBe(
      'Cloudflare has CAA records at shop.example.com that OpsCrew did not create (0 issue "digicert.com"). OpsCrew leaves them as they are.',
    );
    expect(caa.remediation).toContain("letsencrypt.org");

    const apex = DeployPlanSchema.parse({
      ...deployedPlan({ proxied: false }),
      dns: { ...deployedPlan({ proxied: false }).dns, domain: "example.com" },
    });
    const top = await setup(apex);
    await writeCloudflareRecord(top.paths, record(undefined));
    const advice = find((await secure(top, server().remote, new FakeZone())).settings, "caa-apex");
    expect(advice.status).toBe("warn");
    expect(advice.message).toBe(
      "OpsCrew writes no CAA record at example.com, the zone's apex, because one there applies to every name in the zone.",
    );
  });

  it("skips the Cloudflare reads without a token", async () => {
    const deps = await setup(deployedPlan());
    await writeCloudflareRecord(deps.paths, record());
    const result = await secure(deps, server().remote);
    expect(find(result.settings, "cloudflare-settings").status).toBe("skip");
  });

  it("warns about a repository that became public with the copy in it", async () => {
    const repo = { private: false };
    const github: FetchLike = async (input) => {
      expect(String(input)).toBe("https://api.github.com/repos/acme/shop");
      return Response.json({ default_branch: "main", ...repo });
    };
    const deps = await setup(deployedPlan(), { fetch: github, github: true });
    const copy = join(deps.paths.root, COPY_PATH);
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(copy, '{"files":{},"sops":{"age":[{}]}}\n');
    const public_ = find((await secure(deps, server().remote)).settings, "secrets-copy-repository");
    expect(public_).toMatchObject({ status: "warn", severity: "high" });
    expect(public_.message).toContain(
      "The repository became public with the encrypted secrets copy in it",
    );
    repo.private = true;
    expect(
      find((await secure(deps, server().remote)).settings, "secrets-copy-repository").status,
    ).toBe("pass");
  });
});

describe("secure's Valkey check (FR-1450)", () => {
  it("passes Valkey refusing an unauthenticated PING, and fails one that answers", async () => {
    const deps = await setup(deployedPlan({ valkey: true }));
    const refused = await secure(deps, server().remote);
    expect(find(refused.hostChecks, "service-cache-auth")).toMatchObject({ status: "pass" });
    const open = await secure(deps, server({ ping: "PONG" }).remote);
    expect(find(open.hostChecks, "service-cache-auth")).toMatchObject({
      status: "fail",
      severity: "high",
    });
  });
});

describe("secure's leak check (FR-1461)", () => {
  it("never puts the origin TLS keys in the report or the output", async () => {
    const deps = await setup(deployedPlan());
    await writeCloudflareRecord(deps.paths, record());
    const originKey = generateP256().privateKey;
    const pullKey = generateP256().privateKey;
    const values = generatedValuesFile(deps);
    await mkdir(dirname(values), { recursive: true });
    await writeFile(
      values,
      JSON.stringify({ originTls: { ORIGIN_TLS_KEY: originKey, ORIGIN_PULL_KEY: pullKey } }),
    );
    const result = await secure(deps, server().remote, new FakeZone());
    const output = [result.report, result.summary, ...deps.reporter.lines.map((l) => l.message)];
    for (const text of output) {
      for (const key of [originKey, pullKey]) expect(text).not.toContain(key.split("\n")[1]);
    }
    expect(JSON.stringify(deps.audit.entries)).not.toContain(originKey.split("\n")[1]);
  });
});
