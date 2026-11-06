/**
 * Pure helpers of feature 023's live pass (`retarget-anywhere.test.ts`, docs/e2e.md "Retarget
 * anywhere"): its legs and their variables, reading the command a stopped `opscrew retarget`
 * printed and the flags the next run passes, the services the pass adds to the example, the
 * scripts that seed and read their data in the containers, the bucket's objects, the addresses
 * in OpsCrew's server record, and DigitalOcean's answer for a Spaces key. No network, no
 * processes; unit-tested in `retarget-anywhere-support.test.ts`.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { opscrewNames } from "@opscrew/connector-portainer";
import { pinnedVersion, serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema } from "@opscrew/plan-schema";
import { z } from "zod";
import { splitCommand } from "./support";

// ---------------------------------------------------------------------------------------------
// The legs and their variables.

/** The pass's gate. */
export const RETARGET_GATE = "OPSCREW_E2E_RETARGET_ANYWHERE";

/** The variables every leg on a server needs besides its gate. */
const SERVER_LEG_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** The pass's legs, in the order they run. */
export type Leg = "own" | "portainer" | "site" | "digitalocean";

/** What each leg needs besides the gate. */
export const LEG_VARIABLES: Readonly<Record<Leg, readonly string[]>> = {
  own: SERVER_LEG_VARIABLES,
  portainer: [...SERVER_LEG_VARIABLES, "OPSCREW_E2E_GHCR_READ_TOKEN"],
  site: [
    "OPSCREW_E2E_GITHUB_REPO_C",
    "OPSCREW_E2E_GITHUB_TOKEN",
    "OPSCREW_E2E_CLOUDFLARE_TOKEN",
    "OPSCREW_E2E_CLOUDFLARE_DEPLOY_TOKEN",
    "OPSCREW_E2E_DOMAIN",
  ],
  digitalocean: [
    ...SERVER_LEG_VARIABLES,
    "OPSCREW_E2E_DIGITALOCEAN_TOKEN",
    "OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID",
    "OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY",
  ],
};

/** The interview regions whose Hetzner locations have Object Storage. */
const STORAGE_REGIONS = ["eu-central", "eu-north"];

/**
 * Why `leg` does not run (its title says it), or `undefined` when it does: the gate, then each
 * missing variable; the bucket's leg also needs a region with Hetzner Object Storage.
 */
export function legSkip(env: Record<string, string | undefined>, leg: Leg): string | undefined {
  const missing = [
    ...(env[RETARGET_GATE] === "1" ? [] : [`${RETARGET_GATE}=1`]),
    ...LEG_VARIABLES[leg].filter((name) => (env[name] ?? "").trim() === ""),
  ];
  if (missing.length > 0) return `set ${missing.join(", ")}`;
  const region = env.OPSCREW_E2E_REGION?.trim() || "eu-central";
  if (leg === "digitalocean" && !STORAGE_REGIONS.includes(region)) {
    return `Hetzner Object Storage is only in ${STORAGE_REGIONS.join(" and ")}, not in OPSCREW_E2E_REGION=${region}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The command a stopped run printed, and the next run's flags.

const PLAN_HASH = /^[0-9a-f]{64}$/;

/**
 * The arguments (after `opscrew retarget`) of the last command in backquotes that `output` asks
 * to run with `--approve <hash>`: what a stop at a plan says to run next. `undefined` when it
 * printed none.
 */
export function printedApproval(output: string): string[] | undefined {
  let found: string[] | undefined;
  for (const [, command = ""] of output.matchAll(/`(opscrew retarget(?: [^`]*)?)`/g)) {
    const args = splitCommand(command).slice(2);
    if (PLAN_HASH.test(flagValue(args, "--approve") ?? "")) found = args;
  }
  return found;
}

/** The value after the last `flag` in `args`. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.lastIndexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** Every `--confirm` name in `args`. */
export function confirmNames(args: readonly string[]): string[] {
  return args.flatMap((arg, at) =>
    arg === "--confirm" && args[at + 1] !== undefined ? [args[at + 1] as string] : [],
  );
}

/**
 * `args` with each group of `extra` added unless it is there already (a flag, or a flag with its
 * value, such as `--confirm shop`), and without `--allow-downtime` when `downtime` is false.
 */
export function withFlags(
  args: readonly string[],
  extra: readonly (readonly string[])[],
  downtime: boolean,
): string[] {
  const out = args.filter((arg) => downtime || arg !== "--allow-downtime");
  for (const group of extra) {
    if (!downtime && group.includes("--allow-downtime")) continue;
    const has = out.some((_, at) => group.every((arg, offset) => out[at + offset] === arg));
    if (!has) out.push(...group);
  }
  return out;
}

/**
 * Whether a stopped run is the refused maintenance window: a run without `--allow-downtime`
 * whose output names that flag and asks for no plan other than the one it was given.
 */
export function windowRefused(output: string, approved: string | undefined): boolean {
  const printed = printedApproval(output);
  const asked = printed === undefined ? undefined : flagValue(printed, "--approve");
  return output.includes("--allow-downtime") && (asked === undefined || asked === approved);
}

// ---------------------------------------------------------------------------------------------
// The example's data: Postgres, MySQL and Valkey added to examples/flask-sqlite.

/** The example of the server legs: its own SQLite file, written through `PUT /data`. */
export const DATA_EXAMPLE = "flask-sqlite";

/** The services the pass adds (by name), as a user adds them to `services` in plan.yaml. */
export const MOVE_SERVICES = { postgres: "db", mysql: "mysql", valkey: "queue" } as const;

/** How many rows each database gets, and how many jobs wait in Valkey. */
export const ROWS = 1000;
export const JOBS = 300;

/** The test's table in both databases, and its list of jobs in Valkey. */
const TABLE = "opscrew_e2e_rows";
const JOB_LIST = "opscrew-e2e:jobs";

/**
 * The plan with Postgres, MySQL and Valkey (holding a queue's jobs, so it keeps them on disk)
 * added, as a user adds services to plan.yaml before design runs again (design keeps them).
 */
export function withMoveServices(plan: DeployPlan): DeployPlan {
  const added = (["postgres", "mysql", "valkey"] as const)
    .filter((kind) => !plan.services.some((service) => service.name === MOVE_SERVICES[kind]))
    .map((kind) => {
      const spec = serviceSpec(kind);
      return PlanServiceSchema.parse({
        name: MOVE_SERVICES[kind],
        kind,
        version: pinnedVersion(spec),
        memoryMb: spec.memory.defaultMb,
        ...(kind === "valkey" ? { options: { mode: "queue" } } : {}),
        reason: "Added in plan.yaml by the retarget live test, for the data a move copies.",
        licence: spec.licence.id,
      });
    });
  return { ...plan, services: [...plan.services, ...added] };
}

/** The Compose project of the app's containers on its target: `opscrew-<app>` in Portainer. */
export function composeProjectOf(plan: Pick<DeployPlan, "app" | "target">): string {
  return plan.target.provider === "portainer" ? opscrewNames(plan.app.name).app : plan.app.name;
}

/**
 * The host command that runs `script` with `sh -c` in the running container of `service` in the
 * Compose project `project`. The script travels in base64, so no quoting reaches it; values such
 * as `$MYSQL_PASSWORD` are expanded inside the container only.
 */
export function inContainer(project: string, service: string, script: string): string {
  const encoded = Buffer.from(script).toString("base64");
  return [
    `c=$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service})`,
    `if [ -z "$c" ]; then echo "no running container of ${service} in ${project}" >&2; exit 3; fi`,
    `docker exec "$c" sh -c "$(echo ${encoded} | base64 -d)"`,
  ].join("; ");
}

const psql = (sql: string) => `psql -v ON_ERROR_STOP=1 -U app -d app -tAc "${sql}"`;
const mysql = (sql: string) => `MYSQL_PWD="$MYSQL_PASSWORD" mysql -uapp -N -B app -e "${sql}"`;
const valkey = (args: string) => `REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli ${args}`;

/**
 * The scripts that seed each service (the jobs named after `marker`). Each may run again after a
 * failure (a database still starting) and leaves the same data.
 */
export function seedScripts(marker: string): Record<keyof typeof MOVE_SERVICES, string> {
  // The jobs are made in a loop in the container: a list of them on the command line is long
  // enough to break the remote shell (run 1 of the own-server leg).
  const jobs = `{ i=1; set --; while [ "$i" -le ${JOBS} ]; do set -- "$@" "job-$i-${marker}"; i=$((i + 1)); done; }`;
  return {
    postgres: psql(
      `create table if not exists ${TABLE} (id integer primary key, v text not null); insert into ${TABLE} select g, md5(g::text) from generate_series(1, ${ROWS}) g on conflict do nothing`,
    ),
    // MySQL's recursive queries stop at 1,000 levels by default, so ROWS stays at 1,000.
    mysql: mysql(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INT PRIMARY KEY, v VARCHAR(64) NOT NULL); INSERT IGNORE INTO ${TABLE} (id, v) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${ROWS}) SELECT n, MD5(n) FROM s`,
    ),
    // SAVE writes the snapshot at once, so the jobs are on disk before any window.
    valkey: `${valkey(`DEL ${JOB_LIST}`)} >/dev/null && ${jobs} && ${valkey(`RPUSH ${JOB_LIST}`)} "$@" >/dev/null && ${valkey("SAVE")} >/dev/null`,
  };
}

/**
 * The scripts that read each service's data back: the rows' count and checksum (`<count>:<md5>`),
 * and the jobs in their order (one per line).
 */
export const READ_SCRIPTS: Record<keyof typeof MOVE_SERVICES, string> = {
  postgres: psql(
    `select count(*) || ':' || md5(string_agg(id || '=' || v, ',' order by id)) from ${TABLE}`,
  ),
  mysql: mysql(
    `SET SESSION group_concat_max_len = 4194304; SELECT CONCAT(COUNT(*), ':', MD5(GROUP_CONCAT(id, '=', v ORDER BY id SEPARATOR ','))) FROM ${TABLE}`,
  ),
  valkey: valkey(`LRANGE ${JOB_LIST} 0 -1`),
};

/** The app's SQLite file (flask-sqlite's `data/app.db`, from the image's working folder). */
export const SQLITE_SCRIPT = "sha256sum data/app.db | cut -d ' ' -f 1";

/** What the pass compares after each move: each service's data and the SQLite file. */
export interface DataSnapshot {
  postgres: string;
  mysql: string;
  /** `<count> jobs, <sha256 of the list>`. */
  jobs: string;
  sqlite: string;
}

/** The jobs a `LRANGE` printed, as `<count> jobs, <sha256>` (blank lines left out). */
export function jobsDigest(lines: string): string {
  const jobs = lines.split(/\r?\n/).filter((line) => line.trim() !== "");
  return `${jobs.length} jobs, ${createHash("sha256").update(jobs.join("\n")).digest("hex")}`;
}

/** What differs between the seeded data and what a side holds, by name, never by value. */
export function dataProblems(seeded: DataSnapshot, now: DataSnapshot): string[] {
  return (Object.keys(seeded) as (keyof DataSnapshot)[])
    .filter((key) => seeded[key] !== now[key])
    .map((key) =>
      key === "sqlite"
        ? "the app's SQLite file differs"
        : key === "jobs"
          ? `Valkey's jobs differ (${now.jobs.split(",")[0]} instead of ${seeded.jobs.split(",")[0]})`
          : `${key}'s rows differ (${now[key].split(":")[0] || "none"} instead of ${seeded[key].split(":")[0]})`,
    );
}

/**
 * The services whose seeded data does not have the count the seed writes (a service empty on both
 * sides would otherwise compare equal), by name.
 */
export function seedProblems(snapshot: DataSnapshot): string[] {
  return [
    snapshot.postgres.startsWith(`${ROWS}:`) ? "" : "postgres",
    snapshot.mysql.startsWith(`${ROWS}:`) ? "" : "mysql",
    snapshot.jobs.startsWith(`${JOBS} jobs,`) ? "" : "valkey",
  ].filter((name) => name !== "");
}

// ---------------------------------------------------------------------------------------------
// The bucket's objects (examples/s3-uploads, through its own S3 client in its container).

/** The example of the bucket's leg. */
export const BUCKET_EXAMPLE = "s3-uploads";
/** How many objects the pass writes into the bucket. */
export const OBJECTS = 200;
/** Where in the bucket they go. */
const OBJECT_PREFIX = "opscrew-e2e/";

/** The variables OpsCrew reads the new bucket's key from while a move takes the bucket along. */
export const NEW_STORAGE_KEY_VARS = {
  accessKeyId: "OPSCREW_NEW_STORAGE_ACCESS_KEY_ID",
  secretAccessKey: "OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY",
} as const;

/**
 * The ES module the app's container runs with `node --input-type=module`: with `seed`, writes
 * {@link OBJECTS} objects (their text names `marker`) through the app's own key; then lists every
 * object under the pass's prefix as `<key> <etag> <size>` lines.
 */
export function objectsScript(seed: boolean, marker: string): string {
  return [
    'import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";',
    "const s3 = new S3Client({ endpoint: process.env.AWS_ENDPOINT_URL_S3, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });",
    "const Bucket = process.env.S3_BUCKET;",
    `const prefix = ${JSON.stringify(OBJECT_PREFIX)};`,
    `if (${seed}) {`,
    `  for (let i = 0; i < ${OBJECTS}; i += 20) {`,
    `    await Promise.all(Array.from({ length: Math.min(20, ${OBJECTS} - i) }, (_, j) => s3.send(new PutObjectCommand({ Bucket, Key: prefix + String(i + j).padStart(4, "0"), Body: "object " + (i + j) + " of " + ${JSON.stringify(marker)} + "\\n" }))));`,
    "  }",
    "}",
    "const lines = [];",
    "let token;",
    "do {",
    "  const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));",
    '  for (const item of page.Contents ?? []) lines.push([item.Key, item.ETag, item.Size].join(" "));',
    "  token = page.IsTruncated ? page.NextContinuationToken : undefined;",
    "} while (token);",
    'console.log(lines.sort().join("\\n"));',
  ].join("\n");
}

/** The host command that runs {@link objectsScript} in the app's container of `project`. */
export function objectsCommand(project: string, seed: boolean, marker: string): string {
  const encoded = Buffer.from(objectsScript(seed, marker)).toString("base64");
  return [
    `c=$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=app)`,
    `if [ -z "$c" ]; then echo "no running app container in ${project}" >&2; exit 3; fi`,
    `docker exec "$c" node --input-type=module -e "$(echo ${encoded} | base64 -d)"`,
  ].join("; ");
}

// ---------------------------------------------------------------------------------------------
// Addresses and keys.

/** Every IPv4 and IPv6 address among the string values of a JSON value (OpsCrew's server record). */
export function recordAddresses(json: unknown): { ipv4: string[]; ipv6: string[] } {
  const found = { ipv4: [] as string[], ipv6: [] as string[] };
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const version = isIP(value);
      if (version === 4 && !found.ipv4.includes(value)) found.ipv4.push(value);
      if (version === 6 && !found.ipv6.includes(value)) found.ipv6.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(json);
  return found;
}

const SpacesKeyAnswerSchema = z.object({
  key: z.object({
    name: z.string().min(1),
    access_key: z.string().min(1),
    secret_key: z.string().min(1),
  }),
});

/** DigitalOcean's answer to `POST /v2/spaces/keys`: the key's name and its two halves. */
export function spacesKeyOf(json: unknown): {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
} {
  const parsed = SpacesKeyAnswerSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      "DigitalOcean's answer for the new Spaces key has no name, access key or secret.",
    );
  }
  const { name, access_key, secret_key } = parsed.data.key;
  return { name, accessKeyId: access_key, secretAccessKey: secret_key };
}
