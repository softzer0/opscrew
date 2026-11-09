/**
 * The live passes of feature 025 on the server-less targets (docs/e2e.md "Credential rotation"),
 * with `sites` in `OPSCREW_E2E_ROTATION`, each skipped without its own variables:
 * - **a Worker on Cloudflare's hosting**: examples/astro-ssr with Better Auth's secret listed in
 *   its `.env.example`, so OpsCrew makes it. `rotate app` (with `--confirm <app>`, as Better
 *   Auth's users are logged out) stopped while its deploy runs (that deploy's version holds
 *   `BETTER_AUTH_SECRETS` set), then `--undo`: the version its deploy uploads with
 *   `--secrets-file` holds `BETTER_AUTH_SECRETS` empty, as the file writes it (T2534). The test's
 *   own page `/e2e-secret-lengths` answers both variables' lengths at each step. Then the rotation
 *   run to its end, and its record.
 * - **GitHub Pages**: examples/hugo-site in the public repository with `SESSION_SECRET` listed:
 *   `rotate app` logs users out, so a script needs `--confirm <app>` beside `--approve`; the
 *   site's GitHub secret is replaced and its deploy follows.
 * Each ends with destroy and the leak search.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deploySecretName, siteEnvSecret, verificationRecordName } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { httpRequest, minutes, waitFor } from "./cloud";
import { AppEnvironments, secretsRecord } from "./environment-checks";
import { EXAMPLES, LiveRun, serverSettings } from "./harness";
import { repoInfo } from "./portainer-cloud";
import {
  approvedRotation,
  mergeRecord,
  rememberPending,
  runUntil,
  scriptedRotation,
  secretLengths,
  servingSecrets,
  shownRotation,
} from "./rotation-checks";
import {
  generatesVariable,
  PAGES_VARIABLES,
  passSkip,
  ROTATION_GATE,
  selectedPasses,
  withExampleVariables,
} from "./rotation-support";
import { pagesStandIn } from "./serverless-support";
import { designSite, siteEnv, siteHosts, siteSettings, workerOf, workflowOf } from "./site-checks";
import { deployRunProblem } from "./support";

const ENV = process.env;
const SKIP = { worker: passSkip(ENV, "sites"), pages: passSkip(ENV, "sites", PAGES_VARIABLES) };
if (selectedPasses(ENV[ROTATION_GATE]).passes.includes("sites")) {
  for (const [part, skip] of Object.entries(SKIP)) {
    if (skip !== undefined) {
      console.warn(
        `OpsCrew E2E (rotation, sites, ${part}): skipped, ${skip} (see docs/e2e.md, "Credential rotation").`,
      );
    }
  }
}

/** The `.env.example` of `example` (empty without one) with `names` listed. */
async function exampleWith(example: string, names: readonly string[]): Promise<string> {
  const text = await readFile(join(EXAMPLES, example, ".env.example"), "utf8").catch(() => "");
  return withExampleVariables(text, names);
}

// ---------------------------------------------------------------------------------------------
// A Worker on Cloudflare's hosting.

const WORKER_APP = "astro-ssr";
const AUTH_SECRET = "BETTER_AUTH_SECRET";
const AUTH_SECRETS = "BETTER_AUTH_SECRETS";
/**
 * The test's page answering the lengths of Better Auth's two variables, never a value. It reads
 * them by a computed name, so OpsCrew's analysis doesn't take them for variables the app's own
 * code needs (a plan that names `BETTER_AUTH_SECRETS` makes it the user's, not OpsCrew's).
 */
const LENGTHS_PAGE = `import type { APIRoute } from 'astro';

// The OpsCrew live test's page: it answers lengths only, never a value.
const NAMES = ['${AUTH_SECRET}', '${AUTH_SECRETS}'];
export const GET: APIRoute = () =>
  Response.json(Object.fromEntries(NAMES.map((name) => [name, (process.env[name] ?? '').length])));
`;

describe.skipIf(SKIP.worker !== undefined)(
  SKIP.worker === undefined
    ? `live rotation, sites: examples/${WORKER_APP} on a Worker, its previous secrets emptied by the undo`
    : `live rotation, sites, Worker (skipped: ${SKIP.worker}; see docs/e2e.md)`,
  () => {
    const settings = siteSettings(serverSettings(ENV), WORKER_APP);
    const run: LiveRun = new LiveRun({ label: "rotation, Worker", name: "rot-worker", settings });
    const envs = new AppEnvironments(run, "");
    let plan: DeployPlan | undefined;
    const worker = () => workerOf(plan as DeployPlan);
    const workflow = () => workflowOf(plan as DeployPlan);

    run.step(
      `1. examples/${WORKER_APP} with ${AUTH_SECRET} listed: designed, adapted, provisioned and deployed; its version holds ${AUTH_SECRET} and ${AUTH_SECRETS} empty`,
      minutes(60),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${WORKER_APP} on Cloudflare's hosting, for credential rotation`,
          env: siteEnv(run, settings),
          files: {
            ".env.example": await exampleWith(WORKER_APP, [AUTH_SECRET]),
            "src/pages/e2e-secret-lengths.ts": LENGTHS_PAGE,
          },
        });
        await envs.snapshotGithub();
        await run.initFix();
        await designSite(run, envs, { provider: "cloudflare-workers", host: run.appHost });
        await run.adaptAndMerge();
        plan = await envs.readPlan();
        expect(plan.target, "the site's target").toMatchObject({
          provider: "cloudflare-workers",
          render: "ssr",
        });
        expect(generatesVariable(plan, AUTH_SECRET), `OpsCrew generates ${AUTH_SECRET}`).toBe(true);
        await envs.designed();
        const hosts = siteHosts(plan);
        await run.snapshotCloudflare(() => hosts);
        await envs.provision("prod", "the site");
        await run.deploy("the site's first deploy", [workflow()]);
        await run.waitForHealth();
        const secrets = await servingSecrets(run, worker());
        expect(secrets, "the first version's secrets").toContain(AUTH_SECRET);
        await secretLengths(run, (got) => got[AUTH_SECRET] > 0 && got[AUTH_SECRETS] === 0);
      },
    );

    run.step(
      `2. opscrew rotate app with --confirm <app> (Better Auth's users are logged out), stopped while its deploy runs: that deploy's version holds ${AUTH_SECRETS} set, and the rotation stays unfinished`,
      minutes(40),
      async () => {
        const shown = await shownRotation(run, ["app"]);
        await run.checkoutMain();
        const head = await run.git("rev-parse", "HEAD");
        const since = new Date();
        // Better Auth's users are logged out, so the plan asks the app's name.
        expect(
          shown.output.includes(`--confirm ${envs.app()}`),
          `the plan asks the app's name:\n${run.tail(shown.output)}`,
        ).toBe(true);
        await runUntil(
          run,
          [
            "rotate",
            "app",
            ...shown.hashes.flatMap((hash) => ["--approve", hash]),
            "--confirm",
            envs.app(),
            "--yes",
          ],
          "Waiting for the deploy run",
        );
        const deployed = await run.github.waitForDeploy({
          headSha: head,
          event: "workflow_dispatch",
          since,
          workflow: workflow(),
        });
        const problem = deployRunProblem(deployed);
        if (problem !== undefined)
          throw new Error(`The rotation's deploy run ${deployed.id}: ${problem}.`);
        expect(await rememberPending(run, envs.paths()), "the unfinished rotation kept").toBe(true);
        expect(await servingSecrets(run, worker()), "the rotation's version's secrets").toContain(
          AUTH_SECRET,
        );
        await secretLengths(run, (got) => got[AUTH_SECRETS] > 0);
      },
    );

    run.step(
      `3. opscrew rotate app --undo: its deploy uploads a version with --secrets-file that holds ${AUTH_SECRETS} empty (T2534)`,
      minutes(40),
      async () => {
        const { done } = await scriptedRotation(run, ["app", "--undo"]);
        expect(
          done.output.includes("Put the old values of"),
          `the undo's result:\n${run.tail(done.output)}`,
        ).toBe(true);
        expect(await rememberPending(run, envs.paths()), "an unfinished rotation left").toBe(false);
        expect(await servingSecrets(run, worker()), "the undo's version's secrets").toContain(
          AUTH_SECRET,
        );
        await secretLengths(run, (got) => got[AUTH_SECRET] > 0 && got[AUTH_SECRETS] === 0);
        await run.waitForHealth();
      },
    );

    run.step(
      `4. opscrew rotate app with --confirm <app> to its end: the version holds ${AUTH_SECRET} and ${AUTH_SECRETS} set, and the record is merged (US4)`,
      minutes(40),
      async () => {
        const since = new Date();
        const { done } = await scriptedRotation(run, ["app"], { confirm: envs.app() });
        expect(
          done.output.includes("the site runs on the new values"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        expect(await servingSecrets(run, worker()), "the rotated version's secrets").toContain(
          AUTH_SECRET,
        );
        await secretLengths(run, (got) => got[AUTH_SECRETS] > 0);
        await mergeRecord(run, envs.paths(), "prod", { [`app:${AUTH_SECRET}`]: 2 }, since);
        await run.waitForHealth();
      },
    );

    run.step("5. destroy leaves nothing at Cloudflare or GitHub", minutes(30), async () => {
      const record = await secretsRecord(envs.paths());
      await envs.destroy("prod");
      await run.expectCloudflareClean();
      if (record !== undefined) await envs.expectSecretsGone("prod", record);
    });

    run.step(
      "6. no secret, old or new, in any output, audit entry, commit, pull request, plan or state file (SC-2503)",
      minutes(10),
      async () => run.expectNothingLeaked(await envs.leaks({ cloudflare: true })),
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// GitHub Pages.

const PAGES_APP = "hugo-site";
const SESSION_SECRET = "SESSION_SECRET";

describe.skipIf(SKIP.pages !== undefined)(
  SKIP.pages === undefined
    ? `live rotation, sites: examples/${PAGES_APP} on GitHub Pages, a secret that logs users out`
    : `live rotation, sites, GitHub Pages (skipped: ${SKIP.pages}; see docs/e2e.md)`,
  () => {
    const settings = {
      ...siteSettings(serverSettings(ENV), PAGES_APP),
      githubRepo: ENV.OPSCREW_E2E_GITHUB_REPO_C?.trim() ?? "",
    };
    const run: LiveRun = new LiveRun({
      label: "rotation, GitHub Pages",
      name: "rot-pages",
      settings,
    });
    const envs = new AppEnvironments(run, "");
    let plan: DeployPlan | undefined;

    run.step(
      `1. examples/${PAGES_APP} with ${SESSION_SECRET} listed, in the public repository: designed, provisioned and published`,
      minutes(60),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${PAGES_APP} on GitHub Pages, for credential rotation`,
          env: siteEnv(run, settings),
          files: { ".env.example": await exampleWith(PAGES_APP, [SESSION_SECRET]) },
        });
        const repo = await repoInfo(run.github);
        if (repo.private) {
          throw new Error(
            "OPSCREW_E2E_GITHUB_REPO_C must be a public repository: GitHub Pages is free there on every plan.",
          );
        }
        await envs.expectNoPagesSite();
        await envs.snapshotGithub();
        await run.initFix();
        plan = await designSite(run, envs, { provider: "github-pages", host: run.appHost });
        expect(generatesVariable(plan, SESSION_SECRET), `OpsCrew generates ${SESSION_SECRET}`).toBe(
          true,
        );
        await envs.designed();
        const verification = verificationRecordName(repo.owner, run.appHost);
        const hosts = [run.appHost, ...(plan.dns.www ? [`www.${run.appHost}`] : []), verification];
        await run.snapshotCloudflare(() => hosts);
        await envs.provision("prod", "GitHub Pages", [
          "--pages-verification",
          pagesStandIn(run.runId),
        ]);
        await run.deploy("the first Pages deploy", [workflowOf(plan)]);
        await waitFor(`http://${run.appHost}/ serving the site`, minutes(10), async () =>
          (await httpRequest(`http://${run.appHost}/`)).status === 200 ? true : undefined,
        );
      },
    );

    run.step(
      `2. opscrew rotate app: ${SESSION_SECRET} logs users out, so a script needs --confirm <app> beside --approve; then its GitHub secret is replaced, its deploy passes and the record is merged (US4, R9)`,
      minutes(40),
      async () => {
        const app = envs.app();
        const secret = deploySecretName(plan as DeployPlan, siteEnvSecret(SESSION_SECRET));
        const before = await run.github.secretUpdatedAt(secret);
        const since = new Date();
        const shown = await shownRotation(run, ["app"]);
        expect(
          shown.output.includes(`--confirm ${app}`),
          `the plan asks the app's name:\n${run.tail(shown.output)}`,
        ).toBe(true);
        const unnamed = await run.opscrew(
          "rotate",
          "app",
          ...shown.hashes.flatMap((h) => ["--approve", h]),
        );
        expect(unnamed.exitCode, `approved without the name:\n${run.tail(unnamed.output)}`).toBe(1);
        expect(await run.github.secretUpdatedAt(secret), `${secret} without the name`).toBe(before);
        const done = await approvedRotation(run, ["app"], shown.hashes, { confirm: app });
        expect(
          done.output.includes("the site runs on the new values"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        expect(await run.github.secretUpdatedAt(secret), `${secret} after the rotation`).not.toBe(
          before,
        );
        await mergeRecord(run, envs.paths(), "prod", { [`app:${SESSION_SECRET}`]: 2 }, since);
        expect(
          (await httpRequest(`http://${run.appHost}/`)).status,
          "the site after the rotation",
        ).toBe(200);
      },
    );

    run.step(
      "3. destroy --delete-verification leaves nothing at Cloudflare or GitHub",
      minutes(30),
      async () => {
        await envs.destroy("prod", undefined, ["--delete-verification"]);
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "4. no secret, old or new, in any output, audit entry, commit, pull request, plan or state file (SC-2503)",
      minutes(10),
      async () => run.expectNothingLeaked(await envs.leaks({ cloudflare: false })),
      { always: true },
    );

    envs.registerCleanup();
  },
);
