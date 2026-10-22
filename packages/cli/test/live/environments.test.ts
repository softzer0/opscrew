/**
 * The live tests of feature 015's environments (docs/e2e.md "Environments and promotion" and "The
 * environment rules on a public repository"):
 * - `OPSCREW_E2E_ENVIRONMENTS=1`: prod and staging on servers OpsCrew creates at Hetzner, in the
 *   Free private throwaway repository (quickstart "2." and "3."). Prod's plan hash and site stay
 *   unchanged under load while staging is added, provisioned, deployed and destroyed; prod is then
 *   promoted from staging, runs staging's exact digest, and rolls back with `--digest`.
 * - with `OPSCREW_E2E_GITHUB_REPO_C` too: the public throwaway repository, where GitHub enforces
 *   every environment rule. Provision creates staging's GitHub environment with its branch rule,
 *   destroy removes it, and a runner for the public repository is only planned, never applied.
 */
import { posix } from "node:path";
import { runnerLabel } from "@opscrew/iac-templates";
import { describe, expect } from "vitest";
import { underLoad } from "./builder-checks";
import { type CloudflareZone, DEPLOY_WORKFLOW, minutes } from "./cloud";
import {
  AppEnvironments,
  acceptOriginPullBlips,
  designProd,
  expectNoRunner,
  forkPrPolicy,
  planHash,
  readGithubEnvironment,
  type SecretsRecord,
  secretsRecord,
} from "./environment-checks";
import {
  ENVIRONMENT_E2E_VARIABLES,
  promotionApproval,
  RULES_E2E_VARIABLES,
} from "./environments-support";
import { LiveRun, serverSettings } from "./harness";
import { repoInfo } from "./portainer-cloud";
import { approveHashes, missingVariables } from "./support";

const GATE = "OPSCREW_E2E_ENVIRONMENTS";
const MISSING = missingVariables(process.env, GATE, ENVIRONMENT_E2E_VARIABLES);
const MISSING_RULES = missingVariables(process.env, GATE, RULES_E2E_VARIABLES);
const SETTINGS = serverSettings(process.env);
/** Optional: the classic `read:packages` token promote reads GHCR with (docs/e2e.md). */
const GHCR_READ_TOKEN = process.env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
const STAGING = "staging";

if (process.env[GATE] === "1") {
  for (const [what, missing] of [
    ["environments", MISSING],
    ["environment rules", MISSING_RULES],
  ] as const) {
    if (missing.length > 0) {
      console.warn(
        `OpsCrew E2E (${what}): skipped, set ${missing.join(", ")} (see docs/e2e.md, "Environments and promotion").`,
      );
    }
  }
}

/** The file name of the environment's deploy workflow (`opscrew-deploy-<env>.yml`). */
async function workflowOf(run: LiveRun, environment: string): Promise<string> {
  return posix.basename((await run.readPlan(environment)).cicd.workflowPath);
}

/**
 * `promote --to prod [--digest <digest>]` as a script runs it: the first run shows the promotion
 * and stops at its approval (exit 1); the promotion it shows must deploy `expected`; the second
 * run deploys it with `--approve <its hash>`.
 */
async function promoteToProd(run: LiveRun, expected: string, digest?: string): Promise<void> {
  const flags = digest === undefined ? [] : ["--digest", digest];
  const shown = await run.opscrew("promote", "--to", "prod", ...flags);
  expect(
    shown.exitCode,
    `promote without --approve stops at the approval:\n${run.tail(shown.output)}`,
  ).toBe(1);
  const approval = promotionApproval(shown.output);
  if (approval === undefined) {
    throw new Error(`promote printed no command to approve:\n${run.tail(shown.output)}`);
  }
  expect(approval.digest, "the digest the promotion shows").toBe(expected);
  await run.opscrewOk(
    "promote",
    "--to",
    "prod",
    "--digest",
    approval.digest,
    "--approve",
    approval.hash,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live environments and promotion (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live environments and promotion: examples/${SETTINGS.app}, prod and staging at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "environments",
      name: "env",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    /** Prod's plan hash, taken again only where prod's own plan changes (`env set`). */
    let prodHash = "";
    let stagingHosts: string[] = [];
    let stagingHealth = "";
    let stagingSecrets: SecretsRecord | undefined;
    /** The image prod runs before its first promotion: the rollback's target. */
    let previous = "";

    /** Prod's plan hash is still `prodHash`, and provision would apply nothing to prod. */
    async function expectProdUnchanged(after: string): Promise<void> {
      expect(planHash(await run.readPlan()), `prod's plan hash after ${after}`).toBe(prodHash);
      const planned = await run.opscrewOk("provision", "--env", "prod", "--plan-only", "--yes");
      expect(
        approveHashes(planned.output),
        `nothing to approve for prod after ${after}:\n${run.tail(planned.output)}`,
      ).toEqual([]);
    }

    run.step(
      "1. designs prod at Hetzner in the Free private repository, and makes a local CA",
      minutes(20),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} with environments`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            ...(GHCR_READ_TOKEN === "" ? {} : { OPSCREW_GHCR_READ_TOKEN: GHCR_READ_TOKEN }),
          },
        });
        run.scrubber.add(GHCR_READ_TOKEN, "ghcr-read-token");
        const repo = await repoInfo(run.github);
        log(
          `observed: OPSCREW_E2E_GITHUB_REPO is ${repo.private ? "private" : "public"} and owned by a ${repo.ownerType}`,
        );
        await envs.snapshotGithub();
        await designProd(run, envs, SETTINGS.region);
        await envs.rememberLocalCa();
      },
    );

    run.step("2. provisions and deploys prod", minutes(60), async () => {
      await run.adaptAndMerge();
      await envs.provision("prod", "prod");
      await run.deployAny("prod's first deploy");
      await run.waitForHealth();
      await run.opscrewOk("verify", "--env", "prod");
      prodHash = planHash(await run.readPlan());
    });

    run.step(
      "3. adds staging, provisions and deploys it while prod answers under load with its plan unchanged",
      minutes(90),
      async () => {
        await underLoad(
          [await run.healthUrl()],
          "staging's addition",
          log,
          async () => {
            await run.opscrewOk("env", "add", STAGING, "--target", "hetzner", "--from", "main");
            const staging = await envs.designed(STAGING);
            const host = staging.dns.domain;
            if (host === undefined || host === run.appHost) {
              throw new Error("design gave staging no hostname of its own.");
            }
            stagingHosts = [host, `www.${host}`];
            stagingHealth = `https://${host}${staging.app.healthPath}`;
            expect(planHash(await run.readPlan()), "prod's plan hash after env add").toBe(prodHash);
            await envs.provision(STAGING, "staging");
            expect(
              planHash(await run.readPlan()),
              "prod's plan hash after staging's provision",
            ).toBe(prodHash);
            const deployed = await run.deploy("staging's first deploy", [
              await workflowOf(run, STAGING),
              DEPLOY_WORKFLOW,
            ]);
            if (deployed === undefined) {
              throw new Error("staging's provision opened no deploy-setup pull request.");
            }
          },
          acceptOriginPullBlips(run, log),
        );
        await run.waitForHealth(minutes(10), true, stagingHealth);
        await run.opscrewOk("verify", "--env", STAGING);
        await expectProdUnchanged("staging's provision and deploy");
        stagingSecrets = await envs.expectSecretsPlaced(STAGING);
        const github = await readGithubEnvironment(run.github, STAGING);
        log(
          `observed: the GitHub environment ${STAGING} ${
            github === undefined
              ? "does not exist"
              : `has ${github.reviewers} required reviewer(s), a wait timer of ${github.waitTimer} minute(s) and ${github.branchPolicy === null ? "no branch rule" : `a branch rule for ${github.branches.join(", ") || "no branch"}`}`
          }`,
        );
        const listed = (await run.opscrewOk("env", "list")).stdout;
        expect(
          ["prod", STAGING].every((name) => listed.includes(name)),
          `env list shows prod and staging:\n${run.tail(listed)}`,
        ).toBe(true);
      },
    );

    run.step(
      "4. env set prod --from staging, and prod's provision makes its workflow the promoted one",
      minutes(45),
      async () => {
        await run.opscrewOk("env", "set", "prod", "--from", STAGING);
        expect((await run.readPlan()).environment?.deploySource, "prod's deploy source").toEqual({
          from: "promote",
          source: STAGING,
        });
        await envs.provision("prod", "prod, promoted from staging");
        const merged = await run.deploy("prod's promoted workflow", [
          await workflowOf(run, STAGING),
        ]);
        if (merged === undefined) {
          throw new Error("prod's provision after env set committed no new deploy workflow.");
        }
        await envs.expectSecretsPlaced("prod");
        prodHash = planHash(await run.readPlan());
      },
    );

    run.step(
      "5. a merged change deploys staging; promote --to prod runs staging's exact digest",
      minutes(60),
      async () => {
        await run.mergeChange("e2e: a change for staging", [await workflowOf(run, STAGING)]);
        const staging = await envs.runningDigest(STAGING);
        previous = await envs.runningDigest("prod");
        expect(staging, "staging runs a newer image than prod").not.toBe(previous);
        await promoteToProd(run, staging);
        expect(await envs.runningDigest("prod"), "prod runs staging's exact digest (SC-1503)").toBe(
          staging,
        );
        await run.waitForHealth();
        await run.opscrewOk("verify", "--env", "prod");
      },
    );

    run.step(
      "6. a rollback with --digest puts prod's previous image back",
      minutes(30),
      async () => {
        await promoteToProd(run, previous, previous);
        expect(await envs.runningDigest("prod"), "prod runs its previous image again").toBe(
          previous,
        );
        await run.waitForHealth();
        await run.opscrewOk("verify", "--env", "prod");
      },
    );

    run.step(
      "7. staging's destroy leaves prod answering under load with its plan unchanged, and removes staging's server, records, secrets and GitHub environment",
      minutes(45),
      async () => {
        await underLoad(
          [await run.healthUrl()],
          "staging's destroy",
          log,
          () => envs.destroy(STAGING),
          acceptOriginPullBlips(run, log),
        );
        await envs.expectNothingLeft(STAGING);
        if (stagingSecrets !== undefined) await envs.expectSecretsGone(STAGING, stagingSecrets);
        const records = await run.cloudflare.zoneRecords(run.zone as CloudflareZone);
        expect(
          records.filter((record) => stagingHosts.includes(record.name)).map((r) => r.type),
          "DNS records left on staging's hostnames",
        ).toEqual([]);
        await run.waitForHealth();
        await run.opscrewOk("verify", "--env", "prod");
        await expectProdUnchanged("staging's destroy");
        await envs.expectSecretsPlaced("prod");
        await run.opscrewOk("env", "remove", STAGING, "--confirm", STAGING);
      },
    );

    run.step(
      "8. destroys prod: nothing of the app is left at Hetzner, in Cloudflare or at GitHub",
      minutes(30),
      async () => {
        const record = await secretsRecord(run.paths());
        await envs.destroy("prod");
        run.destroyed = true;
        await envs.expectNothingLeft("prod");
        await run.expectCloudflareClean();
        if (record !== undefined) await envs.expectSecretsGone("prod", record);
      },
    );

    run.step(
      "9. no secret (every environment's generated values, the local CA key), runner token or server address in any output, commit, pull request, audit entry or state file",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: true }));
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

const RULES_REPO = process.env.OPSCREW_E2E_GITHUB_REPO_C?.trim() ?? "";

describe.skipIf(MISSING_RULES.length > 0)(
  MISSING_RULES.length > 0
    ? `live environment rules on a public repository (skipped: set ${MISSING_RULES.join(", ")}; see docs/e2e.md)`
    : `live environment rules on a public repository: examples/${SETTINGS.app}, staging at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "environment rules",
      name: "rules",
      // No domain: nothing here needs the site, so nothing touches the zone.
      settings: { ...SETTINGS, githubRepo: RULES_REPO, domain: "" },
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    /** The environment whose runner would be on the server: planned only, never provisioned. */
    const RUNNER_ENV = "selfhosted";
    let policy = "";
    let stagingSecrets: SecretsRecord | undefined;

    run.step(
      "1. designs prod in the public repository (never provisioned) and reads its fork pull request policy",
      minutes(20),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} with environment rules`,
          env: { HCLOUD_TOKEN: SETTINGS.hcloudToken },
        });
        if ((await repoInfo(run.github)).private) {
          throw new Error(
            "OPSCREW_E2E_GITHUB_REPO_C must be a public repository: GitHub enforces every environment rule only there on the Free plan.",
          );
        }
        policy = await forkPrPolicy(run.github);
        if (policy === "all_external_contributors") {
          throw new Error(
            "The repository already requires approval for every outside contributor's workflow runs, so OpsCrew would not refuse a runner there. Set it back to first-time contributors (Settings → Actions → General), then run the test again.",
          );
        }
        log(`observed: the fork pull request approval policy is ${policy}`);
        await envs.snapshotGithub();
        await designProd(run, envs, SETTINGS.region);
        await run.adaptAndMerge();
      },
    );

    run.step(
      "2. provisions staging (promoted from prod): its GitHub environment with the branch rule, no reviewer from a script",
      minutes(40),
      async () => {
        await run.opscrewOk("env", "add", STAGING, "--target", "hetzner", "--from", "prod");
        await envs.designed(STAGING);
        const output = await envs.provision(STAGING, "staging");
        const view = await readGithubEnvironment(run.github, STAGING);
        if (view === undefined) throw new Error("provision created no GitHub environment staging.");
        expect(view.branchPolicy, "staging's deployment branches").toEqual({
          protectedBranches: false,
          customBranchPolicies: true,
        });
        expect(view.branches, "the branches that may deploy to staging").toEqual(["main"]);
        expect(view.reviewers, "required reviewers added by a script").toBe(0);
        expect(
          output.includes("This run is not interactive, so OpsCrew adds no required reviewer"),
          `provision says a script adds no reviewer:\n${run.tail(output)}`,
        ).toBe(true);
        log(
          `observed: staging's GitHub environment lets only main deploy; a script added no reviewer and named the setting for one (the interactive offer is the founder's to try)`,
        );
        stagingSecrets = await envs.expectSecretsPlaced(STAGING);
        expect(stagingSecrets.createdEnvironment, "OpsCrew records that it created staging").toBe(
          true,
        );
      },
    );

    run.step(
      "3. a runner for the public repository is refused, and the fork pull request policy change only planned",
      minutes(20),
      async () => {
        await run.opscrewOk(
          "env",
          "add",
          RUNNER_ENV,
          "--target",
          "hetzner",
          "--from",
          "prod",
          "--runner",
          "server",
        );
        const label = runnerLabel(await envs.designed(RUNNER_ENV));
        // Never `provision` without --plan-only here, and no --yes: no change at GitHub can be
        // approved by this run, so the policy and the runner stay as they are.
        const planned = await run.opscrew("provision", "--env", RUNNER_ENV, "--plan-only");
        for (const words of [
          "GitHub says self-hosted runners should almost never serve a public repository",
          "a plan-only run changes nothing at GitHub",
        ]) {
          expect(
            planned.output.includes(words),
            `the plan-only run says: ${words}\n${run.tail(planned.output)}`,
          ).toBe(true);
        }
        expect(await forkPrPolicy(run.github), "the fork pull request policy").toBe(policy);
        await expectNoRunner(run.github, label);
        await run.opscrewOk("env", "remove", RUNNER_ENV, "--confirm", RUNNER_ENV);
        log(
          "observed: the runner for the public repository was refused in the plan, which only names the policy change; nothing changed at GitHub",
        );
      },
    );

    run.step(
      "4. staging's destroy removes its server, its GitHub environment and its secrets",
      minutes(30),
      async () => {
        await envs.destroy(STAGING);
        run.destroyed = true;
        await envs.expectNothingLeft(STAGING);
        if (stagingSecrets !== undefined) await envs.expectSecretsGone(STAGING, stagingSecrets);
        expect(await forkPrPolicy(run.github), "the fork pull request policy").toBe(policy);
        await run.opscrewOk("env", "remove", STAGING, "--confirm", STAGING);
      },
    );

    run.step(
      "5. no secret, runner token or server address in any output, commit, pull request, audit entry or state file",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: false }));
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);
