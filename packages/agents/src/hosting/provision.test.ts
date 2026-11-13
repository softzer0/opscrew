// Feature 027 (T2711): `opscrew provision` for an app on a hosting account, through each panel's
// fakes, the agent's part played by the test (its report, its answers to requests).
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeCpanel, type FakeCpanelOptions, fakeCpanel } from "@opscrew/connector-cpanel";
import { FakeDirectAdmin } from "@opscrew/connector-directadmin";
import { fakePlesk } from "@opscrew/connector-plesk";
import type { ApprovalRequest, FetchLike, HostingFiles } from "@opscrew/contracts";
import { NodeCommandRunner, OpsCrewError } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import {
  type HostingDeployTarget,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import { runProvision } from "../provision/run";
import type { ProvisionOptions } from "../provision/types";
import { requireGitRepo } from "../shared";
import {
  createTestPhaseDeps,
  FakeEngine,
  fakeCloudflare,
  makeRequirements,
  projectRunner,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
} from "../testing";
import { LoggedGitHub, PAGES_REPO } from "../testing/pages";
import { agentCronCommand } from "./php";
import { HostingPlanSchema, hostingPlanFile } from "./plan";
import { type HostingProvisionServices, provisionHosting } from "./provision";
import {
  type HostingRecord,
  hostingRecordFile,
  readHostingRecord,
  updateHostingRecord,
} from "./record";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const TOKEN = fakeSecret("generic-password", "hosting-provision");
const GITHUB_TOKEN = fakeSecret("github-token", "hosting-provision");
const CLOUDFLARE_TOKEN = fakeSecret("cloudflare-token", "hosting-provision");
const PANEL_URL = "https://panel.example.com:2083";
const CPANEL = { kind: "cpanel", url: PANEL_URL, user: "acct" } as const;
const FOLDER = "opscrew/notes-prod";
const HOSTNAME = "notes.example.com";
/** GitHub's SSH host key, as `/meta` lists it (public). */
const GITHUB_HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
/** The agent's own read-only GitHub key, as its report gives it (public). */
const AGENT_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeagentkeyfortestsonlyopscrewhostingagent opscrew-notes-prod";
/** The app's own value, which the settings file holds and no output may show. */
const APP_SECRET = fakeSecret("generic-password", "hosting-app-value");

/** Every module a CloudLinux alt-php CLI loads by default (research R11). */
const BASE =
  "Core,ctype,curl,date,json,openssl,PDO,pdo_mysql,mysqli,session,tokenizer,xml,Zend OPcache";
const ALL = `${BASE},mbstring,fileinfo,intl,gd,zip`;

/** The agent's first report on the founder's kind of account: PHP 7.0, alt-php 8.0 to 8.5. */
function report(
  o: { account?: string; github?: boolean; git?: boolean; extra?: string[] } = {},
): string {
  const php = [
    ["/usr/local/bin/php", o.account ?? "7.0.33", ALL],
    ...["80", "81", "82", "83", "84", "85"].map((v) => [
      `/opt/alt/php${v}/usr/bin/php`,
      `${v[0]}.${v.slice(1)}.4`,
      BASE,
    ]),
  ];
  return [
    `public_key=${AGENT_KEY}`,
    ...php.flatMap(([path, version, modules], i) => [
      `php.${i + 1}.path=${path}`,
      `php.${i + 1}.version=PHP ${version} (cli) (built: Nov  1 2026 10:00:00) ( NTS )`,
      `php.${i + 1}.modules=${modules}`,
    ]),
    ...(o.extra ?? []),
    ...["git", "openssl", "flock", "mysqldump", "tar", "curl", "ssh", "ssh-keygen"].map(
      (tool) => `tool.${tool}=${tool === "git" && o.git === false ? "no" : "yes"}`,
    ),
    `github.22=${o.github === false ? "no" : "yes"}`,
    `github.443=${o.github === false ? "no" : "yes"}`,
    "",
  ].join("\n");
}

/** GitHub's API as OpsCrew's own client reaches it: `/meta` and the repository's deploy keys. */
function fakeGithubApi() {
  const keys: { id: number; title: string; key: string; read_only: boolean }[] = [];
  let next = 4000;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/meta") return json(200, { ssh_keys: [GITHUB_HOST_KEY] });
    if (url.pathname === `/repos/${PAGES_REPO.owner}/${PAGES_REPO.repo}/keys`) {
      if ((init?.method ?? "GET") === "GET") return json(200, keys);
      const body = JSON.parse(String(init?.body)) as { title: string; key: string };
      const key = {
        id: next++,
        title: body.title,
        key: body.key.split(" ").slice(0, 2).join(" "),
        read_only: true,
      };
      keys.push(key);
      return json(201, key);
    }
    const removed = new RegExp(`^/repos/${PAGES_REPO.owner}/${PAGES_REPO.repo}/keys/(\\d+)$`).exec(
      url.pathname,
    );
    if (removed !== null && init?.method === "DELETE") {
      const index = keys.findIndex((key) => key.id === Number(removed[1]));
      if (index === -1) return json(404, { message: "Not Found" });
      keys.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: "Not Found" });
  };
  return { keys, fetch };
}

/** The account's main domain answers with LiteSpeed; GitHub's API; everything else the panel. */
function router(panel: FetchLike, github: FetchLike): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "example.com") {
      return new Response("", { status: 301, headers: { server: "LiteSpeed" } });
    }
    if (url.hostname === "api.github.com") return github(input, init);
    return panel(input, init);
  };
}

/** A fake account as the agent on it sees it. */
interface Account {
  panel: { kind: "cpanel" | "plesk" | "directadmin"; url: string; user: string };
  fetch: FetchLike;
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  remove(path: string): void;
  paths(): string[];
  /** The agent's cron line is there (one the user added in the panel counts). */
  agentRuns(): boolean;
}

function cpanelAccount(fake: FakeCpanel): Account {
  return {
    panel: CPANEL,
    fetch: fake.fetch,
    read: (path) => fake.readText(path),
    write: (path, text) => fake.writeText(path, text, 0o600),
    remove: (path) => fake.state.files.delete(path),
    paths: () => [...fake.state.files.keys()],
    agentRuns: () => fake.state.cron.some((line) => line.command === agentCronCommand(FOLDER)),
  };
}

function directAdminAccount(fake: FakeDirectAdmin): Account {
  return {
    panel: { kind: "directadmin", url: fake.access.url, user: fake.access.user },
    fetch: fake.fetch,
    read: (path) => fake.text(path),
    write: (path, text) =>
      fake.files.set(path, { type: "file", content: new TextEncoder().encode(text), mode: 0o600 }),
    remove: (path) => fake.files.delete(path),
    paths: () => [...fake.files.keys()],
    agentRuns: () =>
      [...fake.cron.values()].some((line) => line.endsWith(agentCronCommand(FOLDER))),
  };
}

/**
 * A Plesk subscription: its files reached over what stands in for SFTP (`files`), and its
 * scheduled task a step the user takes in the panel (`cron.added`).
 */
function pleskAccount(
  fake: ReturnType<typeof fakePlesk>,
  files: MemoryFiles,
  cron: { added: boolean },
): Account {
  return {
    panel: { kind: "plesk", url: fake.url, user: fake.login },
    fetch: fake.fetch,
    read: (path) => files.files.get(path),
    write: (path, text) => files.files.set(path, text),
    remove: (path) => files.files.delete(path),
    paths: () => [...files.files.keys()],
    agentRuns: () => cron.added,
  };
}

/** The entries of a ustar archive: files with their text, folders and links. */
function untar(bytes: Uint8Array): { name: string; type: string; text: string; target: string }[] {
  const field = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, "");
  const entries = [];
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const name = field(offset, 100);
    if (name === "") break;
    const size = Number.parseInt(field(offset + 124, 12) || "0", 8);
    const type = field(offset + 156, 1) || "0";
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    entries.push({
      name: name.replace(/\/$/, ""),
      type,
      text: new TextDecoder().decode(body),
      target: field(offset + 157, 100),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** An account's files in memory (what stands in for SFTP on Plesk). */
class MemoryFiles implements HostingFiles {
  readonly files = new Map<string, string>();
  readonly links = new Map<string, string>();
  async writeFile(path: string, content: Uint8Array) {
    this.files.set(path, new TextDecoder().decode(content));
  }
  async uploadTar(folder: string, tar: Uint8Array) {
    for (const entry of untar(tar)) {
      const path = folder === "." ? entry.name : `${folder}/${entry.name}`;
      if (entry.type === "0") this.files.set(path, entry.text);
      if (entry.type === "2") this.links.set(path, entry.target);
    }
  }
  async readFile(path: string) {
    return this.files.get(path);
  }
  async list() {
    return [];
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

/**
 * The agent on a fake account, run at each of OpsCrew's waits: its first report once its cron line
 * is there, then an answer to each request (an `env` request puts `.env.next` in place), each
 * request's text logged in `requests`.
 */
function agent(account: Account, text: () => string, requests: string[] = []) {
  return async () => {
    if (account.agentRuns() && account.read(`${FOLDER}/state/report`) === undefined) {
      account.write(`${FOLDER}/state/report`, text());
    }
    for (const path of account.paths()) {
      const match = new RegExp(`^${FOLDER}/requests/([0-9a-f]{64})\\.req$`).exec(path);
      if (match === null) continue;
      requests.push(account.read(path) ?? "");
      const next = account.read(`${FOLDER}/shared/.env.next`);
      if (/^kind=env$/m.test(account.read(path) ?? "") && next !== undefined) {
        account.write(`${FOLDER}/shared/.env`, next);
        account.remove(`${FOLDER}/shared/.env.next`);
      }
      account.write(`${FOLDER}/state/${match[1]}.result`, "result=done\n");
      account.remove(path);
    }
  };
}

interface ProjectOptions {
  example?: string;
  requirements?: Partial<Requirements>;
  /** The agent's report (default: {@link report}'s). */
  report?: () => string;
  /** Provision through `provisionHosting` with these collaborators. */
  hosting?: HostingProvisionServices;
}

/**
 * `examples/<example>` as a git project with a GitHub `origin` (pushes go to a bare repository),
 * analysed, interviewed for `account` and designed; `run` provisions it once.
 */
async function project(account: Account, o: ProjectOptions = {}) {
  const runner = new NodeCommandRunner();
  const tmp = tmpdir();
  const root = await mkdtemp(join(tmp, "opscrew-hosting-provision-"));
  const bare = await mkdtemp(join(tmp, "opscrew-hosting-remote-"));
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await materializeFixture(join(EXAMPLES, o.example ?? "php-plain-mysql"), root);
  await writeFile(join(root, ".gitignore"), ".opscrew/\n.env\nproduction.env\n");
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  const origin = `https://github.com/${PAGES_REPO.owner}/${PAGES_REPO.repo}.git`;
  await git(root, "remote", "add", "origin", origin);
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "init");
  await git(root, "push", "-q", "origin", "main");
  const github = fakeGithubApi();
  const fetch = router(account.fetch, github.fetch);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(root, ".home-opscrew"),
    GITHUB_TOKEN,
    GH_TOKEN: undefined,
    CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN,
    OPSCREW_HOSTING_URL: account.panel.url,
    OPSCREW_HOSTING_USER: account.panel.user,
    OPSCREW_HOSTING_TOKEN: TOKEN,
    OPSCREW_APP_ENV_FILE: "production.env",
  };
  await writeFile(join(root, "production.env"), `NOTES_API_KEY='Notes ${APP_SECRET}'\n`);
  const deps = await createTestPhaseDeps({ root, env, fetch, runner: projectRunner() });
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-11-12T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: { ...(await detectProject(root)), name: "notes" },
    summary: "An app.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({
      provider: "hosting",
      region: undefined,
      domain: HOSTNAME,
      dnsProvider: "other",
      ...o.requirements,
    }),
  );
  await updateHostingRecord(deps.paths, () => ({
    schemaVersion: 1,
    objects: [],
    panel: account.panel,
  }));
  await runDesign(deps);
  // A value of the user's own, which the settings file holds and no output may show.
  const designed = await readArtifact("plan", deps.paths.files.plan);
  await writeArtifact("plan", deps.paths.files.plan, {
    ...designed,
    app: {
      ...designed.app,
      env: [...designed.app.env, { name: "NOTES_API_KEY", secret: true, source: "user" }],
    },
  });
  const text = o.report ?? (() => report());
  const requests: string[] = [];
  const engine = new FakeEngine({
    changes: [
      {
        address: "module.dns.cloudflare_dns_record.a",
        type: "cloudflare_dns_record",
        name: "a",
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        action: "create",
      },
    ],
    planJson: { format_version: "1.2", resource_changes: [] },
    outputs: { url: `https://${HOSTNAME}` },
  });
  const cloudflare = fakeCloudflare({});
  /** One provision run: its deps, the approvals asked, and its result or error. */
  const run = async (
    options: Omit<ProvisionOptions, "services"> & {
      answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
    } = {},
  ) => {
    const { answer, ...provision } = options;
    const handler = new ScriptedApprovalHandler(answer ?? (() => true));
    const runDeps = await createTestPhaseDeps({
      root,
      env,
      fetch,
      runner: projectRunner(),
      approvalHandler: handler,
    });
    const log: string[] = [];
    const services = {
      github: new LoggedGitHub(log),
      engine: async () => engine,
      cloudflare,
      sleep: agent(account, text, requests),
    };
    const work =
      o.hosting === undefined
        ? runProvision(runDeps, { ...provision, services })
        : provisionHosting(
            runDeps,
            { ...provision, services },
            {
              plan: await readArtifact("plan", runDeps.paths.files.plan),
              requirements: undefined,
              git: await requireGitRepo(runDeps),
            },
            o.hosting,
          );
    const outcome = await work.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { deps: runDeps, handler, log, services, ...outcome };
  };
  /** GitHub merges the provision pull request, and this clone pulls main. */
  const merge = async () => {
    const branch = await git(root, "branch", "--show-current");
    if (branch === "main") return;
    await git(bare, "update-ref", "refs/heads/main", await git(root, "rev-parse", "HEAD"));
    await git(root, "checkout", "-q", "main");
    await git(root, "merge", "-q", "--ff-only", branch);
  };
  return { root, github, engine, run, merge, requests };
}

/** A project on a fake cPanel account. */
async function setup(o: ProjectOptions & { cpanel?: Partial<FakeCpanelOptions> } = {}) {
  const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com", ...o.cpanel });
  return { ...(await project(cpanelAccount(fake), o)), fake };
}

/** Every hash-bound approval asked, as `<kind>`. */
const kinds = (requests: readonly ApprovalRequest[]) => requests.map((request) => request.kind);

const said = (deps: TestPhaseDeps) => deps.reporter.text();

async function record(root: string): Promise<HostingRecord> {
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew") },
  });
  return (await readHostingRecord(deps.paths)) as HostingRecord;
}

/** The fake's calls that change the account. */
const changes = (fake: FakeCpanel) =>
  fake.calls
    .filter((call) =>
      /^(add|create|delete|set_|set|save|upload|fileop|start_|php_set|remove|del)/.test(call.func),
    )
    .map((call) =>
      call.func === "fileop"
        ? `${call.module}::fileop ${call.params.op}`
        : `${call.module}::${call.func}`,
    );

describe("provision on a cPanel account", () => {
  it("installs the agent, sets the app up from its report, and opens the pull request", async () => {
    const s = await setup();
    const { deps, handler, error, result, log, services } = await s.run();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ applied: true, outputs: { url: `https://${HOSTNAME}` } });

    // Two hosting plans, each approved by its hash, plan B storing the signing key in GitHub (its
    // own approval); then the deploy key, the files.
    expect(kinds(handler.requests)).toEqual([
      "hosting-apply",
      "hosting-apply",
      "github-secrets",
      "github-settings",
      "repo-write",
      "git-push",
      "pull-request",
    ]);
    const [a, b] = handler.requests;
    const agentPlan = HostingPlanSchema.parse(
      JSON.parse(await readFile(hostingPlanFile(deps.paths, "prod", "agent"), "utf8")),
    );
    const appPlan = HostingPlanSchema.parse(
      JSON.parse(await readFile(hostingPlanFile(deps.paths, "prod", "app"), "utf8")),
    );
    expect(agentPlan.steps.map((step) => step.kind)).toEqual(["folder", "cron"]);
    expect(appPlan.steps.map((step) => step.kind)).toEqual([
      "signing-key",
      "database",
      "values",
      "file",
      "file",
      "hostname",
      "cron",
      "certificate",
    ]);
    expect(a?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.details).toContain("Hosting plan B (the app) for notes.example.com");

    // The agent's folder, its files and modes, and its cron line.
    expect(s.fake.readText(`${FOLDER}/agent.sh`)).toMatch(/^#!\/bin\/bash/);
    expect(s.fake.state.files.get(`${FOLDER}/agent.sh`)).toMatchObject({ mode: 0o700 });
    expect(s.fake.readText(`${FOLDER}/keys/known_hosts`)).toBe(
      `github.com ${GITHUB_HOST_KEY}\n[ssh.github.com]:443 ${GITHUB_HOST_KEY}\n`,
    );
    expect(s.fake.readText(`${FOLDER}/keys/release.pub`)).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(s.fake.state.cron.map((line) => line.command)).toContain(agentCronCommand(FOLDER));

    // The settings: the chosen PHP (the handler line on LiteSpeed, R11), no secret.
    const settings = s.fake.readText(`${FOLDER}/settings.sh`) ?? "";
    expect(settings).toContain("PHP_CLI='/opt/alt/php83/usr/bin/php'");
    expect(settings).toContain("PHP_HANDLER='application/x-httpd-alt-php83___lsphp'");
    expect(settings).toContain("DATABASE='acct_notes'");
    expect(settings).toContain("SNAPSHOTS='yes'");

    // The database, its password only in .env and mysql.cnf (0600), and env.php.
    expect([...s.fake.state.databases.keys()]).toEqual(["acct_notes"]);
    const values = s.fake.readText(`${FOLDER}/shared/.env`) ?? "";
    expect(values).toContain("DB_DATABASE=acct_notes\n");
    expect(values).toContain("DB_HOST=localhost\n");
    expect(values).toContain(`NOTES_API_KEY='Notes ${APP_SECRET}'`);
    const password = /^DB_PASSWORD=(\S+)$/m.exec(values)?.[1] ?? "";
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(s.fake.readText(`${FOLDER}/shared/mysql.cnf`)).toContain(`password=${password}`);
    for (const path of [".env", "mysql.cnf", "env.php"]) {
      expect(s.fake.state.files.get(`${FOLDER}/shared/${path}`)).toMatchObject({ mode: 0o600 });
    }
    expect(s.fake.readText(`${FOLDER}/shared/env.php`)).toContain("'DB_PASSWORD' => true,");

    // The hostname on the release, its cron line with the chosen PHP.
    expect(s.fake.state.domains.find((d) => d.name === HOSTNAME)?.documentRoot).toBe(
      `${FOLDER}/current/public`,
    );
    expect(s.fake.state.cron.map((line) => line.command)).toContain(
      `cd "$HOME/${FOLDER}/current" && /opt/alt/php83/usr/bin/php -d auto_prepend_file="$HOME/${FOLDER}/shared/env.php" bin/cron.php >> "$HOME/${FOLDER}/state/cron.log" 2>&1`,
    );

    // GitHub: the agent's read-only key, the signing key as the deploy secret.
    expect(s.github.keys).toEqual([
      expect.objectContaining({ title: "opscrew-notes-prod", read_only: true }),
    ]);
    expect(log).toContain("github secret OPSCREW_RELEASE_SIGNING_KEY");
    expect(log).toContain("github pull request");
    const body = services.github.pulls[0]?.body ?? "";
    expect(body).toContain("`opscrew/hosting/agent.sh`: OpsCrew's agent");
    expect(body).toContain("`opscrew/release/prod`");
    expect(body).not.toContain("acct");
    expect(deps.audit.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "hosting apply started",
        "hosting change folder",
        "hosting change hostname",
      ]),
    );

    // The committed files: the workflow, the agent and its settings.
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect((plan.target as HostingDeployTarget).php).toEqual({ version: "8.3", via: "handler" });
    expect(await readFile(join(s.root, "opscrew/hosting/agent.sh"), "utf8")).toBe(
      s.fake.readText(`${FOLDER}/agent.sh`),
    );
    expect(await readFile(join(s.root, "opscrew/hosting/prod.sh"), "utf8")).toBe(settings);
    expect(await readFile(join(s.root, plan.cicd.workflowPath), "utf8")).toContain(
      "opscrew/release/prod",
    );

    // Everything made is recorded with the panel's key, the hostname's own certificate too.
    const made = await record(s.root);
    expect(made.objects.find((o) => o.kind === "certificate")?.key).toBe(
      s.fake.state.installed.get(HOSTNAME),
    );
    expect(made.objects.map((o) => o.kind).sort()).toEqual([
      "certificate",
      "cron",
      "cron",
      "database",
      "deploy-key",
      "file",
      "folder",
      "hostname",
      "signing-key",
    ]);
    expect(said(deps)).toContain(
      "PHP: the app gets PHP 8.3, CloudLinux's PHP 8.3 through the hostname's handler line",
    );
  });

  it("keeps one signing key: a replaced public half gets a new pair once, then nothing", async () => {
    const s = await setup();
    expect((await s.run()).error).toBeUndefined();
    await s.merge();
    s.fake.writeText(`${FOLDER}/keys/release.pub`, "-----BEGIN PUBLIC KEY-----\nother\n");
    const second = await s.run();
    expect(second.error).toBeUndefined();
    // Then the plan, which records the approvals, in a pull request.
    expect(kinds(second.handler.requests).slice(0, 2)).toEqual(["hosting-apply", "github-secrets"]);
    await s.merge();
    const third = await s.run();
    expect(third.error).toBeUndefined();
    expect(kinds(third.handler.requests)).toEqual([]);
    const made = await record(s.root);
    expect(made.objects.filter((o) => o.kind === "signing-key")).toHaveLength(1);
  });

  it("replaces the agent's deploy key once when the agent made a new one", async () => {
    const s = await setup();
    expect((await s.run()).error).toBeUndefined();
    await s.merge();
    const [first] = s.github.keys;
    const other =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherAgentKeyAfterTheAgentMadeANewOne1 opscrew";
    s.fake.writeText(
      `${FOLDER}/state/report`,
      (s.fake.readText(`${FOLDER}/state/report`) ?? "").replace(
        /^public_key=.*$/m,
        `public_key=${other}`,
      ),
    );
    const second = await s.run();
    expect(second.error).toBeUndefined();
    expect(kinds(second.handler.requests)).toEqual(["github-settings"]);
    expect(second.handler.requests[0]?.details).toContain(
      `It replaces the agent's earlier key, which OpsCrew removes from ${PAGES_REPO.owner}/${PAGES_REPO.repo} (GitHub's id ${first?.id}).`,
    );
    expect(s.github.keys.map((key) => key.key)).toEqual([other.split(" ").slice(0, 2).join(" ")]);
    const third = await s.run();
    expect(third.error).toBeUndefined();
    expect(kinds(third.handler.requests)).toEqual([]);
    expect(s.github.keys).toHaveLength(1);
    const made = await record(s.root);
    expect(made.objects.filter((o) => o.kind === "deploy-key")).toHaveLength(1);
  });

  it("gives the hash of each hosting plan that changes something, for --approve", async () => {
    const s = await setup();
    // --plan-only: plan A only (plan B comes from the agent's report), nothing changed.
    const planned = await s.run({ planOnly: true });
    expect(planned.error).toBeUndefined();
    expect(planned.handler.requests).toEqual([]);
    expect(changes(s.fake)).toEqual([]);
    const agentHashes = planned.result?.hostingPlanHashes ?? [];
    expect(agentHashes).toHaveLength(1);
    expect(said(planned.deps)).toContain(`Hosting plan hash: ${agentHashes[0]}`);

    // The run that applies both gives plan A's hash, then plan B's, as their approvals bound them.
    const applied = await s.run();
    expect(applied.error).toBeUndefined();
    const bound = applied.handler.requests
      .filter((request) => request.kind === "hosting-apply")
      .map((request) => request.planHash);
    expect(applied.result?.hostingPlanHashes).toEqual(bound);
    expect(bound[0]).toBe(agentHashes[0]);

    // A run again with nothing new names no hosting plan.
    await s.merge();
    const again = await s.run({ planOnly: true });
    expect(again.error).toBeUndefined();
    expect(again.result?.hostingPlanHashes).toBeUndefined();
  });

  it("changes nothing on a run again with nothing new", async () => {
    const s = await setup();
    expect((await s.run()).error).toBeUndefined();
    await s.merge();
    const before = changes(s.fake).length;
    const again = await s.run();
    expect(again.error).toBeUndefined();
    expect(kinds(again.handler.requests)).not.toContain("hosting-apply");
    expect(kinds(again.handler.requests)).not.toContain("github-secrets");
    expect(changes(s.fake).length).toBe(before);
    expect(said(again.deps)).toContain("Hosting plan A (the agent) has nothing to change");
    expect(said(again.deps)).toContain("Hosting plan B (the app) has nothing to change");
  });

  it("records the hostname's own certificate, in any case, and never one it didn't make (R13)", async () => {
    const certificates = async (certificateNames: (hostname: string) => string[]) => {
      const s = await setup({ cpanel: { certificateNames } });
      expect((await s.run()).error).toBeUndefined();
      expect(s.fake.state.installed.has(HOSTNAME)).toBe(true);
      const made = await record(s.root);
      return made.objects.filter((o) => o.kind === "certificate").map((o) => o.key);
    };
    const upper = await certificates((h) => [h.toUpperCase(), `WWW.${h.toUpperCase()}`]);
    expect(upper).toHaveLength(1);
    // The domain's AutoSSL wildcard, installed on the new hostname.
    expect(await certificates(() => ["*.example.com", "example.com"])).toEqual([]);
    // A certificate that also names another host.
    expect(await certificates((h) => [h, `www.${h}`, "shop.example.com"])).toEqual([]);
  });

  it("writes .env.next and an env request when only the values changed", async () => {
    const s = await setup();
    expect((await s.run()).error).toBeUndefined();
    const before = s.fake.readText(`${FOLDER}/shared/.env`) ?? "";
    const password = /^DB_PASSWORD=(\S+)$/m.exec(before)?.[1];
    await s.merge();
    await writeFile(join(s.root, "production.env"), "NOTES_API_KEY='Notes, renamed'\n");
    const again = await s.run();
    expect(again.error).toBeUndefined();
    const plan = HostingPlanSchema.parse(
      JSON.parse(await readFile(hostingPlanFile(again.deps.paths, "prod", "app"), "utf8")),
    );
    expect(plan.steps).toEqual([expect.objectContaining({ kind: "values", file: ".env.next" })]);
    const after = s.fake.readText(`${FOLDER}/shared/.env`) ?? "";
    expect(after).toContain("NOTES_API_KEY='Notes, renamed'");
    // The database keeps its password.
    expect(after).toContain(`DB_PASSWORD=${password}\n`);
    expect(s.fake.calls.filter((call) => call.func === "create_database")).toHaveLength(1);
    expect(kinds(again.handler.requests).filter((kind) => kind === "hosting-apply")).toHaveLength(
      1,
    );
  });

  it("stops before any change for a hostname the account serves and OpsCrew didn't make", async () => {
    const s = await setup();
    s.fake.state.domains.push({ name: HOSTNAME, kind: "subdomain", documentRoot: "notes" });
    const { error, handler } = await s.run();
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      "The account already serves notes.example.com, and OpsCrew's record",
    );
    expect(handler.requests).toEqual([]);
    expect(changes(s.fake)).toEqual([]);
  });

  it("stops at a report the account can't deploy with, the agent recorded", async () => {
    const s = await setup({ report: () => report({ github: false }) });
    const { error } = await s.run();
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "The hosting account can't run OpsCrew's deploys: the account can't reach GitHub over SSH, on port 22 or on ssh.github.com's port 443, so the agent can't fetch releases. The agent and its cron line are installed and recorded; nothing else was made.",
    );
    expect((error as OpsCrewError).hint).toContain("allow outgoing SSH");
    const made = await record(s.root);
    expect(made.objects.map((o) => o.kind).sort()).toEqual(["cron", "folder"]);
    // No PHP is chosen before the report fits: the agent's first settings name none.
    expect(s.fake.readText(`${FOLDER}/settings.sh`)).toContain("\nPHP_CLI=''\n");
    expect(s.fake.state.databases.size).toBe(0);
  });

  it("stops before the hostname and the database when no PHP runs the app (plan 5 step 4)", async () => {
    const s = await setup({
      report: () => report().replace(/^php\.[2-7]\..*\n/gm, ""),
    });
    const { error } = await s.run();
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      "The app needs PHP >=8.3 with pdo_mysql, and the account runs PHP 7.0.33.",
    );
    expect(s.fake.state.databases.size).toBe(0);
    expect(s.fake.state.domains.some((d) => d.name === HOSTNAME)).toBe(false);
  });

  it("takes the account's own PHP when it runs the app", async () => {
    const s = await setup({ report: () => report({ account: "8.3.20" }) });
    expect((await s.run()).error).toBeUndefined();
    const settings = s.fake.readText(`${FOLDER}/settings.sh`) ?? "";
    expect(settings).toContain("PHP_CLI='/usr/local/bin/php'");
    expect(settings).toContain("PHP_HANDLER=''");
  });

  it("sets the hostname's PHP through MultiPHP where the account has it", async () => {
    const s = await setup({
      cpanel: { features: { multiphp: 1 }, phpVersions: ["ea-php83", "ea-php84"] },
      report: () =>
        report({
          extra: [
            "php.8.path=/opt/cpanel/ea-php83/root/usr/bin/php",
            "php.8.version=PHP 8.3.11 (cli)",
            `php.8.modules=${ALL}`,
          ],
        }),
    });
    expect((await s.run()).error).toBeUndefined();
    expect(s.fake.state.vhostPhp.get(HOSTNAME)).toBe("ea-php83");
    expect(s.fake.readText(`${FOLDER}/settings.sh`)).toContain(
      "PHP_CLI='/opt/cpanel/ea-php83/root/usr/bin/php'",
    );
  });

  it("makes the link in public_html before the hostname where the panel restricts roots", async () => {
    const s = await setup({ cpanel: { docrootsInPublicHtmlOnly: true } });
    expect((await s.run()).error).toBeUndefined();
    expect(s.fake.state.files.get("public_html/opscrew-notes-prod")).toEqual({
      kind: "link",
      target: `../${FOLDER}/current/public`,
    });
    expect(s.fake.state.domains.find((d) => d.name === HOSTNAME)?.documentRoot).toBe(
      "public_html/opscrew-notes-prod",
    );
    const made = await record(s.root);
    expect(made.objects).toContainEqual({ kind: "link", key: "public_html/opscrew-notes-prod" });
  });

  it("points a hostname on Cloudflare at the account, DNS only, through the IaC approval", async () => {
    const s = await setup({ requirements: { dnsProvider: "cloudflare" } });
    const { error, handler, deps } = await s.run();
    expect(error).toBeUndefined();
    // Only Cloudflare's records: the approval names Cloudflare, no server provider.
    expect(handler.requests.find((request) => request.kind === "iac-apply")?.title).toMatch(
      /^Apply the infrastructure plan on Cloudflare \(1 to create, /,
    );
    const tfvars = JSON.parse(
      await readFile(
        join(
          s.root,
          (await readArtifact("plan", deps.paths.files.plan)).infra.dir,
          "terraform.tfvars.json",
        ),
        "utf8",
      ),
    );
    expect(tfvars).toMatchObject({ domain: HOSTNAME, account_ipv4: "192.0.2.10" });
    expect(s.engine.applied).toHaveLength(1);
  });

  it("makes a Node.js app in CloudLinux's selector through the agent, once (T2717)", async () => {
    const s = await setup({ example: "hono-api" });
    const { deps, handler, error } = await s.run();
    expect(error).toBeUndefined();
    const plan = HostingPlanSchema.parse(
      JSON.parse(await readFile(hostingPlanFile(deps.paths, "prod", "app"), "utf8")),
    );
    const steps = plan.steps.map((step) => step.kind);
    // After the agent's settings and the hostname the selector serves it on.
    expect(steps.indexOf("app")).toBeGreaterThan(steps.indexOf("hostname"));
    expect(steps.indexOf("app")).toBeGreaterThan(steps.indexOf("file"));
    const step = plan.steps.find((candidate) => candidate.kind === "app");
    expect(step).toEqual({
      kind: "app",
      interpreter: "nodejs",
      version: expect.stringMatching(/^\d+/),
      startup: "dist/index.js",
    });
    expect(said(deps)).toContain(
      `Make the Node.js ${step?.kind === "app" ? step.version : ""} app ~/${FOLDER}/app in CloudLinux's selector, started from current/dist/index.js and served at https://${HOSTNAME}/`,
    );

    // The agent's request, bound to plan B's hash; its settings name the runtime.
    const planB = handler.requests.filter((request) => request.kind === "hosting-apply")[1];
    expect(s.requests).toEqual([
      expect.stringMatching(
        new RegExp(`^kind=app\\nhash=${planB?.planHash}\\nexpires=\\d+\\naction=create\\n$`),
      ),
    ]);
    const settings = s.fake.readText(`${FOLDER}/settings.sh`) ?? "";
    expect(settings).toContain("\nAPP_KIND='node'\n");
    expect(settings).toContain(`\nRUNTIME_VERSION='${step?.kind === "app" ? step.version : ""}'\n`);
    expect(settings).toContain("\nSTARTUP_FILE='dist/index.js'\n");
    // The hostname serves the release's public/; Passenger's app root, the release with the
    // source and the linked settings file, stays outside it.
    expect(plan.steps).toContainEqual({
      kind: "hostname",
      hostname: HOSTNAME,
      documentRoot: `${FOLDER}/current/public`,
    });
    expect(settings).toContain("\nWEB_ROOT='public'\n");
    expect(settings).toContain("\nSHARED_PATHS='.env'\n");
    expect((await record(s.root)).objects).toContainEqual({
      kind: "app",
      key: "nodejs",
      value: step?.kind === "app" ? step.version : "",
    });

    // A run again makes nothing new in the selector.
    await s.merge();
    expect((await s.run()).error).toBeUndefined();
    expect(s.requests.filter((request) => request.startsWith("kind=app\n"))).toHaveLength(1);
  });

  it("stops with the agent's reason when the selector can't make the app (T2717)", async () => {
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    const account = cpanelAccount(fake);
    const failing: Account = {
      ...account,
      write: (path, text) =>
        account.write(
          path,
          /\/state\/[0-9a-f]{64}\.result$/.test(path)
            ? "result=failed\nreason=CloudLinux's selector didn't make the app: no version 99\n"
            : text,
        ),
    };
    const s = await project(failing, { example: "hono-api" });
    const { error } = await s.run();
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      "The agent didn't make the app in CloudLinux's selector: CloudLinux's selector didn't make the app: no version 99.",
    );
    expect((error as OpsCrewError).hint).toContain("target.runtime");
    expect((await record(s.root)).objects.some((object) => object.kind === "app")).toBe(false);
  });

  it("records the app and shows the note when the selector refused its settings (T2717)", async () => {
    const note =
      "CloudLinux's selector made the app but refused its settings, so the app gets them only from its .env file until a settings change hands them over again";
    const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com" });
    const account = cpanelAccount(fake);
    const noted: Account = {
      ...account,
      write: (path, text) =>
        account.write(
          path,
          /\/state\/[0-9a-f]{64}\.result$/.test(path) ? `result=done\nnote=${note}\n` : text,
        ),
    };
    const s = await project(noted, { example: "hono-api" });
    const { deps, error } = await s.run();
    expect(error).toBeUndefined();
    expect(said(deps)).toContain(`${note}.`);
    expect((await record(s.root)).objects).toContainEqual(
      expect.objectContaining({ kind: "app", key: "nodejs" }),
    );
  });

  it("never shows the panel's token: outputs, plan files, audit entries", async () => {
    const s = await setup();
    const { deps, handler, error } = await s.run();
    expect(error).toBeUndefined();
    const texts = [
      said(deps),
      JSON.stringify(handler.requests),
      JSON.stringify(deps.audit.entries),
    ];
    const plans = deps.paths.files.plansDir;
    for (const name of await readdir(plans)) texts.push(await readFile(join(plans, name), "utf8"));
    texts.push(await readFile(hostingRecordFile(deps.paths), "utf8"));
    for (const text of texts) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(APP_SECRET);
      expect(text).not.toContain("BEGIN PRIVATE KEY");
    }
  });
});

describe("provision through Plesk's and DirectAdmin's fakes (SC-2705)", () => {
  /** The account's 7.4 runs no app of PHP 8.3; the panel's own 8.3 does. */
  const panelPhp = (path: string) => () =>
    report({
      account: "7.4.33",
      extra: [`php.8.path=${path}`, "php.8.version=PHP 8.3.9 (cli)", `php.8.modules=${ALL}`],
    });

  it("on Plesk, pauses for the steps in the panel and continues once the user took them", async () => {
    const fake = fakePlesk({ token: TOKEN });
    const files = new MemoryFiles();
    const cron = { added: false };
    const s = await project(pleskAccount(fake, files, cron), {
      hosting: { files },
      report: panelPhp("/opt/plesk/php/8.3/bin/php"),
    });

    // 1. Plan A: the agent's files over SFTP's stand-in; its scheduled task is the user's step.
    const first = await s.run();
    expect(first.error).toBeUndefined();
    expect(kinds(first.handler.requests)).toEqual(["hosting-apply"]);
    expect(files.files.get(`${FOLDER}/agent.sh`)).toMatch(/^#!\/bin\/bash/);
    const pause = first.deps.reporter.lines.find((line) => line.level === "warn")?.message ?? "";
    expect(pause).toContain("Plesk's API can't do this step, so do it in Plesk");
    expect(pause).toContain(agentCronCommand(FOLDER));
    expect(pause).toContain("Websites & Domains → Scheduled Tasks");

    // 2. The user added the task: the agent reports, plan B sets the app up, and pauses for the
    // hostname's PHP version and the app's own task.
    cron.added = true;
    const second = await s.run();
    expect(second.error).toBeUndefined();
    expect(kinds(second.handler.requests)).toEqual([
      "hosting-apply",
      "github-secrets",
      "github-settings",
    ]);
    const steps = second.deps.reporter.lines.find((line) => line.level === "warn")?.message ?? "";
    expect(steps).toContain("Plesk's API can't do these steps");
    expect(steps).toContain("8.3");
    expect(steps).toContain("bin/cron.php");
    expect(fake.state.sites.map((site) => site.name)).toContain(HOSTNAME);
    expect(fake.state.databases.map((database) => database.name)).toContain("notes");

    // 3. The user took them: nothing more on the account; the pull request.
    const third = await s.run();
    expect(third.error).toBeUndefined();
    expect(kinds(third.handler.requests)).toEqual(["repo-write", "git-push", "pull-request"]);
    expect(said(third.deps)).toContain("Plesk's API doesn't show certificates");
    const made = await record(s.root);
    expect(made.objects.filter((o) => o.kind === "panel-step").map((o) => o.key)).toEqual([
      "agent-cron",
      "php:8.3",
      expect.stringMatching(/^cron:\* \* \* \* \* cd /),
    ]);

    // 4. The app drops its scheduled command: the user removes the task in the panel.
    await s.merge();
    const plan = await readArtifact("plan", third.deps.paths.files.plan);
    await writeArtifact("plan", third.deps.paths.files.plan, {
      ...plan,
      target: { ...(plan.target as HostingDeployTarget), cron: [] },
    });
    const fourth = await s.run();
    expect(fourth.error).toBeUndefined();
    expect(kinds(fourth.handler.requests)).toEqual(["hosting-apply"]);
    const removal = fourth.deps.reporter.lines.find((line) => line.level === "warn")?.message ?? "";
    expect(removal).toContain("Remove the scheduled task that runs this command");
    expect(removal).toContain("bin/cron.php");

    // 5. The user did: both steps are forgotten, and nothing is asked of the panel again.
    const fifth = await s.run();
    expect(fifth.error).toBeUndefined();
    expect(kinds(fifth.handler.requests)).not.toContain("hosting-apply");
    expect(fifth.deps.reporter.text()).not.toContain("can't do");
    const after = await record(s.root);
    expect(after.objects.filter((o) => o.kind === "panel-step").map((o) => o.key)).toEqual([
      "agent-cron",
      "php:8.3",
    ]);
  });

  it("on DirectAdmin, links the panel's own empty root to the release and pauses for the PHP version", async () => {
    const fake = new FakeDirectAdmin({ token: TOKEN });
    const s = await project(directAdminAccount(fake), {
      report: panelPhp("/usr/local/php83/bin/php"),
    });
    const first = await s.run();
    expect(first.error).toBeUndefined();
    expect(kinds(first.handler.requests)).toEqual([
      "hosting-apply",
      "hosting-apply",
      "github-secrets",
      "github-settings",
    ]);
    expect(fake.files.get("domains/notes.example.com/public_html")).toEqual({
      type: "symlink",
      target: `../../${FOLDER}/current/public`,
    });
    expect([...fake.databases]).toContain("alice_notes");
    expect([...fake.cron.values()].some((line) => line.endsWith(agentCronCommand(FOLDER)))).toBe(
      true,
    );
    expect([...fake.cron.values()].some((line) => line.includes("/usr/local/php83/bin/php"))).toBe(
      true,
    );
    const pause = first.deps.reporter.lines.find((line) => line.level === "warn")?.message ?? "";
    expect(pause).toContain("DirectAdmin's API can't do this step");
    expect(pause).toContain("8.3");

    const second = await s.run();
    expect(second.error).toBeUndefined();
    expect(kinds(second.handler.requests)).toEqual(["repo-write", "git-push", "pull-request"]);
  });

  it("on DirectAdmin, never replaces a root that holds files OpsCrew didn't put there", async () => {
    const fake = new FakeDirectAdmin({ token: TOKEN });
    fake.files.set("domains/notes.example.com", { type: "dir" });
    fake.files.set("domains/notes.example.com/public_html", { type: "dir" });
    fake.files.set("domains/notes.example.com/public_html/old.php", {
      type: "file",
      content: new TextEncoder().encode("<?php echo 'kept';"),
      mode: 0o644,
    });
    const s = await project(directAdminAccount(fake), {
      report: panelPhp("/usr/local/php83/bin/php"),
    });
    const { error } = await s.run();
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain(
      "holds files OpsCrew didn't put there (old.php), so OpsCrew won't replace it",
    );
    expect(fake.text("domains/notes.example.com/public_html/old.php")).toBe("<?php echo 'kept';");
  });
});
