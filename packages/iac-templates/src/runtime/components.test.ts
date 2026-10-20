// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and shell syntax in expected contents, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppBuild, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serviceSpec } from "../catalog";
import { GARAGE_STORAGE, type ServiceEntry, withServices } from "../catalog/__fixtures__/plans";
import { IMAGES } from "../pins";
import { withBuild, withSqlite } from "../workflow/__fixtures__/plans";
import {
  hostSettingsServices,
  renderCompose,
  renderRuntimeFiles,
  sqliteVolumeOwner,
} from "./index";

type Service = Record<string, unknown> & {
  mem_limit?: string;
  memswap_limit?: string;
  volumes?: string[];
  healthcheck?: Record<string, unknown>;
  environment?: Record<string, string>;
  labels?: Record<string, string>;
};

/** `plan` with `app.build` for `builder`, `probe` and `memoryMb`, and these processes. */
function withApp(
  plan: DeployPlan,
  o: {
    builder?: AppBuild["builder"];
    probe?: AppBuild["probe"];
    memoryMb?: number;
    workers?: Record<string, unknown>[];
    cron?: Record<string, unknown>[];
  },
): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      ...(o.memoryMb === undefined ? {} : { memoryMb: o.memoryMb }),
      ...(o.builder === undefined
        ? {}
        : {
            build: {
              builder: o.builder,
              chosen: "auto",
              reason: "test",
              runtime: { language: "node", version: "24" },
              probe: o.probe ?? "node",
            },
          }),
    },
    processes: { workers: o.workers ?? [], cron: o.cron ?? [] },
  });
}

/** The app with a worker, cron, MySQL and RabbitMQ (the acceptance snapshot). */
const FULL = withApp(withServices([{ kind: "mysql" }, { kind: "rabbitmq" }]), {
  builder: "generated-dockerfile",
  memoryMb: 768,
  workers: [{ name: "worker", command: "node worker.js", source: "library", count: 2 }],
  cron: [
    { name: "cleanup", schedule: "*/15 * * * *", command: "node scripts/cleanup.js" },
    { name: "report", schedule: "0 * * * *", route: "/api/cron/report?full=1" },
  ],
});

function services(plan: DeployPlan): Record<string, Service> {
  return parse(renderCompose(plan).content).services;
}

describe("the services on a server", () => {
  it("renders an app with a worker, cron, MySQL and RabbitMQ (snapshot)", () => {
    const compose = renderCompose(FULL);
    expect(Object.keys(parse(compose.content).services)).toEqual([
      "app",
      "worker",
      "cron",
      "mysql",
      "rabbitmq",
    ]);
    expect(compose.content).toMatchSnapshot();
    const files = renderRuntimeFiles(FULL);
    expect(files.map((file) => file.path)).toEqual([
      "opscrew/runtime/services/mysql/my.cnf",
      "opscrew/runtime/services/rabbitmq/rabbitmq.conf",
      "opscrew/runtime/crontab",
      "opscrew/runtime/edge/compose.yaml",
    ]);
    // The edge's file has its own tests and snapshots (src/edge).
    for (const file of files.filter((f) => !f.path.startsWith("opscrew/runtime/edge/"))) {
      expect(file.kind).toBe("runtime");
      expect(file.content).toMatchSnapshot(file.path);
    }
  });

  it("gives every service a memory limit, its health check, the internal network and no ports", () => {
    const plan = withServices(
      [
        { kind: "postgres" },
        { kind: "valkey", options: { mode: "queue" } },
        { kind: "mysql", memoryMb: 640 },
        { kind: "mariadb" },
        { kind: "mongodb" },
        { kind: "rabbitmq" },
        { kind: "nats" },
        { kind: "kafka" },
        { kind: "redpanda" },
        { kind: "garage" },
        { kind: "opensearch" },
        { kind: "elasticsearch" },
        { kind: "meilisearch" },
        { kind: "typesense" },
        { kind: "clickhouse" },
        { kind: "neo4j" },
      ],
      { storage: GARAGE_STORAGE },
    );
    const all = services(plan);
    for (const service of plan.services) {
      const rendered = all[service.name] as Service;
      expect(rendered.image).toBe(IMAGES[serviceSpec(service.kind).image].ref);
      expect(rendered.mem_limit).toBe(`${service.memoryMb}m`);
      expect(rendered.memswap_limit).toBe(rendered.mem_limit);
      expect(rendered.restart).toBe("unless-stopped");
      expect(rendered.networks).toEqual(["internal"]);
      expect(rendered.ports).toBeUndefined();
      expect(rendered.healthcheck).toMatchObject({ interval: "10s", retries: 6 });
      expect(rendered.security_opt).toEqual(["no-new-privileges:true"]);
    }
    expect(all.mysql?.mem_limit).toBe("640m");
    expect(all.app?.depends_on).toEqual(
      Object.fromEntries(plan.services.map((s) => [s.name, { condition: "service_healthy" }])),
    );
  });

  it("keeps the data under /srv/data/<app>/<service>, or in a volume for images that run as their own user", () => {
    const all = services(
      withServices([{ kind: "mysql" }, { kind: "mongodb" }, { kind: "kafka" }, { kind: "garage" }]),
    );
    expect(all.mysql?.volumes?.[0]).toBe("/srv/data/shop/mysql:/var/lib/mysql");
    expect(all.mongodb?.volumes).toEqual([
      "/srv/data/shop/mongodb/db:/data/db",
      "/srv/data/shop/mongodb/configdb:/data/configdb",
    ]);
    expect(all.garage?.volumes?.[0]).toBe("/srv/data/shop/garage:/var/lib/garage");
    // With the folders its image also declares as volumes: none is left anonymous.
    expect(all.kafka?.volumes).toEqual([
      "kafka_data:/var/lib/kafka/data",
      "kafka_secrets:/etc/kafka/secrets",
      "kafka_config:/mnt/shared/config",
    ]);
    const doc = parse(renderCompose(withServices([{ kind: "kafka" }])).content);
    expect(Object.keys(doc.volumes)).toEqual(["kafka_data", "kafka_secrets", "kafka_config"]);
  });

  it("reads a service's secrets from its env file and has the other settings inline", () => {
    const all = services(withServices([{ kind: "mysql" }, { kind: "nats" }, { kind: "kafka" }]));
    expect(all.mysql?.env_file).toEqual(["mysql.env"]);
    expect(all.mysql?.environment).toBeUndefined();
    expect(all.nats?.env_file).toEqual(["nats.env"]);
    expect(all.kafka?.env_file).toBeUndefined();
    expect(all.kafka?.environment?.KAFKA_ADVERTISED_LISTENERS).toBe("PLAINTEXT://kafka:9092");
  });

  it("mounts each settings file read-only from opscrew/runtime/services/<name>/, recreating the service when it changes", () => {
    const small = services(withServices([{ kind: "mysql" }, { kind: "nats" }, { kind: "garage" }]));
    expect(small.mysql?.volumes?.[1]).toBe(
      "./services/mysql/my.cnf:/etc/mysql/conf.d/opscrew.cnf:ro",
    );
    expect(small.nats?.volumes?.[1]).toBe(
      "./services/nats/nats.conf:/etc/nats/nats-server.conf:ro",
    );
    expect(small.garage?.volumes?.[1]).toBe("./services/garage/garage.toml:/etc/garage.toml:ro");
    const label = (all: Record<string, Service>) =>
      all.mysql?.labels?.["dev.opscrew.config-sha256"];
    const larger = services(withServices([{ kind: "mysql", memoryMb: 1024 }]));
    expect(label(small)).toMatch(/^[0-9a-f]{64}$/);
    expect(label(larger)).not.toBe(label(small));
    expect(label(services(withServices([{ kind: "mysql" }])))).toBe(label(small));
  });

  it("sets RabbitMQ's hostname and runs MongoDB with its keyFile when it is a replica set", () => {
    const all = services(
      withServices([{ kind: "rabbitmq" }, { kind: "mongodb", options: { replicaSet: true } }]),
    );
    expect(all.rabbitmq?.hostname).toBe("rabbitmq");
    // `$` would be Compose's: the script has none.
    expect(all.mongodb?.command).toEqual([
      "bash",
      "-c",
      expect.stringContaining("--replSet rs0 --keyFile /data/configdb/keyfile"),
    ]);
  });

  it("refuses a version OpsCrew does not pin", () => {
    expect(() => renderCompose(withServices([{ kind: "mysql", version: "9.7" }]))).toThrow(
      "asks for MySQL 9.7",
    );
  });

  it("leaves out a service the plan turned off", () => {
    const all = services(withServices([{ kind: "mysql", enabled: false }]));
    expect(all.mysql).toBeUndefined();
    expect(all.app?.depends_on).toBeUndefined();
    expect(
      renderRuntimeFiles(withServices([{ kind: "mysql", enabled: false }])).map((f) => f.path),
    ).toEqual(["opscrew/runtime/edge/compose.yaml"]);
  });
});

describe("the search engines' host setting", () => {
  const plan = (provider: "hetzner" | "own" = "hetzner") =>
    withServices(
      [{ kind: "opensearch" }, { kind: "elasticsearch" }, { kind: "meilisearch" }],
      {},
      { provider },
    );

  it("is raised on a cloud server by one privileged one-shot container per app, which every engine that needs it waits for (snapshot)", () => {
    const compose = renderCompose(plan());
    expect(compose.content).toMatchSnapshot();
    const all = services(plan());
    expect(Object.keys(all)).toEqual([
      "app",
      "sysctl",
      "opensearch",
      "elasticsearch",
      "meilisearch",
    ]);
    const sysctl = all.sysctl as Service;
    expect(sysctl).toMatchObject({
      image: IMAGES.caddy.ref,
      privileged: true,
      network_mode: "none",
      read_only: true,
      mem_limit: "16m",
      security_opt: ["no-new-privileges:true"],
    });
    expect(sysctl.networks).toBeUndefined();
    expect(sysctl.restart).toBeUndefined();
    // Only that one setting, also in the host's /etc/sysctl.d so a restart keeps it.
    expect(sysctl.command).toEqual([
      "sh",
      "-c",
      [
        "set -e",
        "echo '# Managed by OpsCrew: kernel settings the services of its apps need.' > /etc/sysctl.d/90-opscrew.conf.tmp",
        'v=$$(sysctl -n vm.max_map_count); if [ "$$v" -lt 262144 ]; then v=262144; sysctl -w vm.max_map_count=$$v; fi; echo "vm.max_map_count = $$v" >> /etc/sysctl.d/90-opscrew.conf.tmp',
        "mv /etc/sysctl.d/90-opscrew.conf.tmp /etc/sysctl.d/90-opscrew.conf",
      ].join("; "),
    ]);
    expect(sysctl.volumes).toEqual(["/etc/sysctl.d:/etc/sysctl.d"]);
    // The engine itself gets the open-file limit it needs.
    expect(all.opensearch?.ulimits).toEqual({ nofile: { soft: 65536, hard: 65536 } });
    expect(all.meilisearch?.ulimits).toBeUndefined();
    expect(all.elasticsearch?.ulimits).toEqual({ nofile: { soft: 65536, hard: 65536 } });
    for (const engine of ["opensearch", "elasticsearch"]) {
      expect(all[engine]?.depends_on, engine).toEqual({
        sysctl: { condition: "service_completed_successfully" },
      });
    }
    expect(all.meilisearch?.depends_on).toBeUndefined();
    // The app waits for the engines, not for the one-shot container.
    expect(all.app?.depends_on).toEqual({
      opensearch: { condition: "service_healthy" },
      elasticsearch: { condition: "service_healthy" },
      meilisearch: { condition: "service_healthy" },
    });
    expect(hostSettingsServices(plan())).toEqual(["sysctl"]);
  });

  it.skipIf(spawnSync("sh", ["-c", "true"]).error !== undefined)(
    "keeps the higher of the wanted and the kernel's value, live and in the file (real shell)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "opscrew-sysctl-"));
      try {
        const root = spawnSync("sh", ["-c", 'cd "$1" && pwd', "_", dir], {
          encoding: "utf8",
        }).stdout.trim();
        const [, , command] = (services(plan()).sysctl?.command ?? []) as string[];
        const script = (command ?? "").replaceAll("$$", "$").replaceAll("/etc/sysctl.d", root);
        // The kernel's value lives in the file `live`.
        const stub = `sysctl() { if [ "$1" = -n ]; then cat "${root}/live"; else echo "\${2#*=}" > "${root}/live"; fi; }`;
        const run = (live: string) => {
          writeFileSync(join(dir, "live"), `${live}\n`);
          const result = spawnSync("sh", ["-c", `${stub}\n${script}`], { encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          return {
            live: readFileSync(join(dir, "live"), "utf8").trim(),
            file: readFileSync(join(dir, "90-opscrew.conf"), "utf8"),
          };
        };
        expect(run("65530")).toEqual({
          live: "262144",
          file: "# Managed by OpsCrew: kernel settings the services of its apps need.\nvm.max_map_count = 262144\n",
        });
        expect(run("1048576")).toEqual({
          live: "1048576",
          file: "# Managed by OpsCrew: kernel settings the services of its apps need.\nvm.max_map_count = 1048576\n",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("is left to the host plan on a server the user owns", () => {
    const all = services(plan("own"));
    expect(all.sysctl).toBeUndefined();
    expect(all.opensearch?.depends_on).toBeUndefined();
    expect(hostSettingsServices(plan("own"))).toEqual([]);
  });

  it("is left out with the engine turned off", () => {
    const off = withServices([{ kind: "elasticsearch", enabled: false }]);
    expect(services(off).sysctl).toBeUndefined();
    expect(hostSettingsServices(off)).toEqual([]);
  });
});

describe("the web service", () => {
  it("gets its memory limit from app.memoryMb, as does the release command", () => {
    const base = withServices([]);
    const plan = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, memoryMb: 1024, releaseCommand: "npm run migrate" },
    });
    const all = services(plan);
    expect(all.app?.mem_limit).toBe("1024m");
    expect(all.app?.memswap_limit).toBe("1024m");
    expect(all.release?.mem_limit).toBe("1024m");
    expect(services(withServices([])).app?.mem_limit).toBe("512m");
  });
});

describe("the workers", () => {
  const plan = withApp(withServices([{ kind: "postgres" }]), {
    builder: "generated-dockerfile",
    workers: [
      {
        name: "worker",
        command: "celery -A app worker",
        source: "library",
        count: 3,
        memoryMb: 384,
        stopGraceSeconds: 45,
      },
      { name: "beat", command: "celery -A app beat", source: "library", single: true },
      { name: "mailer", command: "node mailer.js", source: "user", enabled: false },
    ],
  });
  const all = services(plan);

  it("run one service each from the app's image, with no port, health check or capability", () => {
    expect(all.worker?.image).toBe(all.app?.image);
    expect(all.worker?.env_file).toEqual(["app.env"]);
    expect(all.worker?.ports).toBeUndefined();
    expect(all.worker?.healthcheck).toEqual({ disable: true });
    expect(all.worker?.cap_drop).toEqual(["ALL"]);
    expect(all.worker?.networks).toEqual(["internal"]);
    expect(all.worker?.restart).toBe("unless-stopped");
    expect(all.worker?.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(all.mailer).toBeUndefined();
  });

  it("get their count, grace period and memory limit from the plan", () => {
    expect(all.worker?.deploy).toEqual({ replicas: 3 });
    expect(all.worker?.stop_grace_period).toBe("45s");
    expect(all.worker?.mem_limit).toBe("384m");
    expect(all.worker?.memswap_limit).toBe("384m");
    expect(all.beat?.deploy).toEqual({ replicas: 1 });
    expect(all.beat?.stop_grace_period).toBe("30s");
    expect(all.beat?.mem_limit).toBe("256m");
  });

  it("start with exec, so the command is PID 1 and gets SIGTERM; `$` is left for the shell", () => {
    const dollar = services(
      withApp(withServices([]), {
        workers: [{ name: "worker", command: "rq worker $QUEUES", source: "user" }],
      }),
    );
    expect(dollar.worker?.command).toEqual(["sh", "-c", "exec rq worker $$QUEUES"]);
  });

  it("start the way each builder's image needs (snapshot)", () => {
    const forms = Object.fromEntries(
      (["generated-dockerfile", "own-dockerfile", "buildpacks", "railpack"] as const).map(
        (builder) => {
          const rendered = services(
            withApp(withServices([]), {
              builder,
              workers: [
                { name: "worker", command: "node worker.js", source: "procfile" },
                { name: "queue", command: "node queue.js", source: "library" },
              ],
              cron: [{ name: "cleanup", schedule: "@daily", command: "node cleanup.js" }],
            }),
          );
          const start = (s: Service | undefined) => ({
            entrypoint: s?.entrypoint,
            command: s?.command,
          });
          return [
            builder,
            {
              worker: start(rendered.worker),
              queue: start(rendered.queue),
              cron: start(rendered.cron),
            },
          ];
        },
      ),
    );
    // A Procfile worker too: its name need not be its Procfile type (design normalises names).
    expect(forms.buildpacks).toEqual({
      worker: { entrypoint: ["/cnb/lifecycle/launcher"], command: ["exec node worker.js"] },
      queue: { entrypoint: ["/cnb/lifecycle/launcher"], command: ["exec node queue.js"] },
      cron: {
        entrypoint: ["/cnb/lifecycle/launcher", "--"],
        command: ["supercronic", "/etc/opscrew/crontab"],
      },
    });
    expect(forms.railpack?.queue).toEqual({
      entrypoint: undefined,
      command: ["exec node queue.js"],
    });
    expect(forms.railpack?.cron.command).toEqual(["exec supercronic /etc/opscrew/crontab"]);
    expect(forms["own-dockerfile"]?.worker.command).toEqual(["sh", "-c", "exec node worker.js"]);
    expect(forms).toMatchSnapshot();
  });
});

describe("cron", () => {
  it("runs as one cron service of the app's image with the crontab mounted read-only", () => {
    const cron = services(FULL).cron;
    expect(cron?.command).toEqual(["supercronic", "/etc/opscrew/crontab"]);
    expect(cron?.volumes).toEqual(["./crontab:/etc/opscrew/crontab:ro"]);
    expect(cron?.env_file).toEqual(["app.env"]);
    expect(cron?.healthcheck).toEqual({ disable: true });
    expect(cron?.stop_grace_period).toBe("10s");
    // Its jobs run the app's code.
    expect(cron?.mem_limit).toBe("768m");
    expect(cron?.deploy).toBeUndefined();
  });

  it("is recreated when its crontab changes: supercronic reads it only when it starts", () => {
    const label = (schedule: string) =>
      services(
        withApp(withServices([]), {
          cron: [{ name: "cleanup", schedule, command: "node cleanup.js" }],
        }),
      ).cron?.labels?.["dev.opscrew.config-sha256"];
    expect(label("@daily")).toMatch(/^[0-9a-f]{64}$/);
    expect(label("@hourly")).not.toBe(label("@daily"));
    expect(label("@daily")).toBe(label("@daily"));
  });

  it("schedules every enabled job in UTC", () => {
    const crontab = renderRuntimeFiles(FULL).find((f) => f.path === "opscrew/runtime/crontab");
    const lines = crontab?.content.split("\n") ?? [];
    expect(lines).toContain("CRON_TZ=UTC");
    expect(lines).toContain("*/15 * * * * node scripts/cleanup.js");
  });

  it("calls a route with the CRON_SECRET bearer token through the image's probe tool", () => {
    const call = (probe: AppBuild["probe"]) => {
      const plan = withApp(withServices([]), {
        builder: "railpack",
        probe,
        cron: [{ name: "report", schedule: "0 * * * *", route: "/api/cron/report?full=1" }],
      });
      const content = renderRuntimeFiles(plan)[0]?.content ?? "";
      return content.split("\n").find((line) => line.startsWith("0 * * * * ")) ?? "";
    };
    expect(call("node")).toBe(
      `0 * * * * node -e "fetch('http://app:3000/api/cron/report?full=1',{headers:{Authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`,
    );
    expect(call("python")).toBe(
      `0 * * * * python -c "import os,urllib.request as u;u.urlopen(u.Request('http://app:3000/api/cron/report?full=1',headers={'Authorization':'Bearer '+os.environ['CRON_SECRET']}))"`,
    );
    expect(call("ruby")).toBe(
      `0 * * * * ruby -rnet/http -e "exit Net::HTTP.get_response(URI('http://app:3000/api/cron/report?full=1'),{'Authorization'=>'Bearer '+ENV['CRON_SECRET']}).is_a?(Net::HTTPSuccess)"`,
    );
    expect(call("php")).toBe(
      `0 * * * * php -r "exit(@file_get_contents('http://app:3000/api/cron/report?full=1',false,stream_context_create(['http'=>['header'=>'Authorization: Bearer '.getenv('CRON_SECRET')]]))===false?1:0);"`,
    );
    expect(call("bash")).toBe(
      `0 * * * * bash -c 'exec 3<>/dev/tcp/app/3000 && printf '\\''GET %s HTTP/1.1\\r\\nHost: app\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n'\\'' '\\''/api/cron/report?full=1'\\'' "$CRON_SECRET" >&3 && read -r _ code _ <&3 && [ "\${code#2}" != "$code" ]'`,
    );
  });

  it("quotes a route for the language and the shell", () => {
    const plan = withApp(withServices([]), {
      builder: "generated-dockerfile",
      probe: "node",
      cron: [{ name: "odd", schedule: "@hourly", route: "/it's/$HOME\\" }],
    });
    const line = renderRuntimeFiles(plan)[0]?.content.split("\n").at(-2);
    expect(line).toContain("fetch('http://app:3000/it\\\\'s/\\$HOME\\\\\\\\'");
  });

  it("refuses a route job when the image has no tool that sends the header", () => {
    for (const probe of ["none", "wget"] as const) {
      const plan = withApp(withServices([]), {
        builder: "generated-dockerfile",
        probe,
        cron: [{ name: "report", schedule: "0 * * * *", route: "/api/cron/report" }],
      });
      expect(() => renderRuntimeFiles(plan)).toThrow(
        `The cron job report calls the app's route /api/cron/report, but the app's image has no tool OpsCrew can send the job's Authorization header with (app.build.probe is ${probe} in opscrew/plan.yaml).`,
      );
    }
  });

  it("is left out without an enabled job", () => {
    const plan = withApp(withServices([]), {
      cron: [{ name: "cleanup", schedule: "@daily", command: "node cleanup.js", enabled: false }],
    });
    expect(services(plan).cron).toBeUndefined();
    expect(renderRuntimeFiles(plan).map((f) => f.path)).toEqual([
      "opscrew/runtime/edge/compose.yaml",
    ]);
  });
});

/** Postgres and Valkey as 012 rendered them, with only the limits and paths new (FR-1325). */
describe("Postgres and Valkey", () => {
  const entries: ServiceEntry[] = [
    { kind: "postgres" },
    { kind: "valkey", options: { mode: "queue" } },
  ];
  const all = services(withServices(entries));

  it("keep their output apart from the limits, the paths and Valkey's own memory limit", () => {
    expect(all.db).toEqual({
      image: IMAGES.postgres.ref,
      restart: "unless-stopped",
      env_file: ["db.env"],
      volumes: ["/srv/data/shop/db:/var/lib/postgresql/data"],
      healthcheck: {
        test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"],
        interval: "10s",
        timeout: "5s",
        retries: 6,
      },
      mem_limit: "512m",
      memswap_limit: "512m",
      security_opt: ["no-new-privileges:true"],
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      networks: ["internal"],
    });
    expect(all.queue?.command).toEqual([
      "valkey-server",
      "--appendonly",
      "yes",
      "--maxmemory",
      "96mb",
      "--maxmemory-policy",
      "noeviction",
    ]);
    expect(all.queue?.volumes).toEqual(["/srv/data/shop/queue:/data"]);
    expect(all.queue?.healthcheck).toMatchObject({ test: ["CMD", "valkey-cli", "ping"] });
  });
});

describe("SQLite", () => {
  /** An app with a release command, a worker and a cron job, on MySQL. */
  const base = withApp(withServices([{ kind: "mysql" }]), {
    builder: "generated-dockerfile",
    workers: [{ name: "worker", command: "node worker.js", source: "library" }],
    cron: [{ name: "cleanup", schedule: "@daily", command: "node cleanup.js" }],
  });
  const app = DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, releaseCommand: "npm run migrate" },
  });
  const mounts = (plan: DeployPlan) => services(plan).app?.volumes;

  it("keeps the database's folder in the volume sqlite, mounted in every container of the app's image", () => {
    const compose = renderCompose(withSqlite(app)).content;
    expect(compose).toMatchSnapshot();
    const doc = parse(compose);
    for (const name of ["app", "release", "worker"]) {
      expect(doc.services[name]?.volumes, name).toEqual(["sqlite:/app/storage"]);
    }
    expect(doc.services.cron?.volumes).toEqual([
      "./crontab:/etc/opscrew/crontab:ro",
      "sqlite:/app/storage",
    ]);
    expect(doc.services.mysql?.volumes).not.toContain("sqlite:/app/storage");
    expect(doc.volumes).toEqual({ sqlite: {} });
  });

  it("mounts it at the folder the app runs in, for each builder", () => {
    expect(mounts(withSqlite(withBuild(app, "buildpacks")))).toEqual(["sqlite:/workspace/storage"]);
    expect(mounts(withSqlite(withBuild(app, "railpack"), { dir: "db/data" }))).toEqual([
      "sqlite:/app/db/data",
    ]);
    const own = withSqlite(withBuild(app, "own-dockerfile"), { workdir: "/srv/app" });
    expect(mounts(own)).toEqual(["sqlite:/srv/app/storage"]);
    const subfolder = DeployPlanSchema.parse({
      ...app,
      app: { ...app.app, dockerfile: "apps/web/Dockerfile" },
    });
    expect(mounts(withSqlite(subfolder))).toEqual(["sqlite:/app/apps/web/storage"]);
    // Buildpacks and Railpack build a workspace member from the repository root.
    expect(mounts(withSqlite(withBuild(subfolder, "buildpacks")))).toEqual([
      "sqlite:/workspace/apps/web/storage",
    ]);
    expect(mounts(withSqlite(withBuild(subfolder, "railpack")))).toEqual([
      "sqlite:/app/apps/web/storage",
    ]);
  });

  it("refuses the app's own folder: the volume would hide the app's code", () => {
    expect(() => renderCompose(withSqlite(app, { dir: "." }))).toThrow(
      "storage.sqlite.dir in opscrew/plan.yaml is the app's own folder (/app), so the SQLite volume would hide the app's code from its image.",
    );
  });

  it("refuses a folder name the Compose file and the image build cannot hold", () => {
    for (const dir of ["my data", "it's", "db:data"]) {
      expect(() => renderCompose(withSqlite(app, { dir })), dir).toThrow(
        `The SQLite folder /app/${dir} (storage.sqlite.dir in opscrew/plan.yaml) has a character OpsCrew cannot use there: only letters, digits, ".", "_", "-" and "/" work.`,
      );
    }
  });

  it("declares it after the services' own volumes", () => {
    const kafka = withSqlite(withBuild(withServices([{ kind: "kafka" }]), "railpack"));
    expect(Object.keys(parse(renderCompose(kafka).content).volumes)).toEqual([
      "kafka_data",
      "kafka_secrets",
      "kafka_config",
      "sqlite",
    ]);
  });

  it("refuses an own Dockerfile whose working directory OpsCrew does not know", () => {
    expect(() => renderCompose(withSqlite(withBuild(app, "own-dockerfile")))).toThrow(
      "The app keeps its SQLite database in storage/ on a persistent volume, but OpsCrew does not know the folder the app runs in: the last stage of your Dockerfile (Dockerfile) has no WORKDIR with an absolute path.",
    );
  });

  it("gets its owner from the user each builder's image runs as, unknown for an own Dockerfile", () => {
    expect(sqliteVolumeOwner(withBuild(app, "buildpacks"))).toBe("1002:1001");
    expect(sqliteVolumeOwner(withBuild(app, "railpack"))).toBe("10001:10001");
    expect(sqliteVolumeOwner(withBuild(app, "generated-dockerfile", { language: "node" }))).toBe(
      "1000:1000",
    );
    expect(sqliteVolumeOwner(withBuild(app, "generated-dockerfile", { language: "python" }))).toBe(
      "10001:10001",
    );
    expect(sqliteVolumeOwner(withBuild(app, "own-dockerfile"))).toBeUndefined();
  });

  it("is left out without storage.sqlite", () => {
    const doc = parse(renderCompose(app).content);
    expect(doc.services.app?.volumes).toBeUndefined();
    expect(doc.services.worker?.volumes).toBeUndefined();
    expect(doc.services.cron?.volumes).toEqual(["./crontab:/etc/opscrew/crontab:ro"]);
    expect(doc.volumes).toBeUndefined();
  });
});
