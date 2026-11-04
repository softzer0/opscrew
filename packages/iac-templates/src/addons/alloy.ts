import {
  APP_SERVER,
  type DeployPlan,
  type GrafanaCloudSettings,
  MONITORING_PUSH_PORT,
  monitoringOf,
  monitoringServerName,
  type PlanService,
} from "@opscrew/plan-schema";
import { appDir, CADDY_METRICS_PORT, EDGE_PROJECT, edgeProxy } from "../edge";
import { MONITORING_PROJECT, MONITORING_PUSH_NETWORK } from "../monitoring";
import { IMAGES } from "../pins";
import { siteHosts } from "../runtime";
import { memoryLimit } from "../runtime/components";
import { servicesRunningOn } from "../runtime/move";
import { hardened } from "../runtime/services";
import { planFilePath } from "../workflow/shared";
import { addonImage, composeFile, DEPLOY_USER } from "./compose";
import { PROXY_SOCKET, PROXY_SOCKET_DIR, PROXY_VOLUME, proxyService } from "./proxy";
import { re2TokenPatterns } from "./re2";

/** Where one server's Alloy sends: Grafana Cloud, the monitoring stack, or both. */
export interface AlloyDestinations {
  grafanaCloud?: GrafanaCloudSettings;
  /**
   * The stack's front: the monitoring server's private address on this server's network, or
   * `front` on the stack's own server (over {@link MONITORING_PUSH_NETWORK}).
   */
  monitoring?: { address: string };
}

/** Alloy's Compose project. */
const PROJECT = "opscrew-alloy";

/**
 * OpsCrew's own Compose projects, whose containers' figures Alloy sends with the app's: the edge,
 * the add-ons and the monitoring stack.
 */
const OPSCREW_PROJECTS = [EDGE_PROJECT, "opscrew-beszel", PROJECT, MONITORING_PROJECT];

/** Alloy's storage (its write-ahead log and positions), the bind-mounted `data/` folder. */
const STORAGE = "/var/lib/opscrew-alloy";

/** Where Alloy reads a file beside its Compose file. */
const inContainer = (file: string) => `/etc/alloy/${file}`;

/**
 * The Grafana Cloud token's file, beside the Compose file (only the deploy user can read it). Not
 * named `…token`: the redactor would take the mount for a labelled secret.
 */
const TOKEN_FILE = "grafana_cloud_credential";

/**
 * The Postgres monitoring login's whole data source (`postgresql://opscrew_monitor:…`), beside the
 * Compose file (only the deploy user can read it), named as {@link TOKEN_FILE} is.
 */
const POSTGRES_FILE = "postgres_monitor_credential";

/**
 * Where Alloy sees the server's `/` and `/sys`, read-only: under `/host` for Grafana Cloud alone,
 * and with monitoring at `/rootfs` and `/sys`, the paths cAdvisor reads (research R7, S1).
 */
const HOST_PATHS = {
  grafanaCloud: { root: "/host/root", sys: "/host/sys" },
  monitoring: { root: "/rootfs", sys: "/sys" },
} as const;

/** Alloy's HTTP server with monitoring, on its loopback only: cAdvisor's figures are read there. */
const HTTP_ADDRESS = "127.0.0.1:12345";

/** Every scrape's interval with monitoring (Alloy's default is a minute). */
const SCRAPE_INTERVAL = "15s";

/** The share of the memory limit Go's garbage collector aims to stay under (spike result 3). */
const GO_MEMORY_SHARE = 0.8;

/** The server's figures Alloy sends: CPU time, load, total and available memory, and `/`'s size. */
const METRICS_KEPT =
  "node_cpu_seconds_total|node_load(1|5|15)|node_memory_(MemTotal|MemAvailable)_bytes|node_filesystem_(size|avail)_bytes";

/** The CPU modes not sent: rare on a small server, and the series cost the free tier. */
const CPU_MODES_DROPPED = "nice|irq|softirq|guest|guest_nice";

/** Each container's figures kept: CPU, working set, limit, start time (restarts) and OOM kills. */
const CONTAINER_METRICS_KEPT =
  "container_(cpu_usage_seconds_total|memory_working_set_bytes|spec_memory_limit_bytes|start_time_seconds|oom_events_total)";

/** The server's interfaces not sent: loopback, Docker's, and WireGuard's (on the physical one too). */
const INTERFACES_DROPPED = "lo|veth.*|br-.*|docker.*|wg.*";

/** Caddy's Compose service in the edge's project: its name on the edge's network, and its label. */
const CADDY_SERVICE = "caddy";

/** Caddy's figures kept (research R7, S5): request durations, in flight, errors, its process. */
const CADDY_METRICS_KEPT =
  "caddy_http_request_duration_seconds_(bucket|sum|count)|caddy_http_requests_in_flight|caddy_http_request_errors_total|process_(resident_memory_bytes|cpu_seconds_total)|up";

/** Postgres's figures kept: connections, transactions, cache, size, deadlocks, the oldest query. */
const POSTGRES_METRICS_KEPT =
  "pg_up|pg_settings_max_connections|pg_stat_activity_count|pg_stat_activity_max_tx_duration|pg_stat_database_(numbackends|xact_commit|xact_rollback|blks_hit|blks_read|deadlocks)|pg_database_size_bytes";

/** An Alloy string literal. */
const str = (value: string) => JSON.stringify(value);

/** Alloy's `[a, b]` list of component references. */
const list = (items: readonly string[]) => `[${items.join(", ")}]`;

/** The first enabled Postgres on `server`, whose figures that server's Alloy then sends. */
function postgresOn(plan: DeployPlan, server: string): PlanService | undefined {
  return plan.services.find(
    (service) =>
      service.kind === "postgres" && service.enabled && (service.server ?? APP_SERVER) === server,
  );
}

/** `text` matched literally in an RE2 (or JavaScript) expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True on the edge's server (the app's) behind Caddy, whose figures Alloy then scrapes. */
function caddyOn(plan: DeployPlan, server: string): boolean {
  return server === APP_SERVER && edgeProxy(plan) === "caddy";
}

/**
 * True where the app runs something whose logs Alloy sends: the app's server, and an extra server
 * with a service (the deploy writes the masking file only there). Not the monitoring server.
 */
function appLogsOn(plan: DeployPlan, server: string): boolean {
  return server === APP_SERVER || servicesRunningOn(plan, server).length > 0;
}

/** The app's Compose network on its servers (project `<app>`, network `internal`), Postgres's. */
function appNetwork(plan: DeployPlan): string {
  return `${plan.app.name}_internal`;
}

/** Grafana Cloud's settings, when there is nowhere else to send. */
function onlyDestination(grafana: GrafanaCloudSettings | undefined): GrafanaCloudSettings {
  if (grafana === undefined) {
    throw new Error(
      "Alloy has nowhere to send: give it Grafana Cloud's settings, the monitoring stack's address, or both.",
    );
  }
  return grafana;
}

/**
 * Alloy's `compose.yaml` (project `opscrew-alloy`): Alloy and the read-only Docker proxy. Alloy runs
 * as the deploy user with no capability, a read-only root and `GOMEMLIMIT` at 80% of its memory
 * limit, on its own bridge network (never the host's, so its local API, which shows the masking
 * values, stays inside the container). It sees Docker only through the proxy, keeps its storage in
 * the bind-mounted `data/` folder, and reads its own `/proc` (the server's CPU, load and memory):
 * - **Grafana Cloud alone:** `/` and `/sys` read-only under `/host`, and the token's file.
 * - **With monitoring** (`destinations.monitoring`): `/` and `/sys` read-only at `/rootfs` and
 *   `/sys` for cAdvisor (no privileged mode, no `/var/lib/docker`), its HTTP server on its loopback,
 *   the memory limits of `observability.monitoring.memoryMb`, the token's file with Grafana Cloud,
 *   and, besides its own network:
 *   - on the edge's server behind Caddy, the edge's network (Caddy's figures);
 *   - on Postgres's server, the app's network and the Postgres data source's file;
 *   - on the stack's own server, {@link MONITORING_PUSH_NETWORK} (the front by name).
 * @throws Error with no destination, or for monitoring the plan doesn't turn on.
 */
export function renderAlloyCompose(
  plan: DeployPlan,
  server: string,
  destinations: AlloyDestinations,
): string {
  const { grafanaCloud } = destinations;
  if (destinations.monitoring === undefined) {
    const grafana = onlyDestination(grafanaCloud);
    return alloyCompose(plan, {
      header: [
        `Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew addon enable grafana-cloud\` regenerates it.`,
        "Grafana Alloy sends the app's logs, masked, and the server's CPU, load, memory and disk to your",
        "Grafana Cloud stack. It reads Docker only through OpsCrew's read-only proxy, and the server's",
        "files read-only. The token is in a file beside this one that only the deploy user can read.",
      ],
      version: { value: grafana.version, field: "grafanaCloud.version" },
      memoryMb: grafana.memoryMb,
      flags: [],
      files: [TOKEN_FILE],
      paths: HOST_PATHS.grafanaCloud,
      networks: [],
    });
  }
  const monitoring = monitoringOf(plan);
  if (monitoring === undefined) {
    throw new Error("The plan doesn't turn monitoring on (observability.monitoring.enabled).");
  }
  const caddy = caddyOn(plan, server);
  const postgres = postgresOn(plan, server) !== undefined;
  const sources = ["the server", "its containers", ...(caddy ? ["Caddy"] : [])];
  if (postgres) sources.push("Postgres");
  const figures = `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)}`;
  const beside = "is in a file beside this one that only the deploy user can read.";
  return alloyCompose(plan, {
    header: [
      `Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
      ...(appLogsOn(plan, server)
        ? [
            "Grafana Alloy sends the app's logs, masked, to the monitoring stack, with the figures of",
            `${figures}.`,
          ]
        : [`Grafana Alloy sends the figures of ${figures} to the monitoring stack.`]),
      ...(grafanaCloud === undefined
        ? []
        : ["It also sends the logs and the server's figures to your Grafana Cloud stack."]),
      "It reads Docker only through OpsCrew's read-only proxy, and the server's files read-only.",
      ...(grafanaCloud === undefined ? [] : [`The Grafana Cloud token ${beside}`]),
      ...(postgres ? [`Postgres's monitoring login ${beside}`] : []),
    ],
    version: { value: monitoring.versions.alloy, field: "observability.monitoring.versions.alloy" },
    memoryMb: monitoring.memoryMb,
    flags: [`--server.http.listen-addr=${HTTP_ADDRESS}`],
    files: [
      ...(grafanaCloud === undefined ? [] : [TOKEN_FILE]),
      ...(postgres ? [POSTGRES_FILE] : []),
    ],
    paths: HOST_PATHS.monitoring,
    networks: [
      ...(caddy ? [EDGE_PROJECT] : []),
      ...(postgres ? [appNetwork(plan)] : []),
      ...(monitoringServerName(plan) === server ? [MONITORING_PUSH_NETWORK] : []),
    ],
  });
}

/** What Alloy's Compose file differs in, by destination. */
interface AlloySetup {
  /** The header's comment lines. */
  header: string[];
  /** Alloy's version, and the plan field it comes from. */
  version: { value: string; field: string };
  memoryMb: { alloy: number; proxy: number };
  /** Alloy's flags besides its storage and reporting. */
  flags: string[];
  /** Files beside the Compose file that Alloy reads, besides its configuration. */
  files: string[];
  paths: { root: string; sys: string };
  /** The external networks Alloy joins besides its own. */
  networks: string[];
}

/** {@link renderAlloyCompose}'s file for `setup`. */
function alloyCompose(plan: DeployPlan, setup: AlloySetup): string {
  const { value: version, field } = setup.version;
  const alloy = addonImage(IMAGES.alloy.ref, `v${version}`);
  const limit = setup.memoryMb.alloy;
  const networks = setup.networks;
  const header = [
    ...setup.header,
    ...(alloy.pinned
      ? []
      : [`Grafana Alloy ${version} (${field} in the plan) is pinned by tag only, not by digest.`]),
  ];
  return composeFile(header, {
    name: PROJECT,
    services: {
      proxy: proxyService(setup.memoryMb.proxy),
      alloy: {
        image: alloy.image,
        restart: "unless-stopped",
        // The metrics' `instance` label: fixed, so a new container doesn't start new series.
        hostname: `opscrew-alloy-${plan.app.name}`,
        user: DEPLOY_USER,
        command: [
          "run",
          `--storage.path=${STORAGE}`,
          "--disable-reporting",
          ...setup.flags,
          inContainer("config.alloy"),
        ],
        environment: { GOMEMLIMIT: `${Math.floor(limit * GO_MEMORY_SHARE)}MiB` },
        volumes: [
          `./config.alloy:${inContainer("config.alloy")}:ro`,
          ...setup.files.map((file) => `./${file}:${inContainer(file)}:ro`),
          `./data:${STORAGE}`,
          `${PROXY_VOLUME}:${PROXY_SOCKET_DIR}`,
          `/:${setup.paths.root}:ro`,
          `/sys:${setup.paths.sys}:ro`,
        ],
        depends_on: ["proxy"],
        read_only: true,
        tmpfs: ["/tmp"],
        ...memoryLimit(limit),
        ...hardened({ noCapabilities: true }),
        ...(networks.length > 0 ? { networks: ["default", ...networks] } : {}),
      },
    },
    ...(networks.length > 0
      ? {
          networks: {
            default: {},
            ...Object.fromEntries(networks.map((network) => [network, { external: true }])),
          },
        }
      : {}),
    volumes: { [PROXY_VOLUME]: {} },
  });
}

/**
 * Alloy's `config.alloy` on `server` (`app` or an extra server's name):
 * - **Logs:** the app's Compose project's containers on the server, through the proxy, labelled
 *   `app`, `env` and `service` (and `server` with monitoring). Before anything leaves the server
 *   they pass OpsCrew's token patterns (in RE2), the app's known values (the masking file each
 *   deploy writes, read every 10 seconds), then `loki.secretfilter` (Gitleaks' rules).
 * - **Grafana Cloud alone:** the server's CPU, load, memory and root filesystem, kept to an
 *   allow-list, and the lines sampled when `logSampling` is below 100; sent with basic auth, the
 *   token from its file.
 * - **With monitoring** (research R7, "The collector"), every scrape every 15 seconds:
 *   - the server's figures as for Grafana Cloud; each container's from cAdvisor on the cgroups,
 *     named through the proxy for the app's and OpsCrew's projects; the server's network traffic;
 *     Caddy's on the edge's server; Postgres's on its server, as `opscrew_monitor`;
 *   - every masked line and figure to the stack's front at `destinations.monitoring.address`, with
 *     no login (the network's filter and the front stand guard), labelled `app`, `env`, `server`;
 *   - with Grafana Cloud too, its lines sampled on its branch only, and only the server's figures;
 *   - on a server where no app service runs (the monitoring server), figures only: no log source,
 *     masking or Loki writer.
 * @throws Error with no destination, or Grafana Cloud's settings without endpoints.
 */
export function renderAlloyConfig(
  plan: DeployPlan,
  server: string,
  destinations: AlloyDestinations,
): string {
  const { grafanaCloud, monitoring } = destinations;
  if (monitoring === undefined) return grafanaCloudConfig(plan, onlyDestination(grafanaCloud));
  const labels = `{ app = ${str(plan.app.name)}, env = ${str(environmentOf(plan))}, server = ${str(server)} }`;
  const cloud = grafanaCloud === undefined ? undefined : endpoints(grafanaCloud);
  const logs = appLogsOn(plan, server);
  const postgres = postgresOn(plan, server);
  return [
    `// Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew provision\` regenerates it.`,
    "",
    ...(logs
      ? [
          ...appLogs(plan, labels),
          ...masking(plan, HOST_PATHS.monitoring.root, []),
          ...fanOut(grafanaCloud),
        ]
      : [
          "// No app service runs on this server, so there are no app logs here: only its figures.",
          "",
        ]),
    "// ---- The server's CPU, load, memory and root filesystem ----",
    "// Alloy's own /proc shows the whole server's; / and /sys are mounted read-only at /rootfs and /sys.",
    ...hostExporter(HOST_PATHS.monitoring),
    'prometheus.scrape "host" {',
    "  targets         = prometheus.exporter.unix.host.targets",
    `  scrape_interval = ${str(SCRAPE_INTERVAL)}`,
    "  forward_to      = [prometheus.relabel.allow.receiver]",
    "}",
    "",
    ...hostAllowList([
      "prometheus.remote_write.monitoring.receiver",
      ...(cloud === undefined ? [] : ["prometheus.remote_write.grafana_cloud.receiver"]),
    ]),
    ...containerFigures(plan),
    ...(caddyOn(plan, server) ? caddyFigures(plan) : []),
    ...(postgres === undefined ? [] : postgresFigures(postgres)),
    "// ---- Sending to the monitoring stack: its front, on the private network, with no login ----",
    ...(logs
      ? [
          'loki.write "monitoring" {',
          "  endpoint {",
          `    url                 = ${str(`http://${monitoring.address}:${MONITORING_PUSH_PORT}/loki/api/v1/push`)}`,
          "    // Lines wait in memory while the stack is away: 40 tries 30 seconds apart keep each batch",
          "    // about 20 minutes, and send it within 30 seconds of the stack's return.",
          '    max_backoff_period  = "30s"',
          "    max_backoff_retries = 40",
          "  }",
          "}",
          "",
        ]
      : []),
    'prometheus.remote_write "monitoring" {',
    `  external_labels = ${labels}`,
    "  endpoint {",
    `    url = ${str(`http://${monitoring.address}:${MONITORING_PUSH_PORT}/api/v1/write`)}`,
    "    // One shard: resharding while the stack is away drops the samples queued in the old shards.",
    "    // The write-ahead log keeps the figures for up to 8 hours.",
    "    queue_config {",
    "      max_shards = 1",
    "    }",
    "  }",
    "}",
    "",
    ...(cloud === undefined
      ? []
      : [...grafanaCloudLogs(cloud.logs), ...grafanaCloudMetrics(plan, cloud.metrics)]),
  ].join("\n");
}

/** Grafana Cloud's `config.alloy` alone (feature 017's). */
function grafanaCloudConfig(plan: DeployPlan, grafana: GrafanaCloudSettings): string {
  const { metrics, logs } = endpoints(grafana);
  return [
    `// Generated by OpsCrew from ${planFilePath(plan)}; \`opscrew addon enable grafana-cloud\` regenerates it.`,
    "",
    ...appLogs(plan, appLabels(plan)),
    ...masking(plan, HOST_PATHS.grafanaCloud.root, samplingStages(grafana)),
    ...secretFilter(["// Gitleaks' rules, after OpsCrew's own."], [CLOUD_LOGS]),
    ...grafanaCloudLogs(logs),
    "// ---- The server's CPU, load, memory and root filesystem ----",
    "// Alloy's own /proc shows the whole server's; / and /sys are mounted read-only under /host.",
    ...hostExporter(HOST_PATHS.grafanaCloud),
    'prometheus.scrape "host" {',
    "  targets    = prometheus.exporter.unix.host.targets",
    "  forward_to = [prometheus.relabel.allow.receiver]",
    "}",
    "",
    ...hostAllowList(["prometheus.remote_write.grafana_cloud.receiver"]),
    ...grafanaCloudMetrics(plan, metrics),
  ].join("\n");
}

/** The plan's environment, as the `env` label names it. */
function environmentOf(plan: DeployPlan): string {
  return plan.environment?.name ?? "prod";
}

/** The labels of Grafana Cloud's lines and figures: the app's and environment's names. */
function appLabels(plan: DeployPlan): string {
  return `{ app = ${str(plan.app.name)}, env = ${str(environmentOf(plan))} }`;
}

/** Grafana Cloud's endpoints. */
function endpoints(grafana: GrafanaCloudSettings) {
  const { metrics, logs } = grafana;
  if (metrics === undefined || logs === undefined) {
    throw new Error("Grafana Cloud's settings have no metrics or logs endpoint to send to.");
  }
  return { metrics, logs };
}

/** The app's Compose project's containers on the server and their logs, with `labels`. */
function appLogs(plan: DeployPlan, labels: string): string[] {
  return [
    "// ---- The app's logs, from its Compose project's containers, through the read-only proxy ----",
    'discovery.docker "app" {',
    `  host = ${str(PROXY_SOCKET)}`,
    "  filter {",
    '    name   = "label"',
    `    values = [${str(`com.docker.compose.project=${plan.app.name}`)}]`,
    "  }",
    "}",
    "",
    'discovery.relabel "app" {',
    "  targets = discovery.docker.app.targets",
    "  rule {",
    '    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]',
    '    target_label  = "service"',
    "  }",
    "}",
    "",
    'loki.source.docker "app" {',
    `  host       = ${str(PROXY_SOCKET)}`,
    "  targets    = discovery.relabel.app.output",
    `  labels     = ${labels}`,
    "  forward_to = [loki.process.mask.receiver]",
    "}",
    "",
  ];
}

/**
 * The masking file under `root` (the server's `/`) and the masking stages: OpsCrew's token
 * patterns, the known values, then the `sampling` stages, if any.
 */
function masking(plan: DeployPlan, root: string, sampling: string[]): string[] {
  const tokenStages = re2TokenPatterns().flatMap(({ id, expression }) => [
    "  stage.replace {",
    `    expression = ${str(expression)}`,
    `    replace    = ${str(`<opscrew:${id}>`)}`,
    "  }",
  ]);
  return [
    "// ---- Masking, before anything leaves the server ----",
    "// The app's known values: each deploy writes them beside app.env as one RE2 alternation.",
    'local.file "mask" {',
    `  filename       = ${str(`${root}${appDir(plan)}/mask.re`)}`,
    "  is_secret      = true",
    '  poll_frequency = "10s"',
    "}",
    "",
    'loki.process "mask" {',
    "  // Values shaped like known kinds of token (OpsCrew's own patterns).",
    ...tokenStages,
    "  stage.replace {",
    "    expression = convert.nonsensitive(local.file.mask.content)",
    '    replace    = "<opscrew:known-value>"',
    "  }",
    ...sampling,
    "  forward_to = [loki.secretfilter.default.receiver]",
    "}",
    "",
  ];
}

/** Grafana Cloud's Loki writer, and the stack's. */
const CLOUD_LOGS = "loki.write.grafana_cloud.receiver";
const STACK_LOGS = "loki.write.monitoring.receiver";

/** `loki.secretfilter` (Gitleaks' rules, after OpsCrew's own), described by `comment`. */
function secretFilter(comment: string[], forwardTo: string[]): string[] {
  return [
    ...comment,
    'loki.secretfilter "default" {',
    '  redact_with = "<secretfilter:$SECRET_NAME>"',
    `  forward_to  = ${list(forwardTo)}`,
    "}",
    "",
  ];
}

/**
 * The lines' fan-out with monitoring, after masking: every line to the stack, and with Grafana
 * Cloud to its writer too, through its own sampling process when `logSampling` is below 100
 * (research R7, S7).
 */
function fanOut(grafana: GrafanaCloudSettings | undefined): string[] {
  const filtered =
    "// Gitleaks' rules, after OpsCrew's own. Then every masked line to the monitoring stack";
  if (grafana === undefined) return secretFilter([`${filtered}.`], [STACK_LOGS]);
  const sampling = samplingStages(grafana);
  if (sampling.length === 0) {
    return secretFilter([`${filtered},`, "// and to Grafana Cloud."], [STACK_LOGS, CLOUD_LOGS]);
  }
  return [
    ...secretFilter(
      [
        `${filtered},`,
        "// and through the sampling (on Grafana Cloud's branch only) to Grafana Cloud.",
      ],
      [STACK_LOGS, "loki.process.grafana_cloud.receiver"],
    ),
    'loki.process "grafana_cloud" {',
    ...sampling,
    `  forward_to = [${CLOUD_LOGS}]`,
    "}",
    "",
  ];
}

/** The stage keeping `grafanaCloud.logSampling`% of the lines, when it is below 100. */
function samplingStages(grafana: GrafanaCloudSettings): string[] {
  if (grafana.logSampling === 100) return [];
  return [
    `  // ${grafana.logSampling}% of the log lines (grafanaCloud.logSampling in the plan).`,
    "  stage.sampling {",
    `    rate = ${grafana.logSampling / 100}`,
    "  }",
  ];
}

/** The server's CPU, load, memory and filesystems, from Alloy's own `/proc` and the server's `paths`. */
function hostExporter(paths: { root: string; sys: string }): string[] {
  return [
    'prometheus.exporter.unix "host" {',
    `  rootfs_path    = ${str(paths.root)}`,
    `  sysfs_path     = ${str(paths.sys)}`,
    '  set_collectors = ["cpu", "loadavg", "meminfo", "filesystem"]',
    "  filesystem {",
    '    mount_points_exclude = "^/.+"',
    "  }",
    "}",
    "",
  ];
}

/** The server's figures kept to the allow-list, then to `forwardTo`. */
function hostAllowList(forwardTo: string[]): string[] {
  return [
    'prometheus.relabel "allow" {',
    "  rule {",
    '    source_labels = ["__name__"]',
    `    regex         = ${str(METRICS_KEPT)}`,
    '    action        = "keep"',
    "  }",
    "  rule {",
    '    source_labels = ["__name__", "mode"]',
    `    regex         = ${str(`node_cpu_seconds_total;(${CPU_MODES_DROPPED})`)}`,
    '    action        = "drop"',
    "  }",
    `  forward_to = ${list(forwardTo)}`,
    "}",
    "",
  ];
}

/**
 * Each container's figures from cAdvisor on the cgroups only, named through `discovery.docker`
 * (research R7, S1), and the server's network traffic from cAdvisor's root cgroup.
 */
function containerFigures(plan: DeployPlan): string[] {
  const projects = [plan.app.name, ...OPSCREW_PROJECTS].join("|");
  return [
    "// ---- Each container's figures: cAdvisor on the cgroups only ----",
    "// Its Docker integration is off (a socket that doesn't exist): it would need containerd's socket",
    "// or /var/lib/docker. The containers' names and Compose services come from discovery.docker,",
    "// through the read-only proxy.",
    'prometheus.exporter.cadvisor "containers" {',
    '  docker_host                 = "unix:///nonexistent/docker.sock"',
    "  docker_only                 = true",
    '  raw_cgroup_prefix_allowlist = ["/docker/", "/system.slice/docker-"]',
    '  enabled_metrics             = ["cpu", "memory", "oom_event", "network"]',
    "  store_container_labels      = false",
    "}",
    "",
    "// One target per container of the app's Compose project and OpsCrew's own, each reading",
    "// cAdvisor's figures on Alloy's own HTTP server and keeping that container's only.",
    'discovery.docker "containers" {',
    `  host = ${str(PROXY_SOCKET)}`,
    "}",
    "",
    'discovery.relabel "containers" {',
    "  targets = discovery.docker.containers.targets",
    "  rule {",
    '    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]',
    `    regex         = ${str(projects)}`,
    '    action        = "keep"',
    "  }",
    "  rule {",
    '    source_labels = ["__meta_docker_container_id"]',
    '    target_label  = "container_id"',
    "  }",
    "  rule {",
    '    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]',
    '    target_label  = "service"',
    "  }",
    "  rule {",
    '    source_labels = ["__meta_docker_container_name"]',
    '    regex         = "/(.*)"',
    '    target_label  = "container"',
    "  }",
    "  rule {",
    '    target_label = "__address__"',
    `    replacement  = ${str(HTTP_ADDRESS)}`,
    "  }",
    "  rule {",
    '    target_label = "__metrics_path__"',
    '    replacement  = "/api/v0/component/prometheus.exporter.cadvisor.containers/metrics"',
    "  }",
    "  rule {",
    '    target_label = "instance"',
    `    replacement  = ${str(`opscrew-alloy-${plan.app.name}`)}`,
    "  }",
    "  rule {",
    '    target_label = "job"',
    '    replacement  = "integrations/cadvisor"',
    "  }",
    "}",
    "",
    'prometheus.scrape "containers" {',
    "  targets         = discovery.relabel.containers.output",
    `  scrape_interval = ${str(SCRAPE_INTERVAL)}`,
    "  forward_to      = [prometheus.relabel.containers.receiver]",
    "}",
    "",
    'prometheus.relabel "containers" {',
    "  // The container's id from its cgroup: /docker/<id> (cgroupfs) or /system.slice/docker-<id>.scope",
    "  // (systemd); kept only when it is this target's container.",
    "  rule {",
    '    source_labels = ["id"]',
    '    regex         = ".*(?:/|docker-)([0-9a-f]{64})(?:[.]scope)?"',
    '    target_label  = "cgroup_container_id"',
    "  }",
    "  rule {",
    '    source_labels = ["cgroup_container_id"]',
    '    target_label  = "container_id"',
    '    action        = "keepequal"',
    "  }",
    "  rule {",
    '    source_labels = ["__name__"]',
    `    regex         = ${str(CONTAINER_METRICS_KEPT)}`,
    '    action        = "keep"',
    "  }",
    "  rule {",
    '    regex  = "cgroup_container_id|id"',
    '    action = "labeldrop"',
    "  }",
    "  forward_to = [prometheus.remote_write.monitoring.receiver]",
    "}",
    "",
    "// ---- The server's network traffic ----",
    "// cAdvisor's root cgroup reads /rootfs/proc/1/net/dev (the server's network); Alloy's own",
    "// /proc/net/dev is its bridge's.",
    'prometheus.scrape "host_network" {',
    "  targets         = prometheus.exporter.cadvisor.containers.targets",
    '  job_name        = "integrations/cadvisor_host"',
    `  scrape_interval = ${str(SCRAPE_INTERVAL)}`,
    "  forward_to      = [prometheus.relabel.host_network.receiver]",
    "}",
    "",
    'prometheus.relabel "host_network" {',
    "  rule {",
    '    source_labels = ["__name__", "id"]',
    '    regex         = "container_network_(receive|transmit)_bytes_total;/"',
    '    action        = "keep"',
    "  }",
    "  // Loopback, Docker's bridges and container ends, and WireGuard (its traffic also crosses the",
    "  // physical interface).",
    "  rule {",
    '    source_labels = ["interface"]',
    `    regex         = ${str(INTERFACES_DROPPED)}`,
    '    action        = "drop"',
    "  }",
    "  rule {",
    '    regex  = "id"',
    '    action = "labeldrop"',
    "  }",
    "  forward_to = [prometheus.remote_write.monitoring.receiver]",
    "}",
    "",
  ];
}

/**
 * Caddy's figures from its metrics site on the edge's network (research R7, S5), for the plan's
 * hostnames ({@link siteHosts}) only.
 */
function caddyFigures(plan: DeployPlan): string[] {
  // The Host header as sent, a port included when the client gives one; none on Caddy's process.
  const hosts = `(${["", ...siteHosts(plan).map(escapeRegExp)].join("|")})(:[0-9]+)?`;
  return [
    "// ---- Caddy's figures, from its metrics site on the edge's network ----",
    'prometheus.scrape "caddy" {',
    `  targets         = [{ __address__ = ${str(`${CADDY_SERVICE}:${CADDY_METRICS_PORT}`)} }]`,
    '  job_name        = "caddy"',
    `  scrape_interval = ${str(SCRAPE_INTERVAL)}`,
    "  forward_to      = [prometheus.relabel.caddy.receiver]",
    "}",
    "",
    'prometheus.relabel "caddy" {',
    "  rule {",
    '    source_labels = ["__name__"]',
    `    regex         = ${str(CADDY_METRICS_KEPT)}`,
    '    action        = "keep"',
    "  }",
    "  // This app's hostnames only: the edge serves every OpsCrew app on the server. Series with no",
    "  // host (Caddy's process) are kept.",
    "  rule {",
    '    source_labels = ["host"]',
    `    regex         = ${str(hosts)}`,
    '    action        = "keep"',
    "  }",
    "  // The metrics site's own requests (these scrapes).",
    "  rule {",
    '    source_labels = ["handler"]',
    '    regex         = "metrics"',
    '    action        = "drop"',
    "  }",
    "  // Caddy's own `server` label (srv0, srv1 …) would hide OpsCrew's: a series keeps its own label",
    "  // over an external one. Renamed.",
    "  rule {",
    '    source_labels = ["server"]',
    '    target_label  = "caddy_server"',
    "  }",
    "  rule {",
    '    regex  = "server"',
    '    action = "labeldrop"',
    "  }",
    "  // Its Compose service, as on its container's figures, so its process figures are told apart.",
    "  rule {",
    '    target_label = "service"',
    `    replacement  = ${str(CADDY_SERVICE)}`,
    "  }",
    "  forward_to = [prometheus.remote_write.monitoring.receiver]",
    "}",
    "",
  ];
}

/**
 * Postgres's figures as `opscrew_monitor` (`LOGIN` and `pg_monitor` only), its whole data source
 * read from its file: Alloy can't build one from a secret password (research R7, "Postgres").
 */
function postgresFigures(postgres: PlanService): string[] {
  return [
    "// ---- Postgres's figures, as opscrew_monitor (it can log in and read the statistics only) ----",
    'local.file "postgres" {',
    `  filename  = ${str(inContainer(POSTGRES_FILE))}`,
    "  is_secret = true",
    "}",
    "",
    'prometheus.exporter.postgres "postgres" {',
    "  data_source_names  = [local.file.postgres.content]",
    '  enabled_collectors = ["database", "stat_database"]',
    "}",
    "",
    'prometheus.scrape "postgres" {',
    "  targets         = prometheus.exporter.postgres.postgres.targets",
    `  scrape_interval = ${str(SCRAPE_INTERVAL)}`,
    "  forward_to      = [prometheus.relabel.postgres.receiver]",
    "}",
    "",
    'prometheus.relabel "postgres" {',
    "  rule {",
    '    source_labels = ["__name__"]',
    `    regex         = ${str(POSTGRES_METRICS_KEPT)}`,
    '    action        = "keep"',
    "  }",
    "  rule {",
    '    source_labels = ["datname"]',
    '    regex         = "template[01]"',
    '    action        = "drop"',
    "  }",
    "  // postgres_exporter's own `server` label (host:port, on pg_stat_activity_* and pg_settings_*)",
    "  // would hide OpsCrew's, as Caddy's does. Renamed.",
    "  rule {",
    '    source_labels = ["server"]',
    '    target_label  = "pg_server"',
    "  }",
    "  rule {",
    '    regex  = "server"',
    '    action = "labeldrop"',
    "  }",
    "  rule {",
    '    target_label = "service"',
    `    replacement  = ${str(postgres.name)}`,
    "  }",
    "  forward_to = [prometheus.remote_write.monitoring.receiver]",
    "}",
    "",
  ];
}

/** Basic auth as Grafana Cloud's `user`, the token from its file. */
function basicAuth(user: string): string[] {
  return [
    "    basic_auth {",
    `      username = ${str(user)}`,
    "      password = local.file.token.content",
    "    }",
  ];
}

/** The token's file and Grafana Cloud's Loki writer. */
function grafanaCloudLogs(logs: { url: string; user: string }): string[] {
  return [
    "// ---- Sending to your Grafana Cloud stack ----",
    'local.file "token" {',
    `  filename  = ${str(inContainer(TOKEN_FILE))}`,
    "  is_secret = true",
    "}",
    "",
    'loki.write "grafana_cloud" {',
    "  endpoint {",
    `    url = ${str(logs.url)}`,
    ...basicAuth(logs.user),
    "  }",
    "}",
    "",
  ];
}

/** Grafana Cloud's Prometheus writer, labelling every figure with the app's and environment's names. */
function grafanaCloudMetrics(plan: DeployPlan, metrics: { url: string; user: string }): string[] {
  return [
    'prometheus.remote_write "grafana_cloud" {',
    `  external_labels = ${appLabels(plan)}`,
    "  endpoint {",
    `    url = ${str(metrics.url)}`,
    ...basicAuth(metrics.user),
    "  }",
    "}",
    "",
  ];
}
