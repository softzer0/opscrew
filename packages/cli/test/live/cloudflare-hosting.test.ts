/**
 * The live test of feature 016's Cloudflare hosting (docs/e2e.md "Cloudflare's hosting",
 * quickstart "1.", "2.", "4." and "5."), with `OPSCREW_E2E_CLOUDFLARE_HOSTING=1`, in the e2e zone
 * on `e2e-` hostnames:
 * - `examples/static-vite` in `OPSCREW_E2E_GITHUB_REPO`: provision, the deploy, the headers, a
 *   second provision with nothing to change (the `www` redirect rule included), a change, a
 *   rollback within a minute (SC-1604), a Worker rename, staging promoted to prod with the same
 *   build SHA-256, and destroy leaving nothing. The time from `provision` to the first answer is
 *   logged; over 10 minutes is a finding that fails the run (SC-1601).
 * - `examples/astro-ssr` in `OPSCREW_E2E_GITHUB_REPO_B`, with a page showing the SHA-256 of its
 *   secret (`test/e2e/__fixtures__/astro-secret`): adapt, provision, a page rendered per request,
 *   the headers, the secret reaching the app, a new secret value, and a rollback to the version
 *   before it, which tells whether Cloudflare wants its `force` (T1610b's note).
 * - the leak search over every output, commit, pull request, audit entry and local file (SC-1602).
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { siteEnvSecret } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { httpRequest, minutes, sleep, waitFor } from "./cloud";
import { AppEnvironments, opscrewUntilApproved, secretsRecord } from "./environment-checks";
import { LiveRun, REPO_ROOT, serverSettings } from "./harness";
import {
  CLOUDFLARE_HOSTING_VARIABLES,
  redirectProblem,
  renderedAt,
  SC_1601_MS,
  SC_1604_MS,
  secretDigest,
  statusVersions,
} from "./serverless-support";
import {
  designSite,
  expectHeaders,
  rollBack,
  siteEnv,
  siteHosts,
  siteSettings,
  workerExists,
  workerOf,
  workerRunning,
  workflowOf,
  wwwOn,
} from "./site-checks";
import { approveHashes, duration, missingVariables } from "./support";

const GATE = "OPSCREW_E2E_CLOUDFLARE_HOSTING";
const MISSING = missingVariables(process.env, GATE, CLOUDFLARE_HOSTING_VARIABLES);
const SETTINGS = siteSettings(serverSettings(process.env), "static-vite");
const STAGING = "staging";
/** The SSR example's secret, as the Docker pass's page reads it (`getSecret`). */
const SECRET_NAME = "STRIPE_SECRET_KEY";
/** The Docker pass's page that shows the SHA-256 of the SSR example's secret. */
const SECRET_PAGE = join(REPO_ROOT, "packages/cli/test/e2e/__fixtures__/astro-secret");
/** A change both examples serve from their static folder, at `/opscrew-e2e-change.txt`. */
const SITE_CHANGE = "public/opscrew-e2e-change.txt";

if (process.env[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (Cloudflare hosting): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Cloudflare's hosting").`,
  );
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live Cloudflare hosting (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : "live Cloudflare hosting: examples/static-vite and examples/astro-ssr on Workers",
  () => {
    const run: LiveRun = new LiveRun({
      label: "Cloudflare hosting",
      name: "cfh",
      settings: SETTINGS,
    });
    const envs = new AppEnvironments(run, "");
    const ssr = run.second("astro-ssr");
    const ssrEnvs = new AppEnvironments(ssr, "");
    const { log } = run;
    let plan: DeployPlan | undefined;
    let ssrPlan: DeployPlan | undefined;
    /** The text of the static site's last change, as `/opscrew-e2e-change.txt` serves it. */
    let changeText = "";

    const host = () => run.appHost;
    const changeUrl = (hostname: string) =>
      `https://${hostname}/opscrew-e2e-change.txt?t=${Date.now()}`;

    /** What `/opscrew-e2e-change.txt` of `hostname` serves now (the single-page app before a change). */
    async function servedChange(hostname: string): Promise<string> {
      const answer = await httpRequest(changeUrl(hostname));
      if (answer.status !== 200) throw new Error(`${hostname} answered ${answer.status}.`);
      return answer.body;
    }

    /**
     * Whether `hostname` no longer serves the static site's last change: the file answers 404
     * (a site with its own 404 page), or something else than the change (the single-page app).
     */
    async function changeGone(hostname: string): Promise<boolean> {
      const answer = await httpRequest(changeUrl(hostname));
      if (answer.status === 404) return true;
      if (answer.status !== 200) throw new Error(`${hostname} answered ${answer.status}.`);
      return answer.body !== changeText;
    }

    /** Waits until `hostname` serves the change whose title is `title`. */
    async function waitForChange(hostname: string, title: string): Promise<string> {
      return waitFor(
        `${hostname} serving the change "${title}"`,
        minutes(5),
        async () => {
          const body = await servedChange(hostname);
          return body.includes(`${title} (run ${run.runId}`) ? body : undefined;
        },
        5_000,
      );
    }

    run.step(
      "1. designs examples/static-vite for Cloudflare's hosting on the run's own hostname, with www on",
      minutes(20),
      async () => {
        await run.prepareRepo({
          commit: "e2e: examples/static-vite on Cloudflare's hosting",
          env: siteEnv(run, SETTINGS),
        });
        await envs.snapshotGithub();
        await run.initFix();
        await designSite(run, envs, { provider: "cloudflare-workers", host: host() });
        plan = await wwwOn(run, envs);
        expect(plan.target, "the static site's target").toMatchObject({
          provider: "cloudflare-workers",
          render: "static",
          workersDev: false,
          previewUrls: false,
        });
        await envs.designed();
        const hosts = siteHosts(plan);
        await run.snapshotCloudflare(() => hosts);
        await run.seedUserRules();
      },
    );

    run.step(
      "2. provisions and deploys it: the site answers within 10 minutes of provision's start (SC-1601), and verify passes",
      minutes(45),
      async () => {
        const started = Date.now();
        await envs.provision("prod", "the static site");
        const deployed = await run.deploy("the static site's first deploy", [
          workflowOf(plan as DeployPlan),
        ]);
        if (deployed === undefined)
          throw new Error("provision opened no deploy-setup pull request.");
        await run.waitForHealth();
        const took = Date.now() - started;
        log(
          `observed: the site answered ${duration(took)} after provision started (SC-1601: at most ${duration(SC_1601_MS)})`,
        );
        if (took > SC_1601_MS) {
          run.findings.push(
            `SC-1601: the static site answered ${duration(took)} after provision started, over ${duration(SC_1601_MS)}`,
          );
        }
        await run.opscrewOk("verify");
        await run.expectSharedCloudflare("the first provision");
      },
    );

    run.step(
      "3. OpsCrew's headers on a page and on the fallback, www redirects to the domain, and a second provision has nothing to change",
      minutes(20),
      async () => {
        await expectHeaders(run, `https://${host()}/`);
        const spa =
          plan?.target.provider === "cloudflare-workers" &&
          plan.target.notFound === "single-page-application";
        await expectHeaders(run, `https://${host()}/opscrew-e2e-no-such-page`, {
          status: spa ? 200 : 404,
        });
        const from = `https://www.${host()}/opscrew/e2e?q=1`;
        const to = `https://${host()}/opscrew/e2e?q=1`;
        await waitFor(
          `www.${host()} redirecting to the domain`,
          minutes(5),
          async () => {
            const problem = redirectProblem(await httpRequest(from), to);
            if (problem !== undefined) throw new Error(problem);
            return true;
          },
          10_000,
        );
        log("observed: www redirects to the domain with a 301, keeping the path and the query");
        const planned = await run.opscrewOk("provision", "--plan-only", "--yes");
        expect(
          approveHashes(planned.output),
          `a second provision right after the first has nothing to approve, the www redirect rule included:\n${run.tail(planned.output)}`,
        ).toEqual([]);
      },
    );

    run.step(
      "4. a merged change deploys a new version; status names it and the version before",
      minutes(40),
      async () => {
        const before = statusVersions((await run.opscrewOk("status")).stdout).running;
        expect(before, "the version running before the change").toBeDefined();
        const title = "e2e: a change to the static site";
        await run.mergeChange(title, [workflowOf(plan as DeployPlan)], SITE_CHANGE);
        changeText = await waitForChange(host(), title);
        const now = statusVersions((await run.opscrewOk("status")).stdout);
        expect(now.running, "the version running after the change").not.toBe(before);
        expect(now.rollback, "the version status offers to roll back to").toBe(before);
        const running = await workerRunning(run, workerOf(plan as DeployPlan));
        expect(running.version, "the version Cloudflare serves").toBe(now.running);
        expect(running.build, "the run and build its message names").toBeDefined();
        log(
          `observed: the change runs as version ${running.version} from run ${running.build?.runId}`,
        );
      },
    );

    run.step(
      "5. promote --version rolls back to the version before within a minute (SC-1604)",
      minutes(15),
      async () => {
        const { version, startedAt } = await rollBack(run);
        await waitFor(
          `${host()} serving the version before the change`,
          minutes(3),
          async () => ((await changeGone(host())) ? true : undefined),
          2_000,
        );
        const took = Date.now() - startedAt;
        log(
          `observed: the version before answered ${duration(took)} after the approved rollback started (SC-1604: at most ${duration(SC_1604_MS)})`,
        );
        if (took > SC_1604_MS) {
          run.findings.push(
            `SC-1604: the rollback answered after ${duration(took)}, over a minute`,
          );
        }
        const running = await workerRunning(run, workerOf(plan as DeployPlan));
        expect(running.version, "the version Cloudflare serves after the rollback").toBe(version);
        await expectHeaders(run, `https://${host()}/`);
      },
    );

    run.step(
      "6. a Worker rename: the new Worker takes the custom domains, and the old one is gone",
      minutes(45),
      async () => {
        const current = await envs.readPlan();
        const { target } = current;
        if (target.provider !== "cloudflare-workers") throw new Error("The site left Cloudflare.");
        const old = target.worker;
        const renamed = `${old}-r`;
        // As a user renames the app's Worker in opscrew/plan.yaml.
        await writeArtifact("plan", envs.paths().files.plan, {
          ...current,
          target: { ...target, worker: renamed },
        });
        await run.addWorker(renamed);
        await envs.provision("prod", "the rename");
        await run.deploy("the renamed Worker's first deploy", [workflowOf(current)]);
        await run.waitForHealth();
        plan = await envs.readPlan();
        expect(workerOf(plan), "the Worker's name in the plan").toBe(renamed);
        expect(await workerExists(run, old), `the old Worker ${old} after the rename`).toBe(false);
        const accountId = run.zone?.accountId as string;
        for (const hostname of siteHosts(plan)) {
          expect(
            await run.cloudflare.customDomainServices(accountId, hostname),
            `the custom domains on ${hostname}`,
          ).toEqual([renamed]);
        }
        await expectHeaders(run, `https://${host()}/`);
        await run.expectSharedCloudflare("the rename");
        log(`observed: the Worker ${old} was replaced by ${renamed}, with its custom domains`);
      },
    );

    run.step(
      "7. staging promoted to prod: prod runs staging's build, with the same SHA-256",
      minutes(90),
      async () => {
        await run.opscrewOk(
          "env",
          "add",
          STAGING,
          "--target",
          "cloudflare-workers",
          "--from",
          "main",
        );
        const staging = await envs.designed(STAGING);
        const stagingHost = staging.dns.domain;
        if (stagingHost === undefined || stagingHost === host()) {
          throw new Error("design gave staging no hostname of its own.");
        }
        expect(workerOf(staging), "staging's Worker").not.toBe(workerOf(plan as DeployPlan));
        await envs.provision(STAGING, "staging");
        await run.deploy("staging's first deploy", [workflowOf(staging)]);
        await expectHeaders(run, `https://${stagingHost}/`, { timeoutMs: minutes(10) });
        await run.opscrewOk("env", "set", "prod", "--from", STAGING);
        await envs.provision("prod", "prod, promoted from staging");
        // Prod's promoted workflow runs only when promote starts it.
        await run.mergeDeploySetup("prod's promoted workflow");
        const title = "e2e: a change for staging";
        await run.mergeChange(title, [workflowOf(staging)], SITE_CHANGE);
        const stagingText = await waitForChange(stagingHost, title);
        const source = await workerRunning(run, workerOf(staging));
        if (source.build === undefined) {
          throw new Error("staging's running version names no build in its message.");
        }
        await opscrewUntilApproved(run, ["promote", "--to", "prod"]);
        const promoted = await workerRunning(run, workerOf(plan as DeployPlan));
        expect(promoted.build?.sha256, "the SHA-256 of the build prod runs").toBe(
          source.build.sha256,
        );
        await waitFor(
          "prod serving what staging serves",
          minutes(2),
          async () => ((await servedChange(host())) === stagingText ? true : undefined),
          5_000,
        );
        log(
          `observed: prod runs version ${promoted.version} with the build ${source.build.sha256.slice(0, 12)}… of staging's run ${source.build.runId} (its message names run ${promoted.build?.runId})`,
        );
      },
    );

    run.step(
      "8. destroys staging, then prod: nothing of the static site is left at Cloudflare or GitHub",
      minutes(30),
      async () => {
        const stagingRecord = await secretsRecord(envs.paths(STAGING));
        const staging = await envs.readPlan(STAGING);
        await envs.destroy(STAGING);
        expect(await workerExists(run, workerOf(staging)), "staging's Worker").toBe(false);
        if (stagingRecord !== undefined) await envs.expectSecretsGone(STAGING, stagingRecord);
        const record = await secretsRecord(envs.paths());
        await envs.destroy("prod");
        run.destroyed = true;
        await run.expectCloudflareClean();
        if (record !== undefined) await envs.expectSecretsGone("prod", record);
        await run.expectSharedCloudflare("the destroy");
      },
    );

    /** The SSR app's secret, as its production values hold it now. */
    let secret = "";

    /** Writes the SSR app's secret into its production values, and masks it from now on. */
    async function writeSecret(value: string): Promise<void> {
      ssr.scrubber.add(value, "app-env-value");
      await writeFile(join(ssr.work, "production.env"), `${SECRET_NAME}=${value}\n`);
      secret = value;
    }

    /** The SHA-256 the SSR app's secret page shows now. */
    async function shownDigest(): Promise<string | undefined> {
      return secretDigest(
        (await httpRequest(`https://${ssr.appHost}/secret?t=${Date.now()}`)).body,
      );
    }

    /** Waits until the SSR app's secret page shows the SHA-256 of its current secret. */
    async function waitForSecret(): Promise<void> {
      await waitFor(
        "the SSR app showing the SHA-256 of its secret",
        minutes(5),
        async () => {
          const shown = await shownDigest();
          if (shown !== sha256(secret)) throw new Error(`the page shows ${shown ?? "no digest"}.`);
          return true;
        },
        5_000,
      );
    }

    ssr.step(
      "S1. designs examples/astro-ssr with a page showing its secret's SHA-256, and adapt adds its Cloudflare adapter",
      minutes(30),
      async () => {
        await ssr.prepareRepo({
          commit: "e2e: examples/astro-ssr on Cloudflare's hosting",
          env: siteEnv(ssr, SETTINGS),
          overlay: SECRET_PAGE,
        });
        await writeSecret(fakeSecret("stripe-live-key", `ssr-${ssr.runId}`));
        await ssrEnvs.snapshotGithub();
        await ssr.initFix();
        await designSite(ssr, ssrEnvs, { provider: "cloudflare-workers", host: ssr.appHost });
        await ssr.adaptAndMerge();
        ssrPlan = await ssrEnvs.readPlan();
        expect(ssrPlan.target, "the SSR app's target").toMatchObject({
          provider: "cloudflare-workers",
          render: "ssr",
        });
        expect(
          ssrPlan.app.env.map((variable) => variable.name),
          "the app's variables",
        ).toContain(SECRET_NAME);
        await ssrEnvs.designed();
        const hosts = siteHosts(ssrPlan);
        await ssr.snapshotCloudflare(() => hosts);
      },
    );

    ssr.step(
      "S2. provisions and deploys it: pages rendered per request with OpsCrew's headers, and the secret reaches the app",
      minutes(45),
      async () => {
        await ssrEnvs.provision("prod", "the SSR app");
        await ssr.deploy("the SSR app's first deploy", [workflowOf(ssrPlan as DeployPlan)]);
        await ssr.waitForHealth();
        await ssr.opscrewOk("verify");
        const first = renderedAt((await expectHeaders(ssr, `https://${ssr.appHost}/`)).body);
        await sleep(1_500);
        const second = renderedAt((await expectHeaders(ssr, `https://${ssr.appHost}/`)).body);
        expect(first, "the home page's render time").toBeDefined();
        expect(second, "rendered again for the next request").not.toBe(first);
        await expectHeaders(ssr, `https://${ssr.appHost}/favicon.svg`);
        await waitForSecret();
        ssr.log(
          "observed: the SSR app renders per request and reads its secret (its SHA-256 matches)",
        );
      },
    );

    ssr.step(
      "S3. a new secret value goes with the next version; a rollback to the version before it says whether Cloudflare wants force",
      minutes(45),
      async () => {
        const name = siteEnvSecret(SECRET_NAME);
        const before = await ssr.github.secretUpdatedAt(name);
        const old = sha256(secret);
        const oldVersion = (await workerRunning(ssr, workerOf(ssrPlan as DeployPlan))).version;
        await writeSecret(fakeSecret("stripe-live-key", `ssr-new-${ssr.runId}`));
        await ssrEnvs.provision("prod", "the new secret value");
        expect(await ssr.github.secretUpdatedAt(name), `GitHub's ${name} was set again`).not.toBe(
          before,
        );
        // Provision commits nothing more here; should it, its merge deploys too.
        await ssr.deploy("the files of the new secret's provision", [
          workflowOf(ssrPlan as DeployPlan),
        ]);
        await ssr.mergeChange(
          "e2e: a change after the new secret",
          [workflowOf(ssrPlan as DeployPlan)],
          SITE_CHANGE,
        );
        await waitForSecret();
        // rollBack names T1610b's note on force when Cloudflare refuses the activation.
        const { version } = await rollBack(ssr, oldVersion);
        const running = await workerRunning(ssr, workerOf(ssrPlan as DeployPlan));
        expect(running.version, "the version Cloudflare serves after the rollback").toBe(version);
        // What the secret page shows once it no longer shows the new secret; still the new one
        // after two minutes means the version before had it too.
        const shown = await waitFor(
          "the secret page showing another secret than the new one",
          minutes(2),
          async () => {
            const digest = await shownDigest();
            return digest === sha256(secret) ? undefined : digest;
          },
          5_000,
        ).catch(() => sha256(secret));
        if (shown === old) {
          ssr.log(
            `observed: Cloudflare activated ${version}, a version older than the secret change, without force; it serves its own (old) secret`,
          );
        } else {
          run.findings.push(
            `after the rollback to ${version}, which ran with the old secret, the app shows ${shown === sha256(secret) ? "the new secret" : "neither secret"}: check which secrets Cloudflare gives a version activated again`,
          );
        }
      },
    );

    ssr.step(
      "S4. destroys the SSR app: nothing of it is left at Cloudflare or GitHub",
      minutes(30),
      async () => {
        const record = await secretsRecord(ssrEnvs.paths());
        await ssrEnvs.destroy("prod");
        ssr.destroyed = true;
        await ssr.expectCloudflareClean();
        if (record !== undefined) await ssrEnvs.expectSecretsGone("prod", record);
      },
    );

    run.step(
      "9. no secret (the tokens, the deploy token, the SSR app's secrets) in any output, commit, pull request, audit entry, plan, state file or Cloudflare record (SC-1602)",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: true, others: [ssrEnvs] }));
      },
      { always: true },
    );

    envs.registerCleanup({ others: [ssrEnvs] });
  },
);
