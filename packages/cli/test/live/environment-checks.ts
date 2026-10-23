/**
 * What feature 015's live tests (`environments.test.ts`, `runners.test.ts`) share on top of the
 * harness: an app's environments on servers OpsCrew creates at Hetzner (their paths and plans, the
 * secrets the leak search looks for, `deploy`'s login to each server, the image it runs, their
 * destroy and the cleanup of what OpsCrew created), GitHub's environments, runners and Actions
 * address ranges, the app's firewall against those ranges, commands that stop at a plan hash, and
 * the leak search over every output, commit, pull request, audit entry and state file. Nothing
 * here prints a secret or an address: everything logged goes through the run's scrubber.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { caFiles, readServerAddresses } from "@opscrew/agents";
import { canonicalJson, sha256Hex } from "@opscrew/core";
import { appDir, deploySecretName, githubEnvironment, runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { expect } from "vitest";
import {
  type CloudflareAppResources,
  deleteHetznerApp,
  type GitHubRepo,
  hetznerAppFirewallRules,
  hetznerAppLeft,
  minutes,
  type RepoRunner,
  RootShell,
  waitFor,
} from "./cloud";
import {
  destroyWithinBudget,
  type EnvironmentRules,
  environmentRules,
  originPullBlip,
  overlapping,
  runnerCredentialSecrets,
  runnerTokenShapes,
  sshSources,
} from "./environments-support";
import {
  CLEANUP_DESTROY_BUDGET_MS,
  CLEANUP_DESTROY_RUN_MS,
  type CleanupAttempt,
  type CliRun,
  type LiveRun,
  localLeakSources,
} from "./harness";
import { secretNames } from "./portainer-cloud";
import { deployedImage } from "./portainer-support";
import { approveHashes, type LoadFailure, leakedLabels, printedHash } from "./support";

/**
 * The scrubber's label for this computer's public address: masked in everything printed, but not
 * searched for, since the runner tests put it in the plan's `security.sshAllowedCidrs` themselves.
 */
export const TESTER_LABEL = "tester-ipv4";

/**
 * As a user starts the app's prod environment at Hetzner: `init --fix`, `analyze --no-ai`, the
 * interview's answers (behind Cloudflare on the run's own hostname when the run has a domain, with
 * the zone's snapshot for the cleanup), and `design`.
 */
export async function designProd(
  run: LiveRun,
  envs: AppEnvironments,
  region: string,
): Promise<DeployPlan> {
  const domain = run.appHost;
  await run.initFix();
  await run.opscrewOk("analyze", "--no-ai");
  const answers = join(run.work, "answers.json");
  await writeFile(
    answers,
    JSON.stringify({
      provider: "hetzner",
      expectedMonthlyUsers: "<1k",
      budgetMonthly: 20,
      region,
      uptime: "best-effort",
      dataCriticality: "important",
      dnsProvider: domain === "" ? "none" : "cloudflare",
      ...(domain === "" ? {} : { domain }),
      keepExternalServices: { s3: false },
    }),
  );
  await run.opscrewOk("interview", "--answers", answers);
  await run.opscrewOk("design");
  const plan = await envs.designed("prod");
  if (plan.target.provider !== "hetzner") {
    throw new Error(`design planned ${plan.target.provider}, not Hetzner.`);
  }
  if (domain !== "") await run.snapshotCloudflare(() => [domain, `www.${domain}`]);
  return plan;
}

/** The hash of a plan as `opscrew promote` binds it (`sha256(canonical plan)`). */
export function planHash(plan: DeployPlan): string {
  return sha256Hex(canonicalJson(plan));
}

/** OpsCrew's record of an environment's deploy secrets (`deploy_secrets.json`, names only). */
export interface SecretsRecord {
  repo: string;
  names: string[];
  /** The GitHub environment holding them apart from the build values; absent: repository secrets. */
  environment?: string;
  /** OpsCrew created that GitHub environment, so destroy deletes it. */
  createdEnvironment?: true;
}

/** OpsCrew's record of the deploy secrets of the environment at `paths`, if it kept one. */
export async function secretsRecord(paths: {
  files: { deploySecrets: string };
}): Promise<SecretsRecord | undefined> {
  const file = paths.files.deploySecrets;
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as SecretsRecord;
}

/**
 * Runs `opscrew <args>` until it exits 0, approving each new plan hash a run printed (`--approve
 * <hash>`, or `Host plan hash: <hash>`) in the next one, as a user does after reviewing it (at most
 * four runs). `cli` runs each (the run's `opscrew` by default). Throws with the output's tail
 * otherwise.
 */
export async function opscrewUntilApproved(
  run: LiveRun,
  args: readonly string[],
  cli: (...args: string[]) => Promise<CliRun> = (...all) => run.opscrew(...all),
): Promise<CliRun> {
  const approved: string[] = [];
  for (let round = 1; ; round++) {
    const result = await cli(...args, ...approved.flatMap((hash) => ["--approve", hash]));
    if (result.exitCode === 0) return result;
    const next = [
      ...new Set([...approveHashes(result.output), printedHash(result.output, "Host plan hash")]),
    ].filter((hash): hash is string => hash !== undefined && !approved.includes(hash));
    if (next.length === 0 || round >= 4) {
      throw new Error(
        `opscrew ${args.join(" ")} exited with ${result.exitCode}:\n${run.tail(result.output)}`,
      );
    }
    run.log(`opscrew ${args.slice(0, 3).join(" ")}: approving the plan hash it printed`);
    approved.push(...next);
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub.

/** The names of the repository's GitHub environments. */
export async function environmentNames(github: GitHubRepo): Promise<string[]> {
  const got = await github.call("GET", `/repos/${github.name}/environments?per_page=100`);
  if (got.status !== 200) {
    throw new Error(`Could not list the GitHub environments (HTTP ${got.status}).`);
  }
  return ((got.json as { environments?: { name: string }[] } | undefined)?.environments ?? []).map(
    (environment) => environment.name,
  );
}

/**
 * The GitHub environment `name` with its rules and, with custom branch policies, the branches
 * that may deploy to it; `undefined` when it does not exist.
 */
export async function readGithubEnvironment(
  github: GitHubRepo,
  name: string,
): Promise<(EnvironmentRules & { branches: string[] }) | undefined> {
  const path = `/repos/${github.name}/environments/${encodeURIComponent(name)}`;
  const got = await github.call("GET", path);
  if (got.status === 404) return undefined;
  if (got.status !== 200) {
    throw new Error(`Could not read the GitHub environment ${name} (HTTP ${got.status}).`);
  }
  const rules = environmentRules(got.json);
  if (rules.branchPolicy?.customBranchPolicies !== true) return { ...rules, branches: [] };
  const listed = await github.call("GET", `${path}/deployment-branch-policies?per_page=100`);
  if (listed.status !== 200) {
    throw new Error(`Could not list the branches of ${name} (HTTP ${listed.status}).`);
  }
  const policies =
    (listed.json as { branch_policies?: { name: string }[] } | undefined)?.branch_policies ?? [];
  return { ...rules, branches: policies.map((policy) => policy.name) };
}

/** The repository's approval policy for workflow runs from forks (public repositories only). */
export async function forkPrPolicy(github: GitHubRepo): Promise<string> {
  const got = await github.call(
    "GET",
    `/repos/${github.name}/actions/permissions/fork-pr-contributor-approval`,
  );
  const policy = (got.json as { approval_policy?: string } | undefined)?.approval_policy;
  if (got.status !== 200 || policy === undefined) {
    throw new Error(`Could not read the fork pull request approval policy (HTTP ${got.status}).`);
  }
  return policy;
}

/** GitHub's Actions address ranges (`actions` in `api.github.com/meta`), IPv4 and IPv6. */
export async function actionsRanges(github: GitHubRepo): Promise<string[]> {
  const got = await github.call("GET", "/meta");
  const ranges = (got.json as { actions?: string[] } | undefined)?.actions ?? [];
  if (got.status !== 200 || ranges.length === 0) {
    throw new Error(`Could not read GitHub's Actions address ranges (HTTP ${got.status}).`);
  }
  return ranges;
}

/** Waits up to 5 minutes until GitHub lists an online runner labelled `label`, and returns it. */
export function waitForRunner(github: GitHubRepo, label: string): Promise<RepoRunner> {
  return waitFor(`GitHub listing an online runner labelled ${label}`, minutes(5), async () =>
    (await github.runners()).find(
      (runner) => runner.labels.includes(label) && runner.status === "online",
    ),
  );
}

/** Waits up to 3 minutes until GitHub lists no runner labelled `label`. */
export async function expectNoRunner(github: GitHubRepo, label: string): Promise<void> {
  await waitFor(`GitHub listing no runner labelled ${label}`, minutes(3), async () =>
    (await github.runners()).some((runner) => runner.labels.includes(label)) ? undefined : true,
  );
}

/**
 * The jobs of workflow run `runId` that asked for the runner label `label`, each of which must
 * have run on `runner`; returns their names.
 */
export async function jobsOnRunner(
  github: GitHubRepo,
  runId: number,
  runner: RepoRunner,
  label: string,
): Promise<string[]> {
  const jobs = (await github.jobs(runId)).filter((job) => job.labels?.includes(label) === true);
  for (const job of jobs) {
    expect(job.runnerName, `the job "${job.name}" ran on the runner labelled ${label}`).toBe(
      runner.name,
    );
  }
  return jobs.map((job) => job.name);
}

/**
 * The firewall OpsCrew made for `app` at Hetzner lets SSH in from exactly `allowed` (this computer,
 * a runner machine) and from no address in GitHub's Actions ranges `actions`. The messages never
 * name an address.
 */
export async function expectSshClosedToActions(
  hcloudToken: string,
  app: string,
  actions: readonly string[],
  allowed: readonly string[],
): Promise<void> {
  const sources = sshSources(await hetznerAppFirewallRules(hcloudToken, app));
  expect(
    overlapping(sources, actions).length,
    "SSH sources of the app's firewall inside GitHub's Actions address ranges",
  ).toBe(0);
  expect(
    [...sources].sort().join(" ") === [...allowed].sort().join(" "),
    `the app's firewall lets SSH in from exactly the ${allowed.length} planned source(s) (it lists ${sources.length})`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// The app's environments on servers OpsCrew creates.

/**
 * An app's environments in one live run, on servers OpsCrew creates at Hetzner (`hcloudToken`):
 * which were designed, provisioned and destroyed, their paths, plans, secrets and servers, the
 * leak search over all of them, and the cleanup of what OpsCrew created for them.
 */
/**
 * The `accepted` check of `underLoad` while an environment's hostnames are added or removed:
 * Cloudflare's brief 52x answers for the zone's other hostnames while the change's origin pull
 * setting rolls out (`originPullBlip`), found in the account's audit log. The log may show an
 * entry late, so a failure is looked up only a minute after it was sent. When the log cannot be
 * read, every failure counts.
 */
export function acceptOriginPullBlips(
  run: LiveRun,
  log: (message: string) => void,
): (failure: LoadFailure) => Promise<string | undefined> {
  return async (failure) => {
    const zone = run.zone;
    if (zone === undefined || !/^HTTP 52/.test(failure.what)) return undefined;
    const sent = Date.parse(failure.at);
    const wait = sent + 60_000 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const deploys = await run.cloudflare.originPullDeploys(
        zone.accountId,
        new Date(sent - 60_000),
        new Date(sent + 60_000),
      );
      return originPullBlip(failure, deploys);
    } catch (error) {
      log(
        `Cloudflare's audit log could not be read, so the request sent at ${failure.at} counts as failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
}

export class AppEnvironments {
  /** Each designed environment's app name, in the order they were designed (prod first). */
  readonly apps = new Map<string, string>();
  /** The environments whose provision started: the cleanup destroys those not destroyed. */
  readonly provisioned = new Set<string>();
  /** The environments whose `opscrew destroy` finished. */
  readonly destroyed = new Set<string>();
  /** The designed environments' runner labels (`opscrew-<app>-<env>`). */
  readonly labels = new Set<string>();
  /** The repository's GitHub environments before the run: the cleanup never deletes those. */
  private githubBefore: string[] | undefined;
  /**
   * What Cloudflare had of each environment's app but prod's before the run (prod's is the
   * harness's): the cleanup removes only what the run created.
   */
  private readonly cloudflareBefore = new Map<string, CloudflareAppResources>();

  constructor(
    private readonly run: LiveRun,
    private readonly hcloudToken: string,
    /** The runner tests: the cleanup puts `main` back to the example (no address stays on it). */
    private readonly options: { restoreMain?: boolean } = {},
  ) {}

  /**
   * The environment's plan after its design: its app name and runner label are kept, and another
   * environment's hostnames (and `www.`) join the run's, with a snapshot of what Cloudflare has of
   * its app.
   */
  async designed(environment = "prod"): Promise<DeployPlan> {
    const { run } = this;
    const plan = await run.readPlan(environment);
    const app = plan.app.name;
    this.apps.set(environment, app);
    this.labels.add(runnerLabel(plan));
    if (environment === "prod") run.appName = app;
    const host = plan.dns.domain;
    if (environment !== "prod" && run.zone !== undefined && host !== undefined) {
      run.hostnames.push(...[host, `www.${host}`].filter((name) => !run.hostnames.includes(name)));
      this.cloudflareBefore.set(
        app,
        await run.cloudflare.appResources(run.zone, app, run.hostnames),
      );
    }
    return plan;
  }

  /** The designed environment's app name. */
  app(environment = "prod"): string {
    const app = this.apps.get(environment);
    if (app === undefined) throw new Error(`The ${environment} environment was not designed.`);
    return app;
  }

  /** Notes the repository's GitHub environments, before OpsCrew may create one. */
  async snapshotGithub(): Promise<void> {
    this.githubBefore = await environmentNames(this.run.github);
  }

  /**
   * Adds each environment's server addresses to the scrubber as soon as OpsCrew recorded them
   * (the harness's `afterCli`), so no later message shows them.
   */
  async rememberServers(): Promise<void> {
    if (this.run.repo === "") return;
    for (const environment of new Set(["prod", ...this.apps.keys()])) {
      const { deployment } = await readServerAddresses(this.run.paths(environment)).catch(() => ({
        deployment: undefined,
      }));
      this.run.scrubber.add(deployment?.ipv4, "server-ipv4");
      this.run.scrubber.add(deployment?.ipv6, "server-ipv6");
    }
  }

  /**
   * `provision --env <environment>` until it is done (each printed plan approved by its hash),
   * then the secrets it made remembered for the leak search. Returns every run's output.
   */
  async provision(environment: string, label: string): Promise<string> {
    this.provisioned.add(environment);
    const output = await this.run.provisionUntilDone(label, { args: ["--env", environment] });
    await this.remember(environment);
    return output;
  }

  /** Adds the environment's deploy key, state passphrase and generated values to the scrubber. */
  async remember(environment: string): Promise<void> {
    const paths = this.run.paths(environment);
    await this.run.rememberSecretFile(paths.files.deployKey, "deploy-private-key");
    await this.run.rememberSecretFile(paths.files.statePassphrase, "state-passphrase");
    await this.run.rememberGeneratedValues(environment);
  }

  /**
   * Makes OpsCrew's local CA in the run's own OpsCrew home (`opscrew localhost trust`, which in a
   * script only prints the trust command) and adds its key to the scrubber.
   */
  async rememberLocalCa(): Promise<void> {
    await this.run.opscrewOk("localhost", "trust");
    const kept = await this.run.rememberSecretFile(caFiles(this.run.paths()).key, "local-ca-key");
    if (!kept) {
      this.run.findings.push(
        "opscrew localhost trust made no local CA, so the leak search misses its key",
      );
    }
  }

  /** `deploy`'s SSH login to the environment's server, with OpsCrew's deploy key and known hosts. */
  async shell(environment = "prod"): Promise<RootShell> {
    const paths = this.run.paths(environment);
    const host = (await readServerAddresses(paths)).deployment?.ipv4;
    if (host === undefined) throw new Error(`OpsCrew recorded no server for ${environment}.`);
    return new RootShell(this.run.runner, {
      host,
      keyFile: paths.files.deployKey,
      knownHostsFile: paths.files.knownHosts,
      env: this.run.env,
      user: "deploy",
    });
  }

  /** The image digest (`sha256:…`) the environment's server runs, from its app's `.env`. */
  async runningDigest(environment = "prod"): Promise<string> {
    const dir = appDir(await this.run.readPlan(environment));
    const image = deployedImage(await (await this.shell(environment)).ok(`cat ${dir}/.env`));
    if (image === undefined) {
      throw new Error(`The ${environment} server's ${dir}/.env names no GHCR image digest.`);
    }
    return `sha256:${image.digest}`;
  }

  /**
   * Adds the private parts of the registered runner's credentials in `dir` (its
   * `.credentials_rsaparams`, read through `shell`) to the scrubber; none is a finding.
   */
  async rememberRunnerCredentials(shell: RootShell, dir: string): Promise<void> {
    const read = await shell.run(`cat ${dir}/.credentials_rsaparams`);
    if (this.rememberRunnerKey(read.stdout) === 0) {
      this.run.findings.push(
        `the runner in ${dir} has no readable credentials, so the leak search misses them`,
      );
    }
  }

  /**
   * Adds the private parts of a runner's RSA key in `text`, the content of its
   * `.credentials_rsaparams`, to the scrubber; returns how many it found.
   */
  rememberRunnerKey(text: string): number {
    let values: string[] = [];
    try {
      // From its first brace: the runner may write a byte order mark first.
      values = runnerCredentialSecrets(JSON.parse(text.slice(text.indexOf("{"))));
    } catch {
      // Never rethrown: JSON's error quotes the text, which holds the key.
    }
    for (const value of values) this.run.scrubber.add(value, "runner-credentials");
    return values.length;
  }

  /**
   * `opscrew destroy --env <environment> --confirm <app> --no-snapshot`, each plan it stops at
   * approved by its hash (a runner machine's host plan). With `timeLeft` (the cleanup's budget),
   * each run stops after {@link CLEANUP_DESTROY_RUN_MS} or the time left, whichever is shorter.
   */
  async destroy(environment: string, timeLeft?: () => number): Promise<void> {
    const { run } = this;
    const cli =
      timeLeft === undefined
        ? undefined
        : (...args: string[]) => {
            const ms = Math.min(CLEANUP_DESTROY_RUN_MS, timeLeft());
            if (ms <= 0) throw new Error("the cleanup's budget for opscrew destroy ended");
            return run.opscrewWithin(ms, ...args);
          };
    await opscrewUntilApproved(
      run,
      ["destroy", "--env", environment, "--confirm", this.app(environment), "--no-snapshot"],
      cli,
    );
    this.destroyed.add(environment);
  }

  /** Nothing OpsCrew created for the environment is left at Hetzner (SC-301). */
  async expectNothingLeft(environment: string): Promise<void> {
    expect(
      await hetznerAppLeft(this.hcloudToken, this.app(environment)),
      `nothing of ${environment} left at Hetzner`,
    ).toEqual([]);
  }

  /**
   * Where the environment's deploy secrets live at GitHub, as OpsCrew's record and plan say: each
   * named secret is there (in the GitHub environment or the repository), in the GitHub environment
   * the plan names or, prefixed, in the repository. Logs what it found and returns the record.
   */
  async expectSecretsPlaced(environment: string): Promise<SecretsRecord> {
    const { github } = this.run;
    const plan = await this.run.readPlan(environment);
    const record = await secretsRecord(this.run.paths(environment));
    if (record === undefined)
      throw new Error(`OpsCrew kept no record of ${environment}'s secrets.`);
    const inRepository = await secretNames(github);
    const inEnvironment =
      record.environment === undefined ? [] : await secretNames(github, record.environment);
    expect(
      record.names.filter((name) => !inRepository.includes(name) && !inEnvironment.includes(name)),
      `${environment}'s deploy secrets missing at GitHub`,
    ).toEqual([]);
    const placement = plan.environment?.secrets;
    if (placement === "environment") {
      expect(record.environment, `the GitHub environment of ${environment}'s secrets`).toBe(
        githubEnvironment(plan),
      );
      expect(inEnvironment.length, `secrets in the GitHub environment`).toBeGreaterThan(0);
    } else if (placement === "prefixed") {
      const prefix = deploySecretName(plan, "");
      expect(
        record.names.filter((name) => !name.startsWith(prefix) || !inRepository.includes(name)),
        `${environment}'s secrets as repository secrets named ${prefix}…`,
      ).toEqual([]);
    }
    this.run.log(
      `observed: ${github.name}: the deploy secrets of ${environment} are ${
        record.environment === undefined
          ? "repository secrets"
          : `in the GitHub environment ${record.environment} (${inEnvironment.length} there, ${record.names.length - inEnvironment.length} in the repository)`
      }; the plan says ${placement ?? "nothing (prod alone)"}`,
    );
    return record;
  }

  /**
   * After the environment's destroy: none of the deploy secrets in `record` is left at GitHub, and
   * the GitHub environment OpsCrew created for them is gone.
   */
  async expectSecretsGone(environment: string, record: SecretsRecord): Promise<void> {
    const { github } = this.run;
    const left = [
      ...(await secretNames(github)),
      ...(record.environment === undefined ? [] : await secretNames(github, record.environment)),
    ].filter((name) => record.names.includes(name));
    expect(left, `${environment}'s deploy secrets left at GitHub after its destroy`).toEqual([]);
    if (record.createdEnvironment === true && record.environment !== undefined) {
      expect(
        await readGithubEnvironment(github, record.environment),
        `the GitHub environment ${record.environment} OpsCrew created, after the destroy`,
      ).toBeUndefined();
    }
  }

  /**
   * The leak search: no known secret (the tokens, keys, passphrases, every environment's generated
   * values, the local CA key, runner credentials) and no string shaped like a runner registration
   * token in any CLI output, commit (every branch), pull request of the run, audit entry, or the
   * saved plans, state files, reports and Cloudflare record of each environment; no server address
   * in a commit or pull request either. `userCidrs`, the SSH sources the test planned itself (in
   * `plan.yaml`), are cut out of the texts first. With `cloudflare`, also the Cloudflare plans and
   * records ({@link LiveRun.sharedPlanLeaks}). Returns the problems, by label and place only.
   */
  async leaks(options: { cloudflare: boolean; userCidrs?: readonly string[] }): Promise<string[]> {
    const { run } = this;
    if (!run.repoReady) return [];
    const known = run.scrubber.entries().filter(({ label }) => label !== TESTER_LABEL);
    const secrets = known.filter(({ label }) => !label.startsWith("server-"));
    const problems: string[] = [];
    const search = (where: string, text: string, values: typeof known) => {
      const planned = (options.userCidrs ?? []).reduce(
        (out, cidr) => out.split(cidr).join("[planned SSH source]"),
        text,
      );
      const found = leakedLabels(planned, values);
      if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
      const shapes = runnerTokenShapes(text);
      if (shapes > 0) {
        problems.push(`${where} contains ${shapes} string(s) shaped like a runner token`);
      }
    };
    for (const source of await run.leakSources()) {
      search(source.where, source.text, source.kind === "audit log" ? secrets : known);
    }
    for (const environment of new Set(["prod", ...this.apps.keys()])) {
      for (const source of await localLeakSources(run.paths(environment))) {
        search(`${source.where} (${environment})`, source.text, secrets);
      }
    }
    for (const [label, output] of run.outputs) search(`the output of ${label}`, output, secrets);
    problems.push(...run.sharedPlanLeaks(known, options.cloudflare));
    return problems;
  }

  /**
   * The harness's cleanup, with {@link teardown} for what OpsCrew created, and the Cloudflare
   * resources of each environment's app beside prod's (the harness removes prod's).
   */
  registerCleanup(options: { first?: () => void } = {}): void {
    this.run.registerCleanup({
      ...options,
      teardown: (attempt) => this.teardown(attempt),
      cloudflare: (attempt) => this.removeCloudflare(attempt),
    });
  }

  /**
   * What OpsCrew created, always removed: `opscrew destroy` for each provisioned environment not
   * destroyed yet (newest first), within {@link CLEANUP_DESTROY_BUDGET_MS} in all; then, whatever
   * those did, through Hetzner's API whatever is left of each app, GitHub's runners with this run's
   * labels, the GitHub environments that appeared during the run, the deploy secrets OpsCrew's
   * records name, and for the runner tests `main` put back to the example.
   */
  private async teardown(attempt: CleanupAttempt): Promise<void> {
    const { run } = this;
    await destroyWithinBudget(
      {
        pending: [...this.provisioned].reverse().filter((env) => !this.destroyed.has(env)),
        destroy: (environment, timeLeft) => {
          run.log(`${environment} was not destroyed: running opscrew destroy first`);
          return this.destroy(environment, timeLeft);
        },
        budgetMs: CLEANUP_DESTROY_BUDGET_MS,
        log: run.log,
      },
      async () => {
        for (const app of this.apps.values()) {
          await attempt(`delete what OpsCrew created for ${app} at Hetzner`, async () => {
            await deleteHetznerApp(this.hcloudToken, app);
            const left = await hetznerAppLeft(this.hcloudToken, app);
            return left.length === 0
              ? []
              : [`Hetzner still lists ${left.join(", ")} of ${app}: delete them in the project`];
          });
        }
        await attempt("remove this run's runners from GitHub", () => this.removeRunners());
        await attempt("remove the GitHub environments and deploy secrets this run left", () =>
          this.removeGithubLeftovers(),
        );
        if (this.options.restoreMain === true && run.repoReady) {
          await attempt("put main back to the example's commit", () => run.restoreMain());
        }
      },
    );
  }

  /** Removes what the run created in Cloudflare for each environment's app beside prod's. */
  private async removeCloudflare(attempt: CleanupAttempt): Promise<void> {
    const { run } = this;
    const { zone } = run;
    if (zone === undefined) return;
    for (const [app, before] of this.cloudflareBefore) {
      await attempt(`remove the Cloudflare resources of ${app}`, async () =>
        run.cloudflare.removeCreated(
          zone,
          await run.cloudflare.appResources(zone, app, run.hostnames),
          before,
        ),
      );
    }
  }

  private async removeRunners(): Promise<string[]> {
    const { github } = this.run;
    const problems: string[] = [];
    for (const runner of await github.runners()) {
      if (!runner.labels.some((label) => this.labels.has(label))) continue;
      const deleted = await github.call(
        "DELETE",
        `/repos/${github.name}/actions/runners/${runner.id}`,
      );
      if (deleted.status === 204 || deleted.status === 404) {
        this.run.log(`removed the runner ${runner.name} from GitHub`);
      } else {
        problems.push(`GitHub kept the runner ${runner.name} (HTTP ${deleted.status})`);
      }
    }
    return problems;
  }

  private async removeGithubLeftovers(): Promise<string[]> {
    const { github } = this.run;
    const problems: string[] = [];
    const remove = async (path: string, what: string) => {
      const deleted = await github.call("DELETE", path);
      if (deleted.status !== 204 && deleted.status !== 404) {
        problems.push(`GitHub kept ${what} (HTTP ${deleted.status})`);
      }
      return deleted.status === 204;
    };
    for (const environment of this.apps.keys()) {
      const record = await secretsRecord(this.run.paths(environment));
      if (record === undefined || record.repo.toLowerCase() !== github.name.toLowerCase()) continue;
      for (const name of record.names) {
        await remove(`/repos/${github.name}/actions/secrets/${name}`, `the secret ${name}`);
        if (record.environment !== undefined) {
          await remove(
            `/repos/${github.name}/environments/${encodeURIComponent(record.environment)}/secrets/${name}`,
            `the secret ${name} of ${record.environment}`,
          );
        }
      }
    }
    const before = this.githubBefore;
    if (before === undefined) return problems;
    for (const name of await environmentNames(github)) {
      if (before.includes(name)) continue;
      const path = `/repos/${github.name}/environments/${encodeURIComponent(name)}`;
      if (await remove(path, `the GitHub environment ${name}`)) {
        this.run.log(`removed the GitHub environment ${name}, which appeared during the run`);
      }
    }
    return problems;
  }
}
