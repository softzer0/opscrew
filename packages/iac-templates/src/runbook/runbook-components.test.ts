import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderRunbook } from "./index";

const ctx = testContext({ projectId: "shop-0123456789ab" });

/** `base` with a worker, cron jobs, MySQL, OpenSearch and an object storage bucket. */
function withComponents(
  base: DeployPlan,
  objectStorage: NonNullable<DeployPlan["storage"]>["objectStorage"],
): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    processes: {
      workers: [
        { name: "worker", command: "node worker.js", source: "procfile", count: 2 },
        { name: "beat", command: "node beat.js", source: "library", single: true },
      ],
      cron: [
        { name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" },
        { name: "sync", schedule: "*/15 * * * *", route: "/api/cron/sync" },
      ],
    },
    services: [
      ...base.services,
      { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
      {
        kind: "opensearch",
        version: "3.9",
        memoryMb: 1024,
        reason: "The app uses OpenSearch.",
        licence: "Apache-2.0",
      },
      ...(objectStorage?.provider === "garage"
        ? [{ kind: "garage", version: "2.4", memoryMb: 64, reason: "S3", licence: "AGPL-3.0" }]
        : []),
    ],
    storage: { objectStorage },
  });
}

const R2 = {
  provider: "r2",
  bucket: "shop-uploads",
  region: "auto",
  cors: false,
  expected: { storageGb: 10, egressGbPerMonth: 50 },
  price: {
    monthly: 0,
    currency: "USD",
    source: "https://developers.cloudflare.com/r2/pricing/",
    checkedOn: "2026-10-19",
  },
} as const;

/** The runbook's section `heading`, up to the next section. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("the runbook's components, edge and storage key", () => {
  it("names only the Docker volume for an app whose only data is SQLite", () => {
    const base = testPlan({ postgres: false });
    const plan = DeployPlanSchema.parse({
      ...base,
      deploy: { ...base.deploy, strategy: "recreate" },
      storage: { sqlite: { dir: "storage" } },
    });
    const text = renderRunbook(plan, ctx).content;
    expect(text).toMatch(
      /\| Database \| SQLite on the server, data in Docker volumes \(see Components\); /,
    );
    expect(text).not.toContain("/srv/data/shop`");
    expect(section(text, "Components")).toContain("on the Docker volume `shop_sqlite`");
  });

  it("lists each component with its memory limit and its data under /srv/data/<app>/<name>", () => {
    const text = renderRunbook(
      withComponents(testPlan({ domain: "shop.example.com" }), R2),
      ctx,
    ).content;
    const components = section(text, "Components");
    expect(components).toContain(
      "The app runs as the Docker Compose project `shop` in `/srv/apps/shop` on the server.",
    );
    expect(components).toContain("| `app` | the web process | 512 MB | |");
    expect(components).toContain("| `worker` | `node worker.js`, 2 copies | 256 MB each | |");
    expect(components).toContain("| `beat` | `node beat.js`, one copy only | 256 MB | |");
    expect(components).toContain("| `cron` | the cron jobs below, with supercronic | 512 MB | |");
    expect(components).toContain(
      "| `db` | PostgreSQL 17 (PostgreSQL) | 512 MB | `/srv/data/shop/db` |",
    );
    expect(components).toContain(
      "| `mysql` | MySQL 8.4 (GPL-2.0) | 512 MB | `/srv/data/shop/mysql` |",
    );
    expect(components).toContain(
      "| `opensearch` | OpenSearch 3.9 (Apache-2.0) | 1024 MB | the Docker volume `shop_opensearch_data` |",
    );
    expect(components).toContain("- `cleanup`: `0 3 * * *`, `node cleanup.js`");
    expect(components).toContain(
      "- `sync`: `*/15 * * * *`, a GET of `/api/cron/sync` with the generated `CRON_SECRET` as its bearer token",
    );
    expect(components).toContain("`opscrew status` shows whether each component runs");
    expect(section(text, "Connect to the server")).toContain("cd /srv/apps/shop");
    expect(text).toContain(
      "| Database | PostgreSQL 17, MySQL 8.4 and OpenSearch 3.9 on the server, data in `/srv/data/shop` and Docker volumes (see Components); Hetzner automated backups are on |",
    );
  });

  it("gives cron its small limit when its jobs only call routes, and lists several volumes", () => {
    const base = testPlan({ domain: "shop.example.com" });
    const plan = DeployPlanSchema.parse({
      ...base,
      processes: { cron: [{ name: "sync", schedule: "*/15 * * * *", route: "/api/cron/sync" }] },
      services: [
        ...base.services,
        { kind: "kafka", version: "4.3", memoryMb: 1024, reason: "kafkajs", licence: "Apache-2.0" },
      ],
    });
    const components = section(renderRunbook(plan, ctx).content, "Components");
    expect(components).toContain("| `cron` | the cron jobs below, with supercronic | 64 MB | |");
    expect(components).toContain(
      "the Docker volumes `shop_kafka_data`, `shop_kafka_secrets` and `shop_kafka_config` |",
    );
  });

  it("describes the shared edge and the app's site file, and no more /srv/app or Caddyfile", () => {
    const text = renderRunbook(testPlan({ domain: "shop.example.com" }), ctx).content;
    const edge = section(text, "The edge");
    expect(edge).toContain("`/srv/edge`, the Compose project `opscrew-edge`");
    expect(edge).toContain("`/srv/edge/sites/shop.caddy`");
    expect(edge).not.toContain("Every OpsCrew app on this server");
    expect(section(text, "How a deploy works")).toContain(
      "to `/srv/apps/shop` on the server and\n   the app's site file to the shared edge in `/srv/edge`",
    );
    expect(text).not.toMatch(/\/srv\/app\b(?!s)/);
    expect(text).not.toContain("Caddyfile");

    const own = renderRunbook(
      testPlan({ provider: "own", domain: "shop.example.com" }),
      ctx,
    ).content;
    expect(section(own, "The shared edge")).toContain(
      "Every OpsCrew app on this server sits behind the same edge",
    );
    expect(own).toContain("cd /srv/apps/shop");
    expect(own).not.toMatch(/\/srv\/app\b(?!s)/);
    expect(own).not.toContain("Caddyfile");
  });

  it("says where the bucket is, what it costs, and that the storage key is the user's", () => {
    const text = renderRunbook(
      withComponents(testPlan({ domain: "shop.example.com" }), R2),
      ctx,
    ).content;
    const storage = section(text, "Object storage").replace(/\s+/g, " ");
    expect(storage).toContain(
      "The app's files are in the private bucket `shop-uploads` on Cloudflare R2 (auto), about $0.00 a month for 10 GB stored and 50 GB sent a month (from https://developers.cloudflare.com/r2/pricing/, checked on 2026-10-19).",
    );
    expect(storage).toContain("`opscrew/infra/storage/`");
    expect(storage).toContain("**The storage key is yours.** OpsCrew never creates one");
    expect(storage).toContain("`~/.opscrew/projects/shop-0123456789ab/storage_key.json`");
    expect(storage).toContain("never in this repository or in infrastructure state");
    expect(storage).toContain("`OPSCREW_STORAGE_ACCESS_KEY_ID`");
    expect(section(text, "Tear it down")).toContain(
      "- **The bucket `shop-uploads`** stays with the app's files, and is billed, unless you add `--delete-data`.",
    );
  });

  it("Garage on a server the user owns keeps the files in its data folder, with a generated key", () => {
    const garage = {
      ...R2,
      provider: "garage",
      bucket: "shop-files",
      region: "garage",
      price: { ...R2.price, source: "https://garagehq.deuxfleurs.fr/documentation/quick-start/" },
    } as const;
    const text = renderRunbook(
      withComponents(testPlan({ provider: "own", domain: "shop.example.com" }), garage),
      ctx,
    ).content;
    const storage = section(text, "Object storage").replace(/\s+/g, " ");
    expect(storage).toContain(
      "The app's files are in the bucket `shop-files` of Garage, the component `garage`, which keeps them in `/srv/data/shop/garage` on the server's own disk, at no extra cost.",
    );
    expect(storage).not.toContain("storage_key.json");
    expect(section(text, "Tear it down")).toContain("the data in `/srv/data/shop`");
  });
});
