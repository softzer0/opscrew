// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation and shell syntax in expected contents, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { IMAGES, TOOLS, toolDownloadUrl } from "../pins";
import { withSqlite } from "../workflow/__fixtures__/plans";
import { portainerTestPlan } from "./__fixtures__/plans";
import {
  fillPortainerStack,
  PORTAINER_IMAGE_PLACEHOLDER,
  PORTAINER_OFFSITE_VARIABLES,
  PORTAINER_RELEASE_PLACEHOLDER,
  portainerSnapshotsVolume,
  portainerStackEnvKeys,
  renderPortainerStack,
} from "./index";

type Service = {
  image?: string;
  user?: string;
  restart?: string;
  environment?: Record<string, string>;
  entrypoint?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
  network_mode?: string;
  networks?: string[];
  mem_limit?: string;
};
type Stack = { services: Record<string, Service>; volumes: Record<string, unknown> };

const ctx = testContext({ acmeEmail: "ops@example.com" });
const IMAGE = `ghcr.io/acme/shop@sha256:${"ab".repeat(32)}`;

/**
 * `shop` on Portainer with PostgreSQL (`db`), Valkey in queue mode (`queue`), a RabbitMQ (stop-only),
 * SQLite in `data`, a release command, and `fields` over the plan.
 */
function snapshotPlan(fields: Record<string, unknown> = {}): DeployPlan {
  const base = withSqlite(
    portainerTestPlan({ postgres: true, releaseCommand: "npm run migrate" }),
    { dir: "data" },
  );
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      build: {
        builder: "railpack",
        chosen: "auto",
        reason: "test",
        runtime: { language: "node", version: "24" },
        probe: "node",
      },
    },
    services: [
      ...base.services,
      {
        name: "queue",
        kind: "valkey",
        version: "8",
        memoryMb: 128,
        enabled: true,
        options: { mode: "queue" },
        reason: "Jobs.",
        licence: "BSD-3-Clause",
      },
      {
        name: "rabbitmq",
        kind: "rabbitmq",
        version: "4.3",
        memoryMb: 512,
        enabled: true,
        options: {},
        reason: "Events.",
        licence: "MPL-2.0",
      },
    ],
    ...fields,
  });
}

/** `plan` in the staging environment. */
function staging(plan: DeployPlan, fields: Record<string, unknown> = {}): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    environment: { name: "staging" },
    app: { ...plan.app, name: `${plan.app.name}-staging` },
    ...fields,
  });
}

function render(plan: DeployPlan): { content: string; stack: Stack } {
  const { content } = renderPortainerStack(plan, ctx);
  return { content, stack: parse(content) as Stack };
}

/** The shell script of a service's `sh -c` entrypoint, as the container's shell sees it. */
function script(service: Service | undefined): string {
  const text = service?.entrypoint?.[2];
  if (text === undefined) throw new Error("The service runs no shell script.");
  return text.replaceAll("$$", "$");
}

/** Whether `sh -n` parses `text` (skipped where no POSIX sh is on the PATH). */
function shParses(text: string): boolean {
  const result = spawnSync("sh", ["-n"], { input: text, encoding: "utf8" });
  if (result.error !== undefined) return true;
  if (result.status !== 0) throw new Error(result.stderr);
  return true;
}

const scheduledPlan = snapshotPlan({ snapshots: { schedule: { every: "12h", keep: 5 } } });
const scheduled = render(scheduledPlan);

describe("the scheduled snapshots in a stack", () => {
  it("runs one loop per online part and the snapshots service, never a stop-only kind (D3)", () => {
    const names = Object.keys(scheduled.stack.services);
    expect(names.filter((name) => name.startsWith("snapshot"))).toEqual([
      "snapshots-db",
      "snapshots-queue",
      "snapshots-sqlite",
      "snapshots",
    ]);
    expect(names).not.toContain("snapshots-rabbitmq");
  });

  it("copies each service from its own pinned image, with its environment and data read-only", () => {
    const db = scheduled.stack.services["snapshots-db"];
    expect(db?.image).toBe(IMAGES.postgres.ref);
    expect(db?.user).toBe("0:0");
    expect(db?.restart).toBe("unless-stopped");
    expect(db?.environment).toEqual({
      POSTGRES_USER: "${OPSCREW_DB_USER}",
      POSTGRES_DB: "${OPSCREW_DB_NAME}",
      POSTGRES_PASSWORD: "${OPSCREW_DB_PASSWORD}",
      OPSCREW_SNAPSHOT_EVERY: "43200",
    });
    expect(db?.volumes).toEqual(["db_data:/var/lib/postgresql/data:ro", "snapshots:/snapshots"]);
    expect(db?.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(db?.networks).toEqual(["internal"]);
    expect(script(db)).toContain(
      'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h db -U "$POSTGRES_USER" -Fc -f "$t" "$POSTGRES_DB"',
    );
    const queue = scheduled.stack.services["snapshots-queue"];
    expect(queue?.image).toBe(IMAGES.valkey.ref);
    expect(script(queue)).toContain(
      'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli -h queue --rdb "$t"',
    );
    expect(queue?.volumes).toEqual(["queue_data:/data:ro", "snapshots:/snapshots"]);
  });

  it("copies SQLite with the pinned python image as the volume's owner, the volume read-write", () => {
    const sqlite = scheduled.stack.services["snapshots-sqlite"];
    expect(sqlite?.image).toBe(IMAGES.python.ref);
    expect(sqlite?.network_mode).toBe("none");
    expect(sqlite?.volumes).toEqual(["sqlite:/sqlite", "snapshots:/snapshots"]);
    const text = script(sqlite);
    expect(text).toContain("os.setgid(s.st_gid); os.setuid(s.st_uid)");
    expect(text).toContain("src.backup(dst)");
    expect(text).toContain("pragma journal_mode=delete");
  });

  it("sleeps to the next slot of `every` and writes <file>.tmp, then the file and <part>.done", () => {
    const text = script(scheduled.stack.services["snapshots-db"]);
    expect(text).toContain(
      "slot=$(( (now / $OPSCREW_SNAPSHOT_EVERY + 1) * $OPSCREW_SNAPSHOT_EVERY ))",
    );
    expect(text).toContain('take /snapshots/"$(date -u -d "@$slot" +%Y%m%dT%H%M%SZ)".partial');
    expect(text).toContain('t="$1"/db.dump.tmp');
    expect(text).toContain('mv "$t" "$1"/db.dump; then');
    expect(text).toContain('touch "$1"/db.done');
    expect(text).toContain('touch "$1"/db.failed');
    for (const name of ["snapshots-db", "snapshots-queue", "snapshots-sqlite", "snapshots"]) {
      expect(shParses(script(scheduled.stack.services[name])), name).toBe(true);
    }
  });

  it("writes about.json once every part settled or the slot is given up, then keeps `keep`", () => {
    const snapshots = scheduled.stack.services.snapshots;
    expect(snapshots?.image).toBe(IMAGES.busybox.ref);
    expect(snapshots?.network_mode).toBe("none");
    expect(snapshots?.volumes).toEqual(["snapshots:/snapshots"]);
    expect(snapshots?.environment).toEqual({ OPSCREW_SNAPSHOT_GIVE_UP: "21600" });
    const text = script(snapshots);
    expect(text).toContain(
      '{ [ -e "$d"/db.done ] || [ -e "$d"/db.failed ]; } && { [ -e "$d"/queue.done ] || [ -e "$d"/queue.failed ]; } && { [ -e "$d"/sqlite.done ] || [ -e "$d"/sqlite.failed ]; }',
    );
    expect(text).toContain('finish "$d" "$id" scheduled && prune scheduled 5');
    expect(text).toContain(
      `printf '{"name":"db","kind":"postgres","file":"db.dump","size":%s}' "$(stat -c %s "$1"/db.dump)"`,
    );
    expect(text).toContain(`printf '{"name":"queue","kind":"valkey","failed":true}'`);
    expect(text).toContain('chmod 600 "$1"/* && chmod 700 "$1"');
  });

  it("keeps the snapshots in the volume opscrew-snapshots-<app>, and the stamp names the running image", () => {
    expect(portainerSnapshotsVolume(scheduledPlan)).toBe("opscrew-snapshots-shop");
    expect(scheduled.stack.volumes.snapshots).toEqual({ name: "opscrew-snapshots-shop" });
    const stamp = scheduled.stack.services.stamp;
    expect(stamp?.environment?.OPSCREW_APP_IMAGE).toBe(PORTAINER_IMAGE_PLACEHOLDER);
    expect(stamp?.volumes).toEqual(["version:/version", "snapshots:/snapshots"]);
    expect(script(stamp)).toContain(
      `printf '%s\\n' "$OPSCREW_APP_IMAGE" > /snapshots/.running.tmp && mv /snapshots/.running.tmp /snapshots/.running`,
    );
  });

  it("counts `every` in seconds: daily, weekly by default, and hours", () => {
    const every = (schedule: object) =>
      render(snapshotPlan({ snapshots: { schedule } })).stack.services["snapshots-db"]?.environment
        ?.OPSCREW_SNAPSHOT_EVERY;
    expect(every({})).toBe("604800");
    expect(every({ every: "daily" })).toBe("86400");
    expect(every({ every: "1h" })).toBe("3600");
    const giveUp = render(snapshotPlan({ snapshots: { schedule: { every: "1h" } } })).stack.services
      .snapshots?.environment?.OPSCREW_SNAPSHOT_GIVE_UP;
    expect(giveUp).toBe("3600");
  });

  it("matches the snapshot", () => {
    expect(scheduled.content).toMatchSnapshot();
  });
});

const releasePlan = staging(snapshotPlan());
const release = render(releasePlan);

describe("the snapshot before each release in a stack", () => {
  it("runs one-offs before the release command, which with the app waits for `snapshot`", () => {
    const names = Object.keys(release.stack.services).filter((name) => name.startsWith("snapshot"));
    expect(names).toEqual(["snapshot-db", "snapshot-queue", "snapshot-sqlite", "snapshot"]);
    const done = { condition: "service_completed_successfully" };
    expect(release.stack.services.release?.depends_on?.snapshot).toEqual(done);
    expect(release.stack.services.app?.depends_on?.snapshot).toEqual(done);
    expect(release.stack.services.snapshot?.depends_on).toEqual({
      "snapshot-db": done,
      "snapshot-queue": done,
      "snapshot-sqlite": done,
    });
    for (const name of names) expect(release.stack.services[name]?.restart).toBe("no");
  });

  it("keys it by the outgoing image the stamp wrote, and skips a rollback and the same image", () => {
    const db = release.stack.services["snapshot-db"];
    expect(db?.environment).toMatchObject({
      OPSCREW_RELEASE: PORTAINER_RELEASE_PLACEHOLDER,
      OPSCREW_APP_IMAGE: PORTAINER_IMAGE_PLACEHOLDER,
    });
    const text = script(db);
    expect(text).toContain(
      'if [ "$OPSCREW_RELEASE" = skip ] || [ ! -f /snapshots/.running ]; then exit 0; fi',
    );
    expect(text).toContain('if [ "$out" = "$OPSCREW_APP_IMAGE" ]; then exit 0; fi');
    expect(text).toContain('take /snapshots/"$hex".partial');
    const finalizer = script(release.stack.services.snapshot);
    expect(finalizer).toContain(
      'finish /snapshots/"$hex".partial "$hex" release && prune release 3',
    );
    for (const name of ["snapshot-db", "snapshot-queue", "snapshot-sqlite", "snapshot"]) {
      expect(shParses(script(release.stack.services[name])), name).toBe(true);
    }
    const filled = parse(fillPortainerStack(release.content, IMAGE)) as Stack;
    expect(filled.services.snapshot?.environment).toEqual({
      OPSCREW_RELEASE: "run",
      OPSCREW_APP_IMAGE: IMAGE,
    });
  });

  it("is off in prod unless asked, with deploy.snapshots false, and without a database", () => {
    const has = (plan: DeployPlan) => "snapshot" in render(plan).stack.services;
    expect(has(snapshotPlan())).toBe(false);
    expect(
      has(staging(snapshotPlan(), { deploy: { ...snapshotPlan().deploy, snapshots: false } })),
    ).toBe(false);
    const valkeyOnly = portainerTestPlan({ redis: true, releaseCommand: "npm run migrate" });
    expect(has(staging(valkeyOnly))).toBe(false);
  });

  it("waits in the app when there is no release command", () => {
    const base = portainerTestPlan({ postgres: true });
    const { stack } = render(staging(base));
    expect(stack.services.release).toBeUndefined();
    expect(stack.services.app?.depends_on?.snapshot).toEqual({
      condition: "service_completed_successfully",
    });
  });
});

describe("the off-server copy in a stack", () => {
  const plan = snapshotPlan({
    snapshots: { offsite: { provider: "hetzner", bucket: "shop-prod-backups" } },
  });
  const { stack, content } = render(plan);
  const offsite = stack.services.offsite;

  it("runs the pinned rclone image with the bucket's settings and key from stack variables", () => {
    expect(offsite?.image).toBe(IMAGES.rclone.ref);
    expect(offsite?.environment).toEqual({
      RCLONE_CONFIG_OFFSITE_TYPE: "s3",
      RCLONE_CONFIG_OFFSITE_PROVIDER: "Other",
      RCLONE_CONFIG_OFFSITE_ENDPOINT: "${OPSCREW_OFFSITE_ENDPOINT}",
      RCLONE_CONFIG_OFFSITE_REGION: "${OPSCREW_OFFSITE_REGION}",
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: "${OPSCREW_OFFSITE_ACCESS_KEY_ID}",
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: "${OPSCREW_OFFSITE_SECRET_ACCESS_KEY}",
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
      OPSCREW_OFFSITE_RECIPIENT: "${OPSCREW_OFFSITE_RECIPIENT}",
    });
    expect(offsite?.volumes).toEqual(["snapshots:/snapshots", "snapshot_tools:/tools"]);
    expect(stack.volumes).toMatchObject({ snapshots: { name: "opscrew-snapshots-shop" } });
    expect(stack.volumes.snapshot_tools).toEqual({});
    expect(portainerStackEnvKeys(plan).opscrew).toEqual(
      expect.arrayContaining(Object.values(PORTAINER_OFFSITE_VARIABLES)),
    );
  });

  it("fetches age once, checking the archive's and the binary's SHA-256, and the binary before each use", () => {
    const text = script(offsite);
    expect(text).toContain(
      `rclone copyurl '${toolDownloadUrl("age", "amd64")}' /tmp/age/age.tar.gz`,
    );
    expect(text).toContain(
      `echo '${TOOLS.age.sha256.amd64}  /tmp/age/age.tar.gz' | sha256sum -c -s`,
    );
    expect(text).toContain(
      `echo '${TOOLS.age.binarySha256.amd64}  /tmp/age/age/age' | sha256sum -c -s`,
    );
    expect(text).toContain(
      `age_ok() { echo '${TOOLS.age.binarySha256.amd64}  /tools/age' | sha256sum -c -s; }`,
    );
    expect(text).toContain("  age_ok || fetch_age || {");
    const arm = render(
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, arch: "arm64" } }),
    );
    expect(script(arm.stack.services.offsite)).toContain(TOOLS.age.binarySha256.arm64);
  });

  it("streams each file through age into rclone rcat, about.json last, then offsite.done", () => {
    const text = script(offsite);
    expect(text).toContain("set -o pipefail");
    expect(text).toContain(
      `/tools/age -r "$OPSCREW_OFFSITE_RECIPIENT" < "$1" | rclone rcat 'offsite:shop-prod-backups/backups/'"$2"`,
    );
    expect(text.indexOf('put "$f" "$id/${f##*/}.age"')).toBeLessThan(
      text.indexOf('put "$d"/about.json "$id"/about.json.age'),
    );
    expect(text).toContain('touch "$d"/offsite.done');
    expect(shParses(text)).toBe(true);
  });

  it("names the region only for Hetzner, and DigitalOcean as rclone's provider", () => {
    const spaces = snapshotPlan({
      snapshots: { offsite: { provider: "digitalocean", bucket: "shop-prod-backups" } },
    });
    const environment = render(spaces).stack.services.offsite?.environment;
    expect(environment?.RCLONE_CONFIG_OFFSITE_PROVIDER).toBe("DigitalOcean");
    expect(environment?.RCLONE_CONFIG_OFFSITE_REGION).toBeUndefined();
    expect(portainerStackEnvKeys(spaces).opscrew).not.toContain("OPSCREW_OFFSITE_REGION");
  });

  it("matches the snapshot", () => {
    expect(content).toMatchSnapshot();
  });
});

describe("a stack without snapshots", () => {
  it("has no snapshot service or volume, and the stamp writes only the version", () => {
    for (const plan of [snapshotPlan(), portainerTestPlan()]) {
      const { stack } = render(plan);
      expect(
        Object.keys(stack.services).filter((name) => /^(snapshot|offsite)/.test(name)),
      ).toEqual([]);
      expect(stack.volumes.snapshots).toBeUndefined();
      expect(stack.services.stamp?.volumes).toEqual(["version:/version"]);
      expect(stack.services.stamp?.environment).toEqual({
        OPSCREW_APP_VERSION: "__OPSCREW_APP_VERSION__",
      });
      expect(portainerStackEnvKeys(plan).opscrew.some((name) => name.includes("OFFSITE"))).toBe(
        false,
      );
    }
  });
});
