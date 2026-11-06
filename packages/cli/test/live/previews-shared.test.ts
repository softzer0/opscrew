/**
 * The live pass of the previews' two opt-ins (docs/e2e.md "Previews on dev's server", spec.md US9
 * and US10), with `OPSCREW_E2E_PREVIEWS_SHARED=1`: the seeded `examples/koa-knex` as prod at
 * Hetzner behind Cloudflare (as for previews); `env add preview --previews --app-zone --domain
 * previews-<run>.<the app's zone>` refused without Advanced Certificate Manager, with nothing
 * changed; dev on a server of its own at Hetzner; then `env add preview --previews --share-server
 * dev`, its warning, `provision --env preview` with no server of its own and the warning in the
 * approval. A pull request's preview answers at its hidden address beside dev, which keeps
 * answering; `destroy --env dev` is refused while the previews run there; `destroy --env preview`
 * leaves dev's server and dev working; then dev, then prod are destroyed, and the leak search.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { APPS_DIR, previewWorkflowPath } from "@opscrew/iac-templates";
import { afterAll, describe, expect } from "vitest";
import { type CloudflareZone, DEPLOY_WORKFLOW, hetznerAppServers, minutes } from "./cloud";
import { AppEnvironments, planHash, secretsRecord } from "./environment-checks";
import { destroyConfirmArgs, LiveRun, serverSettings } from "./harness";
import {
  deploySeededProd,
  PreviewPulls,
  type Pull,
  previewPage,
  provisionPreviews,
  registerPreviewZoneCleanup,
  wildcardRecords,
} from "./previews-checks";
import {
  acmRefused,
  appZonePreviewDomain,
  HOST_ENV,
  hostDestroyRefused,
  PREVIEW_ENV,
  PREVIEWS_EXAMPLE,
  previewList,
  previewValues,
  REMOVED,
  SEED_ROWS,
  SHARED_E2E_VARIABLES,
  SHARED_GATE,
  STARTED,
  sharedServerWarning,
} from "./previews-support";
import { missingVariables } from "./support";

const MISSING = missingVariables(process.env, SHARED_GATE, SHARED_E2E_VARIABLES);
/** Always this example, as for previews: Postgres, a release command and a seed. */
const SETTINGS = { ...serverSettings(process.env), app: PREVIEWS_EXAMPLE };
/** The previews' own domain: a Cloudflare zone of the token's used for nothing else. */
const PREVIEW_DOMAIN = process.env.OPSCREW_E2E_PREVIEW_DOMAIN?.trim().toLowerCase() ?? "";

if (process.env[SHARED_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (previews on dev's server): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Previews on dev's server").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live previews on dev's server (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live previews on dev's server: examples/${SETTINGS.app}, prod, dev and its previews at Hetzner`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "previews on dev's server",
      name: "shared",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    const pr = new PreviewPulls(run);
    /** The preview zone in Cloudflare, once found: the cleanup removes its wildcard. */
    let previewZone: CloudflareZone | undefined;
    /** dev's hostname and its server's id at Hetzner, once dev is deployed. */
    let devHost = "";
    let devServers: number[] = [];
    let pullA: Pull | undefined;

    /** dev's page answers through Cloudflare: main's marker, no row, no preview value. */
    async function expectDevAnswering(after: string): Promise<void> {
      const dev = await envs.readPlan(HOST_ENV);
      await run.waitForHealth(minutes(5), true, `https://${devHost}${dev.app.healthPath}`);
      expect(await previewPage(`https://${devHost}`), `dev's page after ${after}`).toMatchObject({
        marker: "main",
        rows: [],
        previewValue: "unset",
        viaCloudflare: true,
      });
      log(`observed: dev answers after ${after}`);
    }

    /** dev's servers at Hetzner are still the one OpsCrew created for it. */
    async function expectDevServerKept(after: string): Promise<void> {
      const ids = (await hetznerAppServers(SETTINGS.hcloudToken, envs.app(HOST_ENV))).map(
        (server) => server.id,
      );
      expect(ids, `dev's server at Hetzner after ${after}`).toEqual(devServers);
    }

    run.step(
      `1. examples/${PREVIEWS_EXAMPLE} with a seed, a page of its rows and a marker (in the throwaway copy only) deployed as prod at Hetzner behind Cloudflare`,
      minutes(60),
      () => deploySeededProd(run, envs, SETTINGS),
    );

    run.step(
      "2. env add preview --previews --app-zone --domain previews-<run>.<the app's zone>: refused without Advanced Certificate Manager, nothing changed",
      minutes(10),
      async () => {
        const zone = await run.cloudflare.zoneOf(run.appHost);
        const domain = appZonePreviewDomain(zone.name, run.runId);
        const prodPlan = planHash(await run.readPlan());
        const before = await run.git("status", "--porcelain");
        const refused = await run.opscrew(
          "env",
          "add",
          PREVIEW_ENV,
          "--previews",
          "--app-zone",
          "--domain",
          domain,
          "--cap",
          "1",
        );
        expect(refused.exitCode, "env add --app-zone on a zone without ACM").not.toBe(0);
        expect(
          acmRefused(refused.output, zone.name, domain),
          `the refusal without Advanced Certificate Manager (the app's zone must have none):\n${run.tail(refused.output)}`,
        ).toBe(true);
        expect(await run.git("status", "--porcelain"), "the checkout after the refusal").toBe(
          before,
        );
        expect(existsSync(envs.paths(PREVIEW_ENV).files.plan), "a preview plan").toBe(false);
        expect(planHash(await run.readPlan()), "prod's plan hash after the refusal").toBe(prodPlan);
        const records = (await run.cloudflare.zoneRecords(zone)).filter(
          (record) => record.name === domain || record.name.endsWith(`.${domain}`),
        );
        expect(records, `records at or below ${domain}`).toEqual([]);
        log("observed: previews below the app's zone refused without ACM, nothing changed");
      },
    );

    run.step(
      "3. dev on a server of its own at Hetzner: added, provisioned and deployed; it answers",
      minutes(75),
      async () => {
        await run.opscrewOk("env", "add", HOST_ENV, "--target", "hetzner", "--from", "main");
        const dev = await envs.designed(HOST_ENV);
        const host = dev.dns.domain;
        if (host === undefined || host === run.appHost) {
          throw new Error("design gave dev no hostname of its own.");
        }
        devHost = host;
        await envs.provision(HOST_ENV, HOST_ENV);
        const deployed = await run.deploy("dev's first deploy", [
          posix.basename(dev.cicd.workflowPath),
          DEPLOY_WORKFLOW,
        ]);
        if (deployed === undefined) {
          throw new Error("dev's provision opened no deploy-setup pull request.");
        }
        await expectDevAnswering("its first deploy");
        await run.opscrewOk("verify", "--env", HOST_ENV);
        devServers = (await hetznerAppServers(SETTINGS.hcloudToken, dev.app.name)).map(
          (server) => server.id,
        );
        expect(devServers.length, "dev's servers at Hetzner").toBe(1);
      },
    );

    run.step(
      "4. env add preview --previews --share-server dev: the warning; provision --env preview with no server of its own and the warning in the approval; dev still answers",
      minutes(75),
      async () => {
        const prodPlan = planHash(await run.readPlan());
        const zone = await run.cloudflare.zoneOf(PREVIEW_DOMAIN);
        if (zone.name !== PREVIEW_DOMAIN) {
          throw new Error(
            `OPSCREW_E2E_PREVIEW_DOMAIN is a name inside the Cloudflare zone ${zone.name}; set it to a zone of its own, used only for previews.`,
          );
        }
        // Set before env add, so the cleanup removes the wildcard record whatever happens next.
        previewZone = zone;
        const added = await run.opscrewOk(
          "env",
          "add",
          PREVIEW_ENV,
          "--previews",
          "--share-server",
          HOST_ENV,
          "--cap",
          "1",
          "--lifetime",
          "1",
          "--domain",
          PREVIEW_DOMAIN,
        );
        expect(added.output, "env add --share-server's warning").toContain(
          sharedServerWarning(HOST_ENV),
        );
        const plan = await envs.designed(PREVIEW_ENV);
        const previews = plan.environment?.previews;
        if (previews === undefined) throw new Error("env add --previews designed no previews.");
        expect(previews, "the preview environment's previews").toMatchObject({
          cap: 1,
          lifetimeDays: 1,
          domain: PREVIEW_DOMAIN,
          server: { environment: HOST_ENV },
        });
        expect(plan.target.provider, "where the previews run").toBe("own");
        pr.app = plan.app.name;
        pr.zone = previews.domain;
        pr.workflow = posix.basename(previewWorkflowPath(plan));
        expect(planHash(await run.readPlan()), "prod's plan hash after env add").toBe(prodPlan);
        const value = `preview-${randomBytes(16).toString("hex")}`;
        run.scrubber.add(value, "preview-value");
        await writeFile(join(run.repo, `.env.${PREVIEW_ENV}`), previewValues(value));

        // The secrets check first, as in the previews pass: each environment it names is
        // provisioned (its secrets into a GitHub environment only its branch may use), then the
        // previews again.
        envs.provisioned.add(PREVIEW_ENV);
        let provisioned = await provisionPreviews(run, pr.app);
        if (provisioned.refused.length > 0) {
          log(
            `observed: provision --env preview refused while a pull request could read the deploy secrets of ${provisioned.refused.join(", ")}; provisioning them first, as the refusal says`,
          );
          for (const environment of provisioned.refused) {
            await envs.provision(
              environment,
              `${environment}'s secrets into its GitHub environment`,
            );
            await run.mergeDeploySetup(`${environment}'s secrets placed in its GitHub environment`);
          }
          await run.waitForHealth();
          await expectDevAnswering("the secrets' move");
          provisioned = await provisionPreviews(run, pr.app);
          if (provisioned.refused.length > 0) {
            throw new Error(
              `provision --env preview refused again:\n${run.tail(provisioned.output)}`,
            );
          }
        }
        expect(provisioned.output, "the approval names dev and repeats the warning").toContain(
          sharedServerWarning(HOST_ENV),
        );
        const paths = envs.paths(PREVIEW_ENV);
        await run.rememberSecretFile(paths.files.statePassphrase, "state-passphrase");
        if (!(await run.rememberSecretFile(paths.files.previewKey, "preview-private-key"))) {
          throw new Error("provision --env preview made no preview key.");
        }
        expect(
          await hetznerAppServers(SETTINGS.hcloudToken, pr.app),
          "the previews' own servers at Hetzner",
        ).toEqual([]);
        await expectDevServerKept("the previews' provision");
        const merged = await run.mergeDeploySetup("the preview workflow and recipe");
        if (merged === undefined) throw new Error("provision --env preview committed nothing.");
        await expectDevAnswering("the previews' provision");
      },
    );

    run.step(
      "5. pull request A gets its preview on dev's server at its hidden address, with the seeded rows; dev keeps answering",
      minutes(45),
      async () => {
        const a = await pr.open("a", "a-1");
        pullA = a;
        await pr.previewRun(a, STARTED, "A opened");
        await pr.expectRunningComment(a);
        const served = await pr.serving(a, "a-1");
        expect(served.rows, "preview A's rows: the seed's").toEqual([...SEED_ROWS]);
        expect(served.viaCloudflare, "preview A answered through Cloudflare (cf-ray)").toBe(true);
        const listed = previewList(
          (await run.opscrewOk("preview", "list", "--env", PREVIEW_ENV, "--json")).stdout,
        );
        expect(listed, "opscrew preview list").toMatchObject({
          count: 1,
          cap: 1,
          previews: [{ number: a.number, state: "running", address: pr.address(a) }],
        });
        await expectDevAnswering("preview A's start");
      },
    );

    run.step(
      "6. destroy --env dev is refused while the previews run on its server, naming destroy --env preview; nothing changed",
      minutes(10),
      async () => {
        const dev = await envs.readPlan(HOST_ENV);
        const refused = await run.opscrew(
          "destroy",
          "--env",
          HOST_ENV,
          ...destroyConfirmArgs(dev),
          "--no-snapshot",
        );
        expect(refused.exitCode, "destroy --env dev while previews run there").not.toBe(0);
        expect(
          hostDestroyRefused(refused.output, HOST_ENV, PREVIEW_ENV),
          `the refusal naming destroy --env preview:\n${run.tail(refused.output)}`,
        ).toBe(true);
        await expectDevServerKept("the refused destroy");
        await expectDevAnswering("the refused destroy");
        const a = pullA;
        if (a === undefined) throw new Error("Step 5 opened no pull request.");
        await pr.serving(a, "a-1");
      },
    );

    run.step(
      "7. A closed, then destroy --env preview: the previews, the recipe and the wildcard go; dev's server stays and dev keeps working",
      minutes(45),
      async () => {
        const a = pullA;
        if (a === undefined) throw new Error("Step 5 opened no pull request.");
        const since = new Date();
        await pr.close(a);
        await pr.previewRun(a, REMOVED, "A closed", since);
        expect(await pr.comment(a), "the comment on pull request A").toEqual({ state: "removed" });
        const record = await secretsRecord(envs.paths(PREVIEW_ENV));
        await envs.destroy(PREVIEW_ENV);
        if (record !== undefined) await envs.expectSecretsGone(PREVIEW_ENV, record);
        if (previewZone === undefined) throw new Error("Step 4 found no preview zone.");
        expect(
          (await wildcardRecords(run, previewZone)).map((r) => r.type),
          "the previews' wildcard records left",
        ).toEqual([]);
        const shell = await envs.shell(HOST_ENV);
        const apps = (await shell.ok(`ls -1 ${APPS_DIR}`)).split("\n").map((line) => line.trim());
        expect(
          apps.filter((name) => name === pr.app || name.startsWith(`${pr.app}-pr-`)),
          "the previews' recipe and previews left on dev's server",
        ).toEqual([]);
        await expectDevServerKept("destroy --env preview");
        await expectDevAnswering("destroy --env preview");
        await run.opscrewOk("verify", "--env", HOST_ENV);
      },
    );

    run.step(
      "8. destroy --env dev, then prod: nothing of the app left at Hetzner or in Cloudflare",
      minutes(45),
      async () => {
        const dev = await secretsRecord(envs.paths(HOST_ENV));
        await envs.destroy(HOST_ENV);
        await envs.expectNothingLeft(HOST_ENV);
        if (dev !== undefined) await envs.expectSecretsGone(HOST_ENV, dev);
        await envs.destroy("prod");
        await envs.expectNothingLeft("prod");
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "9. no token, key, generated password or preview value in any output, commit, pull request, comment, preview workflow log, audit entry, plan or state file, and no server address in a comment",
      minutes(15),
      async () => {
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await pr.leaks()),
        ]);
      },
      { always: true },
    );

    // The harness's cleanup: destroy what is left, newest first (the previews before dev, whose
    // destroy they would refuse, then prod), Hetzner's API by the apps' labels, GitHub's
    // environments and secrets, Cloudflare, then the wildcard record in the preview zone, then
    // the repository's reset.
    registerPreviewZoneCleanup(run, envs, () => previewZone);
    // Registered after the harness's cleanup, so it runs before it: the run's pull requests still
    // open are closed while the previews may still run (see previews.test.ts).
    afterAll(async () => {
      const problems = await pr.closeOpen(Date.now() + minutes(15));
      if (problems.length > 0) {
        throw run.cleanError(
          new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`),
        );
      }
    }, minutes(20));
  },
);
