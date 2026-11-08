// Feature 013's plain PHP apps (US8, T1319): the web root, the kept folder and `cron.php` jobs in
// the facts and the plan.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ArchitectureSchema,
  DeployPlanSchema,
  ProjectFactsSchema,
  parseArtifact,
  snapshotsOn,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");
const validPlan = async () => parseArtifact("plan", await fixture("plan.yaml"), "fixture");
const facts = async () =>
  ArchitectureSchema.parse(JSON.parse(await fixture("architecture.json"))).facts;

function pathsOf(result: { success: boolean; error?: z.ZodError }) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => i.path.join(".")) ?? [];
}

const build = {
  builder: "railpack",
  chosen: "auto",
  reason: "A PHP app without a framework: Railpack builds it.",
  runtime: { language: "php", version: "8.5" },
  probe: "php",
  webRoot: "public",
} as const;

describe("ProjectFacts of a plain PHP app", () => {
  it("records the web root, the kept folder and a cron.php job beside route jobs", async () => {
    const f = await facts();
    const found = {
      webRoot: "public",
      files: { dir: "storage" },
      cronJobs: [
        { schedule: "0 5 * * *", route: "/api/cron", source: "vercel.json" },
        { schedule: "* * * * *", command: "php bin/cron.php", source: "cron.php" },
      ],
    };
    expect(ProjectFactsSchema.parse({ ...f, ...found })).toEqual({ ...f, ...found });
    const parsed = ProjectFactsSchema.parse(f);
    expect(parsed).not.toHaveProperty("webRoot");
    expect(parsed).not.toHaveProperty("files");
  });

  it("rejects a mixed or malformed cron job and a path outside the app", async () => {
    const f = await facts();
    const paths = (fields: object) => pathsOf(ProjectFactsSchema.safeParse({ ...f, ...fields }));
    const job = (fields: object) => ({ cronJobs: [{ schedule: "* * * * *", ...fields }] });
    expect(paths(job({ command: "php bin/cron.php", source: "vercel.json" }))).toEqual([
      "cronJobs.0.route",
      "cronJobs.0",
    ]);
    expect(paths(job({ route: "/cron", source: "cron.php" }))).toEqual([
      "cronJobs.0.command",
      "cronJobs.0",
    ]);
    expect(paths(job({ command: "php bin/cron.php", source: "crontab" }))).toEqual([
      "cronJobs.0.source",
    ]);
    expect(paths(job({ command: "php a\nphp b", source: "cron.php" }))).toEqual([
      "cronJobs.0.command",
    ]);
    expect(paths({ webRoot: "../public" })).toEqual(["webRoot"]);
    expect(paths({ files: { dir: "/var/data" } })).toEqual(["files.dir"]);
    expect(paths({ files: { dir: "storage", extra: true } })).toEqual(["files"]);
  });
});

describe("DeployPlan of a plain PHP app", () => {
  const withBuild = (plan: object & { app: object }, value: object) => ({
    ...plan,
    app: { ...plan.app, build: value },
  });

  it("keeps the web root only with Railpack and PHP", async () => {
    const plan = await validPlan();
    expect(DeployPlanSchema.parse(withBuild(plan, build)).app.build?.webRoot).toBe("public");
    for (const builder of ["generated-dockerfile", "own-dockerfile", "buildpacks"]) {
      const result = DeployPlanSchema.safeParse(withBuild(plan, { ...build, builder }));
      expect(pathsOf(result), builder).toEqual(["app.build.webRoot"]);
    }
    const node = { ...build, runtime: { language: "node", version: "24" }, probe: "node" };
    expect(pathsOf(DeployPlanSchema.safeParse(withBuild(plan, node)))).toEqual([
      "app.build.webRoot",
    ]);
    const outside = DeployPlanSchema.safeParse(withBuild(plan, { ...build, webRoot: "../x" }));
    expect(pathsOf(outside)).toEqual(["app.build.webRoot"]);
  });

  it("keeps a folder across deploys with the rolling strategy", async () => {
    const plan = await validPlan();
    const parsed = DeployPlanSchema.parse({ ...plan, storage: { files: { dir: "storage" } } });
    expect(parsed.storage).toEqual({ files: { dir: "storage" } });
    expect(parsed.deploy.strategy).toBe("rolling");
  });

  it("refuses the app's own folder and a folder shared with SQLite's", async () => {
    const plan = await validPlan();
    const paths = (storage: object) =>
      pathsOf(DeployPlanSchema.safeParse({ ...plan, storage, deploy: { strategy: "recreate" } }));
    for (const dir of [".", "./"]) {
      expect(paths({ files: { dir } }), dir).toEqual(["storage.files.dir"]);
    }
    for (const [files, sqlite] of [
      ["storage", "storage"],
      ["storage/", "./storage"],
      ["storage", "storage/db"],
      ["data/files", "data"],
    ]) {
      expect(paths({ files: { dir: files }, sqlite: { dir: sqlite } }), files).toEqual([
        "storage.files.dir",
      ]);
    }
    const apart = { files: { dir: "storage" }, sqlite: { dir: "storage-db" } };
    expect(
      DeployPlanSchema.safeParse({ ...plan, storage: apart, deploy: { strategy: "recreate" } })
        .success,
    ).toBe(true);
  });

  it("snapshots the kept folder as data", async () => {
    const plan = await validPlan();
    const bare = { ...plan, services: [], deploy: { snapshots: true } };
    expect(snapshotsOn(DeployPlanSchema.parse(bare))).toBe(false);
    const kept = DeployPlanSchema.parse({ ...bare, storage: { files: { dir: "storage" } } });
    expect(snapshotsOn(kept)).toBe(true);
  });
});
