import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  composeProjectOf,
  confirmNames,
  type DataSnapshot,
  dataProblems,
  flagValue,
  inContainer,
  JOBS,
  jobsDigest,
  legSkip,
  MOVE_SERVICES,
  objectsCommand,
  printedApproval,
  READ_SCRIPTS,
  RETARGET_GATE,
  ROWS,
  recordAddresses,
  seedProblems,
  seedScripts,
  spacesKeyOf,
  windowRefused,
  withFlags,
  withMoveServices,
} from "./retarget-anywhere-support";
import { type HetznerServerType, serverCandidates } from "./support";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

const ALL = {
  [RETARGET_GATE]: "1",
  OPSCREW_E2E_HCLOUD_TOKEN: "t",
  OPSCREW_E2E_GITHUB_REPO: "o/r",
  OPSCREW_E2E_GITHUB_REPO_C: "o/c",
  OPSCREW_E2E_GITHUB_TOKEN: "t",
  OPSCREW_E2E_CLOUDFLARE_TOKEN: "t",
  OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN: "t",
  OPSCREW_E2E_DOMAIN: "e2e.example.com",
  OPSCREW_E2E_GHCR_READ_TOKEN: "t",
  OPSCREW_E2E_DIGITALOCEAN_TOKEN: "t",
  OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID: "k",
  OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY: "s",
};

describe("legSkip", () => {
  it("runs every leg with the gate and its variables", () => {
    for (const leg of ["own", "portainer", "site", "digitalocean"] as const) {
      expect(legSkip(ALL, leg)).toBeUndefined();
    }
  });

  it("names the gate and each missing variable", () => {
    expect(legSkip({ ...ALL, [RETARGET_GATE]: undefined }, "own")).toBe(`set ${RETARGET_GATE}=1`);
    expect(legSkip({ ...ALL, OPSCREW_E2E_DIGITALOCEAN_TOKEN: " " }, "digitalocean")).toBe(
      "set OPSCREW_E2E_DIGITALOCEAN_TOKEN",
    );
    // The other legs do not need DigitalOcean.
    expect(legSkip({ ...ALL, OPSCREW_E2E_DIGITALOCEAN_TOKEN: undefined }, "own")).toBeUndefined();
    expect(legSkip({ ...ALL, OPSCREW_E2E_GHCR_READ_TOKEN: "" }, "portainer")).toBe(
      "set OPSCREW_E2E_GHCR_READ_TOKEN",
    );
  });

  it("keeps the bucket's leg to regions with Hetzner Object Storage", () => {
    expect(legSkip({ ...ALL, OPSCREW_E2E_REGION: "us-east" }, "digitalocean")).toContain(
      "OPSCREW_E2E_REGION=us-east",
    );
    expect(legSkip({ ...ALL, OPSCREW_E2E_REGION: "us-east" }, "own")).toBeUndefined();
  });
});

describe("the printed command", () => {
  it("is the last command with --approve and a plan hash", () => {
    const output = [
      "To undo it, run `opscrew retarget --abort`.",
      `Review the plan above, then run \`opscrew retarget --approve ${OTHER}\` to apply it.`,
      `Review the plan above, then run \`opscrew retarget --finish --confirm shop --confirm opscrew-e2e-x --approve ${HASH}\` to apply it and continue.`,
      "Pass --yes again with that command.",
    ].join("\n");
    const args = printedApproval(output) as string[];
    expect(args).toEqual([
      "--finish",
      "--confirm",
      "shop",
      "--confirm",
      "opscrew-e2e-x",
      "--approve",
      HASH,
    ]);
    expect(flagValue(args, "--approve")).toBe(HASH);
    expect(confirmNames(args)).toEqual(["shop", "opscrew-e2e-x"]);
  });

  it("reads the plain hint a refused switch prints, after the commands before it", () => {
    const output = [
      `Review the plan above, then run \`opscrew retarget --approve ${OTHER}\` to apply it.`,
      "✗ The switch was not approved. The app on the old server runs again.",
      `  To apply it later without prompts, run: opscrew retarget --approve ${HASH} --confirm shop. When you are ready, run \`opscrew retarget\` again (it repeats the maintenance window), or \`opscrew retarget --abort\` to undo the move.`,
    ].join("\n");
    expect(printedApproval(output)).toEqual(["--approve", HASH, "--confirm", "shop"]);
  });

  it("is none without a plan hash", () => {
    expect(printedApproval("Then run `opscrew retarget` again.")).toBeUndefined();
    expect(printedApproval("run `opscrew retarget --approve <hash>`")).toBeUndefined();
  });

  it("gets the run's own flags once, and loses --allow-downtime before the window", () => {
    const printed = ["--allow-downtime", "--approve", HASH, "--yes"];
    const extra = [["--yes"], ["--allow-downtime"], ["--confirm", "shop"]];
    expect(withFlags(printed, extra, true)).toEqual([
      "--allow-downtime",
      "--approve",
      HASH,
      "--yes",
      "--confirm",
      "shop",
    ]);
    expect(withFlags(printed, extra, false)).toEqual([
      "--approve",
      HASH,
      "--yes",
      "--confirm",
      "shop",
    ]);
    expect(withFlags(["--confirm", "shop"], [["--confirm", "shop"]], true)).toEqual([
      "--confirm",
      "shop",
    ]);
  });

  it("tells the refused maintenance window from a new plan", () => {
    const refused = `Allow the maintenance window with --allow-downtime: \`opscrew retarget --allow-downtime --approve ${HASH}\``;
    expect(windowRefused(refused, HASH)).toBe(true);
    expect(
      windowRefused("This run is not interactive: … the maintenance window --allow-downtime", HASH),
    ).toBe(true);
    expect(
      windowRefused(`run \`opscrew retarget --allow-downtime --approve ${OTHER}\``, HASH),
    ).toBe(false);
    expect(windowRefused("The deploy workflow failed.", HASH)).toBe(false);
  });
});

describe("the example's data", () => {
  it("adds Postgres, MySQL and a Valkey queue once, as plan.yaml entries", () => {
    const plan = { services: [] } as unknown as Parameters<typeof withMoveServices>[0];
    const added = withMoveServices(plan);
    expect(added.services.map((service) => [service.name, service.kind])).toEqual([
      [MOVE_SERVICES.postgres, "postgres"],
      [MOVE_SERVICES.mysql, "mysql"],
      [MOVE_SERVICES.valkey, "valkey"],
    ]);
    const queue = added.services.find((service) => service.kind === "valkey");
    expect(queue?.options).toEqual({ mode: "queue" });
    expect(withMoveServices(added).services).toHaveLength(3);
  });

  it("finds the app's containers by its Compose project: opscrew-<app> in Portainer", () => {
    const app = { name: "shop" };
    expect(composeProjectOf({ app, target: { provider: "own" } } as never)).toBe("shop");
    expect(composeProjectOf({ app, target: { provider: "portainer" } } as never)).toBe(
      "opscrew-shop",
    );
  });

  it("runs a script in a service's container without quoting it, its values expanded there", () => {
    const script = READ_SCRIPTS.mysql;
    const command = inContainer("shop", "mysql", script);
    expect(command).toContain(
      "--filter label=com.docker.compose.project=shop --filter label=com.docker.compose.service=mysql",
    );
    const encoded = /echo (\S+) \| base64 -d/.exec(command)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString()).toBe(script);
    expect(script).toContain('MYSQL_PWD="$MYSQL_PASSWORD"');
    expect(command).not.toContain("MYSQL_PASSWORD");
  });

  it("seeds ROWS rows in each database and JOBS jobs named after the run", () => {
    const seeds = seedScripts("run1");
    expect(seeds.postgres).toContain(`generate_series(1, ${ROWS})`);
    expect(seeds.mysql).toContain(`n < ${ROWS}`);
    // The jobs are made in the container, job-1-run1 to job-${JOBS}-run1 in order.
    const loop = `${seeds.valkey.split(" && ")[1]}; printf '%s\\n' "$@"`;
    const made = spawnSync("sh", ["-c", loop], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(made).toHaveLength(JOBS);
    expect(made[0]).toBe("job-1-run1");
    expect(made.at(-1)).toBe(`job-${JOBS}-run1`);
    expect(seeds.valkey).toContain("SAVE");
  });

  it("digests the jobs and names what differs, never a value", () => {
    const lines = "job-1\njob-2\n\n";
    const digest = jobsDigest(lines);
    expect(digest).toBe(`2 jobs, ${createHash("sha256").update("job-1\njob-2").digest("hex")}`);
    const seeded: DataSnapshot = {
      postgres: `${ROWS}:p`,
      mysql: `${ROWS}:m`,
      jobs: `${JOBS} jobs, j`,
      sqlite: "s",
    };
    expect(seedProblems(seeded)).toEqual([]);
    expect(dataProblems(seeded, seeded)).toEqual([]);
    const now: DataSnapshot = { postgres: "", mysql: `${ROWS}:x`, jobs: "0 jobs, e", sqlite: "t" };
    expect(dataProblems(seeded, now)).toEqual([
      `postgres's rows differ (none instead of ${ROWS})`,
      `mysql's rows differ (${ROWS} instead of ${ROWS})`,
      `Valkey's jobs differ (0 jobs instead of ${JOBS} jobs)`,
      "the app's SQLite file differs",
    ]);
    expect(seedProblems(now)).toEqual(["postgres", "valkey"]);
  });

  it("runs the bucket's script with node in the app's container", () => {
    const command = objectsCommand("shop", true, "run1");
    expect(command).toContain("--filter label=com.docker.compose.service=app");
    const encoded = /echo (\S+) \| base64 -d/.exec(command)?.[1] ?? "";
    const script = Buffer.from(encoded, "base64").toString();
    expect(script).toContain("PutObjectCommand");
    expect(script).toContain('"run1"');
    expect(objectsCommand("shop", false, "run1")).not.toBe(command);
  });
});

describe("addresses and keys", () => {
  it("finds every address in a server record", () => {
    const record = {
      schemaVersion: 1,
      deployment: { ipv4: "203.0.113.10", ipv6: "2001:db8::1" },
      retarget: { from: { ipv4: "198.51.100.7" }, note: "not an address" },
      servers: { data: { ipv4: "203.0.113.10" } },
    };
    expect(recordAddresses(record)).toEqual({
      ipv4: ["203.0.113.10", "198.51.100.7"],
      ipv6: ["2001:db8::1"],
    });
  });

  it("reads DigitalOcean's Spaces key, and refuses an answer without it", () => {
    const access = `AK${"0".repeat(18)}`;
    const secret = "s".repeat(40);
    expect(
      spacesKeyOf({ key: { name: "opscrew-e2e-x", access_key: access, secret_key: secret } }),
    ).toEqual({ name: "opscrew-e2e-x", accessKeyId: access, secretAccessKey: secret });
    expect(() => spacesKeyOf({ key: { name: "x" } })).toThrow(/no name, access key or secret/);
  });
});

describe("serverCandidates", () => {
  const types: HetznerServerType[] = [
    { name: "cx23", architecture: "x86", memory: 4, prices: [price("nbg1", "0.0060")] },
    { name: "cax11", architecture: "arm", memory: 4, prices: [price("nbg1", "0.0070")] },
  ];

  it("keeps x86 by default and Arm when asked", () => {
    expect(serverCandidates(types, ["nbg1"]).map((c) => c.serverType)).toEqual(["cx23"]);
    expect(serverCandidates(types, ["nbg1"], undefined, "arm").map((c) => c.serverType)).toEqual([
      "cax11",
    ]);
  });
});

function price(location: string, gross: string) {
  return { location, price_hourly: { gross } };
}
