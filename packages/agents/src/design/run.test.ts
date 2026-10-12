import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@opscrew/contracts";
import { materializeFixture } from "@opscrew/core/testing";
import {
  type Architecture,
  type DeployPlan,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, type TestPhaseDeps } from "../testing";
import {
  euCatalog,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
} from "./__fixtures__/catalog";
import { previewDesignOptions, runDesign } from "./index";

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

  it("uses --option when given and rejects an unknown id with the valid ones", async () => {
    const deps = await setup();
    const result = await runDesign(deps, {
      catalog: euCatalog(),
      optionId: "hetzner-single-cx33-nbg1",
    });
    expect(result.plan.target.serverType).toBe("cx33");

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
    expect(result.options.every((o) => o.summary.includes("estimate as of 2026-06-15"))).toBe(true);
    expect(result.warnings.join("\n")).toContain("HCLOUD_TOKEN is not set");
    expect(deps.reporter.lines.some((l) => l.level === "warn")).toBe(true);
    expect(result.plan.cost.source).toBe("static");
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
    expect(result.plan.target.backups).toBe(true);
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
    expect(result.plan.target.serverType).toBeDefined();
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
        serverIpv4: "203.0.113.10",
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
      expect(plan.deployment).toMatchObject({ serverIpv4: "203.0.113.10", lastPlanHash: HASH });
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
        deployed({ ...plan, target: { ...plan.target, serverType: "cx23" } }),
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
