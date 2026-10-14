import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectFactsSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { DetectError, detectProject, detectProjectDetails, normalizeAppDir } from "./index";

const FIXTURES = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const TURBO = join(FIXTURES, "monorepo-turbo");
const TWO_APPS = join(FIXTURES, "monorepo-two-apps");

async function rejection(promise: Promise<unknown>): Promise<DetectError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DetectError);
    return error as DetectError;
  }
  throw new Error("expected detection to fail");
}

describe("normalizeAppDir", () => {
  it.each([
    ["apps/api", "apps/api"],
    ["apps/api/", "apps/api"],
    ["./apps/api", "apps/api"],
    ["././apps//api///", "apps/api"],
    ["apps\\api\\", "apps/api"],
    [" apps/api ", "apps/api"],
    [".", "."],
    ["./", "."],
    ["", "."],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeAppDir(input)).toBe(expected);
  });
});

describe("chosen app directory: monorepo-turbo", () => {
  it("auto-selects the only app and records it in the facts", async () => {
    const result = await detectProjectDetails(TURBO);
    expect(result.appDir).toBe("apps/web");
    expect(result.facts.appDir).toBe("apps/web");
    expect(result.appCandidates).toEqual([]);
  });

  it("gives the same facts when the only app is chosen explicitly", async () => {
    const auto = await detectProjectDetails(TURBO);
    const chosen = await detectProjectDetails(TURBO, { appDir: "./apps/web/" });
    expect(chosen.appDir).toBe("apps/web");
    expect(chosen.appCandidates).toEqual([]);
    expect(chosen.facts).toEqual(auto.facts);
  });

  it("describes the repository root when `.` is chosen", async () => {
    const result = await detectProjectDetails(TURBO, { appDir: "." });
    expect(result.appDir).toBe(".");
    expect(result.appCandidates).toEqual([]);
    expect(result.facts.appDir).toBe(".");
    expect(result.facts.appKind).toBe("unknown");
    expect(result.facts.port).toBeUndefined();
  });

  it("rejects a directory that is not a detected unit", async () => {
    const error = await rejection(detectProjectDetails(TURBO, { appDir: "apps/missing" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("apps/missing");
    expect(error.message).toContain("apps/web");
    expect(error.candidates).toEqual(["apps/web"]);
  });
});

describe("chosen app directory: two-app monorepo", () => {
  it("lists both apps when none is chosen", async () => {
    const result = await detectProjectDetails(TWO_APPS);
    expect(result.appDir).toBe(".");
    expect(result.facts.appDir).toBe(".");
    expect(result.appCandidates).toEqual(["apps/api", "apps/web"]);
  });

  it("describes only the Express API when apps/api is chosen", async () => {
    const result = await detectProjectDetails(TWO_APPS, { appDir: "apps/api/" });
    expect(result.appDir).toBe("apps/api");
    expect(result.appCandidates).toEqual([]);
    expect(ProjectFactsSchema.parse(result.facts)).toEqual(result.facts);
    expect(result.facts).toEqual({
      name: "duo",
      languages: ["javascript"],
      packageManager: "pnpm",
      frameworks: [{ name: "express", version: "^5.0.1", path: "apps/api" }],
      appKind: "api",
      platformExport: { platform: "none", evidence: [] },
      build: {
        installCommand: "pnpm install --frozen-lockfile",
        startCommand: "pnpm --filter api start",
      },
      port: 4001,
      runtimeVersions: {},
      envVars: [
        {
          name: "DATABASE_URL",
          files: ["apps/api/src/server.js"],
          clientExposed: false,
          secretLikely: true,
        },
        {
          name: "PORT",
          files: ["apps/api/src/server.js"],
          clientExposed: false,
          secretLikely: false,
          hasDefault: true,
        },
      ],
      services: [{ kind: "postgres", evidence: ["dependency:pg", "env:DATABASE_URL"] }],
      docker: {},
      healthEndpoint: "/healthz",
      monorepo: true,
      appDir: "apps/api",
      git: {},
    });
  });

  it("describes the Next.js app when apps/web is chosen", async () => {
    const facts = await detectProject(TWO_APPS, { appDir: "apps/web" });
    expect(facts.appDir).toBe("apps/web");
    expect(facts.appKind).toBe("ssr");
    expect(facts.port).toBe(3000);
    expect(facts.frameworks.map((f) => f.name)).toEqual(["next", "react"]);
    expect(facts.envVars.map((v) => v.name)).toEqual(["NEXT_PUBLIC_API_URL"]);
    expect(facts.services).toEqual([]);
    expect(facts.build.startCommand).toBe("pnpm --filter web start");
  });

  it("throws INVALID_INPUT listing the candidates for an unknown directory", async () => {
    const error = await rejection(detectProjectDetails(TWO_APPS, { appDir: "apps/worker" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.candidates).toEqual(["apps/api", "apps/web"]);
    expect(error.message).toContain("apps/api, apps/web");
    expect(error.hint).toContain("--app");
  });

  it.each(["../outside", "/apps/api", "apps/api/src"])("rejects %j", async (appDir) => {
    const error = await rejection(detectProjectDetails(TWO_APPS, { appDir }));
    expect(error.code).toBe("INVALID_INPUT");
  });
});
