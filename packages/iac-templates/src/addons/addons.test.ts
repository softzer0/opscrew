// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation in expected files, not JavaScript templates.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandRunner, Redactor, TOKEN_PATTERNS } from "@opscrew/core";
import { type FakeSecretKind, fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { IMAGES } from "../pins";
import { GRAFANA_CLOUD, HUB_KEY, observabilityPlan } from "./__fixtures__/plans";
import { type AddonKind, BESZEL_TOKEN_PLACEHOLDER, renderAddon } from "./index";
import { allowedPathPattern } from "./proxy";
import { re2TokenPatterns } from "./re2";

const BESZEL = { enabled: true, version: "0.21.1" } as const;
const AGENT_MODE = {
  ...BESZEL,
  mode: "agent",
  hubUrl: "https://beszel.example.org",
  hubKey: HUB_KEY,
} as const;

const plans = {
  "Beszel, hub mode": () => observabilityPlan({ beszel: BESZEL }),
  "Beszel, agent mode": () => observabilityPlan({ beszel: AGENT_MODE }),
  "Grafana Cloud": () => observabilityPlan({ grafanaCloud: GRAFANA_CLOUD }),
  "Grafana Cloud, sampled": () =>
    observabilityPlan({ grafanaCloud: { ...GRAFANA_CLOUD, logSampling: 25 } }),
};
const kindOf = (label: string): AddonKind =>
  label.startsWith("Beszel") ? "beszel" : "grafana-cloud";

function files(plan: DeployPlan, kind: AddonKind): Record<string, string> {
  return Object.fromEntries(renderAddon(plan, kind).map((f) => [f.path, f.content]));
}

type Service = Record<string, unknown> & { environment?: Record<string, string> };
function compose(
  plan: DeployPlan,
  kind: AddonKind,
): { services: Record<string, Service> } & {
  [key: string]: unknown;
} {
  return parse(files(plan, kind)["compose.yaml"] as string);
}

describe("renderAddon", () => {
  for (const [label, planFor] of Object.entries(plans)) {
    it(`renders ${label} (snapshot)`, () => {
      expect(files(planFor(), kindOf(label))).toMatchSnapshot();
    });
  }

  it("returns compose.yaml, the proxy's Caddyfile, and config.yml or config.alloy", () => {
    expect(Object.keys(files(plans["Beszel, hub mode"](), "beszel"))).toEqual([
      "compose.yaml",
      "Caddyfile",
      "config.yml",
    ]);
    expect(Object.keys(files(plans["Beszel, agent mode"](), "beszel"))).toEqual([
      "compose.yaml",
      "Caddyfile",
    ]);
    expect(Object.keys(files(plans["Grafana Cloud"](), "grafana-cloud"))).toEqual([
      "compose.yaml",
      "Caddyfile",
      "config.alloy",
    ]);
  });

  it("refuses an add-on the plan doesn't turn on", () => {
    expect(() => renderAddon(observabilityPlan({}), "beszel")).toThrow(/doesn't turn Beszel on/);
    expect(() =>
      renderAddon(observabilityPlan({ beszel: { ...BESZEL, enabled: false } }), "beszel"),
    ).toThrow(/doesn't turn Beszel on/);
    expect(() => renderAddon(plans["Beszel, hub mode"](), "grafana-cloud")).toThrow(
      /doesn't turn Grafana Cloud on/,
    );
  });

  it("puts no secret in any file, and only the placeholder where Beszel's token goes", () => {
    const redactor = new Redactor();
    for (const [label, planFor] of Object.entries(plans)) {
      for (const [path, content] of Object.entries(files(planFor(), kindOf(label)))) {
        expect(redactor.redact(content), `${label}: ${path}`).toBe(content);
      }
    }
    const config = files(plans["Beszel, hub mode"](), "beszel")["config.yml"] as string;
    expect(parse(config)).toEqual({
      systems: [{ name: "shop", host: "localhost", port: 45876, token: BESZEL_TOKEN_PLACEHOLDER }],
    });
  });
});

describe("the read-only Docker proxy", () => {
  for (const kind of ["beszel", "grafana-cloud"] as const) {
    const plan = kind === "beszel" ? plans["Beszel, hub mode"]() : plans["Grafana Cloud"]();
    it(`runs hardened, with no network and the plan's memory, for ${kind}`, () => {
      expect(compose(plan, kind).services.proxy).toEqual({
        image: IMAGES.caddy.ref,
        restart: "unless-stopped",
        user: "0:${OPSCREW_DEPLOY_GID}",
        network_mode: "none",
        volumes: [
          "./Caddyfile:/etc/caddy/Caddyfile:ro",
          "/var/run/docker.sock:/var/run/docker.sock",
          "docker_ro:/run/opscrew-docker-ro",
        ],
        read_only: true,
        tmpfs: ["/data", "/config"],
        cap_add: ["NET_BIND_SERVICE"],
        mem_limit: "32m",
        memswap_limit: "32m",
        security_opt: ["no-new-privileges:true"],
        logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
        cap_drop: ["ALL"],
      });
    });

    it(`listens on the shared socket with no admin API, no certificates and no saved config, for ${kind}`, () => {
      const caddyfile = files(plan, kind).Caddyfile as string;
      for (const line of [
        "\tadmin off",
        "\tauto_https off",
        "\tpersist_config off",
        "\tbind unix//run/opscrew-docker-ro/docker.sock|0660",
        "\t\tmethod GET HEAD",
        "\t\treverse_proxy unix//var/run/docker.sock {",
        "\t\t\tflush_interval -1",
        "\t\trespond 403",
      ]) {
        expect(caddyfile.split("\n")).toContain(line);
      }
    });
  }

  /** Whether the rendered Caddyfile passes `method path` to Docker (its matcher, read back). */
  function passes(kind: AddonKind, method: string, path: string): boolean {
    const plan = kind === "beszel" ? plans["Beszel, hub mode"]() : plans["Grafana Cloud"]();
    const caddyfile = files(plan, kind).Caddyfile as string;
    const regexp = /\tpath_regexp (\S+)/.exec(caddyfile)?.[1] as string;
    const methods = /\tmethod (.+)/.exec(caddyfile)?.[1]?.split(" ") ?? [];
    return methods.includes(method) && new RegExp(regexp).test(path);
  }

  const READS = ["/_ping", "/version", "/info", "/containers/json", "/containers/abc123/stats"];
  const ALLOY_READS = ["/networks", "/containers/shop-app-1/logs", "/containers/abc123/json"];
  const REFUSED: [string, string][] = [
    ["POST", "/containers/abc123/stop"],
    ["POST", "/containers/abc123/exec"],
    ["POST", "/exec/abc123/start"],
    ["GET", "/containers/abc123/archive"],
    ["GET", "/containers/abc123/export"],
    ["GET", "/images/json"],
    ["GET", "/images/caddy/json"],
    ["GET", "/volumes"],
    ["GET", "/containers/abc123/attach"],
    ["GET", "/containers/abc123/top"],
    ["DELETE", "/containers/abc123"],
    ["PUT", "/containers/abc123/archive"],
    ["GET", "/containers/abc123%2F..%2F..%2Fimages/stats"],
    ["GET", "//images/json"],
    ["GET", "/v1.47/images/json"],
    ["GET", "/containers/json/../../images/json"],
  ];

  it.each([
    ...READS.map((path) => ["beszel", path] as const),
    ...[...READS, ...ALLOY_READS].map((path) => ["grafana-cloud", path] as const),
  ])("%s: passes GET and HEAD %s, with and without the API version", (kind, path) => {
    for (const method of ["GET", "HEAD"]) {
      expect(passes(kind, method, path)).toBe(true);
      expect(passes(kind, method, `/v1.47${path}`)).toBe(true);
    }
  });

  it.each(
    (["beszel", "grafana-cloud"] as const).flatMap((kind) =>
      REFUSED.map(([method, path]) => [kind, method, path] as const),
    ),
  )("%s: refuses %s %s", (kind, method, path) => {
    expect(passes(kind, method, path)).toBe(false);
  });

  it("refuses Beszel the logs, inspect and networks Alloy needs", () => {
    for (const path of ALLOY_READS) expect(passes("beszel", "GET", path)).toBe(false);
  });

  it("refuses POST even on an allowed path", () => {
    expect(passes("grafana-cloud", "POST", "/containers/json")).toBe(false);
  });
});

describe("Beszel", () => {
  it("in hub mode runs the hub on loopback, with its data folder, config and env file", () => {
    const { services, volumes, name } = compose(plans["Beszel, hub mode"](), "beszel");
    expect(name).toBe("opscrew-beszel");
    expect(Object.keys(services)).toEqual(["proxy", "hub", "agent"]);
    expect(services.hub).toMatchObject({
      image: IMAGES.beszel.ref,
      user: "${OPSCREW_DEPLOY_UID}:${OPSCREW_DEPLOY_GID}",
      ports: ["127.0.0.1:8090:8090"],
      env_file: ["hub.env"],
      environment: { CONTAINER_DETAILS: "false", DISABLE_SSH: "true" },
      volumes: ["./data:/beszel_data", "./config.yml:/beszel_data/config.yml:ro"],
      read_only: true,
      tmpfs: ["/tmp"],
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "128m",
    });
    expect(JSON.stringify(services)).not.toContain("AUTO_LOGIN");
    expect(volumes).toEqual({ docker_ro: {} });
  });

  it("in hub mode runs the agent on the host network, through the proxy, to the local hub", () => {
    const { agent } = compose(plans["Beszel, hub mode"](), "beszel").services;
    expect(agent).toMatchObject({
      image: IMAGES.beszelAgent.ref,
      user: "${OPSCREW_DEPLOY_UID}:${OPSCREW_DEPLOY_GID}",
      network_mode: "host",
      env_file: ["agent.env"],
      environment: {
        HUB_URL: "http://127.0.0.1:8090",
        DISABLE_SSH: "true",
        DOCKER_HOST: "unix:///run/opscrew-docker-ro/docker.sock",
        DOCKER_IMAGE_CHECK: "false",
        DATA_DIR: "/var/lib/beszel-agent",
      },
      volumes: ["docker_ro:/run/opscrew-docker-ro", "./agent_data:/var/lib/beszel-agent"],
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "64m",
    });
    // TOKEN and KEY come from agent.env (the hub's key is OpsCrew's, generated with the token).
    expect(agent?.environment).not.toHaveProperty("KEY");
    expect(agent?.environment).not.toHaveProperty("TOKEN");
  });

  it("in agent mode runs only the agent and the proxy, connected out to the user's hub", () => {
    const { services } = compose(plans["Beszel, agent mode"](), "beszel");
    expect(Object.keys(services)).toEqual(["proxy", "agent"]);
    expect(services.agent?.environment).toMatchObject({
      HUB_URL: "https://beszel.example.org",
      KEY: HUB_KEY,
    });
    expect(services.agent?.depends_on).toEqual(["proxy"]);
  });

  it("takes the plan's memory limits", () => {
    const plan = observabilityPlan({
      beszel: { ...BESZEL, memoryMb: { hub: 96, agent: 48, proxy: 24 } },
    });
    const { services } = compose(plan, "beszel");
    expect([services.hub, services.agent, services.proxy].map((s) => s?.mem_limit)).toEqual([
      "96m",
      "48m",
      "24m",
    ]);
  });

  it("runs another version by its tag, and says it is not pinned by digest", () => {
    const content = files(
      observabilityPlan({ beszel: { ...BESZEL, version: "0.21.0" } }),
      "beszel",
    )["compose.yaml"] as string;
    const { services } = parse(content);
    expect(services.hub.image).toBe("henrygd/beszel:0.21.0");
    expect(services.agent.image).toBe("henrygd/beszel-agent:0.21.0");
    expect(content).toContain("is pinned by tag only, not by digest");
  });
});

describe("Grafana Alloy", () => {
  it("runs unprivileged, on its own network, with / and /sys read-only and no Docker socket", () => {
    const { services, name } = compose(plans["Grafana Cloud"](), "grafana-cloud");
    expect(name).toBe("opscrew-alloy");
    const alloy = services.alloy as Service;
    expect(alloy).toMatchObject({
      image: IMAGES.alloy.ref,
      // A fixed hostname, the metrics' `instance`: a recreated container keeps its series.
      hostname: "opscrew-alloy-shop",
      user: "${OPSCREW_DEPLOY_UID}:${OPSCREW_DEPLOY_GID}",
      command: [
        "run",
        "--storage.path=/var/lib/opscrew-alloy",
        "--disable-reporting",
        "/etc/alloy/config.alloy",
      ],
      environment: { GOMEMLIMIT: "204MiB" },
      volumes: [
        "./config.alloy:/etc/alloy/config.alloy:ro",
        "./grafana_cloud_credential:/etc/alloy/grafana_cloud_credential:ro",
        "./data:/var/lib/opscrew-alloy",
        "docker_ro:/run/opscrew-docker-ro",
        "/:/host/root:ro",
        "/sys:/host/sys:ro",
      ],
      read_only: true,
      tmpfs: ["/tmp"],
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "256m",
    });
    // Nothing privileged: no host network, no Docker socket, no writable host folder.
    expect(alloy).not.toHaveProperty("privileged");
    expect(alloy).not.toHaveProperty("network_mode");
    expect(alloy).not.toHaveProperty("cap_add");
    const volumes = alloy.volumes as string[];
    expect(volumes.join(" ")).not.toContain("docker.sock");
    for (const volume of volumes.filter((v) => v.startsWith("/"))) expect(volume).toMatch(/:ro$/);
  });

  it("sets GOMEMLIMIT at 80% of the plan's limit", () => {
    const plan = observabilityPlan({
      grafanaCloud: { ...GRAFANA_CLOUD, memoryMb: { alloy: 256, proxy: 32 } },
    });
    expect(compose(plan, "grafana-cloud").services.alloy?.environment).toEqual({
      GOMEMLIMIT: "204MiB",
    });
  });

  const config = (plan: DeployPlan = plans["Grafana Cloud"]()) =>
    files(plan, "grafana-cloud")["config.alloy"] as string;

  it("tails only the app's Compose project through the proxy, labelled app, env and service", () => {
    const text = config();
    expect(text).toContain('  host = "unix:///run/opscrew-docker-ro/docker.sock"');
    expect(text).toContain('    values = ["com.docker.compose.project=shop"]');
    expect(text).toContain('  labels     = { app = "shop", env = "prod" }');
    expect(text).toContain(
      '    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]',
    );
    expect(text).toContain('    target_label  = "service"');
  });

  it("masks with OpsCrew's token patterns, then the known values, then loki.secretfilter", () => {
    const text = config();
    for (const id of Object.keys(TOKEN_PATTERNS)) {
      expect(text).toContain(`    replace    = "<opscrew:${id}>"`);
    }
    expect(text).toContain(
      [
        'local.file "mask" {',
        '  filename       = "/host/root/srv/apps/shop/mask.re"',
        "  is_secret      = true",
        '  poll_frequency = "10s"',
        "}",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        "  stage.replace {",
        "    expression = convert.nonsensitive(local.file.mask.content)",
        '    replace    = "<opscrew:known-value>"',
        "  }",
        "  forward_to = [loki.secretfilter.default.receiver]",
      ].join("\n"),
    );
    expect(text).toContain("  forward_to  = [loki.write.grafana_cloud.receiver]");
    expect(text).not.toContain("stage.sampling");
  });

  it("samples the log lines when logSampling is below 100", () => {
    expect(config(plans["Grafana Cloud, sampled"]())).toContain(
      ["  stage.sampling {", "    rate = 0.25", "  }"].join("\n"),
    );
  });

  it("sends with basic auth, each endpoint's user and the token from its file", () => {
    const text = config();
    expect(text).toContain(
      [
        'local.file "token" {',
        '  filename  = "/etc/alloy/grafana_cloud_credential"',
        "  is_secret = true",
        "}",
      ].join("\n"),
    );
    for (const [component, endpoint, labels] of [
      ["loki.write", GRAFANA_CLOUD.logs, []],
      [
        "prometheus.remote_write",
        GRAFANA_CLOUD.metrics,
        // The app's and environment's names on every series, as on the log lines.
        ['  external_labels = { app = "shop", env = "prod" }'],
      ],
    ] as const) {
      expect(text).toContain(
        [
          `${component} "grafana_cloud" {`,
          ...labels,
          "  endpoint {",
          `    url = "${endpoint.url}"`,
          "    basic_auth {",
          `      username = "${endpoint.user}"`,
          "      password = local.file.token.content",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
    }
  });

  it("sends the server's CPU, load, memory and root filesystem from its own /proc", () => {
    const text = config();
    expect(text).toContain(
      [
        'prometheus.exporter.unix "host" {',
        '  rootfs_path    = "/host/root"',
        '  sysfs_path     = "/host/sys"',
        '  set_collectors = ["cpu", "loadavg", "meminfo", "filesystem"]',
        "  filesystem {",
        '    mount_points_exclude = "^/.+"',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(text).not.toContain("procfs_path");
    expect(text).toContain(
      '    regex         = "node_cpu_seconds_total;(nice|irq|softirq|guest|guest_nice)"',
    );
    expect(text).not.toContain("netdev");
  });
});

/** A sample of each token pattern's kind, and the text around it in a log line. */
const SAMPLES: Record<keyof typeof TOKEN_PATTERNS, { kind: FakeSecretKind; before?: string }> = {
  "github-token": { kind: "github-token" },
  "github-pat": { kind: "github-pat" },
  "anthropic-api-key": { kind: "anthropic-key" },
  "openai-api-key": { kind: "openai-key" },
  "aws-access-key-id": { kind: "aws-access-key-id" },
  "aws-secret-access-key": { kind: "aws-secret-access-key", before: "AWS_SECRET_ACCESS_KEY=" },
  "stripe-secret-key": { kind: "stripe-live-key" },
  "slack-token": { kind: "slack-bot-token" },
  "digitalocean-token": { kind: "digitalocean-token" },
  "google-api-key": { kind: "google-api-key" },
  jwt: { kind: "supabase-anon-jwt" },
};

/** What Alloy's `stage.replace` does: each match's capture groups replaced, the rest kept. */
function alloyReplace(expression: string, line: string, replace: string): string {
  const insensitive = expression.startsWith("(?i)");
  const pattern = new RegExp(
    insensitive ? expression.slice(4) : expression,
    `gd${insensitive ? "i" : ""}`,
  );
  let out = "";
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const [start, end] = match.indices?.[1] ?? [0, 0];
    out += line.slice(cursor, start) + replace;
    cursor = end;
  }
  return out + line.slice(cursor);
}

describe("OpsCrew's token patterns in RE2", () => {
  const patterns = re2TokenPatterns();

  it("covers every pattern in core's TOKEN_PATTERNS", () => {
    expect(patterns.map((p) => p.id)).toEqual(Object.keys(TOKEN_PATTERNS));
  });

  it.each(patterns)("$id uses only RE2 syntax, with one capture group", ({ expression }) => {
    // No lookaround, backreference, named group, atomic group or possessive quantifier.
    expect(expression).not.toMatch(/\(\?<?[=!]|\\[1-9]|\(\?<|\(\?P?<|\(\?>|[+*?}]\+/);
    // RE2 repeats at most 1,000 times.
    for (const [, n] of expression.matchAll(/\{(\d+)(?:,\d*)?\}/g))
      expect(Number(n)).toBeLessThanOrEqual(1000);
    for (const [, , m] of expression.matchAll(/\{(\d+),(\d+)\}/g))
      expect(Number(m)).toBeLessThanOrEqual(1000);
    expect(expression.match(/\((?!\?)/g)).toHaveLength(1);
  });

  it.each(patterns)(
    "$id masks its kind of token in a log line, and only the token",
    ({ id, expression }) => {
      const { kind, before = "token " } = SAMPLES[id];
      const secret = fakeSecret(kind);
      for (const line of [`${before}${secret}`, `level=info msg="${before}${secret}" done`]) {
        const masked = alloyReplace(expression, line, `<opscrew:${id}>`);
        expect(masked).not.toContain(secret);
        expect(masked).toBe(line.replace(secret, `<opscrew:${id}>`));
      }
    },
  );

  it("compiles every expression with Go's regexp (RE2), when Go is installed", async (test) => {
    const runner = new NodeCommandRunner();
    const go = await runner.run("go", ["version"]).catch(() => undefined);
    if (go?.exitCode !== 0) test.skip("go is not on PATH; the syntax checks above still ran");
    const dir = await mkdtemp(join(tmpdir(), "opscrew-re2-"));
    const expressions = [
      ...patterns.map((p) => p.expression),
      allowedPathPattern("beszel"),
      allowedPathPattern("grafana-cloud"),
    ];
    await writeFile(
      join(dir, "main.go"),
      [
        "package main",
        'import "regexp"',
        "func main() {",
        ...expressions.map((e) => `\tregexp.MustCompile(${JSON.stringify(e)})`),
        "}",
      ].join("\n"),
    );
    const run = await runner.run("go", ["run", "main.go"], {
      cwd: dir,
      env: { ...process.env, GOCACHE: join(dir, "cache"), GO111MODULE: "off" },
    });
    expect(run.exitCode, run.stderr).toBe(0);
  }, 120_000);
});
