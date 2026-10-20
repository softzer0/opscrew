import { readFile } from "node:fs/promises";
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
  answeredKinds,
  applyComponentAnswers,
  buildComponentQuestions,
  hostedAdditions,
  splitComponentAnswers,
  storageAnswerText,
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

/** An app with an S3 client, and optionally an endpoint at a known host. */
const s3 = (hostedServices: ProjectFacts["hostedServices"] = []) =>
  makeFacts({
    services: [{ kind: "s3", evidence: ["dependency:@aws-sdk/client-s3"] }],
    objectStorage: { client: "@aws-sdk/client-s3", presignedUploads: false, variables: [] },
    ...(hostedServices.length > 0 ? { hostedServices } : {}),
  });

describe("the object storage questions (FR-1316a)", () => {
  it("ask to keep the storage the app uses now or let OpsCrew create a bucket, kept by default", () => {
    const [keep, where, ...rest] = buildComponentQuestions(s3(), makeRequirements());
    expect(rest).toEqual([]);
    expect(keep).toEqual({
      id: "keepExternalServices.s3",
      prompt: "Keep the storage the app uses now for its files?",
      help: "The app stores files through S3 (@aws-sdk/client-s3). Yes keeps that storage: OpsCrew creates no bucket, and you set its address and keys in the app's production environment. No lets OpsCrew create a private bucket for the app, at the storage you choose next.",
      kind: "confirm",
      default: true,
      required: false,
    });
    // The offers where the app runs, with their prices; Garage too, but never the default here.
    expect(where).toEqual({
      id: "objectStorage",
      prompt: "If OpsCrew creates the bucket, which storage should it use?",
      help: "Priced for 10 GB stored and 50 GB sent a month, from the number of users (storage.objectStorage.expected in opscrew/plan.yaml changes it later). Used only when you let OpsCrew create a bucket.",
      kind: "single-select",
      options: [
        {
          value: "garage",
          label:
            "Garage on your server $0.00/month plus 64 MB of the server's memory, with the files on that server only",
          hint: "only if you choose it",
        },
        { value: "hetzner", label: "Hetzner Object Storage €6.49/month" },
      ],
      default: "hetzner",
      required: false,
    });
    // On the user's own server Garage can be the default; an earlier answer carries over.
    const own = buildComponentQuestions(s3(), makeRequirements({ provider: "own" }));
    expect(own[1]).toMatchObject({ options: [{ value: "garage" }], default: "garage" });
    const earlier = buildComponentQuestions(
      s3(),
      makeRequirements({ keepExternalServices: { s3: false }, objectStorage: "garage" }),
    );
    expect(earlier.map((q) => q.default)).toEqual([false, "garage"]);
  });

  it("name the known host the app stores its files at", () => {
    const amazon = s3([{ kind: "s3", variable: "S3_ENDPOINT", provider: "Amazon S3" }]);
    const [keep] = buildComponentQuestions(amazon, makeRequirements());
    expect(keep).toMatchObject({
      id: "keepExternalServices.s3",
      prompt: "Keep storing the app's files at Amazon S3?",
      default: true,
    });
    expect(keep?.help).toBe(
      "The app stores files through S3 (@aws-sdk/client-s3) at Amazon S3 (S3_ENDPOINT). Yes keeps that storage: OpsCrew creates no bucket, and you set its address and keys in the app's production environment. No lets OpsCrew create a private bucket for the app, at the storage you choose next, and you move the files yourself.",
    );
  });

  it("list every storage with where it is offered before the target is known", () => {
    const [, where] = buildComponentQuestions(s3(), { keepExternalServices: {} });
    expect(where?.options?.map((o) => [o.value, o.hint])).toEqual([
      ["garage", "on the app's server: on a cloud server only if you choose it"],
      ["hetzner", "on Hetzner Cloud in Falkenstein, Nuremberg or Helsinki"],
      ["digitalocean", "on DigitalOcean"],
      ["r2", "with the domain on Cloudflare"],
    ]);
    expect(where?.default).toBeUndefined();
    // With an earlier choice and no target (the provider may change in the same answers).
    const [, earlier] = buildComponentQuestions(s3(), {
      keepExternalServices: { s3: false },
      objectStorage: "garage",
    });
    expect(earlier?.options).toHaveLength(4);
    expect(earlier?.default).toBe("garage");
  });

  it("take the storage only for a bucket OpsCrew creates, and only where it is offered", () => {
    const apply = (answers: Record<string, unknown>, requirements = makeRequirements()) =>
      applyComponentAnswers(requirements, splitComponentAnswers(answers, s3()));
    const garage = apply({ "keepExternalServices.s3": false, objectStorage: "Garage" });
    expect(garage.keepExternalServices).toEqual({ s3: false });
    expect(garage.objectStorage).toBe("garage");
    // Kept storage needs no choice; an empty answer removes an earlier one.
    expect(apply({ "keepExternalServices.s3": true, objectStorage: "garage" }).objectStorage).toBe(
      undefined,
    );
    const earlier = makeRequirements({
      keepExternalServices: { s3: false },
      objectStorage: "garage",
    });
    expect(apply({ objectStorage: "" }, earlier).objectStorage).toBeUndefined();
    expect(apply({}, earlier).objectStorage).toBe("garage");
    // An earlier choice the target no longer offers does not carry over.
    const moved = makeRequirements({
      provider: "digitalocean",
      keepExternalServices: { s3: false },
      objectStorage: "hetzner",
    });
    expect(apply({}, moved).objectStorage).toBeUndefined();
    // DigitalOcean Spaces is not offered on Hetzner.
    expect(() =>
      apply({ "keepExternalServices.s3": false, objectStorage: "digitalocean" }),
    ).toThrow(
      'objectStorage: "digitalocean" is not offered where the app runs (choose one of garage, hetzner)',
    );
  });

  it("are summed up as a new bucket, not as something run on the server", () => {
    const bucket = makeRequirements({ keepExternalServices: { s3: false, redis: false } });
    expect(answeredKinds(bucket, false)).toEqual(["redis"]);
    expect(storageAnswerText(bucket)).toBe("a new bucket, at the storage design picks");
    expect(storageAnswerText({ ...bucket, objectStorage: "garage" })).toBe(
      "a new bucket in Garage on your server",
    );
    const kept = makeRequirements({ keepExternalServices: { s3: true } });
    expect(answeredKinds(kept, true)).toEqual(["s3"]);
    expect(storageAnswerText(kept)).toBeUndefined();
  });

  it("let the user choose Garage on Hetzner, which a rerun of design keeps", async () => {
    const deps = await withFacts(s3());
    let asked: string[] = [];
    await runInterview(deps, {
      answers: ANSWERS,
      askComponents: async (questions) => {
        asked = questions.map((q) => q.id);
        return { "keepExternalServices.s3": false, objectStorage: "garage" };
      },
    });
    expect(asked).toEqual(["keepExternalServices.s3", "objectStorage"]);
    const first = await runDesign(deps, { catalog: euCatalog() });
    expect(first.plan.storage?.objectStorage).toMatchObject({ provider: "garage" });
    expect(first.plan.services.map((s) => s.kind)).toEqual(["garage"]);
    const before = await readFile(deps.paths.files.plan, "utf8");
    await runDesign(deps, { catalog: euCatalog() });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("default to where the plan's bucket is, so accepting the defaults never moves it", async () => {
    const deps = await withFacts(s3());
    await runInterview(deps, { answers: { ...ANSWERS, "keepExternalServices.s3": false } });
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    expect(plan.storage?.objectStorage?.provider).toBe("hetzner");
    // The user moves the bucket to Garage in plan.yaml, then reruns the interview.
    const storage = plan.storage?.objectStorage;
    if (storage === undefined) throw new Error("no bucket planned");
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      storage: { objectStorage: { ...storage, provider: "garage", region: "garage" } },
    });
    let defaults: unknown[] = [];
    const { requirements } = await runInterview(deps, {
      answers: ANSWERS,
      askComponents: async (questions) => {
        defaults = questions.map((q) => q.default);
        return Object.fromEntries(questions.map((q) => [q.id, q.default]));
      },
    });
    expect(defaults).toEqual([false, "garage"]);
    expect(requirements).toMatchObject({
      keepExternalServices: { s3: false },
      objectStorage: "garage",
    });
    const again = await runDesign(deps, { catalog: euCatalog() });
    expect(again.plan.storage?.objectStorage).toMatchObject({
      provider: "garage",
      bucket: storage.bucket,
    });
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
