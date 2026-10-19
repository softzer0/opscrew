import { describe, expect, it } from "vitest";
import { RequirementsSchema } from "./requirements";

const requirements = {
  schemaVersion: 1,
  answeredAt: "2026-10-19T10:00:00.000Z",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  provider: "hetzner",
  region: "eu-central",
  uptime: "standard",
  dataCriticality: "important",
  dnsProvider: "none",
  keepExternalServices: {},
};

describe("RequirementsSchema keepExternalServices", () => {
  it("answers per kind whether the app keeps a service where it is hosted, empty by default", () => {
    const { keepExternalServices: _none, ...unanswered } = requirements;
    expect(RequirementsSchema.parse(unanswered).keepExternalServices).toEqual({});
    const parsed = RequirementsSchema.parse({
      ...requirements,
      keepExternalServices: { supabase: true, redis: false },
    });
    expect(parsed.keepExternalServices).toEqual({ supabase: true, redis: false });
    for (const keepExternalServices of [["supabase"], { neon: true }, { redis: "yes" }]) {
      expect(
        RequirementsSchema.safeParse({ ...requirements, keepExternalServices }).success,
        JSON.stringify(keepExternalServices),
      ).toBe(false);
    }
  });
});

describe("RequirementsSchema workerCommands", () => {
  it("keeps the commands of workers by their names", () => {
    const parsed = RequirementsSchema.parse({
      ...requirements,
      workerCommands: { bullmq: "node dist/worker.js", "mail-2": "node mail.js" },
    });
    expect(parsed.workerCommands).toEqual({
      bullmq: "node dist/worker.js",
      "mail-2": "node mail.js",
    });
    expect(RequirementsSchema.parse(requirements).workerCommands).toBeUndefined();
  });

  it("refuses names a worker cannot have and commands on several lines", () => {
    const issues = (workerCommands: Record<string, string>) =>
      RequirementsSchema.safeParse({ ...requirements, workerCommands }).error?.issues.map((i) =>
        i.path.join("."),
      );
    expect(issues({ Worker_1: "node worker.js" })).toEqual(["workerCommands.Worker_1"]);
    expect(issues({ cron: "node worker.js" })).toEqual(["workerCommands.cron"]);
    expect(issues({ bullmq: "node a.js\nnode b.js" })).toEqual(["workerCommands.bullmq"]);
  });
});
