import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import { renderDockerAssets } from "@opscrew/iac-templates";
import { afterAll, describe, expect, it } from "vitest";
import { standaloneConfigEdit } from "./next-config";

/**
 * Real `docker build` of `examples/nextjs-postgres` with the Dockerfile OpsCrew generates, once
 * as the example is (no standalone output, the failure of the first real run) and once with the
 * deterministic `output: "standalone"` edit. It pulls the base image and npm packages, so like the
 * other tests that reach the network it runs only on request: OPSCREW_DOCKER_TESTS=1 with a running
 * Docker daemon (skipped otherwise).
 */

const EXAMPLE = fileURLToPath(new URL("../../../../examples/nextjs-postgres/", import.meta.url));
const DOCKER = findExecutable("docker");
const TEN_MINUTES = 600_000;

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  if (DOCKER === undefined) return "docker is not installed";
  const info = spawnSync(DOCKER, ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 30_000,
    stdio: "ignore",
  });
  return info.status === 0 ? undefined : "the Docker daemon is not running (`docker info` failed)";
}

const SKIP = skipReason();
if (SKIP !== undefined) {
  console.warn(`Skipping the Next.js docker build tests: ${SKIP}.`);
}

const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
const images: string[] = [];
const containers: string[] = [];

async function docker(args: string[], timeoutMs = TEN_MINUTES) {
  return runner.run(DOCKER ?? "docker", args, { timeoutMs });
}

/** The example in a temp folder with OpsCrew's Dockerfile and `.dockerignore`. */
async function prepare(variant: string, standalone: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `opscrew-next-docker-${variant}-`));
  await materializeFixture(EXAMPLE, dir);
  const facts = await detectProject(dir);
  for (const file of renderDockerAssets(facts, { appPort: 3000, healthPath: "/" })) {
    if (file.path === "Dockerfile" || file.path === ".dockerignore") {
      await writeFile(join(dir, file.path), file.content);
    }
  }
  const configPath = join(dir, "next.config.mjs");
  const config = await readFile(configPath, "utf8");
  expect(config).not.toContain("standalone");
  if (standalone) {
    const edit = standaloneConfigEdit({ path: "next.config.mjs", content: config });
    if (edit.action !== "write") throw new Error(`expected an edit, got ${JSON.stringify(edit)}`);
    await writeFile(configPath, edit.content);
  }
  return dir;
}

/** Builds the image, starts it and fetches `/` from inside the container. */
async function buildAndServe(variant: string, standalone: boolean): Promise<string> {
  const dir = await prepare(variant, standalone);
  const tag = `opscrew-test/nextjs-${variant}:${Date.now()}`;
  images.push(tag);
  const build = await docker(["build", "--progress=plain", "-t", tag, dir]);
  if (build.exitCode !== 0) {
    throw new Error(`docker build failed:\n${build.stderr.slice(-4000)}`);
  }
  const run = await docker(["run", "-d", tag], 60_000);
  expect(run.exitCode, run.stderr).toBe(0);
  const id = run.stdout.trim();
  containers.push(id);
  const script = await docker(["exec", id, "cat", "/app/opscrew-start.sh"], 30_000);
  const user = await docker(["exec", id, "id", "-un"], 30_000);
  expect(user.stdout.trim()).toBe("node");
  let page = "";
  for (let attempt = 0; attempt < 60 && !page.includes("Hello from Next.js"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const fetched = await docker(["exec", id, "wget", "-qO-", "http://127.0.0.1:3000/"], 30_000);
    page = fetched.stdout;
  }
  if (!page.includes("Hello from Next.js")) {
    const logs = await docker(["logs", id], 30_000);
    throw new Error(`the app did not answer:\n${logs.stdout}\n${logs.stderr}`);
  }
  await rm(dir, { recursive: true, force: true });
  return script.stdout;
}

const TITLE = "Next.js Dockerfile with a real docker build";
describe.skipIf(SKIP !== undefined)(
  SKIP === undefined ? TITLE : `${TITLE} (skipped: ${SKIP})`,
  () => {
    afterAll(async () => {
      for (const id of containers) await docker(["rm", "-f", id], 60_000);
      for (const tag of images) await docker(["rmi", "-f", tag], 60_000);
    }, 120_000);

    it(
      "builds and serves the example without standalone output (next start)",
      async () => {
        const script = await buildAndServe("plain", false);
        expect(script).toContain(" start --hostname ");
        expect(script).not.toContain("server.js");
      },
      TEN_MINUTES,
    );

    it(
      "builds and serves the example with the deterministic standalone edit",
      async () => {
        const script = await buildAndServe("standalone", true);
        expect(script).toContain('exec node "/app/server.js"');
      },
      TEN_MINUTES,
    );
  },
);
