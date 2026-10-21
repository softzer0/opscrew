/**
 * The live test of the nginx edge on a server the user already owns (feature 014, docs/e2e.md
 * "Your own server with nginx"): certbot's first certificate and a forced renewal under load, an
 * addition served, testssl.sh through nginx, a second app on the same edge and a different proxy
 * refused while both are there, origin TLS on nginx behind Cloudflare's proxy, a switch to Caddy
 * and back within the stated interruption, and a destroy that removes the certificates.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAA_ISSUERS,
  EDGE_DIR,
  EDGE_PROJECT,
  type EdgeProxy,
  siteHosts,
} from "@opscrew/iac-templates";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { underLoad } from "./builder-checks";
import { type CloudflareZone, minutes, resolveIpv4, servedCertificate, waitFor } from "./cloud";
import { LiveRun, localLeakSources, serverSettings } from "./harness";
import {
  addressLinesOutsidePurpose,
  leakedLabels,
  missingVariables,
  printedHash,
  SERVER_E2E_VARIABLES,
} from "./support";
import {
  DEEP_TARGET_MS,
  interruptionOf,
  originCheck,
  readTlsRecord,
  requireDocker,
  secureDeep,
} from "./tls-checks";
import { caaAt, cloudflareSideProblems, tlsLeft, tlsLeftText } from "./tls-support";

const MISSING = missingVariables(process.env, "OPSCREW_E2E_OWN_NGINX", SERVER_E2E_VARIABLES);
const SETTINGS = serverSettings(process.env, "OPSCREW_E2E_OWN_SERVER_TYPE");
/** The second app on the same edge (steps 6 and 7). */
const SECOND_APP = "express-api";
/** The addition the test commits (an exact-match location that answers by itself). */
const ADDITION_PATH = "/opscrew-e2e-addition";
const ADDITION_BODY = "served by the addition";
/** The same addition in each proxy's syntax. */
const ADDITIONS: Record<EdgeProxy, string> = {
  nginx: `location = ${ADDITION_PATH} {\n    return 200 "${ADDITION_BODY}";\n}\n`,
  caddy: `handle ${ADDITION_PATH} {\n\trespond "${ADDITION_BODY}" 200\n}\n`,
};
/**
 * The interruption a switch of the proxy may cause for a proxied hostname (the plan states "a few
 * seconds"; research R5).
 */
const SWITCH_BOUND_MS = 15_000;

if (MISSING.length > 0 && process.env.OPSCREW_E2E_OWN_NGINX === "1") {
  console.warn(
    `OpsCrew E2E (own server, nginx): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Your own server with nginx").`,
  );
}

type Serve = "dns-only" | "proxy";

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live end-to-end of the nginx edge on your own server (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live end-to-end of the nginx edge on your own server: examples/${SETTINGS.app} and examples/${SECOND_APP}`,
  () => {
    const run = new LiveRun({ label: "own server, nginx", name: "nginx", settings: SETTINGS });
    const { log, scrubber } = run;
    const b = run.second(SECOND_APP);
    let fingerprint = "";

    /** The recovery copy's key file of `app` (outside its repository and OpsCrew's folder). */
    const keyFile = (app: LiveRun) => join(app.work, "age-key.txt");
    const copies = (app: LiveRun) => join(app.work, "copies");

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
          keepExternalServices: { s3: false },
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
    }

    /** Sets `target.edge` in the app's `opscrew/plan.yaml`, as the guide says. */
    async function setEdge(edge: EdgeProxy, app = run): Promise<void> {
      const plan = await app.readPlan();
      if (plan.target.provider !== "own") throw new Error("design did not plan the own server.");
      await writeArtifact("plan", join(app.repo, "opscrew/plan.yaml"), {
        ...plan,
        target: { ...plan.target, edge },
      });
    }

    /**
     * Writes the addition in `edge`'s syntax and deletes the other proxy's file, as OpsCrew asks
     * before a switch; with `push`, commits and pushes it, since the deploy takes it from `main`.
     */
    async function writeAddition(edge: EdgeProxy, push: boolean): Promise<void> {
      const dir = join(run.repo, "opscrew/proxy");
      await mkdir(dir, { recursive: true });
      await rm(join(dir, `additions.${edge === "nginx" ? "caddy" : "nginx"}`), { force: true });
      await writeFile(join(dir, `additions.${edge}`), ADDITIONS[edge]);
      if (push) {
        await run.git("add", "-A", "opscrew/proxy");
        await run.git("commit", "-q", "-m", `e2e: the addition for ${edge}`);
        await run.git("push", "-q", "origin", "main");
      }
    }

    /** Waits until the addition answers on the app's hostname, with OpsCrew's headers. */
    async function expectAddition(): Promise<void> {
      const url = `https://${run.appHost}${ADDITION_PATH}`;
      const answer = await waitFor(`${url} answering`, minutes(5), async () => {
        const got = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        const body = await got.text();
        return got.status === 200 && body.includes(ADDITION_BODY) ? got : undefined;
      });
      expect(
        answer.headers.get("strict-transport-security"),
        "the addition's location keeps OpsCrew's HSTS header",
      ).toBeTruthy();
      expect(answer.headers.get("x-content-type-options"), "and nosniff").toBe("nosniff");
    }

    /** The proxy the server's edge runs, from the stamp in its Compose file. */
    async function serverProxy(): Promise<string> {
      return run.shell().ok(`sed -n 's/^x-opscrew-edge-proxy: *//p' ${EDGE_DIR}/compose.yaml`);
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

    /** The first setup of `app`, DNS only with nginx, up to a verified deploy. */
    async function setUp(app: LiveRun, what: string): Promise<void> {
      await app.initFix();
      await app.opscrewOk("analyze", "--no-ai");
      await answerAndDesign("dns-only", fingerprint, app);
      await setEdge("nginx", app);
      const plan = await app.readPlan();
      app.appName = plan.app.name;
      expect(plan.dns.proxied, `${what}: DNS only`).toBe(false);
      await app.snapshotCloudflare((zone) => [
        app.appHost,
        `www.${app.appHost}`,
        `ssh-${app.app()}.${zone.name}`,
        `portainer.${app.appHost}`,
      ]);
      // The recovery copy: its first key to a file of the test's own, the copy to a folder too
      // (a public repository gets no committed copy in a script).
      await mkdir(copies(app), { recursive: true });
      await app.opscrewOk("secrets", "folder", copies(app));
      app.provisionFlags = ["--key-out", keyFile(app)];
      await app.adaptAndMerge();
      await app.provisionUntilDone(what);
      await app.rememberSecretFile(app.paths().files.deployKey, "deploy-private-key");
      await app.rememberSecretFile(app.paths().files.statePassphrase, "state-passphrase");
      await app.rememberGeneratedValues();
      await app.deployAny(what);
      await waitForDns(true, app);
      await app.waitForHealth(minutes(10), false);
      await app.opscrewOk("verify");
      const certificate = await servedCertificate(app.appHost);
      expect(certificate.issuer, `${what}: certbot's certificate is Let's Encrypt's`).toMatch(
        /Let's Encrypt/,
      );
      const records = await app.cloudflare.zoneRecords(app.zone as CloudflareZone);
      expect(caaAt(records, app.appHost), `${what}: the CAA records for nginx`).toEqual(
        CAA_ISSUERS.nginx.map((issuer) => ({ issuer, opscrew: true })),
      );
    }

    /** `destroy --confirm <app>` with `flags`, then with `--approve <host plan hash>` (at most 3 runs). */
    async function destroyApp(app: LiveRun, flags: readonly string[]): Promise<void> {
      let approve: string[] = [];
      const tried: string[] = [];
      for (let attempt = 1; ; attempt++) {
        const result = await app.opscrew("destroy", "--confirm", app.app(), ...flags, ...approve);
        if (result.exitCode === 0) break;
        const hash = printedHash(result.output, "Host plan hash");
        if (hash === undefined || tried.includes(hash) || attempt >= 3) {
          throw new Error(
            `opscrew destroy ${flags.join(" ")} exited with ${result.exitCode}:\n${run.tail(result.output)}`,
          );
        }
        tried.push(hash);
        approve = ["--approve", hash];
      }
      app.destroyed = true;
    }

    // -------------------------------------------------------------------------------------------

    run.step(
      "1. creates a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        await requireDocker("This test");
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} behind nginx on your own server`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        fingerprint = await run.createServer();
      },
    );

    run.step(
      "2. nginx, DNS only: certbot's first certificate during the first deploy, CAA for Let's Encrypt, verify, secure and drift",
      minutes(75),
      async () => {
        await setUp(run, "the first app, DNS only");
        expect(await serverProxy(), "the edge runs nginx").toBe("nginx");
        await run.opscrewOk("secure");
        await run.opscrewOk("drift");
      },
    );

    run.step("3. an addition is served, with OpsCrew's headers", minutes(45), async () => {
      await writeAddition("nginx", true);
      await run.provisionUntilDone("the addition");
      await run.deployAny("the addition");
      await expectAddition();
      log("the addition is served with OpsCrew's headers");
    });

    run.step(
      "4. a forced certbot renewal under load: no failed request, and nginx serves the new certificate",
      minutes(30),
      async () => {
        const before = await servedCertificate(run.appHost);
        const certbot = `$(docker ps -q --filter label=com.docker.compose.project=${EDGE_PROJECT} --filter label=com.docker.compose.service=certbot)`;
        // The loop's own command, with its folders: certbot runs as a user who cannot write
        // certbot's default ones.
        const renew = certbotRenew(await run.shell().ok(`cat ${EDGE_DIR}/compose.yaml`));
        await underLoad([await run.healthUrl()], "a forced renewal", log, async () => {
          await run
            .shell()
            .ok(
              `docker exec ${certbot} ${renew} --force-renewal --cert-name ${run.app()}`,
              minutes(5),
            );
          await waitFor("nginx serving the renewed certificate", minutes(3), async () =>
            (await servedCertificate(run.appHost)).serial !== before.serial ? true : undefined,
          );
        });
        log(
          "certbot renewed the certificate; nginx reloaded and serves it, with no failed request",
        );
      },
    );

    run.step(
      "5. secure --deep through nginx: no high finding from testssl.sh, ssh-audit's policy, Lynis",
      minutes(20),
      async () => {
        const took = await secureDeep(
          (...args) => run.opscrew(...args),
          run.paths().files.securityReport,
          { ran: ["lynis", "ssh-audit", "testssl"] },
          (text) => run.tail(text),
        );
        log(`opscrew secure --deep took ${Math.round(took / 1000)} s`);
        if (took > DEEP_TARGET_MS) {
          run.findings.push(
            `opscrew secure --deep took ${Math.round(took / 1000)} s, over 5 minutes`,
          );
        }
      },
    );

    run.step(
      "6. a second app on the same nginx edge; another proxy for the first app is refused while both are there",
      minutes(75),
      async () => {
        await b.prepareRepo({
          commit: `e2e: a second app (examples/${SECOND_APP}) behind nginx on your own server`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        b.useServerOf(run);
        await setUp(b, "the second app, DNS only");
        await run.waitForHealth(minutes(5), false);
        const planFile = join(run.repo, "opscrew/plan.yaml");
        const kept = await readFile(planFile, "utf8");
        // The addition in Caddy's syntax first, as OpsCrew asks, so that the refusal is the shared
        // proxy's.
        await writeAddition("caddy", false);
        await setEdge("caddy");
        const refused = await run.opscrew(
          "provision",
          "--plan-only",
          ...run.provisionFlags,
          "--yes",
        );
        await writeFile(planFile, kept);
        await writeAddition("nginx", false);
        expect(refused.exitCode, "provision refuses another proxy for the first app").not.toBe(0);
        expect(
          refused.output.includes("which every OpsCrew app on it shares") &&
            refused.output.includes("Nothing was changed"),
          `the refusal says the proxy is shared:\n${run.tail(refused.output)}`,
        ).toBe(true);
        expect(await serverProxy(), "the edge still runs nginx").toBe("nginx");
        log("both apps behind one nginx; another proxy was refused before any change");
      },
    );

    run.step(
      "7. destroying the second app leaves the first one answering",
      minutes(30),
      async () => {
        await destroyApp(b, []);
        await b.expectCloudflareClean();
        await run.waitForHealth(minutes(5), false);
      },
    );

    run.step(
      "8. origin TLS on nginx behind Cloudflare's proxy: Cloudflare's side, the check from the server, secure",
      minutes(75),
      async () => {
        await answerAndDesign("proxy");
        const plan = await run.readPlan();
        expect(plan.dns.proxied, "the record is proxied").toBe(true);
        expect("edge" in plan.target && plan.target.edge, "design kept nginx").toBe("nginx");
        await run.provisionUntilDone("origin TLS on nginx");
        await run.deployAny("origin TLS on nginx");
        await waitForDns(false);
        await run.waitForHealth();
        await run.rememberGeneratedValues();
        const hosts = siteHosts(plan);
        expect(
          cloudflareSideProblems(
            await run.cloudflare.zoneTls(run.zone as CloudflareZone, hosts),
            await readTlsRecord(run.paths()),
            hosts,
          ),
          "the app's origin TLS at Cloudflare",
        ).toEqual([]);
        const origin = await originCheck((c) => run.shell().run(c), hosts, "nginx", log);
        run.findings.push(...origin.findings);
        expect(origin.problems, "the origin check from the server").toEqual([]);
        await run.opscrewOk("secure");
        await run.opscrewOk("drift");
      },
    );

    run.step(
      "9. with one app left, a switch to Caddy and back, each within the stated interruption",
      minutes(90),
      async () => {
        for (const edge of ["caddy", "nginx"] as const) {
          await writeAddition(edge, true);
          await setEdge(edge);
          const provisioned = await run.provisionUntilDone(`the switch to ${edge}`);
          expect(
            provisioned.includes("switches the server's proxy from"),
            `the plan states the switch to ${edge} and its interruption`,
          ).toBe(true);
          const load = await interruptionOf(await run.healthUrl(), () =>
            run.deployAny(`the switch to ${edge}`),
          );
          log(
            `the switch to ${edge}: ${load.failed} of ${load.sent} requests failed, the longest interruption ${Math.round(load.longestMs / 100) / 10} s`,
          );
          expect(
            load.longestMs,
            `the interruption of the switch to ${edge} (a few seconds for a proxied hostname)`,
          ).toBeLessThanOrEqual(SWITCH_BOUND_MS);
          expect(await serverProxy(), `the edge runs ${edge}`).toBe(edge);
          await run.waitForHealth(minutes(5));
          await expectAddition();
          log(`the addition is served on ${edge}, with OpsCrew's headers`);
        }
      },
    );

    run.step(
      "10. destroy --undo-host revokes the origin certificate and removes the client certificate, its settings and the CAA records",
      minutes(30),
      async () => {
        const hosts = siteHosts(await run.readPlan());
        await destroyApp(run, ["--undo-host"]);
        await run.expectCloudflareClean();
        const zone = run.zone as CloudflareZone;
        const now = await run.cloudflare.zoneTls(zone, hosts);
        expect(
          tlsLeftText(tlsLeft(now, run.tlsBefore as typeof now, hosts)),
          "nothing of the app's origin TLS is left at Cloudflare",
        ).toEqual([]);
        expect(caaAt(await run.cloudflare.zoneRecords(zone), run.appHost)).toEqual([]);
        await run.shell().ok("true");
      },
    );

    run.step(
      "11. no secret, key or age identity in commits, pull requests, CLI output, plans, reports, state or the audit log",
      minutes(10),
      async () => {
        if (!run.repoReady) return;
        for (const app of [run, b].filter((item) => item.repoReady)) {
          if (!(await app.rememberSecretFile(keyFile(app), "age-identity"))) {
            run.findings.push(
              `the recovery copy's key file of ${app.appName ?? "an app"} was not written, so the leak search misses its age identity`,
            );
          }
        }
        const known = scrubber.entries();
        const secrets = known.filter(({ label }) => !label.startsWith("server-"));
        const problems: string[] = [];
        for (const { kind, where, text } of await run.leakSources()) {
          const found = leakedLabels(text, kind === "audit log" ? secrets : known);
          if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
        }
        for (const app of [run, b].filter((item) => item.repoReady)) {
          const folderCopy = join(copies(app), `${app.appName ?? ""}.sops.json`);
          for (const { where, text } of await localLeakSources(app.paths(), [folderCopy])) {
            const found = leakedLabels(text, secrets);
            if (found.length > 0)
              problems.push(`${where} (${app.appName}) contains: ${found.join(", ")}`);
          }
        }
        problems.push(...run.sharedPlanLeaks(known, true));
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

    run.registerCleanup();
  },
);

/** The loop's `certbot renew` command, with its folders, from the edge's Compose file. */
function certbotRenew(composeFile: string): string {
  const doc = parse(composeFile) as { services: { certbot?: { entrypoint?: string[] } } };
  const line = (doc.services.certbot?.entrypoint?.at(-1) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("certbot renew "));
  if (line === undefined) throw new Error("The edge's certbot service runs no `certbot renew`.");
  return line;
}
