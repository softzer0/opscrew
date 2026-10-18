import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_PRICES_AS_OF as HETZNER_PRICES_AS_OF } from "@opscrew/connector-hetzner";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { cloudTarget } from "@opscrew/iac-templates";
import {
  type Architecture,
  type DeployPlan,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runInterview } from "../interview";
import { recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  doEuCatalog,
  euCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
  type TestPhaseDeps,
} from "../testing";
import { previewDesignOptions, runDesign } from "./run";

const TOKEN = "hcloud-test-token-not-a-real-value";
/** The detect `monorepo-turbo` fixture plus an Express API in `apps/api`. */
const MONOREPO_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/monorepo-two-apps", import.meta.url),
);

async function setup(
  facts = staticSpaFacts(),
  requirements: Requirements = makeRequirements(),
  options: Parameters<typeof createTestPhaseDeps>[0] = {},
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps(options);
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  return deps;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const price = (net: string) => ({ net, gross: net });

/** A fake Hetzner API with two x86 types and one ARM type in nbg1. */
function hetznerApi(options: { serverTypesStatus?: number; tokenStatus?: number } = {}) {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return json({ error: { message: "bad token" } }, 401);
    if (url.pathname === "/v1/locations") {
      if (options.tokenStatus) {
        return json(
          { error: { code: "unauthorized", message: "unable to authenticate" } },
          options.tokenStatus,
        );
      }
      return json({ locations: [{ id: 1, name: "nbg1", country: "DE", city: "Nuremberg" }] });
    }
    if (url.pathname === "/v1/server_types") {
      if (options.serverTypesStatus) {
        return json(
          { error: { code: "forbidden", message: "forbidden" } },
          options.serverTypesStatus,
        );
      }
      const type = (
        id: number,
        name: string,
        cores: number,
        memory: number,
        disk: number,
        monthly: string,
        architecture = "x86",
      ) => ({
        id,
        name,
        cores,
        memory,
        disk,
        cpu_type: "shared",
        architecture,
        deprecated: false,
        prices: [{ location: "nbg1", price_hourly: price("0.01"), price_monthly: price(monthly) }],
        locations: [{ id: 1, name: "nbg1", available: true }],
      });
      return json({
        server_types: [
          type(1, "cx23", 2, 4, 40, "5.4900"),
          type(2, "cx33", 4, 8, 80, "8.4900"),
          type(3, "cax11", 2, 4, 40, "3.9900", "arm"),
        ],
        meta: { pagination: { page: 1, per_page: 50, next_page: null } },
      });
    }
    if (url.pathname === "/v1/pricing") {
      return json({
        pricing: {
          currency: "EUR",
          primary_ips: [
            { type: "ipv4", prices: [{ location: "nbg1", price_monthly: price("0.5000") }] },
          ],
          server_backup: { percentage: "20.0000" },
        },
      });
    }
    return json({ error: { message: "not found" } }, 404);
  };
  return { fetch, calls };
}

describe("runDesign", () => {
  it("writes plan.yaml for the recommended option and marks the phase", async () => {
    const deps = await setup();
    const result = await runDesign(deps, { catalog: euCatalog() });

    expect(result.chosen.recommended).toBe(true);
    expect(result.chosen.id).toBe("hetzner-single-cx13-fsn1");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan).toEqual(result.plan);
    expect(plan.target).toMatchObject({ serverType: "cx13", location: "fsn1", backups: false });
    expect(plan.codeChanges.map((c) => c.kind)).toEqual(["dockerfile", "dockerignore"]);

    const state = await deps.state.read();
    expect(state.phases.design).toMatchObject({ status: "ok" });
    expect(state.phases.design?.summary).toContain("hetzner-single-cx13-fsn1");
    const text = deps.reporter.text();
    expect(text).toContain("recommended");
    expect(text).toContain("Wrote opscrew/plan.yaml");
    expect(text).toContain("opscrew adapt");
  });

  it("says which release command every deploy runs and where to change it", async () => {
    const deps = await setup(
      makeFacts({
        languages: ["python"],
        packageManager: "pip",
        frameworks: [{ name: "django", path: "." }],
        appKind: "fullstack",
        port: 8000,
        build: { releaseCommand: "python manage.py migrate --noinput" },
        services: [{ kind: "postgres", evidence: ["dependency:psycopg"] }],
      }),
    );
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.app.releaseCommand).toBe("python manage.py migrate --noinput");
    const text = deps.reporter.text();
    expect(text).toContain("Every deploy runs `python manage.py migrate --noinput`");
    expect(text).toContain("app.releaseCommand");
  });

  it("keeps the migrations OpsCrew found, since the standalone image holds the Prisma CLI (012)", async () => {
    const deps = await setup(
      nextPostgresFacts({
        build: { buildCommand: "npm run build", releaseCommand: "npx prisma migrate deploy" },
      }),
    );
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.app.releaseCommand).toBe("npx prisma migrate deploy");
    expect(result.warnings.join("\n")).not.toContain("OpsCrew found Prisma migrations");
    expect(deps.reporter.text()).toContain("Every deploy runs `npx prisma migrate deploy`");
  });

  it("says nothing about migrations for an app without a command or a database", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: euCatalog() });
    expect(deps.reporter.text()).not.toContain("releaseCommand");
  });

  it("uses --option when given and rejects an unknown id with the valid ones", async () => {
    const deps = await setup();
    const result = await runDesign(deps, {
      catalog: euCatalog(),
      optionId: "hetzner-single-cx33-nbg1",
    });
    expect(result.plan.target).toMatchObject({ serverType: "cx33" });

    const err = await runDesign(deps, { catalog: euCatalog(), optionId: "nope" }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: "INVALID_INPUT",
      hint: expect.stringContaining("hetzner-single-cx13-fsn1"),
    });
    expect((await deps.state.read()).phases.design?.status).toBe("failed");
  });

  it("asks the chooser when no option id is given", async () => {
    const deps = await setup();
    const seen: string[] = [];
    const result = await runDesign(deps, {
      catalog: euCatalog(),
      choose: async (options) => {
        seen.push(...options.map((o) => o.id));
        return options[1]?.id ?? "";
      },
    });
    expect(seen).toEqual(["hetzner-single-cx13-fsn1", "hetzner-single-cx33-nbg1"]);
    expect(result.chosen.id).toBe("hetzner-single-cx33-nbg1");
  });

  it("US3-3: tells the user the minimum cost when nothing fits the budget", async () => {
    const deps = await setup(
      staticSpaFacts(),
      makeRequirements({ budgetMonthly: { amount: 2, currency: "USD" } }),
    );
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.options.some((o) => o.fitsBudget)).toBe(false);
    const warning = result.warnings.join("\n");
    expect(warning).toContain("None of the options fits your budget of $2.00/month");
    expect(warning).toContain("The cheapest costs $5.16/month");
    expect(warning).toContain("1 EUR = 1.10 USD");
  });

  it("US3-4: without HCLOUD_TOKEN, uses the dated static price list and says so", async () => {
    const deps = await setup();
    const result = await runDesign(deps);
    expect(result.priceSource).toBe("static");
    expect(result.options.every((o) => o.cost.source === "static")).toBe(true);
    expect(
      result.options.every((o) =>
        o.summary.includes(`estimate as of ${HETZNER_PRICES_AS_OF.slice(0, 10)}`),
      ),
    ).toBe(true);
    expect(result.warnings.join("\n")).toContain("HCLOUD_TOKEN is not set");
    expect(deps.reporter.lines.some((l) => l.level === "warn")).toBe(true);
    expect(result.plan.cost.source).toBe("static");
  });

  it("FR-812: warns once that background jobs will not run, naming the library", async () => {
    const facts = nextPostgresFacts({
      appKind: "api",
      services: [{ kind: "queue", evidence: ["dependency:celery"] }],
    });
    const deps = await setup(facts);
    const result = await runDesign(deps, { catalog: euCatalog() });
    const notes = result.warnings.filter((w) => w.includes("background jobs"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Celery");
    expect(notes[0]).toContain("only the web process");
    expect(notes[0]).toContain("run the worker yourself");
    expect(deps.reporter.lines.some((l) => l.level === "warn" && l.message === notes[0])).toBe(
      true,
    );
  });

  it("shows what detection noted about the app (for example the parts it does not deploy)", async () => {
    const note = "Only the API side of this app is deployed; its web side is not served yet.";
    const deps = await setup(nextPostgresFacts({ notes: [note] }));
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.warnings).toContain(note);
    expect(deps.reporter.lines.some((l) => l.level === "warn" && l.message === note)).toBe(true);
  });

  it("FR-812: no background-jobs warning for an app without them", async () => {
    const deps = await setup(nextPostgresFacts());
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.warnings.join("\n")).not.toContain("background jobs");
  });

  it("previews the options without writing a plan or marking the phase", async () => {
    const deps = await setup();
    const preview = await previewDesignOptions(deps);
    expect(preview.options.length).toBeGreaterThanOrEqual(2);
    expect(preview.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(preview.priceSource).toBe("static");
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await deps.state.read()).phases.design).toBeUndefined();
  });

  it("US3-4: with a working HCLOUD_TOKEN, prices are live and ARM is skipped", async () => {
    const api = hetznerApi();
    const deps = await setup(staticSpaFacts(), makeRequirements(), {
      fetch: api.fetch,
      env: { HCLOUD_TOKEN: TOKEN },
    });
    const result = await runDesign(deps);
    expect(result.priceSource).toBe("live");
    expect(result.warnings).toEqual([]);
    expect(result.options.map((o) => o.id)).toEqual([
      "hetzner-single-cx23-nbg1",
      "hetzner-single-cx33-nbg1",
    ]);
    expect(result.options[0]?.cost.asOf).toBe("2026-10-11T12:00:00.000Z");
    expect(result.options[0]?.summary).toContain("live price");
    expect(api.calls).toContain("/v1/locations");
    // The token never reaches the plan or the report.
    expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain(TOKEN);
    expect(deps.reporter.text()).not.toContain(TOKEN);
  });

  it("falls back to static prices when the token is rejected or the API fails", async () => {
    const rejected = await setup(staticSpaFacts(), makeRequirements(), {
      fetch: hetznerApi({ tokenStatus: 401 }).fetch,
      env: { HCLOUD_TOKEN: TOKEN },
    });
    const first = await runDesign(rejected);
    expect(first.priceSource).toBe("static");
    expect(first.warnings.join("\n")).toContain("could not be used");

    const failing = await setup(staticSpaFacts(), makeRequirements(), {
      fetch: hetznerApi({ serverTypesStatus: 403 }).fetch,
      env: { HCLOUD_TOKEN: TOKEN },
    });
    const second = await runDesign(failing);
    expect(second.priceSource).toBe("static");
    expect(second.warnings.join("\n")).toContain("Could not read live prices from Hetzner");
    expect(second.warnings.join("\n")).not.toContain(TOKEN);
  });

  it("derives code changes from the repository and the saved scan report", async () => {
    const deps = await setup(
      nextPostgresFacts(),
      makeRequirements({
        dataCriticality: "important",
        budgetMonthly: { amount: 50, currency: "EUR" },
      }),
    );
    const write = async (rel: string, content: string) => {
      const abs = `${deps.paths.root}/${rel}`;
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    };
    await write("next.config.mjs", 'export default { output: "standalone" };\n');
    await write("src/app/page.tsx", "export default function Page() { return null; }\n");
    await write(
      ".opscrew/scan.json",
      JSON.stringify({
        tool: "opscrew",
        findings: [
          {
            ruleId: "secrets/stripe-secret-key",
            title: "Stripe secret key",
            file: "src/pay.ts",
            severity: "critical",
          },
        ],
        counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      }),
    );
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.codeChanges.map((c) => [c.kind, c.path])).toEqual([
      ["dockerfile", "Dockerfile"],
      ["dockerignore", ".dockerignore"],
      ["health-endpoint", "src/app/api/health/route.ts"],
      ["env-example", ".env.example"],
      ["secret-removal", "src/pay.ts"],
    ]);
    expect(result.plan.services.postgres).toBe(true);
    expect(result.plan.target).toMatchObject({ backups: true });
  });

  it("keeps createdAt of an earlier plan", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: euCatalog() });
    const later = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      clock: { now: () => new Date("2026-10-12T08:00:00.000Z") },
    });
    const result = await runDesign(later, { catalog: euCatalog() });
    expect(result.plan.createdAt).toBe("2026-10-11T12:00:00.000Z");
    expect(result.plan.updatedAt).toBe("2026-10-12T08:00:00.000Z");
  });

  it("stops when a monorepo has several deployable apps and none was chosen", async () => {
    const deps = await setup(nextPostgresFacts());
    await materializeFixture(MONOREPO_FIXTURE, deps.paths.root);

    for (const attempt of [
      () => runDesign(deps, { catalog: euCatalog() }),
      () => previewDesignOptions(deps, { catalog: euCatalog() }),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      const { message, hint } = error as { message: string; hint: string };
      expect(message).toContain("`apps/api` (Express)");
      expect(message).toContain("`apps/web` (Next.js");
      expect(message).toContain("OpsCrew deploys one app, so choose which one");
      expect(hint).toMatch(/`opscrew interview` and pick the app/);
      expect(hint).toMatch(/`opscrew analyze --app apps\/api`/);
    }
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await deps.state.read()).phases.design?.status).toBe("failed");
  });

  it("designs the chosen app of a monorepo, built from the repository root", async () => {
    const facts = nextPostgresFacts({
      monorepo: true,
      appDir: "apps/web",
      frameworks: [{ name: "next", version: "15.0.0", path: "apps/web" }],
    });
    const deps = await setup(facts, makeRequirements({ appDir: "apps/web" }));
    await materializeFixture(MONOREPO_FIXTURE, deps.paths.root);

    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.app.dockerfile).toBe("apps/web/Dockerfile");
    expect(result.plan.app.buildContext).toBe(".");
    const paths = Object.fromEntries(result.plan.codeChanges.map((c) => [c.id, c.path]));
    expect(paths.dockerfile).toBe("apps/web/Dockerfile");
    expect(paths.dockerignore).toBe(".dockerignore");
    // Ports and server entries of the other app (apps/api) are not this app's changes.
    expect(result.plan.codeChanges.some((c) => c.path.startsWith("apps/api/"))).toBe(false);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(result.plan);
  });

  it("does not stop without requirements.appDir when the analysis already chose an app", async () => {
    const facts = nextPostgresFacts({
      monorepo: true,
      appDir: "apps/web",
      frameworks: [{ name: "next", version: "15.0.0", path: "apps/web" }],
    });
    const deps = await setup(facts);
    await materializeFixture(MONOREPO_FIXTURE, deps.paths.root);
    const preview = await previewDesignOptions(deps, { catalog: euCatalog() });
    expect(preview.options.length).toBeGreaterThan(0);
  });

  it("stops when the requirements choose an app the analysis does not describe", async () => {
    const deps = await setup(nextPostgresFacts(), makeRequirements({ appDir: "apps/api" }));
    await materializeFixture(MONOREPO_FIXTURE, deps.paths.root);
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("chooses the app in apps/api"),
      hint: expect.stringContaining("Run `opscrew analyze`"),
    });
  });

  it("designs a monorepo with a single deployable app", async () => {
    const deps = await setup(nextPostgresFacts());
    await materializeFixture(MONOREPO_FIXTURE, deps.paths.root);
    await rm(join(deps.paths.root, "apps", "api"), { recursive: true, force: true });
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(cloudTarget(result.plan.target).serverType).toBeDefined();
  });

  describe("re-running design on an existing plan", () => {
    const HASH = "ab".repeat(32);

    /** Writes a plan for `optionId`, then applies `edit` to it as the user or provision would. */
    async function existingPlan(
      optionId: string,
      edit: (plan: DeployPlan) => DeployPlan,
    ): Promise<TestPhaseDeps> {
      const deps = await setup();
      await runDesign(deps, { catalog: euCatalog(), optionId });
      const plan = await readArtifact("plan", deps.paths.files.plan);
      await writeArtifact("plan", deps.paths.files.plan, edit(plan));
      return deps;
    }

    const deployed = (plan: DeployPlan): DeployPlan => ({
      ...plan,
      codeChanges: plan.codeChanges.map((c) =>
        c.id === "dockerfile" ? { ...c, status: "applied" as const } : c,
      ),
      infra: { engine: "tofu", dir: "infra/live", stateEncryption: false },
      security: { ...plan.security, sshAllowedCidrs: ["203.0.113.7/32"], imageScan: false },
      approvals: [
        { planHash: HASH, approver: "dev", at: "2026-10-11T12:30:00.000Z", kind: "apply" },
      ],
      deployment: {
        lastCompletedPhase: "provision",
        lastPlanHash: HASH,
        lastApplyAt: "2026-10-11T12:30:00.000Z",
      },
    });

    it("keeps deployment, approvals, security, infra and code-change progress", async () => {
      const deps = await existingPlan("hetzner-single-cx13-fsn1", deployed);
      const result = await runDesign(deps, {
        catalog: euCatalog(),
        optionId: "hetzner-single-cx13-fsn1",
      });
      const plan = await readArtifact("plan", deps.paths.files.plan);
      expect(plan).toEqual(result.plan);
      expect(plan.security.sshAllowedCidrs).toEqual(["203.0.113.7/32"]);
      expect(plan.security.imageScan).toBe(false);
      expect(plan.infra).toEqual({ engine: "tofu", dir: "infra/live", stateEncryption: false });
      expect(plan.approvals).toEqual([
        { planHash: HASH, approver: "dev", at: "2026-10-11T12:30:00.000Z", kind: "apply" },
      ]);
      expect(plan.deployment).toMatchObject({
        lastApplyAt: "2026-10-11T12:30:00.000Z",
        lastPlanHash: HASH,
      });
      expect(plan.codeChanges.find((c) => c.id === "dockerfile")?.status).toBe("applied");
      expect(plan.codeChanges.find((c) => c.id === "dockerignore")?.status).toBe("pending");
      expect(result.warnings.join("\n")).not.toMatch(/replace|resize/);
    });

    it("warns that a deployed server will be replaced when the location changes", async () => {
      const deps = await existingPlan("hetzner-single-cx13-fsn1", deployed);
      const result = await runDesign(deps, {
        catalog: euCatalog(),
        optionId: "hetzner-single-cx33-nbg1",
      });
      const warning = result.warnings.join("\n");
      expect(warning).toMatch(/fsn1/);
      expect(warning).toMatch(/nbg1/);
      expect(warning).toMatch(/replace the server/);
      expect(warning).toMatch(/opscrew provision/);
      expect(deps.reporter.lines.some((l) => l.level === "warn" && /replace/.test(l.message))).toBe(
        true,
      );
      // The new plan still keeps the user's settings.
      expect(result.plan.security.sshAllowedCidrs).toEqual(["203.0.113.7/32"]);
    });

    it("warns that a deployed server will be resized when only the server type changes", async () => {
      const deps = await existingPlan("hetzner-single-cx33-nbg1", (plan) =>
        deployed({ ...plan, target: { ...cloudTarget(plan.target), serverType: "cx23" } }),
      );
      const result = await runDesign(deps, {
        catalog: euCatalog(),
        optionId: "hetzner-single-cx33-nbg1",
      });
      const warning = result.warnings.join("\n");
      expect(warning).toMatch(/cx23/);
      expect(warning).toMatch(/cx33/);
      expect(warning).toMatch(/resize/);
      expect(warning).not.toMatch(/replace the server/);
    });

    it("does not warn about a plan that was never provisioned", async () => {
      const deps = await existingPlan("hetzner-single-cx13-fsn1", (plan) => plan);
      const result = await runDesign(deps, {
        catalog: euCatalog(),
        optionId: "hetzner-single-cx33-nbg1",
      });
      expect(result.warnings.join("\n")).not.toMatch(/replace|resize/);
    });

    it("re-derives the HTTP allow-list when the DNS proxy setting changed", async () => {
      // The old plan was proxied by Cloudflare; the new requirements have no Cloudflare DNS.
      const deps = await existingPlan("hetzner-single-cx13-fsn1", (plan) => ({
        ...deployed(plan),
        dns: { provider: "cloudflare", domain: "app.example.com", proxied: true, www: false },
        security: { ...deployed(plan).security, httpAllowedFrom: "cloudflare" },
      }));
      const result = await runDesign(deps, {
        catalog: euCatalog(),
        optionId: "hetzner-single-cx13-fsn1",
      });
      expect(result.plan.dns.proxied).toBe(false);
      expect(result.plan.security.httpAllowedFrom).toBe("any");
      expect(result.plan.security.sshAllowedCidrs).toEqual(["203.0.113.7/32"]);
    });

    describe("with Portainer enabled", () => {
      const onCloudflare = makeRequirements({
        dnsProvider: "cloudflare",
        domain: "shop.example.com",
      });
      const PORTAINER = {
        enabled: true,
        version: "2.33.1",
        access: "subdomain" as const,
        hostname: "portainer.example.com",
        allowedEmails: ["ops@example.com"],
      };

      /** A deployed plan on Cloudflare after `opscrew portainer enable --subdomain portainer`. */
      async function withPortainer(): Promise<TestPhaseDeps> {
        const deps = await setup(staticSpaFacts(), onCloudflare);
        await runDesign(deps, { catalog: euCatalog(), optionId: "hetzner-single-cx13-fsn1" });
        const plan = deployed(await readArtifact("plan", deps.paths.files.plan));
        await writeArtifact("plan", deps.paths.files.plan, {
          ...plan,
          dns: { ...plan.dns, zone: "example.com" },
          portainer: PORTAINER,
        });
        return deps;
      }

      it("re-running interview and design keeps plan.portainer exactly as it was", async () => {
        const deps = await withPortainer();
        await runInterview(deps, {
          answers: {
            expectedMonthlyUsers: "1k-10k",
            budgetMonthly: { amount: 20, currency: "EUR" },
            region: "eu-central",
            uptime: "standard",
            dataCriticality: "none",
            domain: "shop.example.com",
            dnsProvider: "cloudflare",
            keepExternalServices: [],
          },
        });
        const result = await runDesign(deps, {
          catalog: euCatalog(),
          optionId: "hetzner-single-cx13-fsn1",
        });
        const plan = await readArtifact("plan", deps.paths.files.plan);
        expect(plan.portainer).toEqual(PORTAINER);
        expect(result.plan.portainer).toEqual(PORTAINER);
        expect(plan.dns.zone).toBe("example.com");
      });

      it("keeps a Portainer reached only through an SSH tunnel on a plan without Cloudflare", async () => {
        const local = { enabled: true, version: "2.33.1", access: "local" as const };
        const deps = await existingPlan("hetzner-single-cx13-fsn1", (plan) => ({
          ...deployed(plan),
          portainer: local,
        }));
        const result = await runDesign(deps, {
          catalog: euCatalog(),
          optionId: "hetzner-single-cx13-fsn1",
        });
        expect(result.plan.portainer).toEqual(local);
      });

      it("stops without touching plan.yaml when its subdomain no longer fits the new DNS", async () => {
        const deps = await withPortainer();
        const before = await readFile(deps.paths.files.plan, "utf8");
        await writeArtifact("requirements", deps.paths.files.requirements, makeRequirements());
        await expect(
          runDesign(deps, { catalog: euCatalog(), optionId: "hetzner-single-cx13-fsn1" }),
        ).rejects.toThrow(/Portainer is served on portainer\.example\.com through Cloudflare/);
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
      });

      it("names the actual problem when the kept settings no longer fit, in plain words", async () => {
        const deps = await withPortainer();
        const before = await readFile(deps.paths.files.plan, "utf8");
        // Still on Cloudflare in the same zone, but now on Portainer's own hostname.
        await writeArtifact(
          "requirements",
          deps.paths.files.requirements,
          makeRequirements({ dnsProvider: "cloudflare", domain: "portainer.example.com" }),
        );
        const error = await runDesign(deps, {
          catalog: euCatalog(),
          optionId: "hetzner-single-cx13-fsn1",
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpsCrewError);
        expect(error).toMatchObject({
          code: "INVALID_INPUT",
          message:
            "OpsCrew cannot keep the settings of the current plan with the new design: portainer.hostname must differ from the app's domain (portainer.example.com) and its www. alias. plan.yaml was not changed.",
        });
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
      });
    });
  });

  describe("on DigitalOcean", () => {
    const doRequirements = (overrides: Partial<Requirements> = {}) =>
      makeRequirements({
        provider: "digitalocean",
        budgetMonthly: { amount: 20, currency: "EUR" },
        ...overrides,
      });

    /** A fake DigitalOcean API: the account and three sizes (one Basic size unavailable). */
    function digitaloceanApi(
      token: string,
      options: { accountStatus?: number; sizesStatus?: number } = {},
    ) {
      const calls: string[] = [];
      const size = (
        slug: string,
        vcpus: number,
        memory: number,
        disk: number,
        monthly: number,
      ) => ({
        slug,
        memory,
        vcpus,
        disk,
        transfer: 2,
        price_monthly: monthly,
        price_hourly: monthly / 672,
        regions: ["fra1", "ams3"],
        available: true,
        description: "Basic",
      });
      const fetch: FetchLike = async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== `Bearer ${token}`) return json({ id: "unauthorized", message: "no" }, 401);
        if (url.pathname === "/v2/account") {
          if (options.accountStatus) {
            return json(
              { id: "unauthorized", message: "Unable to authenticate you." },
              options.accountStatus,
            );
          }
          return json({ account: { status: "active", email_verified: true, droplet_limit: 25 } });
        }
        if (url.pathname === "/v2/sizes") {
          if (options.sizesStatus) {
            return json({ id: "forbidden", message: "Forbidden." }, options.sizesStatus);
          }
          return json({
            sizes: [
              size("s-1vcpu-2gb", 1, 2048, 50, 12),
              size("s-2vcpu-4gb", 2, 4096, 80, 24),
              { ...size("s-4vcpu-8gb", 4, 8192, 160, 48), available: false },
            ],
            links: {},
            meta: { total: 3 },
          });
        }
        return json({ id: "not_found", message: "not found" }, 404);
      };
      return { fetch, calls };
    }

    it("US1-2: writes a DigitalOcean plan with the provider, the Droplet image and USD prices", async () => {
      const deps = await setup(staticSpaFacts(), doRequirements());
      const result = await runDesign(deps, { catalog: doEuCatalog() });
      expect(result.chosen.id).toBe("digitalocean-single-s-1vcpu-2gb-fra1");
      const plan = await readArtifact("plan", deps.paths.files.plan);
      expect(plan).toEqual(result.plan);
      expect(plan.target).toEqual({
        provider: "digitalocean",
        mode: "vps-compose",
        location: "fra1",
        serverType: "s-1vcpu-2gb",
        image: "ubuntu-24-04-x64",
        backups: false,
      });
      expect(plan.cost.monthly).toEqual({ amount: 12, currency: "USD" });
      const text = deps.reporter.text();
      expect(text).toContain("$12.00/month (about €10.91)");
      expect(text).toContain(
        "DigitalOcean prices are in USD and your budget is in EUR, so the budget comparison is approximate.",
      );
      expect(text).toContain("1 EUR = 1.10 USD");
    });

    it("US3-1: without a token, uses the dated static price list and says how to get live prices", async () => {
      const deps = await setup(staticSpaFacts(), doRequirements({ region: "eu-north" }));
      const result = await runDesign(deps);
      expect(result.priceSource).toBe("static");
      expect(result.options.map((o) => o.id)).toContain("digitalocean-single-s-1vcpu-2gb-ams3");
      expect(result.options.every((o) => o.summary.includes("estimate as of 2026-10-12"))).toBe(
        true,
      );
      const warning = result.warnings.join("\n");
      expect(warning).toContain("DIGITALOCEAN_TOKEN is not set");
      expect(warning).toContain("DigitalOcean's published price list dated 2026-10-12");
      expect(warning).toContain("Droplet availability is not checked");
      expect(warning).toContain("Set DIGITALOCEAN_TOKEN for live prices.");
      expect(warning).not.toMatch(/Hetzner|HCLOUD/);
      // The reporter (after redaction) still says which variable to set.
      const text = deps.reporter.text();
      expect(text).toContain("Set DIGITALOCEAN_TOKEN for live prices.");
      expect(text).toContain("DigitalOcean has no data centre in northern Europe");
      expect(result.plan.target).toMatchObject({ provider: "digitalocean", location: "ams3" });
    });

    it("prices live from the DigitalOcean API when the token works", async () => {
      const token = fakeSecret("digitalocean-token");
      const api = digitaloceanApi(token);
      const deps = await setup(staticSpaFacts(), doRequirements(), {
        fetch: api.fetch,
        env: { DIGITALOCEAN_TOKEN: token },
      });
      const result = await runDesign(deps);
      expect(result.priceSource).toBe("live");
      expect(result.warnings).toEqual([]);
      expect(result.options.map((o) => o.id)).toEqual([
        "digitalocean-single-s-1vcpu-2gb-fra1",
        "digitalocean-single-s-2vcpu-4gb-fra1",
      ]);
      expect(result.options[0]?.summary).toContain("live price");
      expect(api.calls).toContain("/v2/account");
      expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain(token);
      expect(deps.reporter.text()).not.toContain(token);
    });

    it("falls back to static prices when the token is rejected or the API fails", async () => {
      const token = fakeSecret("digitalocean-token");
      const rejected = await setup(staticSpaFacts(), doRequirements(), {
        fetch: digitaloceanApi(token, { accountStatus: 401 }).fetch,
        env: { DIGITALOCEAN_TOKEN: token },
      });
      const first = await runDesign(rejected);
      expect(first.priceSource).toBe("static");
      expect(first.warnings.join("\n")).toContain("The DigitalOcean token could not be used");
      expect(first.warnings.join("\n")).toContain("price list dated 2026-10-12");

      const failing = await setup(staticSpaFacts(), doRequirements(), {
        fetch: digitaloceanApi(token, { sizesStatus: 403 }).fetch,
        env: { DIGITALOCEAN_TOKEN: token },
      });
      const second = await runDesign(failing);
      expect(second.priceSource).toBe("static");
      const warning = second.warnings.join("\n");
      expect(warning).toContain("Could not read live prices from DigitalOcean");
      expect(warning).toContain("Using the price list dated 2026-10-12 instead");
      expect(warning).not.toContain(token);
      expect(failing.reporter.text()).not.toContain(token);
    });

    describe("changing the provider of an existing plan", () => {
      /**
       * A Hetzner plan, provisioned, then the requirements switch to DigitalOcean. With `server`,
       * the server's address is in OpsCrew's local state, as `opscrew provision` leaves it.
       */
      async function hetznerDeployment(
        deployment: DeployPlan["deployment"],
        server = false,
      ): Promise<{ deps: TestPhaseDeps; before: string }> {
        const deps = await setup();
        await runDesign(deps, { catalog: euCatalog() });
        const plan = await readArtifact("plan", deps.paths.files.plan);
        await writeArtifact("plan", deps.paths.files.plan, { ...plan, deployment });
        if (server) await recordServerAddress(deps.paths, { ipv4: "203.0.113.10" });
        await writeArtifact("requirements", deps.paths.files.requirements, doRequirements());
        return { deps, before: await readFile(deps.paths.files.plan, "utf8") };
      }

      it("US3-2: stops without touching plan.yaml when the deployment is live", async () => {
        const { deps, before } = await hetznerDeployment(
          {
            lastCompletedPhase: "provision",
            lastApplyAt: "2026-10-11T12:30:00.000Z",
          },
          true,
        );
        let asked = false;
        const error = await runDesign(deps, {
          catalog: doEuCatalog(),
          choose: async (options) => {
            asked = true;
            return options[0]?.id ?? "";
          },
        }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
        const { message, hint } = error as { message: string; hint: string };
        expect(message).toBe(
          "Your app is deployed on Hetzner Cloud, but opscrew/requirements.yaml now asks for DigitalOcean. opscrew/plan.yaml was not changed.",
        );
        expect(hint).toBe(
          "Run `opscrew retarget --to digitalocean` to move the deployment with its data, or `opscrew destroy` first and then `opscrew design`, or keep Hetzner Cloud by answering `opscrew interview` again.",
        );
        expect(asked).toBe(false);
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
        expect((await deps.state.read()).phases.design?.status).toBe("failed");
      });

      it("lets a destroyed deployment switch providers", async () => {
        const { deps } = await hetznerDeployment({
          lastCompletedPhase: "provision",
          lastApplyAt: "2026-10-11T12:30:00.000Z",
          destroyedAt: "2026-10-12T09:00:00.000Z",
        });
        const result = await runDesign(deps, { catalog: doEuCatalog() });
        expect(result.plan.target).toMatchObject({
          provider: "digitalocean",
          image: "ubuntu-24-04-x64",
          location: "fra1",
        });
        expect(result.plan.deployment.destroyedAt).toBe("2026-10-12T09:00:00.000Z");
        expect(result.warnings.join("\n")).not.toMatch(/replace|resize/);
        expect((await readArtifact("plan", deps.paths.files.plan)).target.provider).toBe(
          "digitalocean",
        );
      });

      it("lets a plan that was never provisioned switch providers", async () => {
        const { deps } = await hetznerDeployment({});
        const result = await runDesign(deps, { catalog: doEuCatalog() });
        expect(result.plan.target.provider).toBe("digitalocean");
      });

      it("on a fresh clone of a deployed app, says where to move it, never `opscrew provision`", async () => {
        // The plan records the apply, but this computer has no local record of the server.
        const { deps, before } = await hetznerDeployment({
          lastPlanHash: "ab".repeat(32),
          lastApplyAt: "2026-10-11T12:30:00.000Z",
        });
        const error = await runDesign(deps, { catalog: doEuCatalog() }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
        const { message, hint } = error as { message: string; hint: string };
        expect(message).toBe(
          "Your app is deployed on Hetzner Cloud, but opscrew/requirements.yaml now asks for DigitalOcean. opscrew/plan.yaml was not changed.",
        );
        expect(hint).toBe(
          "OpsCrew does not know the server's address on this computer: on the computer that provisioned it (its .opscrew/ folder holds the address), run `opscrew retarget --to digitalocean` to move the deployment with its data, or `opscrew destroy` there first and then `opscrew design`, or keep Hetzner Cloud by answering `opscrew interview` again.",
        );
        expect(hint).not.toContain("opscrew provision");
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);

        const preview = await previewDesignOptions(deps, { catalog: doEuCatalog() });
        const warning = preview.warnings.join("\n");
        expect(warning).toContain("Your app is deployed on Hetzner Cloud, but");
        expect(warning).toContain("on the computer that provisioned it");
        expect(warning).not.toContain("opscrew provision");
      });

      it("lets a plan that was planned but never applied switch providers", async () => {
        const { deps } = await hetznerDeployment({ lastPlanHash: "ab".repeat(32) });
        const result = await runDesign(deps, { catalog: doEuCatalog() });
        expect(result.plan.target.provider).toBe("digitalocean");
      });

      /** Writes a non-empty local state file, as a (partly) failed apply leaves behind. */
      async function writeState(deps: TestPhaseDeps, content = '{"version":4,"resources":[]}') {
        await mkdir(deps.paths.files.tfstateDir, { recursive: true });
        await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), content);
      }

      it("stops after a first apply that failed half-way (state file, no address, no apply recorded)", async () => {
        const { deps, before } = await hetznerDeployment({ lastPlanHash: "ab".repeat(32) });
        await writeState(deps);
        const error = await runDesign(deps, { catalog: doEuCatalog() }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
        expect((error as Error).message).toContain(
          "An earlier apply may have created resources at Hetzner Cloud",
        );
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);

        const preview = await previewDesignOptions(deps, { catalog: doEuCatalog() });
        expect(preview.warnings.join("\n")).toContain(
          "now asks for DigitalOcean. `opscrew design` will stop",
        );
      });

      it("lets a plan-only run without a state file (or with an empty one) switch providers", async () => {
        const { deps } = await hetznerDeployment({ lastPlanHash: "ab".repeat(32) });
        await writeState(deps, "");
        const result = await runDesign(deps, { catalog: doEuCatalog() });
        expect(result.plan.target.provider).toBe("digitalocean");
      });

      it("lets a destroyed deployment switch even though its state file remains", async () => {
        const { deps } = await hetznerDeployment({
          lastApplyAt: "2026-10-11T12:30:00.000Z",
          destroyedAt: "2026-10-12T09:00:00.000Z",
        });
        await writeState(deps);
        const result = await runDesign(deps, { catalog: doEuCatalog() });
        expect(result.plan.target.provider).toBe("digitalocean");
      });

      it("the preview still lists the options and warns that design would stop", async () => {
        const { deps, before } = await hetznerDeployment(
          {
            lastCompletedPhase: "provision",
            lastApplyAt: "2026-10-11T12:30:00.000Z",
          },
          true,
        );
        const preview = await previewDesignOptions(deps, { catalog: doEuCatalog() });
        expect(preview.options.map((o) => o.id)).toContain("digitalocean-single-s-1vcpu-2gb-fra1");
        const warning = preview.warnings.join("\n");
        expect(warning).toContain("Your app is deployed on Hetzner Cloud, but");
        expect(warning).toContain(
          "now asks for DigitalOcean. `opscrew design` will stop without changing opscrew/plan.yaml.",
        );
        expect(warning).toMatch(
          /Run `opscrew retarget --to digitalocean` to move the deployment with its data, .*answering `opscrew interview` again\.$/,
        );
        expect(
          deps.reporter.lines.some((l) => l.level === "warn" && /Hetzner Cloud/.test(l.message)),
        ).toBe(true);
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);

        // A destroyed deployment previews without that warning.
        const destroyed = await hetznerDeployment({
          lastApplyAt: "2026-10-11T12:30:00.000Z",
          destroyedAt: "2026-10-12T09:00:00.000Z",
        });
        const clean = await previewDesignOptions(destroyed.deps, { catalog: doEuCatalog() });
        expect(clean.warnings.join("\n")).not.toContain("now asks for DigitalOcean");
      });
    });

    describe("while a move to another provider is in progress", () => {
      /** A Hetzner deployment that `opscrew retarget` is moving to DigitalOcean. */
      async function movingDeployment(): Promise<{ deps: TestPhaseDeps; before: string }> {
        const deps = await setup();
        await runDesign(deps, { catalog: euCatalog() });
        const plan = await readArtifact("plan", deps.paths.files.plan);
        await writeArtifact("plan", deps.paths.files.plan, {
          ...plan,
          target: {
            provider: "digitalocean",
            mode: "vps-compose",
            location: "fra1",
            serverType: "s-1vcpu-2gb",
            image: "ubuntu-24-04-x64",
            backups: true,
          },
          deployment: { lastApplyAt: "2026-10-11T12:30:00.000Z" },
          retarget: {
            from: { target: cloudTarget(plan.target) },
            step: "renamed",
            startedAt: "2026-10-12T09:00:00.000Z",
          },
        });
        await writeArtifact("requirements", deps.paths.files.requirements, doRequirements());
        return { deps, before: await readFile(deps.paths.files.plan, "utf8") };
      }

      it("stops before anything else and leaves plan.yaml and the phase as they were", async () => {
        const { deps, before } = await movingDeployment();
        let asked = false;
        const error = await runDesign(deps, {
          catalog: doEuCatalog(),
          choose: async (options) => {
            asked = true;
            return options[0]?.id ?? "";
          },
        }).catch((e: unknown) => e);
        expect(error).toMatchObject({
          code: "PHASE_PRECONDITION",
          message: "A move to DigitalOcean is in progress.",
          hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
        });
        expect(asked).toBe(false);
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
        expect((await deps.state.read()).phases.design?.status).toBe("ok");
      });

      it("the preview still lists the options and warns that design would stop", async () => {
        const { deps, before } = await movingDeployment();
        const preview = await previewDesignOptions(deps, { catalog: doEuCatalog() });
        expect(preview.options.length).toBeGreaterThan(0);
        const warning = preview.warnings.join("\n");
        expect(warning).toContain("A move to DigitalOcean is in progress.");
        expect(warning).toContain("`opscrew design` will stop without changing opscrew/plan.yaml");
        expect(warning).toContain("`opscrew retarget --finish` after the switch");
        expect(warning).not.toContain("now asks for DigitalOcean");
        expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
      });
    });
  });

  it("keeps the Hetzner image and provider in Hetzner plans", async () => {
    const deps = await setup();
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.target).toMatchObject({ provider: "hetzner", image: "ubuntu-24.04" });
  });

  it("says which artefact is missing", async () => {
    const deps = await createTestPhaseDeps();
    await expect(runDesign(deps, { catalog: euCatalog() })).rejects.toMatchObject({
      code: "ARTIFACT_MISSING",
      hint: expect.stringContaining("opscrew analyze"),
    });
    expect((await deps.state.read()).phases.design?.status).toBe("failed");
  });
});

describe("runDesign: the image builder and the deploy strategy", () => {
  const later = (deps: TestPhaseDeps) =>
    createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      clock: { now: () => new Date("2026-10-12T08:00:00.000Z") },
    });

  it("writes app.build and deploy with their reasons, and shows both", async () => {
    const deps = await setup();
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.app.build).toEqual({
      builder: "generated-dockerfile",
      chosen: "auto",
      reason:
        "OpsCrew has a Dockerfile for a static site built with Vite, which builds a small image that runs as a non-root user.",
      runtime: { language: "node", version: "24" },
      probe: "wget",
      automatic: "generated-dockerfile",
    });
    expect(plan.deploy).toEqual({ strategy: "rolling", drainSeconds: 30 });
    expect(plan.supplyChain).toEqual({ sign: false });
    expect(plan.cicd.deployTags).toEqual({ enabled: false, release: false });
    const text = deps.reporter.text();
    expect(text).toContain(`Image builder: generated-dockerfile. ${plan.app.build?.reason}`);
    expect(text).toContain("Deploys: rolling. New versions start next to the running one");
  });

  it("warns about a runtime version past its end of life", async () => {
    const deps = await setup(nextPostgresFacts({ runtimeVersions: { node: "20" } }));
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.app.build?.runtime).toEqual({ language: "node", version: "20" });
    expect(result.warnings.join("\n")).toContain("Node.js 20 is past its end of life");
  });

  it("copies the interview's signing and deploy tags", async () => {
    const deps = await setup(
      staticSpaFacts(),
      makeRequirements({ signImages: true, deployTags: "tag-and-release" }),
    );
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.supplyChain).toEqual({ sign: true });
    expect(plan.cicd.deployTags).toEqual({ enabled: true, release: true });
  });

  it("keeps the recorded version and the user's plan.yaml settings on later designs", async () => {
    const deps = await setup();
    const first = await runDesign(deps, { catalog: euCatalog() });
    const build = first.plan.app.build as NonNullable<DeployPlan["app"]["build"]>;
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      app: { ...first.plan.app, build: { ...build, runtime: { language: "node", version: "22" } } },
      deploy: { strategy: "recreate", drainSeconds: 60 },
      supplyChain: { sign: true },
      cicd: {
        ...first.plan.cicd,
        deployTags: { enabled: true, release: false },
        imageRetention: { enabled: false, keep: 10 },
      },
    });
    const again = await later(deps);
    const { plan } = await runDesign(again, { catalog: euCatalog() });
    expect(plan.app.build?.runtime).toEqual({ language: "node", version: "22" });
    expect(plan.deploy).toEqual({ strategy: "recreate", drainSeconds: 60 });
    expect(again.reporter.text()).toContain(
      "Deploys: recreate. You chose recreate in opscrew/plan.yaml (deploy.strategy).",
    );
    expect(plan.supplyChain).toEqual({ sign: true });
    expect(plan.cicd.deployTags).toEqual({ enabled: true, release: false });
    expect(plan.cicd.imageRetention).toEqual({ enabled: false, keep: 10 });
  });

  it("takes signing and deploy tags from an interview answered after the plan", async () => {
    const deps = await setup();
    const first = await runDesign(deps, { catalog: euCatalog() });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      supplyChain: { sign: true },
    });
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({ answeredAt: "2026-10-12T07:00:00.000Z", deployTags: "tag" }),
    );
    const { plan } = await runDesign(await later(deps), { catalog: euCatalog() });
    expect(plan.supplyChain).toEqual({ sign: false });
    expect(plan.cicd.deployTags).toEqual({ enabled: true, release: false });
  });

  it("stops without changing plan.yaml when the user's builder cannot build the app", async () => {
    const deps = await setup({ ...staticSpaFacts(), packageManager: "pnpm" });
    const first = await runDesign(deps, { catalog: euCatalog() });
    const build = first.plan.app.build as NonNullable<DeployPlan["app"]["build"]>;
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      app: { ...first.plan.app, build: { ...build, builder: "buildpacks", chosen: "user" } },
    });
    const before = await readFile(deps.paths.files.plan, "utf8");
    await expect(runDesign(await later(deps), { catalog: euCatalog() })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(
        "opscrew/plan.yaml sets app.build.builder to buildpacks, but the pinned Buildpacks builder has no pnpm support",
      ),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });
});
