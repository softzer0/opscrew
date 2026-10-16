/**
 * The shared harness of the live tests on a throwaway server (`own-server.test.ts` and
 * `portainer-target.test.ts`): ordered steps that stop at the first failure, the log and its
 * scrubber, the built CLI run non-interactively, the step-1 bootstrap (the throwaway repository
 * and the throwaway Hetzner server with root SSH), provision until every plan is applied, the
 * deploy, and the cleanup that always runs (the server, what the run created in Cloudflare, the
 * repository). Nothing the harness prints holds a known secret or the server's address.
 */
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  deleteThrowaway,
  type FirewallRule,
  GitHubRepo,
  type HetznerIds,
  minutes,
  RootShell,
  type ThrowawayServer,
  waitFor,
} from "./cloud";
import {
  approveHashes,
  ed25519FromKeyscan,
  fingerprintFromKeygen,
  ipv6PrefixForms,
  removalApproval,
  runHostname,
  Scrubber,
} from "./support";

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
  const cliEnv: Record<string, string | undefined> = {
    ...process.env,
    CI: "1",
    OPSCREW_HOME: join(work, "home"),
    ...env,
  };
  for (const name of Object.keys(cliEnv)) if (name.startsWith("OPSCREW_E2E_")) delete cliEnv[name];
  for (const name of ["HCLOUD_TOKEN", "DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN"]) {
    delete cliEnv[name];
  }
  await materializeFixture(join(EXAMPLES, "nextjs-postgres"), repo);
  await runner.run("git", ["-C", repo, "init", "-q"], { env: cliEnv });
  const opscrew = async (...args: string[]) => {
    const result = await runner.run(process.execPath, [CLI, ...args], {
      cwd: repo,
      env: cliEnv,
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
      keepExternalServices: [],
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
}

/** The settings both server live tests share; `serverTypeVariable` names the test's own one. */
export function serverSettings(
  env: Record<string, string | undefined>,
  serverTypeVariable: string,
): ServerSettings {
  const serverType = env[serverTypeVariable]?.trim();
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
  };
}

/** One CLI run. */
export interface CliRun {
  exitCode: number;
  stdout: string;
  /** stdout and stderr; may hold anything, so print it only through `scrub`. */
  output: string;
}

/** A function the cleanup runs one action with: errors and returned problems are collected. */
export type CleanupAttempt = (what: string, body: () => Promise<unknown>) => Promise<void>;

/**
 * One live run on a throwaway server: its state, its steps and its cleanup. Create it in the
 * `describe` block; it does nothing until a step runs.
 */
export class LiveRun {
  readonly runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  readonly startedAt = new Date();
  readonly runner = new NodeCommandRunner();
  readonly scrubber = new Scrubber();
  readonly scrub = this.scrubber.scrub;
  readonly github: GitHubRepo;
  readonly cloudflare: Cloudflare;
  /** The app's hostname for this run only (`runHostname`), so Let's Encrypt's weekly limit never applies. */
  readonly appHost: string;
  /** Raw CLI outputs by (scrubbed) label: never printed, searched at the end. */
  readonly outputs = new Map<string, string>();
  /** Problems that do not stop the run but fail it at the end. */
  readonly findings: string[] = [];

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
  cloudflareBefore: CloudflareAppResources | undefined;
  destroyed = false;

  private stopped = false;
  private publicKey = "";
  private hetznerTouched = false;
  private readonly hetznerIds: HetznerIds = {};

  constructor(
    private readonly options: {
      /** In the log prefix: `OpsCrew E2E (<label>)`. */
      label: string;
      /** In the names of the temporary folder and the server (`opscrew-e2e-<name>-<run id>`). */
      name: string;
      settings: ServerSettings;
      /** Runs after every CLI run (for example to keep the saved plans for the leak search). */
      afterCli?: () => Promise<void>;
    },
  ) {
    const { settings } = options;
    this.github = new GitHubRepo(settings.githubToken, settings.githubRepo);
    this.cloudflare = new Cloudflare(settings.cloudflareToken);
    this.appHost = settings.domain === "" ? "" : runHostname(settings.domain, this.runId);
    this.scrubber.add(settings.hcloudToken, "hetzner-token");
    this.scrubber.add(settings.githubToken, "github-token");
    this.scrubber.add(settings.cloudflareToken, "cloudflare-token");
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

  ipv4(): string {
    return (this.server as ThrowawayServer).ipv4;
  }

  shell(): RootShell {
    return this.root as RootShell;
  }

  app(): string {
    return this.appName as string;
  }

  paths() {
    return resolveProjectPaths(this.repo, { env: this.env });
  }

  readPlan(): Promise<DeployPlan> {
    return readArtifact("plan", join(this.repo, "opscrew/plan.yaml"));
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

  /** Runs the built CLI in the project, non-interactively (`CI=1`), with `overrides` in its env. */
  async opscrewWith(
    overrides: Record<string, string | undefined>,
    ...args: string[]
  ): Promise<CliRun> {
    this.log(`running opscrew ${args.join(" ")}`);
    const result = await this.runner.run(process.execPath, [CLI, ...args], {
      cwd: this.repo,
      env: { ...this.env, ...overrides },
      timeoutMs: minutes(30),
    });
    const output = `${result.stdout}\n${result.stderr}`;
    this.outputs.set(this.scrub(`#${this.outputs.size + 1} opscrew ${args.join(" ")}`), output);
    await this.options.afterCli?.();
    if (result.timedOut === true) {
      throw new Error(
        `opscrew ${args.join(" ")} did not finish in 30 minutes:\n${this.tail(output)}`,
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

  /** The infrastructure outputs (tunnel tokens, the Access service token), read with the engine. */
  async infraOutputs(): Promise<Record<string, unknown>> {
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

  // -------------------------------------------------------------------------------------------
  // Step 1: the throwaway repository and server.

  /**
   * The first half of step 1: checks the app and the region, then makes the run's temporary
   * folder, the CLI's environment (`CI=1`, the GitHub token, `env`; never a cloud token, an SSH
   * agent, an `OPSCREW_E2E_*` variable or a name in `drop`), the server's own SSH key (never in
   * the repository, never printed), and the throwaway repository's `main` with a fresh copy of the
   * example (`commit` as its message) and without earlier pull requests or branches.
   */
  async prepareRepo(options: {
    commit: string;
    env?: Record<string, string | undefined>;
    drop?: readonly string[];
  }): Promise<void> {
    const { settings } = this.options;
    expect(existsSync(CLI), "build the CLI first: pnpm --filter opscrew build").toBe(true);
    if (!isExample(settings.app)) {
      throw new Error(
        `OPSCREW_E2E_APP="${settings.app}" is not an example under examples/ (this test deploys examples only).`,
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
    this.env = {
      ...process.env,
      CI: "1",
      OPSCREW_HOME: join(this.work, "home"),
      GITHUB_TOKEN: settings.githubToken,
      OPSCREW_APP_ENV_FILE: join(this.work, "production.env"),
      ...options.env,
    };
    // OpsCrew never gets a cloud token or an SSH agent here: the server is the user's own, and
    // the test key (by path) is the only key OpsCrew may use.
    for (const name of [
      "HCLOUD_TOKEN",
      "DIGITALOCEAN_TOKEN",
      "DIGITALOCEAN_ACCESS_TOKEN",
      "SSH_AUTH_SOCK",
      ...(options.drop ?? []),
    ]) {
      delete this.env[name];
    }
    for (const name of Object.keys(this.env)) {
      if (name.startsWith("OPSCREW_E2E_")) delete this.env[name];
    }

    const keygen = await this.runner.run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", `opscrew-e2e-${this.runId}`, "-f", this.keyFile],
      { env: this.env, timeoutMs: 60_000 },
    );
    if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
    this.scrubber.add(await readFile(this.keyFile, "utf8"), "test-private-key");
    this.publicKey = (await readFile(`${this.keyFile}.pub`, "utf8")).trim();

    this.log(`pushing examples/${settings.app} to the throwaway repository`);
    await materializeFixture(join(EXAMPLES, settings.app), this.repo);
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
    await this.git("push", "-q", "--force", "origin", "main");
    await this.github.reset();
    this.repoReady = true;
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
   * the app on `hostnames`: the cleanup never deletes what was there before the run.
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
    this.cloudflareBefore = await this.cloudflare.appResources(zone, this.app(), this.hostnames);
    return zone;
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
   * the printed command, which must name this app; it is planned only once. Returns every run's
   * output.
   */
  async provisionUntilDone(
    label: string,
    overrides: Record<string, string | undefined> = {},
  ): Promise<string> {
    const all: string[] = [];
    let removed = false;
    for (let round = 1; round <= 4; round++) {
      const planned = await this.opscrewOkWith(overrides, "provision", "--plan-only", "--yes");
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
        all.push((await this.opscrewOkWith(overrides, "provision", "--yes")).output);
        return all.join("\n");
      }
      const confirm = removal === undefined ? [] : ["--confirm", removal.app];
      for (let follow = 1; follow <= 3; follow++) {
        const applied = await this.opscrewWith(
          overrides,
          "provision",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          ...confirm,
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
   * Deploys what the last provision prepared: merges its pull request and waits for that run to
   * succeed, returning its id. Returns `undefined` when provision committed nothing (it stayed on
   * `main`); a deploy branch without an open pull request stops the run.
   */
  async deploy(what: string): Promise<number | undefined> {
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
    this.log(
      `merging pull request #${pull} (${what}) and waiting for its deploy run (up to 30 minutes)`,
    );
    const sha = await this.github.merge(pull);
    await this.checkoutMain();
    return this.expectDeployed(await this.github.waitForDeploy({ headSha: sha }), what);
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

  private expectDeployed(
    run: Awaited<ReturnType<GitHubRepo["waitForDeploy"]>>,
    what: string,
  ): number {
    const failed = run.jobs.filter((job) => job.conclusion !== "success");
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
    );
    expect(
      cloudflareLeft(now, this.cloudflareBefore as CloudflareAppResources),
      "nothing of the app is left in Cloudflare",
    ).toEqual({ records: [], tunnels: [], apps: [], policies: [], serviceTokens: [] });
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
   * The cleanup, after every step and always: `first` (for example stopping a tunnel), the
   * throwaway server, its key and firewall (they are billed), then what the run created in
   * Cloudflare (also after a finished destroy, which should have left nothing; only ids that were
   * not there before the run), then `cloudflare` (more checks there), then the repository's reset
   * and the temporary folder. Problems are collected and fail the cleanup at the end.
   */
  registerCleanup(
    options: { first?: () => void; cloudflare?: (attempt: CleanupAttempt) => Promise<void> } = {},
  ): void {
    afterAll(async () => {
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
      if (this.hetznerTouched) {
        this.log("deleting the throwaway server, its SSH key and any firewall");
        await attempt("delete the throwaway server", () =>
          deleteThrowaway({
            token: this.options.settings.hcloudToken,
            runId: this.runId,
            ids: this.hetznerIds,
          }),
        );
      }
      const { zone, appName, cloudflareBefore } = this;
      if (zone !== undefined && appName !== undefined && cloudflareBefore !== undefined) {
        this.log(
          this.destroyed
            ? "checking Cloudflare for anything this run created that destroy left"
            : "destroy did not finish: removing what this run created in Cloudflare",
        );
        await attempt("remove the Cloudflare resources", async () =>
          this.cloudflare.removeCreated(
            zone,
            await this.cloudflare.appResources(zone, appName, this.hostnames),
            cloudflareBefore,
            { hostnames: this.hostnames, log: this.log },
          ),
        );
        await options.cloudflare?.(attempt);
      }
      if (this.repoReady) {
        await attempt("reset the throwaway repository", () => this.github.reset());
      }
      if (this.work !== "") {
        await rm(this.work, { recursive: true, force: true }).catch(() => undefined);
      }
      if (problems.length > 0) {
        throw this.cleanError(
          new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`),
        );
      }
      if (this.hetznerTouched) this.log("the throwaway server and everything with it are deleted");
    }, minutes(15));
  }
}
