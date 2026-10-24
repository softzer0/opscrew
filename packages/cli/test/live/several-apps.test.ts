/**
 * The live test of two apps in one repository (feature 016, US6, SC-1607; docs/e2e.md "Two apps in
 * one repository"), with `OPSCREW_E2E_SEVERAL_APPS=1`: `examples/static-vite` in `sites/landing`
 * is the repository's first app, and `examples/hugo-site` in `sites/docs` is added with
 * `opscrew app add`. Both go to Cloudflare's hosting in the e2e zone, each on its own `e2e-`
 * hostname, in `OPSCREW_E2E_GITHUB_REPO`. Each answers with its own workflow and secrets, and
 * destroying the second leaves the first answering.
 */
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { minutes } from "./cloud";
import { AppEnvironments, secretsRecord } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { SEVERAL_APPS_VARIABLES } from "./serverless-support";
import {
  designSite,
  expectHeaders,
  siteEnv,
  siteHosts,
  siteSettings,
  workerExists,
  workerOf,
  workflowOf,
} from "./site-checks";
import { missingVariables, runHostname } from "./support";

const GATE = "OPSCREW_E2E_SEVERAL_APPS";
const MISSING = missingVariables(process.env, GATE, SEVERAL_APPS_VARIABLES);
const SETTINGS = siteSettings(serverSettings(process.env), "static-vite");
/** The second app's key: its Worker's name too, so not one a user's own Worker is likely to have. */
const KEY = "e2e-docs";
const FOLDERS = { "sites/landing": "static-vite", "sites/docs": "hugo-site" };

if (process.env[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (several apps): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Two apps in one repository").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live several apps (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : "live several apps: two static sites of one repository on Cloudflare's hosting",
  () => {
    const run: LiveRun = new LiveRun({ label: "several apps", name: "apps", settings: SETTINGS });
    const first = new AppEnvironments(run, "", { firstOfSeveral: true });
    const docs = new AppEnvironments(run, "", { app: KEY });
    const { log } = run;
    let firstPlan: DeployPlan | undefined;
    let docsPlan: DeployPlan | undefined;

    const docsHost = () => runHostname(SETTINGS.domain, run.runId, "docs");

    run.step(
      "1. the first app in sites/landing and a second added with app add in sites/docs, each designed for Cloudflare's hosting on its own hostname",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: "e2e: two static sites in one repository",
          env: siteEnv(run, SETTINGS),
          folders: FOLDERS,
        });
        await first.snapshotGithub();
        await docs.snapshotGithub();
        await run.initFix();
        firstPlan = await designSite(run, first, {
          provider: "cloudflare-workers",
          host: run.appHost,
          dir: "sites/landing",
        });
        await first.designed();
        const hosts = siteHosts(firstPlan);
        await run.snapshotCloudflare(() => hosts);
        await run.seedUserRules();
        await run.opscrewOk("app", "add", KEY, "--dir", "sites/docs");
        docsPlan = await designSite(run, docs, {
          provider: "cloudflare-workers",
          host: docsHost(),
        });
        await docs.designed();
        expect(docsPlan.app.key, "the second app's key in its plan").toBe(KEY);
        expect(workflowOf(docsPlan), "the second app's workflow").not.toBe(workflowOf(firstPlan));
        expect(workerOf(docsPlan), "the second app's Worker").not.toBe(workerOf(firstPlan));
        const listed = (await run.opscrewOk("app", "list")).stdout;
        expect(listed.includes(KEY) && listed.includes("first app"), "app list shows both").toBe(
          true,
        );
      },
    );

    run.step(
      "2. both provisioned and deployed, each by its own workflow and with its own secrets",
      minutes(60),
      async () => {
        await first.provision("prod", "the first app");
        await run.deploy("the first app's first deploy", [workflowOf(firstPlan as DeployPlan)]);
        await docs.provision("prod", "the second app");
        await run.deploy("the second app's first deploy", [workflowOf(docsPlan as DeployPlan)]);
        await expectHeaders(run, `https://${run.appHost}/`, { timeoutMs: minutes(10) });
        await expectHeaders(run, `https://${docsHost()}/`, { timeoutMs: minutes(10) });
        await run.opscrewOk("verify", "--app", ".");
        await run.opscrewOk("verify", "--app", KEY);
        const firstSecrets = await first.expectSecretsPlaced("prod");
        const docsSecrets = await docs.expectSecretsPlaced("prod");
        expect(
          firstSecrets.names.filter((name) => docsSecrets.names.includes(name)),
          "deploy secrets both apps share",
        ).toEqual([]);
        await run.expectSharedCloudflare("both provisions", [await docs.readPlan()]);
        log(
          `observed: each app answers on its own hostname, deployed by ${workflowOf(firstPlan as DeployPlan)} and ${workflowOf(docsPlan as DeployPlan)}`,
        );
      },
    );

    run.step(
      "3. destroying the second app leaves the first answering, with its secrets (SC-1607)",
      minutes(30),
      async () => {
        const record = await secretsRecord(docs.paths());
        await docs.destroy("prod");
        expect(await workerExists(run, workerOf(docsPlan as DeployPlan)), "the second Worker").toBe(
          false,
        );
        const accountId = run.zone?.accountId as string;
        expect(
          await run.cloudflare.customDomainServices(accountId, docsHost()),
          "custom domains on the second app's hostname",
        ).toEqual([]);
        if (record !== undefined) await docs.expectSecretsGone("prod", record);
        await expectHeaders(run, `https://${run.appHost}/`);
        await first.expectSecretsPlaced("prod");
        await run.opscrewOk("verify", "--app", ".");
        await run.expectSharedCloudflare("the second app's destroy");
      },
    );

    run.step(
      "4. destroying the first app leaves nothing of either at Cloudflare or GitHub",
      minutes(30),
      async () => {
        const record = await secretsRecord(first.paths());
        await first.destroy("prod");
        run.destroyed = true;
        await run.expectCloudflareClean();
        if (record !== undefined) await first.expectSecretsGone("prod", record);
        await run.expectSharedCloudflare("the first app's destroy");
      },
    );

    run.step(
      "5. no secret (the tokens, the deploy token) in any output, commit, pull request, audit entry, plan, state file or Cloudflare record",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await first.leaks({ cloudflare: true, others: [docs] }));
      },
      { always: true },
    );

    first.registerCleanup({ others: [docs] });
  },
);
