import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  FetchLike,
  IacApplyResult,
  IacEngine,
  IacRunOptions,
  PlanSummary,
  ResourceDrift,
} from "@opscrew/contracts";
import { tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { writeCloudflareRecord } from "../provision/shared-cloudflare";
import type { ProvisionServices } from "../provision/types";
import { ensureStatePassphrase, pagesVerificationStateFile } from "../shared";
import {
  createTestPhaseDeps,
  fakeCloudflare,
  fakeSharedCloudflare,
  plainStateResources,
  ScriptedRunner,
} from "../testing";
import { type FakePagesOptions, fakeGithubPages, pagesTestPlan } from "../testing/pages";
import { sitePlan } from "../testing/serverless";
import { driftNextSteps, renderDriftReport } from "./render";
import { runDrift } from "./run";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

const drifted = (address: string, action: ResourceDrift["action"], attributes: string[] = []) => {
  const parts = address.split(".");
  return {
    address,
    type: parts.at(-2) ?? "",
    name: parts.at(-1) ?? "",
    provider: CLOUDFLARE_PROVIDER,
    action,
    attributes,
  };
};

/** Engine fake for drift: the refresh-only plan reports `drift`; a normal plan has no changes. */
class SiteDriftEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: string[] = [];
  readonly stateResources = plainStateResources;
  async untaint(): Promise<void> {}
  async importResource(): Promise<void> {}
  async providerSchemas(): Promise<unknown> {
    return {};
  }
  async validate() {
    return { valid: true, diagnostics: [] };
  }
  async output(): Promise<Record<string, unknown>> {
    return {};
  }
  constructor(readonly drift: ResourceDrift[] = []) {}

  async init(): Promise<void> {
    this.calls.push("init");
  }

  async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { refreshOnly?: boolean } = {},
  ): Promise<PlanSummary> {
    const refresh = options.refreshOnly === true;
    this.calls.push(refresh ? "plan:refresh-only" : "plan");
    await writeFile(planFile, "fake drift plan");
    const drift = refresh ? this.drift : [];
    return {
      engine: this.info,
      dir,
      planFile,
      planHash: "0".repeat(64),
      createdAt: "2026-10-23T12:00:00.000Z",
      changes: [],
      counts: { create: 0, update: 0, delete: 0, replace: 0 },
      hasDestroy: false,
      planJson: {},
      ...(drift.length > 0 ? { drift } : {}),
    };
  }

  async apply(): Promise<IacApplyResult> {
    throw new Error("drift must never apply");
  }
}

/** A deployed site's project: its plan, its state (and the passphrase), `origin` on GitHub. */
async function setup(plan: DeployPlan, o: { fetch?: FetchLike; engine?: SiteDriftEngine } = {}) {
  const runner = new ScriptedRunner((command, args) =>
    command === "git" && args.includes("get-url")
      ? { exitCode: 0, stdout: "https://github.com/example-org/example-app.git\n", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "unexpected command" },
  );
  const deps = await createTestPhaseDeps({ runner, ...(o.fetch ? { fetch: o.fetch } : {}) });
  deps.env.GITHUB_TOKEN = fakeSecret("github-token", "drift-site");
  deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "drift-site");
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await ensureStatePassphrase(deps.paths);
  const state = JSON.stringify({ version: 4, resources: [{ mode: "managed", type: "x" }] });
  await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
  await writeFile(tfstateFile(deps.paths), state);
  const engine = o.engine ?? new SiteDriftEngine();
  const zone = new FakeZone();
  const services: ProvisionServices = {
    engine: async () => engine,
    cloudflare: fakeCloudflare(),
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  return { deps, engine, zone, services, state };
}

/** The Worker's custom domains at Cloudflare. */
function domains(zone: FakeZone, hostnames: string[]): void {
  for (const hostname of hostnames) {
    zone.workerDomains.push({
      id: `domain-${hostname}`,
      hostname,
      service: "example-app",
      zone_id: FAKE_ZONE_ID,
      zone_name: "example.com",
    });
  }
}

describe("opscrew drift on Cloudflare's hosting", () => {
  it("is clean when the Worker has the plan's custom domains, and ignores what deploys change", async () => {
    // Each deploy uploads new code: the shell's update read back is never drift.
    const engine = new SiteDriftEngine([
      drifted("module.worker.cloudflare_workers_script.this", "update", ["content"]),
    ]);
    const s = await setup(sitePlan({ www: true, deployed: true }), { engine });
    domains(s.zone, ["docs.example.com", "www.docs.example.com"]);
    const report = await runDrift(s.deps, { services: s.services });

    expect(report).toMatchObject({
      clean: true,
      drift: [],
      site: [],
      provider: "cloudflare-workers",
    });
    expect(report.cloudflareRules).toBeUndefined();
    expect(engine.calls).toEqual(["init", "plan:refresh-only", "plan"]);
    expect(s.zone.writes()).toEqual([]);
    const plan = sitePlan({ www: true, deployed: true });
    expect(renderDriftReport(report, plan)).toContain(
      "The deployment matches the plan: the Worker, its custom domains, the state and the infrastructure code all agree.",
    );
    expect(driftNextSteps(report, plan)).toEqual([
      "nothing to do; run `opscrew drift` again after changes in the Cloudflare dashboard.",
    ]);
  });

  it("reports the Worker's shell deleted outside OpsCrew", async () => {
    const engine = new SiteDriftEngine([
      drifted("module.worker.cloudflare_workers_script.this", "delete"),
    ]);
    const s = await setup(sitePlan({ deployed: true }), { engine });
    domains(s.zone, ["docs.example.com"]);
    const report = await runDrift(s.deps, { services: s.services });

    expect(report.clean).toBe(false);
    expect(report.drift).toEqual([
      drifted("module.worker.cloudflare_workers_script.this", "delete"),
    ]);
    expect(renderDriftReport(report, sitePlan({ deployed: true }))).toContain(
      "  - module.worker.cloudflare_workers_script.this no longer exists",
    );
  });

  it("reports a drifted custom domain, and how provision puts it back", async () => {
    const engine = new SiteDriftEngine([
      drifted("module.worker.cloudflare_workers_custom_domain.www", "delete"),
    ]);
    const s = await setup(sitePlan({ www: true, deployed: true }), { engine });
    domains(s.zone, ["docs.example.com", "shop.example.com"]);
    const report = await runDrift(s.deps, { services: s.services });

    expect(report.clean).toBe(false);
    expect(report.drift.map((d) => d.address)).toEqual([
      "module.worker.cloudflare_workers_custom_domain.www",
    ]);
    expect(report.site).toEqual([
      {
        title: "www.docs.example.com is no longer a custom domain of the Worker example-app",
        detail:
          "It was removed or moved to another Worker outside OpsCrew, so the site does not answer there. `opscrew provision` sets it up again (it shows the infrastructure plan first).",
      },
      {
        title:
          "shop.example.com is a custom domain of the Worker example-app that the plan does not have",
        detail: expect.stringContaining("`opscrew provision` leaves it alone"),
      },
    ]);
    const text = renderDriftReport(report, sitePlan({ www: true, deployed: true }));
    expect(text).toContain("The Worker's custom domains differ from the plan (2):");
    expect(text).toContain("Nothing was changed: `opscrew drift` only reads.");
    expect(s.zone.writes()).toEqual([]);
  });

  it("reads the www redirect's phase for the redirect rule the record lists", async () => {
    const s = await setup(sitePlan({ www: true, deployed: true }));
    domains(s.zone, ["docs.example.com", "www.docs.example.com"]);
    await writeCloudflareRecord(s.deps.paths, {
      zoneId: FAKE_ZONE_ID,
      hostnames: { "opscrew-www-redirect": ["www.docs.example.com"] },
      createdEntrypoints: [],
    });
    const report = await runDrift(s.deps, { services: s.services });

    expect(report.cloudflareRules).toEqual([
      {
        title:
          "OpsCrew's rule \"Redirect www to the domain\" is missing from the zone's single redirect rules",
        detail: expect.stringContaining("`opscrew provision` creates it again"),
      },
    ]);
    expect(s.zone.calls.some((c) => c.path.includes("http_request_dynamic_redirect"))).toBe(true);
    expect(s.zone.writes()).toEqual([]);
  });
});

describe("opscrew drift on GitHub Pages", () => {
  const deployed = (): DeployPlan => ({
    ...pagesTestPlan(),
    deployment: { lastApplyAt: "2026-10-23T11:00:00.000Z" },
  });
  const SITE = { buildType: "workflow", cname: "docs.example.com", httpsEnforced: true } as const;

  async function pagesDrift(pages: Omit<FakePagesOptions, "log">, verification = false) {
    const github = fakeGithubPages(pages);
    const s = await setup(deployed(), { fetch: github.fetch });
    if (verification) {
      await writeFile(pagesVerificationStateFile(s.deps.paths), s.state);
    }
    const report = await runDrift(s.deps, { services: s.services });
    return { ...s, github, report };
  }

  it("compares both roots and the Pages site, and is clean when they match", async () => {
    const { report, engine, github } = await pagesDrift({ site: SITE, health: "issued" }, true);

    expect(report).toMatchObject({ clean: true, site: [], provider: "github-pages" });
    expect(engine.calls.filter((c) => c === "init")).toHaveLength(2);
    expect(github.log).toEqual(["pages GET /pages", "pages GET /pages/health"]);
    expect(renderDriftReport(report, deployed())).toContain(
      "The deployment matches the plan: the GitHub Pages site, its DNS records, the state and the infrastructure code all agree.",
    );
  });

  it("reports a drifted cname, and how provision puts it back", async () => {
    const { report, github } = await pagesDrift({
      site: { ...SITE, cname: "other.example.org" },
      health: "issued",
    });

    expect(report.clean).toBe(false);
    expect(report.site).toEqual([
      {
        title:
          "The GitHub Pages site of example-org/example-app has the custom domain other.example.org, not docs.example.com",
        detail: expect.stringContaining(
          "`opscrew provision` sets docs.example.com again (it shows the Pages plan first",
        ),
      },
    ]);
    // Read only: the site, and no health check of a domain the site does not claim.
    expect(github.log).toEqual(["pages GET /pages"]);
    expect(renderDriftReport(report, deployed())).toContain(
      "The GitHub Pages site differs from the plan (1):",
    );
    expect(driftNextSteps(report, deployed())[0]).toContain("run `opscrew provision`");
  });

  it("reports Pages turned off, a branch build and HTTPS left off once the certificate is there", async () => {
    const off = await pagesDrift({});
    expect(off.report.site?.[0]?.title).toBe("GitHub Pages is off for example-org/example-app");
    expect(off.report.site?.[0]?.detail).toContain("could take it over");

    const branch = await pagesDrift({
      site: { buildType: "legacy", cname: "docs.example.com", httpsEnforced: false },
      health: "issued",
    });
    expect(branch.report.site?.map((d) => d.title)).toEqual([
      "The GitHub Pages site of example-org/example-app is built from a branch, not published by OpsCrew's deploy workflow",
      "HTTPS is not enforced for docs.example.com",
    ]);
  });

  it("notes a pending certificate without calling it drift", async () => {
    const { report } = await pagesDrift({
      site: { ...SITE, httpsEnforced: false },
      health: "dns-ok",
    });
    expect(report.clean).toBe(true);
    expect(report.notes?.[0]).toContain("GitHub has not issued the certificate");
  });
});
