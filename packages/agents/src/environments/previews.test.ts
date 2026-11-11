import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { FetchLike } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { edgeMemoryMb } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { appPaths } from "../apps/list";
import { runDesign } from "../design/run";
import { sharedServerWarning } from "../previews/host";
import { readOwnServer, readServerAddresses, updateServerAddresses } from "../shared";
import { appMemoryMb, SYSTEM_RESERVE_MB } from "../shared/memory";
import {
  createTestPhaseDeps,
  euCatalog,
  freshFacts,
  HOST_IPV4,
  hostTestPlan,
  makeRequirements,
  nextPostgresFacts,
  PREVIEW_ZONE,
  previewTestPlan,
  sharedPreviewTestPlan,
  type TestPhaseDeps,
  TOKEN,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { addEnvironment, type EnvironmentQuestion, removeEnvironment } from "./index";
import { environmentPaths } from "./paths";

const DOMAIN = "shop.example.com";
const ZONE = "example.com";
const API = "https://api.cloudflare.com/client/v4";
const SEED = "npx prisma db seed";
/** The preview domain the tests answer: a zone of its own. */
const PREVIEWS = { domain: PREVIEW_ZONE };

/** A DNS record as the fakes list it. */
type FakeRecord = { type: string; name: string; content: string; comment?: string };

/** The app's zone as Cloudflare answers for it (previews below it, US10). */
interface AppZoneFake {
  /** `advanced.allocated` of its pack quota: 0 without ACM (default 10). */
  allocated?: number;
  /** Total TLS on (default off). */
  totalTls?: boolean;
  records?: FakeRecord[];
}

/**
 * A fake Cloudflare API: the app's zone `ZONE` (id z1, as `app` has it) and the preview zone (id
 * z2), which holds `records`.
 */
function cloudflare(records: FakeRecord[] = [], app: AppZoneFake = {}) {
  const asked: string[] = [];
  const zones: Record<string, string> = { [ZONE]: "z1", [PREVIEW_ZONE]: "z2" };
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(new URL(API).pathname, "");
    asked.push(`${path}${url.search}`);
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        headers: { "content-type": "application/json" },
      });
    if (path === "/zones") {
      const name = url.searchParams.get("name") ?? "";
      const id = zones[name];
      return ok(id === undefined ? [] : [{ id, name, status: "active", name_servers: [] }]);
    }
    if (path === "/zones/z2/dns_records") {
      return ok(records.map((record, i) => ({ id: `r${i}`, ttl: 1, ...record })));
    }
    if (path === "/zones/z1/ssl/certificate_packs/quota") {
      return ok({ advanced: { allocated: app.allocated ?? 10, used: 0 } });
    }
    if (path === "/zones/z1/acm/total_tls") return ok({ enabled: app.totalTls ?? false });
    if (path === "/zones/z1/dns_records") {
      return ok((app.records ?? []).map((record, i) => ({ id: `a${i}`, ttl: 1, ...record })));
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
    appZone?: AppZoneFake;
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
  const api = cloudflare(options.records, options.appZone);
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
      answers: PREVIEWS,
      design: { catalog: euCatalog() },
    });
    const { plan } = result.design;
    expect(plan.environment).toEqual({
      name: "preview",
      deploySource: { from: "main" },
      runner: "github",
      previews: { cap: 3, lifetimeDays: 7, domain: PREVIEW_ZONE, seed: null },
    });
    // The preview zone, no hostname of its own, behind the proxy, open to Cloudflare only.
    expect(plan.dns).toEqual({
      provider: "cloudflare",
      zone: PREVIEW_ZONE,
      proxied: true,
      www: false,
    });
    expect(plan.security.httpAllowedFrom).toBe("cloudflare");
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
    // The preview zone's records were read, and nothing of the app's zone.
    expect(asked).toContain("/zones/z2/dns_records?page=1&per_page=100");
    expect(asked.filter((path) => path.startsWith("/zones/z1"))).toEqual([]);

    const said = preview.reporter.text();
    expect(said).toMatch(/Wrote opscrew\/environments\/preview\/plan\.yaml: .*€\d+\.\d\d\/month/);
    expect(said).toContain(
      `Previews: up to 3 previews at once at pr-<number>-<random>.${PREVIEW_ZONE}, behind Cloudflare's proxy`,
    );
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
        return { cap: "2", lifetime: "3", ...PREVIEWS };
      },
      design: { catalog: euCatalog() },
    });
    // The preview domain has no default: the app's own is not one previews can use.
    expect(questions.map((q) => [q.id, q.default])).toEqual([
      ["provider", "hetzner"],
      ["region", "eu-central"],
      ["cap", "3"],
      ["domain", undefined],
      ["seed", SEED],
      ["lifetime", "7"],
    ]);
    expect(questions.find((q) => q.id === "domain")?.help).toContain(
      "`opscrew domain buy <name>` buys one",
    );
    expect(questions[0]?.options?.map((o) => o.value)).toEqual([
      "hetzner",
      "digitalocean",
      "contabo",
      "own",
    ]);
    const plan = await readArtifact("plan", preview.paths.files.plan);
    expect(plan.environment?.previews).toEqual({
      cap: 2,
      lifetimeDays: 3,
      domain: PREVIEW_ZONE,
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
      answers: { cap: "1", ...PREVIEWS },
      design: { catalog: euCatalog() },
    });
    const ten = await prodApp();
    const big = await addEnvironment(ten.preview, {
      previews: true,
      answers: { cap: "10", ...PREVIEWS },
      design: { catalog: euCatalog() },
    });
    expect(big.design.chosen.target.memoryGb).toBeGreaterThan(small.design.chosen.target.memoryGb);
    const { eachMb, sharedMb } = previewNeed(big.design.plan);
    expect(big.design.chosen.target.memoryGb * 1024).toBeGreaterThanOrEqual(10 * eachMb + sharedMb);

    const sized = await prodApp();
    const result = await addEnvironment(sized.preview, {
      previews: true,
      answers: { size: "cx43", ...PREVIEWS },
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
      answers: { cap: "8", ...PREVIEWS },
      design: { catalog: euCatalog() },
    });
    expect(result.design.warnings.join("\n")).toMatch(/None of the options fits your budget/);
  });

  it("takes --seed and --no-seed", async () => {
    const seeded = await prodApp({
      facts: nextPostgresFacts({ name: "shop", build: { seedCommand: SEED } }),
    });
    const none = await addEnvironment(seeded.preview, {
      previews: true,
      answers: { seed: false, ...PREVIEWS },
      design: { catalog: euCatalog() },
    });
    expect(none.design.plan.environment?.previews?.seed).toBeNull();
    expect(seeded.preview.reporter.text()).toContain("with no seed command");

    const other = await prodApp({
      facts: nextPostgresFacts({
        name: "shop",
        build: { seedNote: "OpsCrew found no seed command: Drizzle has none of its own." },
      }),
    });
    const result = await addEnvironment(other.preview, {
      previews: true,
      answers: { seed: "npm run db:fill", ...PREVIEWS },
      design: { catalog: euCatalog() },
    });
    expect(result.design.plan.environment?.previews).toMatchObject({ seed: "npm run db:fill" });
  });

  it("says the values come from .env.<name> when it is there", async () => {
    const { preview } = await prodApp();
    await writeFile(join(preview.paths.root, ".env.preview"), "STRIPE_KEY=\n");
    await addEnvironment(preview, {
      previews: true,
      answers: PREVIEWS,
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

  it.each([
    [
      "no domain",
      {},
      "INVALID_INPUT",
      "Previews need a domain of their own on Cloudflare, where each preview gets an address nobody can guess (pr-<number>-<random>.<domain>), and none was given.",
    ],
    [
      "the app's own zone",
      { domain: ZONE },
      "INVALID_INPUT",
      `${ZONE} is in your app's own domain ${ZONE}, and previews need a domain of their own`,
    ],
    [
      "a name in the app's zone",
      { domain: `previews.${ZONE}` },
      "INVALID_INPUT",
      `previews.${ZONE} is in your app's own domain ${ZONE}`,
    ],
    [
      "a name no zone of the token's is",
      { domain: "example.org" },
      "PHASE_PRECONDITION",
      "Previews need a domain of their own on Cloudflare, and no Cloudflare zone your token sees is example.org.",
    ],
    [
      "a name inside another zone",
      { domain: `previews.${PREVIEW_ZONE}` },
      "PHASE_PRECONDITION",
      `previews.${PREVIEW_ZONE} is a name inside your Cloudflare zone ${PREVIEW_ZONE}, and previews need a zone of their own`,
    ],
  ])(
    "refuses %s before any change, naming `opscrew domain buy`",
    async (_case, answers, code, said) => {
      const { preview } = await prodApp();
      const error = await failure(addEnvironment(preview, { previews: true, answers }));
      expect(error.code).toBe(code);
      expect(error.message).toContain(said);
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toContain("`opscrew domain buy <name>`");
      expect(await nothingWritten(preview)).toBe(true);
    },
  );

  it("refuses a preview zone with A, AAAA or CNAME records, naming them without their content", async () => {
    const taken = await prodApp({
      records: [
        { type: "A", name: `www.${PREVIEW_ZONE}`, content: "203.0.113.20" },
        { type: "CNAME", name: `*.${PREVIEW_ZONE}`, content: "other.example.com" },
        { type: "TXT", name: PREVIEW_ZONE, content: "v=spf1 -all" },
      ],
    });
    const error = await failure(
      addEnvironment(taken.preview, { previews: true, answers: PREVIEWS }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      `Your Cloudflare zone ${PREVIEW_ZONE} already has www.${PREVIEW_ZONE} (A) and *.${PREVIEW_ZONE} (CNAME), and previews need a zone used for nothing else`,
    );
    expect(error.message).not.toContain("203.0.113.20");
    expect(error.message).not.toContain("other.example.com");
    expect(error.hint).toContain("`opscrew domain buy <name>`");
    expect(await nothingWritten(taken.preview)).toBe(true);

    // Other records (mail, verification) stay the zone's own business.
    const mail = await prodApp({
      records: [
        { type: "TXT", name: PREVIEW_ZONE, content: "v=spf1 -all" },
        { type: "MX", name: PREVIEW_ZONE, content: "mail.example.com" },
      ],
    });
    const result = await addEnvironment(mail.preview, {
      previews: true,
      answers: PREVIEWS,
      design: { catalog: euCatalog() },
    });
    expect(result.design.plan.dns.zone).toBe(PREVIEW_ZONE);
  });

  it("refuses without a Cloudflare token", async () => {
    const { prod } = await prodApp();
    const preview = await createTestPhaseDeps({
      root: prod.paths.root,
      env: prod.env,
      environment: "preview",
    });
    const error = await failure(addEnvironment(preview, { previews: true, answers: PREVIEWS }));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("refuses a second preview environment", async () => {
    const { prod, preview } = await prodApp();
    await addEnvironment(preview, {
      previews: true,
      answers: PREVIEWS,
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
    const own = {
      provider: "own",
      "server.host": "198.51.100.7",
      "server.user": "root",
      ...PREVIEWS,
    };
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
    const answers = {
      provider: "own",
      "server.host": "198.51.100.7",
      "server.user": "root",
      ...PREVIEWS,
    };
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
      zone: PREVIEW_ZONE,
      proxied: true,
      www: false,
    });
    // Served behind Cloudflare's proxy with OpsCrew's web filter.
    expect((await readOwnServer(free.preview.paths))?.serve).toBe("proxy");

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
      answers: PREVIEWS,
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
      domain: PREVIEW_ZONE,
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
    expect(plan.dns).toEqual({
      provider: "cloudflare",
      zone: PREVIEW_ZONE,
      proxied: true,
      www: false,
    });
    expect(lines).toContain(
      `Previews: up to 2 previews at once at pr-<number>-<random>.${PREVIEW_ZONE}, behind Cloudflare's proxy, each removed after 3 days without a push, with no seed command.`,
    );
  });
});

describe("removeEnvironment of a preview environment", () => {
  it("also removes its preview workflow and its committed recipe", async () => {
    const { prod, preview } = await prodApp();
    await addEnvironment(preview, {
      previews: true,
      answers: PREVIEWS,
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

describe("addEnvironment with previews on another environment's server (US9)", () => {
  /** dev's server: 8 GB, as inspection reads it. */
  const SERVER = {
    arch: "amd64" as const,
    vcpus: 4,
    memoryGb: 8,
    diskFreeGb: 120,
    os: "Ubuntu 24.04",
  };
  /** What dev's own containers take on it. */
  const DEV = { name: "shop-dev", memoryMb: 1536, tunnel: false };
  const WARNING = sharedServerWarning("dev");

  /** prodApp with dev provisioned (`hostTestPlan`, or `plan`). */
  async function withDev(plan: DeployPlan = hostTestPlan()) {
    const app = await prodApp();
    const dev = environmentPaths(app.prod.paths, "dev");
    await writeArtifact("plan", dev.files.plan, plan);
    return { ...app, dev };
  }

  it("--share-server dev: warns, designs previews on dev's server with no price, and records nothing of it", async () => {
    const { preview } = await withDev();
    const result = await addEnvironment(preview, {
      previews: true,
      shareServer: "dev",
      answers: PREVIEWS,
      design: { ownServer: { facts: SERVER, apps: [DEV] } },
    });
    const { plan } = result.design;
    expect(plan.target).toMatchObject({ provider: "own", access: "public", edge: "caddy" });
    expect(plan.environment?.previews).toEqual({
      cap: 3,
      lifetimeDays: 7,
      domain: PREVIEW_ZONE,
      server: { environment: "dev" },
      seed: null,
    });
    expect(await readArtifact("plan", preview.paths.files.plan)).toEqual(plan);
    expect(result.requirements.provider).toBe("own");
    // No server price: the server is dev's, whose own containers it holds too.
    const { chosen } = result.design;
    expect(chosen.cost.monthly.amount).toBe(0);
    expect(chosen.title).toBe("dev's server");
    expect(chosen.summary).toMatch(/^dev's server \(4 vCPU, 8 GB memory/);
    expect(chosen.summary).toContain("; dev's own containers 1536 MB;");
    // dev is behind Cloudflare's proxy, open to Cloudflare only.
    expect(chosen.summary).toContain(
      "The previews are served behind Cloudflare's proxy, and dev's server lets only Cloudflare's addresses reach ports 80 and 443.",
    );
    expect(chosen.summary).toContain("The server is dev's: it is priced and backed up with dev.");
    expect(chosen.summary).not.toContain("you already pay for this server");
    expect(chosen.summary).not.toContain("backups are your responsibility");
    expect(preview.reporter.text()).not.toContain("backups are your responsibility");
    expect(preview.reporter.text()).toContain(WARNING);
    // Nothing of dev's server or login in the preview environment's state.
    expect(await readOwnServer(preview.paths)).toBeUndefined();
    expect(await readServerAddresses(preview.paths)).not.toHaveProperty("deployment");
  });

  it("offers each provisioned environment's server, and confirms after the warning, no by default", async () => {
    const { preview } = await withDev();
    const asked: EnvironmentQuestion[][] = [];
    const ask = (share: boolean) => async (questions: EnvironmentQuestion[]) => {
      asked.push(questions);
      return questions[0]?.id === "share" ? { share } : { ...PREVIEWS, provider: "share:dev" };
    };
    const error = await failure(
      addEnvironment(preview, {
        previews: true,
        ask: ask(false),
        design: { ownServer: { facts: SERVER, apps: [DEV] } },
      }),
    );
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(
      "The previews were not set up on dev's server. Nothing was changed.",
    );
    expect(await nothingWritten(preview)).toBe(true);
    const [where, confirm] = asked;
    expect(where?.[0]?.options?.map((o) => o.value)).toEqual([
      "hetzner",
      "digitalocean",
      "contabo",
      "own",
      "share:dev",
    ]);
    expect(where?.[0]?.options?.at(-1)?.label).toBe("On the dev environment's server");
    expect(confirm).toEqual([
      expect.objectContaining({ id: "share", kind: "confirm", default: false, help: WARNING }),
    ]);
    expect(preview.reporter.text()).toContain(WARNING);

    const yes = await withDev();
    const result = await addEnvironment(yes.preview, {
      previews: true,
      ask: ask(true),
      design: { ownServer: { facts: SERVER, apps: [DEV] } },
    });
    expect(result.design.plan.environment?.previews?.server).toEqual({ environment: "dev" });
  });

  it("asks no question of where previews run with --share-server in a terminal", async () => {
    const { preview } = await withDev();
    const asked: EnvironmentQuestion[][] = [];
    const result = await addEnvironment(preview, {
      previews: true,
      shareServer: "dev",
      ask: async (questions) => {
        asked.push(questions);
        return PREVIEWS;
      },
      design: { ownServer: { facts: SERVER, apps: [DEV] } },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.map((q) => q.id)).not.toContain("provider");
    expect(result.design.plan.environment?.previews?.server).toEqual({ environment: "dev" });
  });

  it("refuses a cap that doesn't fit what dev's server has left, saying the cap that fits", async () => {
    const { preview } = await withDev();
    const error = await failure(
      addEnvironment(preview, {
        previews: true,
        shareServer: "dev",
        answers: { ...PREVIEWS, cap: "20" },
        design: { ownServer: { facts: { ...SERVER, memoryGb: 4 }, apps: [DEV] } },
      }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("dev's server has 4096 MB of memory.");
    expect(error.message).toContain("1536 MB for dev's own containers");
    expect(error.message).toMatch(/do not fit: at most \d+ previews? fits?\./);
    expect(error.hint).toMatch(/^Lower the cap to \d+ /);
  });

  it.each([
    ["prod", "prod", {}, "Previews never run on prod's server"],
    ["the preview environment itself", "preview", {}, "preview is the preview environment itself"],
    [
      "--target beside it",
      "dev",
      { provider: "hetzner" },
      "--share-server runs previews on dev's server, and --target names a server of their own.",
    ],
    [
      "--size beside it",
      "dev",
      { size: "cx33" },
      "--size picks a new server's type, and dev's server has its own size.",
    ],
  ])("refuses %s before any change", async (_case, shareServer, answers, said) => {
    const { preview } = await withDev();
    const error = await failure(
      addEnvironment(preview, {
        previews: true,
        shareServer,
        answers: { ...PREVIEWS, ...answers },
        design: { ownServer: { facts: SERVER, apps: [DEV] } },
      }),
    );
    expect(error.message).toContain(said);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(await nothingWritten(preview)).toBe(true);
  });

  it.each([
    ["dev not provisioned", hostTestPlan({ deployed: false }), [DEV], "dev is not provisioned yet"],
    [
      "an edge other than Caddy",
      DeployPlanSchema.parse({
        ...hostTestPlan(),
        target: { ...hostTestPlan().target, edge: "nginx" },
      }),
      [DEV],
      "dev's server runs nginx as its proxy",
    ],
    [
      "a server prod runs on",
      hostTestPlan(),
      [DEV, { ...DEV, name: "shop" }],
      "prod runs on dev's server too",
    ],
    [
      "a server with another app",
      hostTestPlan(),
      [DEV, { ...DEV, name: "blog" }],
      'dev\'s server also runs "blog"',
    ],
  ])("refuses %s before any change", async (_case, plan, apps, said) => {
    const { preview } = await withDev(plan);
    const error = await failure(
      addEnvironment(preview, {
        previews: true,
        shareServer: "dev",
        answers: PREVIEWS,
        design: { ownServer: { facts: SERVER, apps } },
      }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(said);
    expect(error.hint).toContain("opscrew env add preview --previews");
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("dev's design counts the previews' memory while the preview environment names it", async () => {
    const { prod, preview } = await prodApp();
    const dev = await createTestPhaseDeps({
      root: prod.paths.root,
      env: preview.env,
      fetch: preview.fetch,
      environment: "dev",
    });
    await addEnvironment(dev, {
      answers: { provider: "hetzner", from: "main", runner: "github" },
      design: { catalog: euCatalog() },
    });
    const alone = await runDesign(dev, { catalog: euCatalog() });
    expect(alone.chosen.summary).not.toContain("the previews of preview");

    const plan = sharedPreviewTestPlan();
    await writeArtifact("plan", preview.paths.files.plan, plan);
    const previewsMb = 3 * appMemoryMb(plan);
    const shared = await runDesign(dev, { catalog: euCatalog() });
    expect(shared.chosen.summary).toContain(`the previews of preview ${previewsMb} MB`);
    const need = appMemoryMb(shared.plan) + previewsMb + edgeMemoryMb("caddy") + SYSTEM_RESERVE_MB;
    expect(shared.chosen.target.memoryGb * 1024).toBeGreaterThanOrEqual(need);
  });

  it("refuses dev's own server when it no longer holds dev and the previews", async () => {
    const { prod, preview } = await prodApp();
    const dev = await createTestPhaseDeps({
      root: prod.paths.root,
      env: preview.env,
      fetch: preview.fetch,
      environment: "dev",
    });
    const small = { ...SERVER, memoryGb: 2 };
    await addEnvironment(dev, {
      answers: {
        provider: "own",
        from: "main",
        runner: "github",
        "server.host": "198.51.100.7",
        "server.user": "root",
      },
      design: { ownServer: { facts: small, apps: [] } },
    });
    await writeArtifact("plan", preview.paths.files.plan, sharedPreviewTestPlan());
    const error = await failure(runDesign(dev, { ownServer: { facts: small, apps: [] } }));
    expect(error.message).toContain("the previews of preview");
  });

  it("reads the size of dev's server through dev's deploy login, counting dev's own needs", async () => {
    const { preview, dev } = await withDev();
    await updateServerAddresses(dev, (current) => ({
      ...current,
      deployment: { ipv4: HOST_IPV4 },
    }));
    await mkdir(dirname(dev.files.deployKey), { recursive: true });
    await writeFile(dev.files.deployKey, "placeholder\n");
    const inspected: string[] = [];
    const facts = HostFactsSchema.parse({
      ...freshFacts({ user: "deploy" }),
      memoryBytes: 8 * 1024 ** 3,
    });
    const result = await addEnvironment(preview, {
      previews: true,
      shareServer: "dev",
      answers: PREVIEWS,
      ownServer: {
        services: {
          host: {
            inspect: async (remote) => {
              inspected.push(remote.host);
              return facts;
            },
            apply: async () => {
              throw new Error("env add applies nothing");
            },
          },
        },
      },
    });
    expect(inspected).toEqual([HOST_IPV4]);
    expect(result.design.plan.environment?.previews?.server).toEqual({ environment: "dev" });
    expect(preview.reporter.text()).toContain(
      "Connecting to dev's server to read its size (read-only)",
    );
    expect(preview.reporter.text()).not.toContain(HOST_IPV4);
    expect(await readFile(preview.paths.files.plan, "utf8")).not.toContain(HOST_IPV4);
  });
});

describe("addEnvironment with previews below the app's zone (US10)", () => {
  const BELOW = `previews.${ZONE}`;
  const COOKIES = `a cookie your app sets for the whole domain (Domain=${ZONE}) reaches every preview, where a pull request's code can read it, and a preview can set such cookies for your app too.`;
  const ACM = `need Cloudflare's Advanced Certificate Manager on ${ZONE}, a paid add-on you turn on in Cloudflare's dashboard, which shows its price`;

  it("--app-zone: warns of ACM and cookies, checks the zone read-only and designs previews in the app's zone", async () => {
    const { prod, preview, asked } = await prodApp({
      appZone: {
        records: [
          { type: "A", name: DOMAIN, content: "203.0.113.20" },
          // OpsCrew's own and the pack's validation records are no reason to refuse.
          {
            type: "A",
            name: `*.${BELOW}`,
            content: "203.0.113.21",
            comment: "Managed by OpsCrew",
          },
          { type: "TXT", name: `_acme-challenge.${BELOW}`, content: "validation" },
        ],
      },
    });
    const prodBytes = await readFile(prod.paths.files.plan, "utf8");
    const result = await addEnvironment(preview, {
      previews: true,
      appZone: true,
      answers: { domain: BELOW },
      design: { catalog: euCatalog() },
    });
    const { plan } = result.design;
    expect(plan.environment?.previews?.domain).toBe(BELOW);
    expect(plan.dns).toEqual({ provider: "cloudflare", zone: ZONE, proxied: true, www: false });
    const said = preview.reporter.text();
    expect(said).toContain(ACM);
    expect(said).toContain(COOKIES);
    expect(said).not.toContain(TOKEN);
    expect(asked).toEqual(
      expect.arrayContaining([
        "/zones/z1/ssl/certificate_packs/quota",
        "/zones/z1/acm/total_tls",
        "/zones/z1/dns_records?page=1&per_page=100",
      ]),
    );
    expect(await readFile(prod.paths.files.plan, "utf8")).toBe(prodBytes);
  });

  it("without --app-zone in a script, refuses as before and names --app-zone", async () => {
    const { preview, asked } = await prodApp();
    const error = await failure(
      addEnvironment(preview, { previews: true, answers: { domain: BELOW } }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(`${BELOW} is in your app's own domain ${ZONE}`);
    expect(error.hint).toContain(`add --app-zone to put the previews below ${ZONE}`);
    expect(asked).toEqual([]);
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("never takes the app's zone itself, even with --app-zone", async () => {
    const { preview } = await prodApp();
    const error = await failure(
      addEnvironment(preview, { previews: true, appZone: true, answers: { domain: ZONE } }),
    );
    expect(error.message).toContain(`${ZONE} is in your app's own domain ${ZONE}`);
    expect(error.hint).not.toContain("--app-zone");
  });

  it("asks a confirmation after the warning, no by default; declined, nothing is written", async () => {
    const { preview, asked: calls } = await prodApp();
    const asked: EnvironmentQuestion[][] = [];
    const ask = (yes: boolean) => async (questions: EnvironmentQuestion[]) => {
      asked.push(questions);
      return questions[0]?.id === "appZone" ? { appZone: yes } : { domain: BELOW };
    };
    const error = await failure(addEnvironment(preview, { previews: true, ask: ask(false) }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe(`The previews were not set up below ${ZONE}. Nothing was changed.`);
    expect(asked[1]).toEqual([
      expect.objectContaining({ id: "appZone", kind: "confirm", default: false }),
    ]);
    expect(asked[1]?.[0]?.help).toContain(COOKIES);
    expect(preview.reporter.text()).toContain(ACM);
    expect(calls.filter((path) => path.startsWith("/zones/z1"))).toEqual([]);
    expect(await nothingWritten(preview)).toBe(true);

    const yes = await prodApp();
    const result = await addEnvironment(yes.preview, {
      previews: true,
      ask: ask(true),
      design: { catalog: euCatalog() },
    });
    expect(result.design.plan.environment?.previews?.domain).toBe(BELOW);
  });

  it.each<[string, AppZoneFake, string, string]>([
    [
      "a zone without ACM",
      { allocated: 0 },
      `Previews below ${ZONE} need Cloudflare's Advanced Certificate Manager on ${ZONE} for the certificate of *.${BELOW}, and it is off there.`,
      `Turn on Advanced Certificate Manager, a paid add-on, in the Cloudflare dashboard (${ZONE} → SSL/TLS → Edge Certificates)`,
    ],
    [
      "Total TLS on",
      { totalTls: true },
      `Total TLS is on for ${ZONE}: it gives each proxied name a certificate of its own, and every public certificate is published, so each preview's name would be too.`,
      `Turn Total TLS off in the Cloudflare dashboard (${ZONE} → SSL/TLS → Edge Certificates)`,
    ],
    [
      "records at or below the domain",
      {
        records: [
          { type: "CNAME", name: `docs.${BELOW}`, content: "docs.host.example.org" },
          { type: "TXT", name: BELOW, content: "v=spf1 -all" },
          { type: "A", name: `other${BELOW}`, content: "203.0.113.30" },
        ],
      },
      `${ZONE} already has docs.${BELOW} (CNAME) and ${BELOW} (TXT) at or below ${BELOW}, and previews take every name there`,
      `Delete them in the Cloudflare dashboard (${ZONE} → DNS → Records) if nothing uses them, or choose another name below ${ZONE} for the previews`,
    ],
  ])("refuses %s before any change, with the dashboard steps", async (_case, zone, said, hint) => {
    const { preview } = await prodApp({ appZone: zone });
    const error = await failure(
      addEnvironment(preview, { previews: true, appZone: true, answers: { domain: BELOW } }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(said);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain(hint);
    expect(error.hint).toContain("then run `opscrew env add preview --previews` again.");
    // Names and types only, never a record's content; never the token.
    for (const text of [error.message, error.hint ?? "", preview.reporter.text()]) {
      expect(text).not.toContain("docs.host.example.org");
      expect(text).not.toContain("v=spf1");
      expect(text).not.toContain(TOKEN);
    }
    expect(await nothingWritten(preview)).toBe(true);
  });

  it("refuses the preview domain of another app's preview environment", async () => {
    const app = await prodApp();
    const { root } = app.prod.paths;
    await writeArtifact("app", join(root, "opscrew", "apps", "docs", "app.yaml"), {
      schemaVersion: 1,
      dir: "docs",
    });
    const shopPreview = previewTestPlan();
    const { dir: _dir, ...infra } = shopPreview.infra;
    const { workflowPath: _workflow, ...cicd } = shopPreview.cicd;
    const docsPreview = DeployPlanSchema.parse({
      ...shopPreview,
      app: { ...shopPreview.app, key: "docs", name: "docs-preview" },
      infra,
      cicd,
      environment: {
        ...shopPreview.environment,
        previews: { ...shopPreview.environment?.previews, domain: BELOW },
      },
      dns: { ...shopPreview.dns, zone: ZONE },
    });
    await writeArtifact(
      "plan",
      appPaths(app.prod.paths, "docs", "preview").files.plan,
      docsPreview,
    );
    const error = await failure(
      addEnvironment(app.preview, { previews: true, appZone: true, answers: { domain: BELOW } }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      `${BELOW} is ${BELOW}, the previews' domain of the app docs's environment preview, and two preview environments can't share names. Nothing was changed.`,
    );
    expect(await nothingWritten(app.preview)).toBe(true);
  });

  it("refuses a domain that is an environment's hostname, or a parent of one", async () => {
    const app = await prodApp();
    const is = await failure(
      addEnvironment(app.preview, { previews: true, appZone: true, answers: { domain: DOMAIN } }),
    );
    expect(is.code).toBe("INVALID_INPUT");
    expect(is.message).toBe(
      `${DOMAIN} is ${DOMAIN}, the first app's prod's hostname, and previews take every name below ${DOMAIN}. Nothing was changed.`,
    );
    expect(is.hint).toBe(
      `Choose another name below ${ZONE} for the previews, then run \`opscrew env add preview --previews\` again.`,
    );

    // A staging environment served DNS only at a name below the preview domain.
    const prodPlan = await readArtifact("plan", app.prod.paths.files.plan);
    const staging = environmentPaths(app.prod.paths, "staging");
    await writeArtifact(
      "plan",
      staging.files.plan,
      DeployPlanSchema.parse({
        ...prodPlan,
        app: { ...prodPlan.app, name: "shop-staging" },
        environment: { name: "staging" },
        infra: { ...prodPlan.infra, dir: "opscrew/infra/staging" },
        cicd: { ...prodPlan.cicd, workflowPath: ".github/workflows/opscrew-deploy-staging.yml" },
        dns: { ...prodPlan.dns, domain: `app.${BELOW}`, proxied: false, www: false },
      }),
    );
    const parent = await failure(
      addEnvironment(app.preview, { previews: true, appZone: true, answers: { domain: BELOW } }),
    );
    expect(parent.message).toContain(
      `${BELOW} is a parent of app.${BELOW}, the first app's environment staging's hostname`,
    );
    expect(await nothingWritten(app.preview)).toBe(true);
  });
});
