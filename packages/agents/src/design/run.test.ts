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
  serviceOf,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runInterview } from "../interview";
import { assembleAppEnv, recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  doEuCatalog,
  euCatalog,
  MemoryCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  offer,
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

  it("FR-812: warns once that background jobs without a worker will not run, naming the library", async () => {
    const facts = nextPostgresFacts({
      appKind: "api",
      services: [{ kind: "queue", evidence: ["dependency:celery"] }],
    });
    const deps = await setup(facts);
    const result = await runDesign(deps, { catalog: euCatalog() });
    const notes = result.warnings.filter((w) => w.includes("background jobs"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Celery");
    expect(notes[0]).toContain("OpsCrew found no worker that runs them");
    expect(notes[0]).toContain("processes.workers in opscrew/plan.yaml");
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
    expect(serviceOf(result.plan, "postgres")).toBeDefined();
    expect(result.plan.target).toMatchObject({ backups: true });
  });

  it("keeps createdAt of an earlier plan, and the whole plan when nothing changed (SC-1307)", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: euCatalog() });
    const first = await readFile(deps.paths.files.plan, "utf8");
    const later = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      clock: { now: () => new Date("2026-10-12T08:00:00.000Z") },
    });
    const same = await runDesign(later, { catalog: euCatalog() });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(first);
    expect(same.plan.updatedAt).toBe("2026-10-11T12:00:00.000Z");
    expect(later.reporter.text()).toContain("opscrew/plan.yaml is up to date");
    // A changed answer changes the plan: it gets a new date and keeps its first one.
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({ answeredAt: "2026-10-12T07:00:00.000Z", signImages: true }),
    );
    const result = await runDesign(later, { catalog: euCatalog() });
    expect(result.plan.createdAt).toBe("2026-10-11T12:00:00.000Z");
    expect(result.plan.updatedAt).toBe("2026-10-12T08:00:00.000Z");
  });

  it("FR-1446: writes vercel.json's rules as the additions of the plan's proxy, and counts that edge's memory", async () => {
    const platformRouting = {
      source: "vercel.json" as const,
      sha256: "a".repeat(64),
      redirects: [],
      rewrites: [{ index: 0, source: "/(.*)", destination: "/index.html" }],
      headers: [],
      unsupported: [],
    };
    const deps = await setup({ ...staticSpaFacts(), platformRouting });
    const first = await runDesign(deps, { catalog: euCatalog() });
    expect(first.lines).toContain(
      "Wrote opscrew/proxy/additions.caddy: vercel.json's routing rules for Caddy, in Vercel's order. The file is yours to edit from now on.",
    );
    const caddy = await readFile(join(deps.paths.root, "opscrew/proxy/additions.caddy"), "utf8");
    expect(caddy).toContain("handle @rewrite0 {");
    expect(first.lines.join("\n")).toContain("OpsCrew's edge and the system 512 MB");
    // The user moves the server to nginx: design writes nginx's additions and counts its 192 MB.
    const nginx = { ...first.plan, target: { ...first.plan.target, edge: "nginx" } } as DeployPlan;
    await writeArtifact("plan", deps.paths.files.plan, nginx);
    const second = await runDesign(deps, { catalog: euCatalog() });
    expect(second.plan.target).toMatchObject({ edge: "nginx" });
    expect(second.lines).toContain(
      "Wrote opscrew/proxy/additions.nginx: vercel.json's routing rules for nginx, in Vercel's order. The file is yours to edit from now on.",
    );
    expect(second.lines.join("\n")).toContain("OpsCrew's edge and the system 576 MB");
    expect(first.chosen.summary).toContain("with Docker Compose behind Caddy.");
    expect(second.chosen.summary).toContain("with Docker Compose behind nginx.");
    expect(await readFile(join(deps.paths.root, "opscrew/proxy/additions.caddy"), "utf8")).toBe(
      caddy,
    );
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
            keepExternalServices: {},
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
        edge: "caddy",
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
            edge: "caddy",
          },
          deployment: { lastApplyAt: "2026-10-11T12:30:00.000Z" },
          retarget: {
            from: { target: cloudTarget(plan.target), deploy: plan.deploy },
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
    expect(first.plan.target).toMatchObject({ edge: "caddy" });
    expect(first.plan.app.maxBodyMb).toBe(100);
    const build = first.plan.app.build as NonNullable<DeployPlan["app"]["build"]>;
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      app: {
        ...first.plan.app,
        build: { ...build, runtime: { language: "node", version: "22" } },
        maxBodyMb: 512,
      },
      target: { ...cloudTarget(first.plan.target), edge: "nginx" },
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
    expect(plan.app.maxBodyMb).toBe(512);
    expect(plan.target).toMatchObject({ edge: "nginx" });
    expect(plan.deploy).toEqual({ strategy: "recreate", drainSeconds: 60 });
    expect(again.reporter.text()).toContain(
      "Deploys: recreate. You chose recreate in opscrew/plan.yaml (deploy.strategy).",
    );
    expect(plan.supplyChain).toEqual({ sign: true });
    expect(plan.cicd.deployTags).toEqual({ enabled: true, release: false });
    expect(plan.cicd.imageRetention).toEqual({ enabled: false, keep: 10 });
  });

  it("keeps the path of the user's own Dockerfile they chose in plan.yaml", async () => {
    const deps = await setup(nextPostgresFacts({ docker: { dockerfile: "Dockerfile" } }));
    const first = await runDesign(deps, { catalog: euCatalog() });
    const build = first.plan.app.build as NonNullable<DeployPlan["app"]["build"]>;
    expect(build.builder).toBe("own-dockerfile");
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      app: {
        ...first.plan.app,
        dockerfile: "docker/production.Dockerfile",
        build: { ...build, chosen: "user" },
      },
    });
    const { plan } = await runDesign(await later(deps), { catalog: euCatalog() });
    expect(plan.app.dockerfile).toBe("docker/production.Dockerfile");
    expect(plan.app.build).toMatchObject({ builder: "own-dockerfile", chosen: "user" });
  });

  it("keeps the secret, source and optional the user set on each variable still there", async () => {
    const deps = await setup(nextPostgresFacts());
    const first = await runDesign(deps, { catalog: euCatalog() });
    expect(first.plan.app.env).toEqual([
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "NEXTAUTH_SECRET", secret: true, source: "generated" },
      { name: "NEXT_PUBLIC_SITE_URL", secret: false, source: "user" },
    ]);
    const edited = [
      { name: "DATABASE_URL", secret: true, source: "derived" },
      // The user brings their own value instead of OpsCrew's generated one.
      { name: "NEXTAUTH_SECRET", secret: true, source: "user" },
      // A build value that must reach the build as a secret mount, never as a build argument.
      { name: "NEXT_PUBLIC_SITE_URL", secret: true, source: "user", optional: true },
      { name: "REMOVED_FROM_THE_CODE", secret: false, source: "user" },
    ] as const;
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      app: { ...first.plan.app, env: [...edited] },
    });
    const { plan } = await runDesign(await later(deps), { catalog: euCatalog() });
    expect(plan.app.env).toEqual(edited.slice(0, 3));
  });

  describe("when the facts change between designs", () => {
    const reanalysed = async (deps: TestPhaseDeps, facts: Architecture["facts"]) => {
      const architecture = await readArtifact("architecture", deps.paths.files.architecture);
      await writeArtifact("architecture", deps.paths.files.architecture, {
        ...architecture,
        facts,
      });
    };
    const variable = (plan: DeployPlan, name: string) => plan.app.env.find((v) => v.name === name);

    it("fills a service's variables from the service turned on or off, keeping the user's others", async () => {
      const deps = await setup(nextPostgresFacts());
      const first = await runDesign(deps, { catalog: euCatalog() });
      expect(variable(first.plan, "DATABASE_URL")).toMatchObject({ source: "derived" });
      // The user brings their own NEXTAUTH_SECRET.
      const own = (plan: DeployPlan) => ({
        ...plan,
        app: {
          ...plan.app,
          env: plan.app.env.map((v) =>
            v.name === "NEXTAUTH_SECRET" ? { ...v, source: "user" as const } : v,
          ),
        },
      });
      await writeArtifact("plan", deps.paths.files.plan, own(first.plan));

      // Postgres turned off in plan.yaml: DATABASE_URL is the user's.
      const turned = (plan: DeployPlan, enabled: boolean) => ({
        ...plan,
        services: plan.services.map((s) => ({ ...s, enabled })),
        // Postgres turned off is reached where it is hosted; on again, it is not.
        externalServices: plan.externalServices.filter((kind) => kind !== "postgres"),
      });
      await writeArtifact("plan", deps.paths.files.plan, turned(own(first.plan), false));
      const off = await runDesign(await later(deps), { catalog: euCatalog() });
      expect(serviceOf(off.plan, "postgres")).toBeUndefined();
      expect(variable(off.plan, "DATABASE_URL")).toEqual({
        name: "DATABASE_URL",
        secret: true,
        source: "user",
      });
      expect(variable(off.plan, "NEXTAUTH_SECRET")).toMatchObject({ source: "user" });

      // Postgres on again: OpsCrew fills DATABASE_URL from it.
      await writeArtifact("plan", deps.paths.files.plan, turned(off.plan, true));
      const on = await runDesign(await later(deps), { catalog: euCatalog() });
      expect(variable(on.plan, "DATABASE_URL")).toEqual({
        name: "DATABASE_URL",
        secret: true,
        source: "derived",
      });
      expect(variable(on.plan, "NEXTAUTH_SECRET")).toMatchObject({ source: "user" });
    });

    it("keeps a name newly detected as secret secret, with the user's other settings", async () => {
      const deps = await setup(nextPostgresFacts());
      const first = await runDesign(deps, { catalog: euCatalog() });
      await writeArtifact("plan", deps.paths.files.plan, {
        ...first.plan,
        app: {
          ...first.plan.app,
          env: first.plan.app.env.map((v) =>
            v.name === "NEXT_PUBLIC_SITE_URL" ? { ...v, optional: true } : v,
          ),
        },
      });
      const facts = nextPostgresFacts();
      await reanalysed(deps, {
        ...facts,
        envVars: facts.envVars.map((v) =>
          v.name === "NEXT_PUBLIC_SITE_URL" ? { ...v, secretLikely: true } : v,
        ),
      });
      const { plan } = await runDesign(await later(deps), { catalog: euCatalog() });
      // Never kept as a build argument: secret values reach the build only as secret mounts.
      expect(variable(plan, "NEXT_PUBLIC_SITE_URL")).toEqual({
        name: "NEXT_PUBLIC_SITE_URL",
        secret: true,
        source: "user",
        optional: true,
      });
    });
  });

  it("keeps source: user on a Rails production setting", async () => {
    const rails = makeFacts({
      name: "shop",
      languages: ["ruby"],
      frameworks: [{ name: "rails", path: "." }],
      appKind: "fullstack",
      runtimeVersions: { ruby: "3.4" },
    });
    const deps = await setup(rails);
    const first = await runDesign(deps, { catalog: euCatalog() });
    const env = first.plan.app.env.map((v) =>
      v.name === "RAILS_ENV" ? { ...v, source: "user" as const } : v,
    );
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      app: { ...first.plan.app, env },
    });
    const { plan } = await runDesign(await later(deps), { catalog: euCatalog() });
    expect(plan.app.env.find((v) => v.name === "RAILS_ENV")).toEqual({
      name: "RAILS_ENV",
      secret: false,
      source: "user",
    });
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

describe("runDesign: components", () => {
  const later = (deps: TestPhaseDeps) =>
    createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      clock: { now: () => new Date("2026-10-12T08:00:00.000Z") },
    });
  const two = () =>
    makeFacts({
      services: [
        { kind: "postgres", evidence: ["dependency:pg"], variable: "DATABASE_URL" },
        { kind: "mysql", evidence: ["dependency:mysql2"] },
      ],
    });

  it("writes the components and says what each is, with their memory on the server", async () => {
    const deps = await setup(two());
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.services.map((s) => [s.name, s.variable])).toEqual([
      ["db", "DATABASE_URL"],
      ["mysql", "MYSQL_URL"],
    ]);
    // The DATABASE_URL both databases claim is said at design.
    const said = deps.reporter.text();
    expect(said).toContain(
      "PostgreSQL keeps it, and MySQL's address goes to MYSQL_URL. Make sure the app reads MySQL's address from MYSQL_URL.",
    );
    expect(said).toContain("MySQL 8.4 (mysql, 512 MB): The app uses MySQL through mysql2.");
    expect(said).toContain("MySQL is under the GPL 2.0");
    expect(result.lines.join("\n")).toMatch(
      /Memory limits: the app 512 MB \(€[\d.]+\/month\), db 512 MB \(€[\d.]+\/month\), mysql 512 MB/,
    );
    expect(result.plan.app.env.map((v) => [v.name, v.source])).toEqual([
      ["DATABASE_URL", "derived"],
      ["MYSQL_URL", "derived"],
    ]);
  });

  it("keeps the user's component edits in plan.yaml, says so and sizes the server again", async () => {
    const deps = await setup(
      makeFacts({ services: [{ kind: "mysql", evidence: ["dependency:mysql2"] }] }),
    );
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.target).toMatchObject({ serverType: "cx13", location: "fsn1" });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      app: { ...plan.app, memoryMb: 2048 },
      services: plan.services.map((s) => ({ ...s, memoryMb: 2048 })),
      // An earlier apply: the server exists, so design says it would be resized.
      deployment: { ...plan.deployment, lastApplyAt: "2026-10-11T13:00:00.000Z" },
    });
    const rerun = await later(deps);
    const result = await runDesign(rerun, { catalog: euCatalog() });
    expect(result.plan.app.memoryMb).toBe(2048);
    expect(result.plan.services[0]?.memoryMb).toBe(2048);
    expect(rerun.reporter.text()).toContain(
      "Kept your changes in opscrew/plan.yaml: the app's memory (2048 MB) and the service mysql (memory 2048 MB).",
    );
    // 2048 + 2048 MB, plus the edge and the system, no longer fit 4 GB: the next server has 8.
    expect(result.plan.target).toMatchObject({ serverType: "cx33" });
    expect(result.warnings.join("\n")).toContain(
      "Your server already runs in fsn1 (cx13). The chosen option uses nbg1 (cx33)",
    );
  });

  it("changes no file when run again with nothing changed, components included (SC-1307)", async () => {
    const deps = await setup(
      makeFacts({
        services: [
          { kind: "mysql", evidence: ["dependency:mysql2"] },
          { kind: "queue", evidence: ["dependency:bullmq"] },
          { kind: "redis", evidence: ["dependency:bullmq"] },
          { kind: "s3", evidence: ["dependency:@aws-sdk/client-s3"] },
        ],
        workers: [
          { name: "bullmq", source: "library", single: false, evidence: ["dependency:bullmq"] },
        ],
        cronJobs: [{ schedule: "0 5 * * *", route: "/api/cron/cleanup", source: "vercel.json" }],
        objectStorage: { client: "@aws-sdk/client-s3", presignedUploads: true, variables: [] },
      }),
      makeRequirements({
        workerCommands: { bullmq: "node dist/worker.js" },
        keepExternalServices: { s3: false },
      }),
    );
    await runDesign(deps, { catalog: euCatalog() });
    const files = async () =>
      Promise.all(
        [deps.paths.files.plan, deps.paths.files.requirements, deps.paths.files.architecture].map(
          (file) => readFile(file, "utf8"),
        ),
      );
    const first = await files();
    const rerun = await later(deps);
    const again = await runDesign(rerun, { catalog: euCatalog() });
    expect(await files()).toEqual(first);
    expect(again.plan.processes.workers.map((w) => w.command)).toEqual(["node dist/worker.js"]);
    expect(again.plan.storage?.objectStorage?.provider).toBe("hetzner");
    expect(rerun.reporter.text()).not.toContain("Kept your changes");
  });

  it("writes the plan after a newer interview with nothing changed, so a later hand edit stays", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: euCatalog() });
    // The same answers again, after the plan was written.
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({ answeredAt: "2026-10-12T07:00:00.000Z" }),
    );
    const noop = await runDesign(await later(deps), { catalog: euCatalog() });
    expect(noop.plan.updatedAt).toBe("2026-10-12T08:00:00.000Z");
    // The user turns signing on by hand; the next design keeps it.
    await writeArtifact("plan", deps.paths.files.plan, {
      ...noop.plan,
      supplyChain: { sign: true },
    });
    const third = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      clock: { now: () => new Date("2026-10-13T08:00:00.000Z") },
    });
    const result = await runDesign(third, { catalog: euCatalog() });
    expect(result.plan.supplyChain).toEqual({ sign: true });
  });

  it("keeps a service plan.yaml lists that detection no longer finds, and a kept options edit", async () => {
    const deps = await setup(
      makeFacts({
        services: [
          { kind: "mongodb", evidence: ["dependency:@prisma/client", "prisma:mongodb"] },
          { kind: "queue", evidence: ["dependency:bullmq"] },
          { kind: "redis", evidence: ["dependency:bullmq"] },
          { kind: "nats", evidence: ["dependency:nats"] },
        ],
      }),
    );
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.services.map((s) => [s.name, s.options])).toEqual([
      ["mongodb", { replicaSet: true }],
      ["queue", { mode: "queue" }],
      ["nats", {}],
    ]);
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      services: plan.services.map((s) =>
        s.kind === "mongodb"
          ? { ...s, options: { replicaSet: false } }
          : s.kind === "valkey"
            ? { ...s, options: { mode: "cache" as const } }
            : s,
      ),
    });
    // The app no longer uses NATS.
    const architecture = await readArtifact("architecture", deps.paths.files.architecture);
    await writeArtifact("architecture", deps.paths.files.architecture, {
      ...architecture,
      facts: {
        ...architecture.facts,
        services: architecture.facts.services.filter((s) => s.kind !== "nats"),
      },
    });
    const rerun = await later(deps);
    const result = await runDesign(rerun, { catalog: euCatalog() });
    expect(result.plan.services.map((s) => [s.name, s.options])).toEqual([
      ["mongodb", { replicaSet: false }],
      ["queue", { mode: "cache" }],
      ["nats", {}],
    ]);
    const said = rerun.reporter.text();
    expect(said).toContain(
      "nats stays because plan.yaml lists it, though the app no longer seems to use it. Delete it there to remove it.",
    );
    expect(said).toContain("the service mongodb (its options) and the service queue (its options)");
  });

  it("keeps a user's own variable that merely looks like a storage one when a bucket comes", async () => {
    const endpoint = {
      name: "API_ENDPOINT",
      files: ["src/api.ts"],
      clientExposed: false,
      secretLikely: false,
    };
    const deps = await setup(
      makeFacts({ envVars: [endpoint] }),
      makeRequirements({ keepExternalServices: { s3: false } }),
    );
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      app: { ...plan.app, env: plan.app.env.map((v) => ({ ...v, secret: true })) },
    });
    const architecture = await readArtifact("architecture", deps.paths.files.architecture);
    await writeArtifact("architecture", deps.paths.files.architecture, {
      ...architecture,
      facts: {
        ...architecture.facts,
        services: [{ kind: "s3", evidence: ["dependency:@aws-sdk/client-s3"] }],
        objectStorage: { client: "@aws-sdk/client-s3", presignedUploads: false, variables: [] },
      },
    });
    const result = await runDesign(await later(deps), { catalog: euCatalog() });
    expect(result.plan.storage?.objectStorage).toBeDefined();
    expect(result.plan.app.env.find((v) => v.name === "API_ENDPOINT")).toEqual({
      name: "API_ENDPOINT",
      secret: true,
      source: "user",
    });
  });

  it("plans cron routes the image cannot call turned off, says what to do, and keeps them on once turned on", async () => {
    const facts = {
      ...staticSpaFacts(),
      cronJobs: [
        { schedule: "0 5 * * *", route: "/api/cron/cleanup", source: "vercel.json" as const },
      ],
    };
    const deps = await setup(facts);
    // A first design, with no plan.yaml yet: the plan is written with the job off.
    const first = await runDesign(deps, { catalog: euCatalog() });
    expect(first.plan.app.build?.probe).toBe("wget");
    expect(first.plan.processes.cron).toEqual([
      { name: "cleanup", schedule: "0 5 * * *", route: "/api/cron/cleanup", enabled: false },
    ]);
    expect(first.plan.app.env.map((v) => v.name)).not.toContain("CRON_SECRET");
    const said = deps.reporter.text();
    expect(said).toContain(
      "The cron job cleanup calls the app's routes, but the image is a static site served by Caddy, whose busybox wget cannot send the job's secret, and a static site answers no route, so OpsCrew turned it off in opscrew/plan.yaml (processes.cron). To run it, deploy the app with a server that answers the routes (app.build.builder: railpack with app.build.chosen: user), or give each job a command that runs its code in the image instead of the route; then set enabled: true.",
    );
    expect(said).not.toContain("Cron job cleanup (");
    // The user turns it on; the next design keeps it on (provision's renderer is the backstop).
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      processes: {
        ...first.plan.processes,
        cron: first.plan.processes.cron.map((job) => ({ ...job, enabled: true })),
      },
    });
    const rerun = await later(deps);
    const second = await runDesign(rerun, { catalog: euCatalog() });
    expect(second.plan.processes.cron[0]?.enabled).toBe(true);
    expect(rerun.reporter.text()).not.toContain("OpsCrew turned it off");
  });

  it("says how to run cron routes when the user's own Dockerfile builds the image", async () => {
    const facts = makeFacts({
      docker: { dockerfile: "Dockerfile" },
      cronJobs: [
        { schedule: "0 5 * * *", route: "/api/cron/a", source: "vercel.json" },
        { schedule: "0 6 * * *", route: "/api/cron/b", source: "vercel.json" },
      ],
    });
    const deps = await setup(facts);
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.processes.cron.map((job) => job.enabled)).toEqual([false, false]);
    expect(deps.reporter.text()).toContain(
      "The cron jobs a and b call the app's routes, but your own Dockerfile builds the image, so OpsCrew knows no tool in it that can call a route with the job's secret, so OpsCrew turned them off in opscrew/plan.yaml (processes.cron). To run them, let OpsCrew build the image (app.build.builder: railpack with app.build.chosen: user)",
    );
  });

  it("refuses an SQLite folder that holds the app's own files, before writing anything", async () => {
    const facts = makeFacts({ sqlite: { paths: ["prisma/dev.db"], dir: "prisma" } });
    const deps = await setup(facts);
    await mkdir(join(deps.paths.root, "prisma"), { recursive: true });
    await writeFile(join(deps.paths.root, "prisma", "schema.prisma"), "datasource db {}\n");
    await expect(runDesign(deps, { catalog: euCatalog() })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("prisma/, which also holds the app's own files"),
      hint: expect.stringContaining("for example data/"),
    });
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
  });

  it("refuses Django's SQLite database in the app's root, saying how to move it", async () => {
    const facts = makeFacts({
      languages: ["python"],
      frameworks: [{ name: "django", path: "." }],
      sqlite: { paths: ["db.sqlite3"], dir: "." },
    });
    await expect(runDesign(await setup(facts), { catalog: euCatalog() })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("in the app's own folder, which holds the app's code"),
      hint: expect.stringContaining("Move the database into a folder of its own"),
    });
  });

  it("moves Laravel's stock database out of database/ and points DB_DATABASE there", async () => {
    const facts = makeFacts({
      languages: ["php"],
      packageManager: "none",
      frameworks: [{ name: "laravel", path: "." }],
      services: [{ kind: "sqlite", evidence: ["env:DB_CONNECTION=sqlite"] }],
      sqlite: { paths: ["database/database.sqlite"], dir: "database" },
    });
    const deps = await setup(facts);
    await mkdir(join(deps.paths.root, "database", "migrations"), { recursive: true });
    await writeFile(join(deps.paths.root, "database", "migrations", "0001_users.php"), "<?php\n");
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.app.build?.builder).toBe("railpack");
    expect(plan.storage).toEqual({ sqlite: { dir: "storage/database" } });
    expect(plan.app.env).toContainEqual({ name: "DB_DATABASE", secret: false, source: "derived" });
    expect(deps.reporter.text()).toContain(
      "The database moves there from database/, which also holds the app's own files, and DB_DATABASE points Laravel at it.",
    );
    const env = await assembleAppEnv({ plan, dotenvText: "", password: () => "x" });
    expect(env.values.app.DB_DATABASE).toBe("/app/storage/database/database.sqlite");
  });

  it("moves Prisma's database out of prisma/ and points DATABASE_URL there", async () => {
    const facts = makeFacts({
      frameworks: [{ name: "express", path: "." }],
      build: { startCommand: "node server.js" },
      envVars: [
        {
          name: "DATABASE_URL",
          files: ["prisma/schema.prisma"],
          clientExposed: false,
          secretLikely: true,
        },
      ],
      services: [{ kind: "sqlite", evidence: ["dependency:@prisma/client", "prisma:sqlite"] }],
      sqlite: { paths: ["prisma/dev.db"], dir: "prisma" },
    });
    const deps = await setup(facts);
    await mkdir(join(deps.paths.root, "prisma"), { recursive: true });
    await writeFile(join(deps.paths.root, "prisma", "schema.prisma"), "datasource db {}\n");
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.storage).toEqual({ sqlite: { dir: "data" } });
    expect(plan.app.env).toEqual([{ name: "DATABASE_URL", secret: false, source: "derived" }]);
    const env = await assembleAppEnv({ plan, dotenvText: "", password: () => "x" });
    expect(env.values.app.DATABASE_URL).toBe("file:/app/data/app.db");
  });

  it("moves the database into the user's own image at its WORKDIR, and refuses without one", async () => {
    const facts = (workdir?: string) =>
      makeFacts({
        languages: ["php"],
        packageManager: "none",
        frameworks: [{ name: "laravel", path: "." }],
        build: workdir === undefined ? {} : { workdir },
        docker: { dockerfile: "Dockerfile" },
        sqlite: { paths: ["database/database.sqlite"], dir: "database" },
      });
    await expect(runDesign(await setup(facts()), { catalog: euCatalog() })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("has no WORKDIR with an absolute path"),
      hint: "Add a WORKDIR with an absolute path to the last stage of Dockerfile (for example WORKDIR /app), then run `opscrew analyze` and `opscrew design` again.",
    });
    const { plan } = await runDesign(await setup(facts("/var/www/html")), {
      catalog: euCatalog(),
    });
    expect(plan.app.build).toMatchObject({ builder: "own-dockerfile", workdir: "/var/www/html" });
    const env = await assembleAppEnv({ plan, dotenvText: "", password: () => "x" });
    expect(env.values.app.DB_DATABASE).toBe("/var/www/html/storage/database/database.sqlite");
  });

  it("refuses SQLite in the user's own image without a WORKDIR, before provision would stop", async () => {
    const facts = makeFacts({
      docker: { dockerfile: "Dockerfile" },
      sqlite: { paths: ["data/app.db"], dir: "data" },
    });
    const deps = await setup(facts);
    await expect(runDesign(deps, { catalog: euCatalog() })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message:
        "The app keeps its SQLite database in data/ on a persistent volume, but OpsCrew does not know the folder the app runs in, because the last stage of your Dockerfile (Dockerfile) has no WORKDIR with an absolute path. plan.yaml was not changed.",
      hint: "Add a WORKDIR with an absolute path to the last stage of Dockerfile (for example WORKDIR /app), then run `opscrew analyze` and `opscrew design` again.",
    });
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
  });

  it("warns that a deployed SQLite volume keeps its owner when the builder changes", async () => {
    const facts = makeFacts({ sqlite: { paths: ["data/app.db"], dir: "data" } });
    const deps = await setup(facts);
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    const builder = plan.app.build?.builder;
    // The deployed plan was built with Buildpacks, whose image runs as 1002:1001.
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      app: { ...plan.app, build: { ...plan.app.build, builder: "buildpacks" } },
      deployment: { ...plan.deployment, lastDeployAt: "2026-10-12T10:00:00.000Z" },
    } as DeployPlan);
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.plan.app.build?.builder).toBe(builder);
    const warning = result.warnings.find((text) => text.includes("SQLite volume"));
    expect(warning).toContain(
      `The app's image is now built with ${builder} instead of buildpacks (app.build.builder in opscrew/plan.yaml), but its SQLite volume keeps the owner Docker gave it when it was made (1002:1001)`,
    );
    expect(warning).toContain(
      `docker run --rm --user 0 --entrypoint chown -v ${plan.app.name}_sqlite:/d`,
    );
  });

  it("stops the old copy first for an app on SQLite in its own folder", async () => {
    const facts = makeFacts({ sqlite: { paths: ["data/app.db"], dir: "data" } });
    const { plan } = await runDesign(await setup(facts), { catalog: euCatalog() });
    expect(plan.storage).toEqual({ sqlite: { dir: "data" } });
    expect(plan.deploy).toMatchObject({ strategy: "recreate" });
    expect(plan.deploy.reason).toContain("SQLite");
  });

  it("warns when the chosen server keeps less than 15% of its memory free", async () => {
    const deps = await setup(
      makeFacts({ services: [{ kind: "kafka", evidence: ["dependency:kafkajs"] }] }),
    );
    const catalog = new MemoryCatalog([
      offer({ id: "cx22", vcpus: 2, memoryGb: 2, diskGb: 40, price: 4 }),
    ]);
    const result = await runDesign(deps, { catalog });
    expect(result.warnings).toContain(
      "The cx22 server keeps only 0% of its memory free after the containers' memory limits, OpsCrew's edge and the system, so a container that grows can make the server run out of memory. Choose a bigger option, or lower a memory limit in opscrew/plan.yaml.",
    );
  });
});
