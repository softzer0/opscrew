// Feature 019's follow-up: the database on a rollback (T1930, plan.md 12.1). The plan's snapshot
// settings, `snapshotsOn` and the down migrations of `app.migrations`.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { previewPlanOf } from "./__fixtures__/preview-plan";
import {
  type DeployPlan,
  DeployPlanSchema,
  DeploySettingsSchema,
  keepSnapshotsOf,
  parseArtifact,
  snapshotsByDefault,
  snapshotsOn,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: a test plan is edited as loose JSON before parsing.
type Loose = Record<string, any>;

/** The fixture's prod plan on Hetzner, with Postgres (`db`) on the app's server. */
async function prodPlan(): Promise<DeployPlan> {
  return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
}

/** The plan of a `before-placement` fixture for `kind`. */
async function targetPlan(kind: string): Promise<DeployPlan> {
  return parseArtifact("plan", await fixture(`before-placement/plan-${kind}.yaml`), "fixture");
}

/** The fixture's plan as the `dev` environment's. */
async function devPlan(): Promise<Loose> {
  const plan: Loose = await prodPlan();
  return {
    ...plan,
    app: { ...plan.app, name: `${plan.app.name}-dev` },
    environment: { name: "dev", deploySource: { from: "main" }, runner: "github" },
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [];
}

const parse = (plan: Loose) => DeployPlanSchema.parse(plan);

describe("deploy.snapshots and deploy.keepSnapshots", () => {
  it("leaves both absent, and keeps 3 snapshots then", () => {
    const deploy = DeploySettingsSchema.parse({});
    expect(deploy).not.toHaveProperty("snapshots");
    expect(deploy).not.toHaveProperty("keepSnapshots");
    expect(keepSnapshotsOf({ deploy })).toBe(3);
    expect(keepSnapshotsOf({ deploy: { keepSnapshots: 5 } })).toBe(5);
    expect(DeploySettingsSchema.parse({ snapshots: false, keepSnapshots: 10 })).toMatchObject({
      snapshots: false,
      keepSnapshots: 10,
    });
  });

  it("keeps 1 to 10 whole snapshots", () => {
    for (const keep of [1, 10]) {
      expect(DeploySettingsSchema.safeParse({ keepSnapshots: keep }).success, `${keep}`).toBe(true);
    }
    for (const keep of [0, 11, 2.5]) {
      expect(DeploySettingsSchema.safeParse({ keepSnapshots: keep }).success, `${keep}`).toBe(
        false,
      );
    }
  });

  it("still parses the deploy settings a move keeps", async () => {
    const plan = await prodPlan();
    const parsed = parse({
      ...plan,
      retarget: {
        from: { target: plan.target, deploy: { strategy: "recreate", snapshots: true } },
        step: "started",
        startedAt: plan.createdAt,
      },
    });
    expect(parsed.retarget?.from.deploy).toEqual({
      strategy: "recreate",
      drainSeconds: 30,
      snapshots: true,
    });
  });
});

describe("snapshotsOn", () => {
  it("is on in prod, whatever the provider's backups, unless deploy.snapshots is false", async () => {
    const plan = await prodPlan();
    expect(plan.target).toMatchObject({ provider: "hetzner", backups: true });
    expect(snapshotsOn(plan)).toBe(true);
    expect(snapshotsOn(parse({ ...plan, target: { ...plan.target, backups: false } }))).toBe(true);
    expect(snapshotsOn(parse({ ...plan, deploy: { snapshots: false } }))).toBe(false);
  });

  it("is on in another environment unless deploy.snapshots is false", async () => {
    const plan = await devPlan();
    expect(snapshotsOn(parse(plan))).toBe(true);
    expect(snapshotsOn(parse({ ...plan, deploy: { snapshots: false } }))).toBe(false);
  });

  it("is on for a cloud server, the user's own server, this computer and Portainer", async () => {
    for (const kind of ["hetzner", "digitalocean", "own", "localhost", "portainer"]) {
      const plan = await targetPlan(kind);
      expect(snapshotsOn(parse({ ...plan, deploy: { snapshots: true } })), kind).toBe(true);
    }
  });

  it("is on Portainer as on servers: on in prod and in another environment unless turned off", async () => {
    const plan = await targetPlan("portainer");
    expect(snapshotsOn(plan)).toBe(true);
    expect(snapshotsOn(parse({ ...plan, deploy: { ...plan.deploy, snapshots: false } }))).toBe(
      false,
    );
    const named: Loose = {
      ...plan,
      app: { ...plan.app, name: `${plan.app.name}-dev` },
      environment: { name: "dev", deploySource: { from: "main" }, runner: "github" },
    };
    expect(snapshotsOn(parse(named))).toBe(true);
    expect(snapshotsOn(parse({ ...named, deploy: { ...named.deploy, snapshots: false } }))).toBe(
      false,
    );
    expect(snapshotsOn(parse({ ...named, services: [] }))).toBe(false);
  });

  it("is off on site targets", async () => {
    for (const kind of ["cloudflare-workers", "github-pages"]) {
      const plan = await targetPlan(kind);
      expect(snapshotsOn(plan), kind).toBe(false);
      const named: Loose = {
        ...plan,
        app: { ...plan.app, name: `${plan.app.name}-dev` },
        environment: { name: "dev", deploySource: { from: "main" }, runner: "github" },
      };
      expect(snapshotsOn(parse(named)), kind).toBe(false);
    }
  });

  it("is off in a preview environment", async () => {
    expect(snapshotsOn(previewPlanOf(await prodPlan()))).toBe(false);
  });

  it("needs a service a release snapshot copies, or the SQLite volume (US7)", async () => {
    const plan = await devPlan();
    const db = plan.services[0];
    for (const kind of ["postgres", "mysql", "mariadb", "mongodb"]) {
      const services = [{ ...db, kind, options: {} }];
      expect(snapshotsOn(parse({ ...plan, services })), kind).toBe(true);
    }
    for (const kind of ["valkey", "redis", "dragonfly"]) {
      const services = [{ ...db, name: "cache", kind, options: { mode: "cache" } }];
      expect(snapshotsOn(parse({ ...plan, services })), kind).toBe(true);
    }
    expect(snapshotsOn(parse({ ...plan, services: [] }))).toBe(false);
    expect(snapshotsOn(parse({ ...plan, services: [{ ...db, enabled: false }] }))).toBe(false);
    // The app's SQLite volume alone.
    const sqlite = {
      ...plan,
      services: [],
      storage: { sqlite: { dir: "data" } },
      deploy: { strategy: "recreate" },
    };
    expect(snapshotsOn(parse(sqlite))).toBe(true);
    expect(snapshotsOn(parse({ ...sqlite, deploy: { ...sqlite.deploy, snapshots: false } }))).toBe(
      false,
    );
    // A stop-only kind counts only when deploy.snapshotStop names it.
    const kafka = { ...db, name: "kafka", kind: "kafka", options: {} };
    expect(snapshotsOn(parse({ ...plan, services: [kafka] }))).toBe(false);
    expect(
      snapshotsOn(parse({ ...plan, services: [kafka], deploy: { snapshotStop: ["kafka"] } })),
    ).toBe(true);
  });

  it("counts the data on an extra server as on the app's server", async () => {
    const parsed = parse(await devPlan());
    const elsewhere = parsed.services.map((service) => ({ ...service, server: "data" }));
    expect(snapshotsOn({ ...parsed, services: elsewhere })).toBe(true);
    const off = { ...parsed.deploy, snapshots: false };
    expect(snapshotsOn({ ...parsed, services: elsewhere, deploy: off })).toBe(false);
  });
});

describe("snapshotsByDefault", () => {
  it("is true in every environment, prod included, and false in a preview environment", async () => {
    const prod = await prodPlan();
    expect(snapshotsByDefault(prod)).toBe(true);
    expect(snapshotsByDefault(parse(await devPlan()))).toBe(true);
    expect(snapshotsByDefault(previewPlanOf(prod))).toBe(false);
  });
});

describe("deploy.snapshots: true where snapshots aren't offered", () => {
  const later = /snapshots .*come in a later release/;

  it("is refused on a preview environment", async () => {
    const plan: Loose = previewPlanOf(await prodPlan());
    const found = issues(DeployPlanSchema.safeParse({ ...plan, deploy: { snapshots: true } }));
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("deploy.snapshots");
    expect(found[0]?.message).toMatch(later);
    expect(DeployPlanSchema.safeParse({ ...plan, deploy: { snapshots: false } }).success).toBe(
      true,
    );
  });

  it("is accepted on Portainer", async () => {
    const plan: Loose = await targetPlan("portainer");
    expect(
      DeployPlanSchema.safeParse({ ...plan, deploy: { snapshots: true } }).error,
    ).toBeUndefined();
  });

  it("is refused on site targets", async () => {
    for (const kind of ["cloudflare-workers", "github-pages"]) {
      const plan: Loose = await targetPlan(kind);
      const found = issues(DeployPlanSchema.safeParse({ ...plan, deploy: { snapshots: true } }));
      expect(found, kind).toHaveLength(1);
      expect(found[0]?.path).toBe("deploy.snapshots");
      expect(found[0]?.message).toMatch(later);
      expect(found[0]?.message).not.toMatch(/\b0\d\d\b/);
    }
  });
});

describe("app.migrations", () => {
  const downs: Record<string, string> = {
    rails: "bin/rails db:migrate VERSION={version}",
    django: "python manage.py migrate {app} {name} --noinput",
    alembic: "alembic downgrade {version}",
    "flask-migrate": "FLASK_APP=app flask db downgrade {version}",
    knex: "npx knex migrate:down",
    sequelize: "npx sequelize-cli db:migrate:undo",
    typeorm: "npx typeorm migration:revert -d dist/data-source.js",
    laravel: "php artisan migrate:rollback --step={count} --force",
  };

  /** The fixture's plan with `migrations`, beside a release command unless `release` is false. */
  async function withMigrations(migrations: Loose, release = true) {
    const plan: Loose = await prodPlan();
    const releaseCommand = release ? { releaseCommand: "migrate" } : {};
    return { ...plan, app: { ...plan.app, ...releaseCommand, migrations } };
  }

  it("accepts each tool's down command with its placeholders", async () => {
    for (const [tool, down] of Object.entries(downs)) {
      const migrations = { tool, status: "status", down };
      const parsed = DeployPlanSchema.safeParse(await withMigrations(migrations));
      expect(parsed.error?.issues, tool).toBeUndefined();
      expect(parsed.data?.app.migrations).toEqual(migrations);
    }
  });

  it("refuses a down command without its tool's placeholders, or with another's", async () => {
    const cases: [string, string][] = [
      ["rails", "bin/rails db:migrate"],
      ["django", "python manage.py migrate {app} --noinput"],
      ["laravel", "php artisan migrate:rollback --force"],
      ["knex", "npx knex migrate:down {count}"],
    ];
    for (const [tool, down] of cases) {
      const found = issues(
        DeployPlanSchema.safeParse(await withMigrations({ tool, status: "status", down })),
      );
      expect(found, tool).toHaveLength(1);
      expect(found[0]?.path).toBe("app.migrations.down");
    }
    const knex = issues(
      DeployPlanSchema.safeParse(
        await withMigrations({ tool: "knex", status: "s", down: "knex {count}" }),
      ),
    );
    expect(knex[0]?.message).toBe(
      'must have no placeholder with tool "knex": it runs once per migration, undoing the newest; found {count}',
    );
    const rails = issues(
      DeployPlanSchema.safeParse(
        await withMigrations({ tool: "rails", status: "s", down: "bin/rails db:migrate" }),
      ),
    );
    expect(rails[0]?.message).toBe(
      'must contain {version} with tool "rails": the version the database goes back to',
    );
  });

  it("refuses an unknown tool and a command that is not one line", async () => {
    for (const migrations of [
      { tool: "prisma", status: "s", down: "d" },
      { tool: "knex", status: "", down: "d" },
      { tool: "knex", status: "s", down: "a\nb" },
    ]) {
      expect(DeployPlanSchema.safeParse(await withMigrations(migrations)).success).toBe(false);
    }
  });

  it("requires app.releaseCommand", async () => {
    const migrations = { tool: "knex", status: "s", down: downs.knex };
    const found = issues(DeployPlanSchema.safeParse(await withMigrations(migrations, false)));
    expect(found).toEqual([
      {
        path: "app.migrations",
        message:
          "needs app.releaseCommand: the down commands undo what the release command migrates; add the release command, or remove app.migrations",
      },
    ]);
  });
});
