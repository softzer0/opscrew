import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  contextFor,
  expectNoFakeValues,
  gitRunner,
  keys,
  type MaterializedFixture,
  materialize,
  scanWith,
} from "../scan/test-utils";
import { createSecretsScanner } from "./secrets";

let fixture: MaterializedFixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function scanFixture(tracked?: readonly string[]): Promise<Finding[]> {
  fixture = await materialize("secrets/app");
  if (tracked) await mkdir(path.join(fixture.dir, ".git"));
  const context = await contextFor(fixture.dir, tracked ? gitRunner(tracked) : undefined);
  return scanWith(createSecretsScanner(), context);
}

function find(findings: Finding[], ruleId: string, file: string): Finding {
  const finding = findings.find((f) => f.ruleId === ruleId && f.file === file);
  if (!finding) throw new Error(`missing ${ruleId} in ${file}: ${keys(findings).join(", ")}`);
  return finding;
}

describe("createSecretsScanner", () => {
  it("is a built-in scanner with the opscrew-secrets id", () => {
    const scanner = createSecretsScanner();
    expect(scanner.id).toBe("opscrew-secrets");
    expect(scanner.kind).toBe("builtin");
  });

  it("finds every token family, generic secret and private key in the fixture", async () => {
    const findings = await scanFixture();
    expect(keys(findings)).toEqual(
      [
        "secrets/github-token@src/github.ts:2",
        "secrets/github-token@src/github.ts:3",
        "secrets/anthropic-api-key@src/ai.py:3",
        "secrets/openai-api-key@src/ai.py:4",
        "secrets/aws-access-key-id@src/ai.py:5",
        "secrets/aws-secret-access-key@src/ai.py:6",
        "secrets/stripe-secret-key@src/billing.js:1",
        "secrets/slack-token@src/billing.js:2",
        "secrets/google-api-key@src/billing.js:3",
        "secrets/url-credentials@config/db.ts:1",
        "secrets/hcloud-token@deploy/vars.sh:2",
        "secrets/cloudflare-api-token@deploy/vars.sh:3",
        "secrets/generic-high-entropy@config/settings.yaml:3",
        "secrets/private-key@certs/server.key:1",
        "secrets/private-key@certs/client.p12:",
        "secrets/generic-high-entropy@.env:3",
        "secrets/env-not-ignored@.env:2",
      ].sort(),
    );
    for (const finding of findings) {
      expect(finding.source).toBe("opscrew-secrets");
      expect(finding.category).toBe("secret");
      expect(finding.id).toMatch(/^[0-9a-f]{16}$/);
      expect(finding.description.length).toBeGreaterThan(20);
      expect(finding.remediation.length).toBeGreaterThan(20);
    }
  });

  it("assigns severities per the plan", async () => {
    const findings = await scanFixture();
    expect(find(findings, "secrets/stripe-secret-key", "src/billing.js").severity).toBe("critical");
    expect(find(findings, "secrets/google-api-key", "src/billing.js").severity).toBe("medium");
    expect(find(findings, "secrets/aws-access-key-id", "src/ai.py").severity).toBe("high");
    expect(find(findings, "secrets/hcloud-token", "deploy/vars.sh").severity).toBe("critical");
    expect(find(findings, "secrets/private-key", "certs/server.key").severity).toBe("critical");
    expect(find(findings, "secrets/url-credentials", "config/db.ts").severity).toBe("high");
  });

  it("masks evidence with maskSecret", async () => {
    const findings = await scanFixture();
    const github = find(findings, "secrets/github-token", "src/github.ts");
    expect(github.evidence).toBe(`ghp_…(${fakeSecret("github-token").length} chars)`);
    const generic = find(findings, "secrets/generic-high-entropy", "config/settings.yaml");
    expect(generic.evidence).toMatch(/^password=Fake…\(\d+ chars\)$/);
    const env = find(findings, "secrets/env-not-ignored", ".env");
    expect(env.evidence).toBe("PORT, SESSION_SECRET");
  });

  it("never puts a generated fake value into any finding field", async () => {
    const findings = await scanFixture([".env", "src/github.ts"]);
    expectNoFakeValues(findings, fixture?.fakes ?? []);
  });

  it("reports a git-tracked .env as committed (critical)", async () => {
    const findings = await scanFixture([".env", "src/github.ts"]);
    const env = find(findings, "secrets/committed-env", ".env");
    expect(env.severity).toBe("critical");
    expect(env.title).toContain("Committed .env");
    expect(findings.some((f) => f.ruleId === "secrets/env-not-ignored")).toBe(false);
  });

  it("still inspects a committed .env that .gitignore now hides", async () => {
    fixture = await materialize("secrets/app");
    await writeFile(path.join(fixture.dir, ".gitignore"), ".env\n");
    await mkdir(path.join(fixture.dir, ".git"));
    const context = await contextFor(fixture.dir, gitRunner([".env"]));
    expect(context.files).not.toContain(".env");
    const findings = await scanWith(createSecretsScanner(), context);
    expect(find(findings, "secrets/committed-env", ".env").severity).toBe("critical");
  });

  it("ignores an untracked .env that .gitignore excludes", async () => {
    fixture = await materialize("secrets/app");
    await writeFile(path.join(fixture.dir, ".gitignore"), ".env\n");
    await mkdir(path.join(fixture.dir, ".git"));
    const findings = await scanWith(
      createSecretsScanner(),
      await contextFor(fixture.dir, gitRunner(["src/github.ts"])),
    );
    expect(findings.filter((f) => f.file === ".env")).toEqual([]);
  });

  it("skips placeholders, env references, docs prose, examples and anon JWTs", async () => {
    const findings = await scanFixture();
    const files = new Set(findings.map((f) => f.file));
    expect(files.has("src/negatives.ts")).toBe(false);
    expect(files.has("docs/SETUP.md")).toBe(false);
    expect(files.has(".env.example")).toBe(false);
    expect(findings.filter((f) => f.file === "config/db.ts")).toHaveLength(1);
  });

  it("skips minified lines but still finds PEM blocks inside them", async () => {
    fixture = await materialize("secrets/app");
    const filler = "x=1;".repeat(1_500);
    const pem = fakeSecret("private-key-pem", "minified").replace(/\n/g, "\\n");
    await mkdir(path.join(fixture.dir, "public"));
    await writeFile(
      path.join(fixture.dir, "public", "vendor.min.js"),
      `${filler}var t="${fakeSecret("github-token", "minified")}";var k="${pem}";\n`,
    );
    const findings = await scanWith(createSecretsScanner(), await contextFor(fixture.dir));
    expect(keys(findings.filter((f) => f.file === "public/vendor.min.js"))).toEqual([
      "secrets/private-key@public/vendor.min.js:1",
    ]);
  });

  it("skips binary files and lockfiles", async () => {
    fixture = await materialize("secrets/app");
    const token = fakeSecret("github-token", "binary");
    await writeFile(path.join(fixture.dir, "blob.dat"), `\0\0${token}`);
    await writeFile(path.join(fixture.dir, "logo.png"), token);
    await writeFile(path.join(fixture.dir, "package-lock.json"), `{"x":"${token}"}`);
    const findings = await scanWith(createSecretsScanner(), await contextFor(fixture.dir));
    const files = new Set(findings.map((f) => f.file));
    for (const file of ["blob.dat", "logo.png", "package-lock.json"]) {
      expect(files.has(file)).toBe(false);
    }
  });

  it("rates encrypted private keys high and Stripe test keys medium", async () => {
    fixture = await materialize("secrets/app");
    const body = fakeSecret("private-key-pem", "enc")
      .replace(/PRIVATE KEY/g, "ENCRYPTED PRIVATE KEY")
      .split("\n");
    await writeFile(path.join(fixture.dir, "enc.pem"), `${body.join("\n")}\n`);
    const testKey = fakeSecret("stripe-live-key", "test").replace("sk_live_", "sk_test_");
    await writeFile(path.join(fixture.dir, "pay.ts"), `const s = "${testKey}";\n`);
    const findings = await scanWith(createSecretsScanner(), await contextFor(fixture.dir));
    expect(find(findings, "secrets/private-key", "enc.pem").severity).toBe("high");
    expect(find(findings, "secrets/stripe-secret-key", "pay.ts").severity).toBe("medium");
  });

  it("gives the same id for the same match on rescans", async () => {
    const first = await scanFixture();
    await fixture?.cleanup();
    const second = await scanFixture();
    expect(second.map((f) => f.id).sort()).toEqual(first.map((f) => f.id).sort());
  });
});
