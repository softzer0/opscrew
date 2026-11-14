// Feature 024: snapshots and restores as commands (T2402, plan.md 9.). The plan's fields
// `deploy.snapshotStop` and `snapshots`, with their defaults and refusals.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { previewPlanOf } from "./__fixtures__/preview-plan";
import {
  backupsBucketOf,
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

  it("refuse a stop on Portainer, which has no Docker socket, before each release and scheduled", async () => {
    const plan: Loose = await targetPlan("portainer");
    const mq = { ...plan.services[0], name: "mq", kind: "rabbitmq", options: {} };
    const services = [...plan.services, mq];
    const paths: [string, (stop: string[]) => Loose][] = [
      ["deploy.snapshotStop", (snapshotStop) => ({ deploy: { ...plan.deploy, snapshotStop } })],
      ["snapshots.schedule.stop", (stop) => ({ snapshots: { schedule: { stop } } })],
    ];
    for (const [path, stopping] of paths) {
      expect(issues({ ...plan, services, ...stopping(["mq"]) })).toEqual([
        {
          path,
          message: `must be empty on a Portainer target: stopping a service needs Docker on the host, which the stack has no access to; snapshot those services by hand with opscrew snapshot, and remove ${path}`,
        },
      ]);
      expect(DeployPlanSchema.safeParse({ ...plan, services, ...stopping([]) }).success).toBe(true);
    }
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
    // Snapshots stay beside the data on this computer: no bucket off it either.
    expect(issues({ ...plan, snapshots: { offsite } })).toEqual([
      {
        path: "snapshots.offsite",
        message:
          "is refused with the localhost target: its snapshots stay on this computer, beside the data; copy the snapshots folder yourself if you need a copy elsewhere, and remove snapshots.offsite",
      },
    ]);
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
      [{ bucket: "shop-prod-backups" }, "snapshots.offsite.provider"],
      [{ ...offsite, endpoint: "https://s3.example.com" }, "snapshots.offsite"],
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

  it("names the bucket OpsCrew plans in the backups root only for R2, Hetzner and DigitalOcean", async () => {
    const plan = await prodPlan();
    const r2 = parse({ ...plan, snapshots: { offsite } });
    expect(backupsBucketOf(r2)).toEqual({ ...offsite, region: "auto", days: 90 });
    const own = parse({ ...plan, snapshots: { offsite: S3 } });
    expect(backupsBucketOf(own)).toBeUndefined();
    expect(backupsBucketOf(parse({ ...plan, snapshots: { offsite: SFTP } }))).toBeUndefined();
    expect(backupsBucketOf(parse(plan))).toBeUndefined();
  });
});

const S3 = {
  provider: "s3",
  endpoint: "https://s3.eu-central-1.wasabisys.com",
  bucket: "shop-backups",
};
const SFTP = {
  provider: "sftp",
  host: "backup.example.com",
  user: "shop-backups",
  path: "/backups",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
};

describe("snapshots.offsite on the user's own S3-compatible bucket", () => {
  it("takes its endpoint and bucket, with us-east-1 and 90 days by default, without writing them", async () => {
    const parsed = parse({ ...(await prodPlan()), snapshots: { offsite: S3 } });
    expect(parsed.snapshots).toEqual({ offsite: S3 });
    expect(snapshotOffsiteOf(parsed)).toEqual({ ...S3, region: "us-east-1", days: 90 });
    const given = { ...S3, endpoint: "https://minio.example.com:9000/", region: "eu-west-2" };
    const kept = parse({ ...(await prodPlan()), snapshots: { offsite: { ...given, days: 7 } } });
    expect(snapshotOffsiteOf(kept)).toEqual({ ...given, days: 7 });
  });

  it("takes S3's bucket names, dots included", async () => {
    const plan = await prodPlan();
    for (const bucket of ["abc", "shop.backups-2026", `a${"b".repeat(61)}c`]) {
      expect(
        parse({ ...plan, snapshots: { offsite: { ...S3, bucket } } }).snapshots,
        bucket,
      ).toEqual({ offsite: { ...S3, bucket } });
    }
  });

  it("refuses an http endpoint, one with a path or a login, a missing field and another provider's fields", async () => {
    const plan = await prodPlan();
    const refused: [Loose, string][] = [
      [{ ...S3, endpoint: "http://s3.example.com" }, "snapshots.offsite.endpoint"],
      [{ ...S3, endpoint: "https://s3.example.com/shop" }, "snapshots.offsite.endpoint"],
      [{ ...S3, endpoint: "https://user:pass@s3.example.com" }, "snapshots.offsite.endpoint"],
      [{ ...S3, endpoint: "s3.example.com" }, "snapshots.offsite.endpoint"],
      [{ provider: "s3", bucket: "shop-backups" }, "snapshots.offsite.endpoint"],
      [{ provider: "s3", endpoint: S3.endpoint }, "snapshots.offsite.bucket"],
      [{ ...S3, bucket: "Shop_Backups" }, "snapshots.offsite.bucket"],
      [{ ...S3, bucket: "-shop" }, "snapshots.offsite.bucket"],
      [{ ...S3, region: "eu west" }, "snapshots.offsite.region"],
      [{ ...S3, days: 0 }, "snapshots.offsite.days"],
      [{ ...S3, host: "backup.example.com" }, "snapshots.offsite"],
    ];
    for (const [value, path] of refused) {
      const found = issues({ ...plan, snapshots: { offsite: value } });
      expect(
        found.map((issue) => issue.path),
        JSON.stringify(value),
      ).toEqual([path]);
    }
    expect(
      issues({ ...plan, snapshots: { offsite: { ...S3, endpoint: "http://s3.example.com" } } })[0]
        ?.message,
    ).toBe(
      "must be an https:// address with no path, such as https://s3.eu-central-1.wasabisys.com",
    );
  });
});

describe("snapshots.offsite on the user's own machine over SFTP", () => {
  it("takes its host, user, folder and host key, with port 22 and 90 days by default, without writing them", async () => {
    const parsed = parse({ ...(await prodPlan()), snapshots: { offsite: SFTP } });
    expect(parsed.snapshots).toEqual({ offsite: SFTP });
    expect(snapshotOffsiteOf(parsed)).toEqual({ ...SFTP, port: 22, days: 90 });
    const given = { ...SFTP, host: "203.0.113.7", port: 23, path: "/", days: 30 };
    const kept = parse({ ...(await prodPlan()), snapshots: { offsite: given } });
    expect(snapshotOffsiteOf(kept)).toEqual(given);
  });

  it("takes the host key types ssh-keyscan reads", async () => {
    const plan = await prodPlan();
    for (const type of ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp521", "ssh-rsa"]) {
      const hostKey = `${type} AAAAB3NzaC1yc2EAAAADAQABAAABAQ==`;
      expect(
        DeployPlanSchema.safeParse({ ...plan, snapshots: { offsite: { ...SFTP, hostKey } } })
          .success,
        type,
      ).toBe(true);
    }
  });

  it("refuses a relative folder, one with . or .., a fingerprint for the key and another provider's fields", async () => {
    const plan = await prodPlan();
    const refused: [Loose, string][] = [
      [{ ...SFTP, path: "backups" }, "snapshots.offsite.path"],
      [{ ...SFTP, path: "~/backups" }, "snapshots.offsite.path"],
      [{ ...SFTP, path: "/backups/../etc" }, "snapshots.offsite.path"],
      [{ ...SFTP, path: "/backups/./shop" }, "snapshots.offsite.path"],
      [{ ...SFTP, path: "/backups/" }, "snapshots.offsite.path"],
      [{ ...SFTP, path: "/my backups" }, "snapshots.offsite.path"],
      [{ ...SFTP, host: "backup.example.com; rm -rf /" }, "snapshots.offsite.host"],
      [{ ...SFTP, host: "-oProxyCommand=x" }, "snapshots.offsite.host"],
      [{ ...SFTP, user: "-shop" }, "snapshots.offsite.user"],
      [{ ...SFTP, user: "shop backups" }, "snapshots.offsite.user"],
      [{ ...SFTP, port: 0 }, "snapshots.offsite.port"],
      [{ ...SFTP, port: 65536 }, "snapshots.offsite.port"],
      [
        { ...SFTP, hostKey: "SHA256:B8/U+nAjyhpmJINWrx+HI5/3+Hg8el/yoDL9IPskP5c" },
        "snapshots.offsite.hostKey",
      ],
      [{ ...SFTP, hostKey: "ssh-dss AAAAB3NzaC1kc3M=" }, "snapshots.offsite.hostKey"],
      [
        { provider: "sftp", host: SFTP.host, user: SFTP.user, path: SFTP.path },
        "snapshots.offsite.hostKey",
      ],
      [{ ...SFTP, bucket: "shop-backups" }, "snapshots.offsite"],
    ];
    for (const [value, path] of refused) {
      const found = issues({ ...plan, snapshots: { offsite: value } });
      expect(
        found.map((issue) => issue.path),
        JSON.stringify(value),
      ).toEqual([path]);
    }
    const relative = issues({ ...plan, snapshots: { offsite: { ...SFTP, path: "backups" } } });
    expect(relative[0]?.message).toBe(
      "must be an absolute folder such as /backups, of letters, digits, dots, hyphens and underscores, without a trailing slash or . and .. parts",
    );
  });

  it("is refused on this computer, as the other copies are", async () => {
    const plan = await targetPlan("localhost");
    for (const value of [S3, SFTP]) {
      expect(issues({ ...plan, snapshots: { offsite: value } }).map((i) => i.path)).toEqual([
        "snapshots.offsite",
      ]);
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
