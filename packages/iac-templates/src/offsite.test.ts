// T2756: where each environment's off-server copies go, so two environments never share a folder.
import { type DeployPlan, DeployPlanSchema, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { withServices } from "./catalog/__fixtures__/plans";
import { offsiteFolderName, offsitePlace, offsiteRoot } from "./offsite";
import { inEnvironment } from "./workflow/__fixtures__/plans";

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

/** `shop` with PostgreSQL in prod, or in `environment`, its copies at `offsite`. */
function plan(offsite: object, environment?: string): DeployPlan {
  const base = withServices([{ kind: "postgres", name: "db" }]);
  const placed = environment === undefined ? base : inEnvironment(base, { name: environment });
  return DeployPlanSchema.parse({ ...placed, snapshots: { offsite } });
}

/** `plan`'s copy off the server, which it has. */
function copyOf(p: DeployPlan) {
  const copy = snapshotOffsiteOf(p);
  if (copy === undefined) throw new Error("The test plan has no off-server copy.");
  return copy;
}

/** The root of `plan`'s copies. */
const root = (p: DeployPlan) => offsiteRoot(p, copyOf(p));

describe("offsiteRoot", () => {
  it("gives each environment its own folder in the user's own bucket and on the SFTP machine", () => {
    expect(root(plan(S3))).toBe("offsite:shop-backups/shop-prod/backups");
    expect(root(plan(S3, "staging"))).toBe("offsite:shop-backups/shop-staging/backups");
    expect(root(plan(SFTP))).toBe("offsite:/backups/shop-prod/backups");
    expect(root(plan(SFTP, "staging"))).toBe("offsite:/backups/shop-staging/backups");
    expect(root(plan({ ...SFTP, path: "/" }))).toBe("offsite:/shop-prod/backups");
  });

  it("keeps a bucket OpsCrew plans, one per environment, as it was", () => {
    const r2 = plan({ provider: "r2", bucket: "shop-prod-backups" });
    expect(root(r2)).toBe("offsite:shop-prod-backups/backups");
    const spaces = plan(
      { provider: "digitalocean", bucket: "shop-staging-backups", region: "fra1" },
      "staging",
    );
    expect(root(spaces)).toBe("offsite:shop-staging-backups/backups");
  });

  it("names the environment's folder as its backups bucket is named", () => {
    expect(offsiteFolderName(plan(S3))).toBe("shop-prod");
    expect(offsiteFolderName(plan(S3, "staging"))).toBe("shop-staging");
  });
});

describe("offsitePlace", () => {
  it("says where the copies are, with no secret", () => {
    expect(offsitePlace(plan(S3), copyOf(plan(S3)))).toBe(
      "your bucket shop-backups at https://s3.eu-central-1.wasabisys.com (us-east-1)",
    );
    const machine = plan({ ...SFTP, port: 23 }, "staging");
    expect(offsitePlace(machine, copyOf(machine))).toBe(
      "the folder /backups/shop-staging/backups on backup.example.com (port 23)",
    );
  });
});
