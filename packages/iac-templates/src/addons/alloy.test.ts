// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation in expected files, not JavaScript templates.
// Feature 020: one Alloy on any server, sending to the monitoring stack, Grafana Cloud or both
// (plan.md 6., research R7 "The collector").
import { Redactor } from "@opscrew/core";
import {
  type DeployPlan,
  type GrafanaCloudSettings,
  MONITORING_PUSH_PORT,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CADDY_METRICS_PORT } from "../edge";
import { MONITORING_PUSH_NETWORK } from "../monitoring";
import { IMAGES } from "../pins";
import {
  GRAFANA_CLOUD,
  MONITORING,
  type MonitoredPlanOptions,
  monitoredPlan,
  observabilityPlan,
} from "./__fixtures__/plans";
import {
  type AlloyDestinations,
  renderAddon,
  renderAlloyCompose,
  renderAlloyConfig,
} from "./index";

/** The monitoring server's private address in {@link monitoredPlan}'s network. */
const STACK = { address: "10.200.4.2" };

/** Postgres on an extra server of its own: the app's server `.1`, `monitoring` `.2`, `db1` `.3`. */
const POSTGRES_ON_DB1: MonitoredPlanOptions = {
  servers: ["monitoring", "db1"],
  placed: { db: "db1" },
};

/** The plan's Grafana Cloud settings, its defaults filled in. */
function grafanaOf(plan: DeployPlan): GrafanaCloudSettings {
  const grafana = plan.observability?.grafanaCloud;
  if (grafana === undefined) throw new Error("The fixture has no Grafana Cloud.");
  return grafana;
}

/** Both destinations, Grafana Cloud's sampled to 25%. */
function bothPlan(o: MonitoredPlanOptions = {}): { plan: DeployPlan; to: AlloyDestinations } {
  const plan = monitoredPlan({ grafanaCloud: { ...GRAFANA_CLOUD, logSampling: 25 }, ...o });
  return { plan, to: { grafanaCloud: grafanaOf(plan), monitoring: STACK } };
}

function files(plan: DeployPlan, server: string, to: AlloyDestinations): Record<string, string> {
  return {
    "compose.yaml": renderAlloyCompose(plan, server, to),
    "config.alloy": renderAlloyConfig(plan, server, to),
  };
}

type Service = Record<string, unknown> & { volumes: string[]; command: string[] };
function compose(plan: DeployPlan, server: string, to: AlloyDestinations) {
  return parse(renderAlloyCompose(plan, server, to)) as {
    services: { alloy: Service; proxy: Service };
    networks?: Record<string, unknown>;
  } & Record<string, unknown>;
}

/** A top-level block of `config.alloy`, from its first line to its closing brace. */
function block(config: string, head: string): string {
  const start = config.indexOf(`\n${head} {\n`);
  if (start < 0) throw new Error(`No block ${head}`);
  return config.slice(start + 1, config.indexOf("\n}\n", start) + 2);
}

const cases: Record<string, () => Record<string, string>> = {
  "monitoring only, on the app's server": () =>
    files(monitoredPlan(POSTGRES_ON_DB1), "app", { monitoring: STACK }),
  "monitoring only, on an extra server with Postgres": () =>
    files(monitoredPlan(POSTGRES_ON_DB1), "db1", { monitoring: STACK }),
  "both destinations, on the app's server": () => {
    const { plan, to } = bothPlan();
    return files(plan, "app", to);
  },
};

describe("Alloy with monitoring", () => {
  for (const [label, render] of Object.entries(cases)) {
    it(`renders ${label} (snapshot)`, () => {
      expect(render()).toMatchSnapshot();
    });
  }

  it("renders Grafana Cloud alone as today's add-on, also where a plan's monitoring is turned off", () => {
    const plan = observabilityPlan({ grafanaCloud: GRAFANA_CLOUD });
    const today = Object.fromEntries(
      renderAddon(plan, "grafana-cloud").map((file) => [file.path, file.content]),
    );
    const alone = { "compose.yaml": today["compose.yaml"], "config.alloy": today["config.alloy"] };
    expect(files(plan, "app", { grafanaCloud: grafanaOf(plan) })).toEqual(alone);
    // Alloy reverting to Grafana Cloud only, on a plan that still has monitoring.
    const monitored = monitoredPlan({ grafanaCloud: GRAFANA_CLOUD });
    expect(files(monitored, "app", { grafanaCloud: grafanaOf(monitored) })).toEqual(alone);
  });

  it("refuses an Alloy with nowhere to send, and monitoring the plan doesn't turn on", () => {
    const plan = monitoredPlan();
    expect(() => renderAlloyConfig(plan, "app", {})).toThrow(/nowhere to send/);
    expect(() => renderAlloyCompose(plan, "app", {})).toThrow(/nowhere to send/);
    const unmonitored = observabilityPlan({});
    expect(() => renderAlloyCompose(unmonitored, "app", { monitoring: STACK })).toThrow(
      /doesn't turn monitoring on/,
    );
  });

  it("tails the app's Compose project on each server it runs on, labelled app, env, server and service", () => {
    const plan = monitoredPlan(POSTGRES_ON_DB1);
    for (const server of ["app", "db1"]) {
      const text = renderAlloyConfig(plan, server, { monitoring: STACK });
      expect(text).toContain('    values = ["com.docker.compose.project=shop"]');
      expect(text).toContain(`  labels     = { app = "shop", env = "prod", server = "${server}" }`);
      expect(block(text, 'discovery.relabel "app"')).toContain('    target_label  = "service"');
    }
  });

  it("sends only figures from a server where no app service runs, such as the monitoring server", () => {
    const plan = monitoredPlan();
    const front = { monitoring: { address: "front" } };
    const text = renderAlloyConfig(plan, "monitoring", front);
    // No log source, no masking (the deploy writes no masking file there) and no Loki writer.
    for (const part of [
      'discovery.docker "app"',
      "loki.",
      "mask",
      "/srv/apps/",
      "/loki/api/v1/push",
    ]) {
      expect(text).not.toContain(part);
    }
    for (const head of [
      'prometheus.exporter.unix "host"',
      'prometheus.exporter.cadvisor "containers"',
      'prometheus.relabel "host_network"',
    ]) {
      expect(block(text, head)).toBeTruthy();
    }
    expect(block(text, 'prometheus.remote_write "monitoring"')).toContain(
      '  external_labels = { app = "shop", env = "prod", server = "monitoring" }',
    );
    expect(renderAlloyCompose(plan, "monitoring", front)).toContain(
      "# Grafana Alloy sends the figures of the server and its containers to the monitoring stack.\n",
    );
  });

  it("masks as Grafana Cloud alone does, with the known values read through /rootfs", () => {
    const today = renderAlloyConfig(observabilityPlan({ grafanaCloud: GRAFANA_CLOUD }), "app", {
      grafanaCloud: grafanaOf(observabilityPlan({ grafanaCloud: GRAFANA_CLOUD })),
    });
    const { plan, to } = bothPlan(POSTGRES_ON_DB1);
    for (const [server, destinations] of [
      ["app", to],
      ["app", { monitoring: STACK }],
      ["db1", { monitoring: STACK }],
    ] as const) {
      const text = renderAlloyConfig(plan, server, destinations);
      // The sampling moved out: the masking stages are today's unsampled ones, and come first.
      expect(block(text, 'loki.process "mask"')).toBe(block(today, 'loki.process "mask"'));
      expect(block(text, 'local.file "mask"')).toBe(
        block(today, 'local.file "mask"').replace("/host/root/", "/rootfs/"),
      );
      expect(block(text, 'loki.secretfilter "default"')).toContain(
        '  redact_with = "<secretfilter:$SECRET_NAME>"',
      );
      expect(block(text, 'loki.source.docker "app"')).toContain(
        "  forward_to = [loki.process.mask.receiver]",
      );
    }
  });

  it("fans out after masking, sampling only Grafana Cloud's branch", () => {
    const { plan, to } = bothPlan();
    const sampled = renderAlloyConfig(plan, "app", to);
    expect(block(sampled, 'loki.secretfilter "default"')).toContain(
      "  forward_to  = [loki.write.monitoring.receiver, loki.process.grafana_cloud.receiver]",
    );
    expect(block(sampled, 'loki.process "grafana_cloud"')).toContain(
      [
        "  stage.sampling {",
        "    rate = 0.25",
        "  }",
        "  forward_to = [loki.write.grafana_cloud.receiver]",
      ].join("\n"),
    );
    expect(sampled.match(/stage\.sampling/g)).toHaveLength(1);

    const whole = monitoredPlan({ grafanaCloud: GRAFANA_CLOUD });
    const unsampled = renderAlloyConfig(whole, "app", {
      grafanaCloud: grafanaOf(whole),
      monitoring: STACK,
    });
    expect(block(unsampled, 'loki.secretfilter "default"')).toContain(
      "  forward_to  = [loki.write.monitoring.receiver, loki.write.grafana_cloud.receiver]",
    );
    expect(unsampled).not.toContain("stage.sampling");

    const alone = renderAlloyConfig(monitoredPlan(), "app", { monitoring: STACK });
    expect(block(alone, 'loki.secretfilter "default"')).toContain(
      "  forward_to  = [loki.write.monitoring.receiver]",
    );
    expect(alone).not.toContain("grafana_cloud");
    expect(alone).not.toContain("stage.sampling");
  });

  it("sends the server's figures to both, and the rest to the stack only", () => {
    const { plan, to } = bothPlan();
    const text = renderAlloyConfig(plan, "app", to);
    expect(block(text, 'prometheus.relabel "allow"')).toContain(
      "  forward_to = [prometheus.remote_write.monitoring.receiver, prometheus.remote_write.grafana_cloud.receiver]",
    );
    for (const head of [
      'prometheus.relabel "containers"',
      'prometheus.relabel "host_network"',
      'prometheus.relabel "caddy"',
      'prometheus.relabel "postgres"',
    ]) {
      expect(block(text, head)).toContain(
        "  forward_to = [prometheus.remote_write.monitoring.receiver]",
      );
    }
    // Grafana Cloud's writers are today's: basic auth, the token from its file, app and env.
    const today = renderAlloyConfig(observabilityPlan({ grafanaCloud: GRAFANA_CLOUD }), "app", {
      grafanaCloud: grafanaOf(observabilityPlan({ grafanaCloud: GRAFANA_CLOUD })),
    });
    for (const head of [
      'local.file "token"',
      'loki.write "grafana_cloud"',
      'prometheus.remote_write "grafana_cloud"',
    ]) {
      expect(block(text, head)).toBe(block(today, head));
    }
  });

  it("writes to the stack's front with no login, one shard, and retries that outlast 10 minutes", () => {
    const text = renderAlloyConfig(monitoredPlan(), "app", { monitoring: STACK });
    const logs = block(text, 'loki.write "monitoring"');
    expect(logs).toContain(
      `    url                 = "http://10.200.4.2:${MONITORING_PUSH_PORT}/loki/api/v1/push"`,
    );
    expect(logs).toContain(
      ['    max_backoff_period  = "30s"', "    max_backoff_retries = 40", "  }", "}"].join("\n"),
    );
    const remote = block(text, 'prometheus.remote_write "monitoring"');
    expect(remote).toContain('  external_labels = { app = "shop", env = "prod", server = "app" }');
    expect(remote).toContain(`    url = "http://10.200.4.2:${MONITORING_PUSH_PORT}/api/v1/write"`);
    expect(remote).toContain(["    queue_config {", "      max_shards = 1", "    }"].join("\n"));
    expect(text).not.toContain("basic_auth");
  });

  it("on the stack's own server, pushes to the front by name over the push network", () => {
    const front = { monitoring: { address: "front" } };
    for (const [plan, server] of [
      [monitoredPlan(), "monitoring"],
      [monitoredPlan({ servers: [], monitoring: { where: { kind: "app" } } }), "app"],
    ] as const) {
      const text = renderAlloyConfig(plan, server, front);
      expect(text).toContain(`"http://front:${MONITORING_PUSH_PORT}/api/v1/write"`);
      // The app's server has logs to send; the monitoring server has none (no app service there).
      expect(text.includes(`"http://front:${MONITORING_PUSH_PORT}/loki/api/v1/push"`)).toBe(
        server === "app",
      );
      const { services, networks } = compose(plan, server, front);
      expect(services.alloy.networks).toContain(MONITORING_PUSH_NETWORK);
      expect(networks?.[MONITORING_PUSH_NETWORK]).toEqual({ external: true });
    }
    // Elsewhere it never joins it.
    const { services } = compose(monitoredPlan(), "app", { monitoring: STACK });
    expect(services.alloy.networks).not.toContain(MONITORING_PUSH_NETWORK);
  });

  it("reads containers from the cgroups only, named through the proxy for the app's and OpsCrew's projects", () => {
    const text = renderAlloyConfig(monitoredPlan(), "app", { monitoring: STACK });
    expect(block(text, 'prometheus.exporter.cadvisor "containers"')).toBe(
      [
        'prometheus.exporter.cadvisor "containers" {',
        '  docker_host                 = "unix:///nonexistent/docker.sock"',
        "  docker_only                 = true",
        '  raw_cgroup_prefix_allowlist = ["/docker/", "/system.slice/docker-"]',
        '  enabled_metrics             = ["cpu", "memory", "oom_event", "network"]',
        "  store_container_labels      = false",
        "}",
      ].join("\n"),
    );
    expect(block(text, 'discovery.docker "containers"')).toBe(
      [
        'discovery.docker "containers" {',
        '  host = "unix:///run/opscrew-docker-ro/docker.sock"',
        "}",
      ].join("\n"),
    );
    const targets = block(text, 'discovery.relabel "containers"');
    const keep = [
      "  rule {",
      '    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]',
      '    regex         = "shop|opscrew-edge|opscrew-beszel|opscrew-alloy|opscrew-monitoring"',
      '    action        = "keep"',
      "  }",
    ].join("\n");
    // The projects are kept first, before any target is made from a container.
    expect(targets.indexOf(keep)).toBe(targets.indexOf("  rule {"));
    expect(targets).toContain('    replacement  = "127.0.0.1:12345"');
    expect(targets).toContain(
      '    replacement  = "/api/v0/component/prometheus.exporter.cadvisor.containers/metrics"',
    );
    for (const label of ["container_id", "service", "container"]) {
      expect(targets).toContain(`    target_label  = "${label}"`);
    }
    expect(block(text, 'prometheus.relabel "containers"')).toContain(
      [
        "  rule {",
        '    source_labels = ["cgroup_container_id"]',
        '    target_label  = "container_id"',
        '    action        = "keepequal"',
        "  }",
      ].join("\n"),
    );
  });

  it("sends the server's own traffic from cAdvisor's root cgroup, without its virtual interfaces", () => {
    const network = block(
      renderAlloyConfig(monitoredPlan(), "app", { monitoring: STACK }),
      'prometheus.relabel "host_network"',
    );
    expect(network).toContain(
      '    regex         = "container_network_(receive|transmit)_bytes_total;/"',
    );
    expect(network).toContain('    regex         = "lo|veth.*|br-.*|docker.*|wg.*"');
  });

  it("scrapes Caddy on the edge's server, with its server label as caddy_server, its service, and its own scrapes dropped", () => {
    const plan = monitoredPlan(POSTGRES_ON_DB1);
    const text = renderAlloyConfig(plan, "app", { monitoring: STACK });
    expect(block(text, 'prometheus.scrape "caddy"')).toContain(
      `  targets         = [{ __address__ = "caddy:${CADDY_METRICS_PORT}" }]`,
    );
    const caddy = block(text, 'prometheus.relabel "caddy"');
    const rules = [
      [
        '    source_labels = ["handler"]',
        '    regex         = "metrics"',
        '    action        = "drop"',
      ],
      ['    source_labels = ["server"]', '    target_label  = "caddy_server"'],
      ['    regex  = "server"', '    action = "labeldrop"'],
      // Every series kept, its process figures included, as Caddy's service.
      ['    target_label = "service"', '    replacement  = "caddy"'],
    ].map((rule) => ["  rule {", ...rule, "  }"].join("\n"));
    for (const rule of rules) expect(caddy).toContain(rule);
    // In that order: the copy to caddy_server, then OpsCrew's service.
    const at = rules.map((rule) => caddy.indexOf(rule));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(compose(plan, "app", { monitoring: STACK }).services.alloy.networks).toEqual([
      "default",
      "opscrew-edge",
    ]);
    // Only this plan's hostnames (another OpsCrew app on the server shares the edge), with or
    // without a port, and the series with no host (Caddy's process).
    const hostRule = caddy.indexOf('    source_labels = ["host"]');
    const regex = JSON.parse(
      (/^ {4}regex {9}= (".*")$/m.exec(caddy.slice(hostRule)) as RegExpExecArray)[1] as string,
    ) as string;
    expect(regex).toBe("(|example\\.com|www\\.example\\.com)(:[0-9]+)?");
    // Prometheus's relabel regexes are anchored at both ends.
    const kept = (host: string) => new RegExp(`^(?:${regex})$`).test(host);
    for (const host of ["", "example.com", "www.example.com", "example.com:443"]) {
      expect(kept(host), host).toBe(true);
    }
    for (const host of [
      "other.example.org",
      "exampleXcom",
      "shop.example.com",
      "example.com.evil",
    ]) {
      expect(kept(host), host).toBe(false);
    }
    // Not on another server, nor behind nginx.
    expect(renderAlloyConfig(plan, "db1", { monitoring: STACK })).not.toContain("caddy");
    const nginx = monitoredPlan({ ...POSTGRES_ON_DB1, edge: "nginx" });
    expect(renderAlloyConfig(nginx, "app", { monitoring: STACK })).not.toContain("caddy");
    expect(compose(nginx, "app", { monitoring: STACK }).services.alloy).not.toHaveProperty(
      "networks",
    );
  });

  it("reads Postgres on its server as opscrew_monitor, its data source from a secret file", () => {
    const plan = monitoredPlan(POSTGRES_ON_DB1);
    const text = renderAlloyConfig(plan, "db1", { monitoring: STACK });
    expect(block(text, 'local.file "postgres"')).toBe(
      [
        'local.file "postgres" {',
        '  filename  = "/etc/alloy/postgres_monitor_credential"',
        "  is_secret = true",
        "}",
      ].join("\n"),
    );
    expect(block(text, 'prometheus.exporter.postgres "postgres"')).toContain(
      [
        "  data_source_names  = [local.file.postgres.content]",
        '  enabled_collectors = ["database", "stat_database"]',
      ].join("\n"),
    );
    // postgres_exporter's own `server` label (host:port) as pg_server, so OpsCrew's applies; then
    // the service.
    const relabel = block(text, 'prometheus.relabel "postgres"');
    const rules = [
      ['    source_labels = ["server"]', '    target_label  = "pg_server"'],
      ['    regex  = "server"', '    action = "labeldrop"'],
      ['    target_label = "service"', '    replacement  = "db"'],
    ].map((rule) => ["  rule {", ...rule, "  }"].join("\n"));
    for (const rule of rules) expect(relabel).toContain(rule);
    const at = rules.map((rule) => relabel.indexOf(rule));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    const { alloy } = compose(plan, "db1", { monitoring: STACK }).services;
    expect(alloy.volumes).toContain(
      "./postgres_monitor_credential:/etc/alloy/postgres_monitor_credential:ro",
    );
    expect(alloy.networks).toEqual(["default", "shop_internal"]);
    expect(compose(plan, "db1", { monitoring: STACK }).networks).toEqual({
      default: {},
      shop_internal: { external: true },
    });
    // Not where Postgres isn't.
    expect(renderAlloyConfig(plan, "app", { monitoring: STACK })).not.toContain("postgres");
    expect(renderAlloyCompose(plan, "app", { monitoring: STACK })).not.toContain("postgres");
  });

  it("reads on each server the Postgres that runs there, with two on two servers", () => {
    const plan = monitoredPlan({
      servers: ["monitoring", "db1", "db2"],
      placed: { db: "db1" },
      services: [
        {
          name: "analytics",
          kind: "postgres",
          version: "17",
          memoryMb: 512,
          enabled: true,
          options: {},
          reason: "The app keeps its reports apart.",
          licence: "PostgreSQL",
          server: "db2",
        },
      ],
    });
    const service = (server: string) =>
      block(renderAlloyConfig(plan, server, { monitoring: STACK }), 'prometheus.relabel "postgres"')
        .split("\n")
        .find((line) => line.startsWith("    replacement  = "));
    expect(service("db1")).toBe('    replacement  = "db"');
    expect(service("db2")).toBe('    replacement  = "analytics"');
    expect(renderAlloyConfig(plan, "app", { monitoring: STACK })).not.toContain("postgres");
  });

  it("scrapes everything every 15 seconds", () => {
    for (const render of Object.values(cases)) {
      const text = render()["config.alloy"] as string;
      const scrapes = text.match(/^prometheus\.scrape "/gm)?.length ?? 0;
      expect(scrapes).toBeGreaterThanOrEqual(4);
      expect(text.match(/^ {2}scrape_interval = "15s"$/gm)).toHaveLength(scrapes);
    }
  });

  it("runs unprivileged with / and /sys read-only at /rootfs and /sys, its HTTP server on loopback", () => {
    const plan = monitoredPlan(POSTGRES_ON_DB1);
    const { services, name } = compose(plan, "app", { monitoring: STACK });
    expect(name).toBe("opscrew-alloy");
    const { alloy } = services;
    expect(alloy).toMatchObject({
      image: IMAGES.alloy.ref,
      hostname: "opscrew-alloy-shop",
      user: "${OPSCREW_DEPLOY_UID}:${OPSCREW_DEPLOY_GID}",
      command: [
        "run",
        "--storage.path=/var/lib/opscrew-alloy",
        "--disable-reporting",
        "--server.http.listen-addr=127.0.0.1:12345",
        "/etc/alloy/config.alloy",
      ],
      volumes: [
        "./config.alloy:/etc/alloy/config.alloy:ro",
        "./data:/var/lib/opscrew-alloy",
        "docker_ro:/run/opscrew-docker-ro",
        "/:/rootfs:ro",
        "/sys:/sys:ro",
      ],
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
    });
    expect(alloy).not.toHaveProperty("privileged");
    expect(alloy).not.toHaveProperty("cap_add");
    expect(alloy).not.toHaveProperty("network_mode");
    expect(alloy.volumes.join(" ")).not.toMatch(/docker\.sock|\/var\/lib\/docker|\/var\/run/);
    const config = renderAlloyConfig(plan, "app", { monitoring: STACK });
    expect(block(config, 'prometheus.exporter.unix "host"')).toContain(
      ['  rootfs_path    = "/rootfs"', '  sysfs_path     = "/sys"'].join("\n"),
    );
    expect(config).not.toContain("/host/");
  });

  it("mounts each credential only where it is used: the token with Grafana Cloud, the data source on Postgres's server", () => {
    // The host step deletes an unused file, and Docker would make a folder for a missing source.
    const credentials = (plan: DeployPlan, server: string, to: AlloyDestinations) =>
      compose(plan, server, to).services.alloy.volumes.filter((v) => v.includes("_credential"));
    const token = "./grafana_cloud_credential:/etc/alloy/grafana_cloud_credential:ro";
    const dataSource = "./postgres_monitor_credential:/etc/alloy/postgres_monitor_credential:ro";
    const { plan, to } = bothPlan(POSTGRES_ON_DB1);
    expect(credentials(plan, "app", to)).toEqual([token]);
    expect(credentials(plan, "app", { monitoring: STACK })).toEqual([]);
    expect(credentials(plan, "db1", { monitoring: STACK })).toEqual([dataSource]);
    expect(credentials(plan, "monitoring", { monitoring: STACK })).toEqual([]);
    const both = bothPlan();
    expect(credentials(both.plan, "app", both.to)).toEqual([token, dataSource]);
    // Grafana Cloud alone: today's file, with its token.
    const alone = observabilityPlan({ grafanaCloud: GRAFANA_CLOUD });
    expect(credentials(alone, "app", { grafanaCloud: grafanaOf(alone) })).toEqual([token]);
  });

  it("takes the memory limits of monitoring's settings", () => {
    const plain = compose(monitoredPlan(), "app", { monitoring: STACK }).services;
    expect([plain.alloy.mem_limit, plain.proxy.mem_limit]).toEqual(["256m", "32m"]);
    expect(plain.alloy.environment).toEqual({ GOMEMLIMIT: "204MiB" });
    const plan = monitoredPlan({ monitoring: { memoryMb: { alloy: 512, proxy: 64 } } });
    const { alloy, proxy } = compose(plan, "app", { monitoring: STACK }).services;
    expect([alloy.mem_limit, proxy.mem_limit]).toEqual(["512m", "64m"]);
    expect(alloy.environment).toEqual({ GOMEMLIMIT: "409MiB" });
  });

  it("runs another Alloy version by its tag, and says it is not pinned by digest", () => {
    const plan = monitoredPlan({
      monitoring: { versions: { ...MONITORING.versions, alloy: "1.21.2" } },
    });
    const text = renderAlloyCompose(plan, "app", { monitoring: STACK });
    expect(parse(text).services.alloy.image).toBe("grafana/alloy:v1.21.2");
    expect(text).toContain(
      "# Grafana Alloy 1.21.2 (observability.monitoring.versions.alloy in the plan) is pinned by tag only, not by digest.",
    );
  });

  it("puts no secret in any file", () => {
    const redactor = new Redactor();
    for (const [label, render] of Object.entries(cases)) {
      for (const [path, content] of Object.entries(render())) {
        expect(redactor.redact(content), `${label}: ${path}`).toBe(content);
        expect(content, `${label}: ${path}`).not.toMatch(/postgres(ql)?:\/\//);
      }
    }
  });
});
