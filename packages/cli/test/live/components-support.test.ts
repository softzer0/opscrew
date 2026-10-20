/**
 * Offline checks of the component checks' pure helpers (feature 013): the Hetzner passes and their
 * skips, the plan edits, and reading what the server shows. No network.
 */
import { createHash } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { hostSysctl, IMAGES, pinnedVersion, serviceSpec } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_EXAMPLES,
  componentServices,
  componentSettings,
  containersOf,
  dataFolderProblems,
  dataFoldersCommand,
  dataMounts,
  fieldsByKey,
  firstCronRun,
  HONOURED_SETTINGS,
  limitProblems,
  parseContainers,
  portProblems,
  processOwnersCommand,
  r2KeyOfToken,
  restartProblems,
  settingsFileProblems,
  settingsMounts,
  statusProblems,
  storageKeyEnv,
  sysctlProblems,
  unprotectStorageRoot,
  withBucket,
  withSearchEngine,
} from "./components-support";
import { generatesValues } from "./support";

/** Just enough of a plan for the helpers under test. */
function plan(fields: Record<string, unknown>): DeployPlan {
  return {
    app: { name: "shop", env: [] },
    processes: { workers: [], cron: [] },
    services: [],
    target: { provider: "hetzner", location: "nbg1" },
    ...fields,
  } as unknown as DeployPlan;
}

const BUCKET = {
  provider: "r2",
  bucket: "shop-uploads",
  region: "auto",
  cors: true,
  expected: { storageGb: 10, egressGbPerMonth: 50 },
  price: { monthly: 0, currency: "USD", source: "R2", checkedOn: "2026-10-19" },
};

describe("componentSettings", () => {
  const on = { OPSCREW_E2E_COMPONENTS: "1" };
  const dns = { ...on, OPSCREW_E2E_DOMAIN: "e2e.example.com", OPSCREW_E2E_CLOUDFLARE_TOKEN: "x" };

  it("runs only with OPSCREW_E2E_COMPONENTS=1 and for the live set's examples", () => {
    expect(componentSettings("node-bullmq", {})).toMatch(/^not checked: the component checks/);
    expect(componentSettings("nextjs-postgres", on)).toBe(
      `not checked: OPSCREW_E2E_COMPONENTS=1 checks only ${COMPONENT_EXAMPLES.join(", ")}`,
    );
    expect(componentSettings(undefined, on)).toMatch(/^not checked: OPSCREW_E2E_COMPONENTS=1/);
    expect(componentSettings("express-mysql", on)).toEqual({
      app: "express-mysql",
      searchEngine: false,
    });
    expect(componentSettings("meili-search", on)).toEqual({
      app: "meili-search",
      searchEngine: true,
    });
  });

  it("puts s3-uploads' bucket on R2 only when R2 is on, and on Hetzner only with the user's key", () => {
    expect(componentSettings("s3-uploads", on)).toEqual({
      skip: expect.stringMatching(/needs the app's domain/),
    });
    expect(componentSettings("s3-uploads", dns)).toEqual({
      skip: expect.stringMatching(/set OPSCREW_E2E_R2=1/),
    });
    expect(componentSettings("s3-uploads", { ...dns, OPSCREW_E2E_R2: "1" })).toEqual({
      app: "s3-uploads",
      searchEngine: false,
      storage: { provider: "r2" },
    });
    const hetzner = { ...dns, OPSCREW_E2E_STORAGE: "hetzner" };
    expect(componentSettings("s3-uploads", hetzner)).toEqual({
      skip: expect.stringMatching(/OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID/),
    });
    const key = {
      accessKeyId: fakeSecret("aws-access-key-id", "hetzner-s3"),
      secretAccessKey: fakeSecret("aws-secret-access-key", "hetzner-s3"),
    };
    expect(
      componentSettings("s3-uploads", {
        ...hetzner,
        OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID: key.accessKeyId,
        OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY: key.secretAccessKey,
      }),
    ).toEqual({ app: "s3-uploads", searchEngine: false, storage: { provider: "hetzner", key } });
    expect(componentSettings("s3-uploads", { ...hetzner, OPSCREW_E2E_REGION: "us-east" })).toEqual({
      skip: "Hetzner Object Storage is only in eu-central and eu-north, not in OPSCREW_E2E_REGION=us-east",
    });
    expect(componentSettings("s3-uploads", { ...dns, OPSCREW_E2E_STORAGE: "minio" })).toEqual({
      skip: 'OPSCREW_E2E_STORAGE="minio" is neither r2 nor hetzner',
    });
    expect(storageKeyEnv(key)).toEqual({
      OPSCREW_STORAGE_ACCESS_KEY_ID: key.accessKeyId,
      OPSCREW_STORAGE_SECRET_ACCESS_KEY: key.secretAccessKey,
    });
  });

  it("makes R2's S3 credentials from a token: its id, and the SHA-256 of its value", () => {
    const token = fakeSecret("cloudflare-token", "r2");
    const key = r2KeyOfToken("0123456789abcdef0123456789abcdef", token);
    expect(key.accessKeyId).toBe("0123456789abcdef0123456789abcdef");
    expect(key.secretAccessKey).toBe(createHash("sha256").update(token).digest("hex"));
    expect(key.secretAccessKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the plan edits", () => {
  it("moves the bucket to R2 or into the server's Hetzner location, under the run's own name", () => {
    const stored = plan({ storage: { objectStorage: BUCKET } });
    expect(withBucket(stored, "hetzner", "opscrew-e2e-1").storage?.objectStorage).toMatchObject({
      provider: "hetzner",
      bucket: "opscrew-e2e-1",
      region: "nbg1",
      cors: true,
    });
    expect(withBucket(stored, "r2", "opscrew-e2e-1").storage?.objectStorage).toMatchObject({
      provider: "r2",
      region: "auto",
    });
    const ashburn = plan({
      storage: { objectStorage: BUCKET },
      target: { provider: "hetzner", location: "ash" },
    });
    expect(() => withBucket(ashburn, "hetzner", "b-1")).toThrow(/no Hetzner Object Storage/);
    expect(() => withBucket(plan({}), "r2", "b-1")).toThrow(/no object storage/);
  });

  it("adds OpenSearch at its pinned version, whose kernel setting the host then needs", () => {
    const before = plan({});
    expect(hostSysctl(before)).toEqual({});
    const added = withSearchEngine(before);
    const spec = serviceSpec("opensearch");
    expect(added.services).toEqual([
      expect.objectContaining({
        name: "opensearch",
        kind: "opensearch",
        version: pinnedVersion(spec),
        memoryMb: spec.memory.defaultMb,
        enabled: true,
      }),
    ]);
    expect(hostSysctl(added)).toEqual({ "vm.max_map_count": "262144" });
  });
});

describe("what the server shows", () => {
  const inspected = (name: string, fields: Record<string, unknown> = {}) => ({
    Name: `/${name}`,
    Config: { Labels: fields.labels ?? null },
    HostConfig: { Memory: fields.memory ?? 268435456, MemorySwap: fields.swap ?? 268435456 },
    NetworkSettings: {
      Ports: fields.ports ?? {},
      Networks: fields.networks ?? { bridge: {} },
    },
    State: { Running: fields.running ?? true, OOMKilled: false, StartedAt: "t", Pid: 4242 },
    RestartCount: fields.restarts ?? 0,
  });
  const labels = (project: string, service: string) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
  });

  it("reads docker inspect, and keeps OpsCrew's projects only", () => {
    expect(parseContainers("")).toEqual([]);
    const containers = parseContainers(
      JSON.stringify([
        inspected("shop-app-1", {
          labels: labels("shop", "app"),
          networks: { shop_internal: {}, "opscrew-edge": {} },
        }),
        inspected("opscrew-edge-caddy-1", {
          labels: labels("opscrew-edge", "caddy"),
          ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }], "443/tcp": null },
        }),
        inspected("shop-tunnel-cloudflared-1", { labels: labels("shop-tunnel", "cloudflared") }),
        inspected("decoy", { memory: 0, swap: 0 }),
      ]),
    );
    expect(containers[0]).toEqual({
      name: "shop-app-1",
      project: "shop",
      service: "app",
      memory: 268435456,
      memorySwap: 268435456,
      ports: [],
      networks: ["shop_internal", "opscrew-edge"],
      running: true,
      restarts: 0,
      oomKilled: false,
      startedAt: "t",
      pid: 4242,
    });
    expect(containers[1]?.ports).toEqual(["127.0.0.1:18080"]);
    expect(containersOf(containers, ["shop", "opscrew-edge"]).map((c) => c.name)).toEqual([
      "shop-app-1",
      "opscrew-edge-caddy-1",
      "shop-tunnel-cloudflared-1",
    ]);
    // `shopping` is another app, not one of shop's own projects.
    expect(
      containersOf(
        parseContainers(JSON.stringify([inspected("x", { labels: labels("shopping", "app") })])),
        ["shop"],
      ),
    ).toEqual([]);
  });

  it("finds a missing limit, a swap beyond it, and every published port but the edge's Caddy", () => {
    const containers = parseContainers(
      JSON.stringify([
        inspected("a", { labels: labels("shop", "app") }),
        inspected("b", { labels: labels("shop", "db"), memory: 0, swap: 0 }),
        inspected("c", { labels: labels("shop", "cache"), swap: -1 }),
        inspected("d", {
          labels: labels("shop", "db"),
          ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }] },
        }),
        inspected("e", {
          labels: labels("opscrew-edge", "caddy"),
          ports: { "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }] },
        }),
      ]),
    );
    expect(limitProblems(containers)).toEqual([
      "b has no memory limit",
      "c may swap beyond its memory limit",
    ]);
    expect(portProblems(containers)).toEqual(["d publishes 0.0.0.0:5432"]);
  });

  it("finds a component without a running container, and one that restarted", () => {
    const containers = parseContainers(
      JSON.stringify([
        inspected("shop-app-1", { labels: labels("shop", "app") }),
        inspected("shop-worker-1", { labels: labels("shop", "worker"), restarts: 2 }),
        inspected("shop-cron-1", { labels: labels("shop", "cron"), running: false }),
      ]),
    );
    expect(
      restartProblems(containers, [{ project: "shop", services: ["app", "worker", "cron"] }]),
    ).toEqual(["shop-worker-1 restarted 2 time(s)", "shop/cron has no running container"]);
    // After a reboot the app's own processes may have restarted until their services answered.
    expect(
      restartProblems(containers, [
        { project: "shop", services: ["app", "worker", "cron"], mayRestart: ["worker"] },
      ]),
    ).toEqual(["shop/cron has no running container"]);
  });

  it("lists the plan's components by their Compose services", () => {
    const withAll = plan({
      processes: {
        workers: [
          { name: "worker", enabled: true },
          { name: "off", enabled: false },
        ],
        cron: [{ name: "tick", enabled: true }],
      },
      services: [{ name: "queue", kind: "valkey", enabled: true }],
    });
    expect(componentServices(withAll)).toEqual(["app", "worker", "cron", "queue"]);
    const status = [
      "Components:",
      "  The web process (app): running",
      "  The worker (worker): running (2 copies)",
      "  The cron jobs (cron): stopped",
      "  Valkey (queue): running",
    ].join("\n");
    expect(statusProblems(status, withAll)).toEqual([
      "opscrew status does not show the cron jobs (cron) running",
    ]);
  });

  const compose = [
    "name: shop",
    "services:",
    "  app:",
    "    volumes: []",
    "  cron:",
    "    volumes:",
    "      - ./crontab:/etc/opscrew/crontab:ro",
    "  mysql:",
    "    volumes:",
    "      - /srv/data/shop/mysql:/var/lib/mysql",
    "      - ./services/mysql/my.cnf:/etc/mysql/conf.d/opscrew.cnf:ro",
    "  mongodb:",
    "    volumes:",
    "      - /srv/data/shop/mongodb/db:/data/db",
    "      - /srv/data/shop/mongodb/configdb:/data/configdb",
    "  kafka:",
    "    volumes:",
    "      - kafka_data:/var/lib/kafka/data",
    "",
  ].join("\n");

  it("reads the data folders and the settings files of the app's Compose file", () => {
    expect(dataMounts(compose, "shop")).toEqual([
      { service: "mysql", path: "mysql" },
      { service: "mongodb", path: "mongodb/db" },
      { service: "mongodb", path: "mongodb/configdb" },
    ]);
    expect(settingsMounts(compose)).toEqual([
      { service: "cron", file: "crontab", target: "/etc/opscrew/crontab" },
      { service: "mysql", file: "services/mysql/my.cnf", target: "/etc/mysql/conf.d/opscrew.cnf" },
    ]);
  });

  it("looks at the data folders as root in the edge's pinned Caddy image, without a network", () => {
    const command = dataFoldersCommand("shop", ["mysql", "mongodb/db"]);
    expect(command).toContain(`-v /srv/data/shop:/d:ro ${IMAGES.caddy.ref} -c '`);
    expect(command).toMatch(/^docker run --rm --network none --user 0:0 --entrypoint sh /);
    expect(command.endsWith("' sh mysql mongodb/db")).toBe(true);
    expect(processOwnersCommand([12, 34])).toBe(
      [
        "for pid in 12 34; do p=$pid",
        `case "$(awk '/^Name:/{print $2}' /proc/$p/status)" in tini|docker-init|dumb-init) p=$(pgrep -P $p | head -n 1);; esac`,
        `echo "$pid $(awk '/^Uid:/{u=$3} /^Gid:/{g=$3} END{print u":"g}' /proc/$p/status)"; done`,
      ].join("; "),
    );
  });

  it("wants each data folder its service's user's, and data in one of each service's folders", () => {
    const mounts = [
      { service: "mysql", path: "mysql" },
      { service: "mongodb", path: "mongodb/db" },
      { service: "mongodb", path: "mongodb/configdb" },
      { service: "nats", path: "nats" },
      { service: "garage", path: "garage" },
    ];
    const folders = fieldsByKey(
      [
        "mysql 999:999 12",
        "mongodb/db 0:0 3",
        "mongodb/configdb 999:999 0",
        "nats 1000:1000 0",
        "",
      ].join("\r\n"),
    );
    const owners = new Map([
      ["mysql", "999:999"],
      ["mongodb", "999:999"],
      ["nats", "1000:1000"],
    ]);
    expect(dataFolderProblems(mounts, folders, owners)).toEqual([
      "/srv/data/…/mongodb/db belongs to 0:0, not to mongodb's user (999)",
      "/srv/data/…/garage of garage is missing",
      "the data folders of nats are empty (nats)",
    ]);
  });

  it("wants each settings file readable by its service and writable only by its owner", () => {
    const file = "services/mysql/my.cnf";
    expect(
      settingsFileProblems(file, { mode: "644", uid: "1000", gid: "1000" }, "999:999"),
    ).toEqual([]);
    expect(settingsFileProblems(file, { mode: "640", uid: "1000", gid: "999" }, "999:999")).toEqual(
      [],
    );
    expect(settingsFileProblems(file, { mode: "600", uid: "999", gid: "0" }, "999:999")).toEqual(
      [],
    );
    expect(
      settingsFileProblems(file, { mode: "666", uid: "1000", gid: "1000" }, "999:999"),
    ).toEqual([`${file} (mode 666) is writable by others than its owner`]);
    expect(
      settingsFileProblems(file, { mode: "600", uid: "1000", gid: "1000" }, "999:999"),
    ).toEqual([`${file} (mode 600, 1000:1000) is not readable by 999:999`]);
  });

  it("reads the value MySQL's and ClickHouse's own settings files set", () => {
    for (const [kind, expected] of [
      ["mysql", String(128 * 1024 * 1024)],
      ["clickhouse", String(768 * 1024 * 1024)],
    ] as const) {
      const probe = HONOURED_SETTINGS[kind];
      const file = serviceSpec(kind)
        .configFiles?.({ service: { memoryMb: kind === "mysql" ? 512 : 1024 } } as never)
        .find((f) => f.name === probe?.file);
      expect(file, `${kind}'s ${probe?.file}`).toBeDefined();
      expect(probe?.expected(file?.content ?? "")).toBe(expected);
      // Run as `sh -c '<query>'`.
      expect(probe?.query.includes("'")).toBe(false);
    }
  });

  it("wants the kernel settings in OpsCrew's file and in use, each at least as high", () => {
    const wanted = { "vm.max_map_count": "262144" };
    const file = "# Managed by OpsCrew\nvm.max_map_count = 262144\n";
    expect(sysctlProblems(file, { "vm.max_map_count": "262144" }, wanted)).toEqual([]);
    expect(sysctlProblems("", { "vm.max_map_count": "65530" }, wanted)).toEqual([
      "/etc/sysctl.d/90-opscrew.conf does not set vm.max_map_count to at least 262144",
      "the kernel uses vm.max_map_count = 65530, not at least 262144",
    ]);
  });

  it("finds the cron container's first successful run and its due time", () => {
    const started = "2026-10-20T10:00:12.5Z";
    const logs = [
      'time="2026-10-20T10:00:13Z" level=info msg="read crontab: /etc/opscrew/crontab"',
      'time="2026-10-20T10:01:00Z" level=info msg=starting job.command="x"',
      'time="2026-10-20T10:01:01Z" level=info msg="job succeeded" job.command="x"',
    ].join("\n");
    const before = Date.parse("2026-10-20T10:00:05Z");
    expect(firstCronRun(logs, started, before)).toEqual({
      due: Date.parse("2026-10-20T10:01:00Z"),
      ran: Date.parse("2026-10-20T10:01:01Z"),
    });
    expect(firstCronRun("", started, before)).toEqual({ due: Date.parse("2026-10-20T10:01:00Z") });
    // The app answered its health route only later: the first run that can reach it is due then.
    const ready = Date.parse("2026-10-20T10:01:30Z");
    expect(firstCronRun("", started, ready)).toEqual({ due: Date.parse("2026-10-20T10:02:00Z") });
    // Read a moment after the app answered on the minute: that minute's run counts as due.
    const justAfter = Date.parse("2026-10-20T10:02:02Z");
    expect(firstCronRun("", started, justAfter)).toEqual({
      due: Date.parse("2026-10-20T10:02:00Z"),
    });
  });

  it("lifts the storage root's prevent_destroy for the cleanup, and refuses a root without it", () => {
    const main =
      'resource "aws_s3_bucket" "this" {\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n';
    expect(unprotectStorageRoot(main)).toBe(main.replace("= true", "= false"));
    expect(() => unprotectStorageRoot("resource {}\n")).toThrow(/prevent_destroy/);
  });

  it("knows when OpsCrew generates values: a service's login, or an app secret", () => {
    expect(generatesValues(plan({}))).toBe(false);
    expect(
      generatesValues(plan({ services: [{ name: "kafka", kind: "kafka", enabled: true }] })),
    ).toBe(false);
    expect(
      generatesValues(plan({ services: [{ name: "mysql", kind: "mysql", enabled: true }] })),
    ).toBe(true);
    expect(
      generatesValues(plan({ app: { name: "shop", env: [{ name: "S", source: "generated" }] } })),
    ).toBe(true);
  });
});
