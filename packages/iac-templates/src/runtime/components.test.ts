// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose and shell syntax in expected contents, not JavaScript templates.
import { type AppBuild, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serviceSpec } from "../catalog";
import { GARAGE_STORAGE, type ServiceEntry, withServices } from "../catalog/__fixtures__/plans";
import { IMAGES } from "../pins";
import { renderCompose, renderRuntimeFiles } from "./index";

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
      "proxy",
      "caddy",
    ]);
    expect(compose.content).toMatchSnapshot();
    const files = renderRuntimeFiles(FULL);
    expect(files.map((file) => file.path)).toEqual([
      "opscrew/runtime/services/mysql/my.cnf",
      "opscrew/runtime/services/rabbitmq/rabbitmq.conf",
      "opscrew/runtime/crontab",
    ]);
    for (const file of files) {
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
    expect(all.kafka?.volumes).toEqual(["kafka_data:/var/lib/kafka/data"]);
    const doc = parse(renderCompose(withServices([{ kind: "kafka" }])).content);
    expect(Object.keys(doc.volumes)).toEqual([
      "kafka_data",
      "caddy_data",
      "caddy_config",
      "kamal-proxy-config",
    ]);
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
    expect(renderRuntimeFiles(withServices([{ kind: "mysql", enabled: false }]))).toEqual([]);
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
    expect(renderRuntimeFiles(plan)).toEqual([]);
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
