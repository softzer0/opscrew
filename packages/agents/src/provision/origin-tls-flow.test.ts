import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SharedRecord } from "@opscrew/connector-cloudflare";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, fingerprintSha256 } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  planJsonFor,
  projectRunner,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { readOriginTlsValues } from "./origin-tls";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const SITE = "opscrew/runtime/edge/sites/shop.caddy";
const PULL_PEM = "opscrew/runtime/edge/tls/pull.pem";
const TFVARS = "opscrew/infra/prod/terraform.tfvars.json";

/** What the server's edge holds for the app, as `opscrew provision` reads it over SSH. */
interface ServerState {
  /** The server cannot be reached over SSH. */
  down?: boolean;
  proxy: "caddy" | "nginx" | undefined;
  origin: string;
  site: string;
}

/** A Hetzner project with a proxied domain, its Cloudflare zone and a server the run can read. */
async function project(o: { plan?: DeployPlan; zone?: FakeZone; byHash?: string[] } = {}) {
  const created = await createProject(o.plan ?? testPlan({ domain: "shop.example.com" }));
  await writeFile(
    join(created.root, "production.env"),
    `STRIPE_SECRET_KEY=${fakeSecret("stripe-live-key")}\n`,
  );
  const zone = o.zone ?? new FakeZone();
  const engine = new FakeEngine({ planJson: planJsonFor({ proxied: true }) });
  const requests: ApprovalRequest[] = [];
  // With hashes in `byHash`, like the CLI's non-interactive handler: Cloudflare and
  // infrastructure plans only by the hashes given (an empty list approves every plan).
  const handler = new ScriptedApprovalHandler((request) => {
    requests.push(request);
    const plans = request.kind === "cloudflare-apply" || request.kind === "iac-apply";
    const by = o.byHash ?? [];
    return by.length === 0 || !plans || by.includes(request.planHash ?? "");
  });
  const deps = await createTestPhaseDeps({
    root: created.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(created.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const github = new FakeGitHub();
  const server: ServerState = { proxy: undefined, origin: "", site: "" };
  const reads: string[] = [];
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command) => {
      if (!command.includes("opscrew-edge-read 1")) {
        return { exitCode: 0, stdout: "ready\n", stderr: "" };
      }
      reads.push(command);
      if (server.down) return { exitCode: 255, stdout: "", stderr: "Connection timed out" };
      return {
        exitCode: 0,
        stdout: `opscrew-edge-read 1\nproxy=${server.proxy ?? "none"}\n--origin--\n${server.origin}--site--\n${server.site}--end--\n`,
        stderr: "",
      };
    },
  });
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  const s = { ...created, deps, engine, github, handler, requests, services, zone, server, reads };
  return s;
}

type Project = Awaited<ReturnType<typeof project>>;

const kinds = (s: Project) => s.requests.map((r) => r.kind);
const repo = (s: Project, path: string) => readFile(join(s.root, path), "utf8");
const record = async (s: Project) =>
  JSON.parse(await readFile(s.deps.paths.files.cloudflareRecord, "utf8")) as SharedRecord;

/** Another run while the first run's pull request is still open. */
async function again(s: Project) {
  s.requests.length = 0;
  s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
  return runProvision(s.deps, { services: s.services });
}

/** The deploy of the committed files: the server serves what the deploy secret and site hold. */
async function deploy(s: Project) {
  const secret = s.github.secrets.get("OPSCREW_ORIGIN_TLS") ?? "";
  const site = await repo(s, SITE);
  s.server.proxy = "caddy";
  s.server.site = site;
  // A deploy without origin TLS removes /srv/edge/tls/<app>/.
  s.server.origin = site.includes("client_auth")
    ? secret.slice(0, secret.indexOf("-----BEGIN PRIVATE KEY-----"))
    : "";
}

/** Everything a run printed, recorded, committed or asked, to search for keys. */
async function everything(s: Project): Promise<string> {
  const plans = s.deps.paths.files.plansDir;
  const saved = await readdir(plans).catch(() => [] as string[]);
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.requests),
    await readFile(s.deps.paths.files.cloudflareRecord, "utf8"),
    await readFile(s.deps.paths.files.plan, "utf8"),
    await s.git(s.root, "show", "HEAD"),
    ...(await Promise.all(saved.map((file) => readFile(join(plans, file), "utf8")))),
  ].join("\n");
}

describe.skipIf(!findExecutable("git"))("opscrew provision: the app's origin TLS", () => {
  it("first provision: client certificate, origin certificate and minimum TLS in one approved plan; the deploy brings the files", async () => {
    const s = await project();
    const result = await runProvision(s.deps, { services: s.services });

    // One Cloudflare plan, approved by its hash before anything else changes.
    expect(kinds(s)[0]).toBe("cloudflare-apply");
    const approval = s.requests[0];
    expect(approval?.details).toContain("Upload this app's client certificate to Cloudflare");
    expect(approval?.details).toContain(
      "Turn on this app's client certificate for shop.example.com",
    );
    expect(approval?.details).toContain(
      "Create a Cloudflare origin certificate for shop.example.com (15 years)",
    );
    expect(approval?.details).toContain("Raise the zone's minimum TLS version from 1.0 to 1.2");
    expect(approval?.planHash).toBe(result.cloudflarePlanHash);

    // Cloudflare: the client certificate on for the hostname, the origin certificate, TLS 1.2.
    const client = s.zone.clientCertificates[0];
    expect(s.zone.hostnameAop.get("shop.example.com")).toMatchObject({
      cert_id: client?.id,
      enabled: true,
    });
    expect(s.zone.originCertificates.map((c) => c.hostnames)).toEqual([["shop.example.com"]]);
    expect(s.zone.minTls.value).toBe("1.2");

    // The keys are generated values; the certificates are recorded by fingerprint.
    const values = await readOriginTlsValues(s.deps);
    const issued = s.zone.originCertificates[0]?.certificate as string;
    expect(values.ORIGIN_TLS_CERT).toBe(issued);
    expect(values.ORIGIN_TLS_KEY).toContain("BEGIN PRIVATE KEY");
    expect(values.ORIGIN_PULL_KEY).toContain("BEGIN PRIVATE KEY");
    expect(values.ORIGIN_TLS_REQUEST).toBeUndefined();
    expect((await record(s)).tls).toMatchObject({
      origin: { sha256: fingerprintSha256(issued), hostnames: ["shop.example.com"] },
      client: {
        sha256: fingerprintSha256(values.ORIGIN_PULL_CERT as string),
        enabled: ["shop.example.com"],
      },
    });

    // The site serves the origin certificate and requires the client certificate; the deploy
    // writes the certificate and its key from the deploy secret, and pull.pem is committed.
    const site = await repo(s, SITE);
    expect(site).toContain("tls /etc/caddy/tls/shop/origin.pem /etc/caddy/tls/shop/origin.key");
    expect(site).toContain("client_auth");
    expect(await repo(s, PULL_PEM)).toBe(values.ORIGIN_PULL_CERT);
    expect(await repo(s, ".github/workflows/opscrew-deploy.yml")).toContain("OPSCREW_ORIGIN_TLS");
    expect(s.github.secrets.get("OPSCREW_ORIGIN_TLS")).toBe(
      `${values.ORIGIN_TLS_CERT}${values.ORIGIN_TLS_KEY}`,
    );
    const committed = await s.git(s.root, "show", "--name-only", "HEAD");
    expect(committed).toContain(PULL_PEM);

    // No private key anywhere OpsCrew writes, prints or commits.
    const all = await everything(s);
    for (const key of [values.ORIGIN_TLS_KEY, values.ORIGIN_PULL_KEY] as string[]) {
      expect(all).not.toContain(key);
      expect(all).not.toContain(key.split("\n")[1]);
    }
    expect(all).not.toContain("PRIVATE KEY-----\n");
    // No renewal, so no deploy is started: merging the pull request deploys.
    expect(s.github.dispatches).toEqual([]);
  });

  it("--plan-only, then --approve with both hashes: the first origin TLS keeps its hash, and the files of the --plan-only run stay", async () => {
    const byHash: string[] = [];
    const s = await project({ byHash });
    const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
    const cloudflare = planned.cloudflarePlanHash as string;
    const infrastructure = planned.planHash as string;
    expect(cloudflare).toMatch(/^[0-9a-f]{64}$/);
    expect(s.zone.writes()).toEqual([]);
    // The request the plan creates the certificate from is kept for the approved run.
    expect((await readOriginTlsValues(s.deps)).ORIGIN_TLS_REQUEST).toBeDefined();

    byHash.push(cloudflare, infrastructure);
    s.requests.length = 0;
    const result = await runProvision(s.deps, {
      services: s.services,
      approveHashes: [cloudflare, infrastructure],
    });
    expect(result).toMatchObject({ applied: true, planHash: infrastructure });
    expect(s.requests.find((r) => r.kind === "cloudflare-apply")?.planHash).toBe(cloudflare);
    expect(s.zone.originCertificates).toHaveLength(1);
    const values = await readOriginTlsValues(s.deps);
    expect(values.ORIGIN_TLS_CERT).toBe(s.zone.originCertificates[0]?.certificate);
    expect(values.ORIGIN_TLS_REQUEST).toBeUndefined();
    // The files are the --plan-only run's: origin TLS reaches the site with the next run.
    expect(await repo(s, SITE)).not.toContain("client_auth");
    byHash.length = 0;
    await again(s);
    expect(await repo(s, SITE)).toContain("client_auth");
    expect(await repo(s, PULL_PEM)).toBe(values.ORIGIN_PULL_CERT);
  });

  it("an idempotent rerun makes no new certificate and asks nothing in Cloudflare", async () => {
    const s = await project();
    await runProvision(s.deps, { services: s.services });
    const before = await readOriginTlsValues(s.deps);
    await deploy(s);
    await again(s);
    expect(kinds(s)).not.toContain("cloudflare-apply");
    expect(s.zone.originCertificates).toHaveLength(1);
    expect(s.zone.clientCertificates).toHaveLength(1);
    expect(await readOriginTlsValues(s.deps)).toEqual(before);
    expect(s.github.dispatches).toEqual([]);
    // The run read what the server serves (read-only, as deploy).
    expect(s.reads).toHaveLength(1);
  });

  it("renews a certificate with fewer than 30 days left, starts the deploy, then revokes the old one once the server serves the new", async () => {
    const s = await project();
    await runProvision(s.deps, { services: s.services });
    await deploy(s);
    const old = await record(s);
    const oldId = old.tls?.origin?.id as string;
    const oldKey = (await readOriginTlsValues(s.deps)).ORIGIN_TLS_KEY;
    // 29 days before its expiry (the test clock is 2026-10-11T12:00Z).
    const tls = old.tls as NonNullable<SharedRecord["tls"]>;
    await writeFile(
      s.deps.paths.files.cloudflareRecord,
      JSON.stringify({
        ...old,
        tls: { ...tls, origin: { ...tls.origin, expiresAt: "2026-11-09T12:00:00.000Z" } },
      }),
    );

    await again(s);
    const approval = s.requests.find((r) => r.kind === "cloudflare-apply");
    expect(approval?.details).toContain(
      "Create a Cloudflare origin certificate for shop.example.com (15 years)",
    );
    // The approval names the deploy that brings the new certificate.
    expect(approval?.details).toContain(
      "OpsCrew starts the deploy workflow (opscrew-deploy.yml on main)",
    );
    expect(s.github.dispatches).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
    const renewed = await readOriginTlsValues(s.deps);
    expect(renewed.ORIGIN_TLS_KEY).not.toBe(oldKey);
    expect(s.github.secrets.get("OPSCREW_ORIGIN_TLS")).toBe(
      `${renewed.ORIGIN_TLS_CERT}${renewed.ORIGIN_TLS_KEY}`,
    );
    expect((await record(s)).tls?.origin?.superseded).toEqual([oldId]);

    // The server still serves the old one: it is not revoked yet.
    await again(s);
    expect(s.zone.originCertificates.find((c) => c.id === oldId)?.revoked_at).toBeUndefined();

    // Once the deploy has brought the new one, the old one is revoked.
    await deploy(s);
    await again(s);
    expect(s.zone.originCertificates.find((c) => c.id === oldId)?.revoked_at).toBeDefined();
    expect((await record(s)).tls?.origin?.superseded).toEqual([]);
  });

  it("a server it cannot read: the clean-up waits, the plan says so, and the run goes on", async () => {
    const s = await project();
    await runProvision(s.deps, { services: s.services });
    await deploy(s);
    const old = await record(s);
    const tls = old.tls as NonNullable<SharedRecord["tls"]>;
    await writeFile(
      s.deps.paths.files.cloudflareRecord,
      JSON.stringify({
        ...old,
        tls: { ...tls, origin: { ...tls.origin, expiresAt: "2026-11-09T12:00:00.000Z" } },
      }),
    );
    await again(s);
    const oldId = tls.origin?.id as string;
    // The server has the new certificate, but cannot be read: the old one is not revoked.
    await deploy(s);
    s.server.down = true;
    const result = await again(s);
    expect(result.prUrl).toBe(OPEN_PULL.url);
    expect(s.zone.originCertificates.find((c) => c.id === oldId)?.revoked_at).toBeUndefined();
    expect(s.deps.reporter.text()).toContain(
      "OpsCrew could not read what your server serves now, so the origin certificates it replaced",
    );
    // No proxy switch is planned on a guess either.
    expect(s.deps.reporter.text()).not.toContain("switches the server's proxy");
  });

  it("a changed hostname set: a new certificate for exactly the new hostnames, and the client certificate turned on for the added one", async () => {
    const s = await project({ plan: testPlan({ domain: "example.com" }) });
    await runProvision(s.deps, { services: s.services });
    await deploy(s);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...plan,
      dns: { ...plan.dns, www: true },
    });
    await again(s);
    expect(s.zone.originCertificates.map((c) => c.hostnames)).toEqual([
      ["example.com"],
      ["example.com", "www.example.com"],
    ]);
    expect(s.zone.hostnameAop.get("www.example.com")?.enabled).toBe(true);
    expect(s.zone.clientCertificates).toHaveLength(1);
    const site = await repo(s, SITE);
    expect(site).toContain("example.com, www.example.com {");
    expect(site).toContain("client_auth");
    // Only the hostnames changed, so merging the pull request deploys: no extra deploy.
    expect(s.github.dispatches).toEqual([]);
  });

  it("a token without the certificate permission keeps today's site, records the gap and goes on", async () => {
    const zone = new FakeZone();
    zone.denied.add("ssl");
    const s = await project({ zone });
    const result = await runProvision(s.deps, { services: s.services });
    expect(result.prUrl).toBe(OPEN_PULL.url);
    expect(s.deps.reporter.text()).toContain("Zone → SSL and Certificates → Edit");
    expect((await record(s)).tls).toEqual({ gap: "permission" });
    const site = await repo(s, SITE);
    expect(site).not.toContain("client_auth");
    expect(s.github.secrets.has("OPSCREW_ORIGIN_TLS")).toBe(false);
    expect(await repo(s, ".github/workflows/opscrew-deploy.yml")).not.toContain(
      "OPSCREW_ORIGIN_TLS",
    );
  });

  it("a hostname leaving the proxy takes two runs: the requirement goes first, then the setting and the record", async () => {
    const s = await project();
    await runProvision(s.deps, { services: s.services });
    await deploy(s);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact("plan", s.deps.paths.files.plan, {
      ...plan,
      dns: { ...plan.dns, proxied: false },
    });

    // First run: the DNS record stays proxied, the site drops the requirement, nothing is turned
    // off at Cloudflare yet; plan.yaml keeps the user's choice.
    await again(s);
    expect(JSON.parse(await repo(s, TFVARS)).proxied).toBe(true);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).dns.proxied).toBe(false);
    expect(await repo(s, SITE)).not.toContain("client_auth");
    expect(s.zone.hostnameAop.get("shop.example.com")?.enabled).toBe(true);
    expect(s.deps.reporter.text()).toContain(
      "shop.example.com left Cloudflare's proxy. Once the deploy has given the server its public certificate, run `opscrew provision` again",
    );

    // Not deployed yet: the server still requires it, so the second run waits too.
    await again(s);
    expect(s.zone.hostnameAop.get("shop.example.com")?.enabled).toBe(true);

    // Deployed: the setting goes, the client certificate is deleted, the origin certificate
    // revoked, and the DNS record is DNS only.
    await deploy(s);
    await again(s);
    expect(s.zone.hostnameAop.get("shop.example.com")?.enabled).toBeNull();
    expect(s.zone.clientCertificates[0]?.status).toBe("pending_deletion");
    expect(s.zone.originCertificates[0]?.revoked_at).toBeDefined();
    expect((await record(s)).tls).toBeUndefined();
    expect(JSON.parse(await repo(s, TFVARS)).proxied).toBe(false);
  });

  it("a server OpsCrew created holds only this app: another proxy is planned, with its interruption", async () => {
    const s = await project();
    await runProvision(s.deps, { services: s.services });
    await deploy(s);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeArtifact(
      "plan",
      s.deps.paths.files.plan,
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge: "nginx" } }),
    );
    await again(s);
    const said =
      "The deploy after this run switches the server's proxy from Caddy to nginx: the site is interrupted for a few seconds";
    expect(s.deps.reporter.text()).toContain(said);
    expect(s.requests.find((r) => r.kind === "iac-apply")?.details).toContain(said);
    expect(await repo(s, "opscrew/runtime/edge/sites/shop.conf")).toContain(
      "ssl_verify_client on;",
    );
  });
});
