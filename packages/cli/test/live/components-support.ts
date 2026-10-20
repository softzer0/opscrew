/**
 * Pure helpers of the component checks (feature 013, docs/e2e.md "Components"): which Hetzner
 * pass an example gets and when it skips, the plan edits a pass makes as a user would (the bucket's
 * provider, a search engine for its kernel setting), and reading what the server shows (`docker
 * inspect`, the data folders, the settings files, the kernel settings, `opscrew status`, the cron
 * container's log). No network, no processes; unit-tested in `components-support.test.ts`.
 */
import { createHash } from "node:crypto";
import { plannedComponents, STORAGE_KEY_VARS, type StorageKey } from "@opscrew/agents";
import { upperFirst } from "@opscrew/core";
import { EDGE_PROJECT, IMAGES, pinnedVersion, serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, PlanServiceSchema } from "@opscrew/plan-schema";
import { parse } from "yaml";

// ---------------------------------------------------------------------------------------------
// The Hetzner passes and their variables.

/** The examples the Hetzner component passes deploy (SC-1301's live set), one server each. */
export const COMPONENT_EXAMPLES = [
  "node-bullmq",
  "express-mysql",
  "node-mongo",
  "s3-uploads",
  "rabbitmq-worker",
  "kafka-app",
  "meili-search",
  "clickhouse-events",
] as const;

/** The interview regions whose Hetzner locations have Object Storage (fsn1, nbg1, hel1). */
const HETZNER_STORAGE_REGIONS = ["eu-central", "eu-north"];

/** The example whose bucket a pass puts on R2 or Hetzner Object Storage. */
const STORAGE_EXAMPLE = "s3-uploads";
/** The example that also gets OpenSearch, for the kernel setting it needs. */
const SEARCH_EXAMPLE = "meili-search";

/** Where the s3-uploads pass keeps the bucket (`OPSCREW_E2E_STORAGE`, default `r2`). */
export type StorageChoice = { provider: "r2" } | { provider: "hetzner"; key: StorageKey };

/** What a Hetzner component pass does besides the checks every example gets. */
export interface ComponentSettings {
  app: string;
  /** s3-uploads only. */
  storage?: StorageChoice;
  /** meili-search only: OpenSearch is added to the plan for its `vm.max_map_count`. */
  searchEngine: boolean;
}

/**
 * The component pass for `app` (an example name, `undefined` for a GitHub repository) with
 * `OPSCREW_E2E_COMPONENTS=1`; otherwise the one line the pass logs to say why the checks do not
 * run, or `{ skip }` with the reason the whole pass is skipped (a bucket whose credentials are not
 * there).
 */
export function componentSettings(
  app: string | undefined,
  env: Record<string, string | undefined>,
): ComponentSettings | { skip: string } | string {
  if (env.OPSCREW_E2E_COMPONENTS !== "1") {
    return "not checked: the component checks of feature 013 (set OPSCREW_E2E_COMPONENTS=1, see docs/e2e.md)";
  }
  if (app === undefined || !(COMPONENT_EXAMPLES as readonly string[]).includes(app)) {
    return `not checked: OPSCREW_E2E_COMPONENTS=1 checks only ${COMPONENT_EXAMPLES.join(", ")}`;
  }
  const settings: ComponentSettings = { app, searchEngine: app === SEARCH_EXAMPLE };
  if (app !== STORAGE_EXAMPLE) return settings;
  if (
    (env.OPSCREW_E2E_DOMAIN ?? "").trim() === "" ||
    (env.OPSCREW_E2E_CLOUDFLARE_TOKEN ?? "") === ""
  ) {
    return {
      skip: "s3-uploads uploads through presigned links, so its bucket needs the app's domain: set OPSCREW_E2E_CLOUDFLARE_TOKEN and OPSCREW_E2E_DOMAIN",
    };
  }
  const choice = env.OPSCREW_E2E_STORAGE?.trim() || "r2";
  if (choice === "r2") {
    if (env.OPSCREW_E2E_R2 !== "1") {
      return {
        skip: "the bucket on Cloudflare R2 needs an account with R2 turned on: set OPSCREW_E2E_R2=1 once it is (docs/e2e.md), or OPSCREW_E2E_STORAGE=hetzner",
      };
    }
    return { ...settings, storage: { provider: "r2" } };
  }
  if (choice === "hetzner") {
    const region = env.OPSCREW_E2E_REGION?.trim() || "eu-central";
    if (!HETZNER_STORAGE_REGIONS.includes(region)) {
      return {
        skip: `Hetzner Object Storage is only in ${HETZNER_STORAGE_REGIONS.join(" and ")}, not in OPSCREW_E2E_REGION=${region}`,
      };
    }
    const accessKeyId = env.OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID?.trim() ?? "";
    const secretAccessKey = env.OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY?.trim() ?? "";
    if (accessKeyId === "" || secretAccessKey === "") {
      return {
        skip: "the bucket on Hetzner Object Storage needs your S3 credentials from the Hetzner Console: set OPSCREW_E2E_HETZNER_S3_ACCESS_KEY_ID and OPSCREW_E2E_HETZNER_S3_SECRET_ACCESS_KEY (docs/e2e.md)",
      };
    }
    return { ...settings, storage: { provider: "hetzner", key: { accessKeyId, secretAccessKey } } };
  }
  return { skip: `OPSCREW_E2E_STORAGE="${choice}" is neither r2 nor hetzner` };
}

/** The variables OpsCrew reads the bucket's key from in a script, holding `key`. */
export function storageKeyEnv(key: StorageKey): Record<string, string> {
  return {
    [STORAGE_KEY_VARS.accessKeyId]: key.accessKeyId,
    [STORAGE_KEY_VARS.secretAccessKey]: key.secretAccessKey,
  };
}

/**
 * Cloudflare's S3 credentials of an API token with an R2 permission: the token's id as the access
 * key ID, and the SHA-256 (hex) of the token's value as the secret.
 */
export function r2KeyOfToken(tokenId: string, token: string): StorageKey {
  return {
    accessKeyId: tokenId,
    secretAccessKey: createHash("sha256").update(token).digest("hex"),
  };
}

/** Hetzner Object Storage's locations; the bucket goes where the server is. */
const HETZNER_STORAGE_LOCATIONS = ["fsn1", "nbg1", "hel1"];

/**
 * The plan with its bucket on `provider`, named `bucket` (each run's own: bucket names at Hetzner
 * are shared by all its customers), as a user sets `storage.objectStorage` before running design
 * again. A Hetzner bucket goes into the server's location, which must have Object Storage.
 */
export function withBucket(
  plan: DeployPlan,
  provider: "r2" | "hetzner",
  bucket: string,
): DeployPlan {
  const storage = plan.storage?.objectStorage;
  if (storage === undefined)
    throw new Error("The plan has no object storage to choose a provider for.");
  const location = plan.target.provider === "hetzner" ? plan.target.location : undefined;
  if (provider === "hetzner" && !HETZNER_STORAGE_LOCATIONS.includes(location ?? "")) {
    throw new Error(
      `The server runs in ${location ?? "no Hetzner location"}, which has no Hetzner Object Storage (only ${HETZNER_STORAGE_LOCATIONS.join(", ")}); set OPSCREW_E2E_REGION=eu-central or eu-north.`,
    );
  }
  const region = provider === "r2" ? "auto" : (location as string);
  return {
    ...plan,
    storage: { ...plan.storage, objectStorage: { ...storage, provider, bucket, region } },
  };
}

/** The search engine the meili-search pass adds: OpenSearch needs the host's `vm.max_map_count`. */
const ADDED_ENGINE = "opensearch";

/**
 * The plan with OpenSearch added as a service the app does not use, as a user adds one to
 * `services` in plan.yaml (design keeps it): its kernel setting is what the pass checks on
 * Hetzner, and what a Portainer target must refuse.
 */
export function withSearchEngine(plan: DeployPlan): DeployPlan {
  const spec = serviceSpec(ADDED_ENGINE);
  const service = PlanServiceSchema.parse({
    name: ADDED_ENGINE,
    kind: ADDED_ENGINE,
    version: pinnedVersion(spec),
    memoryMb: spec.memory.defaultMb,
    reason: "Added in plan.yaml by the live test, for the kernel setting it needs.",
    licence: spec.licence.id,
  });
  return { ...plan, services: [...plan.services, service] };
}

// ---------------------------------------------------------------------------------------------
// What the server shows.

/** One container on the server, as `docker inspect` shows it. */
export interface ServerContainer {
  name: string;
  /** Its Compose project and service (empty for a container started without Compose). */
  project: string;
  service: string;
  /** Bytes; 0 without a limit. */
  memory: number;
  memorySwap: number;
  /** Published host ports, `127.0.0.1:18080`. */
  ports: string[];
  networks: string[];
  running: boolean;
  restarts: number;
  oomKilled: boolean;
  startedAt: string;
  /** Its main process on the host; 0 when it does not run. */
  pid: number;
}

/** Lists every container's id and inspects them (`[]` printed as nothing when there is none). */
export const INSPECT_ALL = "docker ps -aq --no-trunc | xargs -r docker inspect";

/** The containers in {@link INSPECT_ALL}'s output. */
export function parseContainers(output: string): ServerContainer[] {
  if (output.trim() === "") return [];
  const inspected = JSON.parse(output) as {
    Name: string;
    Config: { Labels: Record<string, string> | null };
    HostConfig: { Memory: number; MemorySwap: number };
    NetworkSettings: {
      Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
      Networks: Record<string, unknown> | null;
    };
    State: { Running: boolean; OOMKilled: boolean; StartedAt: string; Pid: number };
    RestartCount: number;
  }[];
  return inspected.map((c) => {
    const labels = c.Config.Labels ?? {};
    return {
      name: c.Name.replace(/^\//, ""),
      project: labels["com.docker.compose.project"] ?? "",
      service: labels["com.docker.compose.service"] ?? "",
      memory: c.HostConfig.Memory,
      memorySwap: c.HostConfig.MemorySwap,
      ports: Object.values(c.NetworkSettings.Ports ?? {})
        .flatMap((bindings) => bindings ?? [])
        .map((binding) => `${binding.HostIp}:${binding.HostPort}`),
      networks: Object.keys(c.NetworkSettings.Networks ?? {}),
      running: c.State.Running,
      restarts: c.RestartCount,
      oomKilled: c.State.OOMKilled,
      startedAt: c.State.StartedAt,
      pid: c.State.Pid,
    };
  });
}

/**
 * The containers of the Compose projects `projects` and of their own projects (`<project>-…`,
 * an app's tunnel connector, a Portainer app's updater): OpsCrew's, never the user's own.
 */
export function containersOf(
  containers: readonly ServerContainer[],
  projects: readonly string[],
): ServerContainer[] {
  return containers.filter((c) =>
    projects.some((project) => c.project === project || c.project.startsWith(`${project}-`)),
  );
}

/** Each container without a memory limit, or one it may swap beyond (SC-1304). */
export function limitProblems(containers: readonly ServerContainer[]): string[] {
  return containers.flatMap((c) => {
    if (c.memory <= 0) return [`${c.name} has no memory limit`];
    if (c.memorySwap !== c.memory) return [`${c.name} may swap beyond its memory limit`];
    return [];
  });
}

/** Each container that publishes a port: only the shared edge's Caddy serves the sites. */
export function portProblems(containers: readonly ServerContainer[]): string[] {
  return containers
    .filter((c) => c.ports.length > 0 && !(c.project === EDGE_PROJECT && c.service === "caddy"))
    .map((c) => `${c.name} publishes ${c.ports.join(", ")}`);
}

/** A project's services that must run, and those of them allowed to have restarted. */
export interface WantedServices {
  project: string;
  services: readonly string[];
  /**
   * Services whose restarts are expected: after a reboot Docker starts every container at once,
   * without Compose's order, so the app's own processes may exit until their services answer.
   */
  mayRestart?: readonly string[];
}

/**
 * The services of each project in `wanted` that do not run as one healthy container each at
 * least: none running, or one that met its memory limit or restarted (unless it may).
 */
export function restartProblems(
  containers: readonly ServerContainer[],
  wanted: readonly WantedServices[],
): string[] {
  return wanted.flatMap(({ project, services, mayRestart = [] }) =>
    services.flatMap((service) => {
      const own = containers.filter((c) => c.project === project && c.service === service);
      if (!own.some((c) => c.running)) return [`${project}/${service} has no running container`];
      return own.flatMap((c) => [
        ...(c.restarts > 0 && !mayRestart.includes(service)
          ? [`${c.name} restarted ${c.restarts} time(s)`]
          : []),
        ...(c.oomKilled ? [`${c.name} was stopped at its memory limit`] : []),
      ]);
    }),
  );
}

/** The app's own processes in its Compose project: the web, its enabled workers and cron. */
export function appProcesses(plan: DeployPlan): string[] {
  return [
    "app",
    ...plan.processes.workers.filter((w) => w.enabled).map((w) => w.name),
    ...(plan.processes.cron.some((job) => job.enabled) ? ["cron"] : []),
  ];
}

/** The plan's components that run in the app's Compose project, by their service. */
export function componentServices(plan: DeployPlan): string[] {
  return plannedComponents(plan).map((component) => component.service);
}

/** The edge's services, which every OpsCrew app on a server sits behind. */
export const EDGE_SERVICES = ["kamal-proxy", "caddy"];

interface ComposeFile {
  services?: Record<string, { volumes?: string[] }>;
}

/** A service's data folder on the server: `/srv/data/<app>/<path>`. */
export interface DataMount {
  service: string;
  /** Below `/srv/data/<app>`: `mysql`, `mongodb/db`. */
  path: string;
}

/**
 * The data folders of the app's Compose file (`opscrew/runtime/compose.yaml`): each volume
 * `/srv/data/<app>/<service>[/<name>]:<target>`. Named volumes (Kafka, OpenSearch, SQLite) are
 * Docker's and not listed.
 */
export function dataMounts(compose: string, app: string): DataMount[] {
  const prefix = `/srv/data/${app}/`;
  const services = (parse(compose) as ComposeFile).services ?? {};
  return Object.entries(services).flatMap(([service, spec]) =>
    (spec.volumes ?? [])
      .filter((volume) => volume.startsWith(prefix))
      .map((volume) => ({ service, path: volume.slice(prefix.length).split(":")[0] as string })),
  );
}

/** A settings file the deploy puts next to compose.yaml, mounted read-only into a service. */
export interface SettingsMount {
  service: string;
  /** Relative to the app's folder: `services/mysql/my.cnf`, `crontab`. */
  file: string;
  target: string;
}

/** The read-only settings files of the app's Compose file: `./<file>:<target>:ro`. */
export function settingsMounts(compose: string): SettingsMount[] {
  const services = (parse(compose) as ComposeFile).services ?? {};
  return Object.entries(services).flatMap(([service, spec]) =>
    (spec.volumes ?? []).flatMap((volume) => {
      const match = /^\.\/([\w./-]+):([^:]+):ro$/.exec(volume);
      return match?.[1] === undefined || match[2] === undefined
        ? []
        : [{ service, file: match[1], target: match[2] }];
    }),
  );
}

/**
 * Prints `<path> <uid>:<gid> <entries>` for each of `paths` below `/srv/data/<app>`, as root in a
 * throwaway container of the edge's pinned Caddy image (on every server; a service's folder may be
 * readable by its own user only, and the deploy user has no sudo), with no network and the data
 * read-only.
 */
export function dataFoldersCommand(app: string, paths: readonly string[]): string {
  const script =
    'for p in "$@"; do printf "%s %s %s\\n" "$p" "$(stat -c %u:%g "/d/$p")" "$(ls -A "/d/$p" | wc -l)"; done';
  return [
    "docker run --rm --network none --user 0:0 --entrypoint sh",
    `-v /srv/data/${app}:/d:ro ${IMAGES.caddy.ref} -c '${script}' sh`,
    ...paths,
  ].join(" ");
}

/**
 * The effective user (`<uid>:<gid>`) of the service process in each container whose main host
 * process is in `pids`: `<pid> <uid>:<gid>` lines, read from `/proc/<pid>/status`.
 * - When the main process is an init the image ships (`tini`, as in Valkey's Alpine image;
 *   `docker-init`; `dumb-init`), it runs as root, so its first child is read instead.
 * - Not the owner of `/proc/<pid>`, which is root for a process that changed its user (an
 *   entrypoint that drops from root to the service's user).
 */
export function processOwnersCommand(pids: readonly number[]): string {
  const name = `awk '/^Name:/{print $2}' /proc/$p/status`;
  const owner = `awk '/^Uid:/{u=$3} /^Gid:/{g=$3} END{print u":"g}' /proc/$p/status`;
  return [
    `for pid in ${pids.join(" ")}; do p=$pid`,
    `case "$(${name})" in tini|docker-init|dumb-init) p=$(pgrep -P $p | head -n 1);; esac`,
    `echo "$pid $(${owner})"; done`,
  ].join("; ");
}

/** `<key> <a> <b> …` lines by their first field. */
export function fieldsByKey(output: string): Map<string, string[]> {
  return new Map(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length > 1)
      .map(([key, ...rest]) => [key as string, rest]),
  );
}

/**
 * What is wrong with the data folders (from {@link dataFoldersCommand}):
 * - each belongs to the user its service runs as (`owners`: service → `<uid>:<gid>` of its main
 *   process; the uids are compared);
 * - each service holds something in at least one of its folders. A second folder an image
 *   declares may stay empty, such as MongoDB's `configdb` outside a config server.
 */
export function dataFolderProblems(
  mounts: readonly DataMount[],
  folders: ReadonlyMap<string, string[]>,
  owners: ReadonlyMap<string, string>,
): string[] {
  const perFolder = mounts.flatMap(({ service, path }) => {
    const [owner] = folders.get(path) ?? [];
    if (owner === undefined) return [`/srv/data/…/${path} of ${service} is missing`];
    const uid = owners.get(service)?.split(":")[0];
    return uid !== undefined && owner.split(":")[0] === uid
      ? []
      : [`/srv/data/…/${path} belongs to ${owner}, not to ${service}'s user (${uid ?? "unknown"})`];
  });
  const empty = [...new Set(mounts.map((m) => m.service))].flatMap((service) => {
    const own = mounts.filter((m) => m.service === service);
    const holds = own.some(({ path }) => Number(folders.get(path)?.[1]) > 0);
    return holds || own.every(({ path }) => !folders.has(path))
      ? []
      : [`the data folders of ${service} are empty (${own.map((m) => m.path).join(", ")})`];
  });
  return [...perFolder, ...empty];
}

/**
 * What is wrong with a mounted settings file for the service that reads it (`mode` octal as `stat
 * -c %a` prints it): writable by group or others (MySQL then ignores it), or not readable by the
 * service's user (`process`: `<uid>:<gid>`).
 */
export function settingsFileProblems(
  file: string,
  stat: { mode: string; uid: string; gid: string },
  process: string,
): string[] {
  const mode = Number.parseInt(stat.mode, 8);
  const [uid, gid] = process.split(":");
  const readable =
    (stat.uid === uid && (mode & 0o400) !== 0) ||
    (stat.gid === gid && (mode & 0o040) !== 0) ||
    (mode & 0o004) !== 0;
  return [
    ...((mode & 0o022) === 0
      ? []
      : [`${file} (mode ${stat.mode}) is writable by others than its owner`]),
    ...(readable
      ? []
      : [`${file} (mode ${stat.mode}, ${stat.uid}:${stat.gid}) is not readable by ${process}`]),
  ];
}

/**
 * How a pass sees that a service honours its mounted settings file: a query in the container (run
 * with `sh -c '<query>'`, so it holds no single quote; logins from the container's own
 * environment) whose answer must be the value the file sets.
 */
export const HONOURED_SETTINGS: Readonly<
  Record<
    string,
    { file: string; what: string; query: string; expected: (content: string) => string | undefined }
  >
> = {
  mysql: {
    file: "my.cnf",
    what: "@@innodb_buffer_pool_size",
    query:
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -s -e "SELECT @@innodb_buffer_pool_size"',
    expected: (content) => {
      const mb = /^innodb_buffer_pool_size\s*=\s*(\d+)M\s*$/m.exec(content)?.[1];
      return mb === undefined ? undefined : String(Number(mb) * 1024 * 1024);
    },
  },
  clickhouse: {
    file: "server.xml",
    what: "max_server_memory_usage",
    query:
      'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --param_name=max_server_memory_usage -q "SELECT value FROM system.server_settings WHERE name = {name:String}"',
    expected: (content) =>
      /<max_server_memory_usage>(\d+)<\/max_server_memory_usage>/.exec(content)?.[1],
  },
};

/** OpsCrew's file of kernel settings on a server (cloud servers and servers the user owns alike). */
export const SYSCTL_FILE = "/etc/sysctl.d/90-opscrew.conf";

/**
 * What is wrong with the kernel settings the services need (`wanted`, minimums): OpsCrew's
 * {@link SYSCTL_FILE} must set each at least that high, and the kernel must use at least that.
 */
export function sysctlProblems(
  file: string,
  live: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(wanted).flatMap(([key, value]) => {
    const inFile = new RegExp(`^${key.replaceAll(".", "\\.")}\\s*=\\s*(\\d+)\\s*$`, "m").exec(
      file,
    )?.[1];
    return [
      ...(inFile !== undefined && Number(inFile) >= Number(value)
        ? []
        : [`${SYSCTL_FILE} does not set ${key} to at least ${value}`]),
      ...(Number(live[key]) >= Number(value)
        ? []
        : [`the kernel uses ${key} = ${live[key] ?? "?"}, not at least ${value}`]),
    ];
  });
}

/** The plan's components `opscrew status` does not show as running (FR-1331). */
export function statusProblems(output: string, plan: DeployPlan): string[] {
  return plannedComponents(plan)
    .filter((component) => {
      const line = `  ${upperFirst(component.what)} (${component.service}): running`;
      return !output.split(/\r?\n/).some((text) => text.startsWith(line));
    })
    .map(
      (component) =>
        `opscrew status does not show ${component.what} (${component.service}) running`,
    );
}

/**
 * When the cron container's first job run was due (the first full minute after both its start and
 * `appReadyAt`, when the app answered its health route, in ms of the server's clock; every
 * example's job runs each minute) and when supercronic logged the first run that succeeded
 * (`undefined` before one did), in ms.
 */
export function firstCronRun(
  logs: string,
  startedAt: string,
  appReadyAt: number,
): { due: number; ran?: number } {
  const due = Math.ceil(Math.max(Date.parse(startedAt), appReadyAt) / 60_000) * 60_000;
  const line = logs.split(/\r?\n/).find((text) => text.includes('msg="job succeeded"'));
  const time = /time="([^"]+)"/.exec(line ?? "")?.[1];
  return time === undefined ? { due } : { due, ran: Date.parse(time) };
}

/**
 * A storage root (`opscrew/infra/storage/main.tf`) whose bucket the cleanup can destroy when
 * `opscrew destroy` could not: its `prevent_destroy = true` becomes `false`. Throws when the root
 * no longer has that line, so the cleanup says so.
 */
export function unprotectStorageRoot(mainTf: string): string {
  const line = /^(\s*prevent_destroy\s*=\s*)true\s*$/m;
  if (!line.test(mainTf)) {
    throw new Error("The storage root no longer sets prevent_destroy = true on its bucket.");
  }
  return mainTf.replace(line, "$1false");
}
