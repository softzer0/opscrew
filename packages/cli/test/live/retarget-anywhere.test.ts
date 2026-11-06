/**
 * The live pass of feature 023 (docs/e2e.md "Retarget anywhere"), with
 * `OPSCREW_E2E_RETARGET_ANYWHERE=1`, in legs that each set up, check and clean up on their own:
 * - **own server:** examples/flask-sqlite with Postgres, MySQL and a Valkey queue added moves from
 *   Hetzner (x86) to a throwaway Arm server (CAX) set up as the user's own, then back to Hetzner;
 *   every row, job and file after each move. In the first move's window a copy that cannot be
 *   written fails it: Hetzner keeps serving with its data unchanged (SC-2302);
 * - **Portainer:** the same app from Hetzner into a Portainer on a throwaway server and back; its
 *   environment stays (SC-2304);
 * - **a site:** examples/hugo-site from GitHub Pages to Cloudflare's hosting and back;
 * - **DigitalOcean and a bucket** (with `OPSCREW_E2E_DIGITALOCEAN_TOKEN`): examples/s3-uploads with
 *   a Hetzner bucket moves to DigitalOcean, its files into a new Spaces bucket, and the old bucket
 *   goes at `--finish` after its typed name.
 * Every run is non-interactive: each stop's printed command approves its plan by hash and types
 * its names. Each leg ends with a leak search over every output, commit, plan and audit entry.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ProviderBucket,
  providerBucket,
  STORAGE_KEY_VARS,
  storageS3Client,
} from "@opscrew/agents";
import { opscrewNames } from "@opscrew/connector-portainer";
import { verificationRecordName } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import {
  api,
  type CloudflareZone,
  HETZNER_API,
  hetznerAppLeft,
  httpRequest,
  minutes,
  sleep,
  waitFor,
} from "./cloud";
import { readValue, writeValue } from "./component-checks";
import { storageKeyEnv, withBucket } from "./components-support";
import { AppEnvironments, designProd } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { repoInfo } from "./portainer-cloud";
import { portainerAnswers } from "./portainer-support";
import {
  appArchitecture,
  type DataApp,
  DigitalOcean,
  deployDataApp,
  endFlags,
  endMove,
  execOn,
  expectData,
  expectProjectGone,
  keptShell,
  MOVE_FLAGS,
  MoveRecords,
  moveLeaks,
  type PortainerHost,
  retargetUntilDone,
  setUpPortainer,
  volumeFolder,
} from "./retarget-anywhere-checks";
import {
  BUCKET_EXAMPLE,
  composeProjectOf,
  DATA_EXAMPLE,
  type Leg,
  legSkip,
  MOVE_SERVICES,
  NEW_STORAGE_KEY_VARS,
  OBJECTS,
  objectsCommand,
  RETARGET_GATE,
} from "./retarget-anywhere-support";
import { pagesStandIn, pointsAtGitHub } from "./serverless-support";
import { designSite, siteEnv, siteSettings, workerExists, workflowOf } from "./site-checks";

const ENV = process.env;

/** The text of examples/hugo-site's home page. */
const HOME_TEXT = "Hugo on OpsCrew";

/** The leg's title, or why it is skipped (logged too when the gate is set). */
function legTitle(leg: Leg, title: string): { skip: boolean; title: string } {
  const why = legSkip(ENV, leg);
  if (why === undefined) return { skip: false, title: `live retarget anywhere: ${title}` };
  if (ENV[RETARGET_GATE] === "1") {
    console.warn(
      `OpsCrew E2E (retarget anywhere, ${title}): skipped, ${why} (see docs/e2e.md, "Retarget anywhere").`,
    );
  }
  return { skip: true, title: `live retarget anywhere: ${title} (skipped: ${why})` };
}

/** Whether Hetzner still lists the server `id` (the throwaway one the user owns). */
async function hetznerServerListed(token: string, id: number): Promise<boolean> {
  const got = await api(HETZNER_API, token, "GET", `/servers/${id}`);
  if (got.status === 404) return false;
  if (got.status === 200) return true;
  throw new Error(`Hetzner answered HTTP ${got.status} for the throwaway server.`);
}

/** Waits up to 3 minutes until Hetzner lists nothing OpsCrew created for `app` (`--finish`). */
async function expectHetznerEmpty(token: string, app: string, what: string): Promise<void> {
  await waitFor(`nothing of ${app} left at Hetzner ${what}`, minutes(3), async () =>
    (await hetznerAppLeft(token, app)).length === 0 ? true : undefined,
  );
}

/** The move's plan after it switched: on `provider`, at the step `switched`. */
async function expectSwitched(run: LiveRun, provider: string): Promise<DeployPlan> {
  const plan = await run.readPlan();
  expect(plan.target.provider, "the plan's target after the move").toBe(provider);
  expect(plan.retarget?.step, "the move's step").toBe("switched");
  return plan;
}

// ---------------------------------------------------------------------------------------------

const OWN = legTitle(
  "own",
  `examples/${DATA_EXAMPLE} from Hetzner (x86) to your own Arm server and back`,
);

describe.skipIf(OWN.skip)(OWN.title, () => {
  const settings = { ...serverSettings(ENV), app: DATA_EXAMPLE };
  const run: LiveRun = new LiveRun({
    label: "retarget, own server",
    name: "move-own",
    settings,
    afterCli: () => records.afterCli(),
  });
  const records = new MoveRecords(run);
  const envs = new AppEnvironments(run, settings.hcloudToken, { restoreMain: true });
  let fingerprint = "";
  let data: DataApp | undefined;
  /** The command that allows the first move's maintenance window. */
  let window: string[] = [];
  const site = () => `https://${run.appHost}`;
  const app = () => run.app();
  const seeded = () => data as DataApp;

  run.step(
    "1. a throwaway Arm server at Hetzner (CAX), the user's own, made outside OpsCrew",
    minutes(30),
    async () => {
      await run.prepareRepo({
        commit: `e2e: examples/${DATA_EXAMPLE}, moved to your own server and back`,
        env: {
          HCLOUD_TOKEN: settings.hcloudToken,
          CLOUDFLARE_API_TOKEN: settings.cloudflareToken,
        },
      });
      await envs.snapshotGithub();
      fingerprint = await run.createServer(undefined, "arm");
      expect(await run.shell().ok("uname -m"), "the own server's architecture").toBe("aarch64");
    },
  );

  run.step(
    "2. the app at Hetzner with Postgres, MySQL, a Valkey queue and its SQLite file, the data seeded",
    minutes(75),
    async () => {
      data = await deployDataApp(run, envs, settings.region);
    },
  );

  run.step(
    "3. the move to your own server stops at its window; a copy that cannot be written fails it, and Hetzner keeps serving with its data unchanged (SC-2302)",
    minutes(90),
    async () => {
      const answers = join(run.work, "own-answers.json");
      await writeFile(
        answers,
        JSON.stringify({
          "server.host": run.ipv4(),
          "server.port": 22,
          "server.user": "root",
          "server.key": run.keyFile,
          "server.reachable": true,
          "server.serve": "proxy",
        }),
      );
      const stop = await retargetUntilDone(run, {
        label: "the move to your own server",
        start: ["--to", "own", "--answers", answers, "--host-key", fingerprint],
        always: MOVE_FLAGS,
        names: [],
        downtime: false,
      });
      if (stop.kind !== "window") {
        throw new Error("The move to your own server finished without a maintenance window.");
      }
      window = stop.args;
      expect((await run.readPlan()).retarget?.step, "the move at its window").toBe("deployed");
      // On the new side, MySQL's volume is made immutable: the window's write into it fails.
      const own = execOn(run.shell());
      const folder = await volumeFolder(own, app(), MOVE_SERVICES.mysql);
      await own(`chattr +i ${folder}`);
      try {
        const failed = await run.opscrew("retarget", ...window);
        expect(failed.exitCode, "the window with a copy that cannot be written").not.toBe(0);
        expect(
          failed.output.includes("The maintenance window failed"),
          `the window failed and said so:\n${run.tail(failed.output)}`,
        ).toBe(true);
      } finally {
        await own(`chattr -i ${folder}`);
      }
      expect((await run.readPlan()).retarget?.step, "the move after the failed window").toBe(
        "deployed",
      );
      await run.waitForHealth(minutes(5));
      await expectData(
        execOn(seeded().hetzner),
        app(),
        seeded().seeded,
        "Hetzner after the failed window",
      );
      await readValue(site(), seeded().value);
      run.log("observed: the failed window left Hetzner serving with every row, job and file");
    },
  );

  run.step(
    "4. the move to your own server (arm64) finishes: every row, job and file there; --finish deletes the Hetzner server",
    minutes(90),
    async () => {
      const moved = await retargetUntilDone(run, {
        label: "the move to your own server",
        start: window,
        always: MOVE_FLAGS,
        names: [],
      });
      await expectSwitched(run, "own");
      const own = execOn(run.shell());
      await expectData(own, app(), seeded().seeded, "your own server");
      expect(await appArchitecture(own, app()), "the app's image on your own server").toBe("arm64");
      await run.waitForHealth();
      await readValue(site(), seeded().value);
      run.log(
        `observed: the move to your own server took ${moved.kind === "done" ? moved.runs : "?"} more runs`,
      );
      await retargetUntilDone(run, {
        label: "the finish of the move to your own server",
        always: endFlags("finish", app()),
        names: [app()],
      });
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      await expectHetznerEmpty(settings.hcloudToken, app(), "after --finish");
    },
  );

  run.step(
    "5. the move back to Hetzner: every row, job and file there; --finish removes only the app from your own server, which stays (SC-2304)",
    minutes(90),
    async () => {
      await retargetUntilDone(run, {
        label: "the move back to Hetzner",
        start: ["--to", "hetzner"],
        always: MOVE_FLAGS,
        names: [],
      });
      await expectSwitched(run, "hetzner");
      const hetzner = execOn(await keptShell(run, envs, "hetzner-back"));
      expect(await hetzner("uname -m"), "the new Hetzner server's architecture").toBe("x86_64");
      await expectData(hetzner, app(), seeded().seeded, "the new Hetzner server");
      await run.waitForHealth();
      await readValue(site(), seeded().value);
      await retargetUntilDone(run, {
        label: "the finish of the move back to Hetzner",
        always: endFlags("finish", app()),
        names: [app()],
      });
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      const own = execOn(run.shell());
      await expectProjectGone(own, app());
      expect(
        await hetznerServerListed(settings.hcloudToken, run.server?.id as number),
        "your own server is still there",
      ).toBe(true);
      run.log("observed: --finish removed the app from your own server; root still logs in");
    },
  );

  run.step("6. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
    await envs.destroy("prod");
    await envs.expectNothingLeft("prod");
    await run.expectCloudflareClean();
  });

  run.step(
    "7. a move a failed step left is finished or aborted, so the cleanup's destroy can run",
    minutes(60),
    () => endMove(run, run.appName === undefined ? [] : [run.appName]),
    { always: true },
  );

  run.step(
    "8. no secret, key or address in any output, commit, pull request, plan or audit entry (SC-2303)",
    minutes(10),
    async () => run.expectNothingLeaked(await moveLeaks(run, envs, records, true)),
    { always: true },
  );

  envs.registerCleanup();
});

// ---------------------------------------------------------------------------------------------

const PORTAINER = legTitle(
  "portainer",
  `examples/${DATA_EXAMPLE} from Hetzner into your Portainer and back`,
);

describe.skipIf(PORTAINER.skip)(PORTAINER.title, () => {
  const settings = { ...serverSettings(ENV), app: DATA_EXAMPLE };
  const ghcrToken = ENV.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
  const repoReadToken = ENV.OPSCREW_E2E_REPO_READ_TOKEN?.trim() ?? "";
  const run: LiveRun = new LiveRun({
    label: "retarget, Portainer",
    name: "move-portainer",
    settings,
    afterCli: () => records.afterCli(),
  });
  const records = new MoveRecords(run);
  const envs = new AppEnvironments(run, settings.hcloudToken, { restoreMain: true });
  let portainer: PortainerHost | undefined;
  let data: DataApp | undefined;
  const site = () => `https://${run.appHost}`;
  const app = () => run.app();
  const seeded = () => data as DataApp;
  const host = () => portainer as PortainerHost;

  run.step(
    "1. a throwaway Hetzner server with Portainer CE: an admin, the local environment and its API key",
    minutes(40),
    async () => {
      run.scrubber.add(ghcrToken, "OPSCREW_GHCR_READ_TOKEN");
      run.scrubber.add(repoReadToken, "OPSCREW_REPO_READ_TOKEN");
      const repo = await repoInfo(run.github);
      if (repo.private && repoReadToken === "") {
        throw new Error(
          "The throwaway repository is private, so Portainer needs a read-only token for it: set OPSCREW_E2E_REPO_READ_TOKEN (docs/e2e.md).",
        );
      }
      await run.prepareRepo({
        commit: `e2e: examples/${DATA_EXAMPLE}, moved into your Portainer and back`,
        env: {
          HCLOUD_TOKEN: settings.hcloudToken,
          CLOUDFLARE_API_TOKEN: settings.cloudflareToken,
          OPSCREW_GHCR_READ_TOKEN: ghcrToken,
          ...(repo.private ? { OPSCREW_REPO_READ_TOKEN: repoReadToken } : {}),
        },
        // OpsCrew gets the Portainer API key once Portainer is set up, never a password.
        drop: ["PORTAINER_API_KEY", ...(repo.private ? [] : ["OPSCREW_REPO_READ_TOKEN"])],
      });
      await envs.snapshotGithub();
      portainer = await setUpPortainer(run);
      run.env.PORTAINER_API_KEY = portainer.token;
    },
  );

  run.step(
    "2. the app at Hetzner with Postgres, MySQL, a Valkey queue and its SQLite file, the data seeded",
    minutes(75),
    async () => {
      data = await deployDataApp(run, envs, settings.region);
    },
  );

  run.step(
    "3. the move into your Portainer, its volumes copied through Portainer's API: every row, job and file there; --finish deletes the Hetzner server",
    minutes(120),
    async () => {
      const answers = join(run.work, "portainer-answers.json");
      await writeFile(
        answers,
        JSON.stringify(
          portainerAnswers({
            domain: run.appHost,
            url: host().url,
            redeploy: "updater",
            web: "caddy",
          }),
        ),
      );
      const address = [run.ipv4(), ...(run.server?.ipv6 === undefined ? [] : [run.server.ipv6])];
      await retargetUntilDone(run, {
        label: "the move into your Portainer",
        start: [
          "--to",
          "portainer",
          "--answers",
          answers,
          "--portainer-cert",
          host().fingerprint,
          "--portainer-address",
          address.join(","),
        ],
        always: MOVE_FLAGS,
        names: [],
      });
      const plan = await expectSwitched(run, "portainer");
      await expectData(
        execOn(run.shell()),
        composeProjectOf(plan),
        seeded().seeded,
        "your Portainer",
      );
      await run.waitForHealth();
      await readValue(site(), seeded().value);
      await retargetUntilDone(run, {
        label: "the finish of the move into your Portainer",
        always: endFlags("finish", app()),
        names: [app()],
      });
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      await expectHetznerEmpty(settings.hcloudToken, app(), "after --finish");
    },
  );

  run.step(
    "4. the move back to Hetzner: every row, job and file there; --finish removes the app's stacks and volumes, never Portainer or its environment (SC-2304)",
    minutes(120),
    async () => {
      await retargetUntilDone(run, {
        label: "the move back to Hetzner",
        start: ["--to", "hetzner"],
        always: MOVE_FLAGS,
        names: [],
      });
      await expectSwitched(run, "hetzner");
      const hetzner = execOn(await keptShell(run, envs, "hetzner-back"));
      await expectData(hetzner, app(), seeded().seeded, "the new Hetzner server");
      await run.waitForHealth();
      await readValue(site(), seeded().value);
      await retargetUntilDone(run, {
        label: "the finish of the move back to Hetzner",
        always: endFlags("finish", app()),
        names: [app()],
      });
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      const portainerHost = execOn(run.shell());
      const stack = opscrewNames(app()).app;
      await expectProjectGone(portainerHost, stack);
      const stacks = await host().api.ok<{ Name: string }[]>(
        "GET",
        "/api/stacks",
        "list the stacks",
      );
      expect(
        stacks.map((item) => item.Name).filter((name) => name.startsWith(stack)),
        "the app's stacks in Portainer after --finish",
      ).toEqual([]);
      await host().api.ok(
        "GET",
        `/api/endpoints/${host().environmentId}`,
        "read the environment after --finish",
      );
      expect(
        await portainerHost("docker ps -q --filter name=^portainer$"),
        "Portainer still runs",
      ).not.toBe("");
      run.log(
        "observed: --finish removed the app's stacks and volumes; Portainer and its environment stay",
      );
    },
  );

  run.step("5. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
    await envs.destroy("prod");
    await envs.expectNothingLeft("prod");
    await run.expectCloudflareClean();
  });

  run.step(
    "6. a move a failed step left is finished or aborted, so the cleanup's destroy can run",
    minutes(60),
    () => endMove(run, run.appName === undefined ? [] : [run.appName]),
    { always: true },
  );

  run.step(
    "7. no secret, key or address in any output, commit, pull request, plan or audit entry (SC-2303)",
    minutes(10),
    async () => run.expectNothingLeaked(await moveLeaks(run, envs, records, true)),
    { always: true },
  );

  envs.registerCleanup();
});

// ---------------------------------------------------------------------------------------------

const SITE = legTitle(
  "site",
  "examples/hugo-site from GitHub Pages to Cloudflare's hosting and back",
);

describe.skipIf(SITE.skip)(SITE.title, () => {
  const settings = {
    ...siteSettings(serverSettings(ENV), "hugo-site"),
    githubRepo: ENV.OPSCREW_E2E_GITHUB_REPO_C?.trim() ?? "",
  };
  const run: LiveRun = new LiveRun({
    label: "retarget, a site",
    name: "move-site",
    settings,
    afterCli: () => records.afterCli(),
  });
  const records = new MoveRecords(run);
  const envs = new AppEnvironments(run, "");
  const standIn = pagesStandIn(run.runId);
  const host = () => run.appHost;
  const app = () => run.app();
  let plan: DeployPlan | undefined;

  /** Waits up to `timeoutMs` until `url` answers 200 with the site's home page. */
  async function expectSite(url: string, timeoutMs = minutes(15)): Promise<void> {
    await waitFor(`${url} serving the site`, timeoutMs, async () => {
      const answer = await httpRequest(url);
      if (answer.status !== 200) throw new Error(`it answered ${answer.status}.`);
      return answer.body.includes(HOME_TEXT) ? true : undefined;
    });
  }

  /** Whether a record of the site's hostname points at GitHub Pages. */
  async function recordsAtGitHub(): Promise<boolean> {
    const records = await run.cloudflare.zoneRecords(run.zone as CloudflareZone);
    return records.filter((record) => record.name === host()).some(pointsAtGitHub);
  }

  run.step(
    "1. examples/hugo-site designed for GitHub Pages in the public repository, which has no Pages site yet",
    minutes(20),
    async () => {
      await run.prepareRepo({
        commit: "e2e: examples/hugo-site, moved between GitHub Pages and Cloudflare's hosting",
        env: siteEnv(run, settings),
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
      await envs.designed();
      const verification = verificationRecordName(repo.owner, host());
      await run.snapshotCloudflare(() => [host(), `www.${host()}`, verification]);
      // The Worker the move makes is named after the app: the cleanup deletes it.
      await run.addWorker(app());
    },
  );

  run.step(
    "2. provision and the first deploy publish the site on GitHub Pages",
    minutes(45),
    async () => {
      await envs.provision("prod", "GitHub Pages", ["--pages-verification", standIn]);
      const deployed = await run.deploy("the first Pages deploy", [workflowOf(plan as DeployPlan)]);
      if (deployed === undefined) throw new Error("provision opened no deploy-setup pull request.");
      await expectSite(`http://${host()}/`);
    },
  );

  run.step(
    "3. the move to Cloudflare's hosting: the switch from Pages to the Worker finishes, the site answers from it; --finish removes the Pages site",
    minutes(60),
    async () => {
      const moved = await retargetUntilDone(run, {
        label: "the move to Cloudflare's hosting",
        start: ["--to", "cloudflare-workers"],
        always: [["--yes"]],
        names: [],
      });
      run.log(
        `observed: the move to Cloudflare's hosting took ${moved.kind === "done" ? moved.runs : "?"} runs of opscrew retarget`,
      );
      await expectSwitched(run, "cloudflare-workers");
      expect(await workerExists(run, app()), "the site's Worker").toBe(true);
      await expectSite(`https://${host()}/`);
      expect(await recordsAtGitHub(), "a record of the hostname still points at GitHub").toBe(
        false,
      );
      await retargetUntilDone(run, {
        label: "the finish of the move to Cloudflare's hosting",
        always: endFlags("finish", app()),
        names: [app()],
      });
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      expect(await run.github.pagesSite(), "the Pages site after --finish").toBeUndefined();
      await expectSite(`https://${host()}/`);
    },
  );

  run.step(
    "4. the move back to GitHub Pages: the site answers from GitHub; --finish removes the Worker",
    minutes(60),
    async () => {
      await retargetUntilDone(run, {
        label: "the move back to GitHub Pages",
        start: ["--to", "github-pages", "--pages-verification", standIn],
        always: [["--yes"]],
        names: [],
      });
      await expectSwitched(run, "github-pages");
      await waitFor("a record of the hostname pointing at GitHub Pages", minutes(5), async () =>
        (await recordsAtGitHub()) ? true : undefined,
      );
      await expectSite(`http://${host()}/`);
      await retargetUntilDone(run, {
        label: "the finish of the move back to GitHub Pages",
        always: endFlags("finish", app()),
        names: [app()],
      });
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      await waitFor("the Worker deleted", minutes(3), async () =>
        (await workerExists(run, app())) ? undefined : true,
      );
      expect(await run.github.pagesSite(), "the Pages site after --finish").toMatchObject({
        cname: host(),
      });
    },
  );

  run.step("5. destroy --delete-verification leaves nothing of the site", minutes(30), async () => {
    await envs.destroy("prod", undefined, ["--delete-verification"]);
    run.destroyed = true;
    expect(await run.github.pagesSite(), "the Pages site after destroy").toBeUndefined();
    await run.expectCloudflareClean();
  });

  run.step(
    "6. a move a failed step left is finished or aborted, so the cleanup's destroy can run",
    minutes(30),
    () => endMove(run, run.appName === undefined ? [] : [run.appName]),
    { always: true },
  );

  run.step(
    "7. no secret (the tokens) in any output, commit, pull request, plan or audit entry (SC-2303)",
    minutes(10),
    async () => run.expectNothingLeaked(await moveLeaks(run, envs, records, false)),
    { always: true },
  );

  envs.registerCleanup();
});

// ---------------------------------------------------------------------------------------------

const DIGITALOCEAN = legTitle(
  "digitalocean",
  `examples/${BUCKET_EXAMPLE} with a Hetzner bucket from Hetzner to DigitalOcean`,
);

describe.skipIf(DIGITALOCEAN.skip)(DIGITALOCEAN.title, () => {
  const settings = { ...serverSettings(ENV), app: BUCKET_EXAMPLE };
  const token = ENV.OPSCREW_E2E_DIGITALOCEAN_TOKEN?.trim() ?? "";
  const hetznerKey = {
    accessKeyId: ENV.OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID?.trim() ?? "",
    secretAccessKey: ENV.OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY?.trim() ?? "",
  };
  const digitalocean = new DigitalOcean(token);
  /** Every bucket the run's plans named, by provider and name: the cleanup checks each. */
  const buckets = new Map<string, ProviderBucket>();
  const run: LiveRun = new LiveRun({
    label: "retarget, DigitalOcean and a bucket",
    name: "move-do",
    settings,
    afterCli: async () => {
      await records.afterCli();
      const plan = await run.readPlan().catch(() => undefined);
      for (const bucket of [
        plan === undefined ? undefined : providerBucket(plan),
        plan?.retarget?.from.objectStorage,
      ]) {
        if (bucket?.provider === "hetzner" || bucket?.provider === "digitalocean") {
          buckets.set(`${bucket.provider}/${bucket.bucket}`, bucket as ProviderBucket);
        }
      }
    },
  });
  const records = new MoveRecords(run);
  const envs = new AppEnvironments(run, settings.hcloudToken, { restoreMain: true });
  const bucketName = `opscrew-e2e-${run.runId}`;
  let spaces: { name: string; accessKeyId: string; secretAccessKey: string } | undefined;
  let objects = "";
  const value = `value-${run.runId}`;
  const site = () => `https://${run.appHost}`;
  const app = () => run.app();
  const io = { fetch, now: () => new Date() };
  const keyOf = (bucket: ProviderBucket) => (bucket.provider === "hetzner" ? hetznerKey : spaces);

  run.step("1. a throwaway Spaces key made through DigitalOcean's API", minutes(10), async () => {
    run.scrubber.add(token, "digitalocean-token");
    run.scrubber.add(hetznerKey.accessKeyId, "hetzner-s3-access-key");
    run.scrubber.add(hetznerKey.secretAccessKey, "hetzner-s3-secret-key");
    spaces = await digitalocean.createSpacesKey(`opscrew-e2e-${run.runId}`);
    run.scrubber.add(spaces.accessKeyId, "spaces-access-key");
    run.scrubber.add(spaces.secretAccessKey, "spaces-secret-key");
    await run.prepareRepo({
      commit: `e2e: examples/${BUCKET_EXAMPLE} with its bucket, moved to DigitalOcean`,
      env: {
        HCLOUD_TOKEN: settings.hcloudToken,
        DIGITALOCEAN_TOKEN: token,
        CLOUDFLARE_API_TOKEN: settings.cloudflareToken,
        ...storageKeyEnv(hetznerKey),
        [NEW_STORAGE_KEY_VARS.accessKeyId]: spaces.accessKeyId,
        [NEW_STORAGE_KEY_VARS.secretAccessKey]: spaces.secretAccessKey,
      },
    });
    await envs.snapshotGithub();
  });

  run.step(
    `2. the app at Hetzner with its bucket at Hetzner Object Storage, holding ${OBJECTS} files`,
    minutes(75),
    async () => {
      await designProd(run, envs, settings.region);
      await writeArtifact(
        "plan",
        run.paths().files.plan,
        withBucket(await run.readPlan(), "hetzner", bucketName),
      );
      await run.opscrewOk("design");
      await envs.designed("prod");
      await run.adaptAndMerge();
      // Hetzner Object Storage can show a new bucket late; provision then asks for a rerun.
      for (let attempt = 1; ; attempt++) {
        try {
          await envs.provision("prod", "the app and its bucket at Hetzner");
          break;
        } catch (error) {
          const late = /did not show the new bucket|found the bucket from an earlier run/;
          if (attempt >= 3 || !late.test(String(error))) throw error;
          run.log("provision stopped at the new bucket and asks for a rerun; running it again");
          await sleep(30_000);
        }
      }
      await run.deployAny("the first deploy at Hetzner");
      await run.waitForHealth();
      await writeValue(site(), value);
      const hetzner = execOn(await keptShell(run, envs, "hetzner-first"));
      objects = await hetzner(objectsCommand(app(), true, run.runId));
      expect(
        objects.split("\n").filter((line) => line !== "").length,
        "the files in the bucket",
      ).toBe(OBJECTS);
    },
  );

  run.step(
    "3. the move to DigitalOcean takes the bucket along: a Spaces bucket with every file, the app on it",
    minutes(120),
    async () => {
      await retargetUntilDone(run, {
        label: "the move to DigitalOcean",
        start: ["--to", "digitalocean"],
        always: MOVE_FLAGS,
        names: [],
      });
      const plan = await expectSwitched(run, "digitalocean");
      expect(plan.storage?.objectStorage?.provider, "the app's bucket after the move").toBe(
        "digitalocean",
      );
      expect(plan.retarget?.from.objectStorage?.bucket, "the bucket being left").toBe(bucketName);
      const droplet = execOn(await keptShell(run, envs, "digitalocean"));
      expect(
        await droplet(objectsCommand(app(), false, run.runId)),
        "the files in the Spaces bucket, read by the app on DigitalOcean",
      ).toBe(objects);
      await run.waitForHealth();
      await readValue(site(), value);
    },
  );

  run.step(
    "4. --finish deletes the Hetzner server and, after its typed name, the old bucket",
    minutes(45),
    async () => {
      const old = buckets.get(`hetzner/${bucketName}`);
      if (old === undefined) throw new Error("The run never saw the Hetzner bucket in the plan.");
      const finished = await retargetUntilDone(run, {
        label: "the finish of the move to DigitalOcean",
        always: endFlags("finish", app()),
        names: [app(), bucketName],
      });
      expect(
        finished.kind === "done" ? finished.confirmed : [],
        "the names --finish typed",
      ).toContain(bucketName);
      expect((await run.readPlan()).retarget, "the move after --finish").toBeUndefined();
      await waitFor("the old bucket deleted", minutes(3), async () =>
        (await storageS3Client(old, hetznerKey, io).headBucket()) ? undefined : true,
      );
      await expectHetznerEmpty(settings.hcloudToken, app(), "after --finish");
    },
  );

  run.step(
    "5. destroy --delete-data leaves nothing at DigitalOcean, Hetzner or in Cloudflare",
    minutes(30),
    async () => {
      const key = spaces as NonNullable<typeof spaces>;
      // The app's bucket is the Spaces one now: OpsCrew reads its key as the bucket's key.
      run.env[STORAGE_KEY_VARS.accessKeyId] = key.accessKeyId;
      run.env[STORAGE_KEY_VARS.secretAccessKey] = key.secretAccessKey;
      delete run.env[NEW_STORAGE_KEY_VARS.accessKeyId];
      delete run.env[NEW_STORAGE_KEY_VARS.secretAccessKey];
      const bucket = providerBucket(await run.readPlan());
      await envs.destroy("prod", undefined, ["--delete-data"]);
      expect(await digitalocean.appLeft(app()), "what is left at DigitalOcean").toEqual([]);
      await envs.expectNothingLeft("prod");
      if (bucket !== undefined) {
        expect(
          await storageS3Client(bucket, key, io).headBucket(),
          "the Spaces bucket after destroy --delete-data",
        ).toBe(false);
      }
      await run.expectCloudflareClean();
    },
  );

  run.step(
    "6. a move a failed step left is finished or aborted, so the cleanup's destroy can run",
    minutes(60),
    () => endMove(run, run.appName === undefined ? [] : [run.appName, bucketName]),
    { always: true },
  );

  run.step(
    "7. no secret, bucket key or address in any output, commit, pull request, plan or audit entry (SC-2303)",
    minutes(10),
    async () => run.expectNothingLeaked(await moveLeaks(run, envs, records, true)),
    { always: true },
  );

  // After the harness's cleanup (the destroy, Hetzner's API, Cloudflare): every bucket the run
  // saw, what is left at DigitalOcean, and the Spaces key, each on its own.
  envs.registerCleanup({
    last: async (attempt) => {
      for (const bucket of buckets.values()) {
        const key = keyOf(bucket);
        if (key === undefined) continue;
        await attempt(`check the bucket ${bucket.bucket} on ${bucket.provider}`, async () => {
          const client = storageS3Client(bucket, key, io);
          if (!(await client.headBucket())) return [];
          await client.deleteBucket();
          return [
            `the bucket ${bucket.bucket} was left on ${bucket.provider}; the cleanup deleted it`,
          ];
        });
      }
      const name = run.appName;
      if (name !== undefined) {
        await attempt(`delete what is left of ${name} at DigitalOcean`, async () => {
          await digitalocean.deleteApp(name);
          const left = await digitalocean.appLeft(name);
          return left.length === 0 ? [] : [`DigitalOcean still lists ${left.join(", ")}`];
        });
      }
      const key = spaces;
      if (key !== undefined) {
        await attempt("delete the throwaway Spaces key", () =>
          digitalocean.deleteSpacesKey(key.accessKeyId),
        );
      }
    },
  });
});
