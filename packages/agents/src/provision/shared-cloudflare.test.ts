import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyShared,
  CloudflareClient,
  inspectShared,
  planShared,
  type SharedChange,
  type SharedPlan,
  type SharedRecord,
} from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest, FetchLike } from "@opscrew/contracts";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
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
  ownPlan,
  planJsonFor,
  portainerPlan,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import { describeCloudflarePlan, sharedDesired, zeroTrustAuthDomain } from "./shared-cloudflare";
import type { ProvisionServices } from "./types";

const WAF = "http_request_firewall_custom";
const CONFIG = "http_config_settings";
const BLOCK = "opscrew-block-probes";
const TLS = "opscrew-strict-tls";
const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };

const both = (hosts: string[]) => ({ [BLOCK]: hosts, [TLS]: hosts });

/** Another OpsCrew app in the zone: its hostnames in both shared rules, as its provision did. */
async function otherApp(zone: FakeZone, hostnames: string[]): Promise<void> {
  const client = fakeSharedCloudflare(zone);
  const facts = await inspectShared(client, {
    zoneId: FAKE_ZONE_ID,
    accountId: FAKE_ACCOUNT_ID,
    access: false,
  });
  const plan = planShared(facts, { hostnames: both(hostnames) }, undefined);
  expect(plan.findings).toEqual([]);
  await applyShared(client, plan, { approvedHash: plan.hash });
}

/** A Hetzner project whose OpsCrew rules live in `zone` (a new, empty one by default). */
async function hetzner(
  o: {
    plan?: DeployPlan;
    zone?: FakeZone;
    client?: CloudflareClient;
    answer?: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
  } = {},
) {
  const project = await createProject(o.plan ?? testPlan({ domain: "shop.example.com" }));
  await writeFile(
    join(project.root, "production.env"),
    `STRIPE_SECRET_KEY=${fakeSecret("stripe-live-key")}\n`,
  );
  const zone = o.zone ?? new FakeZone();
  const engine = new FakeEngine({ planJson: planJsonFor({ proxied: true }) });
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const github = new FakeGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: o.client ?? fakeSharedCloudflare(zone),
  };
  return { ...project, deps, engine, handler, github, services, zone };
}

type Hetzner = Awaited<ReturnType<typeof hetzner>>;

const kinds = (s: Hetzner) => s.handler.requests.map((r) => r.kind);
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as OpsCrewError,
  );
const record = async (s: Hetzner) =>
  JSON.parse(await readFile(s.deps.paths.files.cloudflareRecord, "utf8")) as SharedRecord;

describe("sharedDesired: which shared rules get the app's hostnames, as the IaC rules did", () => {
  const access = (oneTimePin: boolean) => ({
    access: { authDomain: zeroTrustAuthDomain("example.com"), oneTimePin },
  });
  const hosts = ["shop.example.com"];
  const withPortainer = (plan: DeployPlan) =>
    DeployPlanSchema.parse({
      ...plan,
      dns: { ...plan.dns, zone: "example.com" },
      portainer: {
        enabled: true,
        version: "2.45.2",
        access: "subdomain",
        hostname: "portainer.example.com",
        allowedEmails: ["owner@example.com"],
      },
    });
  const noWaf = (plan: DeployPlan) => ({
    ...plan,
    security: { ...plan.security, wafCustomRules: false },
  });

  it.each([
    ["Hetzner", testPlan({ domain: "shop.example.com" }), { hostnames: both(hosts) }],
    [
      "DigitalOcean, apex and www",
      testPlan({ provider: "digitalocean", domain: "example.com", www: true }),
      { hostnames: both(["example.com", "www.example.com"]) },
    ],
    [
      "Hetzner without WAF rules: strict TLS only",
      noWaf(testPlan({ domain: "shop.example.com" })),
      { hostnames: { [BLOCK]: [], [TLS]: hosts } },
    ],
    [
      "Hetzner with Portainer on a subdomain: the one-time PIN login",
      withPortainer(testPlan({ domain: "shop.example.com" })),
      { hostnames: both(hosts), ...access(true) },
    ],
    ["an own server in public mode", ownPlan(), { hostnames: both(hosts) }],
    [
      "an own server in tunnel mode: the block only, and Access for SSH",
      ownPlan({ access: "tunnel" }),
      { hostnames: { [BLOCK]: hosts, [TLS]: [] }, ...access(false) },
    ],
    [
      "an own server with Portainer on a subdomain",
      ownPlan({ portainer: "subdomain" }),
      { hostnames: both(hosts), ...access(true) },
    ],
    [
      "the user's Portainer serving the app through its tunnel: the block only",
      portainerPlan(),
      { hostnames: { [BLOCK]: hosts, [TLS]: [] } },
    ],
    [
      "the user's Portainer behind its own proxy, redeploys through Cloudflare: Access only",
      portainerPlan({ web: { mode: "proxy", port: 8080 }, redeploy: "cloudflare" }),
      { hostnames: { [BLOCK]: [], [TLS]: [] }, ...access(false) },
    ],
  ] as const)("%s", (_, plan, desired) => {
    expect(sharedDesired(plan, "example.com")).toEqual(desired);
  });
});

describe("the Cloudflare plan in words: origin TLS, the zone's minimum TLS and advice", () => {
  const HOSTS = ["app.example.com", "www.app.example.com"];
  const FINGERPRINT = "b".repeat(64);
  const plan = (changes: SharedChange[], advice: SharedPlan["advice"] = []): SharedPlan => ({
    zoneId: FAKE_ZONE_ID,
    accountId: FAKE_ACCOUNT_ID,
    changes,
    expect: {},
    findings: [],
    previous: undefined,
    record: { zoneId: FAKE_ZONE_ID, hostnames: {}, createdEntrypoints: [] },
    advice,
    hash: "a".repeat(64),
  });
  const text = (changes: SharedChange[], advice?: SharedPlan["advice"]) =>
    describeCloudflarePlan(plan(changes, advice), { hostnames: {} }, "example.com");

  /** Each change with the line that says what it does. */
  const CHANGES: [SharedChange, string][] = [
    [
      { kind: "upload-client-certificate", sha256: FINGERPRINT },
      `  ~ Upload this app's client certificate to Cloudflare (SHA-256 ${FINGERPRINT})`,
    ],
    [
      { kind: "enable-client-certificate", hostnames: HOSTS, sha256: FINGERPRINT },
      `  ~ Turn on this app's client certificate for app.example.com, www.app.example.com (SHA-256 ${FINGERPRINT})`,
    ],
    [
      { kind: "create-origin-certificate", hostnames: HOSTS, csrSha256: "c".repeat(64) },
      "  ~ Create a Cloudflare origin certificate for app.example.com, www.app.example.com (15 years)",
    ],
    [
      { kind: "disable-client-certificate", hostnames: ["old.example.com"] },
      "  ~ Turn off this app's client certificate for old.example.com",
    ],
    [
      { kind: "delete-client-certificate", id: "client-1" },
      "  ~ Delete this app's client certificate from Cloudflare",
    ],
    [
      { kind: "revoke-origin-certificate", id: "origin-1" },
      "  ~ Revoke an origin certificate of this app that the server no longer serves",
    ],
    [
      { kind: "set-min-tls", from: "1.0", to: "1.2" },
      "  ~ Raise the zone's minimum TLS version from 1.0 to 1.2",
    ],
  ];

  it.each(CHANGES.map(([change, line]) => [change.kind, change, line] as const))(
    "says what %s does, with its reason",
    (_, change, line) => {
      const lines = text([change]).split("\n");
      expect(lines[0]).toBe("Cloudflare plan for example.com: 1 to change, 0 already in place.");
      expect(lines[1]).toBe(line);
      // The reason, indented under the change.
      expect(lines[2]).toMatch(/^ {6}\S/);
      expect(lines.at(-1)).toBe(`Cloudflare plan hash: ${"a".repeat(64)}`);
    },
  );

  it("lists the changes in the plan's order and shows no id or CSR fingerprint", () => {
    const shown = text(CHANGES.map(([change]) => change));
    expect(shown).toContain("Cloudflare plan for example.com: 7 to change, 0 already in place.");
    const titles = shown.split("\n").filter((line) => line.startsWith("  ~ "));
    expect(titles).toEqual(CHANGES.map(([, line]) => line));
    for (const hidden of ["client-1", "origin-1", "c".repeat(64)]) {
      expect(shown).not.toContain(hidden);
    }
  });

  it("shows each advice with its next step, apart from the changes, and never as a stop", () => {
    const advice: SharedPlan["advice"] = [
      {
        code: "tls-permission-missing",
        message: "The Cloudflare token may not manage origin certificates.",
        hint: "Give the token SSL and Certificates: Edit, then run provision again.",
      },
      {
        code: "min-tls-advised",
        message: "The zone still accepts TLS 1.0 and 1.1.",
        hint: "Raise the minimum TLS version to 1.2 in the Cloudflare dashboard.",
      },
    ];
    const lines = text([], advice).split("\n");
    expect(lines[0]).toBe("Cloudflare plan for example.com: 0 to change, 0 already in place.");
    expect(lines.slice(1, 5)).toEqual([
      "  Advice: The Cloudflare token may not manage origin certificates.",
      "      Give the token SSL and Certificates: Edit, then run provision again.",
      "  Advice: The zone still accepts TLS 1.0 and 1.1.",
      "      Raise the minimum TLS version to 1.2 in the Cloudflare dashboard.",
    ]);
    expect(lines.join("\n")).not.toContain("  ! ");
  });
});

describe.skipIf(!findExecutable("git"))(
  "opscrew provision: OpsCrew's shared Cloudflare rules",
  () => {
    it("stops before any change when another app already has this app's hostname in the shared rules", async () => {
      const zone = new FakeZone();
      await otherApp(zone, ["shop.example.com"]);
      const writes = zone.writes().length;
      const s = await hetzner({ zone });
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect(error?.message).toContain(
        "OpsCrew cannot apply the Cloudflare plan, so it changed nothing:",
      );
      expect(error?.message).toContain(
        `shop.example.com is already in OpsCrew's shared rule "OpsCrew: block probes for secrets and admin panels" in this zone, but this app did not add it`,
      );
      expect(error?.hint).toContain("OpsCrew never takes a hostname from another app.");
      expect(kinds(s)).toEqual([]);
      expect(s.engine.calls).toEqual([]);
      expect(zone.writes()).toHaveLength(writes);
      await expect(readFile(s.deps.paths.files.cloudflareRecord, "utf8")).rejects.toThrow();
    });

    it("stops before any change when this app's hostname would push a shared rule over Cloudflare's expression limit", async () => {
      const zone = new FakeZone();
      const facts = await inspectShared(fakeSharedCloudflare(zone), {
        zoneId: FAKE_ZONE_ID,
        accountId: FAKE_ACCOUNT_ID,
        access: false,
      });
      const names = (count: number) =>
        Array.from({ length: count }, (_, i) => `app-${String(i).padStart(3, "0")}.example.com`);
      let count = 0;
      while (
        planShared(facts, { hostnames: both(names(count + 1)) }, undefined).findings.length === 0
      ) {
        count++;
      }
      await otherApp(zone, names(count));
      const writes = zone.writes().length;
      const s = await hetzner({
        zone,
        plan: testPlan({ domain: "a-hostname-long-enough-to-pass-the-limit.example.com" }),
      });
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect(error?.message).toContain("over Cloudflare's limit of 4,096");
      expect(error?.message).toContain(`It already lists ${count} hostnames.`);
      expect(kinds(s)).toEqual([]);
      expect(s.engine.calls).toEqual([]);
      expect(zone.writes()).toHaveLength(writes);
    });

    it("a plan made stale by another app between its approval and its apply changes nothing; the next run plans again", async () => {
      const zone = new FakeZone();
      await otherApp(zone, ["api.example.com"]);
      let raced = false;
      const s = await hetzner({
        zone,
        answer: (request) => {
          if (request.kind === "cloudflare-apply" && !raced) {
            raced = true;
            // Another app adds its hostname to the block rule while this one is being approved.
            const rule = zone.opscrewRule(WAF) as Record<string, unknown>;
            rule.expression = String(rule.expression).replace(
              '{"api.example.com"}',
              '{"api.example.com" "beta.example.com"}',
            );
          }
          return true;
        },
      });
      const writes = zone.writes().length;
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect(error?.message).toContain(
        "changed after this Cloudflare plan was made: another OpsCrew app added or removed hostnames in OpsCrew's rule. OpsCrew changed nothing.",
      );
      expect(error?.hint).toContain("Run the command again to make a new plan");
      expect(zone.writes()).toHaveLength(writes);
      expect(s.engine.calls).toEqual([]);
      expect(kinds(s)).toEqual(["cloudflare-apply"]);
      expect(s.deps.audit.entries).toContainEqual(
        expect.objectContaining({
          action: "cloudflare apply failed",
          detail: "changes applied before the failure: none",
        }),
      );

      await runProvision(s.deps, { services: s.services });
      expect(zone.opscrewRule(CONFIG)?.expression).toBe(
        '(http.host in {"api.example.com" "shop.example.com"})',
      );
      expect(String(zone.opscrewRule(WAF)?.expression)).toContain(
        '(http.host in {"api.example.com" "beta.example.com" "shop.example.com"})',
      );
      expect((await record(s)).hostnames).toEqual(both(["shop.example.com"]));
    });

    it("--plan-only shows the Cloudflare plan; the infrastructure plan follows the one-time PIN login, each approved by its hash", async () => {
      const plan = testPlan({ domain: "shop.example.com" });
      const approved: string[] = [];
      const s = await hetzner({
        plan: DeployPlanSchema.parse({
          ...plan,
          dns: { ...plan.dns, zone: "example.com" },
          portainer: {
            enabled: true,
            version: "2.45.2",
            access: "subdomain",
            hostname: "portainer.example.com",
            allowedEmails: ["owner@example.com"],
          },
        }),
        // Like the CLI's non-interactive handler: Cloudflare and infrastructure plans by hash only.
        answer: (request) =>
          request.kind === "cloudflare-apply" || request.kind === "iac-apply"
            ? approved.includes(request.planHash ?? "")
            : true,
      });

      const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
      const cloudflareHash = planned.cloudflarePlanHash as string;
      expect(cloudflareHash).toMatch(/^[0-9a-f]{64}$/);
      // It only adds: no typed app name.
      expect(planned.cloudflarePlanDeletes).toBeUndefined();
      expect(planned.planHash).toBeUndefined();
      const text = s.deps.reporter.text();
      // The rules, Zero Trust, the app's origin TLS and the zone's minimum TLS.
      expect(text).toContain("Cloudflare plan for example.com: 8 to change, 0 already in place.");
      expect(text).toContain(`Cloudflare plan hash: ${cloudflareHash}`);
      expect(text).toContain(
        `The infrastructure plan follows once this Cloudflare plan is applied, because it needs the one-time PIN login the Cloudflare plan adds (in scripts: run \`opscrew provision --approve ${cloudflareHash}\`, then again with \`--approve\` and the infrastructure plan's hash).`,
      );
      expect(kinds(s)).toEqual([]);
      expect(s.engine.calls).toEqual([]);
      expect(s.zone.writes()).toEqual([]);

      // The Cloudflare plan's hash: it is applied, then the infrastructure plan waits for its own.
      approved.push(cloudflareHash);
      const refused = await failure(
        runProvision(s.deps, { services: s.services, approveHashes: [cloudflareHash] }),
      );
      expect(refused?.code).toBe("APPROVAL_REFUSED");
      const iacHash = s.handler.requests.find((r) => r.kind === "iac-apply")?.planHash as string;
      expect(refused?.hint).toBe(
        `To apply it later without prompts, run: opscrew provision --approve ${iacHash}`,
      );
      expect(s.zone.organization?.auth_domain).toBe(zeroTrustAuthDomain("example.com"));
      expect(s.zone.providers).toHaveLength(1);
      expect(s.engine.applied).toHaveLength(0);

      // Both hashes again: the Cloudflare plan is done (nothing to ask); the saved plan is applied.
      approved.push(iacHash);
      s.handler.requests.length = 0;
      const result = await runProvision(s.deps, {
        services: s.services,
        approveHashes: [cloudflareHash, iacHash],
      });
      expect(result).toMatchObject({ applied: true, planHash: iacHash });
      expect(kinds(s)).not.toContain("cloudflare-apply");
      expect(s.engine.applied).toHaveLength(1);
    });

    it("a write that fails part-way records what reached Cloudflare and audits it", async () => {
      const s = await hetzner();
      // The block rule's entrypoint is created; Cloudflare then fails the strict-TLS one.
      s.zone.faults.push({
        match: `PUT /zones/${FAKE_ZONE_ID}/rulesets/phases/${CONFIG}/entrypoint`,
        reply: { status: 500, body: { success: false, errors: [], messages: [], result: null } },
      });
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error).toBeDefined();
      expect(s.zone.opscrewRule(WAF)).toBeDefined();
      expect(s.zone.entrypoints.has(CONFIG)).toBe(false);
      // The origin TLS and the zone setting went first, and are recorded with the block rule.
      expect(await record(s)).toMatchObject({
        zoneId: FAKE_ZONE_ID,
        hostnames: { [BLOCK]: ["shop.example.com"] },
        createdEntrypoints: [WAF],
        tls: { origin: { hostnames: ["shop.example.com"] } },
        zoneSettings: { minTlsVersion: { previous: "1.0" } },
      });
      expect((await record(s)).hostnames).toEqual({ [BLOCK]: ["shop.example.com"] });
      expect(s.deps.audit.entries).toContainEqual(
        expect.objectContaining({
          action: "cloudflare apply failed",
          detail: `changes applied before the failure: upload-client-certificate, enable-client-certificate, create-origin-certificate, set-min-tls, create-entrypoint ${WAF}`,
        }),
      );
      expect(s.engine.calls).toEqual([]);

      // The next run plans only what is missing.
      await runProvision(s.deps, { services: s.services });
      expect(s.zone.opscrewRule(CONFIG)?.expression).toBe('(http.host in {"shop.example.com"})');
      expect((await record(s)).hostnames).toEqual(both(["shop.example.com"]));
    });

    it("--plan-only writes no record, even when nothing in Cloudflare changes", async () => {
      const s = await hetzner();
      await runProvision(s.deps, { services: s.services });
      // A hostname the record lists that OpsCrew's rules no longer hold (removed by hand), and
      // that this app no longer wants: nothing changes in Cloudflare, only the record would.
      const stale: SharedRecord = {
        ...(await record(s)),
        hostnames: both(["old.example.com", "shop.example.com"]),
      };
      const text = `${JSON.stringify(stale, null, 2)}\n`;
      await writeFile(s.deps.paths.files.cloudflareRecord, text);
      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      const writes = s.zone.writes().length;

      const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
      expect(planned.cloudflarePlanHash).toBeUndefined();
      expect(await readFile(s.deps.paths.files.cloudflareRecord, "utf8")).toBe(text);
      expect(s.zone.writes()).toHaveLength(writes);

      // A run that applies writes it.
      await runProvision(s.deps, { services: s.services });
      expect((await record(s)).hostnames).toEqual(both(["shop.example.com"]));
      expect(s.zone.writes()).toHaveLength(writes);
    });

    it("a damaged record stops before any change", async () => {
      const s = await hetzner();
      await mkdir(dirname(s.deps.paths.files.cloudflareRecord), { recursive: true });
      await writeFile(s.deps.paths.files.cloudflareRecord, '{"zoneId": "zone-1"}\n');
      const error = await failure(runProvision(s.deps, { services: s.services }));
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          ".opscrew/cloudflare.json, OpsCrew's record of this app's hostnames in its shared Cloudflare rules, is damaged, so OpsCrew cannot tell which hostnames there are this app's. Nothing was changed.",
      });
      expect(kinds(s)).toEqual([]);
      expect(s.engine.calls).toEqual([]);
      expect(s.zone.writes()).toEqual([]);
    });

    it("deleting OpsCrew's rule when this app no longer uses it needs the typed app name", async () => {
      let confirmation = "shop";
      const s = await hetzner({
        answer: (request) =>
          request.kind === "cloudflare-apply" && request.allowDestroy === true
            ? { approved: true, confirmation }
            : true,
      });
      await runProvision(s.deps, { services: s.services });
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...plan,
        security: { ...plan.security, wafCustomRules: false },
      });
      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      // --plan-only says the Cloudflare plan deletes (its approval then needs --confirm <app>).
      const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
      expect(planned.cloudflarePlanDeletes).toBe(true);
      s.handler.requests.length = 0;

      confirmation = "yes";
      const refused = await failure(runProvision(s.deps, { services: s.services }));
      expect(refused?.code).toBe("APPROVAL_REFUSED");
      expect(refused?.message).toContain("The Cloudflare plan was not approved");
      const request = s.handler.requests[0];
      expect(request).toMatchObject({
        kind: "cloudflare-apply",
        allowDestroy: true,
        confirmPhrase: "shop",
      });
      expect(request?.details).toContain(
        "~ Block probes for secrets and admin panels: remove shop.example.com",
      );
      expect(request?.details).toContain(
        "No other OpsCrew app is in OpsCrew's rule, so OpsCrew deletes it, and the zone's WAF custom rules, which then hold no rule.",
      );
      expect(refused?.hint).toBe(
        `To apply it later without prompts, run: opscrew provision --approve ${request?.planHash} --confirm shop`,
      );
      expect(request?.planHash).toBe(planned.cloudflarePlanHash);
      expect(s.zone.opscrewRule(WAF)).toBeDefined();
      expect(s.engine.applied).toHaveLength(1);

      confirmation = "shop";
      await runProvision(s.deps, { services: s.services });
      expect(s.zone.entrypoints.has(WAF)).toBe(false);
      expect(s.zone.opscrewRule(CONFIG)?.expression).toBe('(http.host in {"shop.example.com"})');
      expect(await record(s)).toMatchObject({
        zoneId: FAKE_ZONE_ID,
        hostnames: { [TLS]: ["shop.example.com"] },
        createdEntrypoints: [CONFIG],
      });
      expect((await record(s)).hostnames).toEqual({ [TLS]: ["shop.example.com"] });
    });

    it("a plan without a Cloudflare zone any more first removes this app's hostnames from the zone it used", async () => {
      const zone = new FakeZone();
      zone.seedRule(WAF, {
        description: "Block one country",
        expression: '(ip.src.country eq "XX")',
        action: "block",
      });
      const userRules = zone.userRulesText(WAF);
      const s = await hetzner({ zone });
      await runProvision(s.deps, { services: s.services });
      expect((await record(s)).hostnames).toEqual(both(["shop.example.com"]));
      // The user serves the app on the server's address now: the plan has no Cloudflare domain.
      const deployed = await readArtifact("plan", s.deps.paths.files.plan);
      await writeArtifact("plan", s.deps.paths.files.plan, {
        ...deployed,
        dns: { provider: "none", proxied: false, www: false },
        security: { ...deployed.security, httpAllowedFrom: "any" },
      });
      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      s.handler.requests.length = 0;
      const writes = zone.writes().length;

      // Without a Cloudflare token the hostnames cannot leave: a plain stop, nothing changed.
      const { sharedCloudflare: _client, ...withoutClient } = s.services;
      const token = s.deps.env.CLOUDFLARE_API_TOKEN;
      delete s.deps.env.CLOUDFLARE_API_TOKEN;
      const missing = await failure(runProvision(s.deps, { services: withoutClient }));
      if (token !== undefined) s.deps.env.CLOUDFLARE_API_TOKEN = token;
      expect(missing).toMatchObject({
        code: "CREDENTIALS_MISSING",
        message: "No Cloudflare token found: set CLOUDFLARE_API_TOKEN. Nothing was changed.",
      });
      expect(kinds(s)).toEqual([]);

      // --plan-only: the removal is the run's Cloudflare plan; the infrastructure plan follows.
      const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
      expect(planned.cloudflarePlanHash).toMatch(/^[0-9a-f]{64}$/);
      expect(planned.cloudflarePlanDeletes).toBe(true);
      expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.deps.reporter.text()).toContain(
        "Cloudflare plan for the zone this app leaves: 2 to change, 0 already in place.",
      );
      expect(zone.writes()).toHaveLength(writes);

      s.handler.requests.length = 0;
      await runProvision(s.deps, { services: s.services });
      expect(kinds(s)[0]).toBe("cloudflare-apply");
      expect(s.handler.requests[0]).toMatchObject({
        planHash: planned.cloudflarePlanHash,
        allowDestroy: true,
        confirmPhrase: "shop",
      });
      // OpsCrew's rules are gone; the user's rule and its ruleset stay as they were.
      expect(zone.opscrewRule(WAF)).toBeUndefined();
      expect(zone.userRulesText(WAF)).toBe(userRules);
      expect(zone.entrypoints.has(CONFIG)).toBe(false);
      expect(await record(s)).toMatchObject({
        zoneId: FAKE_ZONE_ID,
        hostnames: {},
        createdEntrypoints: [],
      });

      // Nothing of this app is left in the zone: the next run plans nothing in Cloudflare.
      s.handler.requests.length = 0;
      await runProvision(s.deps, { services: s.services });
      expect(kinds(s)).not.toContain("cloudflare-apply");
      expect(
        s.deps.reporter.text().split("Cloudflare plan for the zone this app leaves"),
      ).toHaveLength(3);
    });

    it("an app moved to another zone first leaves the old zone's rules, in a Cloudflare plan of its own", async () => {
      const OLD_ZONE = "a".repeat(32);
      const current = new FakeZone();
      const old = new FakeZone();
      // This app's hostname in the old zone's rules, as its earlier provision left them.
      await otherApp(old, ["shop.example.com"]);
      const fetch: FetchLike = (input, init) => {
        const url = String(input);
        return url.includes(`/zones/${OLD_ZONE}`)
          ? old.fetch(url.replace(`/zones/${OLD_ZONE}`, `/zones/${FAKE_ZONE_ID}`), init)
          : current.fetch(input, init);
      };
      const client = new CloudflareClient({
        token: fakeSecret("cloudflare-token", "two-zones"),
        fetch,
        sleep: async () => undefined,
      });
      const s = await hetzner({ zone: current, client });
      await mkdir(dirname(s.deps.paths.files.cloudflareRecord), { recursive: true });
      const earlier: SharedRecord = {
        zoneId: OLD_ZONE,
        hostnames: both(["shop.example.com"]),
        createdEntrypoints: [WAF, CONFIG],
      };
      await writeFile(s.deps.paths.files.cloudflareRecord, JSON.stringify(earlier));
      const oldWrites = old.writes().length;

      // --plan-only shows only the removal from the zone the app leaves.
      const planned = await runProvision(s.deps, { services: s.services, planOnly: true });
      const leaveHash = planned.cloudflarePlanHash as string;
      const text = s.deps.reporter.text();
      expect(text).toContain("Cloudflare plan for the zone this app leaves: 2 to change");
      expect(text).toContain(
        `After this Cloudflare plan is applied (\`opscrew provision --approve ${leaveHash}\`), run \`opscrew provision\` again for the plans that follow.`,
      );
      expect(s.engine.calls).toEqual([]);
      expect(old.writes()).toHaveLength(oldWrites);
      expect(current.writes()).toEqual([]);

      await runProvision(s.deps, { services: s.services });
      const requests = s.handler.requests.filter((r) => r.kind === "cloudflare-apply");
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        planHash: leaveHash,
        allowDestroy: true,
        confirmPhrase: "shop",
      });
      expect(old.entrypoints.size).toBe(0);
      expect(current.opscrewRule(CONFIG)?.expression).toBe('(http.host in {"shop.example.com"})');
      expect(await record(s)).toMatchObject({
        zoneId: FAKE_ZONE_ID,
        hostnames: both(["shop.example.com"]),
        createdEntrypoints: [WAF, CONFIG],
      });
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.approvals.map((a) => a.kind).slice(0, 3)).toEqual([
        "cloudflare-apply",
        "cloudflare-apply",
        "iac-apply",
      ]);
    });

    it("a zone left whose rules no longer list this app's hostnames changes nothing there, and says so plainly", async () => {
      const OLD_ZONE = "b".repeat(32);
      const current = new FakeZone();
      // The old zone's rules lost this app's hostnames by hand: nothing to remove there.
      const old = new FakeZone();
      const fetch: FetchLike = (input, init) => {
        const url = String(input);
        return url.includes(`/zones/${OLD_ZONE}`)
          ? old.fetch(url.replace(`/zones/${OLD_ZONE}`, `/zones/${FAKE_ZONE_ID}`), init)
          : current.fetch(input, init);
      };
      const client = new CloudflareClient({
        token: fakeSecret("cloudflare-token", "left-by-hand"),
        fetch,
        sleep: async () => undefined,
      });
      const s = await hetzner({ zone: current, client });
      await mkdir(dirname(s.deps.paths.files.cloudflareRecord), { recursive: true });
      const earlier: SharedRecord = {
        zoneId: OLD_ZONE,
        hostnames: both(["shop.example.com"]),
        createdEntrypoints: [],
      };
      await writeFile(s.deps.paths.files.cloudflareRecord, JSON.stringify(earlier));

      await runProvision(s.deps, { services: s.services });
      const text = s.deps.reporter.text();
      expect(text).toContain(
        "None of this app's hostnames are in OpsCrew's shared Cloudflare rules there; nothing in Cloudflare changes.",
      );
      expect(text).not.toContain("already set up for this app");
      expect(old.writes()).toEqual([]);
      expect(s.handler.requests.filter((r) => r.kind === "cloudflare-apply")).toHaveLength(1);
    });
  },
);
