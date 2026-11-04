import { MONITORING_GRAFANA_PORT, MONITORING_PUSH_PORT } from "@opscrew/plan-schema";
import { addonImage, composeFile, goMemLimit } from "../addons/compose";
import { IMAGES } from "../pins";
import { memoryLimit } from "../runtime/components";
import { hardened } from "../runtime/services";
import { generatedBy } from "./header";
import type { MonitoringStackInput } from "./index";

/**
 * The stack's Docker network that the Alloy on the stack's own server joins, to push to the front
 * by its service name (`front`). Created by the stack's Compose file under this exact name.
 */
export const MONITORING_PUSH_NETWORK = "opscrew-monitoring-push";

/** The stack's Compose project. */
export const MONITORING_PROJECT = "opscrew-monitoring";

/** Grafana's admin password file in the stack's folder, and where Grafana reads it. */
export const GRAFANA_CREDENTIAL_FILE = "grafana_admin_credential";
const GRAFANA_CREDENTIAL_IN_CONTAINER = `/run/opscrew/${GRAFANA_CREDENTIAL_FILE}`;

/** Where Grafana reads OpsCrew's dashboards (the stack's `grafana/dashboards/`). */
export const GRAFANA_DASHBOARDS_IN_CONTAINER = "/etc/grafana/dashboards";

/** The networks: `stack` has no route out; `published` carries the two published services. */
const STACK = "stack";
const PUBLISHED = "published";
const PUSH = "push";

/**
 * The bundled Grafana plugins with a backend that OpsCrew doesn't use: each would start a process of
 * its own (research R7, S3).
 */
const UNUSED_GRAFANA_PLUGINS = [
  "cloudwatch",
  "elasticsearch",
  "grafana-postgresql-datasource",
  "grafana-pyroscope-datasource",
  "influxdb",
  "jaeger",
  "mssql",
  "mysql",
  "opentsdb",
  "stackdriver",
  "tempo",
  "zipkin",
];

/** Grafana's links to grafana.com point at a closed local port, so its pages never fetch from it. */
const CLOSED_PORT = "http://127.0.0.1:9";

/** Grafana's settings: nothing open without a login, and nothing that calls home (research R7, S3). */
const GRAFANA_SETTINGS = {
  GF_SECURITY_ADMIN_PASSWORD: `$$__file{${GRAFANA_CREDENTIAL_IN_CONTAINER}}`,
  GF_SECURITY_DISABLE_GRAVATAR: "true",
  GF_USERS_ALLOW_SIGN_UP: "false",
  GF_USERS_ALLOW_ORG_CREATE: "false",
  GF_AUTH_ANONYMOUS_ENABLED: "false",
  GF_SNAPSHOTS_EXTERNAL_ENABLED: "false",
  GF_PUBLIC_DASHBOARDS_ENABLED: "false",
  GF_METRICS_ENABLED: "false",
  GF_ANALYTICS_REPORTING_ENABLED: "false",
  GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
  GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false",
  GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: "false",
  GF_NEWS_NEWS_FEED_ENABLED: "false",
  GF_PLUGINS_PREINSTALL_DISABLED: "true",
  GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED: "true",
  GF_PLUGINS_PLUGIN_ADMIN_ENABLED: "false",
  GF_GRAFANA_COM_URL: CLOSED_PORT,
  GF_GRAFANA_COM_API_URL: `${CLOSED_PORT}/api`,
  GF_PLUGINS_DISABLE_PLUGINS: UNUSED_GRAFANA_PLUGINS.join(","),
};

/** A healthcheck that runs `command` in the container's shell every 30 seconds. */
function healthcheck(command: string, startPeriod: string): object {
  return {
    test: ["CMD-SHELL", command],
    interval: "30s",
    timeout: "5s",
    start_period: startPeriod,
  };
}

/** `wget` of `url`, quietly, the body discarded. */
const fetches = (url: string) => `wget -q -O /dev/null ${url}`;

/**
 * The stack's `compose.yaml` (project {@link MONITORING_PROJECT}): Prometheus, Loki, Grafana and
 * the front, each with a read-only root, no capability (the front only binds), the image's own
 * user (the front 65534), the plan's memory limit with `GOMEMLIMIT` at 80% of it, and its data on a
 * named volume. Prometheus and Loki are only on the internal `stack` network. Grafana is published
 * on the server's loopback and on each private address, where the network's filter admits only
 * devices (none until one is added), so a new device reaches it with no change to the stack; the
 * front on each private address at {@link MONITORING_PUSH_PORT}, and on the push network the Alloy
 * on this server joins.
 */
export function renderMonitoringCompose(input: MonitoringStackInput): string {
  const { settings, networks, plan } = input;
  const { memoryMb, retention, versions } = settings;
  const prometheus = addonImage(IMAGES.prometheus.ref, `v${versions.prometheus}`);
  const loki = addonImage(IMAGES.loki.ref, versions.loki);
  const grafana = addonImage(IMAGES.grafana.ref, versions.grafana);
  const addresses = networks.map((network) => network.address);
  const publish = (port: number, on: string[]) => on.map((address) => `${address}:${port}:${port}`);
  const services = {
    prometheus: {
      image: prometheus.image,
      restart: "unless-stopped",
      command: [
        "--config.file=/etc/prometheus/prometheus.yml",
        "--storage.tsdb.path=/prometheus",
        `--storage.tsdb.retention.time=${retention.metricsDays}d`,
        `--storage.tsdb.retention.size=${retention.metricsMaxGb}GB`,
        "--web.enable-remote-write-receiver",
      ],
      environment: { GOMEMLIMIT: goMemLimit(memoryMb.prometheus) },
      volumes: ["./prometheus.yml:/etc/prometheus/prometheus.yml:ro", "prometheus:/prometheus"],
      healthcheck: healthcheck(fetches("http://127.0.0.1:9090/-/ready"), "30s"),
      networks: [STACK],
      read_only: true,
      ...memoryLimit(memoryMb.prometheus),
      ...hardened({ noCapabilities: true }),
    },
    loki: {
      image: loki.image,
      restart: "unless-stopped",
      command: ["-config.file=/etc/loki/loki.yaml"],
      environment: { GOMEMLIMIT: goMemLimit(memoryMb.loki) },
      volumes: ["./loki.yaml:/etc/loki/loki.yaml:ro", "loki:/loki"],
      networks: [STACK],
      read_only: true,
      // The compactor writes its retention markers in /tmp: without it nothing is ever deleted.
      tmpfs: ["/tmp"],
      ...memoryLimit(memoryMb.loki),
      ...hardened({ noCapabilities: true }),
    },
    grafana: {
      image: grafana.image,
      restart: "unless-stopped",
      environment: { GOMEMLIMIT: goMemLimit(memoryMb.grafana), ...GRAFANA_SETTINGS },
      volumes: [
        "./grafana/provisioning/datasources:/etc/grafana/provisioning/datasources:ro",
        "./grafana/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro",
        `./grafana/dashboards:${GRAFANA_DASHBOARDS_IN_CONTAINER}:ro`,
        `./${GRAFANA_CREDENTIAL_FILE}:${GRAFANA_CREDENTIAL_IN_CONTAINER}:ro`,
        "grafana:/var/lib/grafana",
      ],
      healthcheck: healthcheck(
        fetches(`http://127.0.0.1:${MONITORING_GRAFANA_PORT}/api/health`),
        "60s",
      ),
      ports: publish(MONITORING_GRAFANA_PORT, ["127.0.0.1", ...addresses]),
      networks: [STACK, PUBLISHED],
      read_only: true,
      // Its data sources' plugins talk to Grafana over Unix sockets in /tmp.
      tmpfs: ["/tmp"],
      ...memoryLimit(memoryMb.grafana),
      ...hardened({ noCapabilities: true }),
    },
    front: {
      image: IMAGES.caddy.ref,
      restart: "unless-stopped",
      user: "65534:65534",
      environment: { GOMEMLIMIT: goMemLimit(memoryMb.front) },
      volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"],
      // Loki's image has no shell or wget: the front checks that both are ready.
      healthcheck: healthcheck(
        `${fetches("http://loki:3100/ready")} && ${fetches("http://prometheus:9090/-/ready")}`,
        "60s",
      ),
      ...(addresses.length > 0 ? { ports: publish(MONITORING_PUSH_PORT, addresses) } : {}),
      networks: [STACK, PUBLISHED, PUSH],
      depends_on: ["prometheus", "loki"],
      read_only: true,
      tmpfs: ["/data:uid=65534,gid=65534,mode=0700", "/config:uid=65534,gid=65534,mode=0700"],
      // Caddy's binary carries the binding capability: without it in the bounding set it can't run.
      cap_add: ["NET_BIND_SERVICE"],
      ...memoryLimit(memoryMb.front),
      ...hardened({ noCapabilities: true }),
    },
  };
  const unpinned = [
    { name: "Prometheus", key: "prometheus", image: prometheus },
    { name: "Loki", key: "loki", image: loki },
    { name: "Grafana", key: "grafana", image: grafana },
  ] as const;
  const header = [
    generatedBy(plan),
    "OpsCrew's monitoring stack: Prometheus and Loki keep what the servers' Alloy pushes through the",
    "front, and Grafana shows it. Prometheus and Loki have no route out and no published port.",
    addresses.length > 0
      ? `The front passes only the two push paths, on ${addresses.join(", ")}.`
      : "The front passes only the two push paths, on this server's push network only.",
    addresses.length > 0
      ? `Grafana is on 127.0.0.1, and for your devices on ${addresses.join(", ")} (the filter admits devices only).`
      : "Grafana is on 127.0.0.1 only.",
    `Grafana's admin password is in ${GRAFANA_CREDENTIAL_FILE} beside this file, never in it.`,
    ...unpinned
      .filter(({ image }) => !image.pinned)
      .map(
        ({ name, key }) =>
          `${name} ${versions[key]} (monitoring.versions.${key} in the plan) is pinned by tag only, not by digest.`,
      ),
  ];
  return composeFile(header, {
    name: MONITORING_PROJECT,
    services,
    networks: {
      [STACK]: { internal: true },
      [PUBLISHED]: {},
      [PUSH]: { name: MONITORING_PUSH_NETWORK },
    },
    volumes: { prometheus: {}, loki: {}, grafana: {} },
  });
}
