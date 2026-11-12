// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { IMAGES } from "../pins";
import { NPM_SITE } from "../serverless/__fixtures__/plans";
import { inEnvironment, ofApp, serverPlan } from "../workflow/__fixtures__/plans";
import { RELEASE_SIGNING_KEY_SECRET, releaseBranch, renderHostingWorkflow } from "./index";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  "timeout-minutes"?: number;
};
type Job = {
  name: string;
  needs?: string;
  if?: string;
  environment?: string;
  permissions: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

/** A hosting target's fields besides the provider, the panel and the web root. */
type Target = Record<string, unknown>;
type Environment = Parameters<typeof inEnvironment>[1];

const PHP: Target = { app: "php", php: { version: "8.3", via: "multiphp" } };
const STATIC: Target = { app: "static", webRoot: ".", site: NPM_SITE };
const NODE: Target = {
  app: "node",
  runtime: { interpreter: "nodejs", version: "22", startup: "server.js" },
};
const PYTHON: Target = {
  app: "python",
  runtime: { interpreter: "python", version: "3.12", startup: "passenger_wsgi.py" },
};
const STAGING_ENV: Environment = { name: "staging", secrets: "environment" };

/** The test plan with `target` on a cPanel account, as `environment`'s plan (staging's by default). */
function planFor(target: Target, environment: Environment = STAGING_ENV): DeployPlan {
  const base = serverPlan();
  const plan = DeployPlanSchema.parse({
    ...base,
    target: { provider: "hosting", panel: "cpanel", webRoot: "public", ...target },
    services: [],
    externalServices: [],
    dns: { provider: "none", domain: "shop.example.com", proxied: false, www: false },
    security: { ...base.security, httpAllowedFrom: "any" },
  });
  return inEnvironment(plan, environment);
}

const render = (target: Target, environment?: Environment) =>
  renderHostingWorkflow(planFor(target, environment));
const doc = (target: Target, environment?: Environment) =>
  parse(render(target, environment).content) as Workflow;

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
}

describe("renderHostingWorkflow", () => {
  it("renders the environment's deploy workflow per kind of app", () => {
    for (const [kind, target] of [
      ["php", PHP],
      ["static", STATIC],
      ["node", NODE],
    ] as const) {
      const file = render(target);
      expect(file.path).toBe(".github/workflows/opscrew-deploy-staging.yml");
      expect(file.kind).toBe("workflow");
      expect(file.content).toMatchSnapshot(kind);
    }
  });

  it("deploys on each push to the deploy branch and by hand, publishing unless paused", () => {
    const flow = doc(PHP);
    expect(flow.name).toBe("OpsCrew deploy (staging)");
    expect(Object.keys(flow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(flow.on.push).toMatchObject({ branches: ["main"] });
    expect(flow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(flow.jobs)).toEqual(["paused", "build", "publish", "wait"]);
    expect(flow.jobs.publish?.if).toBe(
      "${{ !contains(vars.OPSCREW_DEPLOY_PAUSED, '\"shop/staging\"') }}",
    );
    expect(flow.jobs.paused?.if).toBe(
      "${{ contains(vars.OPSCREW_DEPLOY_PAUSED, '\"shop/staging\"') }}",
    );
  });

  it("runs build, publish and wait in order, with contents: write only on publish", () => {
    const { jobs } = doc(PHP);
    expect(jobs.build?.needs).toBeUndefined();
    expect(jobs.publish?.needs).toBe("build");
    expect(jobs.wait?.needs).toBe("publish");
    expect(jobs.build?.permissions).toEqual({ contents: "read" });
    expect(jobs.publish?.permissions).toEqual({ contents: "write" });
    expect(jobs.wait?.permissions).toEqual({});
    expect(jobs.paused?.permissions).toEqual({});
    expect(jobs.publish?.environment).toBe("staging");
    for (const id of ["paused", "build", "wait"]) expect(jobs[id]?.environment).toBeUndefined();
    const publish = step(jobs.publish, "Sign the release and push it");
    expect(publish.env).toMatchObject({
      ENVIRONMENT: "staging",
      BRANCH: "opscrew/release/staging",
      SIGNING_KEY: "${{ secrets.OPSCREW_STAGING_RELEASE_SIGNING_KEY }}",
    });
    expect(releaseBranch(planFor(PHP))).toBe("opscrew/release/staging");
    // The key reaches only the publish job.
    for (const id of ["paused", "build", "wait"]) {
      expect(JSON.stringify(jobs[id])).not.toContain("SIGNING_KEY");
    }
  });

  it("uses the first app's prod's secret name and GitHub environment", () => {
    const { jobs } = doc(PHP, {});
    expect(jobs.publish?.environment).toBe("production");
    expect(step(jobs.publish, "Sign the release and push it").env?.SIGNING_KEY).toBe(
      `\${{ secrets.${RELEASE_SIGNING_KEY_SECRET} }}`,
    );
    expect(releaseBranch(serverPlan())).toBe("opscrew/release/prod");
  });

  it("pins every action by its commit", () => {
    for (const target of [PHP, STATIC, NODE]) {
      const uses = render(target)
        .content.split("\n")
        .filter((line) => line.includes("uses:"));
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) expect(line).toMatch(/uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\S+$/);
    }
  });

  it("builds a PHP app with Composer in the pinned image of its version, ignoring ext-* only", () => {
    const composer = step(
      doc(PHP).jobs.build,
      "Install the app's PHP packages with Composer in PHP 8.3",
    );
    expect(composer.env).toEqual({
      PHP_IMAGE: IMAGES.php83Cli.ref,
      COMPOSER_IMAGE: IMAGES.composer.ref,
    });
    expect(composer.run).toContain(
      'composer install --no-dev --optimize-autoloader --no-interaction --no-progress --ignore-platform-req="ext-*"',
    );
  });

  it("refuses a PHP version OpsCrew has no image of, naming the ones it builds for", () => {
    expect(() => render({ app: "php", php: { version: "7.3", via: "account" } })).toThrow(
      "OpsCrew builds PHP apps for a hosting account with PHP 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5; the plan's PHP version is 7.3.",
    );
    expect(() => render({ app: "php" })).toThrow("the plan's PHP version is not set");
  });

  it("refuses a promoted environment, an SFTP host and any other target", () => {
    expect(() =>
      render(PHP, { name: "prod2", deploySource: { from: "promote", source: "staging" } }),
    ).toThrow("cannot be promoted");
    expect(() =>
      render({ ...PHP, panel: "sftp", php: { version: "8.3", via: "account" } }),
    ).toThrow("only applies to an app on a hosting account with a panel");
    expect(() => renderHostingWorkflow(serverPlan())).toThrow(
      "only applies to an app on a hosting account with a panel",
    );
  });

  it("publishes a Python app's source as it is, with no build", () => {
    const build = doc(PYTHON).jobs.build;
    expect(build?.steps.map((s) => s.name ?? s.uses?.split("@")[0])).toEqual([
      "actions/checkout",
      "Keep the release",
      "actions/upload-artifact",
    ]);
    expect(step(build, "Keep the release").run).toContain("-C '.' --exclude=.git");
  });

  it("names a further app's release branch after its key", () => {
    const docs = ofApp(planFor(PHP), "docs");
    expect(releaseBranch(docs)).toBe("opscrew/release/docs-staging");
    expect(releaseBranch(ofApp(serverPlan(), "docs"))).toBe("opscrew/release/docs-prod");
    const publish = (parse(renderHostingWorkflow(docs).content) as Workflow).jobs.publish;
    expect(publish?.name).toBe("Publish the release on opscrew/release/docs-staging");
    expect(step(publish, "Sign the release and push it").env?.BRANCH).toBe(
      "opscrew/release/docs-staging",
    );
  });

  it("publishes a static site's output and gives its build no app values", () => {
    const flow = render(STATIC, { name: "staging" });
    expect(flow.content).toContain("-C 'dist' --exclude=.git");
    expect(flow.content).not.toContain("secrets.OPSCREW_STAGING_ENV_");
  });

  it("waits about 10 minutes for the release publish made, failing with what to run", () => {
    const { jobs } = doc(PHP);
    const publish = step(jobs.publish, "Sign the release and push it");
    expect(publish.id).toBe("publish");
    expect(jobs.publish?.outputs).toEqual({ release: "${{ steps.publish.outputs.release }}" });
    expect(publish.run).toContain(
      'echo "release=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"',
    );
    const wait = step(jobs.wait, "Wait for the account to switch to the release");
    // The publish job's, so a re-run of the failed wait job waits for the same release.
    expect(wait.env).toEqual({
      URL: "https://staging-shop.example.com/",
      RELEASE: "${{ needs.publish.outputs.release }}",
    });
    expect(wait["timeout-minutes"]).toBe(12);
    expect(wait.run).toContain("for attempt in $(seq 1 40); do");
    expect(wait.run).toContain("curl -sS --max-time 5 ");
    expect(wait.run).toContain(
      "The account didn't switch to this release: run \\`opscrew status --env staging\\` to see why.",
    );
  });
});

// The bash runs below start Git Bash on Windows, which can be slow on a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

/** Which of the tools the scripts need are missing. */
const missing = ["bash", "git", "openssl", "tar"].filter((tool) => {
  try {
    return spawnSync(tool, ["--version"], { encoding: "utf8" }).status !== 0;
  } catch {
    return true;
  }
});
const skipped = missing.length > 0;
if (skipped) {
  console.warn(`The hosting workflow's script tests are skipped: ${missing.join(", ")} not found.`);
}

const slashed = (path: string) => path.replaceAll("\\", "/");
/** `path` as bash takes it on every platform: Git Bash's tar reads `D:` as a remote host. */
const inBash = (path: string) =>
  path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
const work = slashed(mkdtempSync(join(tmpdir(), "opscrew-hosting-workflow-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function bash(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function git(args: string[], gitDir: string): string {
  const result = spawnSync("git", [`--git-dir=${gitDir}`, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe.skipIf(skipped)("the build's and publish's scripts (bash, git, openssl, tar)", () => {
  const flow = doc(PHP);
  const keep = step(flow.jobs.build, "Keep the release").run ?? "";
  const publish = step(flow.jobs.publish, "Sign the release and push it");
  const remote = `${work}/github/example-org/example-app.git`;
  mkdirSync(remote, { recursive: true });
  spawnSync("git", ["init", "-q", "--bare", remote]);
  // A throwaway ECDSA P-256 key, as `opscrew provision` makes, and its public half.
  spawnSync("openssl", [
    "ecparam",
    "-name",
    "prime256v1",
    "-genkey",
    "-noout",
    "-out",
    `${work}/key.pem`,
  ]);
  spawnSync("openssl", ["ec", "-in", `${work}/key.pem`, "-pubout", "-out", `${work}/release.pub`]);

  /**
   * The app as the build left it: its .gitignore ignores vendor/ and dist/, which it built, and its
   * .gitattributes would turn CRLF into LF.
   */
  const app = `${work}/app`;
  write(app, {
    ".gitignore": "vendor/\ndist/\n.env\n",
    ".gitattributes": "* text=auto\n",
    "windows.txt": "one\r\ntwo\r\n",
    "composer.json": '{"require":{"php":">=8.3","ext-pdo_mysql":"*"}}\n',
    "public/index.php": "<?php require __DIR__ . '/../vendor/autoload.php';\n",
    "vendor/autoload.php": "<?php // Composer's autoloader\n",
    "vendor/acme/lib/.git/HEAD": "ref: refs/heads/main\n",
    "vendor/acme/lib/src/Lib.php": "<?php\n",
    "dist/app.js": "console.log(1);\n",
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
    ".github/workflows/ci.yml": "on: push\n",
    "opscrew/plan.yaml": "version: 1\n",
    ".git/HEAD": "ref: refs/heads/main\n",
  });

  function publishRun(runId: string, attempt: string, signingKey: string) {
    const runner = `${work}/runner-${runId}-${attempt}`;
    mkdirSync(`${runner}/tmp`, { recursive: true });
    writeFileSync(`${runner}/output`, "");
    const kept = bash(keep, app, { RUNNER_TEMP: inBash(runner) });
    expect(kept.status, kept.stderr).toBe(0);
    return bash(publish.run ?? "", runner, {
      ...publish.env,
      RUNNER_TEMP: inBash(runner),
      TMPDIR: inBash(`${runner}/tmp`),
      GITHUB_OUTPUT: inBash(`${runner}/output`),
      SIGNING_KEY: signingKey,
      TOKEN: "test-token",
      GITHUB_SERVER_URL: `file:///${work.replace(/^\//, "")}/github`,
      GITHUB_REPOSITORY: "example-org/example-app",
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: attempt,
      GITHUB_SHA: "f".repeat(40),
    });
  }

  /** Checks the release commit's trailer with `openssl dgst -sha256 -verify` and the public key. */
  function verify(commit: string, runId: string, attempt: string): boolean {
    const tree = git(["rev-parse", `${commit}^{tree}`], remote).trim();
    const body = git(["log", "-1", "--format=%B", commit], remote);
    const trailer = /^OpsCrew-Release: (\S+) (\S+) (\S+) (\S+)$/m.exec(body);
    expect(trailer?.slice(1, 4)).toEqual([runId, attempt, "staging"]);
    writeFileSync(`${work}/message`, `${tree} ${runId} ${attempt} staging`);
    writeFileSync(`${work}/signature`, Buffer.from(trailer?.[4] ?? "", "base64"));
    return (
      spawnSync("openssl", [
        "dgst",
        "-sha256",
        "-verify",
        `${work}/release.pub`,
        "-signature",
        `${work}/signature`,
        `${work}/message`,
      ]).status === 0
    );
  }

  it("publishes the built tree as a signed orphan commit, ignored files included", () => {
    const result = publishRun("1001", "1", readFileSync(`${work}/key.pem`, "utf8"));
    expect(result.status, result.stderr).toBe(0);
    const commit = git(["rev-parse", "refs/heads/opscrew/release/staging"], remote).trim();
    expect(git(["log", "-1", "--format=%P", commit], remote).trim()).toBe("");
    const files = git(["ls-tree", "-r", "--name-only", commit], remote).trim().split("\n");
    expect(files.sort()).toEqual(
      [
        ".gitattributes",
        ".gitignore",
        "composer.json",
        "dist/app.js",
        "public/index.php",
        "vendor/acme/lib/src/Lib.php",
        "vendor/autoload.php",
        "windows.txt",
      ].sort(),
    );
    // Byte for byte, whatever the app's .gitattributes says.
    expect(git(["show", `${commit}:windows.txt`], remote)).toBe("one\r\ntwo\r\n");
    expect(readFileSync(`${work}/runner-1001-1/output`, "utf8")).toBe("release=1001-1\n");
    expect(verify(commit, "1001", "1")).toBe(true);
    // The signature binds the tree: another tree's message does not verify.
    writeFileSync(`${work}/message`, `${"0".repeat(40)} 1001 1 staging`);
    expect(
      spawnSync("openssl", [
        "dgst",
        "-sha256",
        "-verify",
        `${work}/release.pub`,
        "-signature",
        `${work}/signature`,
        `${work}/message`,
      ]).status,
    ).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("BEGIN EC PRIVATE KEY");
  });

  it("replaces the previous release after a shallow fetch of it, and removes the key file", () => {
    write(app, { "dist/app.js": "console.log(2);\n" });
    const result = publishRun("1002", "2", readFileSync(`${work}/key.pem`, "utf8"));
    expect(result.status, result.stderr).toBe(0);
    const commit = git(["rev-parse", "refs/heads/opscrew/release/staging"], remote).trim();
    expect(git(["log", "-1", "--format=%P", commit], remote).trim()).toBe("");
    expect(git(["show", `${commit}:dist/app.js`], remote)).toBe("console.log(2);\n");
    expect(verify(commit, "1002", "2")).toBe(true);
    // The fetched previous release is in the runner's repository.
    const local = `${work}/runner-1002-2/release.git`;
    expect(git(["rev-parse", "refs/remotes/origin/release"], local).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
    // mktemp made the key file in TMPDIR, and it is gone.
    expect(readdirSync(`${work}/runner-1002-2/tmp`)).toEqual([]);
  });

  it("stops before anything is pushed when the environment has no signing key", () => {
    const before = git(["rev-parse", "refs/heads/opscrew/release/staging"], remote).trim();
    const result = publishRun("1003", "1", "");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "::error::The deploy environment has no release signing key (OPSCREW_STAGING_RELEASE_SIGNING_KEY): run `opscrew provision --env staging`, which sets it.",
    );
    expect(git(["rev-parse", "refs/heads/opscrew/release/staging"], remote).trim()).toBe(before);
  });

  it("waits until the hostname answers with the published release", () => {
    const wait = step(flow.jobs.wait, "Wait for the account to switch to the release");
    // curl answers with the release the account serves, and counts its calls; sleep returns at once.
    const fakes = [
      'curl() { echo x >> "$CALLS"; printf "HTTP/2 200\\r\\nX-OpsCrew-Release: %s\\r\\n\\r\\n" "$SERVED"; }',
      "sleep() { :; }",
    ].join("\n");
    const run = (served: string) => {
      writeFileSync(`${work}/calls`, "");
      const result = bash(`${fakes}\n${wait.run}`, work, {
        ...wait.env,
        RELEASE: "1001-1",
        SERVED: served,
        CALLS: `${work}/calls`,
      });
      return { ...result, calls: readFileSync(`${work}/calls`, "utf8").length / 2 };
    };
    const served = run("1001-1");
    expect(served.status, served.stderr).toBe(0);
    expect(served.stdout).toContain("The account serves release 1001-1.");
    expect(served.calls).toBe(1);
    const old = run("1000-1");
    expect(old.status).toBe(1);
    expect(old.calls).toBe(40);
    expect(old.stdout).toContain(
      "::error::The account didn't switch to this release: run `opscrew status --env staging` to see why.",
    );
  });
});

/** Why the Docker run below is skipped, or undefined when it runs. */
const dockerSkip =
  process.env.OPSCREW_DOCKER_TESTS !== "1"
    ? "set OPSCREW_DOCKER_TESTS=1 to run it"
    : missing.includes("bash")
      ? "bash not found"
      : undefined;

describe.skipIf(dockerSkip !== undefined)(
  `Composer's install of a php-plain-mysql-shaped app in the PHP image (OPSCREW_DOCKER_TESTS=1${dockerSkip === undefined ? "" : `: ${dockerSkip}`})`,
  { timeout: 600_000 },
  () => {
    /** Runs the Composer step for PHP `version` in a fresh copy of the app; returns its result. */
    function install(version: string) {
      const composer = step(
        doc({ app: "php", php: { version, via: "multiphp" } }).jobs.build,
        `Install the app's PHP packages with Composer in PHP ${version}`,
      );
      const dir = `${work}/composer-${version}`;
      write(dir, {
        // examples/php-plain-mysql's requirements: a PHP version and an extension the image lacks.
        "composer.json": '{"require":{"php":">=8.3","ext-pdo_mysql":"*"}}\n',
        "public/index.php": "<?php\n",
      });
      mkdirSync(`${dir}/runner`);
      const result = bash(composer.run ?? "", dir, {
        ...composer.env,
        RUNNER_TEMP: `${dir}/runner`,
        MSYS_NO_PATHCONV: "1",
      });
      return { result, dir };
    }

    it("passes the platform check without the extension, on the version the app needs", () => {
      const { result, dir } = install("8.3");
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(`${dir}/vendor/autoload.php`)).toBe(true);
    });

    it("still checks the PHP version", () => {
      const { result } = install("8.2");
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/requires php >=8\.3/);
    });
  },
);
