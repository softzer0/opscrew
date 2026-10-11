import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding } from "@opscrew/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  contextFor,
  expectNoFakeValues,
  keys,
  type MaterializedFixture,
  materialize,
  scanWith,
} from "../scan/test-utils";
import { createConfigScanner } from "./config";

let fixture: MaterializedFixture | undefined;
const temps: string[] = [];
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scanFixture(): Promise<Finding[]> {
  fixture = await materialize("config/app");
  return scanWith(createConfigScanner(), await contextFor(fixture.dir));
}

/** Scans a throwaway project made of `files` (repo-relative path → content). */
async function scanFiles(files: Record<string, string>): Promise<Finding[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-config-"));
  temps.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return scanWith(createConfigScanner(), await contextFor(dir));
}

function find(findings: Finding[], ruleId: string, file?: string): Finding {
  const finding = findings.find(
    (f) => f.ruleId === ruleId && (file === undefined || f.file === file),
  );
  if (!finding) throw new Error(`missing ${ruleId} in ${file}: ${keys(findings).join(", ")}`);
  return finding;
}

describe("createConfigScanner", () => {
  it("is a built-in scanner with the opscrew-config id", () => {
    const scanner = createConfigScanner();
    expect(scanner.id).toBe("opscrew-config");
    expect(scanner.kind).toBe("builtin");
  });

  it("reports exactly the expected findings in the fixture", async () => {
    const findings = await scanFixture();
    expect(keys(findings)).toEqual(
      [
        "config/dockerfile-latest-tag@Dockerfile:1",
        "config/dockerfile-root@Dockerfile:1",
        "config/dockerfile-secret-env@Dockerfile:5",
        "config/dockerfile-secret-env@Dockerfile:7",
        "config/dockerfile-latest-tag@services/worker/Dockerfile:1",
        "config/dockerfile-root@services/worker/Dockerfile:4",
        "config/django-debug@mysite/settings.py:5",
        "config/cors-wildcard-credentials@mysite/settings.py:12",
        "config/cors-wildcard-credentials@flaskapp/app.py:5",
        "config/flask-debug@flaskapp/app.py:17",
        "config/cors-wildcard-credentials@server/index.js:7",
        "config/cors-wildcard-credentials@api/main.py:8",
        "config/client-exposed-secret@web/src/client.ts:4",
        "config/client-exposed-secret@web/src/client.ts:5",
        "config/client-exposed-secret@web/.env.local:2",
        "config/env-not-gitignored@.gitignore:",
      ].sort(),
    );
    for (const finding of findings) {
      expect(finding.source).toBe("opscrew-config");
      expect(finding.category).toBe("config");
      expect(finding.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("uses the severities from the task", async () => {
    const findings = await scanFixture();
    const severity = (ruleId: string) => find(findings, ruleId).severity;
    expect(severity("config/dockerfile-root")).toBe("medium");
    expect(severity("config/dockerfile-latest-tag")).toBe("low");
    expect(severity("config/dockerfile-secret-env")).toBe("high");
    expect(severity("config/django-debug")).toBe("high");
    expect(severity("config/flask-debug")).toBe("high");
    expect(severity("config/cors-wildcard-credentials")).toBe("medium");
    expect(severity("config/client-exposed-secret")).toBe("critical");
    expect(severity("config/env-not-gitignored")).toBe("medium");
  });

  it("masks ENV/ARG values and never leaks a generated fake value", async () => {
    const findings = await scanFixture();
    const env = findings.filter((f) => f.ruleId === "config/dockerfile-secret-env");
    expect(env.map((f) => f.evidence)).toEqual([
      expect.stringMatching(/^ENV API_SECRET=Fake…\(\d+ chars\)$/),
      expect.stringMatching(/^ARG DB_PASSWORD=Fake…\(\d+ chars\)$/),
    ]);
    expectNoFakeValues(findings, fixture?.fakes ?? []);
  });

  it("explains latest versus untagged base images", async () => {
    const findings = await scanFixture();
    expect(find(findings, "config/dockerfile-latest-tag", "Dockerfile").title).toContain("latest");
    expect(
      find(findings, "config/dockerfile-latest-tag", "services/worker/Dockerfile").title,
    ).toContain("no version tag");
  });

  it("lists the unignored env files in the .gitignore finding", async () => {
    const findings = await scanFixture();
    expect(find(findings, "config/env-not-gitignored").evidence).toBe(".env, web/.env.local");
  });

  describe("negative cases", () => {
    it("accepts a non-root Dockerfile with pinned images and runtime secrets", async () => {
      const findings = await scanFixture();
      const files = new Set(findings.map((f) => f.file));
      expect(files.has("services/web/Dockerfile")).toBe(false);
      expect(files.has("services/distroless/Dockerfile")).toBe(false);
    });

    it("ignores dev settings, DEBUG = False, commented and disabled Flask debug", async () => {
      const findings = await scanFixture();
      const files = new Set(findings.map((f) => f.file));
      for (const file of ["mysite/settings_dev.py", "mysite/production.py", "flaskapp/safe.py"]) {
        expect(files.has(file)).toBe(false);
      }
    });

    it("ignores wildcard CORS without credentials and credentials only in comments", async () => {
      const findings = await scanFixture();
      expect(findings.some((f) => f.file === "server/public.js")).toBe(false);
    });

    it("ignores public client env names and prose", async () => {
      const findings = await scanFixture();
      expect(findings.some((f) => f.evidence === "VITE_SUPABASE_ANON_KEY")).toBe(false);
      expect(findings.some((f) => f.file === "web/README.md")).toBe(false);
    });

    it("reports nothing about .env when .gitignore excludes it", async () => {
      const findings = await scanFiles({ ".gitignore": ".env*\n", ".env": "PORT=3000\n" });
      expect(findings).toEqual([]);
    });

    it("reports nothing for an empty project", async () => {
      expect(await scanFiles({ "README.md": "# hi\n" })).toEqual([]);
    });

    it("ignores debug=True outside Flask apps and in tests", async () => {
      const findings = await scanFiles({
        "tool.py": "import logging\nrun(debug=True)\n",
        "tests/test_app.py":
          "from flask import Flask\napp = Flask(__name__)\napp.run(debug=True)\n",
      });
      expect(findings).toEqual([]);
    });
  });

  it("handles Dockerfile variants, root USER, nonroot bases and ENV legacy syntax", async () => {
    const findings = await scanFiles({
      "api.Dockerfile": "FROM python:3.12-slim\nUSER 0\n",
      Containerfile: "FROM registry.local:5000/team/app\nUSER app\n",
      "docker/Dockerfile.prod": `FROM node:22\nENV ADMIN_PASSWORD hunter2-but-longer\nUSER node\n`,
    });
    expect(keys(findings)).toEqual(
      [
        "config/dockerfile-root@api.Dockerfile:2",
        "config/dockerfile-latest-tag@Containerfile:1",
        "config/dockerfile-secret-env@docker/Dockerfile.prod:2",
      ].sort(),
    );
  });

  it("reports the .env rule without a file when the project has no .gitignore", async () => {
    const findings = await scanFiles({ ".env": "PORT=3000\n" });
    const finding = find(findings, "config/env-not-gitignored");
    expect(finding.file).toBeUndefined();
    expect(finding.description).toContain("no .gitignore");
  });
});
