/**
 * The live pass of feature 027 on an SFTP-only host (docs/e2e.md "An SFTP-only host", FR-2712,
 * plan 10): a throwaway Hetzner server the test sets up the way such a host is, as the user would
 * find it: an account chrooted to its folder that reaches it over SFTP only (`internal-sftp`), and
 * Apache with PHP-FPM (running as that account) serving its folder, so `.htaccess` and `.user.ini`
 * apply; MariaDB, the hostnames' DNS records and their Let's Encrypt certificates are the user's
 * part, which the test does too. Two apps, each on its own hostname and folder there:
 * `examples/static-vite` (`OPSCREW_E2E_GITHUB_REPO`) and `examples/php-plain-mysql` with the
 * database's values as its settings (`OPSCREW_E2E_GITHUB_REPO_B`). For each: interview (the host's
 * key confirmed), design, provision (one hosting plan, approved by its hash, applied over SFTP), the
 * first deploy, verify and status, a second release and a rollback over SFTP (the answers around
 * each switch watched), and destroy. The server, the records and everything else go in the
 * harness's cleanup.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { type CloudflareZone, httpRequest, minutes, resolveIpv4, waitFor } from "./cloud";
import {
  hostingAnswers,
  hostingGithubLeftovers,
  hostingRunProblem,
  type Marker,
  nothingDeployed,
  PANEL_VARIABLES,
  PHP_MARKER,
  releaseOf,
  runTag,
  SFTP_DEPLOY_JOB,
  SITE_MARKER,
  switchVerdict,
  watchSwitch,
} from "./cpanel-support";
import { environmentNames, opscrewUntilApproved } from "./environment-checks";
import { CLEANUP_DESTROY_RUN_MS, LiveRun, localLeakSources, serverSettings } from "./harness";
import { shownRollback } from "./rollback-support";
import { leakedLabels, missingVariables, SERVER_E2E_VARIABLES } from "./support";

const ENV = process.env;
const GATE = "OPSCREW_E2E_SFTP";
const MISSING = missingVariables(ENV, GATE, SERVER_E2E_VARIABLES);
const SETTINGS = { ...serverSettings(ENV, "OPSCREW_E2E_OWN_SERVER_TYPE"), app: "static-vite" };
if (ENV[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (SFTP host): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "An SFTP-only host").`,
  );
}

/** The host's SFTP account, chrooted to its home; SFTP starts in its folder `files`. */
const SFTP_USER = "e2esftp";
const HOME = `/srv/sftp/${SFTP_USER}`;
const START = `${HOME}/files`;
/** PHP-FPM's pool for the account: PHP runs as it, so it reads the app's 0600 settings. */
const PHP_SOCKET = `/run/php/${SFTP_USER}.sock`;
/** The PHP app's database, which the user makes on such a host. */
const DATABASE = "e2e_notes";
/** PHP on Ubuntu 24.04, the throwaway server's image. */
const PHP_VERSION = "8.3";

/** One app of the pass, on its own hostname and in its own folder of the account. */
interface Leg {
  app: LiveRun;
  key: "site" | "php";
  example: string;
  kind: "static" | "php";
  webRoot: string;
  marker: Marker;
  /** The app's folder as SFTP shows it, under {@link START}. */
  folder: string;
  provisioned: boolean;
  destroyed: boolean;
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live SFTP-only host (skipped: set ${MISSING.join(", ")}; see docs/e2e.md, "An SFTP-only host")`
    : "live SFTP-only host: examples/static-vite and examples/php-plain-mysql on a Hetzner server set up as one",
  () => {
    const run = new LiveRun({ label: "SFTP host", name: "sftp", settings: SETTINGS });
    const b = run.second("php-plain-mysql");
    const { log } = run;
    const tag = runTag(run.runId);
    const legs: Leg[] = [
      {
        app: run,
        key: "site",
        example: "static-vite",
        kind: "static",
        webRoot: ".",
        marker: SITE_MARKER,
        folder: `e2e-${tag}-site`,
        provisioned: false,
        destroyed: false,
      },
      {
        app: b,
        key: "php",
        example: "php-plain-mysql",
        kind: "php",
        webRoot: "public",
        marker: PHP_MARKER,
        folder: `e2e-${tag}-php`,
        provisioned: false,
        destroyed: false,
      },
    ];
    let fingerprint = "";
    /** The SFTP account's own key, which OpsCrew logs in with from this computer. */
    let userKey = "";
    let dbPassword = "";
    const githubBefore = new Map<LiveRun, string[]>();

    const request = (url: string, options: Parameters<typeof httpRequest>[1] = {}) =>
      httpRequest(url, { timeoutMs: 30_000, ...options });
    const phpPath = (leg: Leg) => `${START}/${leg.folder}`;
    const documentRoot = (leg: Leg) =>
      `${phpPath(leg)}/current${leg.webRoot === "." ? "" : `/${leg.webRoot}`}`;

    /** Waits for the deploy run of commit `sha` to succeed with its upload job; its id. */
    async function deployed(app: LiveRun, sha: string, what: string): Promise<number> {
      log(`waiting for the deploy run of ${what} (up to 30 minutes)`);
      const found = await app.github.waitForDeploy({ headSha: sha });
      const problem = hostingRunProblem(found, SFTP_DEPLOY_JOB);
      if (problem !== undefined) {
        throw new Error(`The deploy run ${found.id} (${what}) did not deploy: ${problem}.`);
      }
      log(`deploy run ${found.id} (${what}) succeeded`);
      return found.id;
    }

    /**
     * The answers around a switch of `leg` from release `from`, checked: from the first answer of
     * another release on (for the PHP app, whose PHP-FPM may keep the old release up to 120 s on
     * Apache, from `settledAt()` on), every answer is the new release's. Returns that release.
     */
    async function switched(
      leg: Leg,
      what: string,
      input: {
        from: string;
        toFirst: boolean;
        during: () => Promise<unknown>;
        settledAt?: () => number;
        settleMs?: number;
      },
    ): Promise<string> {
      const start = Date.now();
      const { marker } = leg;
      const samples = await watchSwitch({
        url: `https://${leg.app.appHost}${marker.path}`,
        oldRelease: input.from,
        pages: input.toFirst
          ? { isNew: marker.isFirst, isOld: marker.isSecond }
          : { isNew: marker.isSecond, isOld: marker.isFirst },
        during: input.during,
        request: (url) => request(url),
        ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
      });
      const from = input.settledAt === undefined ? 0 : input.settledAt() - start;
      const verdict = switchVerdict(samples, input.from, from);
      if (verdict.release === undefined) {
        throw new Error(`No answer named another release than ${input.from} (${what}).`);
      }
      if (verdict.problems.length > 0) {
        const shown = [...verdict.problems.slice(0, 3), "…", ...verdict.problems.slice(-2)];
        log(
          `the answers after the switch that weren't the new release's (${what}):\n${shown.join("\n")}`,
        );
        // Evidence: how long PHP keeps serving the old page with no restart (R5: its caches).
        const pages = input.toFirst
          ? { isNew: marker.isFirst, isOld: marker.isSecond }
          : { isNew: marker.isSecond, isOld: marker.isFirst };
        let fresh = 0;
        const stopsAt = Date.now() + minutes(10);
        while (fresh < 6 && Date.now() < stopsAt) {
          const answer = await request(`https://${leg.app.appHost}${marker.path}`).catch(
            () => undefined,
          );
          fresh = answer !== undefined && pages.isNew(answer.status, answer.body) ? fresh + 1 : 0;
          if (fresh < 6) await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        log(
          `observed: ${what}: the old page stopped ${fresh >= 6 ? `${Math.round((Date.now() - start) / 1000)} s after the watch began` : "not within 10 minutes after the watch"} (the new release's 6 answers in a row)`,
        );
      }
      expect(verdict.problems, `the answers after the switch (${what})`).toEqual([]);
      if (verdict.others > 0) {
        run.findings.push(
          `${what}: ${verdict.others} of the ${verdict.after} answers after the switch were errors or showed neither page`,
        );
      }
      log(`observed: ${what}: ${verdict.after} answers of ${verdict.release}, all of it`);
      return verdict.release;
    }

    function legSteps(leg: Leg, index: number): void {
      const { app } = leg;
      const name = `e2e-${tag}-${leg.key}`;
      const url = (path: string) => `https://${app.appHost}${path}`;
      const keyFile = () => join(app.work, "age-key.txt");
      let first = "";
      let second = "";
      const n = (step: number) => `${index + 2}.${step} ${leg.key}`;

      run.step(
        `${n(1)}: examples/${leg.example} as ${name}: init, analyze, the interview (the host's key confirmed, the folder and the path PHP sees) and design`,
        minutes(20),
        async () => {
          app.env = {
            ...app.env,
            OPSCREW_SFTP_HOST: run.ipv4(),
            OPSCREW_SFTP_USER: SFTP_USER,
            OPSCREW_SFTP_KEY: userKey,
          };
          if (leg.kind === "php") {
            await writeFile(
              join(app.work, "production.env"),
              [
                "DB_HOST=localhost",
                "DB_PORT=3306",
                `DB_DATABASE=${DATABASE}`,
                `DB_USERNAME=${DATABASE}`,
                `DB_PASSWORD=${dbPassword}`,
                "",
              ].join("\n"),
            );
          }
          await app.initFix();
          await app.opscrewOk("analyze", "--no-ai");
          const file = app.paths().files.architecture;
          const architecture = await readArtifact("architecture", file);
          await writeArtifact("architecture", file, {
            ...architecture,
            facts: { ...architecture.facts, name },
          });
          const answers = join(app.work, "answers.json");
          await writeFile(
            answers,
            JSON.stringify(
              hostingAnswers(app.appHost, {
                "hosting.port": 22,
                "hosting.hostKey": fingerprint,
                "hosting.folder": leg.folder,
                "hosting.phpPath": phpPath(leg),
              }),
            ),
          );
          await app.opscrewOk("interview", "--answers", answers);
          await app.opscrewOk("design");
          const plan = await app.readPlan();
          expect(plan.app.name, "the app's name").toBe(name);
          expect(plan.target, "what design planned on the host").toMatchObject({
            provider: "hosting",
            panel: "sftp",
            app: leg.kind,
            webRoot: leg.webRoot,
          });
          if (leg.kind === "php" && plan.target.provider === "hosting") {
            // OpsCrew can't read the host's PHP over SFTP: the plan names the version it runs, as
            // the guide says.
            await writeArtifact("plan", app.paths().files.plan, {
              ...plan,
              target: { ...plan.target, php: { version: PHP_VERSION, via: "account" } },
            });
          }
          const copies = join(app.work, "copies");
          await mkdir(copies, { recursive: true });
          await app.opscrewOk("secrets", "folder", copies);
          app.provisionFlags = ["--key-out", keyFile()];
        },
      );

      run.step(
        `${n(2)}: provision over SFTP, approved by its hash: the app's folder at the planned document root, GitHub Actions' key in ~/.ssh/authorized_keys with restrict`,
        minutes(30),
        async () => {
          leg.provisioned = true;
          await app.provisionUntilDone(`${leg.key}: provision`);
          await app.rememberSecretFile(keyFile(), "age-identity");
          const saved = JSON.parse(
            await readFile(join(app.paths().files.plansDir, "hosting-prod-sftp.json"), "utf8"),
          ) as { documentRoot?: string };
          expect(saved.documentRoot, "the document root the plan names").toBe(documentRoot(leg));
          await run.shell().ok(`test -L ${phpPath(leg)}/current`);
          const keys = (await run.shell().ok(`cat ${START}/.ssh/authorized_keys`)).split("\n");
          expect(
            keys.filter((line) => line.startsWith("restrict")).length,
            "GitHub Actions' keys with restrict",
          ).toBe(legs.filter((other) => other.provisioned && !other.destroyed).length);
        },
      );

      run.step(
        `${n(3)}: the first deploy over SFTP from GitHub Actions, verify and status${leg.kind === "php" ? "; the app reads its database's values" : ""}`,
        minutes(40),
        async () => {
          const sha = await app.mergeDeploySetup(`${leg.key}: the first deploy`);
          if (sha === undefined) throw new Error("provision opened no deploy-setup pull request.");
          await deployed(app, sha, `${leg.key}: the first deploy`);
          const health = await waitFor(`${app.appHost} answering 200`, minutes(5), async () => {
            const answer = await request(url((await app.readPlan()).app.healthPath));
            if (answer.status !== 200) throw new Error(`it answered ${answer.status}.`);
            return answer;
          });
          first = releaseOf(health) ?? "";
          if (first === "")
            throw new Error("The app answered without its X-OpsCrew-Release header.");
          await app.opscrewOk("verify");
          expect((await app.opscrewOk("status")).output, "status").toContain(
            `Release: ${first} runs`,
          );
          if (leg.kind === "php") {
            expect((await request(url("/"))).body, "the app reached its database").toContain(
              "MySQL",
            );
            const value = `value-${tag}`;
            expect((await request(url("/data"), { method: "PUT", body: value })).status).toBe(204);
            expect((await request(url("/data"))).body, "the note").toBe(value);
          }
        },
      );

      run.step(
        `${n(4)}: a second release: every answer after the switch is the new release's`,
        minutes(40),
        async () => {
          const title = `e2e: the second release of ${leg.key}`;
          let doneAt = 0;
          second = await switched(leg, `${leg.key}: the second release`, {
            from: first,
            toFirst: false,
            during: async () => {
              await deployed(
                app,
                await app.merge(title, leg.marker.file, await leg.marker.second()),
                title,
              );
              doneAt = Date.now();
            },
            // The workflow's own check waits past PHP's realpath cache before it ends.
            ...(leg.kind === "php" ? { settledAt: () => doneAt } : {}),
          });
          expect((await app.opscrewOk("status")).output, "status").toContain(
            `Release: ${second} runs`,
          );
        },
      );

      run.step(
        `${n(5)}: rollback over SFTP from this computer to the first release; then --resume`,
        minutes(20),
        async () => {
          const shown = await shownRollback(app);
          expect(shown.to, "the release the rollback goes back to").toBe(first);
          let doneAt = 0;
          await switched(leg, `${leg.key}: the rollback`, {
            from: second,
            toFirst: true,
            during: async () => {
              await app.opscrewOk("rollback", "--to", shown.to, "--approve", shown.hash);
              doneAt = Date.now();
            },
            // PHP-FPM may keep the newer release for up to 120 s after a switch on Apache.
            ...(leg.kind === "php" ? { settledAt: () => doneAt + 125_000, settleMs: 140_000 } : {}),
          });
          expect((await app.opscrewOk("status")).output, "status").toContain(
            `Release: ${first} runs`,
          );
          await app.opscrewOk("rollback", "--resume", "--yes");
        },
      );

      run.step(
        `${n(6)}: destroy, confirmed with the hostname: the app's folder and GitHub Actions' key line gone over SFTP`,
        minutes(20),
        async () => {
          await opscrewUntilApproved(app, ["destroy", "--confirm", app.appHost]);
          leg.destroyed = true;
          app.destroyed = true;
          await run.shell().ok(`test ! -e ${phpPath(leg)}`);
          const keys = (await run.shell().ok(`cat ${START}/.ssh/authorized_keys`)).split("\n");
          expect(
            keys.filter((line) => line.startsWith("restrict")).length,
            "GitHub Actions' keys left",
          ).toBe(legs.filter((other) => other.provisioned && !other.destroyed).length);
        },
      );
    }

    // -------------------------------------------------------------------------------------------

    run.step(
      "1. a throwaway Hetzner server set up as an SFTP-only host: a chrooted account with internal-sftp, Apache with PHP-FPM as that account, MariaDB, both hostnames' DNS records and certificates",
      minutes(45),
      async () => {
        await run.prepareRepo({
          commit: "e2e: examples/static-vite on an SFTP-only host",
          drop: [...PANEL_VARIABLES, "CLOUDFLARE_API_TOKEN"],
        });
        await b.prepareRepo({
          commit: "e2e: examples/php-plain-mysql on an SFTP-only host",
          drop: [...PANEL_VARIABLES, "CLOUDFLARE_API_TOKEN"],
          files: { [PHP_MARKER.file]: PHP_MARKER.first as string },
        });
        for (const app of [run, b]) githubBefore.set(app, await environmentNames(app.github));
        fingerprint = await run.createServer();
        b.useServerOf(run);
        userKey = join(run.work, "keys", "sftp-account");
        const keygen = await run.runner.run(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", `opscrew-e2e-sftp-${run.runId}`, "-f", userKey],
          { env: run.env, timeoutMs: 60_000 },
        );
        if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.trim()}`);
        run.scrubber.add(await readFile(userKey, "utf8"), "sftp-account-key");
        dbPassword = randomBytes(16).toString("hex");
        run.scrubber.add(dbPassword, "database-password");
        for (const leg of legs) leg.app.appName = `e2e-${tag}-${leg.key}`;
        const zone = await run.snapshotCloudflare(() => [run.appHost]);
        await b.snapshotCloudflare(() => [b.appHost]);
        log("setting up the host (up to 15 minutes)");
        await run.shell().ok(
          hostSetup({
            publicKey: (await readFile(`${userKey}.pub`, "utf8")).trim(),
            dbPassword,
            sites: legs.map((leg) => ({
              host: leg.app.appHost,
              root: documentRoot(leg),
              conf: leg.folder,
            })),
          }),
          minutes(15),
        );
        for (const leg of legs) await pointAndCertify(zone, leg.app.appHost);
      },
    );

    legs.forEach(legSteps);

    run.step(
      "4. no key, password or token in any CLI output, commit, pull request, audit entry, saved plan or report",
      minutes(10),
      async () => {
        const known = run.scrubber.entries();
        const secrets = known.filter(({ label }) => !label.startsWith("server-"));
        const problems: string[] = [];
        for (const { kind, where, text } of await run.leakSources()) {
          const found = leakedLabels(text, kind === "audit log" ? secrets : known);
          if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
        }
        for (const leg of legs.filter((item) => item.app.repoReady)) {
          const copy = join(leg.app.work, "copies", `${leg.app.appName}.sops.json`);
          for (const { where, text } of await localLeakSources(leg.app.paths(), [copy])) {
            const found = leakedLabels(text, secrets);
            if (found.length > 0)
              problems.push(`${where} (${leg.key}) contains: ${found.join(", ")}`);
          }
        }
        for (const [label, output] of run.outputs) {
          const found = leakedLabels(output, secrets);
          if (found.length > 0) problems.push(`${label} printed: ${found.join(", ")}`);
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    run.registerCleanup({
      teardown: async (attempt) => {
        for (const leg of [...legs].reverse()) {
          if (leg.provisioned && !leg.destroyed) {
            log(`${leg.key} was not destroyed: running opscrew destroy first`);
            await attempt(`opscrew destroy of ${leg.key}`, () =>
              opscrewUntilApproved(leg.app, ["destroy", "--confirm", leg.app.appHost], (...args) =>
                leg.app.opscrewWithin(CLEANUP_DESTROY_RUN_MS, ...args),
              ).catch(nothingDeployed),
            );
          }
          if (!leg.app.repoReady) continue;
          await attempt(`remove what ${leg.key} left at GitHub`, () =>
            hostingGithubLeftovers(leg.app, {
              before: githubBefore.get(leg.app),
              live: !leg.destroyed,
            }),
          );
        }
      },
    });

    /**
     * The hostname's DNS record at the server (DNS only, as the user adds it), then Let's Encrypt's
     * certificate for it through certbot's Apache plugin, once the name resolves.
     */
    async function pointAndCertify(zone: CloudflareZone, host: string): Promise<void> {
      const created = await run.cloudflare.call("POST", `/zones/${zone.id}/dns_records`, {
        type: "A",
        name: host,
        content: run.ipv4(),
        ttl: 60,
        proxied: false,
      });
      if (created.status !== 200) {
        throw new Error(`Cloudflare refused the record of ${host} (HTTP ${created.status}).`);
      }
      await waitFor(`${host} resolving to the server`, minutes(10), async () =>
        (await resolveIpv4(host)).includes(run.ipv4()) ? true : undefined,
      );
      await waitFor(
        `certbot's certificate for ${host}`,
        minutes(6),
        async () => {
          const result = await run
            .shell()
            .run(
              `certbot --apache --non-interactive --agree-tos --register-unsafely-without-email --no-redirect -d ${host}`,
              minutes(3),
            );
          if (result.exitCode !== 0) throw new Error(result.stderr.trim().slice(-300));
          return true;
        },
        30_000,
      );
      log(`${host} points at the server with a Let's Encrypt certificate`);
    }
  },
);

/**
 * The script (run as root) that makes the server an SFTP-only host: the account `e2esftp`
 * chrooted to its home with `internal-sftp` starting in `files/` (its own keys in
 * `files/.ssh/authorized_keys`, where OpsCrew finds them over SFTP), PHP-FPM running as that
 * account, Apache serving each site's document root with `.htaccess` allowed and PHP through that
 * pool, and MariaDB with the PHP app's database.
 */
function hostSetup(input: {
  publicKey: string;
  dbPassword: string;
  sites: readonly { host: string; root: string; conf: string }[];
}): string {
  const vhost = (site: (typeof input.sites)[number]) => [
    `cat > /etc/apache2/sites-available/${site.conf}.conf <<'EOF'`,
    "<VirtualHost *:80>",
    `  ServerName ${site.host}`,
    `  DocumentRoot ${site.root}`,
    `  <Directory ${START}>`,
    "    Options FollowSymLinks",
    "    AllowOverride All",
    "    Require all granted",
    "  </Directory>",
    '  <FilesMatch "\\.php$">',
    `    SetHandler "proxy:unix:${PHP_SOCKET}|fcgi://localhost"`,
    "  </FilesMatch>",
    "</VirtualHost>",
    "EOF",
  ];
  return [
    "set -eu",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -q > /dev/null",
    `apt-get install -y -q apache2 php${PHP_VERSION}-fpm php${PHP_VERSION}-mysql mariadb-server certbot python3-certbot-apache > /dev/null`,
    `id ${SFTP_USER} > /dev/null 2>&1 || useradd --home-dir ${HOME} --no-create-home --shell /usr/sbin/nologin ${SFTP_USER}`,
    `install -d -o root -g root -m 755 /srv/sftp ${HOME}`,
    `install -d -o ${SFTP_USER} -g ${SFTP_USER} -m 755 ${START}`,
    `install -d -o ${SFTP_USER} -g ${SFTP_USER} -m 700 ${START}/.ssh`,
    `printf '%s\\n' '${input.publicKey}' > ${START}/.ssh/authorized_keys`,
    `chown ${SFTP_USER}:${SFTP_USER} ${START}/.ssh/authorized_keys`,
    `chmod 600 ${START}/.ssh/authorized_keys`,
    // `Match all` closes the block: sshd_config's own lines follow its Include.
    "cat > /etc/ssh/sshd_config.d/50-opscrew-e2e-sftp.conf <<'EOF'",
    `Match User ${SFTP_USER}`,
    "  ChrootDirectory %h",
    "  ForceCommand internal-sftp -d /files",
    "  AuthorizedKeysFile %h/files/.ssh/authorized_keys",
    "  PasswordAuthentication no",
    "  AllowTcpForwarding no",
    "  X11Forwarding no",
    "  PermitTTY no",
    "Match all",
    "EOF",
    "sshd -t",
    "systemctl reload ssh",
    `cat > /etc/php/${PHP_VERSION}/fpm/pool.d/${SFTP_USER}.conf <<'EOF'`,
    `[${SFTP_USER}]`,
    `user = ${SFTP_USER}`,
    `group = ${SFTP_USER}`,
    `listen = ${PHP_SOCKET}`,
    "listen.owner = www-data",
    "listen.group = www-data",
    "listen.mode = 0660",
    "pm = ondemand",
    "pm.max_children = 5",
    "EOF",
    `systemctl restart php${PHP_VERSION}-fpm`,
    "a2enmod -q proxy_fcgi setenvif rewrite headers ssl > /dev/null",
    "a2dissite -q 000-default > /dev/null",
    ...input.sites.flatMap(vhost),
    ...input.sites.map((site) => `a2ensite -q ${site.conf} > /dev/null`),
    "apache2ctl configtest",
    "systemctl reload apache2",
    `mysql -e "CREATE DATABASE IF NOT EXISTS ${DATABASE}; CREATE USER IF NOT EXISTS '${DATABASE}'@'localhost' IDENTIFIED BY '${input.dbPassword}'; GRANT ALL ON ${DATABASE}.* TO '${DATABASE}'@'localhost';"`,
  ].join("\n");
}
