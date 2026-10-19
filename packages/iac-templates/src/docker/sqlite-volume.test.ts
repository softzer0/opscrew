import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan, ImageBuilder, ProjectFacts } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { withBuild, withSqlite } from "../workflow/__fixtures__/plans";
import { renderWorkflow, sqliteFolder } from "../workflow/index";
import { renderDockerAssets } from "./index";

/*
 * Checks that the app's user can write to a fresh `sqlite` volume, and again after a redeploy, in
 * the image of each builder: a `docker run` mounts a new named volume at the database's folder, as
 * Compose does, and writes a file there as the image's user. The generated Dockerfile is built as
 * OpsCrew renders it. The Buildpacks, Railpack and own-Dockerfile images are sealed with the seal
 * Dockerfile the workflow writes, on a base laid out as their builder leaves it: Buildpacks the
 * pinned Paketo run image with the app's files owned by the build user (1001:1001), running as the
 * run image's user; Railpack a Debian image with the app's files in a root-owned /app, running as
 * root; an own Dockerfile running as its own user. It pulls base images, so it runs only with
 * OPSCREW_DOCKER_TESTS=1, and removes the images and volumes it created.
 */

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (info.status !== 0 || info.stdout.trim() !== "linux") {
    return "no Docker engine for Linux containers is running";
  }
  const bash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return bash.stdout?.trim() === "ok" ? undefined : "bash is not available";
}

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping the SQLite volume check: ${reason}`);

const id = `opscrew-sqlite-test-${randomBytes(4).toString("hex")}`;
const images: string[] = [];
const volumes: string[] = [];

function docker(args: string[], cwd?: string): string {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

/** A new folder with `files`, for a build context. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "opscrew-sqlite-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Builds `dockerfile` in a context with `files` as the image `<id>-<name>`. */
function build(name: string, dockerfile: string, files: Record<string, string> = {}): string {
  const tag = `${id}-${name}`;
  const dir = folder({ ...files, Dockerfile: dockerfile });
  try {
    docker(["build", "--quiet", "--tag", tag, "."], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  images.push(tag);
  return tag;
}

/** The seal Dockerfile the plan's build job writes, `FROM base`. */
function sealDockerfile(plan: DeployPlan, base: string): string {
  const steps: { name?: string; run?: string }[] = parse(
    renderWorkflow(plan, testContext()).content,
  ).jobs.build.steps;
  const script = steps.find((step) => step.name === "Write the seal Dockerfile")?.run ?? "";
  const work = mkdtempSync(join(tmpdir(), "opscrew-seal-")).replaceAll("\\", "/");
  try {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, BASE: base, RUNNER_TEMP: work },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
    return readFileSync(join(work, "seal", "Dockerfile"), "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Runs `image` twice on one new volume at `path`, as its own user without capabilities (as
 * Compose runs the app), each time writing a file there: the uid that wrote, the volume's owner
 * and the files the second run found.
 */
function writeTwice(image: string, path: string): string[] {
  const volume = `${id}-${images.length}-${volumes.length}`;
  docker(["volume", "create", volume]);
  volumes.push(volume);
  const run = (file: string) =>
    docker([
      "run",
      "--rm",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--volume",
      `${volume}:${path}`,
      "--entrypoint",
      "sh",
      image,
      "-c",
      `touch ${path}/${file} && echo "$(id -u) $(stat -c %u:%g ${path}) $(ls -A ${path} | tr '\\n' ' ')"`,
    ]);
  run("first.sqlite3");
  return run("second.sqlite3").split(" ").filter(Boolean);
}

/** A plan for a Python app built by `builder`, on SQLite in `dir`. */
function planOn(builder: ImageBuilder, dir: string, workdir?: string): DeployPlan {
  return withSqlite(withBuild(testPlan(), builder, { language: "python", version: "3.14" }), {
    dir,
    ...(workdir === undefined ? {} : { workdir }),
  });
}

const APP = { "main.py": "print('ok')\n", "requirements.txt": "", "storage/.keep": "" };

afterAll(() => {
  if (images.length > 0) spawnSync("docker", ["image", "rm", "--force", ...images]);
  if (volumes.length > 0) spawnSync("docker", ["volume", "rm", "--force", ...volumes]);
});

describe.skipIf(reason !== undefined)(
  "the SQLite volume (OPSCREW_DOCKER_TESTS=1)",
  {
    timeout: 600_000,
  },
  () => {
    it("is the app's to write in OpsCrew's generated Dockerfile", () => {
      const plan = planOn("generated-dockerfile", "data");
      const folderInImage = sqliteFolder(plan) ?? "";
      const facts: ProjectFacts = {
        name: "shop",
        languages: ["python"],
        packageManager: "pip",
        frameworks: [],
        appKind: "worker",
        platformExport: { platform: "none", evidence: [] },
        build: {},
        runtimeVersions: {},
        envVars: [],
        services: [],
        docker: {},
        monorepo: false,
        appDir: ".",
        git: {},
      };
      const [dockerfile, dockerignore] = renderDockerAssets(facts, {
        appPort: 8000,
        healthPath: "/",
        app: plan.app,
        sqliteFolder: folderInImage,
      });
      const image = build("generated", dockerfile?.content ?? "", {
        ...APP,
        ".dockerignore": dockerignore?.content ?? "",
      });
      expect(folderInImage).toBe("/app/data");
      expect(writeTwice(image, folderInImage)).toEqual([
        "10001",
        "10001:10001",
        "first.sqlite3",
        "second.sqlite3",
      ]);
    });

    it("is the app's to write in a Railpack image after the seal", () => {
      const plan = planOn("railpack", "storage");
      const base = build(
        "railpack-base",
        [`FROM ${IMAGES.python.ref}`, "WORKDIR /app", "COPY . /app"].join("\n"),
        APP,
      );
      const image = build("railpack", sealDockerfile(plan, base));
      expect(writeTwice(image, "/app/storage")).toEqual([
        "10001",
        "10001:10001",
        ".keep",
        "first.sqlite3",
        "second.sqlite3",
      ]);
    });

    it("is the app's to write in a Buildpacks image after the seal, which keeps the run image's user", () => {
      const plan = planOn("buildpacks", "storage");
      const base = build(
        "buildpacks-base",
        [
          `FROM ${IMAGES.paketoRun.ref}`,
          "COPY --chown=1001:1001 . /workspace/",
          "WORKDIR /workspace",
        ].join("\n"),
        APP,
      );
      const image = build("buildpacks", sealDockerfile(plan, base));
      const user = (ref: string) =>
        docker(["image", "inspect", "--format", "{{.Config.User}}", ref]);
      // The base keeps the run image's user.
      expect(user(image)).toBe(user(base));
      const [uid] = user(image).split(":");
      expect(writeTwice(image, "/workspace/storage")).toEqual([
        uid,
        user(image),
        ".keep",
        "first.sqlite3",
        "second.sqlite3",
      ]);
    });

    it("is the app's to write in an own Dockerfile's image after the seal, which keeps its user", () => {
      const plan = planOn("own-dockerfile", "data", "/srv/app");
      const base = build(
        "own-base",
        [
          `FROM ${IMAGES.python.ref}`,
          "RUN useradd --uid 10002 shop",
          "WORKDIR /srv/app",
          "COPY main.py ./",
          "USER shop",
        ].join("\n"),
        APP,
      );
      const image = build("own", sealDockerfile(plan, base));
      const config = (ref: string) =>
        docker(["image", "inspect", "--format", "{{.Config.User}} {{.Config.WorkingDir}}", ref]);
      expect(config(image)).toBe(config(base));
      expect(writeTwice(image, "/srv/app/data")).toEqual([
        "10002",
        "10002:10002",
        "first.sqlite3",
        "second.sqlite3",
      ]);
    });
  },
);
