import { describe, expect, it } from "vitest";
import { nextPostgresFacts } from "../testing";
import { backgroundJobLibraries, backgroundJobsWarning } from "./background-jobs";

const withQueue = (evidence: string[], appKind = "api" as const) =>
  nextPostgresFacts({
    appKind,
    services: [
      { kind: "queue", evidence },
      { kind: "redis", evidence: ["env:REDIS_URL"] },
    ],
  });

const NONE = { processes: { workers: [], cron: [] } };

describe("backgroundJobsWarning", () => {
  it("names the library when OpsCrew found no worker for it, and says what to do", () => {
    const warning = backgroundJobsWarning(withQueue(["dependency:celery[redis]"]), NONE);
    expect(warning).toBe(
      "This app also runs background jobs with Celery, but OpsCrew found no worker that runs them: no Procfile type and no job library with a process of its own. The jobs will not run until you add the worker's command to processes.workers in opscrew/plan.yaml (with source: user); then run `opscrew design` again.",
    );
  });

  it("names every library it knows, in a stable order", () => {
    const facts = withQueue(["dependency:bullmq", "dependency:rq", "devDependency:bull"]);
    expect(backgroundJobLibraries(facts)).toEqual(["BullMQ", "RQ"]);
    expect(backgroundJobsWarning(facts, NONE)).toContain("background jobs with BullMQ and RQ,");
  });

  it("falls back to a plain sentence when the queue has no named library", () => {
    const warning = backgroundJobsWarning(withQueue(["env:CELERY_BROKER_URL"]), NONE);
    expect(warning).toMatch(/^This app also runs background jobs, but OpsCrew found no worker/);
  });

  it("says nothing once a worker runs the jobs, detected or added in the plan", () => {
    const facts = withQueue(["dependency:bullmq"]);
    const detected = {
      ...facts,
      workers: [
        {
          name: "bullmq",
          source: "library" as const,
          single: false,
          evidence: ["dependency:bullmq"],
        },
      ],
    };
    expect(backgroundJobsWarning(detected, NONE)).toBeUndefined();
    const worker = {
      name: "jobs",
      command: "node worker.js",
      source: "user" as const,
      count: 1,
      single: false,
      stopGraceSeconds: 30,
      memoryMb: 256,
      enabled: true,
    };
    expect(
      backgroundJobsWarning(facts, { processes: { workers: [worker], cron: [] } }),
    ).toBeUndefined();
  });

  it("recognises worker libraries that show up as frameworks", () => {
    const facts = nextPostgresFacts({
      frameworks: [
        { name: "fastapi", path: "." },
        { name: "dramatiq", path: "." },
      ],
    });
    expect(backgroundJobLibraries(facts)).toEqual(["Dramatiq"]);
  });

  it("says nothing for an app without background jobs", () => {
    expect(backgroundJobsWarning(nextPostgresFacts(), NONE)).toBeUndefined();
    const cronOnly = nextPostgresFacts({
      services: [{ kind: "cron", evidence: ["dependency:node-cron"] }],
    });
    expect(backgroundJobsWarning(cronOnly, NONE)).toBeUndefined();
  });

  it("says nothing for a worker app or a static site (no web process beside the jobs)", () => {
    expect(backgroundJobsWarning(withQueue(["dependency:celery"], "worker" as never), NONE)).toBe(
      undefined,
    );
    expect(
      backgroundJobsWarning(withQueue(["dependency:bullmq"], "static-spa" as never), NONE),
    ).toBeUndefined();
  });
});
