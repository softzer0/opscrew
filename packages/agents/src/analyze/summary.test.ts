import type { ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { summarizeFacts } from "./summary";

/** What detection reports for a monorepo with an Express API and a Next.js web app. */
function ambiguousMonorepo(): ProjectFacts {
  return {
    name: "mono",
    languages: ["typescript"],
    packageManager: "pnpm",
    frameworks: [
      { name: "express", path: "apps/api" },
      { name: "next", path: "apps/web" },
      { name: "react", path: "apps/web" },
      { name: "react", path: "packages/ui" },
    ],
    appKind: "unknown",
    platformExport: { platform: "none", evidence: [] },
    build: {},
    runtimeVersions: {},
    envVars: [],
    services: [],
    docker: {},
    monorepo: true,
    appDir: ".",
    git: {},
  };
}

describe("summarizeFacts for a monorepo with several apps", () => {
  const options = { appCandidates: ["apps/api", "apps/web"] };

  it("describes each candidate app instead of one app of unknown type", () => {
    const { summary } = summarizeFacts(ambiguousMonorepo(), options);
    expect(summary).toContain(
      "mono is a monorepo with 2 deployable apps: `apps/api` (Express) and `apps/web` (Next.js and React), written in TypeScript.",
    );
    expect(summary).not.toMatch(/unknown type/);
    expect(summary).not.toMatch(/built with/);
    expect(summary).not.toContain("The repository is a monorepo.");
  });

  it("does not contradict itself in the risks", () => {
    const { risks } = summarizeFacts(ambiguousMonorepo(), options);
    const text = risks.join("\n");
    expect(text).toMatch(/several deployable apps \(`apps\/api` and `apps\/web`\)/);
    expect(text).toMatch(/stops until you choose which/);
    expect(text).toMatch(/`opscrew interview`/);
    expect(text).toMatch(/`opscrew analyze --app apps\/api`/);
    expect(text).not.toMatch(/no known web framework/);
    expect(text).not.toMatch(/could not tell what kind of app/);
  });

  it("describes a chosen app in a subfolder without the several-apps risk", () => {
    const facts = {
      ...ambiguousMonorepo(),
      appKind: "api" as const,
      appDir: "apps/api",
      frameworks: [{ name: "express", path: "apps/api" }],
    };
    const { summary, risks } = summarizeFacts(facts);
    expect(summary).toContain("built with Express");
    expect(summary).toContain(
      "It lives in `apps/api` of a monorepo and is built from the repository root.",
    );
    expect(summary).not.toContain("The repository is a monorepo.");
    expect(risks.join("\n")).not.toMatch(/several deployable apps/);
  });

  it("names a candidate without a detected framework plainly", () => {
    const { summary } = summarizeFacts(ambiguousMonorepo(), {
      appCandidates: ["apps/api", "apps/worker"],
    });
    expect(summary).toContain("`apps/api` (Express) and `apps/worker`,");
  });

  it("keeps the unknown-kind risk when only one app was found", () => {
    const facts = { ...ambiguousMonorepo(), frameworks: [], monorepo: false };
    const { summary, risks } = summarizeFacts(facts);
    expect(summary).toContain("mono is an app of unknown type written in TypeScript.");
    expect(risks.join("\n")).toMatch(/could not tell what kind of app/);
  });
});
