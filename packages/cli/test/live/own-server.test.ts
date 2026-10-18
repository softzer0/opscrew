/** The live test on a server the user already owns (docs/e2e.md, "Your own server"). */
import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  type CloudflareZone,
  canConnect,
  httpRequest,
  minutes,
  resolveIpv4,
  sleep,
  waitFor,
  waitForAccessRefusal,
} from "./cloud";
import { LiveRun, secondAppSkip, serverSettings } from "./harness";
import {
  addressLinesOutsidePurpose,
  approveHashes,
  duration,
  failedInitChecks,
  leakedLabels,
  missingVariables,
  printedHash,
  SERVER_E2E_VARIABLES,
  splitCommand,
  ufwRulesBeyondSsh,
  webListenersBeyondIpv4,
} from "./support";

const MISSING = missingVariables(process.env, "OPSCREW_E2E_OWN_SERVER", SERVER_E2E_VARIABLES);
const SETTINGS = serverSettings(process.env, "OPSCREW_E2E_OWN_SERVER_TYPE");
/** Why the second app's steps (6b, 7b) are skipped, if they are. */
const SECOND_SKIP = secondAppSkip(SETTINGS);

if (MISSING.length > 0 && process.env.OPSCREW_E2E_OWN_SERVER === "1") {
  console.warn(
    `OpsCrew E2E (own server): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Your own server").`,
  );
}
if (MISSING.length === 0 && SECOND_SKIP !== undefined) {
  console.warn(`OpsCrew E2E (own server): the second app's steps are skipped: ${SECOND_SKIP}.`);
}

const PORTAINER_PORTS = [9443, 9000, 8000];
/** The tunnel's and the Access service token's secrets, for the leak search. */
const TUNNEL_OUTPUTS = [
  "tunnel_token",
  "deploy_service_token_client_secret",
  "deploy_service_token_client_id",
];
/** SC-901: a deploy on the user's own server takes under 20 minutes from `opscrew init`. */
const INIT_TO_DEPLOY_TARGET_MS = 20 * 60_000;

type Serve = "dns-only" | "proxy" | "tunnel";

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live end-to-end on your own server (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live end-to-end on your own server: examples/${SETTINGS.app} on a throwaway Hetzner server`,
  () => {
    const run = new LiveRun({ label: "own server", name: "own", settings: SETTINGS });
    const { log, scrubber } = run;
    const { appHost } = run;
    /** The second app, B, on its own server (steps 6b and 7b), when its steps run. */
    const b = run.second();
    const second = () => b as LiveRun;
    let fingerprint = "";
    let ipv6Route = false;
    let tunnel: ChildProcess | undefined;

    /** The server's addresses this computer can try (IPv6 only with a route). */
    const ownAddresses = () => [
      run.ipv4(),
      ...(ipv6Route && run.server?.ipv6 !== undefined ? [run.server.ipv6] : []),
    ];

    /** Interview (own server, root, the test key, `serve`) then design, for `app` (A by default). */
    async function answerAndDesign(serve: Serve, hostKey?: string, app = run): Promise<void> {
      const answers = join(app.work, "answers.json");
      await writeFile(
        answers,
        JSON.stringify({
          provider: "own",
          expectedMonthlyUsers: "<1k",
          budgetMonthly: 20,
          uptime: "best-effort",
          dataCriticality: "important",
          dnsProvider: "cloudflare",
          domain: app.appHost,
          keepExternalServices: [],
          "server.host": app.ipv4(),
          "server.port": 22,
          "server.user": "root",
          "server.key": app.keyFile,
          "server.reachable": true,
          "server.serve": serve,
        }),
      );
      await app.opscrewOk("interview", "--answers", answers);
      await app.opscrewOk("design", ...(hostKey === undefined ? [] : ["--host-key", hostKey]));
      const plan = await app.readPlan();
      if (plan.target.provider !== "own") {
        throw new Error(`design planned ${plan.target.provider}, not the user's own server.`);
      }
    }

    /** Waits until the app's domain resolves (through 1.1.1.1) to its server or to Cloudflare. */
    async function waitForDns(direct: boolean, app = run): Promise<void> {
      const where = direct ? "at the server" : "at Cloudflare";
      log(`waiting for ${app.appHost} to point ${where} (up to 10 minutes)`);
      await waitFor(`${app.appHost} pointing ${where}`, minutes(10), async () => {
        const addresses = await resolveIpv4(app.appHost);
        if (addresses.length === 0) return undefined;
        return addresses.includes(app.ipv4()) === direct ? true : undefined;
      });
    }

    /** Every address/port pair of the server's own addresses that accepts a TCP connection. */
    async function answering(ports: readonly number[], timeoutMs = 5_000): Promise<string[]> {
      const open: string[] = [];
      for (const address of ownAddresses()) {
        for (const port of ports) {
          if (await canConnect(address, port, timeoutMs)) {
            open.push(`${address.includes(":") ? "IPv6" : "IPv4"} port ${port}`);
          }
        }
      }
      return open;
    }

    async function expectNotAnswering(ports: readonly number[], why: string): Promise<void> {
      if (!ipv6Route)
        log("this computer has no IPv6 route: the server's IPv6 address is not tried");
      const open = await answering(ports);
      expect(open, `the server's own address answers on ${open.join(", ")} (${why})`).toEqual([]);
    }

    /**
     * `destroy --confirm <app> --undo-host`, then again with `--approve <undo host plan hash>` until
     * it exits 0 (at most three runs, each hash approved once).
     */
    async function destroyUndoHost(app: LiveRun): Promise<void> {
      let approve: string[] = [];
      const tried: string[] = [];
      for (let attempt = 1; ; attempt++) {
        const result = await app.opscrew(
          "destroy",
          "--confirm",
          app.app(),
          "--undo-host",
          ...approve,
        );
        if (result.exitCode === 0) break;
        const hash = printedHash(result.output, "Host plan hash");
        if (hash === undefined || tried.includes(hash) || attempt >= 3) {
          throw new Error(
            `opscrew destroy --undo-host exited with ${result.exitCode}:\n${run.tail(result.output)}`,
          );
        }
        tried.push(hash);
        log(`approving the undo host plan ${hash}`);
        approve = ["--approve", hash];
      }
      app.destroyed = true;
    }

    // -------------------------------------------------------------------------------------------

    run.step(
      "1. creates a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} on your own server`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        ipv6Route = await canConnect("2606:4700:4700::1111", 443, 5_000);
        log(
          ipv6Route
            ? "this computer has an IPv6 route: the server's IPv6 address is probed too"
            : "this computer has no IPv6 route: probes of the server's IPv6 address are skipped",
        );
        fingerprint = await run.createServer();
      },
    );

    run.step(
      "2. DNS only: init, interview, design, adapt, provision, deploy, verify, secure and drift",
      minutes(75),
      async () => {
        // SC-901 measures from `opscrew init`, which a user runs first.
        const initStarted = Date.now();
        const first = await run.initFix();
        // Before the interview only the provider check may fail: no cloud token is set, and its
        // hint says that a server the user already has needs none.
        const failed = failedInitChecks(first.output);
        if (
          ![0, 1].includes(first.exitCode) ||
          failed.some((title) => title !== "Cloud provider token") ||
          (failed.length > 0 && !first.output.includes("a server you already have"))
        ) {
          throw new Error(
            `opscrew init failed before the interview (exit ${first.exitCode}):\n${run.tail(first.output)}`,
          );
        }
        await run.opscrewOk("analyze", "--no-ai");
        await answerAndDesign("dns-only", fingerprint);
        // Now the provider check looks at the recorded SSH login, and everything passes.
        await run.opscrewOk("init");
        const plan = await run.readPlan();
        run.appName = plan.app.name;
        expect(plan.dns.provider, "DNS on Cloudflare").toBe("cloudflare");
        expect(plan.dns.proxied, "DNS only: the record is not proxied").toBe(false);
        await run.snapshotCloudflare((zone) => [
          appHost,
          `www.${appHost}`,
          `ssh-${run.app()}.${zone.name}`,
          `portainer.${appHost}`,
        ]);
        await run.seedUserRules();

        await run.adaptAndMerge();
        await run.provisionUntilDone("DNS only");
        await run.expectSharedCloudflare("the DNS-only provision");
        await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
        await run.rememberSecretFile(run.paths().files.statePassphrase, "state-passphrase");
        await run.deployAny("the first deploy, DNS only");

        await waitForDns(true);
        await run.waitForHealth(minutes(10), false);
        await run.opscrewOk("verify");
        const took = Date.now() - initStarted;
        const target = `under ${INIT_TO_DEPLOY_TARGET_MS / 60_000} minutes`;
        log(`init to a verified DNS-only deploy took ${duration(took)} (SC-901: ${target})`);
        if (took >= INIT_TO_DEPLOY_TARGET_MS) {
          // A finding fails the run at the end (step 8), so the later steps still run.
          run.findings.push(
            `init to a verified DNS-only deploy took ${duration(took)}, not ${target} (SC-901)`,
          );
        }
        const secure = await run.opscrewOk("secure");
        expect(
          secure.output.includes("SECURITY_REPORT.md"),
          `secure wrote its report:\n${run.tail(secure.output)}`,
        ).toBe(true);
        await run.opscrewOk("drift");
        await run.shell().ok("true");
        log("DNS only: deployed, verified, secured, drift-free; root still logs in with its key");
      },
    );

    run.step("3. re-running provision shows no changes", minutes(20), async () => {
      const planned = await run.opscrewOk("provision", "--plan-only", "--yes");
      expect(
        approveHashes(planned.output),
        `nothing to approve:\n${run.tail(planned.output)}`,
      ).toEqual([]);
      expect(
        /Nothing to apply/.test(planned.output),
        `nothing to apply:\n${run.tail(planned.output)}`,
      ).toBe(true);
    });

    run.step(
      "4. Portainer: unreachable from outside, working through the printed SSH tunnel",
      minutes(30),
      async () => {
        const planned = await run.opscrewOk("portainer", "enable", "--plan-only", "--yes");
        const hashes = approveHashes(planned.output);
        expect(
          hashes.length,
          `portainer enable planned something:\n${run.tail(planned.output)}`,
        ).toBeGreaterThan(0);
        await run.opscrewOk(
          "portainer",
          "enable",
          ...hashes.flatMap((hash) => ["--approve", hash]),
          "--yes",
        );

        const status = JSON.parse(
          (await run.opscrewOk("portainer", "status", "--json")).stdout,
        ) as {
          enabled: boolean;
          localUrl: string;
          tunnelCommand?: string;
          passwordFile: string;
          passwordFileExists: boolean;
        };
        expect(status.enabled, "Portainer is on").toBe(true);
        expect(status.passwordFileExists, "the password file is on this computer").toBe(true);
        const password = (await readFile(status.passwordFile, "utf8")).trim();
        scrubber.add(password, "portainer-password");

        await expectNotAnswering(PORTAINER_PORTS, "Portainer must listen on the server only");

        const command = splitCommand(status.tunnelCommand ?? "");
        expect(command[0], "the printed tunnel command runs ssh").toBe("ssh");
        log("starting the printed SSH tunnel");
        let stderr = "";
        let exited: string | undefined;
        tunnel = spawn(
          "ssh",
          ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", ...command.slice(1)],
          { env: run.env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] },
        );
        tunnel.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        tunnel.once("exit", (code, signal) => {
          exited = `exit ${code ?? signal}`;
        });
        tunnel.once("error", (error) => {
          exited = error.message;
        });
        const sshSaid = () => stderr.trim().slice(-300) || "nothing";
        try {
          const local = (path: string) => new URL(path, status.localUrl).toString();
          log("waiting for Portainer through the tunnel (up to 3 minutes)");
          await waitFor(
            () => `Portainer through the tunnel (ssh said: ${sshSaid()})`,
            minutes(3),
            async () =>
              (await httpRequest(local("/api/system/status"), { insecure: true })).status === 200
                ? true
                : undefined,
            5_000,
            () =>
              exited === undefined
                ? undefined
                : `The SSH tunnel command ended (${exited}); ssh said: ${sshSaid()}`,
          );
          const admin = await httpRequest(local("/api/users/admin/check"), { insecure: true });
          expect(admin.status, "the admin account exists (204)").toBe(204);
          const login = await httpRequest(local("/api/auth"), {
            method: "POST",
            insecure: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "admin", password }),
          });
          expect(login.status, "admin logs in with the password OpsCrew generated").toBe(200);
          scrubber.add((JSON.parse(login.body) as { jwt?: string }).jwt, "portainer-session");
        } finally {
          tunnel.kill();
          tunnel = undefined;
        }
        log("Portainer: closed to the internet, working through the tunnel, admin set up");
      },
    );

    run.step(
      "5. the Cloudflare-only filter: proxied, closed on the server's addresses, also after a reboot",
      minutes(75),
      async () => {
        await answerAndDesign("proxy");
        const redesigned = await run.readPlan();
        expect(redesigned.dns.proxied, "the record is proxied").toBe(true);
        expect(
          redesigned.portainer?.enabled,
          "re-running the interview and design keeps Portainer on",
        ).toBe(true);
        await run.provisionUntilDone("the Cloudflare-only filter");
        await run.expectSharedCloudflare("the switch to the Cloudflare-only filter");
        await run.deployAny("the Cloudflare-only filter");

        const portainer = JSON.parse(
          (await run.opscrewOk("portainer", "status", "--json")).stdout,
        ) as { enabled: boolean };
        expect(portainer.enabled, "Portainer is still on after the switch to the filter").toBe(
          true,
        );

        await waitForDns(false);
        await run.waitForHealth();
        await expectNotAnswering([80, 443], "only Cloudflare may reach the web ports");
        const listeners = webListenersBeyondIpv4(await run.shell().ok("ss -ltnuH"));
        expect(listeners, "nothing listens on IPv6 (or every address) on 80/443").toEqual([]);
        await run.opscrewOk("verify");

        const bootId = await run.shell().ok("cat /proc/sys/kernel/random/boot_id");
        log(
          "rebooting the server; probing its own addresses until the site answers again (up to 15 minutes)",
        );
        await run.shell().run("systemctl reboot", 30_000);
        const deadline = Date.now() + minutes(15);
        let rebooted = false;
        for (;;) {
          const open = await answering([80, 443], 3_000);
          expect(
            open,
            `while the server started, its own address answered on ${open.join(", ")}`,
          ).toEqual([]);
          if (!rebooted) {
            const boot = await run.shell().run("cat /proc/sys/kernel/random/boot_id", 30_000);
            rebooted = boot.exitCode === 0 && boot.stdout.trim() !== bootId;
            if (rebooted) log("the server is back up; waiting for the site through Cloudflare");
          } else {
            const answer = await httpRequest(await run.healthUrl()).catch(() => undefined);
            if (answer?.status === 200 && answer.headers["cf-ray"] !== undefined) break;
          }
          if (Date.now() > deadline) {
            throw new Error(
              rebooted
                ? "The site did not answer within 15 minutes of the reboot."
                : "The server did not come back within 15 minutes.",
            );
          }
          await sleep(3_000);
        }
        await expectNotAnswering([80, 443], "the filter is back after the reboot");
        expect(
          webListenersBeyondIpv4(await run.shell().ok("ss -ltnuH")),
          "after the reboot, still IPv4 only",
        ).toEqual([]);
        // On the server: the filter unit is active and became active no later than Docker.
        const filterActive = await run
          .shell()
          .run("systemctl is-active opscrew-web-filter.service");
        expect(filterActive.stdout.trim(), "opscrew-web-filter.service is active").toBe("active");
        const activeSince = async (unit: string) =>
          Number(
            await run.shell().ok(`systemctl show -p ActiveEnterTimestampMonotonic --value ${unit}`),
          );
        const filterAt = await activeSince("opscrew-web-filter.service");
        const dockerAt = await activeSince("docker.service");
        expect(
          filterAt > 0 && dockerAt > 0,
          `both units have started since the boot (filter ${filterAt}, docker ${dockerAt})`,
        ).toBe(true);
        expect(
          filterAt <= dockerAt,
          `the filter became active before Docker (filter ${filterAt}, docker ${dockerAt})`,
        ).toBe(true);
        await run.opscrewOk("drift");
        log(
          "Cloudflare-only filter: served through Cloudflare, closed on the server's own addresses, also after a reboot",
        );
      },
    );

    run.step(
      "6. the tunnel: only SSH open, served through the tunnel, a merged change deploys through Access",
      minutes(90),
      async () => {
        await answerAndDesign("tunnel");
        expect((await run.readPlan()).target, "tunnel mode").toMatchObject({
          provider: "own",
          access: "tunnel",
        });
        await run.provisionUntilDone("the tunnel");
        // A tunnel app is only in the probe block: its strict-TLS hostnames left OpsCrew's rule.
        await run.expectSharedCloudflare("the switch to the tunnel");
        await run.rememberOutputs(TUNNEL_OUTPUTS);
        await run.deployAny("the tunnel");

        const ufw = ufwRulesBeyondSsh(await run.shell().ok("ufw status"));
        expect(ufw.active, "ufw is active").toBe(true);
        expect(ufw.rules, "ufw status lists the SSH rule").toBeGreaterThan(0);
        expect(ufw.others, "ufw allows only SSH").toEqual([]);
        await waitForDns(false);
        await run.waitForHealth();
        await expectNotAnswering([80, 443], "the tunnel opens no web port");
        await run.opscrewOk("verify");
        await run.opscrewOk("drift");

        const sshHost = `ssh-${run.app()}.${(run.zone as CloudflareZone).name}`;
        const access = await waitForAccessRefusal(`https://${sshHost}/`);
        log(`${sshHost} refuses a request without the service token (${access})`);

        // A merged change deploys through the Access-protected SSH hostname: the workflow on main
        // connects to that hostname through `cloudflared access ssh` ...
        const workflow = await readFile(
          join(run.repo, (await run.readPlan()).cicd.workflowPath),
          "utf8",
        );
        expect(workflow.includes(sshHost), `the deploy workflow on main names ${sshHost}`).toBe(
          true,
        );
        expect(
          workflow.includes("cloudflared access ssh"),
          "the deploy workflow connects through `cloudflared access ssh`",
        ).toBe(true);
        const before = await run.shell().ok("stat -c %Y /srv/app/.env");
        const since = await run.shell().ok("date +%s");
        const branch = `e2e/change-${run.runId}`;
        const title = "e2e: a change deployed through the tunnel";
        await run.git("checkout", "-q", "-b", branch);
        await writeFile(
          join(run.repo, "opscrew-e2e-change.txt"),
          `Deployed through the tunnel by run ${run.runId}.\n`,
        );
        await run.git("add", "opscrew-e2e-change.txt");
        await run.git("commit", "-q", "-m", title);
        await run.git("push", "-q", "-u", "origin", branch);
        const number = await run.github.createPullRequest(title, branch);
        log(
          `merging the change #${number} and waiting for its deploy through the tunnel (up to 30 minutes)`,
        );
        const sha = await run.github.merge(number);
        await run.checkoutMain();
        const deployed = await run.github.waitForDeploy({ headSha: sha });
        expect(
          deployed.conclusion,
          `the change's deploy run ${deployed.id}: ${deployed.jobs.map((j) => `${j.name}=${j.conclusion}`).join(", ")}`,
        ).toBe("success");
        const after = await run.shell().ok("stat -c %Y /srv/app/.env");
        expect(Number(after) > Number(before), "the deploy wrote the server's .env again").toBe(
          true,
        );
        // ... and on the server, the deploy user's logins came from the tunnel connector (local).
        const sshLog = await run
          .shell()
          .ok(`journalctl -u ssh -u sshd --since @${since} --no-pager -o cat`);
        const logins = sshLog
          .split(/\r?\n/)
          .filter((line) => /Accepted publickey for deploy from /.test(line));
        expect(
          logins.length,
          "sshd logged the deploy user's logins during the deploy",
        ).toBeGreaterThan(0);
        expect(
          logins.every((line) => / from (127\.0\.0\.1|::1) port /.test(line)),
          `every deploy login came through cloudflared on the server (${logins.length} logins; from: ${[
            ...new Set(logins.map((line) => / from (\S+) port /.exec(line)?.[1] ?? "?")),
          ].join(", ")})`,
        ).toBe(true);
        await run.waitForHealth(minutes(5));
        log(
          "tunnel: only SSH open, the site served through the tunnel, a merged change deployed through Access",
        );
      },
    );

    run.step(
      "6b. a second app on its own throwaway server, in tunnel mode, in the same zone and account: both blocked on /.env, both in OpsCrew's probe block",
      minutes(75),
      async () => {
        const app = second();
        await app.prepareRepo({
          commit: `e2e: a second app (examples/${SETTINGS.app}) on your own server`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        const hostKey = await app.createServer();
        await app.initFix();
        await app.opscrewOk("analyze", "--no-ai");
        await answerAndDesign("tunnel", hostKey, app);
        const plan = await app.readPlan();
        expect(plan.target, "the second app in tunnel mode").toMatchObject({
          provider: "own",
          access: "tunnel",
        });
        app.appName = plan.app.name;
        await app.snapshotCloudflare((zone) => [
          app.appHost,
          `www.${app.appHost}`,
          `ssh-${app.app()}.${zone.name}`,
        ]);
        await app.adaptAndMerge();
        await app.provisionUntilDone("the second app, tunnel");
        // Both tunnel apps are in OpsCrew's probe block, neither in its strict-TLS rule.
        await run.expectSharedCloudflare("the second app's provision");
        await app.rememberSecretFile(app.paths().files.deployKey, "deploy-private-key");
        await app.rememberSecretFile(app.paths().files.statePassphrase, "state-passphrase");
        await app.rememberOutputs(TUNNEL_OUTPUTS);
        await app.deployAny("the second app");
        await waitForDns(false, app);
        await app.waitForHealth();
        await app.opscrewOk("verify");
        await run.expectProbeBlocked(appHost);
        await run.expectProbeBlocked(app.appHost);
        log(
          "second app: served through its own tunnel in the same zone and account; both apps' /.env blocked",
        );
      },
      { skip: SECOND_SKIP },
    );

    run.step(
      "7. destroy --undo-host removes the app, DNS, tunnel and Access; root still logs in; the second app keeps working",
      minutes(30),
      async () => {
        const name = run.app();
        await destroyUndoHost(run);
        await run.expectCloudflareClean();
        await run.expectSharedCloudflare("the first app's destroy");
        if (b?.appName !== undefined) {
          // SC-1102: the second app's tunnel, probe block and Access login still work.
          await b.waitForHealth(minutes(5));
          await run.expectProbeBlocked(b.appHost);
          const sshHost = `ssh-${b.app()}.${(run.zone as CloudflareZone).name}`;
          const access = await waitForAccessRefusal(`https://${sshHost}/`);
          log(
            `the second app still answers through its tunnel, its /.env is blocked and ${sshHost} refuses a request without the service token (${access})`,
          );
        }

        await run.shell().ok("true");
        const containers = await run
          .shell()
          .ok(`docker ps -aq --filter label=com.docker.compose.project=${name}`);
        expect(containers, "no container of the app is left").toBe("");
        const deployUser = await run.shell().run("id -u deploy");
        expect(deployUser.exitCode, "the deploy user is removed").not.toBe(0);
        log(
          "destroy --undo-host: app, DNS, tunnel and Access removed; root still logs in with its key",
        );
      },
    );

    run.step(
      "7b. destroying the second app removes OpsCrew's shared rules; the seeded rules and the Zero Trust pieces stay",
      minutes(30),
      async () => {
        const app = second();
        await destroyUndoHost(app);
        await app.expectCloudflareClean();
        await run.expectSharedCloudflare("the second app's destroy");
        log(
          "second app destroyed: OpsCrew's shared rules list nothing of this run, the zone's own rules and the Zero Trust pieces are as they were",
        );
      },
      { skip: SECOND_SKIP },
    );

    run.step(
      "8. no server address or secret in commits, pull requests, CLI output, OpsCrew's Cloudflare record or the audit log",
      minutes(10),
      async () => {
        if (!run.repoReady) return;
        const known = scrubber.entries();
        const secrets = known.filter(({ label }) => !label.startsWith("server-"));
        const problems: string[] = [];
        for (const { kind, where, text } of await run.leakSources()) {
          const found = leakedLabels(text, kind === "audit log" ? secrets : known);
          if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
        }
        problems.push(...run.sharedPlanLeaks(known, true));
        // The CLI shows the server's address on purpose only in the Portainer tunnel command and
        // in messages about "your server at <address>"; anywhere else in its output it is a leak.
        const addresses = known
          .filter(({ label }) => label.startsWith("server-"))
          .map(({ value }) => value);
        for (const [label, output] of run.outputs) {
          const found = leakedLabels(output, secrets);
          if (found.length > 0) problems.push(`${label} printed: ${found.join(", ")}`);
          const lines = addressLinesOutsidePurpose(output, addresses);
          if (lines > 0) problems.push(`${label} printed the server's address on ${lines} line(s)`);
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    run.registerCleanup({ first: () => tunnel?.kill() });
  },
);
