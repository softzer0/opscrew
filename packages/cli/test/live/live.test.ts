/**
 * Live end-to-end test against a real cloud (Hetzner Cloud and/or DigitalOcean), GitHub (a
 * throwaway repository) and optionally Cloudflare. Each provider runs only when its
 * OPSCREW_E2E_* token is set; see docs/e2e.md. It creates a real server for a few minutes (cents)
 * and always tears it down, even when a step fails. OPSCREW_E2E_APP picks the app to deploy. With
 * a Cloudflare domain it also checks the app's hostnames in OpsCrew's shared rules (feature 011).
 * On Hetzner the builder examples also get the builder checks of feature 012 (builder-checks.ts).
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  type BuilderRun,
  builderChecks,
  builderPreflight,
  builderSettings,
} from "./builder-checks";
import {
  api,
  Cloudflare,
  type CloudflareZone,
  GitHubRepo,
  HETZNER_API,
  minutes,
  retryDelete,
} from "./cloud";
import { CLI, EXAMPLES, isExample } from "./harness";
import {
  type AppRules,
  appRules,
  approveHashes,
  newRunId,
  runHostname,
  sharedRuleHosts,
  unprotectHetznerRoot,
  type ZoneEntrypoints,
} from "./support";

const E2E = {
  hcloudToken: process.env.OPSCREW_E2E_HCLOUD_TOKEN,
  digitaloceanToken: process.env.OPSCREW_E2E_DIGITALOCEAN_TOKEN,
  githubRepo: process.env.OPSCREW_E2E_GITHUB_REPO,
  githubToken: process.env.OPSCREW_E2E_GITHUB_TOKEN,
  cloudflareToken: process.env.OPSCREW_E2E_CLOUDFLARE_TOKEN,
  domain: process.env.OPSCREW_E2E_DOMAIN,
  region: process.env.OPSCREW_E2E_REGION ?? "eu-central",
  /** A file of production values for the app (`NAME=value` lines), copied in for `provision`. */
  appEnvFile: process.env.OPSCREW_E2E_APP_ENV,
};
const withGitHub = Boolean(E2E.githubRepo && E2E.githubToken);
const withDns = Boolean(E2E.cloudflareToken && E2E.domain);
// OPSCREW_E2E_AI=1 runs `analyze` and `adapt` with a model (ANTHROPIC_API_KEY), for apps whose
// health route or other changes only the Code-change agent makes. It costs model usage.
const withAi = process.env.OPSCREW_E2E_AI === "1";
const aiFlags = withAi ? [] : ["--no-ai"];

const DIGITALOCEAN_API = "https://api.digitalocean.com/v2";

const runner = new NodeCommandRunner();
const github = new GitHubRepo(E2E.githubToken ?? "", E2E.githubRepo ?? "");

/** The app a live pass deploys, from OPSCREW_E2E_APP. */
type E2eApp =
  | { kind: "example"; name: string; label: string }
  | { kind: "github"; owner: string; repo: string; commit: string; label: string };

const DEFAULT_E2E_APP = "nextjs-postgres";
const GITHUB_APP = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)@(.*)$/;

/**
 * Parses OPSCREW_E2E_APP: an example name under `examples/` (default `nextjs-postgres`) or
 * `github:<owner>/<repo>@<40-character commit SHA>`. Throws a plain message for anything else.
 */
function parseE2eApp(value: string | undefined): E2eApp {
  const raw = value?.trim() || DEFAULT_E2E_APP;
  if (raw.startsWith("github:")) {
    const match = GITHUB_APP.exec(raw);
    const [, owner = "", repo = "", commit = ""] = match ?? [];
    if (!match || repo === "." || repo === "..") {
      throw new Error(
        `OPSCREW_E2E_APP="${raw}" is not github:<owner>/<repo>@<commit>, for example github:octocat/hello-world@<40-character commit SHA>.`,
      );
    }
    if (!/^[0-9a-fA-F]{40}$/.test(commit)) {
      throw new Error(
        `OPSCREW_E2E_APP="${raw}" must pin a full 40-character commit SHA after "@", not "${commit}" (branches, tags and short SHAs can move). Copy it from the commit page on GitHub.`,
      );
    }
    const sha = commit.toLowerCase();
    return { kind: "github", owner, repo, commit: sha, label: `github:${owner}/${repo}@${sha}` };
  }
  if (!isExample(raw)) {
    throw new Error(
      `OPSCREW_E2E_APP="${raw}" is not an example under examples/ and not github:<owner>/<repo>@<commit>. Use a folder name from examples/, for example ${DEFAULT_E2E_APP}.`,
    );
  }
  return { kind: "example", name: raw, label: `examples/${raw}` };
}

/** The parsed app, or the reason OPSCREW_E2E_APP was refused (each pass stops on it first). */
const APP: E2eApp | Error = (() => {
  try {
    return parseE2eApp(process.env.OPSCREW_E2E_APP);
  } catch (error) {
    return error as Error;
  }
})();
const APP_LABEL =
  APP instanceof Error ? `OPSCREW_E2E_APP=${process.env.OPSCREW_E2E_APP}` : APP.label;
const isDefaultApp =
  !(APP instanceof Error) && APP.kind === "example" && APP.name === DEFAULT_E2E_APP;

/**
 * Puts the app's files into `dest`: a fresh copy of the example, or the public repository fetched
 * at exactly the pinned commit without its `.git` (read-only: nothing is ever pushed to it).
 */
async function materializeApp(app: E2eApp, dest: string): Promise<void> {
  if (app.kind === "example") {
    await materializeFixture(join(EXAMPLES, app.name), dest);
    return;
  }
  const source = await mkdtemp(join(tmpdir(), "opscrew-e2e-source-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = async (...args: string[]) => {
    const result = await runner.run("git", ["-C", source, ...args], {
      env,
      timeoutMs: minutes(5),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not fetch ${app.label} (git ${args[0]}): ${result.stderr.trim()}. Check that the repository is public and the commit exists.`,
      );
    }
    return result.stdout.trim();
  };
  await git("init", "-q");
  const url = `https://github.com/${app.owner}/${app.repo}.git`;
  await git("fetch", "-q", "--depth", "1", url, app.commit);
  await git("-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD");
  expect(await git("rev-parse", "HEAD"), "the fetched commit").toBe(app.commit);
  await cp(source, dest, {
    recursive: true,
    filter: (path) => !relative(source, path).split(sep).includes(".git"),
  });
}

const hetzner = (method: string, path: string, body?: unknown) =>
  api(HETZNER_API, E2E.hcloudToken as string, method, path, body);
const digitalocean = (method: string, path: string, body?: unknown) =>
  api(DIGITALOCEAN_API, E2E.digitaloceanToken as string, method, path, body);

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
  unprotect: unprotectHetznerRoot,
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

/**
 * The builder checks (feature 012) of the Hetzner pass with OPSCREW_E2E_BUILDS=1, when
 * OPSCREW_E2E_APP is one of the builder examples (nextjs-postgres, go-api, rust-api); otherwise
 * the line the pass logs instead.
 */
const BUILDERS = builderSettings(
  APP instanceof Error || APP.kind !== "example" ? undefined : APP.name,
  process.env,
);

/**
 * OPSCREW_E2E_SKIP_DESTROY=1: the Hetzner pass skips `opscrew destroy` and takes the fallback a
 * failed destroy takes (the IaC destroy, the provider API, the shared Cloudflare rules), whose
 * leftover checks must then find nothing.
 */
const skipDestroy = process.env.OPSCREW_E2E_SKIP_DESTROY === "1";

for (const provider of [HETZNER, DIGITALOCEAN]) {
  const onHetzner = provider.id === "hetzner";
  const builders = onHetzner && typeof BUILDERS !== "string" ? BUILDERS : undefined;
  describe.skipIf(!(provider.token && withGitHub))(`live end-to-end on ${provider.name}`, () => {
    it(`deploys ${APP_LABEL} from a GitHub repository and tears everything down`, {
      timeout: minutes(builders === undefined ? 75 : 180),
    }, async () => {
      const cleanup = { skipDestroy: onHetzner && skipDestroy };
      if (builders === undefined) {
        if (onHetzner && typeof BUILDERS === "string") console.log(`OpsCrew E2E: ${BUILDERS}`);
        await deployAndTearDown(provider, cleanup);
        return;
      }
      // Before any GitHub or cloud call.
      await builderPreflight(builders);
      await deployAndTearDown(provider, {
        ...cleanup,
        answers: builders.sign ? { signImages: true } : {},
        afterDeploy: (run) =>
          builderChecks(run, builders, [
            { label: "OPSCREW_E2E_GITHUB_TOKEN", value: E2E.githubToken },
            { label: "OPSCREW_E2E_HCLOUD_TOKEN", value: E2E.hcloudToken },
            { label: "OPSCREW_E2E_CLOUDFLARE_TOKEN", value: E2E.cloudflareToken },
          ]),
      });
    });
  });
}

const PLAN_HASH = /(?:Plan hash \(SHA-256\): |--approve )([0-9a-f]{64})/;

/** The Cloudflare zone of the domain and its two entrypoint rulesets before the provision. */
interface SharedZone {
  cloudflare: Cloudflare;
  zone: CloudflareZone;
  before: ZoneEntrypoints;
}

/**
 * The app's hostnames in OpsCrew's shared Cloudflare rules (feature 011), found by `ref`: after a
 * provision (`listed`) exactly the rules `rules` names list them, after the destroy none does.
 * Other hostnames in the rules (other apps in the zone) are not this test's.
 */
async function expectInSharedRules(
  shared: SharedZone,
  rules: AppRules,
  listed: boolean,
): Promise<void> {
  const now = sharedRuleHosts(await shared.cloudflare.sharedEntrypoints(shared.zone));
  const hosts = new Set(Object.values(rules).flat());
  for (const [ref, ruleHosts] of Object.entries(now)) {
    const want = listed ? (rules[ref as keyof AppRules] ?? []) : [];
    expect(
      (ruleHosts ?? []).filter((host) => hosts.has(host)),
      `the app's hostnames in OpsCrew's shared rule ${ref} ${listed ? "after provision" : "after destroy"}`,
    ).toEqual([...want].sort());
  }
}

/**
 * The last resort after a failed teardown: deletes the DNS records left on the app's hostnames.
 * They are this run's own (`runHostname`), so no other app's record is touched. Logs each by its
 * type, never its content.
 */
async function removeRecordsOfRun(shared: SharedZone, rules: AppRules): Promise<void> {
  const hosts = new Set(Object.values(rules).flat());
  const records = await shared.cloudflare.list<{ id: string; type: string; name: string }>(
    `/zones/${shared.zone.id}/dns_records`,
  );
  for (const record of records.filter((r) => hosts.has(r.name))) {
    const deleted = await retryDelete(() =>
      shared.cloudflare.call("DELETE", `/zones/${shared.zone.id}/dns_records/${record.id}`),
    );
    console.error(
      `OpsCrew E2E: ${deleted ? "deleted" : "could not delete"} the ${record.type} record the teardown left on this run's hostname`,
    );
  }
}

/**
 * After the destroy or its fallback: no DNS record on the app's hostnames (its domain, and `www.`
 * when it serves that too) is left in the zone. A failure names each record by its type and a
 * label, never by its name or content.
 */
async function expectNoRecordsLeft(shared: SharedZone, rules: AppRules): Promise<void> {
  const hosts = [...new Set(Object.values(rules).flat())];
  const records = await shared.cloudflare.list<{ type: string; name: string }>(
    `/zones/${shared.zone.id}/dns_records`,
  );
  const left = records
    .filter((record) => hosts.includes(record.name))
    .map(
      (record) =>
        `${record.type} record on ${record.name === hosts[0] ? "the app's domain" : "the app's www. name"}`,
    );
  expect(left, "DNS records of the app left in the zone after destroy").toEqual([]);
}

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

// The move checks a row in the app's Postgres service, so it runs with the default app only.
describe.skipIf(!(HETZNER.token && DIGITALOCEAN.token && withGitHub && isDefaultApp))(
  "live move from Hetzner Cloud to DigitalOcean",
  () => {
    it("keeps the data, switches DNS, finishes the move and tears everything down", {
      timeout: minutes(150),
    }, async () => {
      await deployAndTearDown(HETZNER, {
        alsoTokens: [DIGITALOCEAN],
        afterDeploy: async (run) => {
          const planFile = join(run.repo, "opscrew/plan.yaml");
          const servers = () => readServerAddresses(resolveProjectPaths(run.repo));
          const oldIp = (await servers()).deployment?.ipv4 as string;
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
          const newIp = (await servers()).deployment?.ipv4 as string;
          expect(newIp).not.toBe(oldIp);
          // SC-501: the row written before the move is in the new server's database …
          expect(await run.ssh(newIp, psql("select v from opscrew_e2e"))).toContain(marker);
          // … and the app answers through its URL on the new server.
          const health = new URL(moved.app.healthPath, moved.deployment.url ?? `http://${newIp}`);
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

/**
 * A deployed example, handed to `afterDeploy` (for example to move it to the other provider, or
 * for the builder checks).
 */
interface LiveRun extends BuilderRun {
  appName: string;
  opscrew: (...args: string[]) => Promise<{ exitCode: number; output: string }>;
}

interface DeployOptions {
  /** Tokens of other providers the run may use (a move needs both). */
  alsoTokens?: readonly LiveProvider[];
  /** More interview answers (for example `signImages`). */
  answers?: Record<string, unknown>;
  /** Runs after the deployment was verified, before the teardown. */
  afterDeploy?: (run: LiveRun) => Promise<void>;
  /** Skips `opscrew destroy`, so the fallback cleanup a failed destroy gets runs and is checked. */
  skipDestroy?: boolean;
}

async function deployAndTearDown(
  provider: LiveProvider,
  options: DeployOptions = {},
): Promise<void> {
  // An invalid OPSCREW_E2E_APP stops here, before any GitHub or cloud call.
  if (APP instanceof Error) throw APP;
  const startedAt = new Date();
  if (withAi && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPSCREW_E2E_AI=1 needs ANTHROPIC_API_KEY for the model.");
  }
  const app = APP;
  // Each run serves the app on its own hostname: every run's fresh server asks Let's Encrypt for a
  // certificate, and it issues only 5 per week for the same names.
  const domain = withDns ? runHostname(E2E.domain as string, newRunId()) : undefined;
  expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
  const work = await mkdtemp(join(tmpdir(), "opscrew-e2e-"));
  const repo = join(work, "repo");
  const home = join(work, "home");
  await mkdir(repo);
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
  /** Merges the open pull request from `head`, checks `main` out again and returns the merge commit. */
  const mergePullRequest = async (head: string) => {
    const pull = await github.openPullRequest(head);
    expect(pull, `an open pull request from ${head}`).toBeDefined();
    const sha = await github.merge(pull as number);
    await git("fetch", "-q", "origin");
    await git("checkout", "-q", "-B", "main", "origin/main");
    return sha;
  };
  /** Commits only `files` on `branch`, then merges its new pull request like the ones above. */
  const mergeFiles = async (branch: string, message: string, files: readonly string[]) => {
    await git("checkout", "-q", "-B", branch);
    await git("add", "--", ...files);
    await git("commit", "-q", "-m", message);
    await git("push", "-q", "--force", "origin", branch);
    const sha = await github.merge(await github.createPullRequest(message, branch));
    await git("fetch", "-q", "origin");
    await git("checkout", "-q", "-B", "main", "origin/main");
    return sha;
  };

  // A fresh copy of the app becomes the throwaway repository's main branch.
  console.log(`OpsCrew E2E: deploying ${app.label} on ${provider.name}`);
  await materializeApp(app, repo);
  // Production values the app needs and OpsCrew cannot derive or generate (OPSCREW_E2E_APP_ENV).
  await writeFile(
    join(work, "production.env"),
    E2E.appEnvFile ? await readFile(E2E.appEnvFile, "utf8") : "",
  );
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "OpsCrew E2E");
  await git("config", "user.email", "e2e@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`);
  await git("remote", "add", "origin", `https://github.com/${github.name}.git`);
  await git("add", "-A");
  await git("commit", "-q", "-m", `e2e: ${app.label}`);
  await git("push", "-q", "--force", "origin", "main");
  await github.reset();

  let appName: string | undefined;
  /** The shared Cloudflare rules the app's hostnames belong in (none without a domain). */
  let sharedRules: AppRules = {};
  /** With a Cloudflare domain, from just before the provision on. */
  let shared: SharedZone | undefined;
  try {
    expect((await opscrew("analyze", ...aiFlags)).exitCode).toBe(0);
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
        ...(domain ? { domain } : {}),
        keepExternalServices: [],
        ...options.answers,
      }),
    );
    expect((await opscrew("interview", "--answers", join(work, "answers.json"))).exitCode).toBe(0);
    expect((await opscrew("design")).exitCode).toBe(0);
    const plan = await readArtifact("plan", join(repo, "opscrew/plan.yaml"));
    appName = plan.app.name;
    expect(plan.target.provider).toBe(provider.id);
    if (withDns) sharedRules = appRules(plan);

    const adapt = await opscrew("adapt", ...aiFlags, "--yes");
    expect(adapt.exitCode, adapt.output).toBe(0);
    const branches = await git(
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/opscrew/prepare-deploy*",
    );
    await mergePullRequest(branches.split(/\r?\n/)[0] as string);

    if (withDns) {
      const cloudflare = new Cloudflare(E2E.cloudflareToken as string);
      const zone = await cloudflare.zoneOf(E2E.domain as string);
      shared = { cloudflare, zone, before: await cloudflare.sharedEntrypoints(zone) };
    }
    const planned = await opscrew("provision", "--plan-only", "--yes");
    expect(planned.exitCode, planned.output).toBe(0);
    // With a Cloudflare domain the Cloudflare plan comes first; every printed plan is approved.
    const hashes = approveHashes(planned.output);
    expect(hashes.length, "the plan hashes are printed").toBeGreaterThan(0);
    const applied = await opscrew(
      "provision",
      ...hashes.flatMap((hash) => ["--approve", hash]),
      "--yes",
    );
    expect(applied.exitCode, applied.output).toBe(0);
    if (shared !== undefined) await expectInSharedRules(shared, sharedRules, true);
    // OpsCrew picks the next free name (`opscrew/deploy-setup-2`) when an earlier pass's branch is
    // still on GitHub, so take the branch provision created, like the adapt branch above.
    const deployBranch = (
      await git("for-each-ref", "--format=%(refname:short)", "refs/heads/opscrew/deploy-setup*")
    ).split(/\r?\n/)[0];
    expect(deployBranch, "provision created its deploy branch").toBeTruthy();
    const mergeSha = await mergePullRequest(deployBranch as string);

    // The merge to main triggers the deploy workflow; wait for the run of that exact commit (a
    // run of an earlier pass on the same repository never counts).
    const deployed = await github.waitForDeploy({ headSha: mergeSha }, minutes(25));
    expect(deployed.conclusion, "the deploy workflow succeeded").toBe("success");

    const verify = await opscrew("verify");
    expect(verify.exitCode, verify.output).toBe(0);
    // The app answers on the health path OpsCrew planned for it (not a framework default).
    const deployedPlan = await readArtifact("plan", join(repo, "opscrew/plan.yaml"));
    const ipv4 = (await readServerAddresses(resolveProjectPaths(repo, { env }))).deployment?.ipv4;
    const health = new URL(
      deployedPlan.app.healthPath,
      deployedPlan.deployment.url ?? `http://${ipv4}`,
    );
    const answered = await fetch(health);
    console.log(
      `OpsCrew E2E: ${app.label} answered ${answered.status} on ${deployedPlan.app.healthPath}`,
    );
    expect(answered.status, `GET ${deployedPlan.app.healthPath}`).toBe(200);
    const secure = await opscrew("secure");
    expect(secure.output).toContain("SECURITY_REPORT.md");
    const drift = await opscrew("drift");
    expect(drift.exitCode, drift.output).toBe(0);
    await expectAddressUnpublished(repo, env, startedAt);
    console.log(`OpsCrew E2E: ${app.label} deployed, verified, secured and drift-free`);

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
      await options.afterDeploy({
        repo,
        env,
        github,
        deployed: { runId: deployed.id, sha: mergeSha },
        appName: appName as string,
        ssh,
        opscrew,
        mergeFiles,
      });
    }
  } finally {
    // The user's own teardown first (SC-301); the IaC and API fallbacks only if it fails.
    const involved = [provider, ...(options.alsoTokens ?? [])];
    const current = await readArtifact("plan", join(repo, "opscrew/plan.yaml"))
      .then((plan) => ({ provider: plan.target.provider, moving: plan.retarget !== undefined }))
      .catch(() => ({ provider: provider.id, moving: false }));
    const live = involved.find((p) => p.id === current.provider) ?? provider;
    let destroyed = false;
    if (options.skipDestroy === true) {
      console.log(
        "OpsCrew E2E: skipping opscrew destroy (OPSCREW_E2E_SKIP_DESTROY=1): the fallback cleanup runs instead",
      );
    } else if (appName !== undefined && !current.moving) {
      const destroy = await opscrew("destroy", "--confirm", appName, "--no-snapshot").catch(
        () => undefined,
      );
      destroyed = destroy?.exitCode === 0;
      if (!destroyed) {
        console.error(`opscrew destroy failed; falling back:\n${destroy?.output ?? ""}`);
      }
    }
    if (!destroyed && shared !== undefined) {
      // Without the destroy the app's hostnames stay in OpsCrew's shared rules, and the next run
      // would stop at them: remove them (rules holding only them, as `removeRulesOfRun` decides).
      // It never throws, so the servers' teardown below always runs.
      const problems = await shared.cloudflare
        .removeRulesOfRun(shared.zone, shared.before, {
          hostnames: [...new Set(Object.values(sharedRules).flat())],
          log: (message) => console.log(`OpsCrew E2E: ${message}`),
        })
        .catch((error: unknown) => [String(error)]);
      for (const problem of problems) console.error(`OpsCrew E2E: ${problem}`);
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
      if (shared !== undefined) await removeRecordsOfRun(shared, sharedRules);
    }
    // After the destroy or its fallback, no shared rule may list the app's hostnames.
    // … and no DNS record on them is left in the zone.
    if (shared !== undefined) {
      await expectInSharedRules(shared, sharedRules, false);
      await expectNoRecordsLeft(shared, sharedRules);
    }
    // The throwaway repository keeps only `main`, as the own-server and Portainer runs leave it.
    await github.reset();
  }
}

/**
 * The server's address (from `.opscrew/server.json`) is in no commit message and no pull request
 * title or body of the repository (any state), and, when the domain is behind Cloudflare's proxy,
 * in no tracked file: a published origin address would let anyone go around Cloudflare.
 */
async function expectAddressUnpublished(
  repo: string,
  env: Record<string, string | undefined>,
  since: Date,
): Promise<void> {
  const address = (await readServerAddresses(resolveProjectPaths(repo, { env }))).deployment;
  expect(address, "the server's address is recorded in .opscrew/server.json").toBeDefined();
  const needles = [address?.ipv4, address?.ipv6].filter((value): value is string => Boolean(value));
  const git = (...args: string[]) => runner.run("git", ["-C", repo, ...args], { env });

  const fetched = await git("fetch", "-q", "origin");
  expect(fetched.exitCode, `git fetch: ${fetched.stderr}`).toBe(0);
  const log = await git("log", "--all", "--format=%B");
  expect(log.exitCode, `git log: ${log.stderr}`).toBe(0);
  for (const needle of needles) {
    expect(log.stdout.includes(needle), "the server address in a commit message").toBe(false);
  }

  for (const pull of await github.pullRequestTexts()) {
    const named = needles.some((needle) => pull.text.includes(needle));
    if (pull.createdAt >= since) {
      expect(named, `the server address in pull request #${pull.number}`).toBe(false);
    } else if (named) {
      // Older runs' pull requests stay in the repository and Hetzner reuses addresses, so one
      // from before T814 may name the address this server was given: worth knowing, not this
      // run's leak. The address itself is never printed.
      console.warn(
        `OpsCrew E2E: pull request #${pull.number} (opened ${pull.createdAt.toISOString()}, before this run) contains this server's address; an earlier server had the same one. Edit its description if it should not be public.`,
      );
    }
  }

  const plan = await readArtifact("plan", join(repo, "opscrew/plan.yaml"));
  if (plan.dns.provider === "cloudflare" && plan.dns.domain && plan.dns.proxied) {
    const grep = await git("grep", "-n", "-F", ...needles.flatMap((needle) => ["-e", needle]));
    // git grep exits 1 when nothing matches.
    expect(grep.exitCode, `the server address in tracked files:\n${grep.stdout}`).toBe(1);
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
