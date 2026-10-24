/**
 * The live test of feature 016's GitHub Pages target (docs/e2e.md "GitHub Pages", quickstart "3."
 * and "4."), with `OPSCREW_E2E_GITHUB_PAGES=1`: `examples/hugo-site` in the public throwaway
 * repository `OPSCREW_E2E_GITHUB_REPO_C`, on the run's own hostname in the e2e zone. Provision
 * turns Pages on with the workflow source and the custom domain, creates the DNS-only records and
 * the verification record, and prints the Verify step; the merge publishes the site; provision runs
 * again until GitHub has issued the certificate and HTTPS is enforced (a long, logged wait);
 * destroy goes in the takeover-safe order, watched all along, and keeps the verification record
 * until `--delete-verification` (SC-1603, SC-1605).
 *
 * The Verify click on GitHub's settings page has no API, and the record's value exists only on
 * that page for a domain added there by hand, so the pass gives provision a stand-in value
 * (`pagesStandIn`): GitHub publishes the site and issues its certificate without the
 * verification. The pass checks the record and the printed step, and skips the click.
 */
import { verificationRecordName } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { type CloudflareZone, httpRequest, minutes, sleep, waitFor } from "./cloud";
import { AppEnvironments, readGithubEnvironment, secretsRecord } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { repoInfo } from "./portainer-cloud";
import {
  GITHUB_PAGES_VARIABLES,
  pagesStandIn,
  pointsAtGitHub,
  redirectProblem,
  takeoverWindow,
} from "./serverless-support";
import { designSite, siteEnv, siteSettings, workflowOf } from "./site-checks";
import { duration, missingVariables } from "./support";

const GATE = "OPSCREW_E2E_GITHUB_PAGES";
const MISSING = missingVariables(process.env, GATE, GITHUB_PAGES_VARIABLES);
const SETTINGS = {
  ...siteSettings(serverSettings(process.env), "hugo-site"),
  githubRepo: process.env.OPSCREW_E2E_GITHUB_REPO_C?.trim() ?? "",
};
/** How long the pass waits for GitHub's certificate (GitHub documents up to 24 hours). */
const CERTIFICATE_WAIT_MS = minutes(180);
/** The text of `examples/hugo-site`'s home page. */
const HOME_TEXT = "Hugo on OpsCrew";

if (process.env[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (GitHub Pages): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "GitHub Pages").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live GitHub Pages (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : "live GitHub Pages: examples/hugo-site in the public repository",
  () => {
    const run: LiveRun = new LiveRun({ label: "GitHub Pages", name: "pages", settings: SETTINGS });
    const envs = new AppEnvironments(run, "");
    const { log } = run;
    const standIn = pagesStandIn(run.runId);
    let plan: DeployPlan | undefined;
    /** GitHub's verification record of the run's hostname. */
    let verification = "";

    const host = () => run.appHost;

    /** The zone's records on `name` now. */
    async function recordsOn(name: string) {
      const records = await run.cloudflare.zoneRecords(run.zone as CloudflareZone);
      return records.filter((record) => record.name === name);
    }

    /** A TXT record's value without the quotes Cloudflare keeps around it. */
    const txtValue = (record: { content?: string }) =>
      (record.content ?? "").replace(/^"(.*)"$/, "$1");

    run.step(
      "1. designs examples/hugo-site for GitHub Pages in the public repository, which has no Pages site yet",
      minutes(20),
      async () => {
        await run.prepareRepo({
          commit: "e2e: examples/hugo-site on GitHub Pages",
          env: siteEnv(run, SETTINGS),
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
        plan = await designSite(run, envs, { provider: "github-pages", host: host() });
        expect(plan.dns, "GitHub Pages' hostnames are DNS-only").toMatchObject({ proxied: false });
        await envs.designed();
        verification = verificationRecordName(repo.owner, host());
        const hosts = [host(), ...(plan.dns.www ? [`www.${host()}`] : []), verification];
        await run.snapshotCloudflare(() => hosts);
        await run.seedUserRules();
      },
    );

    run.step(
      "2. provision: Pages on with the workflow source and the custom domain, DNS-only records, the verification record, and the Verify step printed",
      minutes(30),
      async () => {
        const output = await envs.provision("prod", "GitHub Pages", [
          "--pages-verification",
          standIn,
        ]);
        const site = await run.github.pagesSite();
        expect(site, "the Pages site").toMatchObject({ buildType: "workflow", cname: host() });
        const records = await recordsOn(host());
        expect(
          records.some((record) => pointsAtGitHub(record)),
          "a record of the hostname points at GitHub Pages",
        ).toBe(true);
        expect(
          records.filter((record) => record.proxied === true).map((record) => record.type),
          "records of the hostname behind Cloudflare's proxy",
        ).toEqual([]);
        expect(
          (await recordsOn(verification)).map((record) => [record.type, txtValue(record)]),
          "GitHub's verification record",
        ).toEqual([["TXT", standIn]]);
        for (const words of [`click Verify next to ${host()}`, "/settings/pages"]) {
          expect(output.includes(words), `provision prints the Verify step: ${words}`).toBe(true);
        }
        log(
          "skipped: the Verify click on GitHub's settings page (no API for it, and this run's value is a stand-in); the record and the printed step are checked",
        );
        await run.expectSharedCloudflare("the provision");
      },
    );

    run.step(
      "3. the deploy-setup merge publishes the site, served over HTTP at its custom domain",
      minutes(40),
      async () => {
        const deployed = await run.deploy("the first Pages deploy", [
          workflowOf(plan as DeployPlan),
        ]);
        if (deployed === undefined)
          throw new Error("provision opened no deploy-setup pull request.");
        await waitFor(`http://${host()}/ serving the site`, minutes(10), async () => {
          const answer = await httpRequest(`http://${host()}/`);
          if (answer.status !== 200) throw new Error(`it answered ${answer.status}.`);
          return answer.body.includes(HOME_TEXT) ? true : undefined;
        });
        log("observed: GitHub Pages serves the site over HTTP at its custom domain");
      },
    );

    run.step(
      "4. the certificate: provision again until GitHub has issued it and HTTPS is enforced (up to 3 hours, logged)",
      CERTIFICATE_WAIT_MS + minutes(60),
      async () => {
        const started = Date.now();
        for (let round = 1; ; round++) {
          const site = await run.github.pagesSite();
          const health = await run.github
            .pagesHealth()
            .then((h) =>
              h === "checking" ? "still checking" : `HTTPS eligible: ${h.httpsEligible}`,
            )
            .catch((error: unknown) => `unreadable (${String(error)})`);
          log(
            `after ${duration(Date.now() - started)}: certificate ${site?.certificate ?? "none"}, HTTPS ${site?.httpsEnforced === true ? "enforced" : "not enforced"}, GitHub's DNS check ${health}`,
          );
          if (site?.httpsEnforced === true) break;
          if (Date.now() - started > CERTIFICATE_WAIT_MS) {
            throw new Error(
              `GitHub had not issued the certificate for ${host()} after ${duration(CERTIFICATE_WAIT_MS)} (it documents up to 24 hours). Run the pass again later, or check the repository's Settings → Pages.`,
            );
          }
          const output = await envs.provision("prod", `provision round ${round}`);
          // A round changes only OpsCrew's own files, which the deploy workflow's path filter
          // leaves out (T1619): merge them; no deploy run starts, and none is needed.
          await run.mergeDeploySetup(`the files of provision round ${round}`);
          // Once provision saved the domain again, GitHub issues the certificate within minutes.
          // Never past the deadline: the last look then gives the plain message above.
          const pause = output.includes("is issuing the certificate") ? minutes(2) : minutes(10);
          await sleep(Math.max(0, Math.min(pause, started + CERTIFICATE_WAIT_MS - Date.now())));
        }
        await waitFor(`https://${host()}/ serving the site`, minutes(10), async () => {
          const answer = await httpRequest(`https://${host()}/`);
          if (answer.status !== 200) throw new Error(`it answered ${answer.status}.`);
          return answer.body.includes(HOME_TEXT) ? true : undefined;
        });
        const problem = redirectProblem(
          await httpRequest(`http://${host()}/`),
          `https://${host()}/`,
        );
        expect(problem, "http:// redirects to https://").toBeUndefined();
        await run.opscrewOk("verify");
        const status = (await run.opscrewOk("status")).stdout;
        expect(status, "status shows HTTPS enforced").toContain("HTTPS: enforced");
        log(
          `observed: the certificate came and HTTPS was enforced ${duration(Date.now() - started)} after the first deploy`,
        );
      },
    );

    run.step(
      "5. destroy in the takeover-safe order: no record ever points at GitHub while no site claims the hostname, and the verification record stays (SC-1605)",
      minutes(30),
      async () => {
        const record = await secretsRecord(envs.paths());
        const watch = watchTakeover();
        try {
          await envs.destroy("prod");
        } finally {
          const seen = await watch.stop();
          log(
            `observed: ${seen.samples} samples of the Pages site and the records during destroy (${seen.failed} reads failed)`,
          );
          expect(seen.problems, "takeover windows seen during destroy").toEqual([]);
        }
        expect(await run.github.pagesSite(), "the Pages site after destroy").toBeUndefined();
        expect(
          await readGithubEnvironment(run.github, "github-pages"),
          "the github-pages environment after destroy",
        ).toBeUndefined();
        expect(
          (await recordsOn(host())).map((r) => r.type),
          "records of the hostname after destroy",
        ).toEqual([]);
        expect(
          (await recordsOn(verification)).map(txtValue),
          "GitHub's verification record stays",
        ).toEqual([standIn]);
        if (record !== undefined) await envs.expectSecretsGone("prod", record);
        await run.expectSharedCloudflare("the destroy");
      },
    );

    run.step(
      "6. destroy --delete-verification removes the verification record too: nothing of the site is left",
      minutes(20),
      async () => {
        await envs.destroy("prod", undefined, ["--delete-verification"]);
        run.destroyed = true;
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "7. no secret (the tokens) in any output, commit, pull request, audit entry, plan or state file",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: false }));
      },
      { always: true },
    );

    /**
     * Reads the Pages site, then the hostname's records, every 2 seconds until `stop()`, and
     * collects every takeover window a sample shows (`takeoverWindow`).
     */
    function watchTakeover(): {
      stop: () => Promise<{ samples: number; failed: number; problems: string[] }>;
    } {
      const problems: string[] = [];
      let samples = 0;
      let failed = 0;
      let stopped = false;
      const loop = (async () => {
        while (!stopped) {
          try {
            const site = await run.github.pagesSite();
            const problem = takeoverWindow(host(), site, await recordsOn(host()));
            if (problem !== undefined) problems.push(problem);
            samples++;
          } catch {
            failed++;
          }
          await sleep(2_000);
        }
      })();
      return {
        stop: async () => {
          stopped = true;
          await loop;
          return { samples, failed, problems };
        },
      };
    }

    envs.registerCleanup();
  },
);
