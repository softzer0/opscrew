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

describe("backgroundJobsWarning", () => {
  it("names the library, says only the web process is deployed and what to do meanwhile", () => {
    const warning = backgroundJobsWarning(withQueue(["dependency:celery[redis]"]));
    expect(warning).toBe(
      "This app also runs background jobs with Celery. OpsCrew deploys only the web process for now, so the background jobs will not run until worker support arrives. Meanwhile, run the worker yourself, for example on the same server next to the app.",
    );
  });

  it("names every library it knows, in a stable order", () => {
    const facts = withQueue(["dependency:bullmq", "dependency:rq", "devDependency:bull"]);
    expect(backgroundJobLibraries(facts)).toEqual(["BullMQ", "RQ"]);
    expect(backgroundJobsWarning(facts)).toContain("background jobs with BullMQ and RQ.");
  });

  it("falls back to a plain sentence when the queue has no named library", () => {
    const warning = backgroundJobsWarning(withQueue(["env:CELERY_BROKER_URL"]));
    expect(warning).toMatch(/^This app also runs background jobs\. OpsCrew deploys only/);
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
    expect(backgroundJobsWarning(nextPostgresFacts())).toBeUndefined();
    const cronOnly = nextPostgresFacts({
      services: [{ kind: "cron", evidence: ["dependency:node-cron"] }],
    });
    expect(backgroundJobsWarning(cronOnly)).toBeUndefined();
  });

  it("says nothing for a worker app or a static site (no web process beside the jobs)", () => {
    expect(backgroundJobsWarning(withQueue(["dependency:celery"], "worker" as never))).toBe(
      undefined,
    );
    expect(
      backgroundJobsWarning(withQueue(["dependency:bullmq"], "static-spa" as never)),
    ).toBeUndefined();
  });
});
