/**
 * What feature 016's live tests on the server-less targets (`cloudflare-hosting.test.ts`,
 * `github-pages.test.ts`, `several-apps.test.ts`) share on top of the harness and the environment
 * checks: the CLI's tokens for a site, the design of a site as a user starts it, its hostnames and
 * workflow, OpsCrew's headers on an answer, the version a Worker runs and the build it came from,
 * and a rollback through `opscrew promote --version`, each approved by its hash. Everything logged
 * goes through the run's scrubber.
 */
import { writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { httpRequest, minutes, waitFor } from "./cloud";
import type { AppEnvironments } from "./environment-checks";
import type { LiveRun, ServerSettings } from "./harness";
import { missingHeaders, servingVersion, statusVersions, versionBuild } from "./serverless-support";
import { approveHashes, duration } from "./support";

/** The deploy token the Cloudflare passes give OpsCrew (`OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN`). */
export const DEPLOY_TOKEN = process.env.OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN?.trim() ?? "";

/**
 * The settings of a pass on a server-less target: the shared ones without a Hetzner token (no
 * server) or `OPSCREW_E2E_APP_ENV` (the pass writes its own values), with `app` as the example.
 */
export function siteSettings(settings: ServerSettings, app: string): ServerSettings {
  const { appEnvFile: _, ...shared } = settings;
  return { ...shared, hcloudToken: "", app };
}

/**
 * The CLI's tokens for a site, as a user sets them: OpsCrew's own Cloudflare token and, for
 * Cloudflare's hosting, the deploy token it stores in GitHub, which is added to the run's scrubber.
 */
export function siteEnv(run: LiveRun, settings: ServerSettings): Record<string, string> {
  run.scrubber.add(DEPLOY_TOKEN, "cloudflare-deploy-token");
  return {
    CLOUDFLARE_API_TOKEN: settings.cloudflareToken,
    ...(DEPLOY_TOKEN === "" ? {} : { OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY_TOKEN }),
  };
}

/**
 * As a user starts a site: `analyze --no-ai` (with `--dir` for the repository's first app in a
 * folder), the interview's answers (`provider`, the site's own hostname `host` on Cloudflare's
 * DNS) and `design`, each for `envs`'s app. Returns the plan, which must be on `provider`.
 */
export async function designSite(
  run: LiveRun,
  envs: AppEnvironments,
  options: { provider: "cloudflare-workers" | "github-pages"; host: string; dir?: string },
): Promise<DeployPlan> {
  const app = envs.appArgs;
  await run.opscrewOk(
    "analyze",
    "--no-ai",
    ...app,
    ...(options.dir === undefined ? [] : ["--dir", options.dir]),
  );
  const answers = join(run.work, `answers${app.length === 0 ? "" : `-${app[1]}`}.json`);
  await writeFile(
    answers,
    JSON.stringify({
      provider: options.provider,
      expectedMonthlyUsers: "<1k",
      budgetMonthly: 20,
      uptime: "best-effort",
      dataCriticality: "none",
      dnsProvider: "cloudflare",
      domain: options.host,
    }),
  );
  await run.opscrewOk("interview", ...app, "--answers", answers);
  await run.opscrewOk("design", ...app);
  const plan = await envs.readPlan();
  if (plan.target.provider !== options.provider) {
    throw new Error(`design planned ${plan.target.provider}, not ${options.provider}.`);
  }
  return plan;
}

/**
 * Turns `www` on in the app's `opscrew/plan.yaml`, as a user edits it (design leaves it off below
 * the zone's apex), so the pass covers the `www` custom domain and OpsCrew's redirect rule.
 */
export async function wwwOn(run: LiveRun, envs: AppEnvironments): Promise<DeployPlan> {
  const plan = await envs.readPlan();
  if (plan.dns.www) return plan;
  const changed = { ...plan, dns: { ...plan.dns, www: true } };
  await writeArtifact("plan", envs.paths().files.plan, changed);
  run.log("turned www on in opscrew/plan.yaml, as a user does");
  return changed;
}

/** The site's hostnames: its domain, and `www.` when it serves that too. */
export function siteHosts(plan: DeployPlan): string[] {
  const domain = plan.dns.domain;
  if (domain === undefined) throw new Error("The site's plan has no domain.");
  return plan.dns.www ? [domain, `www.${domain}`] : [domain];
}

/** The file name of the plan's deploy workflow. */
export function workflowOf(plan: DeployPlan): string {
  return posix.basename(plan.cicd.workflowPath);
}

/** The plan's Worker on Cloudflare's hosting. */
export function workerOf(plan: DeployPlan): string {
  if (plan.target.provider !== "cloudflare-workers") {
    throw new Error(`The plan is on ${plan.target.provider}, not on Cloudflare's hosting.`);
  }
  return plan.target.worker;
}

/**
 * Waits up to `timeoutMs` until `url` answers `status` (200 by default) with every one of
 * OpsCrew's security headers (through Cloudflare's public resolver), and returns the answer.
 */
export async function expectHeaders(
  run: LiveRun,
  url: string,
  options: { status?: number; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<typeof httpRequest>>> {
  const status = options.status ?? 200;
  const answer = await waitFor(
    `${url} answering ${status} with OpsCrew's headers`,
    options.timeoutMs ?? minutes(5),
    async () => {
      const got = await httpRequest(url);
      if (got.status !== status) throw new Error(`${url} answered ${got.status}.`);
      const missing = missingHeaders(got.headers);
      if (missing.length > 0) throw new Error(`${url} answered without ${missing.join(", ")}.`);
      return got;
    },
    5_000,
  );
  run.log(`observed: ${url} answers ${status} with OpsCrew's security headers`);
  return answer;
}

/**
 * Waits, logged, up to 15 minutes until `https://www.<host>/` answers over HTTPS with any status:
 * Cloudflare issues a Workers custom domain's own certificate minutes after provision when the
 * hostname is below the zone's first level (seen live).
 */
export async function wwwAnswers(run: LiveRun, host: string): Promise<void> {
  const url = `https://www.${host}/`;
  const started = Date.now();
  run.log(`waiting for ${url} to answer over HTTPS (its certificate may take minutes)`);
  const answer = await waitFor(
    `${url} answering over HTTPS`,
    minutes(15),
    () => httpRequest(url),
    10_000,
  );
  run.log(`observed: ${url} answered ${answer.status} ${duration(Date.now() - started)} later`);
}

/**
 * The version the Worker `worker` runs now, read from Cloudflare's deployments, and the run and
 * build SHA-256 its message names (`undefined` for a version OpsCrew's workflow did not upload).
 */
export async function workerRunning(
  run: LiveRun,
  worker: string,
): Promise<{ version: string; build: ReturnType<typeof versionBuild> }> {
  const accountId = run.zone?.accountId;
  if (accountId === undefined) throw new Error("The run has no Cloudflare zone.");
  const deployments = await run.cloudflare.workerDeployments(accountId, worker);
  const version = deployments === undefined ? undefined : servingVersion(deployments);
  if (version === undefined) throw new Error(`The Worker ${worker} runs no version.`);
  const message = await run.cloudflare.workerVersionMessage(accountId, worker, version);
  return { version, build: versionBuild(message) };
}

/** Whether the account still has the Worker `worker`. */
export async function workerExists(run: LiveRun, worker: string): Promise<boolean> {
  const accountId = run.zone?.accountId;
  if (accountId === undefined) throw new Error("The run has no Cloudflare zone.");
  return (await run.cloudflare.workerDeployments(accountId, worker)) !== undefined;
}

/**
 * Prod's rollback as a user runs it: `opscrew status` names the version before and its command
 * (or `version` is given); `promote --to prod --version <it>` shows the rollback and stops at its
 * approval (exit 1); the same with `--approve <the hash it printed>` rolls back. Returns the
 * version and when the approved run started, for the "within a minute" checks.
 */
export async function rollBack(
  run: LiveRun,
  version?: string,
): Promise<{ version: string; startedAt: number }> {
  let rollback = version;
  if (rollback === undefined) {
    const status = await run.opscrewOk("status");
    rollback = statusVersions(status.stdout).rollback;
    if (rollback === undefined) {
      throw new Error(
        `opscrew status named no version to roll back to:\n${run.tail(status.output)}`,
      );
    }
  }
  const promote = ["promote", "--to", "prod"];
  const shown = await run.opscrew(...promote, "--version", rollback);
  expect(
    shown.exitCode,
    `promote --version without --approve stops at the approval:\n${run.tail(shown.output)}`,
  ).toBe(1);
  const hash = approveHashes(shown.output).at(-1);
  if (hash === undefined) {
    throw new Error(`promote printed no command to approve:\n${run.tail(shown.output)}`);
  }
  const startedAt = Date.now();
  const approved = await run.opscrew(...promote, "--version", rollback, "--approve", hash);
  if (approved.exitCode !== 0) {
    throw new Error(
      `The approved rollback to ${rollback} exited with ${approved.exitCode}. A version older than a secret change is refused, naming the secrets, unless --allow-old-secrets names them (T1623):\n${run.tail(approved.output)}`,
    );
  }
  return { version: rollback, startedAt };
}
