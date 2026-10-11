import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";

/** Lets a test lower the scan's file limit (20,000) so truncation can be tested on a small fixture. */
const limits = vi.hoisted(() => ({ maxFiles: undefined as number | undefined }));
vi.mock("@opscrew/secops", async (importOriginal) => {
  const secops = await importOriginal<typeof import("@opscrew/secops")>();
  return {
    ...secops,
    runScan: (root: string, options: Parameters<typeof secops.runScan>[1]) =>
      secops.runScan(
        root,
        limits.maxFiles === undefined ? options : { ...options, maxFiles: limits.maxFiles },
      ),
  };
});

let project: TempProject | undefined;
afterEach(async () => {
  limits.maxFiles = undefined;
  await project?.cleanup();
  project = undefined;
});

const SERVICE_ROLE = fakeSecret("supabase-service-role-jwt");

describe("opscrew scan", () => {
  it("writes both reports, prints a summary and exits 1 on high findings", async () => {
    project = await tempProject("lovable-supabase");
    const ctx = projectContext(project);
    expect(await run(ctx, "scan", "--offline")).toBe(1);

    const paths = resolveProjectPaths(project.root, { env: project.env });
    const markdown = await readFile(paths.files.scanReportMd, "utf8");
    const json = JSON.parse(await readFile(paths.files.scanReportJson, "utf8"));
    expect(markdown).toContain("supabase/service-role-in-client");
    expect(json.findings.map((f: { ruleId: string }) => f.ruleId)).toContain(
      "supabase/rls-disabled",
    );
    expect(ctx.output).toContain("OpsCrew scan of lovable-supabase:");
    expect(ctx.output).toContain("Full report: opscrew/SECURITY_SCAN.md");
    expect(ctx.output).toContain("opscrew analyze");
    expect(ctx.fetchUrls).toEqual([]);

    const state = await new ProjectStateStore(paths.files.state).read();
    expect(state.phases.scan?.status).toBe("ok");
    for (const text of [ctx.output, ctx.errors, markdown, JSON.stringify(json)]) {
      expect(text).not.toContain(SERVICE_ROLE);
      expect(text).not.toContain(project.root);
    }
  });

  it("exits 0 on a clean project and says nothing serious was found", async () => {
    project = await tempProject("static-vite");
    const ctx = projectContext(project);
    expect(await run(ctx, "scan", "--offline")).toBe(0);
    expect(ctx.output).toContain("0 critical, 0 high");
    expect(ctx.output).toContain("No high or critical problems were found.");
    expect(ctx.errors).not.toMatch(/were not checked/);
  });

  it("says so when only medium findings remain (US1 AS2)", async () => {
    project = await tempProject("static-vite");
    // A Dockerfile running as root is a medium finding.
    await writeFile(path.join(project.root, "Dockerfile"), 'FROM node:22-alpine\nCMD ["node"]\n');
    const ctx = projectContext(project);
    expect(await run(ctx, "scan", "--offline")).toBe(0);
    expect(ctx.output).toContain("No high or critical problems were found.");
    expect(ctx.output).toContain("MEDIUM");
  });

  it("warns when the scan stops at the file limit, also with --json", async () => {
    project = await tempProject("static-vite");
    limits.maxFiles = 2;
    const ctx = projectContext(project);
    await run(ctx, "scan", "--offline");
    expect(ctx.output + ctx.errors).toMatch(/more than 2 files.*were not checked/);
    const json = projectContext(project);
    await run(json, "scan", "--offline", "--json");
    expect(JSON.parse(json.output).tool).toBe("opscrew");
    expect(json.errors).toMatch(/more than 2 files/);
  });

  it("honours --fail-on", async () => {
    project = await tempProject("static-vite");
    // A Dockerfile running as root is a medium finding.
    await writeFile(path.join(project.root, "Dockerfile"), 'FROM node:22-alpine\nCMD ["node"]\n');
    const lenient = projectContext(project);
    expect(await run(lenient, "scan", "--offline")).toBe(0);
    const strict = projectContext(project);
    expect(await run(strict, "scan", "--offline", "--fail-on", "low")).toBe(1);
    expect(strict.output).toContain("fix the low or worse findings");
  });

  it("prints only the JSON report with --json", async () => {
    project = await tempProject("lovable-supabase");
    const ctx = projectContext(project);
    expect(await run(ctx, "scan", "--offline", "--json", "--fail-on", "critical")).toBe(1);
    const report = JSON.parse(ctx.output);
    expect(report.tool).toBe("opscrew");
    expect(report.counts.critical).toBeGreaterThan(0);
  });

  it("uses the injected fetch for dependency lookups when online", async () => {
    project = await tempProject("lovable-supabase");
    const ctx = projectContext(project);
    await run(ctx, "scan");
    // The lockfile-less fixture may not need OSV; whatever was fetched went through the fake.
    for (const url of ctx.fetchUrls) expect(url).toMatch(/^https:\/\/api\.osv\.dev\//);
  });

  it("exits 2 for an invalid --fail-on value or an unknown option", async () => {
    project = await tempProject("static-vite");
    const bad = projectContext(project);
    expect(await run(bad, "scan", "--fail-on", "severe")).toBe(2);
    expect(bad.errors).toContain("--fail-on must be one of critical, high, medium, low, info");
    const unknown = projectContext(project);
    expect(await run(unknown, "scan", "--nope")).toBe(2);
  });

  it("exits 2 when the scan cannot run", async () => {
    project = await tempProject("static-vite");
    const ctx = projectContext(project);
    // The state directory is a file, so the reports cannot be written.
    await writeFile(path.join(project.root, ".opscrew"), "not a directory");
    expect(await run(ctx, "scan", "--offline")).toBe(2);
    expect(ctx.errors).toMatch(/✗ /);
  });
});
