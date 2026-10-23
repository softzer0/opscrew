/**
 * The Docker pass for Cloudflare's hosting (T1613, plan.md "13."): `static-vite`, `angular-static`,
 * `hugo-site` and `astro-ssr` are designed for the target by the real CLI in-process, offline and
 * without a model (`analyze --no-ai` → `interview --answers` → `design`; for `astro-ssr` then
 * `adapt --no-ai --no-push`, which adds `@astrojs/cloudflare` from the npm registry). OpsCrew's
 * generated files (the Wrangler config and, for SSR, the headers wrapper) are rendered into the
 * repository as provision writes them, and the deploy workflow OpsCrew renders runs in containers
 * standing in for GitHub's machines:
 * - the build job, every step as the workflow has it (the site's install and build, Hugo's pinned
 *   download, the limits check, for SSR Wrangler's bundle of the Worker, and the build's SHA-256);
 * - the deploy job's steps before it reaches Cloudflare: the SHA-256 check that puts the site in
 *   place, and the program that writes OpsCrew's headers into `_headers`;
 * - `wrangler dev` in a third container, with the arguments the deploy job's upload has (for SSR,
 *   the bundled Worker with `--no-bundle`) and the committed config.
 *
 * The checks: OpsCrew's headers (HSTS, content type options, frame options, referrer policy) on a
 * page and on the single-page app's fallback or the 404 page; for `astro-ssr`, a server-rendered
 * page with the headers, and a page (`__fixtures__/astro-secret`) showing the SHA-256 of a secret
 * the Worker gets as the deploy gives it (from GitHub secrets, here `.dev.vars` written through
 * stdin), whose value appears in no output, response, built file or generated file.
 *
 * The containers run `node:24-trixie` for linux/amd64 (GitHub's `ubuntu-latest` with setup-node:
 * glibc for workerd and Hugo, bash, curl), as root with a `sudo` that runs its command (the runner
 * user has passwordless sudo). Actions are not run: checkout and the artifact's upload and download
 * are the shared volume, setup-node is the image's Node.js (checked against the workflow's
 * version), and `cloudflare/wrangler-action` is what it does: the pinned Wrangler installed in its
 * working directory, then `npx wrangler <command>`.
 *
 * It pulls an image and packages, so it runs only with OPSCREW_DOCKER_TESTS=1 and a running
 * daemon. Every container and volume carries the label {@link SERVERLESS_LABEL} and is removed by
 * it afterwards; the image is removed when the test pulled it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCommandRunner } from "@opscrew/core";
import { FakeAgentRuntime, fakeSecret } from "@opscrew/core/testing";
import {
  type RenderedFile,
  renderHeadersEntry,
  renderWorkflow,
  renderWranglerConfig,
  siteEnvSecret,
  TOOLS,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GIT, projectContext, run, type TempProject } from "../../src/ui/__fixtures__/harness";
import {
  DOCKER,
  dockerSkipReason,
  imageIds,
  removeNewImages,
  TEN_MINUTES,
  TWO_MINUTES,
  tail,
} from "./docker-support";
import { designedPlan, freePort, until } from "./edge-support";
import { findLeaks, readPlan, ScriptedApprovals } from "./support";

const SKIP = dockerSkipReason() ?? (GIT === undefined ? "git is not installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping the server-less Docker pass: ${SKIP}.`);

/** On every container and volume this file creates, and how it removes them. */
const SERVERLESS_LABEL = "opscrew.test=serverless-pass";

/** GitHub's `ubuntu-latest` with setup-node's Node.js 24; pinned for this test only. */
const RUNNER_IMAGE =
  "node:24-trixie@sha256:016f604a11c4c725f0a4c62e29ff11adab153d297bf97046c9bf2ddb9f1011d3";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

/** The runner's folders in the shared volume: the checkout and `$RUNNER_TEMP`. */
const WORKSPACE = "/work/repo";
const RUNNER_TEMP = "/work/temp";

/** OpsCrew's security headers every response must carry (spec US1 scenario 4). */
const OPSCREW_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
];

/** The app's secret in the SSR example, as the user's GitHub secret holds it. */
const SECRET_NAME = "STRIPE_SECRET_KEY";
const SECRET = fakeSecret("stripe-live-key", "serverless-pass");

const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });

/** `docker <args>`, with `input` on its stdin and `env` added to the docker CLI's environment. */
async function docker(
  args: string[],
  what: string,
  o: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const result = await runner.run(DOCKER ?? "docker", args, {
    timeoutMs: o.timeoutMs ?? TWO_MINUTES,
    ...(o.input === undefined ? {} : { input: o.input }),
    ...(o.env === undefined ? {} : { env: { ...process.env, ...o.env } }),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    const failure = result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`;
    throw new Error(`${what} ${failure}:\n${tail(`${result.stdout}\n${result.stderr}`)}`);
  }
  return `${result.stdout}${result.stderr}`;
}

/** A step of the rendered workflow, as far as the pass runs it. */
interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  outputs?: Record<string, string>;
  steps: Step[];
}

/** What a workflow's `${{ … }}` expressions read in this pass. */
interface Expressions {
  secrets: Record<string, string>;
  steps: Record<string, Record<string, string>>;
  build: Record<string, string>;
}

/** `text` with GitHub's expressions replaced; an expression the pass does not know fails. */
function substitute(text: string, ctx: Expressions): string {
  return text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const value =
      expr === "runner.temp"
        ? RUNNER_TEMP
        : expr === "github.workspace"
          ? WORKSPACE
          : expr === "github.run_id"
            ? "1"
            : expr.startsWith("secrets.")
              ? ctx.secrets[expr.slice("secrets.".length)]
              : expr.startsWith("needs.build.outputs.")
                ? ctx.build[expr.slice("needs.build.outputs.".length)]
                : /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(expr)?.slice(1, 3).join(".");
    if (value === undefined) throw new Error(`The pass has no value for \${{ ${expr} }}.`);
    if (expr.startsWith("steps.")) {
      const [id, key] = value.split(".") as [string, string];
      const output = ctx.steps[id]?.[key];
      if (output === undefined) throw new Error(`No output for \${{ ${expr} }}.`);
      return output;
    }
    return value;
  });
}

/** A container standing in for one job's GitHub machine, with the shared volume at /work. */
class Machine {
  /** Every step's output, by `<job>: <step>`, for the leak search. */
  readonly outputs = new Map<string, string>();
  #steps = 0;

  private constructor(
    readonly name: string,
    private readonly job: string,
  ) {}

  static async start(volume: string, job: string): Promise<Machine> {
    const name = `opscrew-test-serverless-${job}-${randomBytes(4).toString("hex")}`;
    await docker(
      [
        ...["run", "-d", "--platform", "linux/amd64", "--label", SERVERLESS_LABEL, "--name", name],
        ...["-v", `${volume}:/work`, RUNNER_IMAGE, "sleep", "infinity"],
      ],
      `starting the ${job} job's machine`,
      { timeoutMs: TEN_MINUTES },
    );
    await docker(
      [
        ...["exec", "-i", name, "sh", "-c"],
        `mkdir -p ${WORKSPACE} ${RUNNER_TEMP} /work/steps && cat > /usr/local/bin/sudo && chmod 0755 /usr/local/bin/sudo`,
      ],
      `setting up the ${job} job's machine`,
      { input: '#!/bin/sh\nexec "$@"\n' },
    );
    return new Machine(name, job);
  }

  /**
   * Runs `script` as a step: with bash (`bash -e`, GitHub's default) or Node.js, in `cwd`, with
   * GitHub's variables and `env` (their values reach docker through its environment, never its
   * command line). Returns the step's outputs (`$GITHUB_OUTPUT`).
   */
  async exec(
    script: string,
    what: string,
    o: { shell?: "bash" | "node"; env?: Record<string, string>; cwd?: string } = {},
  ): Promise<Record<string, string>> {
    const n = ++this.#steps;
    const file = `/work/steps/${this.job}-${n}`;
    const output = `${RUNNER_TEMP}/output-${this.job}-${n}`;
    await docker(["exec", "-i", this.name, "sh", "-c", `cat > ${file}`], `writing "${what}"`, {
      input: script,
    });
    const env: Record<string, string> = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_WORKSPACE: WORKSPACE,
      GITHUB_RUN_ID: "1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: `${RUNNER_TEMP}/summary`,
      ...o.env,
    };
    const started = Date.now();
    const text = await docker(
      [
        ...["exec", "-w", o.cwd ?? WORKSPACE],
        ...Object.keys(env).flatMap((name) => ["-e", name]),
        ...[this.name, "sh", "-c", `: > ${output} && touch ${RUNNER_TEMP}/summary && exec "$@"`],
        ...["step", ...(o.shell === "node" ? ["node", file] : ["bash", "-e", file])],
      ],
      `"${what}" in the ${this.job} job`,
      { env, timeoutMs: TEN_MINUTES },
    );
    console.info(`[${this.job}] ${what}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    this.outputs.set(`${this.job}: ${what}`, text);
    const written = await docker(["exec", this.name, "cat", output], "reading the step's outputs");
    return Object.fromEntries(
      written
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  }

  /**
   * Runs the job's `steps` as GitHub would, with `ctx` for the expressions; each step's outputs go
   * into `ctx.steps`.
   */
  async runSteps(steps: readonly Step[], ctx: Expressions): Promise<void> {
    for (const step of steps) {
      const what = step.name ?? step.uses ?? step.id ?? "a step";
      const env = Object.fromEntries(
        Object.entries(step.env ?? {}).map(([k, v]) => [k, substitute(String(v), ctx)]),
      );
      const cwd =
        step["working-directory"] === undefined
          ? WORKSPACE
          : path.posix.join(WORKSPACE, step["working-directory"]);
      let outputs: Record<string, string> = {};
      const action = step.uses?.split("@")[0];
      if (action === undefined) {
        if (step.run === undefined) throw new Error(`The step "${what}" has no run and no uses.`);
        const shell = step.shell === "node {0}" ? "node" : "bash";
        if (step.shell !== undefined && shell !== "node") {
          throw new Error(`The pass cannot run the shell ${step.shell}.`);
        }
        outputs = await this.exec(substitute(step.run, ctx), what, { shell, env, cwd });
      } else if (action === "actions/setup-node") {
        const node = await docker(
          ["exec", this.name, "node", "-p", "process.versions.node"],
          "reading the machine's Node.js version",
        );
        expect(node.trim().split(".")[0], "the image's Node.js is the workflow's").toBe(
          String(step.with?.["node-version"]),
        );
      } else if (action === "cloudflare/wrangler-action") {
        const dir = substitute(String(step.with?.workingDirectory), ctx);
        const version = String(step.with?.wranglerVersion);
        expect(version).toBe(TOOLS.wrangler.version);
        outputs = await this.exec(
          [
            "set -euo pipefail",
            `cd "${dir}"`,
            `npm install --no-audit --no-fund --save-dev "wrangler@${version}"`,
            `npx wrangler ${substitute(String(step.with?.command), ctx)}`,
          ].join("\n"),
          what,
          { env: { WRANGLER_SEND_METRICS: "false" } },
        );
      } else if (
        action !== "actions/checkout" &&
        action !== "actions/upload-artifact" &&
        action !== "actions/download-artifact"
      ) {
        // Checkout and the artifact are the shared volume.
        throw new Error(`The pass cannot run ${step.uses}.`);
      }
      if (step.id !== undefined) ctx.steps[step.id] = outputs;
    }
  }
}

/** Writes OpsCrew's generated `files` into the project, as provision does. */
async function writeGenerated(root: string, files: readonly RenderedFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

/** The headers of the `/*` rule in a `_headers` file, by lower-case name. */
function headersRule(text: string): Map<string, string> {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  const rule = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || !/^\s/.test(line)) break;
    const at = line.indexOf(":");
    rule.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return rule;
}

/** A page as a browser navigating to it asks for it. */
async function get(port: number, urlPath: string) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** One example the pass builds and serves. */
interface Case {
  example: string;
  /** What a path that is no file answers: the single-page app, the 404 page, or the Worker. */
  fallback: "spa" | "404" | "ssr";
  /** A folder under `__fixtures__/` copied over the example. */
  overlay?: string;
}

const CASES: Case[] = [
  { example: "static-vite", fallback: "spa" },
  { example: "angular-static", fallback: "spa" },
  { example: "hugo-site", fallback: "404" },
  { example: "astro-ssr", fallback: "ssr", overlay: "astro-secret" },
];

/** The answers that choose Cloudflare's hosting. */
const ANSWERS = {
  provider: "cloudflare-workers",
  domain: "site.example.com",
  dnsProvider: "cloudflare",
  budgetMonthly: "10 EUR",
  dataCriticality: "none",
};

describe.skipIf(SKIP !== undefined)("the server-less Docker pass", () => {
  let images: Set<string>;
  const projects: TempProject[] = [];

  beforeAll(async () => {
    images = await imageIds();
  });

  afterAll(async () => {
    const filter = ["--filter", `label=${SERVERLESS_LABEL}`];
    const containers = (await docker(["ps", "-a", "-q", ...filter], "listing the containers"))
      .split(/\s+/)
      .filter((id) => id !== "");
    if (containers.length > 0) await docker(["rm", "-f", "-v", ...containers], "removing them");
    const volumes = (await docker(["volume", "ls", "-q", ...filter], "listing the volumes"))
      .split(/\s+/)
      .filter((name) => name !== "");
    if (volumes.length > 0) await docker(["volume", "rm", "-f", ...volumes], "removing them");
    if (images !== undefined) await removeNewImages(images, [RUNNER_IMAGE]);
    for (const project of projects) await project.cleanup();
  }, TEN_MINUTES);

  describe.each(CASES)("$example on Cloudflare's hosting", (testCase) => {
    let project: TempProject;
    let plan: DeployPlan;
    let volume: string;
    let workflow: { jobs: { build: Job; deploy: Job } };
    const ctx: Expressions = { secrets: {}, steps: {}, build: {} };
    const machines: Machine[] = [];
    /** The headers OpsCrew's program wrote into the site's `_headers`. */
    let expected: Map<string, string>;

    beforeAll(async () => {
      ({ project, plan } = await designedPlan(testCase.example, ANSWERS, {
        ...(testCase.overlay === undefined
          ? {}
          : { overlay: path.join(FIXTURES, testCase.overlay) }),
      }));
      projects.push(project);
      if (testCase.fallback === "ssr") {
        // adapt adds the Cloudflare adapter at the release the npm registry has for the app's Astro.
        const adapt = projectContext(project, {
          services: {
            runtime: new FakeAgentRuntime(),
            approvalHandler: new ScriptedApprovals(),
            fetch: globalThis.fetch,
          },
        });
        const code = await run(adapt, "adapt", "--no-ai", "--no-push");
        if (code !== 0) throw new Error(`adapt failed:\n${tail(adapt.output + adapt.errors)}`);
        plan = await readPlan(project.root);
        expect(plan.codeChanges.map((change) => [change.id, change.status])).toEqual([
          ["cloudflare-adapter", "applied"],
        ]);
        expect(plan.app.env.map((variable) => variable.name)).toEqual([SECRET_NAME]);
        ctx.secrets[siteEnvSecret(SECRET_NAME)] = SECRET;
      }
      const ssr = plan.target.provider === "cloudflare-workers" && plan.target.render === "ssr";
      expect(ssr).toBe(testCase.fallback === "ssr");
      await writeGenerated(project.root, [
        renderWranglerConfig(plan),
        ...(ssr ? [renderHeadersEntry(plan)] : []),
      ]);
      workflow = parse(
        renderWorkflow(plan, {
          opscrewVersion: "0.0.0-test",
          github: { owner: "acme", repo: testCase.example },
          deploySshPublicKey: "",
        }).content,
      ) as typeof workflow;
      volume = `opscrew-test-serverless-${randomBytes(4).toString("hex")}`;
      await docker(
        ["volume", "create", "--label", SERVERLESS_LABEL, volume],
        "creating the volume",
      );
    }, TEN_MINUTES);

    afterAll(async () => {
      for (const machine of machines) {
        await docker(["rm", "-f", machine.name], `removing ${machine.name}`).catch(() => {});
      }
    }, TWO_MINUTES);

    it(
      "builds with the workflow's build steps",
      async () => {
        const build = await Machine.start(volume, "build");
        machines.push(build);
        // The checkout: the repository with OpsCrew's generated files.
        await docker(["cp", `${project.root}/.`, `${build.name}:${WORKSPACE}`], "the checkout");
        await build.runSteps(workflow.jobs.build.steps, ctx);
        ctx.build = Object.fromEntries(
          Object.entries(workflow.jobs.build.outputs ?? {}).map(([k, v]) => [
            k,
            substitute(v, ctx),
          ]),
        );
        expect(ctx.build.sha256).toMatch(/^[0-9a-f]{64}$/);
      },
      TEN_MINUTES * 2,
    );

    it(
      "serves the site with wrangler dev, with OpsCrew's headers",
      async () => {
        const deploy = await Machine.start(volume, "deploy");
        machines.push(deploy);
        // The deploy job up to Cloudflare: the build put in place, and OpsCrew's headers in _headers.
        const steps = workflow.jobs.deploy.steps;
        const prepare = steps.findIndex((step) => step.name === "Prepare Wrangler");
        expect(prepare).toBeGreaterThan(0);
        await deploy.runSteps(steps.slice(0, prepare), ctx);
        const site = String(steps.find((s) => s.env?.SITE !== undefined)?.env?.SITE);
        expected = headersRule(
          await docker(
            ["exec", deploy.name, "cat", path.posix.join(WORKSPACE, site, "_headers")],
            "reading _headers",
          ),
        );
        expect([...expected.keys()]).toEqual(expect.arrayContaining(OPSCREW_HEADERS));

        // The Worker's secrets, as the upload's --secrets-file gives them, through stdin only.
        const upload = substitute(String(steps.find((s) => s.id === "upload")?.with?.command), ctx);
        const configDir = path.posix.dirname(/--config (\S+)/.exec(upload)?.[1] ?? "");
        if (plan.app.env.length > 0) {
          await docker(
            ["exec", "-i", deploy.name, "sh", "-c", `umask 077 && cat > ${configDir}/.dev.vars`],
            "writing .dev.vars",
            { input: plan.app.env.map((v) => `${v.name}=${SECRET}\n`).join("") },
          );
        }

        // wrangler dev with the upload's arguments (the SSR bundle, `--no-bundle`, the config).
        const args = upload
          .replace(/^versions upload\s*/, "")
          .replace(/--message "[^"]*"\s*/, "")
          .replace(/--secrets-file \S+\s*/, "")
          .trim();
        const port = await freePort();
        const serve = `opscrew-test-serverless-serve-${randomBytes(4).toString("hex")}`;
        const wrangler = `${RUNNER_TEMP}/wrangler`;
        await docker(
          [
            ...["run", "-d", "--platform", "linux/amd64", "--label", SERVERLESS_LABEL],
            ...["--name", serve, "-v", `${volume}:/work`, "-p", `127.0.0.1:${port}:8787`],
            ...["-e", "WRANGLER_SEND_METRICS=false", "-e", "CI=true", RUNNER_IMAGE, "bash", "-c"],
            [
              "set -euo pipefail",
              `mkdir -p ${wrangler} && cd ${wrangler}`,
              `[ -f package.json ] || printf '{"private": true}\\n' > package.json`,
              `npm install --no-audit --no-fund --save-dev "wrangler@${TOOLS.wrangler.version}"`,
              `exec npx wrangler dev ${args} --ip 0.0.0.0 --port 8787`,
            ].join("\n"),
          ],
          "starting wrangler dev",
          { timeoutMs: TEN_MINUTES },
        );
        const logs = () => docker(["logs", serve], "reading wrangler dev's output");
        const texts = new Map<string, string>();
        try {
          const home = await until(
            "wrangler dev's answer",
            async () => {
              const answer = await get(port, "/");
              return answer.status === 200 ? answer : undefined;
            },
            TEN_MINUTES / 2,
            2_000,
          );
          const answers = {
            home,
            missing: await get(port, "/no/such/page"),
            ...(testCase.fallback === "ssr" ? { secret: await get(port, "/secret") } : {}),
          };
          for (const [what, answer] of Object.entries(answers)) {
            texts.set(`the answer to ${what}`, answer.body);
            for (const [name, value] of expected) {
              expect(answer.headers.get(name), `${name} on ${what}`).toBe(value);
            }
          }
          if (testCase.fallback === "spa") {
            expect(answers.missing.status).toBe(200);
            expect(answers.missing.body).toBe(home.body);
          } else if (testCase.fallback === "404") {
            expect(answers.missing.status).toBe(404);
            expect(answers.missing.body).toContain("Page not found");
          } else {
            expect(home.body).toContain("Rendered on the server at");
            expect(answers.missing.status).toBe(404);
            const digest = createHash("sha256").update(SECRET).digest("hex");
            expect(answers.secret?.status).toBe(200);
            expect(answers.secret?.body).toContain(`The secret's SHA-256: ${digest}`);
          }
        } catch (error) {
          console.warn(`wrangler dev's output:\n${tail(await logs(), 30)}`);
          throw error;
        } finally {
          texts.set("wrangler dev's output", await logs());
          await docker(["rm", "-f", serve], "removing wrangler dev's container");
        }

        if (testCase.fallback === "ssr") {
          // The secret is in no output, answer, built file (the artifact) or generated file.
          const artifact = path.join(project.dir, "artifact");
          await docker(
            ["cp", `${deploy.name}:${RUNNER_TEMP}/opscrew-site`, artifact],
            "copying the artifact out",
          );
          for (const machine of machines) {
            for (const [label, text] of machine.outputs) texts.set(label, text);
          }
          const leaks = await findLeaks({
            secrets: [SECRET],
            texts,
            dir: project.dir,
            inputs: new Map(),
          });
          expect(leaks.map((leak) => leak.where)).toEqual([]);
        }
      },
      TEN_MINUTES * 2,
    );
  });
});
