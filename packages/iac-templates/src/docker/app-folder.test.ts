import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMPOSER_IMAGE, docker, hasImage } from "../__fixtures__/docker";
import { testContext, testPlan } from "../__fixtures__/plans";
import { plainPhp, withFiles } from "../workflow/__fixtures__/plans";
import { renderWorkflow } from "../workflow/index";

/*
 * Checks a plain PHP app's sealed Railpack image (FR-1340): as the app's user, uid 10001, a file
 * can be made in the app's folder and a temporary file renamed onto it (an installer's settings
 * file), while the image's own files, root's, can be neither changed, replaced nor removed. The
 * base is laid out as Railpack leaves a PHP app (its files in a root-owned /app, running as root,
 * with a stand-in for FrankenPHP's binary, which the seal copies); it is sealed with the seal
 * Dockerfile the workflow writes. It pulls a PHP image, so it runs only with
 * OPSCREW_DOCKER_TESTS=1, and removes the images it built and the base it pulled.
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
if (reason) console.warn(`[iac-templates] skipping the PHP app folder check: ${reason}`);

const id = `opscrew-app-folder-test-${randomBytes(4).toString("hex")}`;
const images: string[] = [];
const pulled = reason === undefined && !hasImage(COMPOSER_IMAGE);

/** Builds `dockerfile` in a context with `files` as the image `<id>-<name>`. */
function build(name: string, dockerfile: string, files: Record<string, string> = {}): string {
  const tag = `${id}-${name}`;
  const dir = mkdtempSync(join(tmpdir(), "opscrew-app-folder-"));
  try {
    for (const [path, content] of Object.entries({ ...files, Dockerfile: dockerfile })) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    docker(["build", "--quiet", "--tag", tag, "."], { cwd: dir });
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

/** What the app's user tries in the app's folder, one line of outcome each. */
const TRIES = [
  "id -u",
  "stat -c %a /app",
  "printf 'APP_KEY=x\\n' > /app/.env.tmp-x && mv -f /app/.env.tmp-x /app/.env && echo \"made .env, owned by $(stat -c %u /app/.env)\"",
  "if printf x >> /app/composer.json 2> /dev/null; then echo 'changed composer.json'; else echo 'composer.json refused a change'; fi",
  "printf x > /app/.tmp-y && if mv -f /app/.tmp-y /app/composer.json 2> /dev/null; then echo 'replaced composer.json'; else echo 'composer.json refused a replacement'; fi",
  "if rm -f /app/composer.json 2> /dev/null && [ ! -e /app/composer.json ]; then echo 'removed composer.json'; else echo 'composer.json refused its removal'; fi",
  "if touch /app/public/new.php 2> /dev/null; then echo 'wrote in public'; else echo 'public refused a new file'; fi",
  "touch /app/storage/kept && echo 'wrote in storage'",
].join("\n");

afterAll(() => {
  if (images.length > 0) spawnSync("docker", ["image", "rm", "--force", ...images]);
  if (pulled) spawnSync("docker", ["image", "rm", COMPOSER_IMAGE], { stdio: "ignore" });
});

describe.skipIf(reason !== undefined)(
  "a plain PHP app's folder in its sealed Railpack image (OPSCREW_DOCKER_TESTS=1)",
  { timeout: 600_000 },
  () => {
    it("takes new files from uid 10001, while the image's files stay root's", () => {
      const base = build(
        "railpack-base",
        [
          `FROM ${COMPOSER_IMAGE}`,
          "RUN printf '#!/bin/sh\\n' > /usr/local/bin/frankenphp && chmod 755 /usr/local/bin/frankenphp",
          "WORKDIR /app",
          "COPY . /app",
        ].join("\n"),
        {
          "composer.json": '{"require": {"php": ">=8.4"}}\n',
          "public/index.php": "<?php echo 'ok';\n",
          "storage/.keep": "",
        },
      );
      const image = build("railpack", sealDockerfile(withFiles(plainPhp(testPlan())), base));
      const output = docker([
        "run",
        "--rm",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "sh",
        image,
        "-c",
        TRIES,
      ]);
      expect(output.split("\n")).toEqual([
        "10001",
        "1777",
        "made .env, owned by 10001",
        "composer.json refused a change",
        "composer.json refused a replacement",
        "composer.json refused its removal",
        "public refused a new file",
        "wrote in storage",
      ]);
    });
  },
);
