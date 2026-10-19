import { type ProjectFacts, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design";
import {
  createTestPhaseDeps,
  euCatalog,
  makeFacts,
  makeRequirements,
  writeArchitecture,
} from "../testing";
import {
  applyComponentAnswers,
  buildComponentQuestions,
  hostedAdditions,
  splitComponentAnswers,
} from "./components";
import { runInterview } from "./run";

const hosted = makeFacts({
  services: [
    { kind: "postgres", evidence: ["dependency:pg"] },
    { kind: "mongodb", evidence: ["dependency:mongoose"] },
    { kind: "redis", evidence: ["dependency:ioredis"] },
  ],
  hostedServices: [
    { kind: "mongodb", variable: "MONGODB_URI", provider: "MongoDB Atlas" },
    { kind: "postgres", variable: "DATABASE_URL", provider: "Neon" },
    { kind: "redis", variable: "REDIS_URL", provider: "Upstash" },
  ],
});

const bull = (facts: Partial<ProjectFacts> = {}) =>
  makeFacts({
    workers: [
      { name: "bullmq", source: "library", single: false, evidence: ["dependency:bullmq"] },
      {
        name: "worker",
        command: "node worker.js",
        source: "procfile",
        single: false,
        evidence: ["procfile:worker"],
      },
    ],
    ...facts,
  });

/** Writes `facts` as the project's `opscrew/architecture.json`. */
async function withFacts(facts: ProjectFacts) {
  const deps = await createTestPhaseDeps();
  await writeArchitecture(deps.paths.files.architecture, "shop");
  const architecture = await readArtifact("architecture", deps.paths.files.architecture);
  await writeArtifact("architecture", deps.paths.files.architecture, { ...architecture, facts });
  return deps;
}

const ANSWERS = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "10 EUR",
  region: "eu-central",
  uptime: "standard",
  dataCriticality: "important",
};

describe("buildComponentQuestions", () => {
  it("asks one generic question per hosted service OpsCrew could run, never about Atlas", () => {
    const questions = buildComponentQuestions(hosted, {
      keepExternalServices: { redis: false },
    });
    // Unanswered, a hosted service is kept; an earlier answer carries over.
    expect(questions.map((q) => [q.id, q.prompt, q.kind, q.default])).toEqual([
      ["keepExternalServices.postgres", "Keep using Neon for PostgreSQL?", "confirm", true],
      ["keepExternalServices.redis", "Keep using Upstash for Redis?", "confirm", false],
    ]);
    // Without the additions it still says what running it adds.
    expect(questions[0]?.help).toBe(
      "Yes (recommended) keeps the app on Neon (DATABASE_URL). No runs PostgreSQL on your server instead, and you move the data yourself. Running PostgreSQL on your server adds a container with 512 MB of memory. OpsCrew cannot see what Neon charges you, so it shows no difference.",
    );
  });

  it("asks a worker's command only when no convention gives it", () => {
    const questions = buildComponentQuestions(bull(), { keepExternalServices: {} });
    expect(questions).toEqual([
      expect.objectContaining({
        id: "workerCommands.bullmq",
        prompt: "Which command starts the worker bullmq?",
        kind: "text",
        required: false,
      }),
    ]);
    const answered = buildComponentQuestions(bull(), {
      keepExternalServices: {},
      workerCommands: { bullmq: "node dist/worker.js" },
    });
    expect(answered[0]?.default).toBe("node dist/worker.js");
  });
});

describe("hostedAdditions", () => {
  const deps = () => createTestPhaseDeps();

  it("says what running it adds: its memory, and the bigger server's published price", async () => {
    const neon = makeFacts({
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
      hostedServices: [{ kind: "postgres", variable: "DATABASE_URL", provider: "Neon" }],
    });
    const requirements = makeRequirements();
    const additions = await hostedAdditions(await deps(), neon, requirements);
    // Hetzner's dated price list: Postgres needs 4 GB, 2 vCPU and 60 GB of disk.
    const [question] = buildComponentQuestions(neon, requirements, additions);
    expect(question?.help).toMatch(
      /Running PostgreSQL on your server adds a container with 512 MB of memory, which needs a bigger server: \S+ at €[\d.]+\/month instead of \S+ at €[\d.]+\/month \(estimate as of \d{4}-\d{2}-\d{2}\)\. OpsCrew cannot see/,
    );
  });

  it("says the user's own server must have room for it", async () => {
    const requirements = makeRequirements({ provider: "own" });
    const additions = await hostedAdditions(await deps(), hosted, requirements);
    const question = buildComponentQuestions(hosted, requirements, additions).find(
      (q) => q.id === "keepExternalServices.redis",
    );
    expect(question?.help).toContain(
      "Running Valkey on your server adds a container with 128 MB of memory, which your server must have room for.",
    );
  });
});

describe("component answers", () => {
  it("keeps or runs each service, and takes worker commands flat or nested", () => {
    const split = splitComponentAnswers(
      {
        expectedMonthlyUsers: "<1k",
        "keepExternalServices.postgres": "no",
        keepExternalServices: { redis: true, s3: true },
        workerCommands: { bullmq: " node dist/worker.js " },
      },
      bull(hosted),
    );
    expect(split.rest).toEqual({ expectedMonthlyUsers: "<1k" });
    const requirements = applyComponentAnswers(
      makeRequirements({ keepExternalServices: { stripe: true, mongodb: true, postgres: true } }),
      split,
    );
    expect(requirements.keepExternalServices).toEqual({
      postgres: false,
      mongodb: true,
      redis: true,
      s3: true,
      stripe: true,
    });
    expect(requirements.workerCommands).toEqual({ bullmq: "node dist/worker.js" });
    // A plain answer for every hosted service stays an answer of its own.
    expect(splitComponentAnswers({ keepExternalServices: false }, hosted).rest).toEqual({
      keepExternalServices: false,
    });
  });

  it("refuses answers that are not this app's or not valid", () => {
    const split = splitComponentAnswers(
      {
        "workerCommands.mailer": "node mail.js",
        "keepExternalServices.postgres": "maybe",
        "keepExternalServices.neon": true,
      },
      bull(hosted),
    );
    expect(() => applyComponentAnswers(makeRequirements(), split)).toThrow(
      /keepExternalServices\.neon: not a question for this app.*workerCommands\.mailer: not a question for this app.*keepExternalServices\.postgres: answer yes or no/,
    );
  });

  it("are carried by an answers file into requirements.yaml", async () => {
    const deps = await withFacts(bull(hosted));
    const { requirements } = await runInterview(deps, {
      answers: {
        ...ANSWERS,
        "workerCommands.bullmq": "node dist/worker.js",
        "keepExternalServices.redis": false,
      },
    });
    // Neon and Atlas are kept, unanswered; Upstash is not.
    expect(requirements.keepExternalServices).toEqual({
      postgres: true,
      mongodb: true,
      redis: false,
    });
    expect(requirements.workerCommands).toEqual({ bullmq: "node dist/worker.js" });
    expect(await readArtifact("requirements", deps.paths.files.requirements)).toEqual(requirements);
  });

  it("never runs a hosted service found after the last interview, with no question answered", async () => {
    // The previous interview had nothing to ask; the app has since moved to Neon.
    const deps = await withFacts(
      makeFacts({ services: [{ kind: "postgres", evidence: ["dependency:pg"] }] }),
    );
    await runInterview(deps, { answers: ANSWERS });
    const before = await readArtifact("requirements", deps.paths.files.requirements);
    expect(before.keepExternalServices).toEqual({});
    const neon = makeFacts({
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
      hostedServices: [{ kind: "postgres", variable: "DATABASE_URL", provider: "Neon" }],
    });
    const architecture = await readArtifact("architecture", deps.paths.files.architecture);
    await writeArtifact("architecture", deps.paths.files.architecture, {
      ...architecture,
      facts: neon,
    });
    // Design straight away, on the old answers: Neon stays.
    const first = await runDesign(deps, { catalog: euCatalog() });
    expect(first.plan.services).toEqual([]);
    expect(first.plan.externalServices).toEqual(["postgres"]);
    // A rerun of the interview without answers, and the defaults it would ask with: kept too.
    const { requirements } = await runInterview(deps, {});
    expect(requirements.keepExternalServices).toEqual({ postgres: true });
    expect(buildComponentQuestions(neon, before)[0]?.default).toBe(true);
  });
});
