import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactError,
  type ArtifactKind,
  type DeployPlan,
  parseArtifact,
  readArtifact,
  readOptionalArtifact,
  serializeArtifact,
  writeArtifact,
} from "./index";
import { YAML_HEADER } from "./io";

const BOM = String.fromCharCode(0xfeff);
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

const VALID: [ArtifactKind, string][] = [
  ["architecture", "architecture.json"],
  ["requirements", "requirements.yaml"],
  ["plan", "plan.yaml"],
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opscrew-plan-schema-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function catchArtifactError(fn: () => unknown): ArtifactError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactError);
    return error as ArtifactError;
  }
  throw new Error("expected an ArtifactError");
}

describe("round-trip", () => {
  it.each(VALID)("%s fixture serialises back byte-identically", async (kind, name) => {
    const text = await fixture(name);
    const value = parseArtifact(kind, text, name);
    expect(serializeArtifact(kind, value)).toBe(text);
  });

  it.each(VALID)("%s survives write then read deeply equal and stable", async (kind, name) => {
    const value = parseArtifact(kind, await fixture(name), name);
    const file = join(dir, "nested", "opscrew", name);
    await writeArtifact(kind, file, value);
    const first = await readFile(file, "utf8");
    expect(await readArtifact(kind, file)).toEqual(value);
    await writeArtifact(kind, file, await readArtifact(kind, file));
    expect(await readFile(file, "utf8")).toBe(first);
    expect(await readdir(join(dir, "nested", "opscrew"))).toEqual([name]);
  });

  it("is deterministic regardless of key order", async () => {
    const value = parseArtifact("plan", await fixture("plan.yaml"), "plan.yaml");
    const reordered = Object.fromEntries(Object.entries(value).reverse()) as DeployPlan;
    expect(serializeArtifact("plan", reordered)).toBe(serializeArtifact("plan", value));
  });

  it("writes YAML with the header comment and LF endings, JSON with a trailing newline", async () => {
    const plan = serializeArtifact(
      "plan",
      parseArtifact("plan", await fixture("plan.yaml"), "plan.yaml"),
    );
    expect(plan.startsWith(`${YAML_HEADER}\nschemaVersion: 1\n`)).toBe(true);
    expect(plan).not.toContain("\r");
    const arch = serializeArtifact(
      "architecture",
      parseArtifact("architecture", await fixture("architecture.json"), "a.json"),
    );
    expect(arch.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
    expect(arch.endsWith("}\n")).toBe(true);
  });
});

describe("input tolerance", () => {
  it.each(VALID)("%s accepts a UTF-8 BOM and CRLF line endings", async (kind, name) => {
    const text = await fixture(name);
    const crlf = `${BOM}${text.replace(/\n/g, "\r\n")}`;
    expect(crlf.charCodeAt(0)).toBe(0xfeff);
    expect(parseArtifact(kind, crlf, name)).toEqual(parseArtifact(kind, text, name));
    const file = join(dir, name);
    await writeFile(file, crlf, "utf8");
    expect(await readArtifact(kind, file)).toEqual(parseArtifact(kind, text, name));
  });

  it("fills documented defaults for a minimal plan", () => {
    const minimal = [
      "schemaVersion: 1",
      "createdAt: 2026-10-11T14:03:00.000Z",
      "updatedAt: 2026-10-11T14:03:00.000Z",
      "app: { name: demo, port: 8080, env: [] }",
      "target: { provider: hetzner, mode: vps-compose, location: fsn1, serverType: cx22, backups: false }",
      "externalServices: []",
      "cost:",
      "  monthly: { amount: 4.5, currency: EUR }",
      "  breakdown: [{ item: server, monthly: { amount: 4.5, currency: EUR } }]",
      "  pricesIncludeVat: true",
      "  source: static",
      "  asOf: 2026-10-01T00:00:00Z",
      "codeChanges: []",
      "dns: { provider: none }",
      "cicd: { provider: github-actions, registry: ghcr }",
    ].join("\n");
    const plan = parseArtifact("plan", minimal, "plan.yaml");
    expect(plan.app).toMatchObject({
      healthPath: "/health",
      buildContext: ".",
      dockerfile: "Dockerfile",
      memoryMb: 512,
    });
    expect(plan.app.build).toBeUndefined();
    expect(plan.target).toMatchObject({ image: "ubuntu-24.04" });
    expect(plan.deploy).toEqual({ strategy: "rolling", drainSeconds: 30 });
    expect(plan.processes).toEqual({ workers: [], cron: [] });
    expect(plan.services).toEqual([]);
    expect(plan.storage).toBeUndefined();
    expect(plan.supplyChain).toEqual({ sign: false });
    expect(plan.infra).toEqual({
      engine: "auto",
      dir: "opscrew/infra/prod",
      stateEncryption: true,
    });
    expect(plan.dns).toEqual({ provider: "none", proxied: true, www: false });
    expect(plan.cicd).toEqual({
      provider: "github-actions",
      workflowPath: ".github/workflows/opscrew-deploy.yml",
      registry: "ghcr",
      branch: "main",
      deployTags: { enabled: false, release: false },
      imageRetention: { enabled: true, keep: 10 },
    });
    expect(plan.security).toEqual({
      sshAllowedCidrs: ["0.0.0.0/0", "::/0"],
      httpAllowedFrom: "cloudflare",
      wafCustomRules: true,
      imageScan: true,
    });
    expect(plan.approvals).toEqual([]);
    expect(plan.deployment).toEqual({});
    // Serialising writes the defaults out; reading that back is stable.
    const text = serializeArtifact("plan", plan);
    expect(serializeArtifact("plan", parseArtifact("plan", text, "plan.yaml"))).toBe(text);

    const unproxied = parseArtifact(
      "plan",
      minimal.replace("dns: { provider: none }", "dns: { provider: none, proxied: false }"),
      "plan.yaml",
    );
    expect(unproxied.security.httpAllowedFrom).toBe("any");
  });
});

describe("errors", () => {
  it("names the file, the missing field and the next step (spec US2 scenario 2)", async () => {
    await writeFile(
      join(dir, "plan.yaml"),
      await fixture("invalid/plan-missing-server-type.yaml"),
      "utf8",
    );
    await expect(readArtifact("plan", join(dir, "plan.yaml"))).rejects.toBeInstanceOf(
      ArtifactError,
    );
    const error = await readArtifact("plan", join(dir, "plan.yaml")).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "ARTIFACT_INVALID",
      file: join(dir, "plan.yaml"),
      issues: [{ path: "target.serverType", message: "is missing" }],
      hint: "Run `opscrew design` to regenerate the plan, or fix the field shown above.",
    });
    const message = (error as ArtifactError).message;
    expect(message).toContain(join(dir, "plan.yaml"));
    expect(message).toContain("target.serverType");
    expect(message).toContain("opscrew design");
    expect(message).not.toMatch(/\n\s+at /); // no stack trace in the message
  });

  it("reports a missing file with ARTIFACT_MISSING and a per-kind hint", async () => {
    const file = join(dir, "requirements.yaml");
    const error = await readArtifact("requirements", file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactError);
    expect(error).toMatchObject({
      code: "ARTIFACT_MISSING",
      file,
      issues: [],
      hint: "Run `opscrew interview` to answer the deployment questions.",
    });
    expect((error as ArtifactError).message).toContain(file);
  });

  it("reads an artefact that may be missing as undefined, but never hides an invalid one", async () => {
    const file = join(dir, "requirements.yaml");
    await expect(readOptionalArtifact("requirements", file)).resolves.toBeUndefined();
    await writeFile(file, await fixture("requirements.yaml"), "utf8");
    await expect(readOptionalArtifact("requirements", file)).resolves.toEqual(
      await readArtifact("requirements", file),
    );
    await writeFile(file, "budget: [unclosed\n", "utf8");
    await expect(readOptionalArtifact("requirements", file)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
    });
  });

  it("uses the architecture hint", () => {
    const error = catchArtifactError(() => parseArtifact("architecture", "{", "a.json"));
    expect(error.hint).toBe("Run `opscrew analyze` to regenerate it.");
    expect(error.issues[0]?.path).toBe("(root)");
    expect(error.issues[0]?.message).toMatch(/not valid JSON/);
  });

  it("reports YAML syntax errors and empty files", () => {
    const bad = catchArtifactError(() => parseArtifact("plan", "app: [unclosed\n", "plan.yaml"));
    expect(bad.code).toBe("ARTIFACT_INVALID");
    expect(bad.issues[0]?.message).toMatch(/not valid YAML/);
    const empty = catchArtifactError(() => parseArtifact("plan", `${YAML_HEADER}\n`, "plan.yaml"));
    expect(empty.issues).toEqual([{ path: "(root)", message: "the file is empty" }]);
  });

  it("flags unknown (misspelled) fields with a dotted path", async () => {
    const text = (await fixture("plan.yaml")).replace("  serverType: cpx22", "  serverTyp: cpx22");
    const error = catchArtifactError(() => parseArtifact("plan", text, "opscrew/plan.yaml"));
    expect(error.issues).toEqual(
      expect.arrayContaining([
        {
          path: "target.serverTyp",
          message: "is not a known field (check the spelling or remove it)",
        },
        { path: "target.serverType", message: "is missing" },
      ]),
    );
  });

  it("uses dotted paths with array indices", async () => {
    const text = (await fixture("plan.yaml")).replace(
      "    path: src/routes/health.ts",
      "    path: /abs/src/routes/health.ts",
    );
    const error = catchArtifactError(() => parseArtifact("plan", text, "plan.yaml"));
    expect(error.issues.map((i) => i.path)).toEqual(["codeChanges.1.path"]);
  });

  it("never serialises or writes invalid data", async () => {
    const value = parseArtifact("plan", await fixture("plan.yaml"), "plan.yaml");
    const broken = { ...value, target: { ...value.target, serverType: "" } };
    const error = catchArtifactError(() => serializeArtifact("plan", broken));
    expect(error.issues.map((i) => i.path)).toEqual(["target.serverType"]);
    const file = join(dir, "out", "plan.yaml");
    await expect(writeArtifact("plan", file, broken)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file,
    });
    await expect(readdir(join(dir, "out"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
