// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import {
  fillPortainerStack,
  portainerImageVersion,
  renderPlaceholderStack,
  renderPortainerStack,
} from "../portainer-target/index";
import { renderWorkflow } from "./index";

/*
 * Runs the generated deploy-job scripts in bash: the deploy branch is written to a real local Git
 * remote (a bare repository), and `curl` and `sleep` are fakes that record their calls.
 */

type Step = { id?: string; name?: string; run?: string };

const ctx = testContext();
const plan = portainerTestPlan({ redeploy: "cloudflare", postgres: true });
const steps = (parse(renderWorkflow(plan, ctx).content).jobs.deploy.steps as Step[]).reduce<
  Record<string, string>
>((all, s) => Object.assign(all, { [s.id ?? s.name ?? ""]: s.run ?? "" }), {});
const template = renderPortainerStack(plan, ctx).content;

const NEW = `ghcr.io/acme/shop@sha256:${"b".repeat(64)}`;
const OLD = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;
const ACCESS_ID = "access-client-id-placeholder";
const ACCESS_SECRET = "access-client-secret-placeholder";
const WEBHOOK = "https://portainer-shop.example.com/api/stacks/webhooks/webhook-id-placeholder";

const FAKES = [
  // curl: `CURL_CODE` (default 204) for the webhook; the health check answers `HEALTH` per call
  // (`down`, or the version it reports), the last one repeating.
  "curl() {",
  '  echo "curl $*" >> "$WORK/curl.log"',
  '  for arg in "$@"; do case "$arg" in @*) cat "${arg#@}" >> "$WORK/headers.log" ;; esac; done',
  '  if [[ " $* " == *" -w %{http_code} "* ]]; then printf \'%s\' "${CURL_CODE:-204}"; return 0; fi',
  '  local n; n=$(( $(cat "$WORK/health-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$WORK/health-count"',
  "  local answers=($HEALTH) answer",
  '  answer="${answers[$(( n <= ${#answers[@]} ? n - 1 : ${#answers[@]} - 1 ))]}"',
  '  [[ "$answer" == down ]] && return 22',
  "  printf '%s' \"$answer\"",
  "}",
  "sleep() { :; }",
].join("\n");

let work = "";

function bashWorks(): boolean {
  try {
    const probe = spawnSync("bash", ["-c", "git --version >/dev/null && echo ok"], {
      encoding: "utf8",
    });
    return probe.status === 0 && probe.stdout.trim() === "ok";
  } catch {
    return false;
  }
}

/** Git that ignores the machine's configuration (signing, line endings). */
function gitEnv(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
    GIT_AUTHOR_NAME: "OpsCrew Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpsCrew Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function sh(script: string, env: Record<string, string> = {}, cwd = join(work, "repo")) {
  const result = spawnSync("bash", ["-c", `${FAKES}\n${script}`], {
    cwd,
    env: {
      ...process.env,
      ...gitEnv(),
      WORK: work.replaceAll("\\", "/"),
      RUNNER_TEMP: join(work, "runner").replaceAll("\\", "/"),
      GITHUB_OUTPUT: join(work, "output").replaceAll("\\", "/"),
      GITHUB_STEP_SUMMARY: join(work, "summary").replaceAll("\\", "/"),
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      ...env,
    },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: join(work, "repo"),
    env: { ...process.env, ...gitEnv() },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function outputs(): Record<string, string> {
  const file = join(work, "output");
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const branchFile = () => git("show", "origin-deploy:compose.yaml");
const fetchBranch = () => git("fetch", "-q", "origin", "+refs/heads/opscrew-deploy:origin-deploy");

/** Pushes a commit holding only `content` as compose.yaml to the deploy branch (as provision does). */
function pushBranch(content: string, parent?: string): string {
  writeFileSync(join(work, "file.yaml"), content);
  const blob = git("hash-object", "-w", join(work, "file.yaml"));
  const tree = spawnSync("git", ["mktree"], {
    cwd: join(work, "repo"),
    env: { ...process.env, ...gitEnv() },
    input: `100644 blob ${blob}\tcompose.yaml\n`,
    encoding: "utf8",
  }).stdout.trim();
  const commit = git("commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "provision");
  git("push", "-q", "origin", `${commit}:refs/heads/opscrew-deploy`);
  return commit;
}

const timeout = 30_000;

describe.skipIf(!bashWorks())("the Portainer deploy job's scripts (bash + git)", () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-portainer-deploy-"));
    writeFileSync(join(work, "gitconfig"), "");
    mkdirSync(join(work, "runner"));
    const origin = join(work, "origin.git");
    spawnSync("git", ["init", "-q", "--bare", origin], { env: { ...process.env, ...gitEnv() } });
    mkdirSync(join(work, "repo"));
    git("init", "-q", "-b", "main");
    mkdirSync(join(work, "repo", "opscrew", "runtime"), { recursive: true });
    writeFileSync(join(work, "repo", "opscrew", "runtime", "compose.yaml"), template);
    git("add", ".");
    git("commit", "-q", "-m", "app");
    git("remote", "add", "origin", `file://${origin.replaceAll("\\", "/")}`);
    git("push", "-q", "origin", "main");
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it(
    "writes the filled-in stack as the only file of a new commit on top of the placeholder",
    () => {
      const placeholder = pushBranch(renderPlaceholderStack(plan).content);
      const run = sh(steps.write ?? "", { IMAGE: NEW });
      expect(run.status, run.output).toBe(0);
      fetchBranch();
      expect(branchFile()).toBe(fillPortainerStack(template, NEW).trimEnd());
      expect(git("ls-tree", "--name-only", "origin-deploy")).toBe("compose.yaml");
      expect(git("rev-parse", "origin-deploy^")).toBe(placeholder);
      expect(git("log", "-1", "--format=%s", "origin-deploy")).toBe(`Deploy ${NEW}`);
      expect(git("log", "-1", "--format=%an", "origin-deploy")).toBe("github-actions[bot]");
      expect(outputs()).toEqual({
        previous: placeholder,
        deployed: git("rev-parse", "origin-deploy"),
        changed: "true",
      });
      // `main` is untouched.
      expect(git("ls-remote", "origin", "refs/heads/main")).toContain(git("rev-parse", "HEAD"));
    },
    timeout,
  );

  it(
    "starts the branch when it does not exist yet, and writes nothing for the same version",
    () => {
      expect(sh(steps.write ?? "", { IMAGE: NEW }).status).toBe(0);
      fetchBranch();
      expect(git("rev-list", "--count", "origin-deploy")).toBe("1");
      expect(outputs().previous).toBe("");
      rmSync(join(work, "output"));
      const again = sh(steps.write ?? "", { IMAGE: NEW });
      expect(again.status, again.output).toBe(0);
      expect(again.output).toContain("already holds this version");
      expect(outputs()).toEqual({ changed: "false" });
      fetchBranch();
      expect(git("rev-list", "--count", "origin-deploy")).toBe("1");
    },
    timeout,
  );

  it(
    "refuses an image that is not pinned by digest, or a template without the image mark",
    () => {
      const bad = sh(steps.write ?? "", { IMAGE: "ghcr.io/acme/shop:latest" });
      expect(bad.status).toBe(1);
      expect(bad.output).toContain("did not report the image digest");
      writeFileSync(join(work, "repo", "opscrew", "runtime", "compose.yaml"), "services: {}\n");
      const noMark = sh(steps.write ?? "", { IMAGE: NEW });
      expect(noMark.status).toBe(1);
      expect(noMark.output).toContain("does not mark the app's image");
      expect(git("ls-remote", "origin", "refs/heads/opscrew-deploy")).toBe("");
    },
    timeout,
  );

  it(
    "calls the webhook through Access with the service token in a file, never in the output",
    () => {
      const env = {
        WEBHOOK_URL: WEBHOOK,
        ACCESS_CLIENT_ID: ACCESS_ID,
        ACCESS_CLIENT_SECRET: ACCESS_SECRET,
      };
      const ok = sh(steps.redeploy ?? "", env);
      expect(ok.status, ok.output).toBe(0);
      expect(ok.output).toContain("Portainer accepted the redeploy.");
      expect(readFileSync(join(work, "headers.log"), "utf8")).toBe(
        `CF-Access-Client-Id: ${ACCESS_ID}\nCF-Access-Client-Secret: ${ACCESS_SECRET}\n`,
      );
      const call = readFileSync(join(work, "curl.log"), "utf8");
      expect(call).toContain(`-X POST -H @`);
      expect(call).toContain(WEBHOOK);
      expect(call).not.toContain(ACCESS_SECRET);
      expect(existsSync(join(work, "runner", "access-headers"))).toBe(false);
      for (const out of [ok.output]) {
        expect(out).not.toContain(ACCESS_SECRET);
        expect(out).not.toContain("webhook-id-placeholder");
      }

      const refused = sh(steps.redeploy ?? "", { ...env, CURL_CODE: "403" });
      expect(refused.status).toBe(1);
      expect(refused.output).toContain(
        "Cloudflare Access refused the deploy workflow's service token",
      );
      const unknown = sh(steps.redeploy ?? "", { ...env, CURL_CODE: "404" });
      expect(unknown.status).toBe(1);
      expect(unknown.output).toContain("does not know this stack's webhook");
      const slow = sh(steps.redeploy ?? "", { ...env, CURL_CODE: "524" });
      expect(slow.status).toBe(0);
      expect(slow.output).toContain("::warning::Portainer did not confirm the redeploy (HTTP 524)");
      for (const out of [refused.output, unknown.output, slow.output]) {
        expect(out).not.toContain(ACCESS_SECRET);
        expect(out).not.toContain("webhook-id-placeholder");
      }
    },
    timeout,
  );

  it(
    "succeeds once the site answers with the new version, not while the previous one serves",
    () => {
      const version = portainerImageVersion(NEW);
      const env = { URL: "https://shop.example.com/api/health", IMAGE: NEW };
      const ok = sh(steps.health ?? "", {
        ...env,
        HEALTH: `down ${portainerImageVersion(OLD)} ${version}`,
      });
      expect(ok.status, ok.output).toBe(0);
      expect(ok.output).toContain("The new version answers after 3 attempt(s).");
      expect(readFileSync(join(work, "curl.log"), "utf8")).toContain(
        "-w %header{x-opscrew-image} https://shop.example.com/api/health",
      );

      rmSync(join(work, "health-count"));
      const stale = sh(steps.health ?? "", { ...env, HEALTH: portainerImageVersion(OLD) });
      expect(stale.status).toBe(1);
      expect(stale.output).toContain("still runs the previous version");
      expect(readFileSync(join(work, "health-count"), "utf8").trim()).toBe("30");

      rmSync(join(work, "health-count"));
      const down = sh(steps.health ?? "", { ...env, HEALTH: "down" });
      expect(down.status).toBe(1);
      expect(down.output).toContain(
        "The new version did not answer at https://shop.example.com/api/health within 5 minutes",
      );
    },
    timeout,
  );

  it(
    "proxy mode: the probe tells whether GitHub reaches the site at all, and never fails the run",
    () => {
      const proxyPlan = portainerTestPlan({ web: { mode: "proxy", port: 8080 } });
      const probe = (
        parse(renderWorkflow(proxyPlan, ctx).content).jobs.deploy.steps as Step[]
      ).find((s) => s.id === "probe")?.run;
      const env = { URL: "https://shop.example.com/api/health" };
      // Any HTTP answer counts (curl without -f exits 0, also for a 502 from the proxy).
      const reachable = sh(probe ?? "", { ...env, HEALTH: "anything" });
      expect(reachable.status, reachable.output).toBe(0);
      expect(outputs()).toEqual({ reachable: "true" });
      rmSync(join(work, "output"));
      const unreachable = sh(probe ?? "", { ...env, HEALTH: "down" });
      expect(unreachable.status, unreachable.output).toBe(0);
      expect(outputs()).toEqual({ reachable: "false" });
      expect(readFileSync(join(work, "curl.log"), "utf8")).toContain(
        "curl -sS --max-time 15 -o /dev/null https://shop.example.com/api/health",
      );
    },
    timeout,
  );

  it(
    "rolls back by writing the previous compose.yaml back and calling the webhook again",
    () => {
      const previousFile = fillPortainerStack(template, OLD);
      const placeholder = pushBranch(renderPlaceholderStack(plan).content);
      const previous = pushBranch(previousFile, placeholder);
      expect(sh(steps.write ?? "", { IMAGE: NEW }).status).toBe(0);
      const written = outputs();
      expect(written.previous).toBe(previous);

      const run = sh(steps["Roll back to the previous version"] ?? "", {
        PREVIOUS: written.previous ?? "",
        DEPLOYED: written.deployed ?? "",
        IMAGE: NEW,
        WEBHOOK_URL: WEBHOOK,
        ACCESS_CLIENT_ID: ACCESS_ID,
        ACCESS_CLIENT_SECRET: ACCESS_SECRET,
      });
      expect(run.status).toBe(1);
      expect(run.output).toContain(
        "OpsCrew wrote the previous version back to the opscrew-deploy branch and asked Portainer to deploy it",
      );
      expect(run.output).not.toContain(ACCESS_SECRET);
      fetchBranch();
      expect(branchFile()).toBe(previousFile.trimEnd());
      expect(git("rev-parse", "origin-deploy^")).toBe(written.deployed);
      expect(git("log", "-1", "--format=%s", "origin-deploy")).toBe(
        "Roll back to the previous version",
      );
      expect(readFileSync(join(work, "curl.log"), "utf8")).toContain(WEBHOOK);
    },
    timeout,
  );

  it(
    "says there is nothing to restore when the branch had no earlier version",
    () => {
      expect(sh(steps.write ?? "", { IMAGE: NEW }).status).toBe(0);
      const head = git("ls-remote", "origin", "refs/heads/opscrew-deploy");
      const run = sh(steps["Roll back to the previous version"] ?? "", {
        PREVIOUS: "",
        DEPLOYED: outputs().deployed ?? "",
        IMAGE: NEW,
      });
      expect(run.status).toBe(1);
      expect(run.output).toContain("had no earlier version to restore");
      expect(git("ls-remote", "origin", "refs/heads/opscrew-deploy")).toBe(head);
    },
    timeout,
  );

  it(
    "updater mode: the rollback only writes the branch, the updater redeploys",
    () => {
      const updaterPlan = portainerTestPlan({ redeploy: "updater" });
      const rollback = (
        parse(renderWorkflow(updaterPlan, ctx).content).jobs.deploy.steps as Step[]
      ).find((s) => s.name === "Roll back to the previous version")?.run;
      const previous = pushBranch(renderPlaceholderStack(updaterPlan).content);
      expect(sh(steps.write ?? "", { IMAGE: NEW }).status).toBe(0);
      const run = sh(rollback ?? "", {
        PREVIOUS: previous,
        DEPLOYED: outputs().deployed ?? "",
        IMAGE: NEW,
      });
      expect(run.status).toBe(1);
      expect(run.output).toContain("Portainer's updater deploys it within about a minute");
      expect(existsSync(join(work, "curl.log"))).toBe(false);
      fetchBranch();
      expect(branchFile()).toBe(renderPlaceholderStack(updaterPlan).content.trimEnd());
    },
    timeout,
  );
});
