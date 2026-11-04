/**
 * Feature 020's Docker pass (plan.md "15.", T2016): self-hosted monitoring as OpsCrew renders it,
 * on this computer's Docker, for a plan with Postgres and the Caddy edge whose stack runs on its
 * own server on the private network (`where.kind: "server"`):
 * - **the stack:** `renderMonitoringStack`'s files (Prometheus, Loki, the front, and Grafana with
 *   its two data sources and the six dashboards of `renderDashboards`), and Grafana's password file
 *   beside them;
 * - **the edge:** `renderEdgeCompose` (its Caddyfile always has Caddy's figures) with the app's site
 *   (`renderCaddyfile`), and the app routed on its kamal-proxy;
 * - **the app:** a fixture (`__fixtures__/monitoring/app`): a web service that logs a value of its
 *   app.env and a token, and Postgres with OpsCrew's monitoring login, made as the `grant` step's
 *   `monitor` access makes it;
 * - **one Alloy** for the app's server: `renderAlloyCompose`, `renderAlloyConfig`, and its
 *   read-only Docker proxy's `renderProxyCaddyfile`, with the files the `alloy` step writes beside
 *   them (the deploy user's ids, Postgres's data source) and the masking file the deploy writes.
 *
 * Only the harness differs from a server; the renderers' files are written as they are, except:
 * - every Compose project, the edge's network and the stack's push network have the run's names, so
 *   a run never touches another or anything else on this computer. Alloy's container discovery
 *   keeps the app's project and OpsCrew's own by their fixed names (`opscrew-edge`, …), so here it
 *   names only the app's containers, and the containers dashboard is proved on those;
 * - a test network stands in for the private network: the front is on it at the monitoring server's
 *   private address (on a server Docker publishes the front there), and Alloy joins it (on a server
 *   it reaches that address over WireGuard); Grafana and the edge publish on free ports of
 *   127.0.0.1;
 * - Alloy reads the app's masking file from a folder of the test's: on a server it reads
 *   `/srv/apps/<app>/mask.re` through `/rootfs`, the server's root, which here is Docker Desktop's
 *   VM (or this computer's root, where the test writes nothing);
 * - the app's site gets its certificate from Caddy's own CA (`tls internal`): Let's Encrypt can't
 *   reach this computer.
 *
 * It checks plan.md 15.'s Docker pass: every query of `DASHBOARD_QUERIES` answers with data within
 * two minutes of Alloy's start (SC-2003); the app's known value and token are stored masked, and
 * none of the run's secrets is in Loki or in the logs of OpsCrew's containers (SC-2004); every
 * container of the stack, Alloy and the edge stays within its memory limit (SC-2005); the front
 * answers 403 to every other path and method; Grafana has its data sources and dashboards, the
 * admin signs in with the file's password, sign-up is off; and a two-minute stop of the stack loses
 * no figures (Alloy's write-ahead log).
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon, and the network
 * for the pinned images. Everything it starts carries its run's label or Compose project and is
 * removed afterwards, even when a step fails, with the images it pulled (never one this computer
 * had before).
 */
import { randomBytes, randomInt } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MONITORING_VERSIONS, x25519KeyPair } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import { MONITOR_LOGIN } from "@opscrew/connector-ssh-host";
import { fakeSecret } from "@opscrew/core/testing";
import {
  appDir,
  DASHBOARD_QUERIES,
  GRAFANA_CREDENTIAL_FILE,
  IMAGES,
  renderAlloyCompose,
  renderAlloyConfig,
  renderCaddyfile,
  renderEdgeCompose,
  renderMonitoringStack,
  renderProxyCaddyfile,
  serviceSpec,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  DeployPlanSchema,
  MONITORING_PUSH_PORT,
  MONITORING_SERVER,
} from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type ComposeProject,
  type ComposeService,
  composeOk,
  dockerSkipReason,
  imageIds,
  LABEL,
  limitProblems,
  projectContainers,
  removeNewImages,
  TEN_MINUTES,
  TWO_MINUTES,
} from "./docker-support";
import {
  dockerOk,
  freePort,
  httpsGet,
  type LoopResult,
  renderContext,
  requestLoop,
  tempDir,
  unique,
  until,
} from "./edge-support";
import {
  APP_FOLDER,
  DASHBOARD_UIDS,
  GrafanaApi,
  hasData,
  instantValue,
  internalTls,
  LOKI_MAX_LINES,
  localAlloy,
  localEdge,
  localMaskFile,
  localStack,
  logLines,
  removeLabelled,
  writeFiles,
} from "./monitoring-support";
import { checked, dockerWith } from "./network-support";

const SKIP = dockerSkipReason();
if (SKIP !== undefined) console.warn(`Skipping the monitoring Docker pass: ${SKIP}.`);

/** The fixture app's Compose project and its web service's script. */
const APP_FIXTURE = fileURLToPath(new URL("./__fixtures__/monitoring/app/", import.meta.url));

/** The app's hostname (the plan's domain). */
const HOST = "example.com";

/** OpsCrew's Postgres image, which the fixture app runs. */
const POSTGRES_IMAGE = IMAGES[serviceSpec("postgres").image].ref;

/** Every image the run may pull; removed afterwards unless this computer had it before. */
const IMAGE_REFS = [
  IMAGES.prometheus.ref,
  IMAGES.loki.ref,
  IMAGES.grafana.ref,
  IMAGES.alloy.ref,
  IMAGES.caddy.ref,
  IMAGES.kamalProxy.ref,
  IMAGES.nodeAlpine.ref,
  IMAGES.curl.ref,
  POSTGRES_IMAGE,
];

/** The two disk panels' queries: from `node_filesystem_*`, which Docker Desktop's VM may not give. */
const DISK_QUERIES = DASHBOARD_QUERIES.filter((q) => q.expr.includes("node_filesystem_"));
const PANEL_QUERIES = DASHBOARD_QUERIES.filter((q) => !DISK_QUERIES.includes(q));

/** The last five minutes, as a dashboard asks for them. */
const LAST_FIVE_MINUTES = { from: "now-5m", to: "now" };

/** What the front must refuse with 403, from the private network: every other method and path. */
const REFUSED = [
  ["GET", "/api/v1/write"],
  ["PUT", "/api/v1/write"],
  ["DELETE", "/api/v1/write"],
  ["GET", "/loki/api/v1/push"],
  ["PUT", "/loki/api/v1/push"],
  ["GET", "/"],
  ["GET", "/metrics"],
  ["GET", "/-/ready"],
  ["POST", "/-/quit"],
  ["GET", "/api/v1/query?query=up"],
  ["POST", "/api/v1/query?query=up"],
  ["GET", "/api/v1/series?match%5B%5D=up"],
  ["GET", "/api/v1/label/__name__/values"],
  ["POST", "/api/v1/admin/tsdb/delete_series?match%5B%5D=up"],
  ["GET", "/ready"],
  ["GET", "/loki/api/v1/labels"],
  ["GET", "/loki/api/v1/query_range?query=%7Bapp%3D~%22.%2B%22%7D"],
  ["POST", "/loki/api/v1/delete?query=%7Bapp%3D~%22.%2B%22%7D"],
  ["POST", "/otlp/v1/logs"],
  ["POST", "/api/v1/otlp/v1/metrics"],
  ["POST", "/api/v1/write/../query?query=up"],
  ["POST", "/loki/api/v1/push/../query_range"],
  ["POST", "/api/v1/write%2F..%2Fquery?query=up"],
] as const;

/** The two push paths, which reach Prometheus's and Loki's handlers (an empty body: not 403). */
const PASSED = [
  ["POST", "/api/v1/write"],
  ["POST", "/loki/api/v1/push"],
] as const;

/**
 * `shop` ({@link testPlan}: Postgres `db` on the app's server, the Caddy edge) named `app`, at
 * {@link HOST}, with monitoring on its own server `monitoring` at the pinned versions, and the
 * private network `<prefix>.0/24` (the app's server `.1`, the monitoring server `.2`).
 */
function monitoredPlan(app: string, prefix: string): DeployPlan {
  const base = testPlan({ domain: HOST });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: app },
    servers: [
      {
        name: MONITORING_SERVER,
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cx23",
          backups: false,
        },
      },
    ],
    network: {
      range: `${prefix}.0/24`,
      members: [APP_SERVER, MONITORING_SERVER].map((name, i) => ({
        name,
        address: `${prefix}.${i + 1}`,
        port: 51820,
        publicKey: x25519KeyPair().publicKey,
      })),
    },
    observability: {
      monitoring: {
        enabled: true,
        where: { kind: "server", server: MONITORING_SERVER },
        versions: MONITORING_VERSIONS,
        retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 },
      },
    },
  });
}

describe.skipIf(SKIP !== undefined)("self-hosted monitoring on Docker (020)", () => {
  const run = unique("mon");
  /** The label of everything this test starts itself, besides the Compose projects' own. */
  const RUN_LABEL = `opscrew.test.run=${run}`;
  /** The app's name, and so its Compose project, the one Alloy reads. */
  const app = run;
  const projects = {
    stack: { name: `${run}-monitoring`, file: "" },
    app: { name: app, file: "" },
    edge: { name: `${run}-edge`, file: "" },
    alloy: { name: `${run}-alloy`, file: "" },
  } satisfies Record<string, ComposeProject>;
  /** The edge's network, the private network's stand-in, and the stack's push network. */
  const networks = { edge: `${run}-edge-net`, private: `${run}-private`, push: `${run}-push` };
  /** A random /24 of the ranges OpsCrew picks a private network from (10.200.0.0/13). */
  const prefix = `10.${200 + randomInt(8)}.${randomInt(256)}`;
  const addresses = { app: `${prefix}.1`, monitoring: `${prefix}.2` };
  /** Every value of the run that must never be stored or logged as it is. */
  const secrets = {
    "the app's known value": randomBytes(12).toString("hex"),
    "the app's token": fakeSecret("github-token", run),
    "Grafana's admin password": randomBytes(18).toString("base64url"),
    "the Postgres monitoring password": randomBytes(16).toString("hex"),
    "the Postgres superuser's password": randomBytes(16).toString("hex"),
  };
  const known = secrets["the app's known value"];
  const token = secrets["the app's token"];
  /** The values of the dashboards' variables: this app, its environment and its server. */
  let variables: Record<string, string> = {};
  let plan: DeployPlan;
  /** The images this computer had before the run; unset, the run removes none. */
  let before: Set<string> | undefined;
  let work = "";
  let httpsPort = 0;
  let grafana: GrafanaApi;
  let started = 0;
  let traffic: { stop(): Promise<LoopResult> } | undefined;
  /** Each rendered project's Compose services, as this test runs them. */
  const services: Record<string, Record<string, ComposeService>> = {};

  /** Starts `project` from its files and waits until its containers are up (and healthy). */
  async function up(project: ComposeProject, what: string): Promise<void> {
    await composeOk(project, what, ["up", "-d", "--wait", "--quiet-pull"], TEN_MINUTES);
  }

  /** Writes a rendered project's adapted `compose.yaml` in `dir` and keeps its services. */
  async function writeCompose(project: ComposeProject, dir: string, content: string) {
    project.file = path.join(dir, "compose.yaml");
    await writeFiles(dir, [{ path: "compose.yaml", content }]);
    services[project.name] = (
      parse(content) as { services: Record<string, ComposeService> }
    ).services;
  }

  /** The app's answer through the edge (Caddy, then kamal-proxy, then the app). */
  const visit = () => httpsGet(httpsPort, HOST);

  beforeAll(async () => {
    before = await imageIds();
    work = await tempDir("opscrew-monitoring-");
    plan = monitoredPlan(app, prefix);
    variables = {
      app,
      env: plan.environment?.name ?? "prod",
      server: APP_SERVER,
      service: ".+",
      search: "",
    };
    const grafanaPort = await freePort();
    httpsPort = await freePort();
    grafana = new GrafanaApi(grafanaPort, secrets["Grafana's admin password"]);
    const label = ["--label", LABEL, "--label", RUN_LABEL];
    await dockerOk(["network", "create", ...label, networks.edge], "creating the edge's network");
    // Docker hands out addresses from .128 up, so the monitoring server's .2 stays free.
    await dockerOk(
      [
        "network",
        "create",
        ...label,
        "--subnet",
        `${prefix}.0/24`,
        "--ip-range",
        `${prefix}.128/25`,
        networks.private,
      ],
      "creating the private network's stand-in",
    );

    // The stack, on the monitoring server: its files, and Grafana's password beside them (on a
    // server root's, 0640, which Grafana reads through its group 0; here a file it can read).
    const stackDir = path.join(work, "monitoring");
    const stackFiles = renderMonitoringStack(plan, [addresses.monitoring]);
    await writeFiles(
      stackDir,
      stackFiles.filter((file) => file.path !== "compose.yaml"),
    );
    await writeCompose(
      projects.stack,
      stackDir,
      localStack(stackFiles.find((file) => file.path === "compose.yaml")?.content ?? "", {
        address: addresses.monitoring,
        privateNetwork: networks.private,
        grafanaPort,
        pushNetwork: networks.push,
      }),
    );
    await writeFiles(stackDir, [
      { path: GRAFANA_CREDENTIAL_FILE, content: secrets["Grafana's admin password"] },
    ]);
    await up(projects.stack, "starting the monitoring stack");

    // The app, with Postgres's monitoring login as the grant step makes it (`monitor` access).
    const appFolder = path.join(work, "app");
    await cp(APP_FIXTURE, appFolder, { recursive: true });
    const env = {
      NODE_IMAGE: IMAGES.nodeAlpine.ref,
      POSTGRES_IMAGE,
      EDGE_NETWORK: networks.edge,
      KNOWN_VALUE: known,
      GITHUB_TOKEN: token,
      POSTGRES_PASSWORD: secrets["the Postgres superuser's password"],
    };
    await writeFiles(
      appFolder,
      [
        {
          path: ".env",
          content: Object.entries(env)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(""),
        },
      ],
      0o600,
    );
    projects.app.file = path.join(appFolder, "compose.yaml");
    await up(projects.app, "starting the app");
    const postgres = plan.services.find((s) => s.kind === "postgres")?.name ?? "";
    await checked(
      dockerWith(
        [
          "compose",
          "-p",
          app,
          "-f",
          projects.app.file,
          "exec",
          "-T",
          postgres,
          "psql",
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "app",
          "-d",
          "app",
        ],
        `CREATE ROLE "${MONITOR_LOGIN}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 3 PASSWORD '${secrets["the Postgres monitoring password"]}';\nGRANT pg_monitor TO "${MONITOR_LOGIN}";\n`,
      ),
      "making Postgres's monitoring login",
    );

    // The shared edge with the app's site, and the app routed on kamal-proxy as a deploy routes it.
    const edgeDir = path.join(work, "edge");
    const ctx = renderContext();
    await writeCompose(
      projects.edge,
      edgeDir,
      localEdge(renderEdgeCompose(plan).content, { edgeNetwork: networks.edge, httpsPort }),
    );
    await writeFiles(edgeDir, [
      {
        path: `sites/${app}.caddy`,
        content: internalTls(renderCaddyfile(plan, ctx).content, ctx.acmeEmail),
      },
    ]);
    await mkdir(path.join(edgeDir, "tls"));
    await up(projects.edge, "starting the edge");
    await composeOk(
      projects.edge,
      "routing the app on kamal-proxy",
      [
        "exec",
        "-T",
        "kamal-proxy",
        "kamal-proxy",
        "deploy",
        app,
        "--target",
        `${app}-web-1:3000`,
        "--host",
        HOST,
        "--health-check-path",
        plan.app.healthPath,
      ],
      TWO_MINUTES,
    );
    await until(
      "the app through the edge",
      async () => (await visit()).status === 200 || undefined,
    );
    // One handler error, so Caddy has caddy_http_request_errors_total: a 502 from a stopped upstream.
    await composeOk(projects.edge, "stopping kamal-proxy", ["stop", "kamal-proxy"]);
    await until("a 502 from the edge", async () => (await visit()).status === 502 || undefined);
    await composeOk(projects.edge, "starting kamal-proxy", ["start", "kamal-proxy"]);
    await until(
      "the app through the edge again",
      async () => (await visit()).status === 200 || undefined,
    );

    // Alloy on the app's server, sending to the front at the monitoring server's private address.
    const alloyDir = path.join(work, "alloy");
    const destinations = { monitoring: { address: addresses.monitoring } };
    await writeCompose(
      projects.alloy,
      alloyDir,
      localAlloy(renderAlloyCompose(plan, APP_SERVER, destinations), {
        edgeNetwork: networks.edge,
        privateNetwork: networks.private,
      }),
    );
    await writeFiles(alloyDir, [
      { path: "Caddyfile", content: renderProxyCaddyfile("grafana-cloud") },
      {
        path: "config.alloy",
        content: localMaskFile(renderAlloyConfig(plan, APP_SERVER, destinations), appDir(plan)),
      },
    ]);
    // The files the alloy step writes beside them: the deploy user's ids (here this user's, or
    // 1000 where Docker Desktop shares this computer's files with any user), and Postgres's whole
    // data source; and the masking file the deploy writes in the app's folder (one capture group).
    const deployUser = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
    await writeFiles(
      alloyDir,
      [
        {
          path: ".env",
          content: `OPSCREW_DEPLOY_UID=${deployUser.uid}\nOPSCREW_DEPLOY_GID=${deployUser.gid}\n`,
        },
        {
          path: "postgres_monitor_credential",
          content: `postgresql://${MONITOR_LOGIN}:${secrets["the Postgres monitoring password"]}@${postgres}:5432/postgres?sslmode=disable`,
        },
        { path: `${APP_FOLDER}/mask.re`, content: `(${known})` },
      ],
      0o600,
    );
    await mkdir(path.join(alloyDir, "data"));
    await up(projects.alloy, "starting Alloy");
    started = Date.now();
    // Visitors, two a second, for the HTTP dashboard.
    traffic = requestLoop(
      async () => {
        await sleep(450);
        return visit();
      },
      (answer) => answer.status === 200,
    );
  }, 3 * TEN_MINUTES);

  afterAll(async () => {
    await traffic?.stop();
    await removeLabelled([
      RUN_LABEL,
      ...Object.values(projects).map((project) => `com.docker.compose.project=${project.name}`),
    ]);
    if (before !== undefined) await removeNewImages(before, IMAGE_REFS);
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, TEN_MINUTES);

  /** `expr` of a dashboard with its variables set to this app, environment and server. */
  function panelQuery(expr: string): string {
    return expr.replace(
      /\$(app|env|server|service|search)\b/g,
      (_, name: string) => variables[name] ?? "",
    );
  }

  it(
    "answers every dashboard query with data within two minutes of Alloy's start (SC-2003)",
    async () => {
      const pending = new Map(PANEL_QUERIES.map((q) => [q, "no answer yet"]));
      for (;;) {
        await Promise.all(
          [...pending.keys()].map(async (q) => {
            try {
              const frames = await grafana.query(
                q.datasource,
                panelQuery(q.expr),
                LAST_FIVE_MINUTES,
              );
              if (hasData(frames)) pending.delete(q);
              else pending.set(q, "no data");
            } catch (error) {
              pending.set(q, String(error));
            }
          }),
        );
        if (pending.size === 0 || Date.now() > started + TWO_MINUTES) break;
        await sleep(5_000);
      }
      expect([...pending].map(([q, why]) => `${q.dashboard}, "${q.panel}": ${why}`)).toEqual([]);
      console.info(
        `All ${PANEL_QUERIES.length} queries had data ${Math.round((Date.now() - started) / 1000)} s after Alloy started.`,
      );
    },
    TEN_MINUTES,
  );

  it(
    "shows the servers dashboard's two disk panels where the server's root is a disk's file system",
    async (context) => {
      const empty: string[] = [];
      for (const q of DISK_QUERIES) {
        const frames = await grafana.query(q.datasource, panelQuery(q.expr), LAST_FIVE_MINUTES);
        if (!hasData(frames)) empty.push(q.panel);
      }
      if (empty.length === 0) return;
      // Alloy's view of the server's root: the unix exporter leaves out overlay file systems, as
      // it leaves out the containers' own on a server.
      const mounts = await composeOk(projects.alloy, "reading Alloy's mounts", [
        "exec",
        "-T",
        "alloy",
        "cat",
        "/proc/1/mountinfo",
      ]);
      const root = mounts.split(/\r?\n/).find((line) => line.split(" ")[4] === "/rootfs");
      const type = root?.split(" - ")[1]?.split(" ")[0];
      if (type === "overlay") {
        context.skip(
          `${empty.join(" and ")} have no data here: the server's root as Alloy sees it at /rootfs is Docker Desktop's VM, an overlay file system, which the unix exporter leaves out, so there are no node_filesystem_* series. On a server it is the disk's; the live pass checks these panels.`,
        );
      }
      expect(empty, `the root at /rootfs is ${type}`).toEqual([]);
    },
    TWO_MINUTES,
  );

  it(
    "stores the app's lines masked, and none of the run's secrets in Loki or OpsCrew's containers' logs (SC-2004)",
    async () => {
      const lines = await until(
        "the web service's lines in Loki",
        async () => {
          const found = logLines(
            await grafana.query("loki", `{app="${app}", service="web"}`, LAST_FIVE_MINUTES),
          );
          return found.filter((line) => line.startsWith("tick ")).length >= 10 ? found : undefined;
        },
        TWO_MINUTES,
        3_000,
      );
      const masked = /^tick \d+ token=<opscrew:github-token> password=<opscrew:known-value>$/;
      expect(
        lines.some((line) => masked.test(line)),
        "a tick line, masked",
      ).toBe(true);
      const stored = logLines(
        await grafana.query("loki", `{app="${app}"}`, { from: "now-15m", to: "now" }),
      );
      // Under Loki's limit, so the check below covers every line the app has stored.
      expect(stored.length).toBeLessThan(LOKI_MAX_LINES);
      const logs = await Promise.all(
        [projects.stack, projects.alloy, projects.edge].map(async (project) => ({
          where: `${project.name}'s logs`,
          text: await composeOk(project, `reading ${project.name}'s logs`, ["logs", "--no-color"]),
        })),
      );
      for (const [name, value] of Object.entries(secrets)) {
        // Counted, never printed: a failure names the value and where it was found.
        expect(stored.filter((line) => line.includes(value)).length, `${name} in Loki`).toBe(0);
        for (const { where, text } of logs)
          expect(text.includes(value), `${name} in ${where}`).toBe(false);
      }
      console.info(`Loki holds ${stored.length} of the app's lines, masked.`);
    },
    TEN_MINUTES,
  );

  it(
    "answers 403 at the front to every other path and method from the private network",
    async () => {
      const curl = (method: string, target: string) =>
        `printf '%s %s %s\\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 20 --path-as-is -g -X ${method} 'http://${addresses.monitoring}:${MONITORING_PUSH_PORT}${target}')" ${method} '${target}'`;
      const output = await dockerOk(
        [
          "run",
          "--rm",
          "--label",
          LABEL,
          "--label",
          RUN_LABEL,
          "--network",
          networks.private,
          "--entrypoint",
          "sh",
          IMAGES.curl.ref,
          "-c",
          [...REFUSED, ...PASSED].map(([method, target]) => curl(method, target)).join("\n"),
        ],
        "requests to the front",
      );
      const answers = output.split(/\r?\n/);
      expect(answers.slice(0, REFUSED.length)).toEqual(
        REFUSED.map(([method, target]) => `403 ${method} ${target}`),
      );
      for (const answer of answers.slice(REFUSED.length)) {
        expect(answer).toMatch(/^[245]\d\d /);
        expect(answer).not.toMatch(/^403 /);
      }
    },
    TWO_MINUTES,
  );

  it(
    "provisions Grafana's two data sources and six dashboards; the admin signs in with the file's password; sign-up is off",
    async () => {
      const sources =
        await grafana.json<{ uid: string; type: string; readOnly: boolean }[]>("/api/datasources");
      expect(
        sources
          .map(({ uid, type, readOnly }) => ({ uid, type, readOnly }))
          .sort((a, b) => a.uid.localeCompare(b.uid)),
      ).toEqual([
        { uid: "opscrew-loki", type: "loki", readOnly: true },
        { uid: "opscrew-prometheus", type: "prometheus", readOnly: true },
      ]);
      const dashboards = await grafana.json<{ uid: string; folderTitle?: string }[]>(
        "/api/search?type=dash-db",
      );
      expect(dashboards.map((d) => d.uid).sort()).toEqual(DASHBOARD_UIDS);
      expect(new Set(dashboards.map((d) => d.folderTitle))).toEqual(new Set(["OpsCrew"]));

      const user = await grafana.fetch("/api/user");
      expect(user.status).toBe(200);
      expect(((await user.json()) as { login: string }).login).toBe("admin");
      // Grafana's own default password, and no login at all.
      expect((await grafana.fetch("/api/user", {}, "admin")).status).toBe(401);
      expect((await grafana.fetch("/api/user", {}, null)).status).toBe(401);

      const signUp = await grafana.fetch(
        "/api/user/signup",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "someone@example.com" }),
        },
        null,
      );
      expect(signUp.status).toBe(401);
      expect(await signUp.text()).toContain("signup is disabled");
    },
    TWO_MINUTES,
  );

  it(
    "keeps every container of the stack, Alloy and the edge within its memory limit (SC-2005)",
    async () => {
      const wait = started + TWO_MINUTES - Date.now();
      if (wait > 0) await sleep(wait);
      for (const project of [projects.stack, projects.alloy, projects.edge]) {
        const rendered = services[project.name] ?? {};
        const containers = await projectContainers(project.name);
        expect(containers.map((c) => c.service).sort()).toEqual(Object.keys(rendered).sort());
        expect(limitProblems(containers, rendered)).toEqual([]);
        for (const c of containers) {
          expect(c, c.name).toMatchObject({ running: true, oomKilled: false, restarts: 0 });
        }
        const stats = await dockerOk(
          [
            "stats",
            "--no-stream",
            "--format",
            "{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}",
            ...containers.map((c) => c.name),
          ],
          `reading ${project.name}'s memory`,
        );
        for (const line of stats.split(/\r?\n/)) {
          const [name, usage, share] = line.split("\t");
          console.info(`${name}: ${usage} (${share})`);
        }
      }
    },
    TEN_MINUTES,
  );

  it(
    "keeps the figures of a two-minute stop of the stack: Alloy sends them from its write-ahead log",
    async () => {
      await composeOk(projects.stack, "stopping the stack", ["stop"]);
      const stopped = Date.now();
      await sleep(TWO_MINUTES);
      const back = Date.now();
      await up(projects.stack, "starting the stack again");
      // The samples Alloy took while the stack was away, 5 s clear of either end.
      const seconds = Math.floor((back - stopped) / 1000) - 10;
      const at = String(back - 5_000);
      const expr = `count_over_time(node_load1{app="${app}", server="${APP_SERVER}"}[${seconds}s])`;
      const expected = Math.floor(seconds / 15) - 1;
      const count = await until(
        "the stop's figures in Prometheus",
        async () => {
          const value = instantValue(
            await grafana.query("prometheus", expr, { from: at, to: at }, true),
          );
          return value !== undefined && value >= expected ? value : undefined;
        },
        TWO_MINUTES,
        5_000,
      );
      expect(count).toBeGreaterThanOrEqual(expected);
      console.info(`Prometheus has ${count} samples from the ${seconds} s the stack was stopped.`);
    },
    TEN_MINUTES,
  );
});
