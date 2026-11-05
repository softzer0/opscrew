/**
 * Provisioning previews below the app's zone (spec.md US10, FR-2231, FR-2232): the zone checked
 * again before any plan; the previews' Origin CA certificate and OpsCrew's rules on `*.<domain>`
 * and `<domain>` beside the app's own, which stay as they are; the advanced pack in the root; and
 * the wait, on an injected clock, until Cloudflare issues it.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments/paths";
import {
  certificateCloudflare,
  createProject,
  createTestPhaseDeps,
  type FakeCertificates,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  freshFacts,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
  testPlan,
  writeArchitecture,
} from "../testing";
import { runProvision } from "./run";
import { readCloudflareRecord } from "./shared-cloudflare";
import type { ProvisionServices } from "./types";

/** The app's zone, as the Cloudflare fakes name it. */
const ZONE = "example.com";
/** The app's hostname. */
const APP = `shop.${ZONE}`;
/** The previews' domain, below the app's zone. */
const BELOW = `previews.${ZONE}`;

/** `prod` as the preview environment's plan below its zone, as `env add --app-zone` designs it. */
function previewOf(prod: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    app: { ...prod.app, name: "shop-preview" },
    environment: {
      name: "preview",
      previews: { cap: 3, lifetimeDays: 7, domain: BELOW, seed: null },
    },
    infra: { ...prod.infra, dir: "opscrew/infra/preview" },
    dns: { provider: "cloudflare", zone: ZONE, proxied: true, www: false },
    security: { ...prod.security, httpAllowedFrom: "cloudflare" },
    supplyChain: { ...prod.supplyChain, sign: false },
    cicd: {
      ...prod.cicd,
      workflowPath: ".github/workflows/opscrew-deploy-preview.yml",
      deployTags: { enabled: false, release: false },
    },
  });
}

/** The preview server as the host adapter reaches it: fresh, and each apply kept. */
class PreviewServer {
  readonly applies: HostPlan[] = [];
  readonly facts: HostFacts = HostFactsSchema.parse({
    ...freshFacts({ user: "deploy" }),
    deployUser: { groups: ["deploy", "docker"], keys: [] },
  });
  readonly inspect = async (): Promise<HostFacts> => this.facts;
  readonly apply = async (
    _remote: unknown,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.applies.push(plan);
    return { applied: plan.steps.map((step) => step.id), skipped: [] };
  };
}

/**
 * The app in prod at {@link APP} behind Cloudflare's proxy (provisioned twice, its secrets in its
 * GitHub environment, its pull requests merged), and the preview environment below its zone with
 * an empty `.env.preview`, which git ignores; one Cloudflare zone for every run, answering about
 * its certificates as `certificates` says, and a clock only the run's sleeps move.
 */
async function appBelowZone(certificates: FakeCertificates = {}) {
  const prod = testPlan({ userSecret: false, domain: APP });
  const project = await createProject(prod);
  const { root, git } = project;
  await writeArchitecture(join(root, "opscrew", "architecture.json"), "shop");
  const github = new FakeGitHub();
  const server = new PreviewServer();
  const zone = new FakeZone();
  const cloudflare = certificateCloudflare(zone, { domain: BELOW, ...certificates }, ZONE);
  const env = { ...process.env, OPSCREW_HOME: join(root, ".home-opscrew") };
  const deps = (environment?: string) =>
    createTestPhaseDeps({
      root,
      env,
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => true),
      ...(environment === undefined ? {} : { environment }),
    });
  const time = { now: 0, slept: [] as number[] };
  const services = (engine = new FakeEngine()): ProvisionServices => ({
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    now: () => time.now,
    sleep: async (ms) => {
      time.slept.push(ms);
      time.now += ms;
    },
    sharedCloudflare: cloudflare.client,
    cloudflare: fakeCloudflare(),
    serverHost: server,
  });
  const merge = async () => {
    const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--no-edit", branch);
    await git(root, "push", "-q", "origin", "main");
  };
  const prodDeps = await deps();
  await runProvision(prodDeps, { services: services() });
  await merge();
  await appendFile(join(root, ".gitignore"), ".env.*\n");
  await git(root, "commit", "-q", "-m", "Ignore the environments' values", "--", ".gitignore");
  await writeArtifact(
    "plan",
    environmentPaths(prodDeps.paths, "preview").files.plan,
    previewOf(prod),
  );
  await writeFile(join(root, ".env.preview"), "");
  // Prod's next provision moves its deploy secrets apart from the previews'.
  await runProvision(await deps(), { services: services() });
  await merge();
  return { ...project, prodDeps, deps, services, github, server, zone, cloudflare, time };
}

const requestsOf = (deps: TestPhaseDeps) =>
  (deps.approvalHandler as ScriptedApprovalHandler).requests;

describe.skipIf(!findExecutable("git"))("provisioning previews below the app's zone (US10)", () => {
  it("puts the previews' certificate and rules beside the app's, which stay as they are, and waits for the pack", async () => {
    const app = await appBelowZone({ statuses: [undefined, "pending_validation", "active"] });
    const { zone, root } = app;
    // The app's own Cloudflare setup before the previews.
    const prodRecord = await readCloudflareRecord(app.prodDeps.paths);
    const prodCertificates = structuredClone(zone.originCertificates);
    expect(prodCertificates.map((c) => c.hostnames)).toEqual([[APP]]);
    const phases = [...zone.entrypoints.keys()];
    expect(phases.length).toBeGreaterThan(0);
    const prodRules = new Map(phases.map((phase) => [phase, zone.opscrewRule(phase)]));

    const preview = await app.deps("preview");
    const result = await runProvision(preview, { services: app.services() });
    expect(result).toMatchObject({ applied: true, previewsApplied: true });

    // The previews' Origin CA certificate for *.<domain> and <domain>, in the app's zone.
    const cloudflarePlan = requestsOf(preview).find((r) => r.kind === "cloudflare-apply");
    expect(cloudflarePlan?.details).toContain(
      `Create a Cloudflare origin certificate for *.${BELOW}, ${BELOW} (15 years)`,
    );
    expect(zone.originCertificates.map((c) => c.hostnames)).toEqual([[APP], [`*.${BELOW}`, BELOW]]);
    // The app's own certificate and record are as they were.
    expect(zone.originCertificates[0]).toEqual(prodCertificates[0]);
    expect(await readCloudflareRecord(app.prodDeps.paths)).toEqual(prodRecord);
    // OpsCrew's rules keep the app's hostname beside the previews' names.
    const previewRecord = await readCloudflareRecord(preview.paths);
    const expression = (rule: Record<string, unknown> | undefined) =>
      String(rule?.expression ?? "");
    const withApp = phases.filter((phase) => expression(prodRules.get(phase)).includes(APP));
    expect(withApp.length).toBeGreaterThan(0);
    for (const phase of withApp) {
      const after = expression(zone.opscrewRule(phase));
      expect(after, phase).toContain(APP);
      expect(after, phase).toContain(BELOW);
    }
    expect(Object.values(previewRecord?.hostnames ?? {})).toContainEqual([`*.${BELOW}`, BELOW]);

    // The root holds the advanced pack for the zone and *.<domain>.
    const main = await readFile(join(root, "opscrew/infra/preview/main.tf"), "utf8");
    expect(main).toContain('resource "cloudflare_certificate_pack" "previews"');
    expect(main).toContain(`hosts                 = ["${ZONE}", "*.\${var.preview_domain}"]`);

    // After the apply it read the packs until the previews' one was active, on its clock.
    expect(app.cloudflare.reads.packs).toBe(3);
    expect(app.time.slept.filter((ms) => ms === 15_000)).toEqual([15_000, 15_000]);
    const said = preview.reporter.text();
    expect(said).toContain(`Cloudflare's certificate for *.${BELOW} is active.`);
    // No secret in anything shown, audited or asked to approve.
    const shown = [
      said,
      JSON.stringify(preview.audit.entries),
      JSON.stringify(requestsOf(preview)),
    ];
    for (const text of shown) {
      // The token the Cloudflare client of the checks and the wait uses.
      expect(text).not.toContain(fakeSecret("cloudflare-token", "certificates"));
      expect(text).not.toMatch(/BEGIN (EC |RSA )?PRIVATE KEY/);
    }
  });

  it("says previews answer once Cloudflare issues the pack when it takes longer than 10 minutes", async () => {
    const app = await appBelowZone({ statuses: ["pending_issuance"] });
    const preview = await app.deps("preview");
    const result = await runProvision(preview, { services: app.services() });
    expect(result).toMatchObject({ applied: true, previewsApplied: true });
    // The first read, then one every 15 seconds for 10 minutes on its clock.
    expect(app.cloudflare.reads.packs).toBe(41);
    expect(preview.reporter.text()).toContain(
      `Cloudflare has not issued the previews' certificate for *.${BELOW} yet (pending_issuance): previews answer once Cloudflare issues it, and \`opscrew verify --env preview\` shows when.`,
    );
  });

  it.each<[string, FakeCertificates, string]>([
    ["without ACM", { allocated: 0 }, "Advanced Certificate Manager"],
    ["with Total TLS on", { totalTls: true }, `Total TLS is on for ${ZONE}`],
  ])("refuses %s before any plan", async (_case, certificates, said) => {
    const app = await appBelowZone(certificates);
    const preview = await app.deps("preview");
    const engine = new FakeEngine();
    const error = await runProvision(preview, { services: app.services(engine) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(said),
      hint: expect.stringContaining(
        `in the Cloudflare dashboard (${ZONE} → SSL/TLS → Edge Certificates), then run \`opscrew provision --env preview\` again.`,
      ),
    });
    expect(requestsOf(preview)).toEqual([]);
    expect(engine.calls).toEqual([]);
    expect(app.server.applies).toEqual([]);
  });

  it("refuses records at or below the domain before any plan, naming them without their content", async () => {
    const app = await appBelowZone();
    app.zone.addDnsRecord({ type: "CNAME", name: `docs.${BELOW}`, proxied: false });
    const preview = await app.deps("preview");
    const engine = new FakeEngine();
    const error = await runProvision(preview, { services: app.services(engine) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        `${ZONE} already has docs.${BELOW} (CNAME) at or below ${BELOW}, and previews take every name there`,
      ),
      hint: expect.stringContaining(`(${ZONE} → DNS → Records)`),
    });
    expect((error as Error).message).not.toContain("target.example.net");
    expect(requestsOf(preview)).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("refuses a domain that holds another environment's hostname before any plan", async () => {
    const app = await appBelowZone();
    const prodPlan = await readArtifact("plan", app.prodDeps.paths.files.plan);
    await writeArtifact(
      "plan",
      environmentPaths(app.prodDeps.paths, "staging").files.plan,
      DeployPlanSchema.parse({
        ...prodPlan,
        app: { ...prodPlan.app, name: "shop-staging" },
        environment: { name: "staging" },
        infra: { ...prodPlan.infra, dir: "opscrew/infra/staging" },
        cicd: { ...prodPlan.cicd, workflowPath: ".github/workflows/opscrew-deploy-staging.yml" },
        dns: { ...prodPlan.dns, domain: `app.${BELOW}`, proxied: false, www: false },
        deployment: {},
      }),
    );
    const preview = await app.deps("preview");
    const engine = new FakeEngine();
    const error = await runProvision(preview, { services: app.services(engine) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: `${BELOW} is a parent of app.${BELOW}, the first app's environment staging's hostname, and previews take every name below ${BELOW}. Nothing was changed.`,
    });
    expect(requestsOf(preview)).toEqual([]);
    expect(engine.calls).toEqual([]);
  });
});
