/** The shared harness of the live tests on a throwaway server (own server and Portainer). */
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostKeyFingerprint, parseDotenv, providerProfile } from "@opscrew/agents";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { materializeFixture } from "@opscrew/core/testing";
import { selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { type DeployPlan, type Region, readArtifact } from "@opscrew/plan-schema";
import { afterAll, expect, it } from "vitest";
import {
  Cloudflare,
  type CloudflareAppResources,
  type CloudflareZone,
  cloudflareLeft,
  createThrowawayServer,
  DEPLOY_WORKFLOW,
  deleteThrowaway,
  type FirewallRule,
  GitHubRepo,
  type HetznerIds,
  httpRequest,
  minutes,
  RootShell,
  type ThrowawayServer,
  waitFor,
  type ZeroTrust,
} from "./cloud";
import { isEncryptedPlan } from "./portainer-support";
import {
  type AppRules,
  appRules,
  approveHashes,
  blockedByCloudflare,
  cloudflareRecordProblems,
  deployJobFailed,
  duration,
  ed25519FromKeyscan,
  expectedSharedHosts,
  fingerprintFromKeygen,
  generatesValues,
  ipv6PrefixForms,
  newRunId,
  removalApproval,
  runHostname,
  Scrubber,
  type SharedPhase,
  seededDescription,
  sharedRuleHosts,
  userRules,
  type ZoneEntrypoints,
} from "./support";
import { generatedSecrets, type ZoneTls } from "./tls-support";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** The built CLI the live tests run (`pnpm --filter opscrew build`). */
export const CLI = join(REPO_ROOT, "packages/cli/dist/opscrew.js");
export const EXAMPLES = join(REPO_ROOT, "examples");

/** Whether `name` is a folder under `examples/` (a plain name, never a path). */
export function isExample(name: string): boolean {
  const dir = join(EXAMPLES, name);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && existsSync(dir) && statSync(dir).isDirectory()
  );
}

/**
 * The built CLI's environment in a live test: this process's environment without any
 * `OPSCREW_E2E_*` variable, cloud provider token or name in `drop`, with `base` on top (which may
 * give OpsCrew one provider's token, for a server OpsCrew creates).
 */
function cliEnv(
  base: Record<string, string | undefined>,
  drop: readonly string[] = [],
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["HCLOUD_TOKEN", "DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN", ...drop]) {
    delete env[name];
  }
  for (const name of Object.keys(env)) if (name.startsWith("OPSCREW_E2E_")) delete env[name];
  return { ...env, ...base };
}

/**
 * A planned project for the domain purchase tests: `examples/nextjs-postgres` in a new git
 * repository, through `analyze --no-ai`, `interview --answers` (Hetzner, no domain yet) and
 * `design`, and a runner of the built CLI in it (`CI=1`, `env` added; never a cloud token or an
 * `OPSCREW_E2E_*` variable).
 */
export async function plannedProject(env: Record<string, string | undefined>): Promise<{
  repo: string;
  opscrew: (...args: string[]) => Promise<{ exitCode: number; stdout: string; output: string }>;
}> {
  expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
  const runner = new NodeCommandRunner();
  const work = await mkdtemp(join(tmpdir(), "opscrew-e2e-domain-"));
  const repo = join(work, "repo");
  const projectEnv = cliEnv({ CI: "1", OPSCREW_HOME: join(work, "home"), ...env });
  await materializeFixture(join(EXAMPLES, "nextjs-postgres"), repo);
  await runner.run("git", ["-C", repo, "init", "-q"], { env: projectEnv });
  const opscrew = async (...args: string[]) => {
    const result = await runner.run(process.execPath, [CLI, ...args], {
      cwd: repo,
      env: projectEnv,
      timeoutMs: minutes(10),
    });
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  };
  expect((await opscrew("analyze", "--no-ai")).exitCode).toBe(0);
  await writeFile(
    join(work, "answers.json"),
    JSON.stringify({
      expectedMonthlyUsers: "<1k",
      budgetMonthly: 20,
      provider: "hetzner",
      region: "eu-central",
      uptime: "best-effort",
      dataCriticality: "important",
      dnsProvider: "none",
      keepExternalServices: { s3: false },
    }),
  );
  expect((await opscrew("interview", "--answers", join(work, "answers.json"))).exitCode).toBe(0);
  expect((await opscrew("design")).exitCode).toBe(0);
  return { repo, opscrew };
}

/** What the server live tests read from their `OPSCREW_E2E_*` variables. */
export interface ServerSettings {
  hcloudToken: string;
  githubRepo: string;
  githubToken: string;
  cloudflareToken: string;
  domain: string;
  region: string;
  /** Optional: a Hetzner server type instead of the cheapest x86 one. */
  serverType?: string;
  /** An example under examples/ (default nextjs-postgres). */
  app: string;
  appEnvFile?: string;
  /** The second app's throwaway repository (`OPSCREW_E2E_GITHUB_REPO_B`). */
  secondRepo: string;
}

/** The cleanup's budget for `opscrew destroy` runs, before the API deletes what is left. */
export const CLEANUP_DESTROY_BUDGET_MS = minutes(10);
/** The longest one `opscrew` run of the cleanup may take, within that budget. */
export const CLEANUP_DESTROY_RUN_MS = minutes(4);
/** What a cleanup's `teardown` may take: the destroy budget, then the API deletions after it. */
const TEARDOWN_TIMEOUT_MS = CLEANUP_DESTROY_BUDGET_MS + minutes(15);

/** The file a merged change adds or rewrites, so that its deploy builds a new image. */
export const CHANGE_FILE = "opscrew-e2e-change.txt";

/**
 * The secret values among OpsCrew's generated values for the app (`generatedSecrets`: 8 characters
 * or more, and of origin TLS only the keys), if it kept any.
 */
export async function readGeneratedValues(
  paths: Pick<ReturnType<typeof resolveProjectPaths>, "projectHomeDir">,
): Promise<string[] | undefined> {
  const file = join(paths.projectHomeDir, "generated_values.json");
  if (!existsSync(file)) return undefined;
  return generatedSecrets(JSON.parse(await readFile(file, "utf8")));
}

/** What the leak search reads of one app: its git history, its pull requests and its audit log. */
export interface LeakSourceApp {
  git: (...args: string[]) => Promise<string>;
  github: GitHubRepo;
  /** Pull requests opened before this are older runs', not this one's. */
  startedAt: Date;
  auditDir: string;
}

/**
 * What the leak search reads in `app` (`which` names it in the labels): the commits of every
 * branch and of `refs/e2e/*`, the pull requests since the run started, and the audit logs.
 */
export async function leakSourcesOf(app: LeakSourceApp, which = ""): Promise<LeakSource[]> {
  await app.git("fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
  const sources: LeakSource[] = [
    {
      kind: "commits",
      where: `the commits (every branch)${which}`,
      text: await app.git("log", "--all", "-p", "--format=%B"),
    },
  ];
  for (const pull of await app.github.pullRequestTexts()) {
    if (pull.createdAt < app.startedAt) continue;
    sources.push({
      kind: "pull request",
      where: `pull request #${pull.number}${which}`,
      text: pull.text,
    });
  }
  if (!existsSync(app.auditDir)) return sources;
  for (const file of await readdir(app.auditDir)) {
    sources.push({
      kind: "audit log",
      where: `the audit log ${file}${which}`,
      text: await readFile(join(app.auditDir, file), "utf8"),
    });
  }
  return sources;
}

/**
 * The files OpsCrew wrote on this computer that feature 014's leak search reads too (SC-1406):
 * each saved plan in `.opscrew/plans/` that is not encrypted, the reports
 * (`opscrew/SECURITY_REPORT.md`, `opscrew/RUNBOOK.md`), the record `.opscrew/cloudflare.json`, the
 * engine's state files in `.opscrew/tfstate/`, and the files in `extra` (a folder copy of the
 * recovery copy). Search them for secrets only: plans and state name the server's address.
 */
export async function localLeakSources(
  paths: ReturnType<typeof resolveProjectPaths>,
  extra: readonly string[] = [],
): Promise<LeakSource[]> {
  const sources: LeakSource[] = [];
  const read = async (file: string, where: string) => {
    if (!existsSync(file)) return;
    const text = await readFile(file, "utf8");
    if (!isEncryptedPlan(text)) sources.push({ kind: "file", where, text });
  };
  for (const [dir, what] of [
    [paths.files.plansDir, "the saved plan"],
    [paths.files.tfstateDir, "the state file"],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const file of await readdir(dir)) await read(join(dir, file), `${what} ${file}`);
  }
  await read(paths.files.securityReport, "opscrew/SECURITY_REPORT.md");
  await read(paths.files.runbook, "opscrew/RUNBOOK.md");
  await read(paths.files.cloudflareRecord, ".opscrew/cloudflare.json");
  for (const file of extra) await read(file, `the file ${file}`);
  return sources;
}

/**
 * The settings the server live tests share; `serverTypeVariable` names the test's own one for its
 * throwaway server (none when the test creates none).
 */
export function serverSettings(
  env: Record<string, string | undefined>,
  serverTypeVariable?: string,
): ServerSettings {
  const serverType = serverTypeVariable === undefined ? undefined : env[serverTypeVariable]?.trim();
  return {
    hcloudToken: env.OPSCREW_E2E_HCLOUD_TOKEN ?? "",
    githubRepo: env.OPSCREW_E2E_GITHUB_REPO ?? "",
    githubToken: env.OPSCREW_E2E_GITHUB_TOKEN ?? "",
    cloudflareToken: env.OPSCREW_E2E_CLOUDFLARE_TOKEN ?? "",
    domain: (env.OPSCREW_E2E_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, ""),
    region: env.OPSCREW_E2E_REGION?.trim() || "eu-central",
    ...(serverType ? { serverType } : {}),
    app: env.OPSCREW_E2E_APP?.trim() || "nextjs-postgres",
    ...(env.OPSCREW_E2E_APP_ENV ? { appEnvFile: env.OPSCREW_E2E_APP_ENV } : {}),
    secondRepo: env.OPSCREW_E2E_GITHUB_REPO_B?.trim() ?? "",
  };
}

/** One CLI run. */
export interface CliRun {
  exitCode: number;
  stdout: string;
  /** stdout and stderr; may hold anything, so print it only through `scrub`. */
  output: string;
}

/** One text the leak search reads; `where` names it in a leak. */
export interface LeakSource {
  kind: "commits" | "pull request" | "audit log" | "file";
  where: string;
  text: string;
}

/** A function the cleanup runs one action with: errors and returned problems are collected. */
export type CleanupAttempt = (what: string, body: () => Promise<unknown>) => Promise<void>;

/** What a {@link LiveRun} is made with. */
interface LiveRunOptions {
  /** In the log prefix: `OpsCrew E2E (<label>)`. */
  label: string;
  /** In the names of the temporary folder and the server (`opscrew-e2e-<name>-<run id>`). */
  name: string;
  settings: ServerSettings;
  /** Runs after every CLI run (for example to keep the saved plans for the leak search). */
  afterCli?: () => Promise<void>;
}

/**
 * One live run on a throwaway server: its state, its steps and its cleanup. Create it in the
 * `describe` block; it does nothing until a step runs. {@link second} adds the run's second app.
 */
export class LiveRun {
  readonly runId: string;
  readonly startedAt = new Date();
  readonly runner = new NodeCommandRunner();
  readonly scrubber: Scrubber;
  readonly scrub: (text: string) => string;
  readonly github: GitHubRepo;
  readonly cloudflare: Cloudflare;
  /** The app's hostname for this run only (`runHostname`), so Let's Encrypt's weekly limit never applies. */
  readonly appHost: string;
  /** Raw CLI outputs by (scrubbed) label: never printed, searched at the end. */
  readonly outputs: Map<string, string>;
  /** Problems that do not stop the run but fail it at the end. */
  readonly findings: string[];
  /** Every version of `.opscrew/cloudflare.json` seen after a CLI run, for the leak search. */
  readonly cloudflareRecords: Set<string>;

  work = "";
  repo = "";
  keyFile = "";
  knownHostsFile = "";
  env: Record<string, string | undefined> = {};
  repoReady = false;
  server: ThrowawayServer | undefined;
  root: RootShell | undefined;
  appName: string | undefined;
  zone: CloudflareZone | undefined;
  hostnames: string[] = [];
  /** The app's Workers on Cloudflare's hosting (every name it had in the run), for the leftover checks. */
  workers: string[] = [];
  cloudflareBefore: CloudflareAppResources | undefined;
  destroyed = false;
  /** The zone's two entrypoint rulesets before the run (and its seeded rules); the first app only. */
  sharedBefore: ZoneEntrypoints | undefined;
  /** The zone's origin TLS before the run (feature 014), for the cleanup's leftover decision. */
  tlsBefore: ZoneTls | undefined;
  /** The example's commit {@link prepareRepo} pushed to `main`. */
  exampleCommit = "";
  /** Flags every `provisionUntilDone` run passes (`--key-out <file>`, the recovery copy's key). */
  provisionFlags: string[] = [];

  private stopped = false;
  private publicKey = "";
  private hetznerTouched = false;
  private readonly hetznerIds: HetznerIds = {};
  private readonly parent: LiveRun | undefined;
  private readonly children: LiveRun[] = [];
  /** The zone's rules OpsCrew did not create, right after {@link seedUserRules}. */
  private userRulesSeeded: Record<SharedPhase, string[]> | undefined;
  /** The Zero Trust organization and one-time PIN logins seen so far: none may go. */
  private readonly zeroTrustSeen: { organization?: string; oneTimePins: Set<string> } = {
    oneTimePins: new Set(),
  };

  constructor(
    private readonly options: LiveRunOptions,
    parent?: LiveRun,
  ) {
    const { settings } = options;
    this.parent = parent;
    this.runId = parent?.runId ?? newRunId();
    this.scrubber = parent?.scrubber ?? new Scrubber();
    this.scrub = this.scrubber.scrub;
    this.outputs = parent?.outputs ?? new Map();
    this.findings = parent?.findings ?? [];
    this.cloudflareRecords = parent?.cloudflareRecords ?? new Set();
    this.github = new GitHubRepo(settings.githubToken, settings.githubRepo);
    this.cloudflare = new Cloudflare(settings.cloudflareToken);
    this.appHost =
      settings.domain === ""
        ? ""
        : runHostname(settings.domain, this.runId, parent === undefined ? undefined : "b");
    this.scrubber.add(settings.hcloudToken, "hetzner-token");
    this.scrubber.add(settings.githubToken, "github-token");
    this.scrubber.add(settings.cloudflareToken, "cloudflare-token");
  }

  /**
   * The run's second app, B: `examples/<example>` (another example than the first app's, so no
   * name of one starts with the other's) on `OPSCREW_E2E_GITHUB_REPO_B`, sharing this run's id,
   * scrubber, outputs, findings and cleanup.
   */
  second(example: string, afterCli?: () => Promise<void>): LiveRun {
    const { label, name, settings } = this.options;
    const second = new LiveRun(
      {
        label: `${label}, B`,
        name: `${name}-b`,
        settings: { ...settings, githubRepo: settings.secondRepo, app: example },
        afterCli,
      },
      this,
    );
    this.children.push(second);
    return second;
  }

  /**
   * Puts this app on `other`'s server (two apps on one server the user owns): its address, root's
   * login with the test key and the pinned host key. Call it after {@link prepareRepo}; the
   * cleanup deletes the server once, with `other`.
   */
  useServerOf(other: LiveRun): void {
    this.server = other.server;
    this.root = other.root;
    this.keyFile = other.keyFile;
    this.knownHostsFile = other.knownHostsFile;
  }

  readonly log = (message: string) =>
    console.log(`OpsCrew E2E (${this.options.label}): ${this.scrub(message)}`);

  tail(text: string, lines = 60): string {
    return this.scrub(text).trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  }

  /** A copy of `error` whose message and stack are scrubbed (no assertion diff with raw values). */
  cleanError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const clean = new Error(this.scrub(message));
    clean.stack = this.scrub(error instanceof Error ? (error.stack ?? message) : message);
    return clean;
  }

  /**
   * An ordered step: skipped after an earlier step failed (unless `always`), or reported as
   * skipped with `skip` as the reason; errors scrubbed.
   */
  step(
    title: string,
    timeoutMs: number,
    body: () => Promise<void>,
    options: { always?: boolean; skip?: string } = {},
  ): void {
    if (options.skip !== undefined) {
      it.skip(`${title} (skipped: ${options.skip})`, () => undefined);
      return;
    }
    it(title, { timeout: timeoutMs }, async (context) => {
      if (this.stopped && options.always !== true) context.skip();
      // Also a timeout (which never reaches the catch below) stops the later steps.
      context.onTestFailed(() => {
        this.stopped = true;
      });
      this.log(`step: ${title}`);
      try {
        await body();
      } catch (error) {
        this.stopped = true;
        throw this.cleanError(error);
      }
    });
  }

  /**
   * Adds the Worker `name` to the run's ({@link workers}), whose leftovers the cleanup deletes.
   * Before the zone's snapshot the snapshot itself notes a Worker of that name the account had
   * already (the cleanup keeps it); after it, the account must not have one: the run stops, so
   * the cleanup only ever deletes Workers this run created.
   */
  async addWorker(name: string): Promise<void> {
    if (this.workers.includes(name)) return;
    const { zone } = this;
    if (
      zone !== undefined &&
      (await this.cloudflare.workerDeployments(zone.accountId, name)) !== undefined
    ) {
      throw new Error(
        `A Worker named ${name} is already in the Cloudflare account; this test would take it over. Delete or rename it, then run the test again.`,
      );
    }
    this.workers.push(name);
  }

  ipv4(): string {
    return (this.server as ThrowawayServer).ipv4;
  }

  shell(): RootShell {
    return this.root as RootShell;
  }

  app(): string {
    return this.appName as string;
  }

  /** The project's paths: prod's, or `environment`'s; of the further app `app` when given. */
  paths(environment?: string, app?: string) {
    return resolveProjectPaths(this.repo, {
      env: this.env,
      ...(environment === undefined ? {} : { environment }),
      ...(app === undefined ? {} : { app }),
    });
  }

  /** `opscrew/plan.yaml`, or `environment`'s plan; of the further app `app` when given. */
  readPlan(environment?: string, app?: string): Promise<DeployPlan> {
    return readArtifact("plan", this.paths(environment, app).files.plan);
  }

  async git(...args: string[]): Promise<string> {
    const result = await this.runner.run("git", ["-C", this.repo, ...args], {
      env: this.env,
      timeoutMs: minutes(5),
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(-500)}`);
    }
    return result.stdout.trim();
  }

  /**
   * Runs the built CLI in the project, non-interactively (`CI=1`), with `overrides` in its env,
   * and keeps its output and the version of `.opscrew/cloudflare.json` it left for the leak search.
   */
  opscrewWith(overrides: Record<string, string | undefined>, ...args: string[]): Promise<CliRun> {
    return this.cli(overrides, minutes(30), args);
  }

  /** {@link opscrew}, stopped after `timeoutMs` (the cleanup's runs, within its budget). */
  opscrewWithin(timeoutMs: number, ...args: string[]): Promise<CliRun> {
    return this.cli({}, timeoutMs, args);
  }

  private async cli(
    overrides: Record<string, string | undefined>,
    timeoutMs: number,
    args: readonly string[],
  ): Promise<CliRun> {
    this.log(`running opscrew ${args.join(" ")}`);
    const result = await this.runner.run(process.execPath, [CLI, ...args], {
      cwd: this.repo,
      env: { ...this.env, ...overrides },
      timeoutMs,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const app = this.parent === undefined ? "" : "(B) ";
    this.outputs.set(
      this.scrub(`#${this.outputs.size + 1} ${app}opscrew ${args.join(" ")}`),
      output,
    );
    const record = await readFile(this.paths().files.cloudflareRecord, "utf8").catch(() => "");
    if (record !== "") this.cloudflareRecords.add(record);
    await this.options.afterCli?.();
    if (result.timedOut === true) {
      throw new Error(
        `opscrew ${args.join(" ")} did not finish in ${duration(timeoutMs)}:\n${this.tail(output)}`,
      );
    }
    return { exitCode: result.exitCode, stdout: result.stdout, output };
  }

  /** {@link opscrewWith}, throwing with the output's tail unless it exits 0. */
  async opscrewOkWith(
    overrides: Record<string, string | undefined>,
    ...args: string[]
  ): Promise<CliRun> {
    const result = await this.opscrewWith(overrides, ...args);
    if (result.exitCode !== 0) {
      throw new Error(
        `opscrew ${args.join(" ")} exited with ${result.exitCode}:\n${this.tail(result.output)}`,
      );
    }
    return result;
  }

  opscrew(...args: string[]): Promise<CliRun> {
    return this.opscrewWith({}, ...args);
  }

  opscrewOk(...args: string[]): Promise<CliRun> {
    return this.opscrewOkWith({}, ...args);
  }

  /**
   * Adds the infrastructure outputs `names` (tunnel tokens, the Access service token) to the
   * scrubber; one it cannot read is a finding, not a reason to stop the run.
   */
  async rememberOutputs(names: readonly string[]): Promise<void> {
    const outputs = await this.infraOutputs().catch((error: unknown) => {
      this.findings.push(
        `could not read the infrastructure outputs, so the leak search misses ${names.join(", ")}: ${String(error)}`,
      );
      return {} as Record<string, unknown>;
    });
    for (const name of names) {
      const value = outputs[name];
      if (typeof value === "string" && value !== "") {
        this.scrubber.add(value, name.replaceAll("_", "-"));
      } else {
        this.findings.push(
          `the infrastructure outputs have no ${name}, so the leak search misses it`,
        );
      }
    }
  }

  private async infraOutputs(): Promise<Record<string, unknown>> {
    const plan = await this.readPlan();
    const engine = await selectEngine("auto", { env: this.env, runner: this.runner });
    const engineEnv = { ...this.env };
    const passphrase = this.paths().files.statePassphrase;
    if (engine.info.name === "tofu" && existsSync(passphrase)) {
      engineEnv.TF_ENCRYPTION = tofuEncryptionEnv((await readFile(passphrase, "utf8")).trim());
    }
    return engine.output(join(this.repo, plan.infra.dir), { env: engineEnv });
  }

  /** Adds the content of `file` to the scrubber as `label`, when the file exists. */
  async rememberSecretFile(file: string, label: string): Promise<boolean> {
    if (!existsSync(file)) return false;
    this.scrubber.add(await readFile(file, "utf8"), label);
    return true;
  }

  /**
   * Adds the values OpsCrew generated for the app's services and secrets (database passwords,
   * Garage's key) to the scrubber, prod's or `environment`'s (of the further app `app` when
   * given); none kept is a finding when the plan has a service.
   */
  async rememberGeneratedValues(environment?: string, app?: string): Promise<void> {
    const values = await readGeneratedValues(this.paths(environment, app));
    if (values === undefined) {
      if (generatesValues(await this.readPlan(environment, app))) {
        this.findings.push(
          `OpsCrew kept no generated values for ${this.app()}${environment === undefined ? "" : ` (${environment})`}, so the leak search misses its services' passwords`,
        );
      }
      return;
    }
    for (const value of values) this.scrubber.add(value, "generated-value");
  }

  // -------------------------------------------------------------------------------------------
  // Step 1: the throwaway repository and server.

  /**
   * The first half of step 1: checks the app and the region, then makes the run's temporary
   * folder, the CLI's environment (`CI=1`, the GitHub token, `env`; never a cloud token, an SSH
   * agent, an `OPSCREW_E2E_*` variable or a name in `drop`), the server's own SSH key (never in
   * the repository, never printed), and the throwaway repository's `main` with a fresh copy of the
   * example (`commit` as its message) and without earlier pull requests or branches. The second
   * app must be another example than the first, so none of its names (stacks, tunnel, Access)
   * starts with the first app's. With `folders` (a repository of several apps), each example goes
   * into its folder instead; `overlay` is a folder copied over the example afterwards.
   */
  async prepareRepo(options: {
    commit: string;
    env?: Record<string, string | undefined>;
    drop?: readonly string[];
    folders?: Readonly<Record<string, string>>;
    overlay?: string;
  }): Promise<void> {
    const { settings } = this.options;
    expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
    const folders = options.folders ?? { ".": settings.app };
    for (const example of Object.values(folders)) {
      if (!isExample(example)) {
        throw new Error(
          `"${example}" is not an example under examples/ (this test deploys examples only; check OPSCREW_E2E_APP).`,
        );
      }
    }
    if (this.parent !== undefined && settings.app === this.parent.options.settings.app) {
      throw new Error(
        `The second app is examples/${settings.app}, so OPSCREW_E2E_APP must name another example (docs/e2e.md).`,
      );
    }
    this.locations();

    this.work = await mkdtemp(join(tmpdir(), `opscrew-e2e-${this.options.name}-`));
    this.repo = join(this.work, "repo");
    const keys = join(this.work, "keys");
    await mkdir(this.repo);
    await mkdir(keys);
    this.keyFile = join(keys, "id_ed25519");
    this.knownHostsFile = join(keys, "known_hosts");
    const basic = Buffer.from(`x-access-token:${settings.githubToken}`).toString("base64");
    this.scrubber.add(basic, "github-basic-auth");
    // OpsCrew never gets an SSH agent here: the server is the user's own, and the test key (by
    // path) is the only key OpsCrew may use.
    this.env = cliEnv(
      {
        CI: "1",
        OPSCREW_HOME: join(this.work, "home"),
        GITHUB_TOKEN: settings.githubToken,
        OPSCREW_APP_ENV_FILE: join(this.work, "production.env"),
        ...options.env,
      },
      ["SSH_AUTH_SOCK", ...(options.drop ?? [])],
    );

    const keygen = await this.runner.run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", `opscrew-e2e-${this.runId}`, "-f", this.keyFile],
      { env: this.env, timeoutMs: 60_000 },
    );
    if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
    this.scrubber.add(await readFile(this.keyFile, "utf8"), "test-private-key");
    this.publicKey = (await readFile(`${this.keyFile}.pub`, "utf8")).trim();

    for (const [folder, example] of Object.entries(folders)) {
      this.log(`pushing examples/${example} to the throwaway repository (${folder})`);
      await materializeFixture(join(EXAMPLES, example), join(this.repo, folder));
    }
    if (options.overlay !== undefined) await materializeFixture(options.overlay, this.repo);
    const appEnv = settings.appEnvFile ? await readFile(settings.appEnvFile, "utf8") : "";
    await writeFile(join(this.work, "production.env"), appEnv);
    // Stand-in values, but still never to be shown or committed (8+ characters: shorter ones
    // would match ordinary text).
    for (const value of parseDotenv(appEnv).values()) {
      if (value.length >= 8) this.scrubber.add(value, "app-env-value");
    }
    await this.git("init", "-q", "-b", "main");
    await this.git("config", "user.name", "OpsCrew E2E");
    await this.git("config", "user.email", "e2e@example.invalid");
    await this.git("config", "commit.gpgsign", "false");
    await this.git(
      "config",
      "http.https://github.com/.extraheader",
      `AUTHORIZATION: basic ${basic}`,
    );
    await this.git("remote", "add", "origin", `https://github.com/${settings.githubRepo}.git`);
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", options.commit);
    this.exampleCommit = await this.git("rev-parse", "HEAD");
    await this.git("push", "-q", "--force", "origin", "main");
    await this.github.reset();
    this.repoReady = true;
  }

  /**
   * Force-pushes the repository's `main` back to the example's commit {@link prepareRepo} pushed,
   * so nothing the run committed (an address in `opscrew/plan.yaml`) stays on it.
   */
  async restoreMain(): Promise<void> {
    await this.git("push", "-q", "--force", "origin", `${this.exampleCommit}:refs/heads/main`);
  }

  /** The Hetzner locations near `OPSCREW_E2E_REGION`, nearest first. */
  private locations(): readonly string[] {
    const { region } = this.options.settings;
    const regions = providerProfile("hetzner").regionLocations;
    if (!Object.hasOwn(regions, region)) {
      throw new Error(
        `OPSCREW_E2E_REGION="${region}" is not one of ${Object.keys(regions).join(", ")}.`,
      );
    }
    return regions[region as Region];
  }

  /**
   * The second half of step 1: creates the throwaway server (with `firewall` when given) outside
   * OpsCrew, masks its addresses, pins its SSH host key, waits until root logs in with the test
   * key and cloud-init is done, and checks the host key fingerprint on the server itself, as the
   * user guide says. Returns that fingerprint.
   */
  async createServer(firewall?: readonly FirewallRule[]): Promise<string> {
    const { settings } = this.options;
    this.hetznerTouched = true;
    const server = await createThrowawayServer({
      token: settings.hcloudToken,
      runId: this.runId,
      name: `opscrew-e2e-${this.options.name}-${this.runId}`,
      publicKey: this.publicKey,
      locations: this.locations(),
      ...(settings.serverType === undefined ? {} : { forcedType: settings.serverType }),
      ...(firewall === undefined ? {} : { firewall }),
      ids: this.hetznerIds,
      log: this.log,
    });
    this.server = server;
    this.scrubber.add(server.ipv4, "server-ipv4");
    this.scrubber.add(server.ipv6, "server-ipv6");
    for (const prefix of server.ipv6Network === undefined
      ? []
      : ipv6PrefixForms(server.ipv6Network)) {
      this.scrubber.add(prefix, "server-ipv6");
    }
    this.log(`server ${server.name} (${server.serverType} in ${server.location}) runs`);

    this.log("waiting for the server's SSH host key (up to 5 minutes)");
    const hostKey = await waitFor(
      "the server's SSH host key",
      minutes(5),
      async () => {
        const scan = await this.runner.run(
          "ssh-keyscan",
          ["-T", "10", "-t", "ed25519", server.ipv4],
          { env: this.env, timeoutMs: 30_000 },
        );
        return ed25519FromKeyscan(scan.stdout);
      },
      5_000,
    );
    await writeFile(this.knownHostsFile, `${server.ipv4} ssh-ed25519 ${hostKey}\n`);
    const fingerprint = hostKeyFingerprint(hostKey);
    this.root = new RootShell(this.runner, {
      host: server.ipv4,
      keyFile: this.keyFile,
      knownHostsFile: this.knownHostsFile,
      env: this.env,
    });
    this.log("waiting for root to log in with the test key (up to 3 minutes)");
    await waitFor(
      "root logging in with the test key",
      minutes(3),
      async () => ((await this.shell().run("true", 30_000)).exitCode === 0 ? true : undefined),
      5_000,
    );
    this.log("waiting for cloud-init to finish on the server (up to 15 minutes)");
    const cloudInit = await this.shell().run("cloud-init status --wait", minutes(15));
    // 2: finished with recoverable errors, which a fresh image may report.
    if (![0, 2].includes(cloudInit.exitCode)) {
      throw new Error(
        `cloud-init did not finish (exit ${cloudInit.exitCode}): ${cloudInit.stdout.trim()}`,
      );
    }
    expect(
      fingerprintFromKeygen(
        await this.shell().ok("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"),
      ),
      "the host key fingerprint on the server matches the scanned key",
    ).toBe(fingerprint);
    return fingerprint;
  }

  // -------------------------------------------------------------------------------------------
  // The flow.

  /** `opscrew init --fix`, as a user runs it first, with the `.gitignore` lines it adds committed. */
  async initFix(): Promise<CliRun> {
    const first = await this.opscrew("init", "--fix");
    if ((await this.git("status", "--porcelain", "--", ".gitignore")) !== "") {
      await this.git("add", ".gitignore");
      await this.git("commit", "-q", "-m", "chore: ignore OpsCrew's local files");
      await this.git("push", "-q", "origin", "main");
    }
    return first;
  }

  /**
   * The Cloudflare zone of the run's hostname, which must be directly below it (Cloudflare's free
   * edge certificate covers only `*.<zone>`), and a snapshot of what OpsCrew may create there for
   * the app on `hostnames`: the cleanup never deletes what was there before the run. The first app
   * also keeps the zone's two entrypoint rulesets and the account's Zero Trust pieces as they were
   * before the run.
   */
  async snapshotCloudflare(hostnames: (zone: CloudflareZone) => string[]): Promise<CloudflareZone> {
    const zone = await this.cloudflare.zoneOf(this.appHost);
    if (this.appHost !== `${this.appHost.split(".")[0]}.${zone.name}`) {
      throw new Error(
        `${this.appHost} is not directly below the Cloudflare zone ${zone.name}, so Cloudflare's free edge certificate does not cover it. Set OPSCREW_E2E_DOMAIN to a hostname one level below the zone (or the zone itself).`,
      );
    }
    this.log(`this run serves the app on its own hostname ${this.appHost}`);
    this.zone = zone;
    this.hostnames = hostnames(zone);
    this.cloudflareBefore = await this.cloudflare.appResources(
      zone,
      this.app(),
      this.hostnames,
      this.workers,
    );
    this.tlsBefore = await this.cloudflare.zoneTls(zone, this.hostnames);
    if (this.parent === undefined) {
      this.sharedBefore = await this.cloudflare.sharedEntrypoints(zone);
      this.noteZeroTrust(await this.cloudflare.zeroTrust(zone.accountId));
    }
    return zone;
  }

  /**
   * Before the first provision (the first app only): one rule of the user's own in each of
   * OpsCrew's two phases, added as a user would (`seedRule`), that matches only
   * `opscrew-e2e-seeded.<the run's hostname>`, a name that does not exist: a block in the WAF
   * custom rules, a harmless setting in the configuration rules (both on the Free plan). The
   * zone's rules OpsCrew did not create, these among them, are then compared after every provision
   * and destroy ({@link expectSharedCloudflare}); the cleanup removes the seeded ones.
   */
  async seedUserRules(): Promise<void> {
    const zone = this.zone as CloudflareZone;
    const description = seededDescription(this.runId);
    const expression = `(http.host eq "opscrew-e2e-seeded.${this.appHost}")`;
    await this.cloudflare.seedRule(zone, "http_request_firewall_custom", {
      description,
      expression,
      action: "block",
      enabled: true,
    });
    await this.cloudflare.seedRule(zone, "http_config_settings", {
      description,
      expression,
      action: "set_config",
      action_parameters: { automatic_https_rewrites: true },
      enabled: true,
    });
    const now = await this.cloudflare.sharedEntrypoints(zone);
    for (const [phase, entrypoint] of Object.entries(now)) {
      expect(
        entrypoint?.rules.some((rule) => rule.description === description),
        `the seeded rule is in the zone's ${phase} rules`,
      ).toBe(true);
    }
    this.userRulesSeeded = userRules(now);
    this.log(
      "seeded a rule of the user's own in the zone's WAF custom rules and configuration rules",
    );
  }

  /**
   * The checks after every provision and destroy of docs/e2e.md ("Your own server", step 2).
   * `further` are the plans of the repository's further apps that are live (`opscrew app add`).
   */
  async expectSharedCloudflare(what: string, further: readonly DeployPlan[] = []): Promise<void> {
    const zone = this.zone as CloudflareZone;
    const now = await this.cloudflare.sharedEntrypoints(zone);
    expect(
      userRules(now),
      `the zone's own rules (the seeded ones among them) are unchanged after ${what}`,
    ).toEqual(this.userRulesSeeded);
    const apps: AppRules[] = further.map(appRules);
    for (const app of [this, ...this.children]) {
      if (app.appName !== undefined && !app.destroyed) apps.push(appRules(await app.readPlan()));
    }
    expect(
      sharedRuleHosts(now),
      `OpsCrew's shared rules list exactly the hostnames of this run's apps after ${what}`,
    ).toEqual(expectedSharedHosts(sharedRuleHosts(this.sharedBefore as ZoneEntrypoints), apps));
    const zeroTrust = await this.cloudflare.zeroTrust(zone.accountId);
    const seen = this.zeroTrustSeen;
    if (seen.organization !== undefined) {
      expect(
        zeroTrust.organization,
        `the account's Zero Trust organization stays after ${what}`,
      ).toBe(seen.organization);
    }
    expect(zeroTrust.oneTimePins, `the account's one-time PIN login stays after ${what}`).toEqual(
      expect.arrayContaining([...seen.oneTimePins]),
    );
    this.noteZeroTrust(zeroTrust);
    this.log(
      `after ${what}: the zone's own rules are unchanged, OpsCrew's shared rules list this run's apps, the Zero Trust pieces stay`,
    );
  }

  private noteZeroTrust(now: ZeroTrust): void {
    this.zeroTrustSeen.organization ??= now.organization;
    for (const id of now.oneTimePins) this.zeroTrustSeen.oneTimePins.add(id);
  }

  /** The app's health URL on its hostname: `https://<appHost><the plan's health path>`. */
  async healthUrl(): Promise<string> {
    return `https://${this.appHost}${(await this.readPlan()).app.healthPath}`;
  }

  /**
   * Waits up to `timeoutMs` until the app's health URL (or `healthUrl`, another environment's)
   * answers 200 with Cloudflare's `cf-ray` header, or, with `throughCloudflare` false, without it
   * (straight from the server).
   */
  async waitForHealth(
    timeoutMs = minutes(10),
    throughCloudflare = true,
    healthUrl?: string,
  ): Promise<void> {
    const url = healthUrl ?? (await this.healthUrl());
    this.log(
      `waiting for ${url} to answer 200${throughCloudflare ? " through Cloudflare" : " from the server"}`,
    );
    await waitFor(`${url} answering 200`, timeoutMs, async () => {
      const answer = await httpRequest(url);
      if (answer.status !== 200) throw new Error(`${url} answered ${answer.status}.`);
      if ((answer.headers["cf-ray"] !== undefined) !== throughCloudflare) {
        throw new Error(
          `${url} answered ${throughCloudflare ? "without" : "with"} Cloudflare's cf-ray header.`,
        );
      }
      return true;
    });
  }

  /** Waits up to 3 minutes until `https://<hostname>/.env` answers with Cloudflare's block page. */
  async expectProbeBlocked(hostname: string): Promise<void> {
    const url = `https://${hostname}/.env`;
    await waitFor(
      `${url} answering with Cloudflare's block page`,
      minutes(3),
      async () => {
        const answer = await httpRequest(url);
        if (blockedByCloudflare(answer)) return true;
        throw new Error(
          `${url} answered ${answer.status}${answer.headers["cf-ray"] === undefined ? " without Cloudflare's cf-ray header" : ""}.`,
        );
      },
      10_000,
    );
    this.log(`${url} is blocked by Cloudflare`);
  }

  /** `adapt --no-ai --yes`, then the merge of its pull request, with `main` checked out again. */
  async adaptAndMerge(): Promise<void> {
    await this.opscrewOk("adapt", "--no-ai", "--yes");
    const head = await this.git("rev-parse", "--abbrev-ref", "HEAD");
    const branch = head.startsWith("opscrew/prepare-deploy")
      ? head
      : (
          await this.git(
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/opscrew/prepare-deploy*",
          )
        ).split(/\r?\n/)[0];
    const pull = branch ? await this.github.openPullRequest(branch) : undefined;
    if (pull === undefined) throw new Error("adapt opened no pull request.");
    this.log(`merging the adapt pull request #${pull}`);
    await this.github.merge(pull);
    await this.checkoutMain();
  }

  async checkoutMain(): Promise<void> {
    await this.git("fetch", "-q", "origin");
    await this.git("checkout", "-q", "-B", "main", "origin/main");
  }

  /**
   * `provision --plan-only`, then `provision --approve <each printed hash> --yes`, until a run
   * finishes; when an apply stops at another plan (the stack plan, or the new setup after a
   * removal), the hash it printed is approved next. A plan that deletes something (the first apply
   * of a switch to or from the tunnel) also needs the app's name: `--confirm <app>`, taken from
   * the printed command, which must name this app; it is planned only once. `args` go to every run
   * (`--env <name>`), `overrides` into its environment. Returns every run's output.
   */
  async provisionUntilDone(
    label: string,
    options: { overrides?: Record<string, string | undefined>; args?: readonly string[] } = {},
  ): Promise<string> {
    const all: string[] = [];
    let removed = false;
    const overrides = options.overrides ?? {};
    const flags = [...(options.args ?? []), ...this.provisionFlags];
    for (let round = 1; round <= 4; round++) {
      const planned = await this.opscrewOkWith(
        overrides,
        "provision",
        "--plan-only",
        ...flags,
        "--yes",
      );
      all.push(planned.output);
      const removal = removalApproval(planned.output);
      if (removal !== undefined) {
        if (removal.app !== this.appName) {
          throw new Error(`The printed command confirms "${removal.app}", not the app's name.`);
        }
        if (removed) {
          throw new Error(`${label}: the removal of the old setup was planned again.`);
        }
        removed = true;
      }
      let hashes = removal?.hashes ?? approveHashes(planned.output);
      if (hashes.length === 0) {
        this.log(`${label}: every plan is applied already; finishing provision`);
        all.push((await this.opscrewOkWith(overrides, "provision", ...flags, "--yes")).output);
        return all.join("\n");
      }
      const confirm = removal === undefined ? [] : ["--confirm", removal.app];
      for (let follow = 1; follow <= 3; follow++) {
        const applied = await this.opscrewWith(
          overrides,
          "provision",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          ...confirm,
          ...flags,
          "--yes",
        );
        all.push(applied.output);
        if (applied.exitCode === 0) return all.join("\n");
        const next = approveHashes(applied.output).filter((hash) => !hashes.includes(hash));
        if (next.length === 0) {
          throw new Error(
            `${label}: opscrew provision --approve … exited with ${applied.exitCode}:\n${this.tail(applied.output)}`,
          );
        }
        this.log(`${label}: provision asks for another plan; approving the hash it printed`);
        hashes = next;
      }
    }
    throw new Error(`${label}: opscrew provision did not finish after 4 rounds of plans.`);
  }

  /**
   * Deploys what the last provision prepared: merges its pull request and waits for the merge's
   * run of each of `workflows` (prod's by default) to succeed, returning the first one's id.
   * Returns `undefined` when provision committed nothing (it stayed on `main`); a deploy branch
   * without an open pull request stops the run.
   */
  async deploy(
    what: string,
    workflows: readonly string[] = [DEPLOY_WORKFLOW],
  ): Promise<number | undefined> {
    const sha = await this.mergeDeploySetup(what);
    return sha === undefined ? undefined : this.expectRuns(sha, workflows, what);
  }

  /**
   * Merges the deploy-setup pull request the last provision opened, with `main` checked out
   * again, and returns the merge commit; `undefined` when provision committed nothing (it stayed
   * on `main`). A deploy branch without an open pull request stops the run.
   */
  async mergeDeploySetup(what: string): Promise<string | undefined> {
    const head = await this.git("rev-parse", "--abbrev-ref", "HEAD");
    const pull = head.startsWith("opscrew/deploy-setup")
      ? await this.github.openPullRequest(head)
      : undefined;
    if (head.startsWith("opscrew/deploy-setup") && pull === undefined) {
      throw new Error(
        `provision left ${head} checked out but there is no open pull request from it, so nothing would deploy its changes.`,
      );
    }
    if (pull === undefined) {
      if (head !== "main") {
        throw new Error(`provision left ${head} checked out, neither main nor a deploy branch.`);
      }
      this.log(`provision committed nothing (${what})`);
      return undefined;
    }
    this.log(`merging pull request #${pull} (${what})`);
    const sha = await this.github.merge(pull);
    await this.checkoutMain();
    return sha;
  }

  /** Waits for the run of each of `workflows` of commit `sha` to succeed; the first one's id. */
  private async expectRuns(
    sha: string,
    workflows: readonly string[],
    what: string,
  ): Promise<number> {
    const ids: number[] = [];
    this.log(`waiting for the run of ${workflows.join(", ")} (up to 30 minutes each)`);
    for (const workflow of workflows) {
      const run = await this.github.waitForDeploy({ headSha: sha, workflow });
      ids.push(this.expectDeployed(run, `${what}, ${workflow}`));
    }
    const [first] = ids;
    if (first === undefined) throw new Error(`No workflow to wait for (${what}).`);
    return first;
  }

  /** Runs the deploy workflow on `main`, as a user would, and waits for it to succeed. */
  async deployMain(what: string): Promise<number> {
    this.log(`running the deploy workflow on main (${what})`);
    await this.checkoutMain();
    const since = new Date();
    await this.github.dispatchDeploy();
    const run = await this.github.waitForDeploy({
      headSha: await this.git("rev-parse", "HEAD"),
      event: "workflow_dispatch",
      since,
    });
    return this.expectDeployed(run, what);
  }

  /** {@link deploy}, or {@link deployMain} when provision committed nothing, as a user would. */
  async deployAny(what: string): Promise<number> {
    return (await this.deploy(what)) ?? this.deployMain(what);
  }

  /**
   * A change as a user merges one: `file` ({@link CHANGE_FILE} by default, a path in the
   * repository) written on a branch of its own, a pull request `title`, its merge, and the merge
   * commit's run of each of `workflows` (prod's by default), which must succeed. Returns the
   * first run's id.
   */
  async mergeChange(
    title: string,
    workflows: readonly string[] = [DEPLOY_WORKFLOW],
    file = CHANGE_FILE,
  ): Promise<number> {
    const branch = `e2e/change-${this.runId}-${Date.now().toString(36)}`;
    await this.git("checkout", "-q", "-b", branch);
    await mkdir(dirname(join(this.repo, file)), { recursive: true });
    await writeFile(
      join(this.repo, file),
      `${title} (run ${this.runId}, ${new Date().toISOString()}).\n`,
    );
    await this.git("add", file);
    await this.git("commit", "-q", "-m", title);
    await this.git("push", "-q", "-u", "origin", branch);
    const number = await this.github.createPullRequest(title, branch);
    this.log(`merging the change #${number}`);
    const sha = await this.github.merge(number);
    await this.checkoutMain();
    return this.expectRuns(sha, workflows, title);
  }

  private expectDeployed(
    run: Awaited<ReturnType<GitHubRepo["waitForDeploy"]>>,
    what: string,
  ): number {
    const failed = run.jobs.filter((job) => deployJobFailed(job, run.conclusion));
    if (run.conclusion !== "success" || failed.length > 0) {
      throw new Error(
        `The deploy run ${run.id} (${what}) ended ${run.conclusion}; jobs: ${run.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}.`,
      );
    }
    this.log(`deploy run ${run.id} (${what}) succeeded`);
    return run.id;
  }

  /** After a destroy: no DNS record, tunnel, Access application, policy or service token of the app. */
  async expectCloudflareClean(): Promise<void> {
    const now = await this.cloudflare.appResources(
      this.zone as CloudflareZone,
      this.app(),
      this.hostnames,
      this.workers,
    );
    expect(
      cloudflareLeft(now, this.cloudflareBefore as CloudflareAppResources),
      "nothing of the app is left in Cloudflare",
    ).toEqual({
      records: [],
      tunnels: [],
      apps: [],
      policies: [],
      serviceTokens: [],
      workers: [],
      customDomains: [],
    });
  }

  /**
   * What the leak search reads in each app with a repository ("(B)" in the second app's labels):
   * the commits of every branch and of `refs/e2e/*`, the pull requests since the run started, and
   * the audit logs.
   */
  async leakSources(): Promise<LeakSource[]> {
    const sources: LeakSource[] = [];
    for (const app of [this, ...this.children].filter((item) => item.repoReady)) {
      const source = {
        git: (...args: string[]) => app.git(...args),
        github: app.github,
        startedAt: app.startedAt,
        auditDir: app.paths().auditDir,
      };
      sources.push(...(await leakSourcesOf(source, app === this ? "" : " (B)")));
    }
    return sources;
  }

  /**
   * The end of the leak search: logs every leak and finding (built from labels, command lines,
   * file names and counts, never from the leaked text) and fails when there is any.
   */
  expectNothingLeaked(problems: readonly string[]): void {
    for (const problem of problems) this.log(`leak: ${problem}`);
    for (const finding of this.findings) this.log(`finding: ${finding}`);
    expect(problems, "nothing leaked").toEqual([]);
    expect(this.findings, "findings of the run").toEqual([]);
  }

  /**
   * The cleanup of docs/e2e.md for both apps, after every step and always, with `first` before it,
   * then `teardown` (what OpsCrew created itself), and `cloudflare` after the zone's rules;
   * problems are collected and fail it at the end.
   */
  registerCleanup(
    options: {
      first?: () => void;
      teardown?: (attempt: CleanupAttempt) => Promise<void>;
      cloudflare?: (attempt: CleanupAttempt) => Promise<void>;
    } = {},
  ): void {
    afterAll(
      async () => {
        const problems: string[] = [];
        const attempt: CleanupAttempt = async (what, body) => {
          try {
            const found = await body();
            if (Array.isArray(found)) problems.push(...found);
          } catch (error) {
            problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
        options.first?.();
        // Whatever it does, the throwaway servers, Cloudflare and the repository come after it.
        const { teardown } = options;
        if (teardown !== undefined) {
          await attempt("tear down what OpsCrew created", () => teardown(attempt));
        }
        const apps = [this, ...this.children];
        for (const app of apps.filter((item) => item.hetznerTouched)) {
          app.log("deleting the throwaway server, its SSH key and any firewall");
          await attempt("delete the throwaway server", () =>
            deleteThrowaway({
              token: app.options.settings.hcloudToken,
              runId: app.runId,
              ids: app.hetznerIds,
            }),
          );
        }
        for (const app of apps) {
          const { zone, appName, cloudflareBefore } = app;
          if (zone === undefined || appName === undefined || cloudflareBefore === undefined)
            continue;
          app.log(
            app.destroyed
              ? "checking Cloudflare for anything of the app that destroy left"
              : "destroy did not finish: removing what this run created in Cloudflare for the app",
          );
          await attempt(`remove the Cloudflare resources of ${appName}`, async () =>
            app.cloudflare.removeCreated(
              zone,
              await app.cloudflare.appResources(zone, appName, app.hostnames, app.workers),
              cloudflareBefore,
            ),
          );
          // Feature 014: the app's origin and client certificates and its origin pull settings. A
          // finished destroy must have removed them; the cleanup removes what is left either way.
          const { tlsBefore } = app;
          if (tlsBefore === undefined) continue;
          await attempt(`remove the origin TLS of ${appName}`, async () => {
            const { removed, problems: kept } = await app.cloudflare.removeTlsOfRun(
              zone,
              tlsBefore,
              app.hostnames,
              app.log,
            );
            return [
              ...kept,
              ...(app.destroyed
                ? removed.map(
                    (what) => `destroy left ${what} of ${appName}; the cleanup removed it`,
                  )
                : []),
            ];
          });
        }
        const { zone, sharedBefore } = this;
        if (zone !== undefined && sharedBefore !== undefined) {
          this.log(
            "removing the seeded rules; checking OpsCrew's shared rules for this run's hostnames",
          );
          await attempt("clean up the zone's rules", () =>
            this.cloudflare.removeRulesOfRun(zone, sharedBefore, {
              hostnames: apps.flatMap((app) => app.hostnames),
              seeded: seededDescription(this.runId),
              log: this.log,
            }),
          );
          await options.cloudflare?.(attempt);
        }
        for (const app of apps) {
          if (app.repoReady) {
            await attempt(`reset the throwaway repository ${app.github.name}`, () =>
              app.github.reset(),
            );
          }
          if (app.work !== "") {
            await rm(app.work, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        if (problems.length > 0) {
          throw this.cleanError(
            new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`),
          );
        }
        if (this.hetznerTouched)
          this.log("the throwaway servers and everything with them are deleted");
      },
      minutes(25) + (options.teardown === undefined ? 0 : TEARDOWN_TIMEOUT_MS),
    );
  }

  /**
   * The leak search's part for OpsCrew's shared Cloudflare resources (feature 011): every version
   * of `.opscrew/cloudflare.json` the run saw must hold only hostnames and ids, and none of `known`
   * (`cloudflareRecordProblems`). The Cloudflare plans are in the CLI outputs, which the search
   * covers anyway. With `expected` (a run that provisioned an app into the shared rules), seeing
   * no Cloudflare plan or no record is a finding, since then the search did not cover them.
   */
  sharedPlanLeaks(known: readonly { label: string; value: string }[], expected: boolean): string[] {
    const shown = [...this.outputs.values()].some((output) =>
      output.includes("Cloudflare plan hash: "),
    );
    if (expected && !shown) {
      this.findings.push("no CLI output showed a Cloudflare plan, so the leak search covered none");
    }
    if (expected && this.cloudflareRecords.size === 0) {
      this.findings.push(
        "no .opscrew/cloudflare.json was written, so the leak search covered none",
      );
    }
    return [...this.cloudflareRecords].flatMap((text) => cloudflareRecordProblems(text, known));
  }
}
