// Feature 027 (T2713): an app provisioned on a fake hosting account, for the tests of rollback,
// destroy, status and logs. The account's objects are made through the panel's own connector and
// recorded in `.opscrew/hosting.json` as provision records them; the agent's part (its status, its
// log, its answers to requests) is played by the test.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeCpanel, type FakeCpanelOptions, fakeCpanel } from "@opscrew/connector-cpanel";
import { FakeDirectAdmin } from "@opscrew/connector-directadmin";
import { fakePlesk } from "@opscrew/connector-plesk";
import type {
  FetchLike,
  HostingFiles,
  HostingPanel,
  HostingPanelAccess,
  HostingPanelKind,
} from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { FakeRollbackGitHub } from "../../rollback/__fixtures__/versions";
import {
  createTestPhaseDeps,
  projectRunner,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
} from "../../testing";
import { hostingFiles, panelConnector } from "../panels";
import { AGENT_SCHEDULE, agentCronCommand } from "../php";
import { ownCertificateId } from "../provision";
import { type HostingObject, recordObject, updateHostingRecord } from "../record";
import { keyValues } from "../requests";

export const HOSTNAME = "notes.example.com";
export const REPOSITORY = { owner: "acme", repo: "shop" } as const;
/** The panel's token, which no output, plan file or audit entry may show. */
export const PANEL_TOKEN = fakeSecret("generic-password", "hosting-account");
/** A value of the app's own, which the agent's log may show and the redactor masks. */
export const APP_VALUE = fakeSecret("generic-password", "hosting-app-value");

/** The agent's read-only GitHub key, as provision recorded it (public). */
const AGENT_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeagentkeyfortestsonlyopscrewhostingagent";

export interface HostingPlanOptions {
  panel?: HostingPanelKind;
  /** A named environment (default prod, whose plan names none). */
  environment?: string;
  /** The app has a MariaDB database (default true). */
  database?: boolean;
  /** The hostname's DNS is on Cloudflare (default: elsewhere). */
  cloudflare?: boolean;
  /** Recorded as provisioned (default true). */
  deployed?: boolean;
}

/** The app's folder on the account, `opscrew/notes-<env>`. */
export const folderOf = (environment = "prod") => `opscrew/notes-${environment}`;

/** A plain PHP app's plan on a hosting account, as design and provision leave it. */
export function hostingTestPlan(o: HostingPlanOptions = {}): DeployPlan {
  const name = o.environment === undefined ? "notes" : `notes-${o.environment}`;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
    ...(o.environment === undefined ? {} : { environment: { name: o.environment } }),
    app: { name, port: 3000, buildContext: ".", healthPath: "/", env: [] },
    target: {
      provider: "hosting",
      panel: o.panel ?? "cpanel",
      app: "php",
      webRoot: "public",
      php: { version: "8.3", via: "handler" },
      ...(o.database === false ? {} : { database: { engine: "mariadb", name: "notes" } }),
      cron: [{ schedule: "*/15 * * * *", command: "php bin/cleanup.php" }],
    },
    processes: { workers: [], cron: [] },
    services: [],
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "USD" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-12T00:00:00.000Z",
    },
    codeChanges: [],
    // Plain state, so a test's DNS root needs no passphrase.
    infra: { engine: "tofu", stateEncryption: false },
    dns:
      o.cloudflare === true
        ? { provider: "cloudflare", domain: HOSTNAME, zone: "example.com", proxied: false, www: false }
        : { provider: "none", domain: HOSTNAME, proxied: false, www: false },
    cicd: {
      provider: "github-actions",
      registry: "ghcr",
      branch: "main",
      ...(o.environment === undefined
        ? {}
        : { workflowPath: `.github/workflows/opscrew-deploy-${o.environment}.yml` }),
    },
    security: { wafCustomRules: false, httpAllowedFrom: "any" },
    ...(o.deployed === false ? {} : { deployment: { lastApplyAt: "2026-11-12T11:00:00.000Z" } }),
  });
}

/** The entries of a ustar archive: files with their text and links with their target. */
function untar(bytes: Uint8Array): { name: string; type: string; text: string }[] {
  const field = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, "");
  const entries = [];
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const name = field(offset, 100);
    if (name === "") break;
    const size = Number.parseInt(field(offset + 124, 12) || "0", 8);
    const type = field(offset + 156, 1) || "0";
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    entries.push({ name: name.replace(/\/$/, ""), type, text: new TextDecoder().decode(body) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** An account's files in memory: what stands in for SFTP on Plesk. */
export class MemoryFiles implements HostingFiles {
  readonly files = new Map<string, string>();
  async writeFile(path: string, content: Uint8Array) {
    this.files.set(path, new TextDecoder().decode(content));
  }
  async uploadTar(folder: string, tar: Uint8Array) {
    for (const entry of untar(tar)) {
      if (entry.type === "0") this.files.set(folder === "." ? entry.name : `${folder}/${entry.name}`, entry.text);
    }
  }
  async readFile(path: string) {
    return this.files.get(path);
  }
  async list(folder: string) {
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (path.startsWith(`${folder}/`)) names.add(path.slice(folder.length + 1).split("/")[0] as string);
    }
    return names.size === 0 ? undefined : [...names];
  }
  async remove(path: string) {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }
}

/** A fake account as the agent on it sees it: its files, and what the panel holds. */
export interface FakeAccount {
  kind: HostingPanelKind;
  access: HostingPanelAccess;
  fetch: FetchLike;
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  /** Makes a folder and its parents. */
  mkdir(path: string): void;
  remove(path: string): void;
  /** Every file's path. */
  paths(): string[];
  /** The cron lines' commands (Plesk's: those the user added in the panel). */
  cron(): string[];
  databases(): string[];
  /** The hostnames the panel serves besides the account's own domains. */
  hostnames(): string[];
  /** The account's files where the panel's API has none (Plesk). */
  files?: MemoryFiles;
  cpanel?: FakeCpanel;
  directadmin?: FakeDirectAdmin;
}

export function cpanelAccount(options: Partial<FakeCpanelOptions> = {}): FakeAccount {
  const fake = fakeCpanel({
    user: "acct",
    token: PANEL_TOKEN,
    mainDomain: "example.com",
    ...options,
  });
  return {
    kind: "cpanel",
    access: { url: "https://panel.example.com:2083", user: "acct", token: PANEL_TOKEN },
    fetch: fake.fetch,
    read: (path) => fake.readText(path),
    write: (path, text) => fake.writeText(path, text, 0o600),
    mkdir: (path) => {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) fake.state.folders.add(parts.slice(0, i).join("/"));
    },
    remove: (path) => {
      for (const key of [...fake.state.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) fake.state.files.delete(key);
      }
    },
    paths: () => [...fake.state.files.keys()],
    cron: () => fake.state.cron.map((line) => line.command),
    databases: () => [...fake.state.databases.keys()],
    hostnames: () => fake.state.domains.filter((d) => d.kind !== "main").map((d) => d.name),
    cpanel: fake,
  };
}

export function directAdminAccount(): FakeAccount {
  const fake = new FakeDirectAdmin({ user: "alice", domains: ["example.com"] });
  const mkdir = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      fake.files.set(parts.slice(0, i).join("/"), { type: "dir" });
    }
  };
  const write = (path: string, text: string) => {
    mkdir(path.split("/").slice(0, -1).join("/"));
    fake.files.set(path, { type: "file", content: new TextEncoder().encode(text), mode: 0o600 });
  };
  return {
    kind: "directadmin",
    access: fake.access,
    fetch: fake.fetch,
    read: (path) => fake.text(path),
    write,
    mkdir,
    remove: (path) => fake.files.delete(path),
    paths: () => [...fake.files.keys()].filter((path) => fake.files.get(path)?.type === "file"),
    cron: () => [...fake.cron.values()],
    databases: () => [...fake.databases],
    hostnames: () => [...fake.subdomains].flatMap(([domain, subs]) => subs.map((s) => `${s}.${domain}`)),
    directadmin: fake,
  };
}

/** A Plesk subscription: its files over what stands in for SFTP, its scheduled tasks the user's. */
export function pleskAccount(): FakeAccount {
  const fake = fakePlesk({ token: PANEL_TOKEN });
  const files = new MemoryFiles();
  return {
    kind: "plesk",
    access: { url: fake.url, user: fake.login, token: PANEL_TOKEN },
    fetch: fake.fetch,
    read: (path) => files.files.get(path),
    write: (path, text) => files.files.set(path, text),
    mkdir: () => {},
    remove: (path) => files.files.delete(path),
    paths: () => [...files.files.keys()],
    cron: () => [],
    databases: () => fake.state.databases.map((db) => db.name),
    hostnames: () => fake.state.sites.map((site) => site.name),
    files,
  };
}

/** The commit the deploy workflow's run `runId` built. */
export const commitOfRun = (runId: number) => `${String(runId).padStart(4, "0")}`.repeat(10);

/**
 * GitHub as a rollback reads it: the deploy workflow's finished runs 777, 790 and 812 (the
 * releases' run ids), and the repository variables, which it writes.
 */
export function hostingGitHub(plan: DeployPlan) {
  const github = new FakeRollbackGitHub();
  for (const [runId, minute] of [
    [777, 1],
    [790, 2],
    [812, 3],
  ] as const) {
    github.runs.set(runId, {
      repository: `${REPOSITORY.owner}/${REPOSITORY.repo}`,
      headRepository: `${REPOSITORY.owner}/${REPOSITORY.repo}`,
      event: "push",
      headBranch: "main",
      headSha: commitOfRun(runId),
      path: plan.cicd.workflowPath,
      createdAt: `2026-11-12T10:0${minute}:00Z`,
      status: "completed",
      conclusion: "success",
    });
  }
  return Object.assign(github, {
    async setRepoVariable(_owner: string, _repo: string, name: string, value: string) {
      github.variables.set(name, value);
    },
    async deleteRepoVariable(_owner: string, _repo: string, name: string) {
      github.variables.delete(name);
    },
  });
}

/** The app on `account`, provisioned: what it set up there and recorded, and its git checkout. */
export interface HostedApp {
  root: string;
  account: FakeAccount;
  plan: DeployPlan;
  folder: string;
  /** The panel's connector, for the test's own checks. */
  panel: HostingPanel;
  /** The account's files, as the hosting commands reach them. */
  files: HostingFiles;
  /** New deps for one run, with this approval handler. */
  deps(handler?: ScriptedApprovalHandler): Promise<TestPhaseDeps>;
  /** The agent's `state/status` now. */
  status(): Record<string, string>;
  /** Writes the agent's `state/status`. */
  setStatus(status: { running: string; previous?: string; kept: string[] }): void;
}

export interface HostedOptions extends HostingPlanOptions {
  account?: FakeAccount;
  /** What the account's main domain names in its `Server` header (default LiteSpeed). */
  webServer?: string;
}

/**
 * An app provisioned on `account` (default a fake cPanel account): the agent's folder with its
 * files, status, log and the dump filed under its previous release; the agent's and the app's cron
 * lines (the user's in Plesk); the hostname and its document root (DirectAdmin's own root replaced
 * by a link); the database and its user; the certificate; GitHub's deploy key and the signing key;
 * each recorded as provision records it. Releases `812-1` (running), `790-1` and `777-2` are kept.
 */
export async function hostedApp(o: HostedOptions = {}): Promise<HostedApp> {
  const account = o.account ?? cpanelAccount();
  const environment = o.environment ?? "prod";
  const folder = folderOf(environment);
  const plan = hostingTestPlan({ ...o, panel: account.kind });
  const root = await mkdtemp(join(tmpdir(), "opscrew-hosting-"));
  const runner = new NodeCommandRunner();
  const git = async (...args: string[]) => {
    const result = await runner.run("git", ["-C", root, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", `https://github.com/${REPOSITORY.owner}/${REPOSITORY.repo}.git`);
  const env: Record<string, string | undefined> = {
    OPSCREW_HOME: join(root, ".home-opscrew"),
    OPSCREW_HOSTING_URL: account.access.url,
    OPSCREW_HOSTING_USER: account.access.user,
    OPSCREW_HOSTING_TOKEN: account.access.token,
  };
  // The account's main domain answers with its web server; everything else is the panel.
  const fetch: FetchLike = async (input, init) =>
    new URL(String(input)).hostname === "example.com"
      ? new Response("", { status: 301, headers: { server: o.webServer ?? "LiteSpeed" } })
      : account.fetch(input, init);
  const deps = async (handler = new ScriptedApprovalHandler()) =>
    createTestPhaseDeps({
      root,
      env,
      fetch,
      runner: projectRunner(),
      approvalHandler: handler,
      ...(o.environment === undefined ? {} : { environment: o.environment }),
    });
  const setup = await deps();
  await writeArtifact("plan", setup.paths.files.plan, plan);
  const panel = panelConnector(account.kind, account.access, setup);
  const files = hostingFiles(panel) ?? (account.files as HostingFiles);
  await updateHostingRecord(setup.paths, () => ({
    schemaVersion: 1,
    objects: [],
    panel: { kind: account.kind, url: account.access.url, user: account.access.user },
  }));
  const made = (object: HostingObject) => recordObject(setup.paths, object);

  // The agent's folder, its state and the app's settings.
  for (const name of ["keys", "state", "requests", "dumps", "releases", "shared"]) {
    account.mkdir(`${folder}/${name}`);
  }
  for (const [path, text] of Object.entries({
    "agent.sh": "#!/bin/bash\n",
    "settings.sh": "APP='notes'\n",
    "shared/.env": `NOTES_API_KEY=${APP_VALUE}\n`,
    "releases/812-1/public/index.php": "<?php echo 812;\n",
    "releases/790-1/public/index.php": "<?php echo 790;\n",
    "releases/777-2/public/index.php": "<?php echo 777;\n",
    "dumps/790-1.sql.gz": "dump of 790-1",
    "dumps/777-2.sql.gz": "dump of 777-2",
    "state/agent.log": [
      "2026-11-12T10:00:00Z Deploying release 790-1 (commit abc).",
      "2026-11-12T10:00:40Z Release 790-1 serves.",
      `2026-11-12T10:30:00Z Release 812-1: NOTES_API_KEY=${APP_VALUE}`,
      "warning: a tool's own line",
      "2026-11-12T10:30:40Z Release 812-1 serves.",
      "",
    ].join("\n"),
  })) {
    account.write(`${folder}/${path}`, text);
  }
  await made({ kind: "folder", key: folder });
  await made({ kind: "file", key: `${folder}/shared/.env`, value: "0".repeat(64) });
  const setStatus = (status: { running: string; previous?: string; kept: string[] }) =>
    account.write(
      `${folder}/state/status`,
      [
        `running=${status.running}`,
        `previous=${status.previous ?? ""}`,
        `kept=${status.kept.join(",")}`,
        "attempt=812-1",
        "result=deployed",
        "reason=",
        "at=2026-11-12T10:30:40Z",
        "",
      ].join("\n"),
    );
  setStatus({ running: "812-1", previous: "790-1", kept: ["790-1", "777-2"] });

  // The cron lines: the agent's, then the app's.
  const agentCommand = agentCronCommand(folder);
  const appLine = { schedule: "*/15 * * * *", command: `cd ~/${folder}/current && php bin/cleanup.php` };
  if (panel.operations.has("addCron")) {
    const agent = await panel.addCron({ schedule: AGENT_SCHEDULE, command: agentCommand });
    await made({ kind: "cron", key: agent.key, value: `${AGENT_SCHEDULE} ${agentCommand}` });
    const job = await panel.addCron(appLine);
    await made({ kind: "cron", key: job.key, value: `${appLine.schedule} ${appLine.command}` });
  } else {
    await made({ kind: "panel-step", key: "agent-cron", value: agentCommand });
    await made({
      kind: "panel-step",
      key: `cron:${appLine.schedule} ${appLine.command}`,
      value: appLine.command,
    });
  }

  // The hostname with its document root, its database and its certificate.
  const served = `${folder}/current/public`;
  if (account.kind === "directadmin") {
    const rootDir = await panel.addHostname(HOSTNAME);
    await made({ kind: "hostname", key: HOSTNAME, value: rootDir });
    account.directadmin?.files.set(rootDir, { type: "symlink", target: `../../../${served}` });
    await made({ kind: "link", key: rootDir });
    account.directadmin?.certificates.set("example.com", [
      { id: "c1", dnsNames: [HOSTNAME], notAfter: "2027-02-01T00:00:00Z", error: "" },
    ]);
  } else {
    const rootDir = await panel.addHostname(HOSTNAME, served);
    await made({ kind: "hostname", key: HOSTNAME, value: rootDir });
  }
  if (o.database !== false) {
    const name = account.kind === "cpanel" ? "acct_notes" : account.kind === "directadmin" ? "alice_notes" : "notes";
    await panel.addDatabase({ name, user: name, password: fakeSecret("generic-password", "db") });
    await made({ kind: "database", key: name });
  }
  const certificate = await panel.certificate(HOSTNAME);
  const own = ownCertificateId(certificate, HOSTNAME);
  if (own !== undefined) await made({ kind: "certificate", key: own });

  // GitHub: the agent's deploy key and the release signing key.
  await made({ kind: "deploy-key", key: "4001", value: AGENT_KEY });
  await made({ kind: "signing-key", key: "1".repeat(64) });

  return {
    root,
    account,
    plan,
    folder,
    panel,
    files,
    deps,
    status: () => keyValues(account.read(`${folder}/state/status`) ?? ""),
    setStatus,
  };
}

/** What the test's agent answers a request, or `undefined` to carry it out as the agent does. */
export type AgentAnswer = (request: Record<string, string>) => string | undefined;

/**
 * The agent on the account, run at each of OpsCrew's waits: it carries out each request once, as
 * `AGENT_SH` does (a rollback switches the status and, with `restore=yes`, files the current
 * database's dump under the running release; a snapshot writes a dump), answers in its result file
 * and removes the request. `answer` replaces what it does.
 */
export function playAgent(app: HostedApp, answer?: AgentAnswer) {
  const { account, folder } = app;
  const requests: Record<string, string>[] = [];
  const run = async () => {
    for (const path of account.paths()) {
      const match = new RegExp(`^${folder}/requests/([0-9a-f]{64})\\.req$`).exec(path);
      if (match === null) continue;
      const request = keyValues(account.read(path) ?? "");
      requests.push(request);
      let result = answer?.(request);
      if (result === undefined && request.kind === "snapshot") {
        account.write(`${folder}/dumps/snapshot-20261011T120000Z.sql.gz`, "final dump");
        result = "result=done\ndump=snapshot-20261011T120000Z.sql.gz\n";
      }
      if (result === undefined && request.kind === "rollback") {
        const status = app.status();
        const target = request.release as string;
        const running = status.running as string;
        const kept = [running, ...(status.kept ?? "").split(",")].filter((id) => id !== target);
        if (request.restore === "yes") account.write(`${folder}/dumps/${running}.sql.gz`, "now");
        app.setStatus({
          running: target,
          ...(kept.includes("777-2") && target === "790-1" ? { previous: "777-2" } : {}),
          kept,
        });
        result = "result=done\n";
      }
      account.write(`${folder}/state/${match[1]}.result`, result ?? "result=refused\nreason=unknown\n");
      account.remove(path);
    }
  };
  return { requests, sleep: async () => run() };
}
