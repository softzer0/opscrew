// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation and shell syntax in expected contents, not JavaScript templates.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { IMAGES, TOOLS, toolDownloadUrl } from "../pins";
import { shellQuote } from "../runtime/services";
import { withSqlite } from "../workflow/__fixtures__/plans";
import { shWorks } from "../workflow/__fixtures__/sh";
import { SQLITE_COPY } from "../workflow/snapshots";
import { portainerTestPlan } from "./__fixtures__/plans";
import {
  fillPortainerStack,
  PORTAINER_IMAGE_PLACEHOLDER,
  PORTAINER_OFFSITE_VARIABLES,
  PORTAINER_RELEASE_PLACEHOLDER,
  portainerServiceEnvironment,
  portainerSnapshotParts,
  portainerSnapshotsVolume,
  portainerStackEnvKeys,
  portainerStackVolumes,
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
      'export PGPASSWORD="$POSTGRES_PASSWORD" && pg_dump -h db -U app -Fc -f "$t" app',
    );
    const queue = scheduled.stack.services["snapshots-queue"];
    expect(queue?.image).toBe(IMAGES.valkey.ref);
    expect(script(queue)).toContain(
      'export REDISCLI_AUTH="$VALKEY_PASSWORD" && valkey-cli -h queue --rdb "$t"',
    );
    expect(queue?.volumes).toEqual(["queue_data:/data:ro", "snapshots:/snapshots"]);
  });

  it("copies the SQLite volume as sqlite.tar with the servers' program on the pinned python image, read-write", () => {
    for (const name of ["snapshots-sqlite", "snapshot-sqlite"]) {
      const services =
        name === "snapshots-sqlite" ? scheduled.stack.services : release.stack.services;
      const sqlite = services[name];
      expect(sqlite?.image, name).toBe(IMAGES.python.ref);
      expect(sqlite?.network_mode).toBe("none");
      expect(sqlite?.volumes).toEqual(["sqlite:/sqlite", "snapshots:/snapshots"]);
      const text = script(sqlite);
      expect(text).toContain('t="$1"/sqlite.tar.tmp');
      expect(text).toContain(
        `(umask 077 && python3 -c ${shellQuote(SQLITE_COPY)} /sqlite > "$t"); r=$?`,
      );
    }
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
      '{ [ -e "$d"/db.done ] || [ -e "$d"/db.failed ] || [ -e "$d"/db.skipped ]; } && { [ -e "$d"/queue.done ] || [ -e "$d"/queue.failed ] || [ -e "$d"/queue.skipped ]; } && { [ -e "$d"/sqlite.done ] || [ -e "$d"/sqlite.failed ] || [ -e "$d"/sqlite.skipped ]; }',
    );
    expect(text).toContain('finish "$d" "$id" scheduled && prune scheduled 5');
    expect(text).toContain(
      `printf '{"name":"db","kind":"postgres","file":"db.dump","size":%s,"image":"${IMAGES.postgres.ref}"}' "$(stat -c %s "$1"/db.dump)"`,
    );
    expect(text).toContain(`printf '{"name":"queue","kind":"valkey","failed":true}'`);
    expect(text).toContain('chmod 600 "$1"/* && chmod 700 "$1"');
  });

  it("keeps the snapshots in the stack's own volume, recorded as data, and the stamp names the running image", () => {
    expect(portainerSnapshotsVolume(scheduledPlan)).toBe("opscrew-shop_snapshots");
    expect(scheduled.stack.volumes.snapshots).toEqual({});
    expect(portainerStackVolumes(scheduledPlan)).toEqual([
      "opscrew-shop_db_data",
      "opscrew-shop_queue_data",
      "opscrew-shop_rabbitmq_data",
      "opscrew-shop_sqlite",
      "opscrew-shop_snapshots",
      "opscrew-shop_version",
    ]);
    expect(Object.keys(scheduled.stack.volumes)).toEqual(
      portainerStackVolumes(scheduledPlan).map((volume) => volume.slice("opscrew-shop_".length)),
    );
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

  it("is off in prod unless asked, and with deploy.snapshots false", () => {
    const has = (plan: DeployPlan) => "snapshot" in render(plan).stack.services;
    expect(has(snapshotPlan())).toBe(false);
    expect(has(snapshotPlan({ deploy: { ...snapshotPlan().deploy, snapshots: true } }))).toBe(true);
    expect(
      has(staging(snapshotPlan(), { deploy: { ...snapshotPlan().deploy, snapshots: false } })),
    ).toBe(false);
    const valkeyOnly = portainerTestPlan({ redis: true, releaseCommand: "npm run migrate" });
    expect(has(staging(valkeyOnly))).toBe(true);
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
    snapshots: { offsite: { provider: "hetzner", bucket: "shop-prod-backups", region: "fsn1" } },
  });
  const { stack, content } = render(plan);
  const offsite = stack.services.offsite;

  it("runs the pinned rclone image with the bucket's settings and key from stack variables", () => {
    expect(offsite?.image).toBe(IMAGES.rclone.ref);
    expect(offsite?.environment).toEqual({
      RCLONE_CONFIG_OFFSITE_TYPE: "s3",
      RCLONE_CONFIG_OFFSITE_PROVIDER: "Hetzner",
      RCLONE_CONFIG_OFFSITE_ENDPOINT: "${OPSCREW_OFFSITE_ENDPOINT}",
      RCLONE_CONFIG_OFFSITE_REGION: "fsn1",
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: "${OPSCREW_OFFSITE_ACCESS_KEY_ID}",
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: "${OPSCREW_OFFSITE_SECRET_ACCESS_KEY}",
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "true",
      OPSCREW_OFFSITE_RECIPIENT: "${OPSCREW_OFFSITE_RECIPIENT}",
    });
    expect(offsite?.volumes).toEqual(["snapshots:/snapshots", "snapshot_tools:/tools"]);
    expect(stack.volumes.snapshots).toEqual({});
    expect(stack.volumes.snapshot_tools).toEqual({});
    expect(portainerStackVolumes(plan).slice(-3)).toEqual([
      "opscrew-shop_snapshots",
      "opscrew-shop_snapshot_tools",
      "opscrew-shop_version",
    ]);
    expect(portainerStackEnvKeys(plan).opscrew).toEqual(
      expect.arrayContaining(Object.values(PORTAINER_OFFSITE_VARIABLES)),
    );
  });

  it("keeps age's archive in its tools volume, checking its SHA-256 and unpacking age before each use", () => {
    const text = script(offsite);
    expect(text).toContain(
      `rclone copyurl '${toolDownloadUrl("age", "amd64")}' /tmp/age/age.tar.gz`,
    );
    expect(text).toContain(
      `age_ok() { echo '${TOOLS.age.sha256.amd64}  /tools/age.tar.gz' | sha256sum -c -s && rm -rf /tmp/age && mkdir /tmp/age && tar -xzf /tools/age.tar.gz -C /tmp/age age/age; }`,
    );
    expect(text).toContain(
      "age_ready() { age_ok || age_fetch || { echo 'OpsCrew: age could not be fetched and checked against its pinned SHA-256.' >&2; return 1; }; }",
    );
    expect(text).toContain("  age_ready || return 1");
    const arm = render(
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, arch: "arm64" } }),
    );
    expect(script(arm.stack.services.offsite)).toContain(TOOLS.age.sha256.arm64);
  });

  it("streams each file through age into rclone rcat, about.json last, then offsite.done", () => {
    const text = script(offsite);
    expect(text).toContain("set -o pipefail");
    // Never a snapshot being written: the schedule's and a release's, or one by hand.
    expect(text).toContain('case "$d" in *.partial|*.taking) continue ;; esac');
    expect(text).toContain(
      `/tmp/age/age/age -r "$OPSCREW_OFFSITE_RECIPIENT" < "$1" | rclone rcat 'offsite:shop-prod-backups/backups/'"$2"`,
    );
    expect(text.indexOf('put "$f" "$id/${f##*/}.age"')).toBeLessThan(
      text.indexOf('put "$d"/about.json "$id"/about.json.age'),
    );
    expect(text).toContain('touch "$d"/offsite.done');
    expect(shParses(text)).toBe(true);
  });

  it.skipIf(!shWorks())(
    "never copies off a snapshot before a release, which a 64-hex digest names (D16)",
    () => {
      const skip = script(offsite)
        .split("\n")
        .find((line) => line.includes("*[!0-9a-f]*"));
      expect(skip?.trim()).toBe('case "${d##*/}" in *[!0-9a-f]*) ;; *) continue ;; esac');
      const names = ["a".repeat(64), "20261107T000000Z", "0123abcd".repeat(8)];
      const kept = spawnSync(
        "sh",
        [
          "-c",
          `for d in ${names.map((n) => `/snapshots/${n}`).join(" ")}; do\n${skip}\necho "\${d##*/}"\ndone`,
        ],
        { encoding: "utf8" },
      );
      expect(kept.stdout.trim().split("\n")).toEqual(["20261107T000000Z"]);
    },
  );

  it("takes the bucket's region from the plan, R2's auto, and rclone's provider of each", () => {
    const environment = (offsite: object) =>
      render(snapshotPlan({ snapshots: { offsite } })).stack.services.offsite?.environment;
    const spaces = environment({
      provider: "digitalocean",
      bucket: "shop-prod-backups",
      region: "fra1",
    });
    expect(spaces?.RCLONE_CONFIG_OFFSITE_PROVIDER).toBe("DigitalOcean");
    expect(spaces?.RCLONE_CONFIG_OFFSITE_REGION).toBe("fra1");
    const r2 = environment({ provider: "r2", bucket: "shop-prod-backups" });
    expect(r2?.RCLONE_CONFIG_OFFSITE_PROVIDER).toBe("Cloudflare");
    expect(r2?.RCLONE_CONFIG_OFFSITE_REGION).toBe("auto");
  });

  it("matches the snapshot", () => {
    expect(content).toMatchSnapshot();
  });
});

describe("the parts and environments for a snapshot by hand", () => {
  it("lists each online part with its file, image and copy, the ones the stack runs", () => {
    const parts = portainerSnapshotParts(scheduledPlan);
    expect(
      parts.map(({ name, kind, file, image, service, mounts }) => ({
        name,
        kind,
        file,
        image,
        service: service?.name,
        mounts,
      })),
    ).toEqual([
      {
        name: "db",
        kind: "postgres",
        file: "db.dump",
        image: IMAGES.postgres.ref,
        service: "db",
        mounts: [{ volume: "db_data", target: "/var/lib/postgresql/data", readOnly: true }],
      },
      {
        name: "queue",
        kind: "valkey",
        file: "queue.rdb",
        image: IMAGES.valkey.ref,
        service: "queue",
        mounts: [{ volume: "queue_data", target: "/data", readOnly: true }],
      },
      {
        name: "sqlite",
        kind: "sqlite",
        file: "sqlite.tar",
        image: IMAGES.python.ref,
        service: undefined,
        mounts: [{ volume: "sqlite", target: "/sqlite", readOnly: false }],
      },
    ]);
    for (const part of parts) {
      const service = scheduled.stack.services[`snapshots-${part.name}`];
      expect(service?.image).toBe(part.image);
      // The part's mounts are its container's only ones, with the snapshots volume.
      expect(service?.volumes).toEqual([
        ...part.mounts.map(
          ({ volume, target, readOnly }) => `${volume}:${target}${readOnly ? ":ro" : ""}`,
        ),
        "snapshots:/snapshots",
      ]);
      expect(script(service)).toContain(`(umask 077 && ${part.copy}); r=$?`);
    }
    // Stop-only kinds are not among them.
    expect(parts.map((part) => part.name)).not.toContain("rabbitmq");
    expect(scheduled.stack.services["snapshots-queue"]?.volumes).toContain("queue_data:/data:ro");
  });

  it("gives each service's environment as the stack does, its secrets as stack variables", () => {
    const [db, queue] = scheduledPlan.services;
    if (db === undefined || queue === undefined) throw new Error("The plan has no services.");
    expect(portainerServiceEnvironment(scheduledPlan, db)).toEqual({
      POSTGRES_USER: "${OPSCREW_DB_USER}",
      POSTGRES_DB: "${OPSCREW_DB_NAME}",
      POSTGRES_PASSWORD: "${OPSCREW_DB_PASSWORD}",
    });
    expect(portainerServiceEnvironment(scheduledPlan, queue)).toEqual({
      VALKEY_PASSWORD: "${OPSCREW_SVC_QUEUE_PASSWORD}",
    });
    for (const service of [db, queue]) {
      expect(scheduled.stack.services[service.name]?.environment).toEqual(
        portainerServiceEnvironment(scheduledPlan, service),
      );
    }
  });
});

describe("a stack without snapshots", () => {
  it("has the snapshots volume a snapshot by hand writes into, and the version there, with data", () => {
    const plan = snapshotPlan();
    const { stack } = render(plan);
    expect(Object.keys(stack.services).filter((name) => /^(snapshot|offsite)/.test(name))).toEqual(
      [],
    );
    expect(stack.volumes.snapshots).toEqual({});
    expect(portainerStackVolumes(plan)).toContain("opscrew-shop_snapshots");
    expect(stack.services.stamp?.volumes).toEqual(["version:/version", "snapshots:/snapshots"]);
  });

  it("has no snapshot service or volume, and the stamp writes only the version, without data", () => {
    for (const plan of [portainerTestPlan()]) {
      expect(plan.services.filter((service) => service.enabled)).toEqual([]);
      const { stack } = render(plan);
      expect(
        Object.keys(stack.services).filter((name) => /^(snapshot|offsite)/.test(name)),
      ).toEqual([]);
      expect(stack.volumes.snapshots).toBeUndefined();
      expect(portainerStackVolumes(plan).some((volume) => volume.includes("snapshot"))).toBe(false);
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

const SH = spawnSync("sh", ["-c", "true"]).status === 0;

/** The shell function `name` of `text`: from `name() {` to its closing `}`. */
function shFunction(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`${name}() {`);
  const end = lines.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error(`The script has no function ${name}.`);
  return lines.slice(start, end + 1).join("\n");
}

describe.skipIf(!SH)("the snapshot scripts under sh", () => {
  let root = "";
  /** A fresh folder that stands for the snapshots volume (`/snapshots` in the scripts). */
  const volume = () => {
    root = mkdtempSync(join(tmpdir(), "opscrew-portainer-snapshots-")).replaceAll("\\", "/");
    return root;
  };
  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });
  /** `text` under sh, `/snapshots` being the test's folder. */
  const run = (text: string, env: Record<string, string> = {}) => {
    const result = spawnSync("sh", ["-c", text.replaceAll("/snapshots", root)], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
  };
  /** A finished snapshot `name` of `kind`, taken at `taken`. */
  const snapshot = (name: string, kind: string, taken: string) => {
    mkdirSync(join(root, name));
    writeFileSync(
      join(root, name, "about.json"),
      `{"id":"${name}","kind":"${kind}","taken":"${taken}","version":"","services":[]}\n`,
    );
  };

  it("prune keeps the newest scheduled snapshots, never another kind or one being written", () => {
    volume();
    snapshot("20261101T000000Z", "scheduled", "2026-11-01T00:00:00Z");
    snapshot("20261102T000000Z", "scheduled", "2026-11-02T00:00:00Z");
    snapshot("20261103T000000Z", "scheduled", "2026-11-03T00:00:00Z");
    snapshot("20261030T000000Z", "manual", "2026-10-30T00:00:00Z");
    snapshot("e".repeat(64), "release", "2026-10-29T00:00:00Z");
    // Being written, with about.json already there and newer than any finished one.
    snapshot("20261104T000000Z.taking", "scheduled", "2026-11-04T00:00:00Z");
    snapshot("20261105T000000Z.partial", "scheduled", "2026-11-05T00:00:00Z");
    const prune = shFunction(script(scheduled.stack.services.snapshots), "prune");
    const result = run(`${prune}\nprune scheduled 2`);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(root).sort()).toEqual([
      "20261030T000000Z",
      "20261102T000000Z",
      "20261103T000000Z",
      "20261104T000000Z.taking",
      "20261105T000000Z.partial",
      "e".repeat(64),
    ]);
  });

  describe("the outgoing version before a release", () => {
    const OLD = `ghcr.io/acme/shop@sha256:${"0a".repeat(32)}`;
    // The part's script, which prints the snapshot's key instead of taking it.
    const part = script(release.stack.services["snapshot-db"]).replace(
      'take /snapshots/"$hex".partial',
      'echo "hex=$hex"',
    );
    const outgoing = (running: string | undefined, env: Record<string, string>) => {
      volume();
      if (running !== undefined) writeFileSync(join(root, ".running"), `${running}\n`);
      return run(part, { OPSCREW_RELEASE: "run", OPSCREW_APP_IMAGE: IMAGE, ...env });
    };

    it("is none before the stamp named a running image, in a rollback, or for the same image", () => {
      const cases: [string | undefined, Record<string, string>][] = [
        [undefined, {}],
        [OLD, { OPSCREW_RELEASE: "skip" }],
        [IMAGE, {}],
      ];
      for (const [running, env] of cases) {
        expect(outgoing(running, env)).toMatchObject({ status: 0, stdout: "" });
      }
    });

    it("is the running image's digest", () => {
      expect(outgoing(OLD, {})).toMatchObject({ status: 0, stdout: `hex=${"0a".repeat(32)}` });
    });

    it("stops the deploy when the running image is not pinned by digest", () => {
      const malformed = ["ghcr.io/acme/shop:latest", `ghcr.io/acme/shop@sha256:${"0a".repeat(31)}`];
      for (const running of malformed) {
        const result = outgoing(running, {});
        expect(result.status, running).toBe(1);
        expect(result.stderr).toContain("names no image pinned by digest");
      }
    });
  });

  describe("the guard on data a rollback restored (D19)", () => {
    const OLD = `ghcr.io/acme/shop@sha256:${"0a".repeat(32)}`;
    const RESTORE = "opscrew restore 20261011T120000Z --env staging";
    // The finalizer, which prints the snapshot's key instead of finishing it.
    const finalizer = script(release.stack.services.snapshot).replace(
      'finish /snapshots/"$hex".partial "$hex" release && prune release 3',
      'echo "hex=$hex"',
    );
    const finalize = (restored: string | undefined, env: Record<string, string>) => {
      volume();
      writeFileSync(join(root, ".running"), `${OLD}\n`);
      // As the rollback writes it: the image, then the restore that is the way out.
      if (restored !== undefined) {
        writeFileSync(join(root, ".restored"), `${restored}\n${RESTORE}\n`);
      }
      return run(finalizer, { OPSCREW_RELEASE: "run", OPSCREW_APP_IMAGE: IMAGE, ...env });
    };

    it("checks .restored in the finalizer only, before the outgoing version", () => {
      expect(finalizer.indexOf("/snapshots/.restored")).toBeGreaterThan(-1);
      expect(finalizer.indexOf("/snapshots/.restored")).toBeLessThan(
        finalizer.indexOf("OPSCREW_RELEASE"),
      );
      expect(script(release.stack.services["snapshot-db"])).not.toContain(".restored");
    });

    it("leaves a deploy and a rollback as they were without the file", () => {
      expect(finalize(undefined, {})).toMatchObject({
        status: 0,
        stdout: `hex=${"0a".repeat(32)}`,
      });
      expect(finalize(undefined, { OPSCREW_RELEASE: "skip" })).toMatchObject({
        status: 0,
        stdout: "",
      });
    });

    it("lets the image the data was restored for start, by its digest", () => {
      expect(finalize(IMAGE, { OPSCREW_RELEASE: "skip" })).toMatchObject({ status: 0 });
      const other = `ghcr.io/Acme/shop@${IMAGE.split("@")[1]}`;
      expect(finalize(other, { OPSCREW_RELEASE: "skip" })).toMatchObject({ status: 0 });
    });

    it("fails for any other image: the workflow's revert, and a deploy", () => {
      for (const env of [{ OPSCREW_RELEASE: "skip" }, { OPSCREW_RELEASE: "run" }]) {
        const result = finalize(OLD, env);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          `OpsCrew: opscrew rollback restored this stack's data for ${OLD}, so no other version starts on it until that rollback ends (/snapshots/.restored names it). If that rollback is stuck, run ${RESTORE} on the computer that ran it; it finishes the rollback and removes /snapshots/.restored.`.replaceAll(
            "/snapshots",
            root,
          ),
        );
      }
      expect(finalize("", {}).status).toBe(1);
    });
  });

  describe("a part and the finished snapshot", () => {
    const take = shFunction(script(scheduled.stack.services["snapshots-sqlite"]), "take");
    /** The SQLite part's `take` with Python exiting `code` (after writing its copy, for 0). */
    const taking = (code: number) => {
      const python = `python3() { if [ ${code} = 0 ]; then echo tar; fi; return ${code}; }`;
      return run(`${python}\n${take}\ntake /snapshots/slot.partial`);
    };

    it("records an app's SQLite volume without a database as skipped, never failed", () => {
      volume();
      expect(taking(3).status).toBe(0);
      expect(readdirSync(join(root, "slot.partial"))).toEqual(["sqlite.skipped"]);
      expect(taking(0).status).toBe(0);
      expect(readdirSync(join(root, "slot.partial")).sort()).toEqual(["sqlite.done", "sqlite.tar"]);
      expect(readFileSync(join(root, "slot.partial", "sqlite.tar"), "utf8")).toBe("tar\n");
      const failed = taking(1);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("the snapshot of sqlite failed");
      expect(readdirSync(join(root, "slot.partial")).sort()).toEqual([
        "sqlite.failed",
        "sqlite.tar",
      ]);
    });

    it("writes about.json with each part's file and size, skipped or failed, and drops the markers", () => {
      volume();
      const slot = join(root, "20261106T120000Z.partial");
      mkdirSync(slot);
      writeFileSync(join(root, ".running"), `${IMAGE}\n`);
      writeFileSync(join(slot, "db.dump"), "dump");
      for (const marker of ["db.done", "queue.failed", "sqlite.skipped"]) {
        writeFileSync(join(slot, marker), "");
      }
      const finish = shFunction(script(scheduled.stack.services.snapshots), "finish");
      // chown to root needs root; the owner and modes are checked in Docker.
      const result = run(
        `chown() { :; }\n${finish}\nfinish /snapshots/20261106T120000Z.partial 20261106T120000Z scheduled`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(slot)).toBe(false);
      const done = join(root, "20261106T120000Z");
      expect(readdirSync(done).sort()).toEqual(["about.json", "db.dump"]);
      expect(JSON.parse(readFileSync(join(done, "about.json"), "utf8"))).toEqual({
        id: "20261106T120000Z",
        kind: "scheduled",
        taken: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        version: IMAGE.slice(IMAGE.indexOf("@") + 1),
        services: [
          // A service's copy records the image the stack pins it to.
          { name: "db", kind: "postgres", file: "db.dump", size: 4, image: IMAGES.postgres.ref },
          { name: "queue", kind: "valkey", failed: true },
          { name: "sqlite", kind: "sqlite", skipped: true },
        ],
      });
    });
  });
});
