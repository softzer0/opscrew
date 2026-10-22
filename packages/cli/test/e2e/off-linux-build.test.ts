/**
 * The off-Linux build path (T1517c) at script level, on a computer that is not Linux (the macOS CI
 * job with Colima, and this Windows computer by hand): `examples/go-api` is designed for this
 * computer through the real CLI in-process (`analyze --no-ai` → `interview --answers` → `design`),
 * as an environment whose local runner builds the image (`runner: local`, `build: runner`). From the
 * deploy workflow OpsCrew renders for it, the "Install pack" step runs with bash as GitHub Actions
 * runs a step, in a runner's work folder (`RUNNER_OS`, `RUNNER_TEMP`, `GITHUB_PATH`): it downloads
 * the pinned Linux pack, checks it and puts the wrapper in `$RUNNER_TEMP/bin`. Then that `pack`, the
 * wrapper running the Linux pack in the pinned Linux image with Docker's socket, builds the example
 * with the workflow's builder, run image and settings into this computer's Docker. No GitHub runner
 * is registered.
 *
 * It downloads pack and pulls the builder, so it runs only with OPSCREW_DOCKER_TESTS=1 and a
 * running daemon, and on Linux it skips (the runner installs the Linux pack itself there).
 * Afterwards it removes the image it built, pack's cache volumes for it, the images it pulled
 * (never one Docker already had) and its temp folder.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inEnvironment } from "../../src/ui/__fixtures__/environments";
import {
  EXAMPLES_DIR,
  GIT,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import { buildSteps, workflowBuild } from "./builders";
import {
  docker,
  dockerSkipReason,
  imageIds,
  removeNewImages,
  TEN_MINUTES,
  tail,
} from "./docker-support";
import { BASE_ANSWERS, readPlan } from "./support";

const EXAMPLE = "go-api";

/** bash as GitHub Actions runs a step: Git for Windows' on Windows (next to git), else on PATH. */
function bash(): string | undefined {
  if (process.platform !== "win32") return "bash";
  if (GIT === undefined) return undefined;
  for (const up of [[".."], ["..", ".."]]) {
    const found = path.join(path.dirname(GIT), ...up, "bin", "bash.exe");
    if (existsSync(found)) return found;
  }
  return undefined;
}
const BASH = bash();

const SKIP =
  dockerSkipReason() ??
  (process.platform === "linux"
    ? "on Linux the runner installs the Linux pack itself; the wrapper is for Windows and macOS"
    : GIT === undefined || BASH === undefined
      ? "git and Git for Windows' bash are needed"
      : undefined);
if (SKIP !== undefined) console.warn(`Skipping the off-Linux build path: ${SKIP}.`);

/** `RUNNER_OS` as GitHub Actions names this computer's OS. */
const RUNNER_OS = process.platform === "win32" ? "Windows" : "macOS";

describe.skipIf(SKIP !== undefined)("a Buildpacks build on the local runner off Linux", () => {
  let project: TempProject;
  let plan: DeployPlan;
  let images: Set<string>;
  /** The runner's work folder: the checkout and `$RUNNER_TEMP` are under it. */
  let work: string;
  const tag = `opscrew-test/off-linux-${randomBytes(4).toString("hex")}:build`;
  const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });

  /** Runs `script` with bash in `cwd` as a workflow step, with the runner's variables. */
  async function step(what: string, script: string, cwd: string, env: Record<string, string>) {
    const file = path.join(work, `${what.replace(/\W+/g, "-")}.sh`);
    await writeFile(file, script);
    const started = Date.now();
    const result = await runner.run(
      BASH ?? "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", file],
      { cwd, env: { ...process.env, ...env }, timeoutMs: TEN_MINUTES },
    );
    console.info(`[off-Linux build] ${what}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `${what} failed (exit ${result.exitCode}):\n${tail(`${result.stdout}\n${result.stderr}`)}`,
      );
    }
    return result.stdout;
  }

  beforeAll(async () => {
    images = await imageIds();
    project = await tempProject();
    work = path.join(project.dir, "runner", "_work");
    await mkdir(path.join(work, "_temp"), { recursive: true });
    const root = path.join(work, EXAMPLE, EXAMPLE);
    await materializeFixture(path.join(EXAMPLES_DIR, EXAMPLE), root);
    const local = { ...project, root };
    const answersFile = path.join(project.dir, "answers.yaml");
    await writeFile(answersFile, `${JSON.stringify({ ...BASE_ANSWERS, provider: "localhost" })}\n`);
    for (const args of [
      ["analyze", "--no-ai"],
      ["interview", "--answers", answersFile],
      ["design"],
    ]) {
      const ctx = projectContext(local);
      const code = await run(ctx, ...args);
      if (code !== 0)
        throw new Error(`opscrew ${args.join(" ")} failed:\n${tail(ctx.output + ctx.errors)}`);
    }
    const prod = await readPlan(root);
    plan = DeployPlanSchema.parse(inEnvironment(prod, "dev", { runner: "local", build: "runner" }));
  }, TEN_MINUTES);

  afterAll(async () => {
    if (project === undefined) return;
    await docker(["image", "rm", "-f", tag]);
    const prefix = `pack-cache-${tag.replace(/[/:]/g, "_")}-`;
    const volumes = (await docker(["volume", "ls", "-q", "--filter", `name=${prefix}`])).stdout
      .split(/\s+/)
      .filter((name) => name.startsWith(prefix));
    if (volumes.length > 0) await docker(["volume", "rm", "-f", ...volumes]);
    const lifecycle = await docker([
      "image",
      "ls",
      "--format",
      "{{.ID}}",
      "buildpacksio/lifecycle",
    ]);
    await removeNewImages(images, [
      IMAGES.linuxTools.ref,
      IMAGES.paketoBuilder.ref,
      IMAGES.paketoRun.ref,
      ...lifecycle.stdout.split(/\s+/).filter((id) => id !== ""),
    ]);
    await project.cleanup();
  }, TEN_MINUTES);

  it(
    "installs the Linux pack behind the wrapper, and builds the example with it through Docker",
    async () => {
      expect(plan.app.build?.builder).toBe("buildpacks");
      const ctx = {
        opscrewVersion: "0.0.0-test",
        github: { owner: "opscrew-test", repo: EXAMPLE },
        deploySshPublicKey: "",
        localhost: { hostname: `${EXAMPLE}.localhost` },
      };
      const install = buildSteps(plan, ctx).find((s) => s.name?.startsWith("Install pack"));
      if (install?.run === undefined) throw new Error("The build job has no Install pack step.");
      const temp = path.join(work, "_temp");
      const githubPath = path.join(work, "github-path");
      await writeFile(githubPath, "");
      const runnerEnv = { RUNNER_OS, RUNNER_TEMP: temp, GITHUB_PATH: githubPath };
      const checkout = path.join(work, EXAMPLE, EXAMPLE);
      await step("Install pack", install.run, checkout, runnerEnv);

      expect(await readFile(githubPath, "utf8")).toBe(`${temp}/bin\n`);
      const wrapper = await readFile(path.join(temp, "bin", "pack"), "utf8");
      expect(wrapper).toContain(IMAGES.linuxTools.ref);

      // The next step, with GITHUB_PATH's folders first on PATH as the runner puts them there.
      const build = workflowBuild(plan, ctx);
      if (build.builder !== "buildpacks") throw new Error("not a Buildpacks build");
      const args = [tag, "--path", ".", ...build.packOptions].map((a) => `'${a}'`).join(" ");
      const output = await step(
        "pack build",
        [
          "while IFS= read -r dir; do",
          '  if [[ "$RUNNER_OS" == Windows ]]; then dir="$(cygpath -u "$dir")"; fi',
          '  PATH="$dir:$PATH"',
          'done < "$GITHUB_PATH"',
          `[[ "$(command -v pack)" == */bin/pack ]]`,
          `pack build ${args}`,
        ].join("\n"),
        checkout,
        runnerEnv,
      );
      expect(output).toContain(`Successfully built image '${tag}'`);
      const inspected = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Os}}/{{.Architecture}}",
        tag,
      ]);
      expect(inspected.stdout.trim()).toBe(
        `linux/${plan.target.provider === "localhost" ? plan.target.arch : ""}`,
      );
    },
    TEN_MINUTES * 2,
  );
});
