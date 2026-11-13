/**
 * The live pass of feature 027 on the founder's cPanel account (docs/e2e.md "A cPanel account",
 * SC-2701 to SC-2704): one leg per app, one after the other on the throwaway repository, each on its
 * own `e2e-<tag>-<leg>` subdomain of `OPSCREW_E2E_CPANEL_DOMAIN`:
 * - `php`: `examples/php-plain-mysql` (PHP through the hostname's handler line; its database, cron
 *   job, settings and kept storage), with a snapshot and its restore;
 * - `site`: `examples/static-vite`;
 * - `node`: `examples/hono-api` through CloudLinux's selector (its findings printed);
 * - `laravel`: `examples/laravel-app`, whole with `OPSCREW_E2E_CPANEL_LARAVEL=1`; otherwise its
 *   refusal (the account's PHP doesn't fit it) is checked, and destroy removes the agent.
 * Each leg runs interview, design, provision (both hosting plans, each approved by its hash), the
 * first deploy, verify, status and logs, a second release and a rollback (the answers around each
 * switch watched, SC-2703), secure, drift and destroy. The account's inventory is taken before the
 * first leg and compared field by field after the last (SC-2702), and every output, the agent's
 * logs, audit entries, commits and local files are searched for the token, the agent's key and the
 * app's settings (SC-2704). The account's user and domains are masked in every log line. The
 * cleanup destroys a leg a failure stopped, then removes through cPanel's API only what names the
 * run (`e2e-<tag>`) and the certificates AutoSSL issued for its hostnames.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDotenv } from "@opscrew/agents";
import type { HostingPanelAccess } from "@opscrew/contracts";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { httpRequest, minutes, waitFor } from "./cloud";
import {
  ACCOUNT_LABEL_PREFIX,
  type AccountInventory,
  accountMasks,
  appRootSuffixes,
  CPANEL_GATE,
  CPANEL_LARAVEL_GATE,
  CPANEL_VARIABLES,
  CpanelAccount,
  envNames,
  hostingAnswers,
  hostingEnv,
  hostingGithubLeftovers,
  hostingRunProblem,
  inventoryProblems,
  legNames,
  type Marker,
  namesRun,
  otherRunsObjects,
  PANEL_DEPLOY_JOB,
  PHP_MARKER,
  panelAccess,
  releaseOf,
  runTag,
  SFTP_VARIABLES,
  SITE_MARKER,
  type SwitchPages,
  selectorEnvNames,
  switchVerdict,
  watchSwitch,
} from "./cpanel-support";
import { environmentNames, opscrewUntilApproved } from "./environment-checks";
import {
  CLEANUP_DESTROY_RUN_MS,
  EXAMPLES,
  type LeakSource,
  LiveRun,
  localLeakSources,
  serverSettings,
} from "./harness";
import { shownRollback } from "./rollback-support";
import { approvedRestore } from "./snapshots-checks";
import { approveHashes, duration, leakedLabels, missingVariables } from "./support";

const ENV = process.env;
const MISSING = missingVariables(ENV, CPANEL_GATE, CPANEL_VARIABLES);
const LARAVEL = ENV[CPANEL_LARAVEL_GATE] === "1";
const DOMAIN = (ENV.OPSCREW_E2E_CPANEL_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, "");
if (ENV[CPANEL_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (cPanel): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "A cPanel account").`,
  );
}

/** One app of the pass. */
interface Leg {
  key: "php" | "site" | "node" | "laravel";
  example: string;
  /** What design must plan: the app's kind and the folder the hostname serves. */
  app: "php" | "static" | "node";
  webRoot: string;
  marker: Marker;
  /** The plain PHP app's checks: its database, cron job, settings and storage, a snapshot. */
  data?: true;
  /** Laravel without its gate: provision must refuse it after the agent's report. */
  refused?: true;
}

const NODE_TEXT = "opscrew-e2e release two";

const LEGS: readonly Leg[] = [
  {
    key: "php",
    example: "php-plain-mysql",
    app: "php",
    webRoot: "public",
    marker: PHP_MARKER,
    data: true,
  },
  {
    key: "site",
    example: "static-vite",
    app: "static",
    webRoot: ".",
    marker: SITE_MARKER,
  },
  {
    key: "node",
    example: "hono-api",
    app: "node",
    webRoot: "public",
    marker: {
      path: "/",
      file: "src/index.ts",
      second: async () =>
        (await readFile(join(EXAMPLES, "hono-api/src/index.ts"), "utf8")).replace(
          '"Hello from Hono"',
          `"Hello from Hono, ${NODE_TEXT}"`,
        ),
      isSecond: (status, body) => status === 200 && body.includes(NODE_TEXT),
      isFirst: (status, body) =>
        status === 200 && body.includes("Hello from Hono") && !body.includes(NODE_TEXT),
    },
  },
  {
    key: "laravel",
    example: "laravel-app",
    app: "php",
    webRoot: "public",
    marker: PHP_MARKER,
    ...(LARAVEL ? {} : { refused: true as const }),
  },
];

/** The names of the app's settings that hold secrets (the database's password, Laravel's key). */
const SECRET_SETTING = /PASSWORD|SECRET|KEY|TOKEN/i;

/** The sentence provision stops with when the account's PHP doesn't fit the app (R11). */
const PHP_REFUSAL =
  "OpsCrew never changes the account's PHP version, so it stopped before making the hostname or the database.";

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live cPanel account (skipped: set ${MISSING.join(", ")}; see docs/e2e.md, "A cPanel account")`
    : `live cPanel account: ${LEGS.map((leg) => `examples/${leg.example}`).join(", ")}`,
  () => {
    const run = new LiveRun({
      label: "cPanel",
      name: "cpanel",
      // No server, no Cloudflare: the account keeps the hostnames' DNS (research R10).
      settings: { ...serverSettings(ENV), hcloudToken: "", cloudflareToken: "", domain: "" },
    });
    const { log } = run;
    const tag = runTag(run.runId);
    /** Made in step 0, once the variables are known to be set. */
    let account: CpanelAccount | undefined;
    let access: HostingPanelAccess | undefined;
    let before: AccountInventory | undefined;
    let githubBefore: string[] | undefined;
    /** The leg running now: the cleanup destroys it when it was provisioned and not destroyed. */
    let current:
      | { leg: Leg; app: string; hostname: string; provisioned: boolean; destroyed: boolean }
      | undefined;
    /** The leak search's problems of the legs done (their commits, audit logs, files, agent's log). */
    const legLeaks: string[] = [];

    const cpanel = () => account as CpanelAccount;
    const secrets = () =>
      run.scrubber.entries().filter(({ label }) => !label.startsWith(ACCOUNT_LABEL_PREFIX));
    const request = (url: string, options: Parameters<typeof httpRequest>[1] = {}) =>
      httpRequest(url, { timeoutMs: 30_000, ...options });

    /** Waits for the deploy run of commit `sha` to succeed with its wait job; its id. */
    async function deployed(sha: string, what: string): Promise<number> {
      log(`waiting for the deploy run of ${what} (up to 30 minutes)`);
      const found = await run.github.waitForDeploy({ headSha: sha });
      const problem = hostingRunProblem(found, PANEL_DEPLOY_JOB);
      if (problem !== undefined) {
        throw new Error(`The deploy run ${found.id} (${what}) did not deploy: ${problem}.`);
      }
      log(`deploy run ${found.id} (${what}) succeeded`);
      return found.id;
    }

    /** Waits until `url` answers 200 and returns the answer. */
    function answering(url: string, ms = minutes(10)) {
      return waitFor(`${url} answering 200`, ms, async () => {
        const answer = await request(url);
        if (answer.status !== 200) throw new Error(`it answered ${answer.status}.`);
        return answer;
      });
    }

    /** The answers around a switch, checked (SC-2703); returns the release switched to. */
    async function switched<T>(
      what: string,
      input: { url: string; from: string; pages: SwitchPages; during: () => Promise<T> },
    ): Promise<string> {
      const started = Date.now();
      const samples = await watchSwitch({
        url: input.url,
        oldRelease: input.from,
        pages: input.pages,
        during: input.during,
        request: (url) => request(url),
      });
      const verdict = switchVerdict(samples, input.from);
      if (verdict.switchedAt === undefined || verdict.release === undefined) {
        throw new Error(`No answer named another release than ${input.from} (${what}).`);
      }
      expect(verdict.problems, `the answers after the switch (${what}, SC-2703)`).toEqual([]);
      if (verdict.others > 0) {
        run.findings.push(
          `${what}: ${verdict.others} of the ${verdict.after} answers after the switch were errors or showed neither page`,
        );
      }
      log(
        `observed: ${what}: the first answer of ${verdict.release} came ${Math.round(verdict.switchedAt / 1000)} s into the watch (${Math.round((Date.now() - started) / 1000)} s in all); all ${verdict.after} answers from it on showed it`,
      );
      return verdict.release;
    }

    /** The app's folder on the account, `opscrew/<app>-prod`. */
    const folderOf = (app: string) => `opscrew/${app}-prod`;

    /** Adds the agent's private GitHub key and the app's secret settings on the account to the scrubber. */
    async function rememberAccountSecrets(app: string, database: boolean): Promise<void> {
      const folder = folderOf(app);
      let keys = 0;
      for (const name of (await cpanel().panel.list(`${folder}/keys`)) ?? []) {
        if (name.endsWith(".pub")) continue;
        const content = await cpanel().panel.readFile(`${folder}/keys/${name}`);
        // Its private keys only; its known hosts and public halves are no secrets.
        if (content?.includes("PRIVATE KEY") === true) {
          run.scrubber.add(content, "agent-key");
          keys++;
        }
      }
      if (keys === 0) {
        run.findings.push(
          `${app}: the account holds no private key of the agent in ${folder}/keys, so the leak search misses it`,
        );
      }
      const settings = await cpanel().panel.readFile(`${folder}/shared/.env`);
      let password = false;
      for (const [name, value] of parseDotenv(settings ?? "")) {
        if (SECRET_SETTING.test(name) && value.length >= 8) run.scrubber.add(value, "app-setting");
        if (/PASSWORD/i.test(name) && value !== "") password = true;
      }
      if (database && !password) {
        run.findings.push(
          `${app}: the app's settings on the account hold no database password, so the leak search misses it`,
        );
      }
    }

    /** The leak search of the leg now done: its commits, pull requests, audit log and files. */
    async function legLeakSearch(leg: Leg, agentLog: string): Promise<void> {
      const known = secrets();
      const plain = known.filter(({ label }) => !label.startsWith("server-"));
      const sources: LeakSource[] = [
        ...(await run.leakSources()),
        ...(await localLeakSources(run.paths(), [
          join(run.work, "copies", `${run.app()}.sops.json`),
        ])),
        { kind: "file", where: "the agent's log on the account", text: agentLog },
      ];
      for (const { where, text } of sources) {
        const found = leakedLabels(text, plain);
        if (found.length > 0) legLeaks.push(`${leg.key}: ${where} contains: ${found.join(", ")}`);
      }
    }

    function legSteps(leg: Leg, index: number): void {
      const { app, hostname } = legNames(tag, leg.key, DOMAIN);
      const folder = folderOf(app);
      const url = (path: string) => `https://${hostname}${path}`;
      const markerUrl = url(leg.marker.path);
      const keyFile = () => join(run.work, "age-key.txt");
      let plan: DeployPlan | undefined;
      let first = "";
      let second = "";
      const value = (n: number) => `value-${tag}-${n}`;
      const n = (step: number) => `${index + 1}.${step} ${leg.key}`;

      run.step(
        `${n(1)}: examples/${leg.example} as ${app}: init, analyze, the interview (it finds cPanel by itself) and design`,
        minutes(20),
        async () => {
          await run.prepareRepo({
            commit: `e2e: examples/${leg.example} on a cPanel account`,
            folders: { ".": leg.example },
            env: hostingEnv(access as HostingPanelAccess),
            drop: [...SFTP_VARIABLES, "CLOUDFLARE_API_TOKEN"],
            ...(leg.marker.first === undefined
              ? {}
              : { files: { [leg.marker.file]: leg.marker.first } }),
          });
          current = { leg, app, hostname, provisioned: false, destroyed: false };
          run.destroyed = false;
          githubBefore ??= await environmentNames(run.github);
          if (leg.key === "node") {
            // A setting of the app's own, to see where the selector keeps it.
            const setting = randomBytes(12).toString("hex");
            run.scrubber.add(setting, "app-setting");
            await writeFile(join(run.work, "production.env"), `OPSCREW_E2E_SETTING=${setting}\n`);
          }
          await run.initFix();
          await run.opscrewOk("analyze", "--no-ai");
          const file = run.paths().files.architecture;
          const architecture = await readArtifact("architecture", file);
          await writeArtifact("architecture", file, {
            ...architecture,
            facts: { ...architecture.facts, name: app },
          });
          const answers = join(run.work, "answers.json");
          await writeFile(answers, JSON.stringify(hostingAnswers(hostname)));
          await run.opscrewOk("interview", "--answers", answers);
          const requirements = await readArtifact("requirements", run.paths().files.requirements);
          expect(requirements.provider, "the target the interview recorded").toBe("hosting");
          const designed = await run.opscrewOk("design");
          plan = await run.readPlan();
          run.appName = plan.app.name;
          expect(plan.app.name, "the app's name").toBe(app);
          expect(plan.dns.domain, "the app's hostname").toBe(hostname);
          expect(plan.target, "what design planned on the account").toMatchObject({
            provider: "hosting",
            panel: "cpanel",
            app: leg.app,
            webRoot: leg.webRoot,
            docroot: "direct",
          });
          if (leg.data === true) {
            expect("database" in plan.target && plan.target.database, "a database").toBeTruthy();
          }
          const server = /LiteSpeed|Apache/.exec(designed.output)?.[0] ?? "no web server named";
          log(`observed: design names ${server} for the account`);
          const copies = join(run.work, "copies");
          await mkdir(copies, { recursive: true });
          await run.opscrewOk("secrets", "folder", copies);
          run.provisionFlags = ["--key-out", keyFile()];
        },
      );

      if (leg.refused === true) {
        run.step(
          `${n(2)}: provision stops after the agent's report: the account's PHP doesn't fit the app, and nothing else is made (R11)`,
          minutes(30),
          async () => {
            (current as NonNullable<typeof current>).provisioned = true;
            const flags = [...run.provisionFlags, "--yes"];
            const planned = await run.opscrewOk("provision", "--plan-only", ...flags);
            const hashes = approveHashes(planned.output);
            expect(hashes.length, `the plans provision showed:\n${run.tail(planned.output)}`).toBe(
              1,
            );
            // Plan A (the agent) only: the refusal comes with its report, before any plan B.
            const applied = await run.opscrew(
              "provision",
              "--approve",
              hashes[0] as string,
              ...flags,
            );
            const { output } = applied;
            expect(applied.exitCode, `provision must stop:\n${run.tail(output)}`).not.toBe(0);
            expect(output, `provision's refusal:\n${run.tail(output)}`).toContain(PHP_REFUSAL);
            expect(output, "the way out it names").toContain("PHP selector");
            expect(await cpanel().panel.documentRoot(hostname), "the hostname").toBeUndefined();
            expect(
              (await cpanel().panel.listDatabases()).filter((name) => namesRun(name, tag)),
              "the run's databases",
            ).toEqual([]);
            log("observed: provision refused examples/laravel-app after the agent's report");
          },
        );
      } else {
        legDeploySteps();
      }

      run.step(
        `${n(8)}: destroy, confirmed with the hostname: nothing of the app left on the account or at GitHub; the leg's commits, pull requests, audit log, files and agent's log hold no secret`,
        minutes(30),
        async () => {
          const agentLog = (await cpanel().panel.readFile(`${folder}/state/agent.log`)) ?? "";
          // The release branch, which destroy deletes, for the leg's leak search below.
          await run.git("fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
          await opscrewUntilApproved(run, ["destroy", "--confirm", hostname, "--no-snapshot"]);
          (current as NonNullable<typeof current>).destroyed = true;
          run.destroyed = true;
          expect(await cpanel().panel.documentRoot(hostname), "the hostname").toBeUndefined();
          expect(
            (await cpanel().panel.listCron()).filter((line) => line.command.includes(folder)),
            "the app's cron lines",
          ).toEqual([]);
          expect(
            (await cpanel().panel.listDatabases()).filter((name) =>
              namesRun(name, `${tag}_${leg.key}`),
            ),
            "the app's database",
          ).toEqual([]);
          expect(
            ((await cpanel().panel.list("opscrew")) ?? []).filter((name) => name.startsWith(app)),
            "the app's folder in ~/opscrew",
          ).toEqual([]);
          if (leg.key === "node") {
            expect(
              await cpanel().panel.list(`nodevenv/${folder}`),
              "the selector's environment folder",
            ).toBeUndefined();
          }
          const keys = await run.github.call("GET", `/repos/${run.github.name}/keys?per_page=100`);
          expect(
            ((keys.json as { title: string }[] | undefined) ?? []).filter((key) =>
              key.title.startsWith(`opscrew-${app}`),
            ),
            "the agent's deploy key at GitHub",
          ).toEqual([]);
          await legLeakSearch(leg, agentLog);
          // The next leg's repository and OpsCrew home go into a new folder.
          await rm(run.work, { recursive: true, force: true });
          log(`${leg.key}: destroy left nothing of ${app}`);
        },
      );

      function legDeploySteps(): void {
        run.step(
          `${n(2)}: provision: plan A (the agent), its report, plan B (the app), each approved by its hash; the hostname at the release, ${leg.data === true ? "the database, the cron jobs, " : ""}the agent's cron line`,
          minutes(45),
          async () => {
            (current as NonNullable<typeof current>).provisioned = true;
            const output = await run.provisionUntilDone(`${leg.key}: provision`);
            const plans = new Set(
              [...output.matchAll(/Hosting plan hash: ([0-9a-f]{64})/g)].map((m) => m[1]),
            );
            expect(plans.size, "the hosting plans provision showed").toBeGreaterThanOrEqual(2);
            await run.rememberSecretFile(keyFile(), "age-identity");
            plan = await run.readPlan();
            await rememberAccountSecrets(
              app,
              plan.target.provider === "hosting" && plan.target.database !== undefined,
            );
            const root = await cpanel().panel.documentRoot(hostname);
            expect(root ?? "", "the hostname's document root").toMatch(
              new RegExp(`${folder}/current${leg.webRoot === "." ? "" : `/${leg.webRoot}`}$`),
            );
            const cron = (await cpanel().panel.listCron()).filter((line) =>
              line.command.includes(folder),
            );
            expect(cron.length, "the agent's cron line and the app's").toBe(
              1 + (plan.target.provider === "hosting" ? plan.target.cron.length : 0),
            );
            if (plan.target.provider === "hosting" && plan.target.php !== undefined) {
              log(
                `observed: the hostname runs PHP ${plan.target.php.version} through ${plan.target.php.via}`,
              );
              if (leg.key === "php") {
                expect(plan.target.php.via, "the hostname's PHP comes through its handler").toBe(
                  "handler",
                );
              }
            }
            if (leg.data === true) {
              expect(
                (await cpanel().panel.listDatabases()).filter((name) => namesRun(name, tag)).length,
                "the app's database",
              ).toBe(1);
            }
          },
        );

        run.step(
          `${n(3)}: the first deploy, verify, status and logs${leg.data === true ? "; the settings, the database, the storage and the cron job" : ""}${leg.key === "node" ? "; where the selector keeps the app (printed)" : ""}`,
          minutes(45),
          async () => {
            const sha = await run.mergeDeploySetup(`${leg.key}: the first deploy`);
            if (sha === undefined)
              throw new Error("provision opened no deploy-setup pull request.");
            await deployed(sha, `${leg.key}: the first deploy`);
            const health = await answering(url((plan as DeployPlan).app.healthPath));
            first = releaseOf(health) ?? "";
            if (first === "")
              throw new Error("The app answered without its X-OpsCrew-Release header.");
            const status = await run.opscrewOk("status");
            expect(status.output, "status names the running release").toContain(
              `Release: ${first} runs`,
            );
            const logs = await run.opscrewOk("logs");
            log(`the agent's log after the first deploy:\n${run.scrub(logs.output)}`);
            const verified = await run.opscrew("verify");
            if (verified.exitCode !== 0) {
              // Evidence for a failed check: how long HTTPS takes to be forced, and the agent's log.
              const http = url("/").replace(/^https:/, "http:");
              const since = Date.now();
              const redirected = await waitFor(`${http} redirecting`, minutes(5), async () => {
                const answer = await request(http);
                return answer.status >= 300 && answer.status < 400 ? answer.status : undefined;
              }).catch(() => undefined);
              log(
                redirected === undefined
                  ? `observed: ${http} didn't redirect within 5 minutes after verify`
                  : `observed: ${http} redirected (${redirected}) ${duration(Date.now() - since)} after verify`,
              );
              const later = await run.opscrewOk("logs");
              log(`the agent's log after that wait:\n${run.scrub(later.output)}`);
              throw new Error(
                `opscrew verify exited with ${verified.exitCode}:\n${run.scrub(verified.output)}`,
              );
            }
            if (leg.data === true) {
              const home = await answering(url("/"));
              expect(home.body, "the app reached its database").toContain("MySQL");
              const put = await request(url("/data"), { method: "PUT", body: value(1) });
              expect(put.status, "PUT /data").toBe(204);
              expect((await request(url("/data"))).body, "the note, in MySQL and storage").toBe(
                value(1),
              );
              const cron = await waitFor("the app's cron job running", minutes(5), async () => {
                const answer = await request(url("/cron"));
                return answer.status === 200 ? answer.body : undefined;
              });
              log(`observed: ${cron}`);
            }
            if (leg.key === "node") await selectorFindings();
            log(`observed: ${leg.key}: the first release ${first} answers`);
          },
        );

        run.step(
          `${n(4)}: a second release: the first answer after its switch, and every one after, is the new release's (SC-2703)`,
          minutes(45),
          async () => {
            const title = `e2e: the second release of ${leg.key}`;
            const text = await leg.marker.second();
            second = await switched(`${leg.key}: the second release`, {
              url: markerUrl,
              from: first,
              pages: { isNew: leg.marker.isSecond, isOld: leg.marker.isFirst },
              during: async () => deployed(await run.merge(title, leg.marker.file, text), title),
            });
            expect((await run.opscrewOk("status")).output, "status").toContain(
              `Release: ${second} runs`,
            );
            if (leg.data === true) {
              expect((await request(url("/data"))).body, "the note kept across releases").toBe(
                value(1),
              );
            }
          },
        );

        run.step(
          `${n(5)}: rollback to the first release, keeping the database: the first answer after it, and every one after, is the first release's (SC-2703); then --resume`,
          minutes(30),
          async () => {
            const shown = await shownRollback(run);
            expect(shown.to, "the release the rollback goes back to").toBe(first);
            await switched(`${leg.key}: the rollback`, {
              url: markerUrl,
              from: second,
              pages: { isNew: leg.marker.isFirst, isOld: leg.marker.isSecond },
              during: () =>
                run.opscrewOk(
                  "rollback",
                  "--to",
                  shown.to,
                  ...(shown.database === undefined ? [] : ["--database", shown.database]),
                  ...(shown.confirm === undefined ? [] : ["--confirm", shown.confirm]),
                  "--approve",
                  shown.hash,
                ),
            });
            expect((await run.opscrewOk("status")).output, "status").toContain(
              `Release: ${first} runs`,
            );
            if (leg.data === true) {
              expect((await request(url("/data"))).body, "the database kept").toBe(value(1));
            }
            await run.opscrewOk("rollback", "--resume", "--yes");
          },
        );

        run.step(`${n(6)}: secure and drift`, minutes(15), async () => {
          await run.opscrewOk("secure");
          await run.opscrewOk("drift");
        });

        if (leg.data !== true) return;
        run.step(
          `${n(7)}: a snapshot, a change, and the snapshot's restore, confirmed with the hostname: the note as it was`,
          minutes(20),
          async () => {
            const taken = await run.opscrewOk("snapshot");
            const id = /Took the snapshot (\S+) of /.exec(taken.output)?.[1];
            if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
            await request(url("/data"), { method: "PUT", body: value(2) });
            expect((await request(url("/data"))).body, "the changed note").toBe(value(2));
            const restored = await approvedRestore(run, [id]);
            expect(restored.confirm, "the name the restore asks to type").toBe(hostname);
            expect((await request(url("/data"))).body, "the note after the restore").toBe(value(1));
            log(`observed: the snapshot ${id} put the note back in MySQL and storage`);
          },
        );
      }

      /**
       * The Node.js app's printed findings (T2717's review): where CloudLinux's selector placed
       * the app's root (the `current` link, followed by each switch, or a release folder), its
       * environment folder, and where it keeps the app's settings (names only).
       */
      async function selectorFindings(): Promise<void> {
        const panel = cpanel().panel;
        for (const file of (await panel.list(".cl.selector")) ?? []) {
          const content =
            (await panel.readFile(`.cl.selector/${file}`).catch(() => undefined)) ?? "";
          const roots = appRootSuffixes(content, folder);
          if (roots.length > 0) {
            log(
              `finding: ~/.cl.selector/${file} names the app's root as ${roots.map((root) => `${folder}${root}`).join(", ")} (${roots.every((root) => root === "/current") ? "the current link, kept" : "not only the current link"})`,
            );
          }
          const names = selectorEnvNames(content, tag);
          if (names.length > 0) {
            log(`finding: ~/.cl.selector/${file} holds the app's variables ${names.join(", ")}`);
          }
        }
        log(
          `finding: ~/nodevenv/${folder} holds ${((await panel.list(`nodevenv/${folder}`)) ?? []).join(", ") || "nothing"}`,
        );
        const served = (await panel.readFile(`${folder}/current/public/.htaccess`)) ?? "";
        const names = envNames(served);
        log(
          names.length > 0
            ? `finding: the served folder's .htaccess holds the app's variables ${names.join(", ")} (inside the release, behind OpsCrew's dotfile rule)`
            : "finding: the served folder's .htaccess holds none of the app's variables",
        );
        log(
          "finding: install-modules with an absolute --requirements-file (a Python app's) is untested here: the pass has no Python app",
        );
      }
    }

    // -------------------------------------------------------------------------------------------

    run.step(
      "0. the account before the run: its inventory (domains, databases and users, cron, SSH keys, tokens, the home folder, ~/opscrew, ~/nodevenv/opscrew, ~/.cl.selector, the zone's records, certificates and keys)",
      minutes(10),
      async () => {
        access = panelAccess(ENV);
        account = new CpanelAccount(access, DOMAIN);
        run.scrubber.add(access.token, "cpanel-token");
        for (const { value, label } of accountMasks(access, [DOMAIN])) {
          run.scrubber.add(value, label);
        }
        const prefix = await cpanel().databasePrefix();
        before = await cpanel().inventory();
        const domains = before.fields.domains?.map((entry) => entry.split("|")[1] ?? "") ?? [];
        for (const { value, label } of accountMasks(access, domains, prefix)) {
          run.scrubber.add(value, label);
        }
        for (const entry of otherRunsObjects(before.fields, tag)) {
          log(`warning: the account has ${entry} of another run; this run leaves it alone`);
        }
        if (!domains.includes(DOMAIN)) {
          throw new Error(
            "OPSCREW_E2E_CPANEL_DOMAIN is none of the account's domains: set it to one the account serves.",
          );
        }
        const taken = Object.values(before.fields)
          .flat()
          .filter((entry) => namesRun(entry, tag));
        expect(taken, "objects already named after this run").toEqual([]);
        log(
          `the account before: ${Object.entries(before.fields)
            .map(([field, entries]) => `${field} ${entries.length}`)
            .join(", ")}`,
        );
      },
    );

    LEGS.forEach(legSteps);

    run.step(
      "10. the account after the run, field by field: nothing of the run is left and nothing else changed (SC-2702)",
      minutes(10),
      async () => {
        if (before === undefined) throw new Error("There is no inventory from before the run.");
        const after = await cpanel().inventory();
        const { problems, observed } = inventoryProblems(before.fields, after.fields, tag);
        for (const line of observed) log(`observed: ${line}`);
        for (const field of Object.keys(after.fields)) {
          if (!problems.some((problem) => problem.startsWith(`${field}:`))) {
            log(`the account after: ${field} as before (${after.fields[field]?.length})`);
          }
        }
        expect(
          problems.map((problem) => run.scrub(problem)),
          "the account's differences",
        ).toEqual([]);
      },
      { always: true },
    );

    run.step(
      "11. no token, agent's key or setting in any CLI output, commit, pull request, audit entry, saved plan, report or agent's log (SC-2704)",
      minutes(10),
      async () => {
        const stopped = current;
        if (stopped !== undefined && !stopped.destroyed && run.repoReady && existsSync(run.work)) {
          const agentLog = await cpanel()
            .panel.readFile(`${folderOf(stopped.app)}/state/agent.log`)
            .catch(() => undefined);
          await legLeakSearch(stopped.leg, agentLog ?? "");
        }
        const plain = secrets().filter(({ label }) => !label.startsWith("server-"));
        const problems = [...legLeaks];
        for (const [label, output] of run.outputs) {
          const found = leakedLabels(output, plain);
          if (found.length > 0) problems.push(`${label} printed: ${found.join(", ")}`);
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    run.registerCleanup({
      teardown: async (attempt) => {
        const leg = current;
        if (leg?.provisioned && !leg.destroyed) {
          log(`${leg.leg.key} was not destroyed: running opscrew destroy first`);
          await attempt(`opscrew destroy of ${leg.leg.key}`, () =>
            opscrewUntilApproved(
              run,
              ["destroy", "--confirm", leg.hostname, "--no-snapshot"],
              (...args) => run.opscrewWithin(CLEANUP_DESTROY_RUN_MS, ...args),
            ),
          );
        }
        if (!run.repoReady) return;
        await attempt(
          "remove the run's deploy keys, secrets, environments and pause at GitHub",
          () =>
            hostingGithubLeftovers(run, {
              before: githubBefore,
              live: current !== undefined && !current.destroyed,
              keyPrefix: `opscrew-e2e-${tag}-`,
            }),
        );
      },
      last: async (attempt) => {
        if (account === undefined) return;
        if (before === undefined) {
          await attempt("clean up the account", async () => [
            "there is no inventory from before the run, so the cleanup changed nothing on the account; look for e2e-… objects in cPanel",
          ]);
          return;
        }
        const inventory = before;
        await attempt("remove what the run left on the account", async () => {
          const { problems } = await cpanel().cleanUp({ tag, before: inventory }, log);
          const after = await cpanel().inventory();
          return [
            ...problems,
            ...inventoryProblems(inventory.fields, after.fields, tag).problems.map(
              (problem) => `after the cleanup, ${problem}`,
            ),
          ];
        });
      },
    });
  },
);
