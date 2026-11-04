/**
 * The live test of feature 020 (docs/e2e.md "Self-hosted monitoring", plan.md 15.), with
 * `OPSCREW_E2E_MONITORING=1`: `examples/nextjs-postgres` at Hetzner behind Cloudflare, in the
 * throwaway repository, deployed first. Then `addon enable monitoring` and `provision`: every
 * server's figures and logs in the stack within 2 minutes; the monitoring server's public ports;
 * a device (018's device container) reaching Grafana while the app's server can't, and the app's
 * server reaching the push paths while the device can't; through Grafana's API from the device,
 * every dashboard panel with data and no app secret in the stored lines; staging sending to the
 * same server; the owner's turn-off refused while staging sends, staging destroyed; monitoring
 * turned off and its server deleted after its typed name; destroy, leaving nothing; and the leak
 * search.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import { ADDON_PROJECTS } from "@opscrew/connector-ssh-host";
import { appDir, DASHBOARD_QUERIES, EDGE_PROJECT } from "@opscrew/iac-templates";
import {
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  MONITORING_SERVER,
  monitoringOf,
} from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { GrafanaApi, hasData, LOKI_MAX_LINES, logLines } from "../e2e/monitoring-support";
import {
  canConnect,
  DEPLOY_WORKFLOW,
  hetznerAppLeft,
  httpRequest,
  minutes,
  type RootShell,
  sleep,
  waitFor,
} from "./cloud";
import { AppEnvironments, designProd, opscrewUntilApproved } from "./environment-checks";
import { LiveRun, readGeneratedValues, serverSettings } from "./harness";
import {
  CLOSED_PORTS,
  grafanaAdminPassword,
  httpStatus,
  MONITORING_GATE,
  MONITORING_VARIABLES,
  planServers,
  SC_2001_MS,
  type ServerLabels,
  secretEnvValues,
  withoutData,
} from "./monitoring-support";
import {
  DeviceComputer,
  hetznerFirewall,
  hetznerServerExists,
  serverIpv4,
  serverShell,
  waitForDatabasePage,
} from "./split-checks";
import { leakedLabels, missingVariables } from "./support";

const MISSING = missingVariables(process.env, MONITORING_GATE, MONITORING_VARIABLES);
/** The default example: Postgres gives the stack its database figures. */
const SETTINGS = { ...serverSettings(process.env), app: "nextjs-postgres" };
const STAGING = "staging";
/** The device of step 5. */
const LAPTOP = "laptop";
/**
 * `$METHOD $URL` from the device with the authorization `$AUTH` and the JSON body `$BODY` when set
 * (values passed by name, never on a command line): prints the status, a newline and the answer's
 * body, or `0` when nothing answers.
 */
const DEVICE_REQUEST = `node -e '${[
  "const e = process.env;",
  "fetch(e.URL, {",
  "  method: e.METHOD,",
  '  headers: { ...(e.AUTH ? { authorization: e.AUTH } : {}), ...(e.BODY ? { "content-type": "application/json" } : {}) },',
  "  body: e.BODY || undefined,",
  "  signal: AbortSignal.timeout(30000),",
  '}).then(async (r) => process.stdout.write(r.status + "\\n" + (await r.text())), () => process.stdout.write("0\\n"));',
].join(" ")}'`;
/** The last five minutes, as a dashboard asks for them. */
const LAST_FIVE_MINUTES = { from: "now-5m", to: "now" };

/** `method url` from the device over its tunnel (`env`: `AUTH`, `BODY`): its status and body. */
async function deviceRequest(
  device: DeviceComputer,
  method: string,
  url: string,
  env: { AUTH?: string; BODY?: string } = {},
): Promise<{ status: number | undefined; body: string }> {
  const { stdout } = await device.exec(DEVICE_REQUEST, { URL: url, METHOD: method, ...env });
  const newline = stdout.indexOf("\n");
  const first = newline < 0 ? stdout : stdout.slice(0, newline);
  return { status: httpStatus(first), body: newline < 0 ? "" : stdout.slice(newline + 1) };
}

/**
 * The Docker pass's Grafana API, reached from the device at the monitoring server's private
 * `address` instead of from this computer, signed in as `admin` with `password`.
 */
class DeviceGrafana extends GrafanaApi {
  constructor(
    private readonly device: DeviceComputer,
    private readonly address: string,
    private readonly adminPassword: string,
  ) {
    super(MONITORING_GRAFANA_PORT, adminPassword);
  }

  override async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const auth = Buffer.from(`admin:${this.adminPassword}`).toString("base64");
    const { status, body } = await deviceRequest(
      this.device,
      init.method ?? "GET",
      `http://${this.address}:${this.port}${path}`,
      { AUTH: `Basic ${auth}`, ...(typeof init.body === "string" ? { BODY: init.body } : {}) },
    );
    if (status === undefined) throw new Error(`Grafana ${path} did not answer the device.`);
    return new Response(body, { status });
  }
}

if (process.env[MONITORING_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (self-hosted monitoring): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Self-hosted monitoring").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live self-hosted monitoring (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live self-hosted monitoring: examples/${SETTINGS.app} at Hetzner, with staging sending to its monitoring server`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "self-hosted monitoring",
      name: "monitoring",
      settings: SETTINGS,
      afterCli: () => remember(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const device = new DeviceComputer(run, envs, () => remember());
    const { log } = run;

    /** Every environment's server addresses, its extra servers' too, masked from now on. */
    async function remember(): Promise<void> {
      await envs.rememberServers();
      if (run.repo === "") return;
      for (const environment of envs.apps.keys()) {
        const record = await readServerAddresses(envs.paths(environment)).catch(() => undefined);
        for (const server of Object.values(record?.servers ?? {})) {
          run.scrubber.add(server.ipv4, "server-ipv4");
          run.scrubber.add(server.ipv6, "server-ipv6");
        }
      }
    }

    /** How many servers Hetzner lists with `app`'s labels. */
    async function serverCount(app: string): Promise<number> {
      const left = await hetznerAppLeft(SETTINGS.hcloudToken, app);
      return left.filter((item) => item.startsWith("servers ")).length;
    }

    /** The deploy workflow's file name of `environment`. */
    async function workflowOf(environment: string): Promise<string> {
      return posix.basename((await envs.readPlan(environment)).cicd.workflowPath);
    }

    /** The monitoring server's address on prod's private network. */
    async function monitoringAddress(): Promise<string> {
      const member = (await run.readPlan()).network?.members.find(
        (m) => m.name === MONITORING_SERVER,
      );
      if (member === undefined) throw new Error("The monitoring server is not on the network.");
      return member.address;
    }

    /** How many WireGuard interfaces the monitoring server has: one per network it is on. */
    async function wireguardInterfaces(): Promise<number> {
      const shell = await serverShell(run, envs, MONITORING_SERVER);
      return Number(await shell.ok("ip -o link show type wireguard | wc -l"));
    }

    /** The HTTP status of `method url` from the server `shell` logs in to; none: `undefined`. */
    async function serverHttp(
      shell: RootShell,
      method: string,
      url: string,
    ): Promise<number | undefined> {
      return httpStatus(
        await shell.ok(
          `curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X ${method} '${url}' || true`,
        ),
      );
    }

    /** The HTTP status of `method url` from the device, over its tunnel; none: `undefined`. */
    async function deviceHttp(method: string, url: string): Promise<number | undefined> {
      return (await deviceRequest(device, method, url)).status;
    }

    /**
     * Some HTTP traffic to the app, with 4xx answers, and one 502 from its edge: kamal-proxy stopped
     * for a moment on the app's server, so Caddy records a handler error, then started again.
     */
    async function httpTraffic(): Promise<void> {
      for (let i = 0; i < 20; i++) {
        await httpRequest(`https://${run.appHost}/${i % 4 === 0 ? "opscrew-e2e-missing" : ""}`, {
          timeoutMs: 10_000,
        }).catch(() => undefined);
      }
      const shell = await envs.shell();
      const proxy = await shell.ok(
        `docker ps -q --filter label=com.docker.compose.project=${EDGE_PROJECT} --filter label=com.docker.compose.service=kamal-proxy`,
      );
      if (proxy === "") throw new Error("The app's server runs no kamal-proxy in the edge.");
      await shell.ok(`docker stop ${proxy}`);
      try {
        await waitFor(
          "a 502 from the app's edge",
          minutes(1),
          async () => {
            const answer = await httpRequest(`https://${run.appHost}/`, { timeoutMs: 10_000 });
            return answer.status === 502 ? true : undefined;
          },
          3_000,
        );
      } finally {
        await shell.ok(`docker start ${proxy}`);
      }
      await run.waitForHealth();
    }

    /**
     * SC-2003: every `DASHBOARD_QUERIES` entry, with the dashboards' variables set to prod's app
     * server, answers with data through Grafana's query API from the device within 5 minutes (the
     * disk panels too, on a real server's disk). Each panel without data is a finding.
     */
    async function expectDashboardsFilled(grafana: DeviceGrafana): Promise<void> {
      const plan = await run.readPlan();
      const variables: Record<string, string> = {
        app: plan.app.name,
        env: plan.environment?.name ?? "prod",
        server: "app",
        service: ".+",
        search: "",
      };
      const query = (expr: string) =>
        expr.replace(
          /\$(app|env|server|service|search)\b/g,
          (_, name: string) => variables[name] ?? "",
        );
      const since = Date.now();
      const pending = new Map(DASHBOARD_QUERIES.map((q) => [q, "no answer yet"]));
      while (pending.size > 0 && Date.now() - since < minutes(5)) {
        for (const q of [...pending.keys()]) {
          try {
            const frames = await grafana.query(q.datasource, query(q.expr), LAST_FIVE_MINUTES);
            if (hasData(frames)) pending.delete(q);
            else pending.set(q, "no data");
          } catch (error) {
            pending.set(q, error instanceof Error ? error.message : String(error));
          }
        }
        if (pending.size > 0) await sleep(10_000);
      }
      log(
        `observed: ${DASHBOARD_QUERIES.length - pending.size} of ${DASHBOARD_QUERIES.length} dashboard queries had data ${Math.round((Date.now() - since) / 1000)} s after the traffic`,
      );
      for (const [q, why] of pending) {
        run.findings.push(`SC-2003: ${q.dashboard}, "${q.panel}" shows no data: ${why}`);
      }
    }

    /**
     * SC-2004: none of the app's secret values (OpsCrew's generated values, and the settings
     * `plan` marks secret in the app's `app.env` on its server) in the lines Loki stores of prod's
     * app since the run started, read through Grafana (at most `LOKI_MAX_LINES`), searched here,
     * never in the query. Counted, never printed: each value found is a finding by its name.
     */
    async function expectNoSecretsStored(grafana: DeviceGrafana): Promise<void> {
      const plan = await run.readPlan();
      const appEnv = await (await envs.shell()).ok(`cat ${appDir(plan)}/app.env`);
      const secrets = [
        ...((await readGeneratedValues(envs.paths())) ?? []).map((value) => ({
          name: "a generated value",
          value,
        })),
        ...secretEnvValues(appEnv, plan).map(({ name, value }) => ({
          name: `app.env's ${name}`,
          value,
        })),
      ];
      for (const { value } of secrets) run.scrubber.add(value, "app-secret");
      const lines = logLines(
        await grafana.query("loki", `{app="${plan.app.name}"}`, {
          from: String(run.startedAt.getTime()),
          to: "now",
        }),
      );
      log(
        `observed: ${secrets.length} secret values searched in ${lines.length} stored lines (at most ${LOKI_MAX_LINES})`,
      );
      if (lines.length === 0) run.findings.push("SC-2004: Loki gave no stored line to search");
      for (const { name, value } of secrets) {
        const count = lines.filter((line) => line.includes(value)).length;
        if (count > 0) run.findings.push(`SC-2004: ${name} is in ${count} stored log lines`);
      }
    }

    /**
     * Waits until prod's `addon status --json` shows figures and logs of every server of
     * `expected` (at most 5 minutes), and logs the time; over 2 minutes is a finding (SC-2001).
     */
    async function expectData(expected: readonly ServerLabels[], what: string): Promise<void> {
      const since = Date.now();
      let missing: string[] = [];
      await waitFor(
        () =>
          `every server's figures and logs in the stack (${what}); none yet from ${missing.join(", ")}`,
        minutes(5),
        async () => {
          const status = await run.opscrewOk("addon", "status", "--env", "prod", "--json");
          missing = withoutData(status.stdout, expected);
          return missing.length === 0 ? true : undefined;
        },
        15_000,
      );
      const seconds = Math.round((Date.now() - since) / 1000);
      log(`observed: every server's figures and logs in the stack ${seconds} s after ${what}`);
      if (Date.now() - since > SC_2001_MS) {
        run.findings.push(
          `SC-2001: every server's data took ${seconds} s after ${what}, over 2 minutes`,
        );
      }
    }

    run.step(
      "1. examples/nextjs-postgres at Hetzner behind Cloudflare, deployed",
      minutes(60),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} with self-hosted monitoring`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
          },
        });
        // Before any server: the device needs Docker with WireGuard here.
        await device.build();
        await envs.snapshotGithub();
        await designProd(run, envs, SETTINGS.region);
        await run.adaptAndMerge();
        await envs.provision("prod", "the app's server");
        await run.deployAny("the first deploy");
        await run.waitForHealth();
        await waitForDatabasePage(run);
      },
    );

    run.step(
      "2. addon enable monitoring writes the plan only; provision creates the monitoring server, the network, the stack and Alloy, each approved by its hash",
      minutes(45),
      async () => {
        const app = envs.app();
        const enabled = await run.opscrewOk("addon", "enable", "monitoring", "--env", "prod");
        for (const shown of ["/month", "AGPL-3.0", "opscrew provision"]) {
          expect(enabled.output, `addon enable monitoring shows "${shown}"`).toContain(shown);
        }
        const plan = await run.readPlan();
        expect(monitoringOf(plan)?.where, "where the stack runs").toEqual({
          kind: "server",
          server: MONITORING_SERVER,
        });
        expect(plan.network?.members.map((m) => m.name)).toContain(MONITORING_SERVER);
        expect(await serverCount(app), "servers at Hetzner after addon enable").toBe(1);
        await envs.provision("prod", "monitoring");
        await run.deploy("monitoring's files");
        expect(await serverCount(app), "servers at Hetzner after provision").toBe(2);
      },
    );

    run.step(
      "3. every server's figures and logs in the stack within 2 minutes, in addon status (SC-2001)",
      minutes(10),
      async () => {
        await expectData(planServers(await run.readPlan()), "monitoring's provision and deploy");
      },
    );

    run.step(
      "4. from the internet, the monitoring server answers only SSH and WireGuard's UDP port; verify and secure pass (SC-2002)",
      minutes(15),
      async () => {
        const ipv4 = await serverIpv4(envs, MONITORING_SERVER);
        expect(await canConnect(ipv4, 22), "SSH on the monitoring server").toBe(true);
        const open: number[] = [];
        for (const port of CLOSED_PORTS) if (await canConnect(ipv4, port)) open.push(port);
        expect(open, "the monitoring server's TCP ports answering from the internet").toEqual([]);
        const port = (await run.readPlan()).network?.members.find(
          (m) => m.name === MONITORING_SERVER,
        )?.port;
        expect(
          await hetznerFirewall(
            SETTINGS.hcloudToken,
            `${envs.app()}-${MONITORING_SERVER}-firewall`,
          ),
          "the monitoring server's cloud firewall",
        ).toEqual(["icmp", "tcp/22", `udp/${port}`].sort());
        await run.opscrewOk("verify", "--env", "prod");
        expect((await run.opscrew("secure", "--env", "prod")).output).toContain(
          "SECURITY_REPORT.md",
        );
      },
    );

    run.step(
      `5. device ${LAPTOP} reaches Grafana and not the push paths; the app's server reaches the push paths, not the queries or Grafana (SC-2002); every dashboard panel has data (SC-2003) and no app secret is in the stored lines (SC-2004)`,
      minutes(30),
      async () => {
        const address = await monitoringAddress();
        const grafana = `http://${address}:${MONITORING_GRAFANA_PORT}/api/health`;
        const front = `http://${address}:${MONITORING_PUSH_PORT}`;
        await opscrewUntilApproved(run, ["vpn", "add", LAPTOP, "--env", "prod"]);
        await device.tunnelUp(LAPTOP);
        await waitFor(
          `Grafana answering device ${LAPTOP}`,
          minutes(1),
          async () => ((await deviceHttp("GET", grafana)) === 200 ? true : undefined),
          5_000,
        );
        expect(
          await deviceHttp("POST", `${front}/api/v1/write`),
          "the push port from the device",
        ).toBeUndefined();

        const app = await serverShell(run, envs, "app");
        for (const path of ["/api/v1/write", "/loki/api/v1/push"]) {
          const status = await serverHttp(app, "POST", `${front}${path}`);
          expect(status, `POST ${path} from the app's server reaches the stack`).toBeDefined();
          expect(status, `POST ${path} from the app's server passes the front`).not.toBe(403);
        }
        expect(
          await serverHttp(app, "GET", `${front}/api/v1/query?query=up`),
          "a query through the front from the app's server",
        ).toBe(403);
        expect(
          await serverHttp(app, "GET", grafana),
          "Grafana from the app's server",
        ).toBeUndefined();

        // Grafana's API from the device, signed in with the password this computer generated.
        const password = grafanaAdminPassword(
          JSON.parse(
            await readFile(join(envs.paths().projectHomeDir, "generated_values.json"), "utf8"),
          ),
        );
        run.scrubber.add(password, "grafana-admin-password");
        const api = new DeviceGrafana(device, address, password);
        await httpTraffic();
        await expectDashboardsFilled(api);
        await expectNoSecretsStored(api);

        await opscrewUntilApproved(run, ["vpn", "remove", LAPTOP, "--env", "prod"]);
        await device.tunnelDown(LAPTOP);
      },
    );

    run.step(
      "6. staging sends to the same monitoring server: no new server, its data under its own environment (US5)",
      minutes(90),
      async () => {
        const prodApp = envs.app();
        await run.opscrewOk("env", "add", STAGING, "--target", "hetzner", "--from", "main");
        const designed = await envs.designed(STAGING);
        const host = designed.dns.domain;
        if (host === undefined) throw new Error("design gave staging no hostname.");
        const workflows = [await workflowOf(STAGING), DEPLOY_WORKFLOW];
        await envs.provision(STAGING, "staging");
        await run.deploy("staging's first deploy", workflows);
        await run.waitForHealth(minutes(10), true, `https://${host}${designed.app.healthPath}`);

        await run.opscrewOk("addon", "enable", "monitoring", "--env", STAGING);
        expect(
          monitoringOf(await envs.readPlan(STAGING))?.where,
          "where staging sends",
        ).toMatchObject({
          kind: "shared",
          owner: { server: MONITORING_SERVER },
        });
        await envs.provision(STAGING, "staging's monitoring");
        // Its pull request changes staging's files only, so prod's workflow doesn't run.
        await run.deploy("staging's monitoring files", [await workflowOf(STAGING)]);
        expect(await serverCount(prodApp), "prod's servers at Hetzner").toBe(2);
        expect(await serverCount(envs.app(STAGING)), "staging's servers at Hetzner").toBe(1);
        expect(await wireguardInterfaces(), "the monitoring server's networks").toBe(2);
        await expectData(
          [...planServers(await run.readPlan()), ...planServers(await envs.readPlan(STAGING))],
          "staging's monitoring provision and deploy",
        );
      },
    );

    run.step(
      "7. prod's addon disable monitoring refused while staging sends; staging destroyed, the monitoring server leaves its network (US5, US7)",
      minutes(30),
      async () => {
        const refused = await run.opscrew("addon", "disable", "monitoring", "--env", "prod");
        expect(refused.exitCode, run.tail(refused.output)).not.toBe(0);
        expect(refused.output).toContain("Nothing was changed.");
        expect(refused.output).toContain(STAGING);
        expect(
          monitoringOf(await run.readPlan()),
          "prod's monitoring after the refusal",
        ).toBeDefined();
        await envs.destroy(STAGING);
        await envs.expectNothingLeft(STAGING);
        expect(await wireguardInterfaces(), "the monitoring server's networks").toBe(1);
      },
    );

    run.step(
      `8. addon disable monitoring and provision: Alloy gone from the app's server, server ${MONITORING_SERVER} deleted after its typed name (US7, SC-2007)`,
      minutes(45),
      async () => {
        await run.opscrewOk("addon", "disable", "monitoring", "--env", "prod");
        const plan = await run.readPlan();
        expect(monitoringOf(plan), "monitoring after addon disable").toBeUndefined();
        expect((plan.servers ?? []).map((s) => s.name)).not.toContain(MONITORING_SERVER);
        // At Hetzner the server's delete protection goes first: in a script, `--confirm` without
        // `--approve` lifts it and plans the deletion, which the runs after it approve by its hash.
        const server = `${envs.app()}-${MONITORING_SERVER}`;
        const flags = [...envs.appArgs, "--env", "prod", ...run.provisionFlags];
        const lifted = await run.opscrewOk("provision", ...flags, "--confirm", server, "--yes");
        expect(lifted.output, "the scripted lift").toMatch(
          new RegExp(
            `Plan hash: [0-9a-f]{64}[\\s\\S]*Lift delete protection on ${server} \\(confirmed with --confirm ${server}\\)`,
          ),
        );
        await envs.provision("prod", `the deletion of server ${MONITORING_SERVER}`);
        await run.deploy("monitoring's removal");
        await run.waitForHealth();
        expect(
          await hetznerServerExists(SETTINGS.hcloudToken, server),
          `server ${MONITORING_SERVER} at Hetzner after its deletion`,
        ).toBe(false);
        expect(
          await (await envs.shell()).ok(
            `docker ps -aq --filter label=com.docker.compose.project=${ADDON_PROJECTS.alloy}`,
          ),
          "Alloy's containers on the app's server",
        ).toBe("");
      },
    );

    run.step("9. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "10. no secret (tokens, keys, Grafana's and the monitoring login's passwords) in any output, commit, pull request, audit entry, plan or state file, and no server address in an addon command's output (SC-2008)",
      minutes(10),
      async () => {
        const problems = await envs.leaks({ cloudflare: true });
        const addresses = run.scrubber.entries().filter(({ label }) => label.startsWith("server-"));
        for (const [label, output] of run.outputs) {
          if (!label.includes(" opscrew addon ")) continue;
          const found = leakedLabels(output, addresses);
          if (found.length > 0)
            problems.push(`the output of ${label} contains: ${found.join(", ")}`);
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    // After the harness's cleanup (destroy, then Hetzner's API by each app's labels, the monitoring
    // server's included): the device.
    envs.registerCleanup({
      last: async (attempt) => {
        await attempt("remove the device", () => device.remove());
      },
    });
  },
);
