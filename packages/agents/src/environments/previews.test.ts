import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { edgeMemoryMb } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { runDesign } from "../design/run";
import { appMemoryMb, SYSTEM_RESERVE_MB } from "../shared/memory";
import {
  createTestPhaseDeps,
  euCatalog,
  makeRequirements,
  nextPostgresFacts,
  type TestPhaseDeps,
  TOKEN,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { addEnvironment, type EnvironmentQuestion, removeEnvironment } from "./index";

const DOMAIN = "shop.example.com";
const ZONE = "example.com";
const API = "https://api.cloudflare.com/client/v4";
const SEED = "npx prisma db seed";

/** A fake Cloudflare API: the zone `ZONE` (id z1), its records at any name `records`. */
function cloudflare(records: { type: string; name: string; content: string }[] = []) {
  const asked: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(new URL(API).pathname, "");
    asked.push(`${path}${url.search}`);
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        headers: { "content-type": "application/json" },
      });
    if (path === "/zones") {
      const name = url.searchParams.get("name");
      return ok(
        name === ZONE ? [{ id: "z1", name: ZONE, status: "active", name_servers: [] }] : [],
      );
    }
    if (path === "/zones/z1/dns_records") {
      return ok(records.map((record, i) => ({ id: `r${i}`, ttl: 1, ...record })));
    }
    throw new Error(`unrouted ${path}`);
  };
  return { fetch, asked };
}

interface App {
  prod: TestPhaseDeps;
  preview: TestPhaseDeps;
  asked: string[];
}

/**
 * A designed prod app (Next.js with Postgres on `DOMAIN` on Cloudflare, or `facts`), and the deps
 * of its `preview` environment, with a Cloudflare token and the fake API.
 */
async function prodApp(
  options: {
    facts?: ProjectFacts;
    requirements?: Requirements;
    records?: Parameters<typeof cloudflare>[0];
    plan?: DeployPlan;
  } = {},
): Promise<App> {
  const prod = await createTestPhaseDeps();
  await writeArtifact("architecture", prod.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-11-05T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: options.facts ?? nextPostgresFacts({ name: "shop" }),
    summary: "A shop.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    prod.paths.files.requirements,
    options.requirements ?? makeRequirements({ domain: DOMAIN, dnsProvider: "cloudflare" }),
  );
  if (options.plan === undefined) await runDesign(prod, { catalog: euCatalog() });
  else await writeArtifact("plan", prod.paths.files.plan, options.plan);
  const api = cloudflare(options.records);
  const preview = await createTestPhaseDeps({
    root: prod.paths.root,
    env: { ...prod.env, CLOUDFLARE_API_TOKEN: TOKEN },
    fetch: api.fetch,
    environment: "preview",
  });
  return { prod, preview, asked: api.asked };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** True when nothing of the environment was written. */
async function nothingWritten(deps: TestPhaseDeps): Promise<boolean> {
  return !(await exists(deps.paths.files.requirements)) && !(await exists(deps.paths.files.plan));
}

/** Each preview's memory limits and the edge's and system's share of a preview plan. */
function previewNeed(plan: DeployPlan): { eachMb: number; sharedMb: number } {
  return { eachMb: appMemoryMb(plan), sharedMb: edgeMemoryMb("caddy") + SYSTEM_RESERVE_MB };
}

describe("addEnvironment with previews", () => {
  it("designs a preview environment: the questions' defaults, its sizing, cost and DNS", async () => {
    const { prod, preview, asked } = await prodApp();
    const prodBytes = await readFile(prod.paths.files.plan, "utf8");

    const result = await addEnvironment(preview, {
      previews: true,
      answers: {},
      design: { catalog: euCatalog() },
    });
    const { plan } = result.design;
    expect(plan.environment).toEqual({
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: { cap: 3, lifetimeDays: 7, domain: DOMAIN, seed: null },
    });
    // The zone, no hostname of its own, DNS only, open to everyone.
    expect(plan.dns).toEqual({ provider: "cloudflare", zone: ZONE, proxied: false, www: false });
    expect(plan.security.httpAllowedFrom).toBe("any");
    expect(plan.supplyChain.sign).toBe(false);
    expect(plan.cicd.deployTags.enabled).toBe(false);
    expect(plan.observability?.check?.enabled).toBe(false);
    // The server holds three previews of the app and Postgres, plus the edge and the system.
    const { eachMb, sharedMb } = previewNeed(plan);
    const chosen = result.design.chosen.target;
    expect(chosen.memoryGb * 1024).toBeGreaterThanOrEqual(3 * eachMb + sharedMb);
    expect(plan.target).toMatchObject({ provider: "hetzner", serverType: chosen.serverType });
    expect(result.design.chosen.summary).toContain(`up to 3 previews at once, each ${eachMb} MB`);
    // Backups are off: a preview's data does not matter.
    expect(result.design.chosen.backups).toBe(false);
    expect(result.requirements).toMatchObject({
      dataCriticality: "none",
      uptime: "best-effort",
      expectedMonthlyUsers: "<1k",
    });
    expect(await readArtifact("plan", preview.paths.files.plan)).toEqual(plan);
    // The wildcard's name was checked in the zone.
    expect(asked).toContain(
      `/zones/z1/dns_records?page=1&per_page=100&name=${encodeURIComponent(`*.${DOMAIN}`)}`,
    );

    const said = preview.reporter.text();
    expect(said).toMatch(/Wrote opscrew\/environments\/preview\/plan\.yaml: .*€\d+\.\d\d\/month/);
    expect(said).toContain(`Previews: up to 3 previews at once at pr-<number>.${DOMAIN}`);
    expect(said).toContain("OpsCrew found no seed command");
    expect(said).toContain("There is no .env.preview yet");
    expect(said).toContain("Prod's .env never goes to previews");
    expect(said).not.toContain(TOKEN);
    // Prod is untouched.
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(prodBytes);
  });

  it("asks only what previews need, with their defaults", async () => {
    const { preview } = await prodApp({
      facts: nextPostgresFacts({ name: "shop", build: { seedCommand: SEED } }),
    });
    let questions: EnvironmentQuestion[] = [];
    await addEnvironment(preview, {
      previews: true,
      ask: async (asked) => {
        questions = asked;
        return { cap: "2", lifetime: "3" };
      },
      design: { catalog: euCatalog() },
    });
    expect(questions.map((q) => [q.id, q.default])).toEqual([
      ["provider", "hetzner"],
      ["region", "eu-central"],
      ["cap", "3"],
      ["domain", DOMAIN],
      ["seed", SEED],
      ["lifetime", "7"],
    ]);
    expect(questions[0]?.options?.map((o) => o.value)).toEqual(["hetzner", "digitalocean", "own"]);
    const plan = await readArtifact("plan", preview.paths.files.plan);
    expect(plan.environment?.previews).toEqual({
      cap: 2,
      lifetimeDays: 3,
      domain: DOMAIN,
      seed: SEED,
    });
    expect(preview.reporter.text()).toContain(
      `Each new preview runs \`${SEED}\` once, the seed command OpsCrew found`,
    );
  });

  it("sizes the server from the cap, and the cap from the size", async () => {
    const one = await prodApp();
    const small = await addEnvironment(one.preview, {
      previews: true,
      answers: { cap: "1" },
      design: { catalog: euCatalog() },
    });
    const ten = await prodApp();
    const big = await addEnvironment(ten.preview, {
      previews: true,
      answers: { cap: "10" },
      design: { catalog: euCatalog() },
    });
    expect(big.design.chosen.target.memoryGb).toBeGreaterThan(small.design.chosen.target.memoryGb);
    const { eachMb, sharedMb } = previewNeed(big.design.plan);
    expect(big.design.chosen.target.memoryGb * 1024).toBeGreaterThanOrEqual(10 * eachMb + sharedMb);

    const sized = await prodApp();
    const result = await addEnvironment(sized.preview, {
      previews: true,
      answers: { size: "cx43" },
      design: { catalog: euCatalog() },
    });
    expect(result.design.options.map((o) => o.target.serverType)).toEqual(["cx43"]);
    const cap = Math.min(20, Math.floor((16 * 1024 - sharedMb) / eachMb));
    expect(result.design.plan.environment?.previews?.cap).toBe(cap);
  });

  it("warns when the preview server costs more than the budget", async () => {
    const { preview } = await prodApp({
      requirements: makeRequirements({
        domain: DOMAIN,
        dnsProvider: "cloudflare",
        budgetMonthly: { amount: 5, currency: "EUR" },
      }),
    });
    const result = await addEnvironment(preview, {
      previews: true,
      answers: { cap: "8" },
      design: { catalog: euCatalog() },
    });
    expect(result.design.warnings.join("\n")).toMatch(/None of the options fits your budget/);
  });

  it("takes --seed, --no-seed and another base name; says so on the zone's apex", async () => {
    const seeded = await prodApp({
      facts: nextPostgresFacts({ name: "shop", build: { seedCommand: SEED } }),
    });
    const none = await addEnvironment(seeded.preview, {
      previews: true,
      answers: { seed: false },
      design: { catalog: euCatalog() },
    });
    expect(none.design.plan.environment?.previews?.seed).toBeNull();
    expect(seeded.preview.reporter.text()).toContain("with no seed command");

    const apex = await prodApp({
      facts: nextPostgresFacts({
        name: "shop",
        build: { seedNote: "OpsCrew found no seed command: Drizzle has none of its own." },
      }),
    });
    const result = await addEnvironment(apex.preview, {
      previews: true,
      answers: { seed: "npm run db:fill", domain: ZONE },
      design: { catalog: euCatalog() },
    });
    expect(result.design.plan.environment?.previews).toMatchObject({
      domain: ZONE,
      seed: "npm run db:fill",
    });
    expect(apex.preview.reporter.text()).toContain(
      `The previews' name ${ZONE} is your zone's apex, so the wildcard record *.${ZONE} sends every name`,
    );
  });

  it("says the values come from .env.<name> when it is there", async () => {
    const { preview } = await prodApp();
    await writeFile(join(preview.paths.root, ".env.preview"), "STRIPE_KEY=\n");
    await addEnvironment(preview, {
      previews: true,
      answers: {},
      design: { catalog: euCatalog() },
    });
    expect(preview.reporter.text()).toContain(
      "The previews' own values come from .env.preview, which `opscrew provision --env preview` reads.",
    );
  });

  it.each([
    ["portainer", "INVALID_INPUT"],
    ["localhost", "INVALID_INPUT"],
  ])("refuses previews on %s before any change", async (target, code) => {
    const { preview } = await prodApp();
    const error = await failure(
      addEnvironment(preview, { previews: true, answers: { provider: target } }),
    );
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(await nothingWritten(preview)).toBe(true);
  });

  it.each([["runner"], ["build"]])("refuses --%s other than github", async (field) => {
    const { preview } = await prodApp();
    const error = await failure(
      addEnvironment(preview, { previews: true, answers: { [field]: "server" } }),
    );
    expect(error.message).toContain(`--${field} server is not available with --previews`);
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("refuses a site", async () => {
    const { preview } = await prodApp({
      requirements: makeRequirements({
        provider: "cloudflare-workers",
        domain: DOMAIN,
        dnsProvider: "cloudflare",
      }),
      plan: sitePlan({ name: "shop" }),
    });
    const error = await failure(addEnvironment(preview, { previews: true, answers: {} }));
    expect(error.message).toContain("previews run on a server of their own");
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("refuses a name in no Cloudflare zone, and a record already at the wildcard", async () => {
    const outside = await prodApp();
    const error = await failure(
      addEnvironment(outside.preview, {
        previews: true,
        answers: { domain: "previews.example.org" },
      }),
    );
    expect(error.message).toContain(
      "no Cloudflare zone your token sees holds previews.example.org",
    );
    expect(await nothingWritten(outside.preview)).toBe(true);

    const taken = await prodApp({
      records: [{ type: "A", name: `*.${DOMAIN}`, content: "203.0.113.20" }],
    });
    const wildcard = await failure(addEnvironment(taken.preview, { previews: true, answers: {} }));
    expect(wildcard.message).toContain(`already has a record at *.${DOMAIN} (A)`);
    expect(wildcard.message).not.toContain("203.0.113.20");
    expect(await nothingWritten(taken.preview)).toBe(true);
  });

  it("refuses without a Cloudflare token", async () => {
    const { prod } = await prodApp();
    const preview = await createTestPhaseDeps({
      root: prod.paths.root,
      env: prod.env,
      environment: "preview",
    });
    const error = await failure(addEnvironment(preview, { previews: true, answers: {} }));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("refuses a second preview environment", async () => {
    const { prod, preview } = await prodApp();
    await addEnvironment(preview, {
      previews: true,
      answers: {},
      design: { catalog: euCatalog() },
    });
    const second = await createTestPhaseDeps({
      root: prod.paths.root,
      env: preview.env,
      fetch: preview.fetch,
      environment: "pulls",
    });
    const error = await failure(addEnvironment(second, { previews: true, answers: {} }));
    expect(error.message).toContain("already has a preview environment, preview");
    expect(await nothingWritten(second)).toBe(true);
  });

  it("refuses an app name too long for each preview's", async () => {
    const { prod } = await prodApp({
      facts: nextPostgresFacts({ name: "example-shop-storefront" }),
    });
    const name = "preview-pulls";
    const long = await createTestPhaseDeps({
      root: prod.paths.root,
      env: { ...prod.env, CLOUDFLARE_API_TOKEN: TOKEN },
      environment: name,
    });
    const error = await failure(addEnvironment(long, { previews: true, answers: {} }));
    expect(error.message).toContain(`at most 31 characters`);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain("Choose a shorter environment name");
    expect(await nothingWritten(long)).toBe(true);
  });

  it("refuses --size on a server of the user's, and one the internet cannot reach", async () => {
    const own = { provider: "own", "server.host": "198.51.100.7", "server.user": "root" };
    const sized = await prodApp();
    const size = await failure(
      addEnvironment(sized.preview, { previews: true, answers: { ...own, size: "cx33" } }),
    );
    expect(size.message).toContain("--size picks a new server's type");
    expect(await nothingWritten(sized.preview)).toBe(true);

    const hidden = await prodApp();
    const unreachable = await failure(
      addEnvironment(hidden.preview, {
        previews: true,
        answers: { ...own, "server.reachable": "no" },
      }),
    );
    expect(unreachable.message).toContain("Previews need a server the internet reaches");
    expect(await nothingWritten(hidden.preview)).toBe(true);
  });

  it("refuses a server of the user's that runs an app, and designs one that runs none", async () => {
    const SERVER = {
      arch: "amd64" as const,
      vcpus: 4,
      memoryGb: 8,
      diskFreeGb: 120,
      os: "Ubuntu 24.04",
    };
    const answers = { provider: "own", "server.host": "198.51.100.7", "server.user": "root" };
    const busy = await prodApp();
    const error = await failure(
      addEnvironment(busy.preview, {
        previews: true,
        answers,
        design: {
          ownServer: { facts: SERVER, apps: [{ name: "shop", memoryMb: 1024, tunnel: false }] },
        },
      }),
    );
    expect(error.message).toContain(
      'Your server runs "shop", and previews run pull requests\' code',
    );
    expect(await nothingWritten(busy.preview)).toBe(true);

    const free = await prodApp();
    const result = await addEnvironment(free.preview, {
      previews: true,
      answers,
      design: { ownServer: { facts: SERVER, apps: [] } },
    });
    expect(result.design.plan.target).toMatchObject({ provider: "own", access: "public" });
    expect(result.design.chosen.summary).toContain("Memory limits: up to 3 previews at once, each");
    // The server's address stays on this computer.
    expect(free.preview.reporter.text()).not.toContain("198.51.100.7");
    expect(await readFile(free.preview.paths.files.plan, "utf8")).not.toContain("198.51.100.7");
    expect(result.design.plan.dns).toEqual({
      provider: "cloudflare",
      zone: ZONE,
      proxied: false,
      www: false,
    });

    const small = await prodApp();
    const full = await failure(
      addEnvironment(small.preview, {
        previews: true,
        answers: { ...answers, cap: "20" },
        design: { ownServer: { facts: { ...SERVER, memoryGb: 2 }, apps: [] } },
      }),
    );
    expect(full.message).toContain("20 previews of");
    expect(full.hint).toContain("Lower the cap");
  });
});

describe("design of a preview environment", () => {
  it("keeps the previews settings and the user's edits; drops servers and add-ons with a line each", async () => {
    const { preview } = await prodApp();
    await addEnvironment(preview, {
      previews: true,
      answers: {},
      design: { catalog: euCatalog() },
    });
    const file = preview.paths.files.plan;
    const edited = parse(await readFile(file, "utf8"));
    edited.environment.previews.cap = 2;
    edited.environment.previews.lifetimeDays = 3;
    edited.app.memoryMb = 384;
    edited.servers = [{ name: "data" }];
    edited.services = edited.services.map((s: { name: string }) => ({ ...s, server: "data" }));
    edited.observability = { ...edited.observability, check: { enabled: true } };
    await writeFile(file, stringify(edited));

    const { plan, lines } = await runDesign(preview, { catalog: euCatalog() });
    expect(plan.environment?.previews).toEqual({
      cap: 2,
      lifetimeDays: 3,
      domain: DOMAIN,
      seed: null,
    });
    expect(plan.app.memoryMb).toBe(384);
    expect(plan.servers).toBeUndefined();
    expect(plan.services.every((s) => s.server === undefined)).toBe(true);
    expect(plan.observability?.check?.enabled).toBe(false);
    expect(lines).toContain(
      "Server data is left out: every preview runs on the preview environment's one server, so db runs there too.",
    );
    expect(lines).toContain(
      "The scheduled check is off: it watches a deployed app, and previews come and go.",
    );
    expect(plan.dns).toEqual({ provider: "cloudflare", zone: ZONE, proxied: false, www: false });
    expect(lines).toContain(
      `Previews: up to 2 previews at once at pr-<number>.${DOMAIN}, each removed after 3 days without a push, with no seed command.`,
    );
  });
});

describe("removeEnvironment of a preview environment", () => {
  it("also removes its preview workflow and its committed recipe", async () => {
    const { prod, preview } = await prodApp();
    await addEnvironment(preview, {
      previews: true,
      answers: {},
      design: { catalog: euCatalog() },
    });
    const root = preview.paths.root;
    const workflow = join(root, ".github/workflows/opscrew-preview.yml");
    const recipe = join(preview.paths.artefactsDir, "previews");
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(workflow, "name: previews\n");
    await writeFile(join(root, ".github/workflows/opscrew-deploy.yml"), "name: deploy\n");
    await mkdir(join(recipe, "template"), { recursive: true });
    await writeFile(join(recipe, "settings.env"), "CAP=3\n");

    const removed = await removeEnvironment(preview);
    expect(removed).toContain(".github/workflows/opscrew-preview.yml");
    expect(await exists(workflow)).toBe(false);
    expect(await exists(recipe)).toBe(false);
    // Prod's workflow and plan stay.
    expect(await exists(join(root, ".github/workflows/opscrew-deploy.yml"))).toBe(true);
    expect(await exists(prod.paths.files.plan)).toBe(true);
  });
});
