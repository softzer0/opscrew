/**
 * Live end-to-end test against a real cloud (Hetzner Cloud and/or DigitalOcean), GitHub (a
 * throwaway repository) and optionally Cloudflare. Each provider runs only when its
 * OPSCREW_E2E_* token is set; see docs/e2e.md. It creates a real server for a few minutes (cents)
 * and always tears it down, even when a step fails.
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
  digitaloceanToken: process.env.OPSCREW_E2E_DIGITALOCEAN_TOKEN,
  githubRepo: process.env.OPSCREW_E2E_GITHUB_REPO,
  githubToken: process.env.OPSCREW_E2E_GITHUB_TOKEN,
  cloudflareToken: process.env.OPSCREW_E2E_CLOUDFLARE_TOKEN,
  domain: process.env.OPSCREW_E2E_DOMAIN,
  region: process.env.OPSCREW_E2E_REGION ?? "eu-central",
};
const withGitHub = Boolean(E2E.githubRepo && E2E.githubToken);
const withDns = Boolean(E2E.cloudflareToken && E2E.domain);

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/cli/dist/opscrew.js");
const EXAMPLE = join(REPO_ROOT, "examples/nextjs-postgres");
const HETZNER_API = "https://api.hetzner.cloud/v1";
const DIGITALOCEAN_API = "https://api.digitalocean.com/v2";
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
const digitalocean = (method: string, path: string, body?: unknown) =>
  api(DIGITALOCEAN_API, E2E.digitaloceanToken as string, method, path, body);

/**
 * Resets the throwaway repository before a pass: closes open pull requests and deletes every
 * branch but `main`, so branches and pull requests of an earlier run never change this one.
 */
async function resetRepository(repoName: string): Promise<void> {
  const pulls = await github("GET", `/repos/${repoName}/pulls?state=open&per_page=100`);
  for (const pull of (pulls.json as { number: number }[] | undefined) ?? []) {
    await github("PATCH", `/repos/${repoName}/pulls/${pull.number}`, { state: "closed" });
  }
  const branches = await github("GET", `/repos/${repoName}/branches?per_page=100`);
  for (const branch of (branches.json as { name: string }[] | undefined) ?? []) {
    if (branch.name === "main") continue;
    const ref = branch.name.split("/").map(encodeURIComponent).join("/");
    const deleted = await github("DELETE", `/repos/${repoName}/git/refs/heads/${ref}`);
    expect(deleted.status, `delete the branch ${branch.name}`).toBe(204);
  }
}

/** What differs between the providers in this test. */
interface LiveProvider {
  id: "hetzner" | "digitalocean";
  name: string;
  token: string | undefined;
  /** The variable the OpsCrew CLI reads the token from. */
  tokenVar: string;
  /** Rewrites the root module before the engine fallback destroys it (lift delete protection). */
  unprotect?: (mainTf: string) => string;
  /** Deletes what OpsCrew created for the app through the provider API (last-resort cleanup). */
  apiCleanup: (appName: string) => Promise<void>;
  /** SC-301 / SC-401: nothing created for the app is left. */
  expectNothingLeft: (appName: string) => Promise<void>;
}

const HETZNER: LiveProvider = {
  id: "hetzner",
  name: "Hetzner Cloud",
  token: E2E.hcloudToken,
  tokenVar: "HCLOUD_TOKEN",
  unprotect: (source) =>
    source.replace(
      'source = "../modules/hetzner-vps"',
      'source = "../modules/hetzner-vps"\n  delete_protection = false',
    ),
  async apiCleanup(appName) {
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
        await retryDelete(() => hetzner("DELETE", `/${kind}/${item.id}`));
      }
    }
  },
  async expectNothingLeft(appName) {
    const selector = encodeURIComponent(`managed-by=opscrew,app=${appName}`);
    for (const kind of ["servers", "firewalls", "ssh_keys"] as const) {
      const left = await hetzner("GET", `/${kind}?label_selector=${selector}`);
      expect((left.json as Record<string, unknown[]>)[kind], `no OpsCrew ${kind} left`).toEqual([]);
    }
  },
};

/** DigitalOcean resources carry plain tags and names, not labels: `opscrew-app:<name>`. */
const appTag = (appName: string) => encodeURIComponent(`opscrew-app:${appName}`);

async function digitaloceanLeftovers(appName: string) {
  const droplets = await digitalocean("GET", `/droplets?tag_name=${appTag(appName)}&per_page=200`);
  const firewalls = await digitalocean("GET", "/firewalls?per_page=200");
  const keys = await digitalocean("GET", "/account/keys?per_page=200");
  const tag = await digitalocean("GET", `/tags/${appTag(appName)}`);
  return {
    droplets: ((droplets.json as { droplets?: { id: number }[] }).droplets ?? []).map((d) => d.id),
    firewalls: ((firewalls.json as { firewalls?: { id: string; name: string }[] }).firewalls ?? [])
      .filter((f) => f.name === `${appName}-firewall`)
      .map((f) => f.id),
    sshKeys: ((keys.json as { ssh_keys?: { id: number; name: string }[] }).ssh_keys ?? [])
      .filter((k) => k.name === `${appName}-deploy`)
      .map((k) => k.id),
    tag: tag.status === 200,
  };
}

const DIGITALOCEAN: LiveProvider = {
  id: "digitalocean",
  name: "DigitalOcean",
  token: E2E.digitaloceanToken,
  tokenVar: "DIGITALOCEAN_TOKEN",
  async apiCleanup(appName) {
    const left = await digitaloceanLeftovers(appName);
    for (const id of left.droplets)
      await retryDelete(() => digitalocean("DELETE", `/droplets/${id}`));
    for (const id of left.firewalls) {
      await retryDelete(() => digitalocean("DELETE", `/firewalls/${id}`));
    }
    for (const id of left.sshKeys) {
      await retryDelete(() => digitalocean("DELETE", `/account/keys/${id}`));
    }
    // Only the app's own tag; `managed-by:opscrew` is shared with other apps and never deleted.
    if (left.tag) await retryDelete(() => digitalocean("DELETE", `/tags/${appTag(appName)}`));
  },
  async expectNothingLeft(appName) {
    const left = await digitaloceanLeftovers(appName);
    expect(left, "no OpsCrew Droplet, firewall, SSH key or app tag left").toEqual({
      droplets: [],
      firewalls: [],
      sshKeys: [],
      tag: false,
    });
  },
};

async function retryDelete(request: () => Promise<{ status: number }>): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const deleted = await request();
    if (deleted.status < 300 || deleted.status === 404) return;
    await sleep(5_000);
  }
}

for (const provider of [HETZNER, DIGITALOCEAN]) {
  describe.skipIf(!(provider.token && withGitHub))(`live end-to-end on ${provider.name}`, () => {
    it("deploys examples/nextjs-postgres from a GitHub repository and tears everything down", {
      timeout: minutes(75),
    }, async () => {
      await deployAndTearDown(provider);
    });
  });
}

const PLAN_HASH = /(?:Plan hash \(SHA-256\): |--approve )([0-9a-f]{64})/;

/** Runs `opscrew retarget …` until it exits 0, approving each plan it stops at by its hash. */
async function retargetUntilDone(run: LiveRun, first: string[], next: string[]): Promise<void> {
  let args = first;
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await run.opscrew("retarget", ...args);
    if (result.exitCode === 0) return;
    expect(result.exitCode, result.output).toBe(1);
    const hash = PLAN_HASH.exec(result.output)?.[1];
    expect(hash, `a plan hash to approve:\n${result.output}`).toBeDefined();
    args = [...next, "--approve", hash as string];
  }
  throw new Error("opscrew retarget did not finish after 12 runs");
}

describe.skipIf(!(HETZNER.token && DIGITALOCEAN.token && withGitHub))(
  "live move from Hetzner Cloud to DigitalOcean",
  () => {
    it("keeps the data, switches DNS, finishes the move and tears everything down", {
      timeout: minutes(150),
    }, async () => {
      await deployAndTearDown(HETZNER, {
        alsoTokens: [DIGITALOCEAN],
        afterDeploy: async (run) => {
          const planFile = join(run.repo, "opscrew/plan.yaml");
          const before = await readArtifact("plan", planFile);
          const oldIp = before.deployment.serverIpv4 as string;
          const marker = `opscrew-e2e-${Date.now()}`;
          const psql = (sql: string) =>
            `cd /srv/app && docker compose exec -T db psql -U app -d app -tAc "${sql}"`;
          await run.ssh(oldIp, psql("create table if not exists opscrew_e2e (v text)"));
          await run.ssh(oldIp, psql(`insert into opscrew_e2e values ('${marker}')`));

          const flags = ["--yes", "--allow-downtime", ...(withDns ? [] : ["--dns-switched"])];
          await retargetUntilDone(run, ["--to", "digitalocean", ...flags], flags);
          const moved = await readArtifact("plan", planFile);
          expect(moved.target.provider).toBe("digitalocean");
          expect(moved.retarget?.step).toBe("switched");
          const newIp = moved.deployment.serverIpv4 as string;
          expect(newIp).not.toBe(oldIp);
          // SC-501: the row written before the move is in the new server's database …
          expect(await run.ssh(newIp, psql("select v from opscrew_e2e"))).toContain(marker);
          // … and the app answers through its URL on the new server.
          const health = new URL(moved.app.healthPath, moved.deployment.url as string);
          expect((await fetch(health)).status, `GET ${health}`).toBe(200);

          const finish = ["--finish", "--confirm", run.appName, "--no-snapshot", "--yes"];
          await retargetUntilDone(run, finish, finish);
          expect((await readArtifact("plan", planFile)).retarget).toBeUndefined();
          await HETZNER.expectNothingLeft(run.appName);
        },
      });
    });
  },
);

/** A deployed example, handed to `afterDeploy` (for example to move it to the other provider). */
interface LiveRun {
  repo: string;
  appName: string;
  /** The deploy key and OpsCrew's known_hosts for this project, for direct SSH checks. */
  ssh: (host: string, command: string) => Promise<string>;
  opscrew: (...args: string[]) => Promise<{ exitCode: number; output: string }>;
}

interface DeployOptions {
  /** Tokens of other providers the run may use (a move needs both). */
  alsoTokens?: readonly LiveProvider[];
  /** Runs after the deployment was verified, before the teardown. */
  afterDeploy?: (run: LiveRun) => Promise<void>;
}

async function deployAndTearDown(
  provider: LiveProvider,
  options: DeployOptions = {},
): Promise<void> {
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
    GITHUB_TOKEN: E2E.githubToken,
    OPSCREW_APP_ENV_FILE: join(work, "production.env"),
    ...(withDns ? { CLOUDFLARE_API_TOKEN: E2E.cloudflareToken } : {}),
  };
  // Only this provider's token, so nothing can reach the other provider's account.
  for (const name of ["HCLOUD_TOKEN", "DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"]) {
    delete env[name];
  }
  env[provider.tokenVar] = provider.token;
  for (const other of options.alsoTokens ?? []) env[other.tokenVar] = other.token;
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
  await resetRepository(repoName);

  let appName: string | undefined;
  try {
    expect((await opscrew("analyze", "--no-ai")).exitCode).toBe(0);
    await writeFile(
      join(work, "answers.json"),
      JSON.stringify({
        expectedMonthlyUsers: "<1k",
        budgetMonthly: provider.id === "digitalocean" ? "25 USD" : 20,
        provider: provider.id,
        region: E2E.region,
        uptime: "best-effort",
        dataCriticality: "important",
        dnsProvider: withDns ? "cloudflare" : "none",
        ...(withDns ? { domain: E2E.domain } : {}),
        keepExternalServices: [],
      }),
    );
    expect((await opscrew("interview", "--answers", join(work, "answers.json"))).exitCode).toBe(0);
    expect((await opscrew("design")).exitCode).toBe(0);
    const plan = await readArtifact("plan", join(repo, "opscrew/plan.yaml"));
    appName = plan.app.name;
    expect(plan.target.provider).toBe(provider.id);

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
      const run = (runs.json as { workflow_runs?: { status: string; conclusion: string | null }[] })
        .workflow_runs?.[0];
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
    const drift = await opscrew("drift");
    expect(drift.exitCode, drift.output).toBe(0);

    if (options.afterDeploy !== undefined) {
      const paths = resolveProjectPaths(repo, { env });
      const ssh = async (host: string, command: string) => {
        const target = host.includes(":") ? `deploy@[${host}]` : `deploy@${host}`;
        const result = await runner.run(
          "ssh",
          [
            "-i",
            paths.files.deployKey,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            `UserKnownHostsFile=${paths.files.knownHosts}`,
            target,
            command,
          ],
          { env, timeoutMs: minutes(2) },
        );
        if (result.exitCode !== 0) throw new Error(`ssh ${host} failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      await options.afterDeploy({ repo, appName: appName as string, ssh, opscrew });
    }
  } finally {
    // The user's own teardown first (SC-301); the IaC and API fallbacks only if it fails.
    const involved = [provider, ...(options.alsoTokens ?? [])];
    const current = await readArtifact("plan", join(repo, "opscrew/plan.yaml"))
      .then((plan) => ({ provider: plan.target.provider, moving: plan.retarget !== undefined }))
      .catch(() => ({ provider: provider.id, moving: false }));
    const live = involved.find((p) => p.id === current.provider) ?? provider;
    let destroyed = false;
    if (appName !== undefined && !current.moving) {
      const destroy = await opscrew("destroy", "--confirm", appName, "--no-snapshot").catch(
        () => undefined,
      );
      destroyed = destroy?.exitCode === 0;
      if (!destroyed) {
        console.error(`opscrew destroy failed; falling back:\n${destroy?.output ?? ""}`);
      }
    }
    if (destroyed && appName !== undefined) {
      for (const p of involved) await p.expectNothingLeft(appName);
    } else if (current.moving && appName !== undefined) {
      // A move left half-way has servers on both providers: delete them through the APIs.
      console.error("A move was still in progress; deleting through both providers' APIs.");
      for (const p of involved) await p.apiCleanup(appName);
      for (const p of involved) await p.expectNothingLeft(appName);
    } else {
      await teardown(live, repo, env, appName);
      for (const p of involved)
        if (p !== live && appName !== undefined) await p.apiCleanup(appName);
    }
  }
}

/**
 * Fallback when `opscrew destroy` failed: lift delete protection (Hetzner) and apply a destroy plan
 * with the engine directly, then delete what OpsCrew created through the provider API, so a failed
 * run never leaves a billed server behind.
 */
async function teardown(
  provider: LiveProvider,
  repo: string,
  env: Record<string, string | undefined>,
  appName: string | undefined,
): Promise<void> {
  const main = join(repo, "opscrew/infra/prod/main.tf");
  try {
    if (existsSync(main)) {
      if (provider.unprotect) {
        await writeFile(main, provider.unprotect(await readFile(main, "utf8")));
      }
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
      if (provider.unprotect) {
        const unprotect = await engine.plan(
          dir,
          join(paths.files.plansDir, "e2e-unprotect.tfplan"),
          { env: engineEnv },
        );
        if (unprotect.changes.length > 0) {
          await engine.apply(
            dir,
            unprotect.planFile,
            { approvedPlanHash: unprotect.planHash },
            { env: engineEnv },
          );
        }
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
    console.error(
      `IaC teardown failed, deleting through the ${provider.name} API: ${String(error)}`,
    );
  }
  if (appName === undefined) return;
  await provider.apiCleanup(appName);
  await provider.expectNothingLeft(appName);
}
