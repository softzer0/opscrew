import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderDependabot } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts, testPlan } from "../testing";
import { dependabotPullRequestLines, dependabotStep } from "./dependabot";

async function temp(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-dependabot-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const facts = makeFacts();
const plan = testPlan();

function java(): DeployPlan {
  return {
    ...plan,
    app: {
      ...plan.app,
      build: {
        builder: "buildpacks",
        chosen: "user",
        reason: "The reason.",
        runtime: { language: "java", version: "25" },
      },
    },
  };
}

describe("dependabotStep", () => {
  it("writes OpsCrew's file when the repository has none", async () => {
    const step = await dependabotStep(await temp(), facts, plan);
    expect(step).toEqual({ action: "write", file: renderDependabot(facts, plan) });
    expect(step.action === "write" && step.file.path).toBe(".github/dependabot.yml");
  });

  it("names Maven or Gradle for a Java app, from its build file", async () => {
    const javaFacts = makeFacts({ languages: ["java"], packageManager: "none" });
    const content = async (files: Record<string, string>) => {
      const step = await dependabotStep(await temp(files), javaFacts, java());
      return step.action === "write" ? step.file.content : "";
    };
    expect(await content({ "pom.xml": "<project/>\n" })).toContain("package-ecosystem: maven");
    expect(await content({ "build.gradle.kts": "plugins {}\n" })).toContain(
      "package-ecosystem: gradle",
    );
    expect(await content({})).not.toMatch(/package-ecosystem: (?:maven|gradle)/);
  });

  it("keeps the user's file, listing the folders its entries lack, or saying it cannot read it", async () => {
    const yaml = [
      "version: 2",
      "updates:",
      "  - package-ecosystem: github-actions",
      "    directory: /",
      "  - package-ecosystem: docker-compose",
      "    directories: [/opscrew/runtime/]",
      "",
    ].join("\n");
    const root = await temp({ ".github/dependabot.yaml": yaml });
    expect(await dependabotStep(root, facts, plan)).toEqual({
      action: "keep",
      path: ".github/dependabot.yaml",
      missing: ["npm in /", "docker in /", "docker-compose in /opscrew/runtime/*"],
    });
    const broken = await temp({ ".github/dependabot.yml": "updates: [\n" });
    expect(await dependabotStep(broken, facts, plan)).toEqual({
      action: "keep",
      path: ".github/dependabot.yml",
    });
  });

  it("takes OpsCrew's own unchanged file as OpsCrew's (a --plan-only run wrote it, or it is committed)", async () => {
    const file = renderDependabot(facts, plan);
    // Git may check it out with CRLF line endings.
    const crlf = file.content.replace(/\n/g, "\r\n");
    for (const content of [file.content, crlf]) {
      const root = await temp({ [file.path]: content });
      expect(await dependabotStep(root, facts, plan)).toEqual({ action: "write", file });
    }
    // Once the user changed it, it is theirs.
    const edited = await temp({ [file.path]: `${file.content}# mine\n` });
    expect(await dependabotStep(edited, facts, plan)).toEqual({
      action: "keep",
      path: file.path,
      missing: [],
    });
  });
});

describe("dependabotPullRequestLines", () => {
  it("says OpsCrew added the file, or lists what the user's lacks", () => {
    const file = renderDependabot(facts, plan);
    expect(dependabotPullRequestLines({ action: "write", file })).toEqual([
      "- `.github/dependabot.yml`: weekly dependency updates, with minor and patch versions grouped; major versions of the runtime images are left to you.",
    ]);
    expect(
      dependabotPullRequestLines({
        action: "keep",
        path: ".github/dependabot.yml",
        missing: ["docker in /docker", "github-actions in /"],
      }),
    ).toEqual([
      "- `.github/dependabot.yml` is yours and stays as it is; OpsCrew's would also update: docker in /docker, github-actions in /.",
    ]);
    // Nothing to say: the user's file lacks nothing, or cannot be read (provision warns then).
    const path = ".github/dependabot.yml";
    expect(dependabotPullRequestLines({ action: "keep", path, missing: [] })).toEqual([]);
    expect(dependabotPullRequestLines({ action: "keep", path })).toEqual([]);
    expect(dependabotPullRequestLines(undefined)).toEqual([]);
  });
});
