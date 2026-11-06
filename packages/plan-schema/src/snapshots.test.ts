// Feature 024: snapshots and restores as commands (T2402, plan.md 9.). The plan's fields
// `deploy.snapshotStop` and `snapshots`, with their defaults and refusals.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { previewPlanOf } from "./__fixtures__/preview-plan";
import {
  type DeployPlan,
  DeployPlanSchema,
  parseArtifact,
  snapshotOffsiteOf,
  snapshotScheduleOf,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: a test plan is edited as loose JSON before parsing.
type Loose = Record<string, any>;

/** The fixture's prod plan on Hetzner, with Postgres (`db`), Valkey (`cache`) and RabbitMQ (`mq`). */
async function prodPlan(): Promise<Loose> {
  const plan: Loose = await parseArtifact("plan", await fixture("plan.yaml"), "fixture");
  const db = plan.services[0];
  const cache = { ...db, name: "cache", kind: "valkey", options: { mode: "cache" } };
  const mq = { ...db, name: "mq", kind: "rabbitmq", options: {} };
  return { ...plan, services: [db, cache, mq] };
}

/** The plan of a `before-placement` fixture for `kind`. */
async function targetPlan(kind: string): Promise<Loose> {
  return parseArtifact("plan", await fixture(`before-placement/plan-${kind}.yaml`), "fixture");
}

function issues(plan: Loose) {
  const result = DeployPlanSchema.safeParse(plan);
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [];
}

const parse = (plan: Loose): DeployPlan => DeployPlanSchema.parse(plan);

const offsite = { provider: "r2", bucket: "shop-prod-backups" };

describe("deploy.snapshotStop and snapshots.schedule.stop", () => {
  it("take services of the stop-only kinds", async () => {
    const plan = await prodPlan();
    const parsed = parse({
      ...plan,
      deploy: { snapshotStop: ["mq"] },
      snapshots: { schedule: { stop: ["mq"] } },
    });
    expect(parsed.deploy.snapshotStop).toEqual(["mq"]);
    expect(parsed.snapshots?.schedule?.stop).toEqual(["mq"]);
  });

  it("refuse a name that is no service of the plan", async () => {
    const plan = await prodPlan();
    expect(issues({ ...plan, deploy: { snapshotStop: ["mq", "queue"] } })).toEqual([
      {
        path: "deploy.snapshotStop.1",
        message:
          'names no service of the plan ("queue"); use a name from services, or remove it from deploy.snapshotStop',
      },
    ]);
    expect(issues({ ...plan, snapshots: { schedule: { stop: ["queue"] } } })[0]?.path).toBe(
      "snapshots.schedule.stop.0",
    );
  });

  it("refuse a service that is turned off", async () => {
    const plan = await prodPlan();
    const services = plan.services.map((service: Loose) =>
      service.name === "mq" ? { ...service, enabled: false } : service,
    );
    expect(issues({ ...plan, services, deploy: { snapshotStop: ["mq"] } })).toEqual([
      {
        path: "deploy.snapshotStop.0",
        message:
          'can\'t name "mq": that service is turned off, so there is nothing to snapshot; remove it from deploy.snapshotStop',
      },
    ]);
    const scheduled = issues({ ...plan, services, snapshots: { schedule: { stop: ["mq"] } } });
    expect(scheduled.map((issue) => issue.path)).toEqual(["snapshots.schedule.stop.0"]);
  });

  it("refuse a scheduled stop on Portainer, which has no Docker socket", async () => {
    const plan: Loose = await targetPlan("portainer");
    const mq = { ...plan.services[0], name: "mq", kind: "rabbitmq", options: {} };
    const services = [...plan.services, mq];
    expect(issues({ ...plan, services, snapshots: { schedule: { stop: ["mq"] } } })).toEqual([
      {
        path: "snapshots.schedule.stop",
        message:
          "must be empty on a Portainer target: stopping a service needs Docker on the host, which the stack has no access to; snapshot those services by hand with opscrew snapshot, and remove snapshots.schedule.stop",
      },
    ]);
    const empty = { ...plan, services, snapshots: { schedule: { stop: [] } } };
    expect(DeployPlanSchema.safeParse(empty).success).toBe(true);
  });

  it("refuse a stop before each release on Portainer too", async () => {
    const plan: Loose = await targetPlan("portainer");
    const mq = { ...plan.services[0], name: "mq", kind: "rabbitmq", options: {} };
    const services = [...plan.services, mq];
    const deploy = (snapshotStop: string[]) => ({ ...plan.deploy, snapshotStop });
    expect(issues({ ...plan, services, deploy: deploy(["mq"]) })).toEqual([
      {
        path: "deploy.snapshotStop",
        message:
          "must be empty on a Portainer target: stopping a service needs Docker on the host, which the stack has no access to; snapshot those services by hand with opscrew snapshot, and remove deploy.snapshotStop",
      },
    ]);
    expect(DeployPlanSchema.safeParse({ ...plan, services, deploy: deploy([]) }).success).toBe(
      true,
    );
  });

  it("refuse the kinds a snapshot copies while they run", async () => {
    const plan = await prodPlan();
    const db = plan.services[0];
    const kinds: [string, Loose][] = [
      ["postgres", {}],
      ["mysql", {}],
      ["mariadb", {}],
      ["mongodb", {}],
      ["valkey", { mode: "cache" }],
      ["redis", { mode: "cache" }],
      ["dragonfly", { mode: "cache" }],
    ];
    for (const [kind, options] of kinds) {
      const services = [{ ...db, kind, options }];
      const found = issues({ ...plan, services, deploy: { snapshotStop: ["db"] } });
      expect(found, kind).toEqual([
        {
          path: "deploy.snapshotStop.0",
          message: `can't name "db": a snapshot copies ${kind} while it runs, so it is never stopped; remove it from deploy.snapshotStop`,
        },
      ]);
      const scheduled = issues({ ...plan, services, snapshots: { schedule: { stop: ["db"] } } });
      expect(scheduled.map((issue) => issue.path)).toEqual(["snapshots.schedule.stop.0"]);
    }
  });
});

describe("snapshots.schedule", () => {
  it("is off when absent, and the plan keeps its shape", async () => {
    const parsed = parse(await prodPlan());
    expect(parsed).not.toHaveProperty("snapshots");
    expect(parsed.deploy).not.toHaveProperty("snapshotStop");
    expect(snapshotScheduleOf(parsed)).toBeUndefined();
    expect(snapshotOffsiteOf(parsed)).toBeUndefined();
  });

  it("is weekly, keeps 4 and stops nothing by default, without writing the defaults", async () => {
    const parsed = parse({ ...(await prodPlan()), snapshots: { schedule: {} } });
    expect(parsed.snapshots).toEqual({ schedule: {} });
    expect(snapshotScheduleOf(parsed)).toEqual({ every: "weekly", keep: 4, stop: [] });
  });

  it("takes daily, weekly and 1h to 168h, and keeps 1 to 30", async () => {
    const plan = await prodPlan();
    for (const every of ["daily", "weekly", "1h", "9h", "12h", "99h", "100h", "159h", "168h"]) {
      const parsed = parse({ ...plan, snapshots: { schedule: { every, keep: 30 } } });
      expect(snapshotScheduleOf(parsed), every).toEqual({ every, keep: 30, stop: [] });
    }
    for (const every of ["0h", "169h", "200h", "01h", "h", "12", "monthly", "1.5h"]) {
      const found = issues({ ...plan, snapshots: { schedule: { every } } });
      expect(
        found.map((issue) => issue.path),
        every,
      ).toEqual(["snapshots.schedule.every"]);
    }
    for (const keep of [0, 31, 2.5]) {
      const found = issues({ ...plan, snapshots: { schedule: { keep } } });
      expect(
        found.map((issue) => issue.path),
        `${keep}`,
      ).toEqual(["snapshots.schedule.keep"]);
    }
    expect(parse({ ...plan, snapshots: { schedule: { keep: 1 } } }).snapshots?.schedule).toEqual({
      keep: 1,
    });
  });

  it("is taken on a cloud server, the user's own server and Portainer", async () => {
    for (const kind of ["hetzner", "digitalocean", "own", "portainer"]) {
      const plan = await targetPlan(kind);
      const parsed = DeployPlanSchema.safeParse({ ...plan, snapshots: { schedule: {} } });
      expect(parsed.error?.issues, kind).toBeUndefined();
    }
  });

  it("is refused on this computer", async () => {
    const plan = await targetPlan("localhost");
    expect(issues({ ...plan, snapshots: { schedule: {} } })).toEqual([
      {
        path: "snapshots.schedule",
        message:
          "is refused with the localhost target: this computer isn't always on to take them; take one when you need it with opscrew snapshot, and remove snapshots.schedule",
      },
    ]);
    // The off-server copy of a snapshot taken by hand stays possible.
    expect(DeployPlanSchema.safeParse({ ...plan, snapshots: { offsite } }).success).toBe(true);
  });
});

describe("snapshots.offsite", () => {
  it("keeps copies 90 days by default, without writing it", async () => {
    const parsed = parse({ ...(await prodPlan()), snapshots: { offsite } });
    expect(parsed.snapshots).toEqual({ offsite });
    expect(snapshotOffsiteOf(parsed)).toEqual({ ...offsite, region: "auto", days: 90 });
  });

  it("takes R2, Hetzner and DigitalOcean, 1 to 3650 days and 013's bucket names", async () => {
    const plan = await prodPlan();
    for (const provider of ["r2", "hetzner", "digitalocean"]) {
      for (const days of [1, 3650]) {
        const region = provider === "r2" ? undefined : "fsn1";
        const value = { ...offsite, provider, days, ...(region === undefined ? {} : { region }) };
        const parsed = parse({ ...plan, snapshots: { offsite: value } });
        expect(snapshotOffsiteOf(parsed)).toEqual({ ...value, region: region ?? "auto" });
      }
    }
    const refused: [Loose, string][] = [
      [{ ...offsite, provider: "garage" }, "snapshots.offsite.provider"],
      [{ ...offsite, provider: "s3" }, "snapshots.offsite.provider"],
      [{ ...offsite, bucket: "Shop_Backups" }, "snapshots.offsite.bucket"],
      [{ ...offsite, bucket: "ab" }, "snapshots.offsite.bucket"],
      [{ ...offsite, days: 0 }, "snapshots.offsite.days"],
      [{ ...offsite, days: 3651 }, "snapshots.offsite.days"],
      [{ provider: "r2" }, "snapshots.offsite.bucket"],
      [{ ...offsite, provider: "hetzner" }, "snapshots.offsite.region"],
      [{ ...offsite, provider: "digitalocean" }, "snapshots.offsite.region"],
      [{ ...offsite, region: "" }, "snapshots.offsite.region"],
    ];
    for (const [value, path] of refused) {
      const found = issues({ ...plan, snapshots: { offsite: value } });
      expect(
        found.map((issue) => issue.path),
        JSON.stringify(value),
      ).toEqual([path]);
    }
  });
});

describe("snapshots where there is nothing to keep", () => {
  it("is refused on site targets", async () => {
    for (const kind of ["cloudflare-workers", "github-pages"]) {
      const plan = await targetPlan(kind);
      const found = issues({ ...plan, snapshots: { schedule: {}, offsite } });
      expect(found, kind).toEqual([
        {
          path: "snapshots.schedule",
          message: "is refused on a site target, which keeps no data; remove snapshots.schedule",
        },
        {
          path: "snapshots.offsite",
          message: "is refused on a site target, which keeps no data; remove snapshots.offsite",
        },
      ]);
    }
  });

  it("is refused in a preview environment", async () => {
    const plan: Loose = previewPlanOf(parse(await prodPlan()));
    const found = issues({ ...plan, snapshots: { schedule: {}, offsite } });
    expect(found.map((issue) => issue.path)).toEqual(["snapshots.schedule", "snapshots.offsite"]);
    expect(found[0]?.message).toBe(
      "is refused on a preview environment, whose previews come and go; remove snapshots.schedule",
    );
  });
});
