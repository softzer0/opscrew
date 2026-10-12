/**
 * Live end-to-end test against real Hetzner Cloud, GitHub (a throwaway repository) and optionally
 * Cloudflare. Skipped unless the OPSCREW_E2E_* variables are set; see docs/e2e.md. It creates a
 * real server for a few minutes (cents) and always tears it down, even when a step fails.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";

const E2E = {
  hcloudToken: process.env.OPSCREW_E2E_HCLOUD_TOKEN,
  githubRepo: process.env.OPSCREW_E2E_GITHUB_REPO,
  githubToken: process.env.OPSCREW_E2E_GITHUB_TOKEN,
  cloudflareToken: process.env.OPSCREW_E2E_CLOUDFLARE_TOKEN,
  domain: process.env.OPSCREW_E2E_DOMAIN,
};
const enabled = Boolean(E2E.hcloudToken && E2E.githubRepo && E2E.githubToken);
const withDns = Boolean(E2E.cloudflareToken && E2E.domain);

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/cli/dist/opscrew.js");
const EXAMPLE = join(REPO_ROOT, "examples/nextjs-postgres");
const HETZNER_API = "https://api.hetzner.cloud/v1";
const GITHUB_API = "https://api.github.com";

const runner = new NodeCommandRunner();
const minutes = (n: number) => n * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: base === GITHUB_API ? "application/vnd.github+json" : "application/json",
      "User-Agent": "opscrew-e2e",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

const github = (method: string, path: string, body?: unknown) =>
  api(GITHUB_API, E2E.githubToken as string, method, path, body);
const hetzner = (method: string, path: string, body?: unknown) =>
  api(HETZNER_API, E2E.hcloudToken as string, method, path, body);

describe.skipIf(!enabled)("live end-to-end on Hetzner Cloud", () => {
  it("deploys examples/nextjs-postgres from a GitHub repository and tears everything down", {
    timeout: minutes(75),
  }, async () => {
    expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
    const work = await mkdtemp(join(tmpdir(), "opscrew-e2e-"));
    const repo = join(work, "repo");
    const home = join(work, "home");
    await mkdir(repo);
    const repoName = E2E.githubRepo as string;
    const basic = Buffer.from(`x-access-token:${E2E.githubToken}`).toString("base64");
    const env: Record<string, string | undefined> = {
      ...process.env,
      CI: "1",
      OPSCREW_HOME: home,
      HCLOUD_TOKEN: E2E.hcloudToken,
      GITHUB_TOKEN: E2E.githubToken,
      OPSCREW_APP_ENV_FILE: join(work, "production.env"),
      ...(withDns ? { CLOUDFLARE_API_TOKEN: E2E.cloudflareToken } : {}),
    };
    for (const name of Object.keys(env)) if (name.startsWith("OPSCREW_E2E_")) delete env[name];
    const git = async (...args: string[]) => {
      const result = await runner.run("git", ["-C", repo, ...args], { env });
      if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    const opscrew = async (...args: string[]) => {
      const result = await runner.run(process.execPath, [CLI, ...args], {
        cwd: repo,
        env,
        timeoutMs: minutes(30),
      });
      return { ...result, output: `${result.stdout}\n${result.stderr}` };
    };
    const mergePullRequest = async (head: string) => {
      const [owner] = repoName.split("/");
      const list = await github(
        "GET",
        `/repos/${repoName}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`,
      );
      const pull = (list.json as { number: number }[])[0];
      expect(pull, `an open pull request from ${head}`).toBeDefined();
      const merged = await github("PUT", `/repos/${repoName}/pulls/${pull?.number}/merge`, {
        merge_method: "squash",
      });
      expect(merged.status, "merge the pull request").toBe(200);
      await git("fetch", "-q", "origin");
      await git("checkout", "-q", "-B", "main", "origin/main");
    };

    // A fresh copy of the example becomes the throwaway repository's main branch.
    await materializeFixture(EXAMPLE, repo);
    await writeFile(join(work, "production.env"), "");
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "OpsCrew E2E");
    await git("config", "user.email", "e2e@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("config", "http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`);
    await git("remote", "add", "origin", `https://github.com/${repoName}.git`);
    await git("add", "-A");
    await git("commit", "-q", "-m", "e2e: examples/nextjs-postgres");
    await git("push", "-q", "--force", "origin", "main");

    let appName: string | undefined;
    try {
      expect((await opscrew("analyze", "--no-ai")).exitCode).toBe(0);
      await writeFile(
        join(work, "answers.json"),
        JSON.stringify({
          expectedMonthlyUsers: "<1k",
          budgetMonthly: 20,
          region: "eu-central",
          uptime: "best-effort",
          dataCriticality: "important",
          dnsProvider: withDns ? "cloudflare" : "none",
          ...(withDns ? { domain: E2E.domain } : {}),
          keepExternalServices: [],
        }),
      );
      expect((await opscrew("interview", "--answers", join(work, "answers.json"))).exitCode).toBe(
        0,
      );
      expect((await opscrew("design")).exitCode).toBe(0);
      appName = (await readArtifact("plan", join(repo, "opscrew/plan.yaml"))).app.name;

      const adapt = await opscrew("adapt", "--no-ai", "--yes");
      expect(adapt.exitCode, adapt.output).toBe(0);
      const branches = await git(
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/opscrew/prepare-deploy*",
      );
      const adaptBranch = branches.split(/\r?\n/)[0];
      await mergePullRequest(adaptBranch as string);

      const planned = await opscrew("provision", "--plan-only", "--yes");
      expect(planned.exitCode, planned.output).toBe(0);
      const hash = /--approve ([0-9a-f]{64})/.exec(planned.output)?.[1];
      expect(hash, "the plan hash is printed").toBeDefined();
      const applied = await opscrew("provision", "--approve", hash as string, "--yes");
      expect(applied.exitCode, applied.output).toBe(0);
      await mergePullRequest("opscrew/deploy-setup");

      // The merge to main triggers the deploy workflow; wait for it.
      const deadline = Date.now() + minutes(25);
      let conclusion: string | null = null;
      while (Date.now() < deadline) {
        const runs = await github(
          "GET",
          `/repos/${repoName}/actions/workflows/opscrew-deploy.yml/runs?branch=main&per_page=1`,
        );
        const run = (
          runs.json as { workflow_runs?: { status: string; conclusion: string | null }[] }
        ).workflow_runs?.[0];
        if (run?.status === "completed") {
          conclusion = run.conclusion;
          break;
        }
        await sleep(20_000);
      }
      expect(conclusion, "the deploy workflow succeeded").toBe("success");

      const verify = await opscrew("verify");
      expect(verify.exitCode, verify.output).toBe(0);
      const secure = await opscrew("secure");
      expect(secure.output).toContain("SECURITY_REPORT.md");
    } finally {
      // The user's own teardown first (SC-301); the IaC and API fallbacks only if it fails.
      let destroyed = false;
      if (appName !== undefined) {
        const destroy = await opscrew("destroy", "--confirm", appName, "--no-snapshot").catch(
          () => undefined,
        );
        destroyed = destroy?.exitCode === 0;
        if (!destroyed) {
          console.error(`opscrew destroy failed; falling back:
${destroy?.output ?? ""}`);
        }
      }
      if (destroyed && appName !== undefined) await expectNothingLeft(appName);
      else await teardown(repo, env, appName);
    }
  });
});

/**
 * Fallback when `opscrew destroy` failed: lift delete protection and apply a destroy plan with the
 * engine directly, then delete the labelled Hetzner resources through the API, so a failed run
 * never leaves a billed server behind.
 */
async function teardown(
  repo: string,
  env: Record<string, string | undefined>,
  appName: string | undefined,
): Promise<void> {
  const main = join(repo, "opscrew/infra/prod/main.tf");
  try {
    if (existsSync(main)) {
      const source = await readFile(main, "utf8");
      await writeFile(
        main,
        source.replace(
          'source = "../modules/hetzner-vps"',
          'source = "../modules/hetzner-vps"\n  delete_protection = false',
        ),
      );
      const paths = resolveProjectPaths(repo, { env });
      const engine = await selectEngine("auto", { env, runner });
      const engineEnv = { ...env };
      if (engine.info.name === "tofu" && existsSync(paths.files.statePassphrase)) {
        const passphrase = (await readFile(paths.files.statePassphrase, "utf8")).trim();
        engineEnv.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
      }
      const dir = join(repo, "opscrew/infra/prod");
      await engine.init(dir, {
        env: engineEnv,
        backendConfig: { path: join(paths.files.tfstateDir, "prod.tfstate") },
      });
      await mkdir(paths.files.plansDir, { recursive: true });
      const unprotect = await engine.plan(dir, join(paths.files.plansDir, "e2e-unprotect.tfplan"), {
        env: engineEnv,
      });
      if (unprotect.changes.length > 0) {
        await engine.apply(
          dir,
          unprotect.planFile,
          { approvedPlanHash: unprotect.planHash },
          {
            env: engineEnv,
          },
        );
      }
      const destroy = await engine.plan(dir, join(paths.files.plansDir, "e2e-destroy.tfplan"), {
        env: engineEnv,
        destroy: true,
      });
      const result = await engine.apply(
        dir,
        destroy.planFile,
        { approvedPlanHash: destroy.planHash, allowDestroy: true },
        { env: engineEnv },
      );
      if (!result.ok) throw new Error(result.log);
    }
  } catch (error) {
    console.error(`IaC teardown failed, deleting through the Hetzner API: ${String(error)}`);
  }
  if (appName === undefined) return;
  const selector = encodeURIComponent(`managed-by=opscrew,app=${appName}`);
  for (const kind of ["servers", "firewalls", "ssh_keys"] as const) {
    const listed = await hetzner("GET", `/${kind}?label_selector=${selector}`);
    for (const item of (listed.json as Record<string, { id: number }[]>)[kind] ?? []) {
      if (kind === "servers") {
        await hetzner("POST", `/servers/${item.id}/actions/change_protection`, {
          delete: false,
          rebuild: false,
        });
      }
      // a firewall stays "in use" until its server is gone; retry for up to a minute
      for (let attempt = 0; attempt < 12; attempt++) {
        const deleted = await hetzner("DELETE", `/${kind}/${item.id}`);
        if (deleted.status < 300 || deleted.status === 404) break;
        await sleep(5_000);
      }
    }
  }
  await expectNothingLeft(appName);
}

/** SC-301: no server, firewall or SSH key labelled for the app remains. */
async function expectNothingLeft(appName: string): Promise<void> {
  const selector = encodeURIComponent(`managed-by=opscrew,app=${appName}`);
  for (const kind of ["servers", "firewalls", "ssh_keys"] as const) {
    const left = await hetzner("GET", `/${kind}?label_selector=${selector}`);
    expect((left.json as Record<string, unknown[]>)[kind], `no OpsCrew ${kind} left`).toEqual([]);
  }
}
