import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import {
  type ProjectFacts,
  type Question,
  QuestionSchema,
  type Requirements,
  readArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runAnalyze } from "../analyze";
import { createTestPhaseDeps } from "../testing";
import { answersToRequirements, normaliseDomain, parseMoney } from "./answers";
import { buildQuestions, type InterviewAnswers, inferredAnswers } from "./questions";
import { runInterview } from "./run";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const now = new Date("2026-10-11T12:00:00.000Z");

async function project(example: string) {
  const root = await mkdtemp(join(tmpdir(), `opscrew-interview-${example}-`));
  await materializeFixture(join(examples, example), root);
  return root;
}

function facts(services: ProjectFacts["services"] = []): ProjectFacts {
  return {
    name: "demo",
    languages: ["typescript"],
    packageManager: "npm",
    frameworks: [],
    appKind: "static-spa",
    platformExport: { platform: "none", evidence: [] },
    build: {},
    runtimeVersions: {},
    envVars: [],
    services,
    docker: {},
    monorepo: false,
    git: {},
  };
}

const ids = (questions: Question[]) => questions.map((q) => q.id);

const BASE_ANSWERS: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  region: "eu-central",
  uptime: "standard",
};

describe("buildQuestions", () => {
  it("skips data criticality and the Supabase question when there is no database", () => {
    const questions = buildQuestions(facts());
    expect(ids(questions)).toEqual([
      "expectedMonthlyUsers",
      "budgetMonthly",
      "provider",
      "region",
      "uptime",
      "domain",
      "dnsProvider",
    ]);
    for (const q of questions) expect(QuestionSchema.safeParse(q).success).toBe(true);
  });

  it("asks about data loss for a database and about keeping Supabase", () => {
    expect(ids(buildQuestions(facts([{ kind: "postgres", evidence: ["dependency:pg"] }])))).toEqual(
      [
        "expectedMonthlyUsers",
        "budgetMonthly",
        "provider",
        "region",
        "uptime",
        "dataCriticality",
        "domain",
        "dnsProvider",
      ],
    );
    const questions = buildQuestions(facts([{ kind: "supabase", evidence: [] }]));
    expect(ids(questions)).toContain("dataCriticality");
    const keep = questions.find((q) => q.id === "keepExternalServices");
    expect(keep).toMatchObject({ kind: "confirm", default: true, required: false });
  });

  it("pre-fills previous answers", () => {
    const previous: Requirements = {
      schemaVersion: 1,
      answeredAt: "2026-10-01T00:00:00.000Z",
      expectedMonthlyUsers: "10k-100k",
      budgetMonthly: { amount: 40, currency: "USD" },
      region: "us-east",
      uptime: "high",
      dataCriticality: "critical",
      domain: "app.example.com",
      dnsProvider: "other",
      keepExternalServices: [],
    };
    const questions = buildQuestions(facts([{ kind: "supabase", evidence: [] }]), previous);
    const defaults = Object.fromEntries(questions.map((q) => [q.id, q.default]));
    expect(defaults).toEqual({
      expectedMonthlyUsers: "10k-100k",
      budgetMonthly: { amount: 40, currency: "USD" },
      provider: "hetzner",
      region: "us-east",
      uptime: "high",
      dataCriticality: "critical",
      domain: "app.example.com",
      dnsProvider: "other",
      keepExternalServices: false,
    });
    expect(buildQuestions(facts()).find((q) => q.id === "budgetMonthly")?.default).toBeUndefined();
  });
});

describe("provider question", () => {
  const previousWith = (provider?: "hetzner" | "digitalocean"): Requirements => ({
    schemaVersion: 1,
    answeredAt: "2026-10-01T00:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 10, currency: "EUR" },
    ...(provider !== undefined ? { provider } : {}),
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "none",
    dnsProvider: "none",
    keepExternalServices: [],
  });
  const providerQuestion = (questions: Question[]) => questions.find((q) => q.id === "provider");

  it("asks which provider to use, directly before the region, with every option", () => {
    const questions = buildQuestions(facts());
    const index = ids(questions).indexOf("provider");
    expect(ids(questions)[index + 1]).toBe("region");
    expect(providerQuestion(questions)).toMatchObject({
      prompt: "Where should OpsCrew run your app?",
      kind: "single-select",
      required: true,
      default: "hetzner",
      options: [
        {
          value: "hetzner",
          label: "Hetzner Cloud",
          hint: "lowest prices; servers in Germany, Finland, the US and Singapore",
        },
        {
          value: "digitalocean",
          label: "DigitalOcean",
          hint: "use your DigitalOcean account; data centres in Germany, the Netherlands, the US and Singapore; prices in USD",
        },
        {
          value: "own",
          label: "A server you already have",
          hint: "an Ubuntu or Debian server you reach over SSH with a key, rented anywhere or at home; you already pay for it",
        },
        {
          value: "portainer",
          label: "My existing Portainer",
          hint: "a Portainer you already run, for example on a NAS or a home server; OpsCrew deploys the app as a stack through Portainer's API and changes nothing else on the host",
        },
      ],
    });
  });

  it("defaults to an existing Portainer chosen before, and records no region for it", () => {
    const previous: Requirements = { ...previousWith(), provider: "portainer" };
    expect(providerQuestion(buildQuestions(facts(), previous))?.default).toBe("portainer");
    const requirements = answersToRequirements(
      { ...BASE_ANSWERS, provider: "Portainer", region: "eu-central" },
      { now, facts: facts() },
    );
    expect(requirements.provider).toBe("portainer");
    expect(requirements.region).toBeUndefined();
    // The tunnel's name check waits for the Portainer answers (proxy and Caddy are DNS only).
    expect(
      answersToRequirements(
        {
          ...BASE_ANSWERS,
          provider: "portainer",
          domain: "api.shop.example.com",
          dnsProvider: "cloudflare",
        },
        { now, facts: facts() },
      ).domain,
    ).toBe("api.shop.example.com");
  });

  it("labels regions without naming one provider's locations", () => {
    const region = buildQuestions(facts()).find((q) => q.id === "region");
    expect(region).toMatchObject({
      prompt: "Where are most of your users?",
      help: "The server goes to the chosen provider's closest data centre.",
      options: [
        { value: "eu-central", label: "Central Europe" },
        { value: "eu-north", label: "Northern Europe" },
        { value: "us-east", label: "United States, east coast" },
        { value: "us-west", label: "United States, west coast" },
        { value: "ap-southeast", label: "Southeast Asia (Singapore)" },
      ],
    });
    expect(JSON.stringify(region)).not.toMatch(/Germany|Finland/);
  });

  it("defaults to the previous answer, then the inferred provider, then Hetzner", () => {
    const def = (previous?: Requirements, inferred?: "hetzner" | "digitalocean") =>
      providerQuestion(
        buildQuestions(
          facts(),
          previous,
          [],
          inferred !== undefined ? { inferredProvider: inferred } : {},
        ),
      )?.default;
    expect(def(previousWith("hetzner"), "digitalocean")).toBe("hetzner");
    expect(def(previousWith("digitalocean"))).toBe("digitalocean");
    expect(def(previousWith(), "digitalocean")).toBe("digitalocean");
    expect(def(undefined, "digitalocean")).toBe("digitalocean");
    expect(def()).toBe("hetzner");
    expect(inferredAnswers(facts()).provider).toBe("hetzner");
    expect(inferredAnswers(facts(), { inferredProvider: "digitalocean" }).provider).toBe(
      "digitalocean",
    );
  });

  it("accepts the provider case-insensitively and rejects other values with the valid list", () => {
    expect(
      answersToRequirements(
        { ...BASE_ANSWERS, provider: " DigitalOcean " },
        { now, facts: facts() },
      ).provider,
    ).toBe("digitalocean");
    expect(() =>
      answersToRequirements({ ...BASE_ANSWERS, provider: "aws" }, { now, facts: facts() }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringMatching(/provider must be one of hetzner, digitalocean/),
      }),
    );
  });

  it("always records the provider: given, previous, inferred, then Hetzner", () => {
    const opts = { now, facts: facts() };
    expect(answersToRequirements(BASE_ANSWERS, opts).provider).toBe("hetzner");
    const withoutFacts = { ...BASE_ANSWERS, dataCriticality: "none" };
    expect(answersToRequirements(withoutFacts, { now }).provider).toBe("hetzner");
    expect(
      answersToRequirements(withoutFacts, { now, inferredProvider: "digitalocean" }).provider,
    ).toBe("digitalocean");
    expect(
      answersToRequirements(BASE_ANSWERS, { ...opts, inferredProvider: "digitalocean" }).provider,
    ).toBe("digitalocean");
    expect(
      answersToRequirements(BASE_ANSWERS, {
        ...opts,
        previous: previousWith("hetzner"),
        inferredProvider: "digitalocean",
      }).provider,
    ).toBe("hetzner");
    expect(
      answersToRequirements(
        { ...BASE_ANSWERS, provider: "digitalocean" },
        { ...opts, previous: previousWith("hetzner") },
      ).provider,
    ).toBe("digitalocean");
  });

  it("infers the provider from the tokens that are set", async () => {
    const root = await project("static-vite");
    const run = async (tokens: Record<string, string>) => {
      const deps = await createTestPhaseDeps({
        root,
        env: { OPSCREW_HOME: join(root, ".home-opscrew"), ...tokens },
      });
      let asked: Question[] = [];
      const result = await runInterview(deps, {
        ask: async (questions) => {
          asked = questions;
          return BASE_ANSWERS;
        },
      });
      await rm(deps.paths.files.requirements);
      return { default: providerQuestion(asked)?.default, saved: result.requirements.provider };
    };
    expect(await run({ DIGITALOCEAN_TOKEN: fakeSecret("digitalocean-token") })).toEqual({
      default: "digitalocean",
      saved: "digitalocean",
    });
    expect(await run({ HCLOUD_TOKEN: fakeSecret("hcloud-token") })).toEqual({
      default: "hetzner",
      saved: "hetzner",
    });
    expect(
      await run({
        HCLOUD_TOKEN: fakeSecret("hcloud-token"),
        DIGITALOCEAN_TOKEN: fakeSecret("digitalocean-token"),
      }),
    ).toEqual({ default: "hetzner", saved: "hetzner" });
    expect(await run({})).toEqual({ default: "hetzner", saved: "hetzner" });
  });
});

describe("answer parsing", () => {
  it("normalises domains", () => {
    expect(normaliseDomain(" https://App.Example.COM./path?x=1 ")).toBe("app.example.com");
    expect(normaliseDomain("shop.example.org:443")).toBe("shop.example.org");
  });

  it("parses budgets", () => {
    expect(parseMoney(10)).toEqual({ amount: 10, currency: "EUR" });
    expect(parseMoney("€12.50")).toEqual({ amount: 12.5, currency: "EUR" });
    expect(parseMoney("20 usd / month")).toEqual({ amount: 20, currency: "USD" });
    expect(parseMoney("$5")).toEqual({ amount: 5, currency: "USD" });
    expect(parseMoney("7,5 EUR")).toEqual({ amount: 7.5, currency: "EUR" });
    expect(parseMoney({ amount: "15", currency: "usd" })).toEqual({ amount: 15, currency: "USD" });
    expect(parseMoney({ amount: 15 })).toEqual({ amount: 15, currency: "EUR" });
    expect(parseMoney("lots")).toBeUndefined();
    expect(parseMoney({ amount: 15, currency: "GBP" })).toBeUndefined();
    expect(parseMoney("$5 EUR")).toBeUndefined();
  });
});

describe("answersToRequirements", () => {
  it("builds valid requirements, inferring skipped answers", () => {
    const requirements = answersToRequirements(
      { ...BASE_ANSWERS, budgetMonthly: "15 EUR", domain: "HTTPS://App.Example.com/" },
      { now, facts: facts() },
    );
    expect(requirements).toEqual({
      schemaVersion: 1,
      answeredAt: "2026-10-11T12:00:00.000Z",
      expectedMonthlyUsers: "<1k",
      budgetMonthly: { amount: 15, currency: "EUR" },
      provider: "hetzner",
      region: "eu-central",
      uptime: "standard",
      dataCriticality: "none",
      domain: "app.example.com",
      dnsProvider: "cloudflare",
      keepExternalServices: [],
    });
  });

  it("uses DNS provider none without a domain and maps the Supabase answer", () => {
    const supabase = facts([{ kind: "supabase", evidence: [] }]);
    const kept = answersToRequirements(
      { ...BASE_ANSWERS, dataCriticality: "important", dnsProvider: "cloudflare" },
      { now, facts: supabase },
    );
    expect(kept.dnsProvider).toBe("none");
    expect(kept.domain).toBeUndefined();
    expect(kept.keepExternalServices).toEqual(["supabase"]);
    const dropped = answersToRequirements(
      { ...BASE_ANSWERS, dataCriticality: "important", keepExternalServices: false },
      { now, facts: supabase },
    );
    expect(dropped.keepExternalServices).toEqual([]);
  });

  it("refuses a Cloudflare domain two levels below its zone for a cloud server", () => {
    const answers = { ...BASE_ANSWERS, dataCriticality: "none" };
    expect(() =>
      answersToRequirements(
        { ...answers, domain: "api.shop.example.com", dnsProvider: "cloudflare" },
        { now, facts: facts() },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message:
          "Some answers are not valid: domain: Cloudflare's free certificate covers only example.com and *.example.com, so api.shop.example.com would fail HTTPS at Cloudflare's edge; use a name one level below example.com, such as api-shop.example.com, or answer other for dnsProvider to manage its DNS yourself, without Cloudflare's proxy.",
      }),
    );
    // One level below, the zone itself, a two-part suffix and DNS outside Cloudflare are fine.
    for (const domain of ["shop.example.com", "example.com", "shop.example.co.uk"]) {
      expect(
        answersToRequirements({ ...answers, domain }, { now, facts: facts() }).domain,
        domain,
      ).toBe(domain);
    }
    expect(
      answersToRequirements(
        { ...answers, domain: "api.shop.example.com", dnsProvider: "other" },
        { now, facts: facts() },
      ).dnsProvider,
    ).toBe("other");
  });

  it("lists missing required answers", () => {
    expect(() =>
      answersToRequirements(
        { region: "eu-central" },
        { now, facts: facts([{ kind: "postgres", evidence: [] }]) },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringMatching(
          /expectedMonthlyUsers .*budgetMonthly .*uptime .*dataCriticality/,
        ),
      }),
    );
  });

  it("rejects unknown keys and invalid values with plain-English messages", () => {
    expect(() =>
      answersToRequirements({ ...BASE_ANSWERS, budget: 10 }, { now, facts: facts() }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: "Unknown answer: budget." }),
    );
    try {
      answersToRequirements(
        { ...BASE_ANSWERS, region: "mars", budgetMonthly: "a lot", contactEmail: "nope" },
        { now, facts: facts() },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      const message = (error as Error).message;
      expect(message).toMatch(/budgetMonthly: write an amount such as `10 EUR`/);
      expect(message).toMatch(/region must be one of eu-central, eu-north, us-east/);
      expect(message).toMatch(/contactEmail: /);
    }
  });

  it("fills unanswered fields from previous answers and lets empty answers clear optional ones", () => {
    const previous = answersToRequirements(
      { ...BASE_ANSWERS, domain: "app.example.com", dnsProvider: "other" },
      { now, facts: facts() },
    );
    const again = answersToRequirements({ uptime: "high" }, { now, previous, facts: facts() });
    expect(again).toEqual({ ...previous, uptime: "high" });
    const cleared = answersToRequirements({ domain: "" }, { now, previous, facts: facts() });
    expect(cleared.domain).toBeUndefined();
    expect(cleared.dnsProvider).toBe("none");
  });

  it("ignores schemaVersion and answeredAt so a requirements file can be reused as answers", () => {
    const previous = answersToRequirements(BASE_ANSWERS, { now, facts: facts() });
    const later = new Date("2026-10-12T00:00:00.000Z");
    expect(answersToRequirements(previous, { now: later, facts: facts() }).answeredAt).toBe(
      later.toISOString(),
    );
  });
});

describe("runInterview", () => {
  it("writes requirements from an answers file without asking", async () => {
    const deps = await createTestPhaseDeps({ root: await project("static-vite") });
    const result = await runInterview(deps, { answers: { ...BASE_ANSWERS, budgetMonthly: 8 } });
    expect(ids(result.questions)).not.toContain("dataCriticality");
    expect(ids(result.questions)).not.toContain("keepExternalServices");
    const written = await readArtifact("requirements", deps.paths.files.requirements);
    expect(written).toEqual(result.requirements);
    expect(written.dataCriticality).toBe("none");
    expect(written.budgetMonthly).toEqual({ amount: 8, currency: "EUR" });
    expect((await deps.state.read()).phases.interview?.status).toBe("ok");
    expect(deps.reporter.text()).toMatch(/No opscrew\/architecture\.json yet/);
  });

  it("asks the questions interactively and pre-fills them on a re-run", async () => {
    const deps = await createTestPhaseDeps({ root: await project("lovable-supabase") });
    await runAnalyze(deps, { ai: false });
    const asked: Question[][] = [];
    const first = await runInterview(deps, {
      ask: async (questions) => {
        asked.push(questions);
        return {
          ...BASE_ANSWERS,
          dataCriticality: "critical",
          keepExternalServices: true,
          domain: "app.example.com",
        };
      },
    });
    expect(ids(asked[0] ?? [])).toContain("keepExternalServices");
    expect(ids(asked[0] ?? [])).toContain("dataCriticality");
    expect(first.requirements.keepExternalServices).toEqual(["supabase"]);
    expect(first.requirements.dnsProvider).toBe("cloudflare");

    const second = await runInterview(deps, {
      ask: async (questions) => {
        asked.push(questions);
        return Object.fromEntries(questions.map((q) => [q.id, q.default]));
      },
    });
    const defaults = Object.fromEntries((asked[1] ?? []).map((q) => [q.id, q.default]));
    expect(defaults).toMatchObject({
      dataCriticality: "critical",
      domain: "app.example.com",
      keepExternalServices: true,
      budgetMonthly: { amount: 10, currency: "EUR" },
    });
    expect(second.requirements).toEqual(first.requirements);
  });

  it("fails with INVALID_INPUT listing missing answers and records the failure", async () => {
    const deps = await createTestPhaseDeps({ root: await project("nextjs-postgres") });
    await expect(runInterview(deps, { answers: { region: "eu-north" } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(
        /expectedMonthlyUsers.*budgetMonthly.*uptime.*dataCriticality/,
      ),
    });
    await expect(runInterview(deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await deps.state.read()).phases.interview?.status).toBe("failed");
    await expect(readFile(deps.paths.files.requirements, "utf8")).rejects.toThrow();
  });

  it("ignores an invalid previous requirements file with a warning", async () => {
    const deps = await createTestPhaseDeps({ root: await project("static-vite") });
    await runInterview(deps, { answers: BASE_ANSWERS });
    await writeFile(deps.paths.files.requirements, "schemaVersion: 1\nregion: moon\n");
    const result = await runInterview(deps, { answers: BASE_ANSWERS });
    expect(result.requirements.region).toBe("eu-central");
    expect(deps.reporter.text()).toMatch(/not valid; its answers are not reused/);
  });

  it("does not ask which app to deploy in a single-app repository", async () => {
    const deps = await createTestPhaseDeps({ root: await project("nextjs-postgres") });
    await runAnalyze(deps, { ai: false });
    const before = await readFile(deps.paths.files.architecture, "utf8");
    const result = await runInterview(deps, {
      answers: { ...BASE_ANSWERS, dataCriticality: "important" },
    });
    expect(ids(result.questions)).not.toContain("appDir");
    expect(result.requirements.appDir).toBeUndefined();
    expect(result.reanalyzed).toBe(false);
    expect(await readFile(deps.paths.files.architecture, "utf8")).toBe(before);
  });
});

describe("choosing one app in a monorepo", () => {
  /** The detect fixture with an Express API in `apps/api` and a Next.js app in `apps/web`. */
  const TWO_APPS = fileURLToPath(
    new URL("../../../detect/test/fixtures/monorepo-two-apps/", import.meta.url),
  );
  const CANDIDATES = ["apps/api", "apps/web"];
  const rootFacts = (): ProjectFacts => ({
    ...facts(),
    appKind: "unknown",
    monorepo: true,
    appDir: ".",
    frameworks: [
      { name: "express", path: "apps/api" },
      { name: "next", path: "apps/web" },
      { name: "react", path: "apps/web" },
    ],
  });

  async function twoApps() {
    const root = await mkdtemp(join(tmpdir(), "opscrew-interview-two-apps-"));
    await materializeFixture(TWO_APPS, root);
    const deps = await createTestPhaseDeps({ root });
    await runAnalyze(deps, { ai: false });
    return deps;
  }

  it("asks first which app to deploy, describing each candidate", () => {
    const questions = buildQuestions(rootFacts(), undefined, CANDIDATES);
    const [first] = questions;
    expect(first).toMatchObject({ id: "appDir", kind: "single-select", required: true });
    expect(first?.options).toEqual([
      { value: "apps/api", label: "apps/api", hint: "Express" },
      { value: "apps/web", label: "apps/web", hint: "Next.js and React" },
    ]);
    expect(first?.default).toBeUndefined();
    expect(QuestionSchema.safeParse(first).success).toBe(true);

    const previous = answersToRequirements(
      { ...BASE_ANSWERS, appDir: "apps/web" },
      { now, facts: rootFacts(), appCandidates: CANDIDATES },
    );
    expect(buildQuestions(rootFacts(), previous, CANDIDATES)[0]?.default).toBe("apps/web");
  });

  it("does not ask with one candidate or when the facts already describe an app", () => {
    expect(ids(buildQuestions(rootFacts(), undefined, ["apps/api"]))).not.toContain("appDir");
    expect(
      ids(buildQuestions({ ...rootFacts(), appDir: "apps/api" }, undefined, CANDIDATES)),
    ).not.toContain("appDir");
    expect(ids(buildQuestions(rootFacts()))).not.toContain("appDir");
  });

  it("normalises the chosen folder and rejects one that is not a candidate", () => {
    const options = { now, facts: rootFacts(), appCandidates: CANDIDATES };
    expect(
      answersToRequirements({ ...BASE_ANSWERS, appDir: ".\\apps\\api\\" }, options).appDir,
    ).toBe("apps/api");
    expect(() =>
      answersToRequirements({ ...BASE_ANSWERS, appDir: "apps/admin" }, options),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringContaining(
          'appDir: "apps/admin" is not one of the apps OpsCrew found (apps/api, apps/web)',
        ),
      }),
    );
    expect(() => answersToRequirements(BASE_ANSWERS, options)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("appDir (app to deploy)") }),
    );
  });

  it("keeps an app chosen by the analysis over an older answer", () => {
    const previous = answersToRequirements(
      { ...BASE_ANSWERS, appDir: "apps/web" },
      { now, facts: rootFacts(), appCandidates: CANDIDATES },
    );
    const chosen = { ...rootFacts(), appDir: "apps/api" };
    expect(answersToRequirements({}, { now, previous, facts: chosen }).appDir).toBe("apps/api");
    expect(answersToRequirements({}, { now, previous, facts: rootFacts() }).appDir).toBe(
      "apps/web",
    );
  });

  it("asks for the app, then analyses the chosen app again without AI", async () => {
    const deps = await twoApps();
    const before = await readArtifact("architecture", deps.paths.files.architecture);
    expect(before.facts.appDir).toBe(".");
    expect(before.risks.join("\n")).toMatch(/several deployable apps/);

    let asked: Question[] = [];
    const result = await runInterview(deps, {
      ask: async (questions) => {
        asked = questions;
        return { ...BASE_ANSWERS, appDir: "apps/api", dataCriticality: "important" };
      },
    });
    expect(asked[0]?.id).toBe("appDir");
    expect(asked[0]?.options?.map((o) => o.value)).toEqual(CANDIDATES);
    expect(result.requirements.appDir).toBe("apps/api");
    expect(result.reanalyzed).toBe(true);

    const after = await readArtifact("architecture", deps.paths.files.architecture);
    expect(after.facts.appDir).toBe("apps/api");
    expect(after.facts.frameworks.map((f) => f.name)).toEqual(["express"]);
    expect(after.aiEnriched).toBe(false);
    expect(after.risks.join("\n")).not.toMatch(/several deployable apps/);
    expect(deps.reporter.text()).toMatch(/AI review was not re-run/);
    expect((await readArtifact("requirements", deps.paths.files.requirements)).appDir).toBe(
      "apps/api",
    );

    // A re-run keeps the choice without asking or analysing again.
    const again = await runInterview(deps, { answers: {} });
    expect(ids(again.questions)).not.toContain("appDir");
    expect(again.requirements.appDir).toBe("apps/api");
    expect(again.reanalyzed).toBe(false);
  });

  it("writes nothing when the chosen app is not one of the candidates", async () => {
    const deps = await twoApps();
    const before = await readFile(deps.paths.files.architecture, "utf8");
    await expect(
      runInterview(deps, { answers: { ...BASE_ANSWERS, appDir: "apps/nope" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readFile(deps.paths.files.requirements, "utf8")).rejects.toThrow();
    expect(await readFile(deps.paths.files.architecture, "utf8")).toBe(before);
    expect((await deps.state.read()).phases.interview?.status).toBe("failed");
  });
});
