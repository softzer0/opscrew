/**
 * `status`'s resource figures (feature 017, US2, FR-1704), read when the command runs and never
 * stored: the server's load, memory and disk, and each container's CPU, memory against its limit,
 * restarts and start time. On a server, one fixed read-only command; in the user's Portainer,
 * Docker's API through it; on this computer, local Docker. Figures past a threshold are flagged
 * with what they mean and what to do.
 */
import { PortainerApiError } from "@opscrew/connector-portainer";
import type { RemoteExec } from "@opscrew/contracts";
import { isUserFacingError, listText, OpsCrewError, plural, upperFirst } from "@opscrew/core";
import {
  localComposeProject,
  portainerStackName,
  portainerTarget,
  shellQuote,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, isServerlessProvider } from "@opscrew/plan-schema";
import { DISK_HIGH_PERCENT, DISK_WARN_PERCENT } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { cloudflareWorkerAccount } from "../logs/cloudflare";
import { providerProfile } from "../providers";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import { portainerClientFor } from "../shared";
import { connectOwnServer } from "../shared/own-server";
import { deployShell } from "./certificates";
import {
  containerService,
  hasExtraServers,
  oneShotServices,
  plannedComponents,
} from "./components";
import type { ComponentStatusOptions } from "./run";

/** One container's figures. */
export interface ContainerReading {
  /** Its Compose service: `app`, a worker, `cron`, a service. */
  service: string;
  /** Of one CPU: 100 is one CPU fully busy. */
  cpuPercent: number;
  /** Its memory in use, and its limit when it has one. */
  memory: { usedBytes: number; limitBytes?: number };
  /** Restarts since the container was created, which each deploy does. */
  restarts: number;
  /** When it last started (`State.StartedAt`). */
  startedAt: string;
}

/** A figure past its threshold: what it means and what to do. */
export interface ResourceFlag {
  figure: string;
  severity: "warning" | "high";
  meaning: string;
  fix: string;
}

/** The figures `status` read (data-model.md "Reading figures"). */
export interface ResourceReading {
  takenAt: string;
  /**
   * The server's figures. Load and memory in use are absent where only Docker's totals can be
   * read (Portainer, this computer), and the disk where it cannot be read (Portainer).
   */
  server?: {
    cpus: number;
    load1?: number;
    load5?: number;
    load15?: number;
    memory: { usedBytes?: number; totalBytes: number };
    disk?: { usedBytes: number; freeBytes: number; totalBytes: number };
  };
  containers: ContainerReading[];
  /** A server-rendered app's Worker on Cloudflare: its last 24 hours (CPU time in ms). */
  edgeRequests?: {
    since: string;
    requests: number;
    errors: number;
    cpuTimeP50Ms: number;
    cpuTimeP99Ms: number;
  };
  /** The figures this target cannot give, by name, each with why. */
  unavailable: string[];
  flags: ResourceFlag[];
}

/** The span of a Worker's figures: the last 24 hours. */
const DAY_MS = 86_400_000;

/** A container uses this share of its memory limit or more: a warning. */
const MEMORY_WARN_PERCENT = 90;

/** A Compose project name as Compose allows it (checked before it reaches a command). */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** `docker inspect`'s format: only the name, restarts, start time and memory limit. */
export const INSPECT_FORMAT =
  '{"name":{{json .Name}},"restarts":{{.RestartCount}},"startedAt":{{json .State.StartedAt}},"memoryLimit":{{.HostConfig.Memory}}}';

/** `docker info`'s format on this computer: the CPUs and memory Docker has. */
const INFO_FORMAT = '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}';

/** The mark before each part of the server command's output. */
const MARK = "==opscrew-figures:";

/**
 * The one fixed, read-only command that reads a server's figures for the Compose project
 * `project`, in the C locale (`free`'s headers): `nproc`, `/proc/loadavg`, `free -b`,
 * `df -P -B1 /`, then `docker stats` and `docker inspect` (only {@link INSPECT_FORMAT}'s fields,
 * never the environment) of the project's containers. It ends with `true`: a step that fails (a
 * container recreated mid-read) leaves its part out, not the rest.
 */
export function serverFiguresCommand(project: string): string {
  if (!PROJECT_NAME.test(project)) {
    throw new OpsCrewError("INTERNAL", `Not a Compose project name: ${project}`);
  }
  const filters = `--filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.oneoff=False`;
  return [
    "export LC_ALL=C",
    `echo '${MARK}cpus'`,
    "nproc",
    `echo '${MARK}load'`,
    "cat /proc/loadavg",
    `echo '${MARK}memory'`,
    "free -b",
    `echo '${MARK}disk'`,
    "df -P -B1 /",
    `ids=$(docker ps -aq ${filters})`,
    `if [ -n "$ids" ]; then echo '${MARK}stats'; docker stats --no-stream --format '{{json .}}' $ids; echo '${MARK}inspect'; docker inspect --format '${INSPECT_FORMAT}' $ids; fi`,
    "true",
  ].join("; ");
}

/**
 * `command` as root where the admin login of the user's own server can be (it is root, or has
 * passwordless sudo), else as the login itself, as the host adapter's inspection runs it.
 */
function asAdmin(command: string): string {
  const quoted = shellQuote(command);
  return `if [ "$(id -u)" = 0 ]; then sh -c ${quoted}; elif sudo -n true 2>/dev/null </dev/null; then sudo -n sh -c ${quoted}; else sh -c ${quoted}; fi`;
}

/** The output's lines under each mark. */
function sections(stdout: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(MARK)) {
      current = [];
      found.set(line.slice(MARK.length), current);
    } else if (line !== "") {
      current?.push(line);
    }
  }
  return found;
}

const Count = z.coerce.number().int().nonnegative();

const ServerSchema = z.object({
  cpus: z.coerce.number().int().positive(),
  load: z.tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()]),
  memory: z.object({ total: Count, available: Count }),
  disk: z.object({ total: Count, used: Count, free: Count }),
});

/** `free -b`'s `total` and `available` of its `Mem:` line, by the header's columns. */
function freeColumns(lines: readonly string[]): Record<string, string> {
  const header = lines[0]?.split(/\s+/) ?? [];
  const values =
    lines
      .find((line) => line.startsWith("Mem:"))
      ?.split(/\s+/)
      .slice(1) ?? [];
  return Object.fromEntries(header.map((name, i) => [name, values[i] ?? ""]));
}

/** The server's figures from the command's output; undefined when they cannot be read. */
function parseServer(parts: Map<string, string[]>): ResourceReading["server"] {
  const memory = freeColumns(parts.get("memory") ?? []);
  // df -P: Filesystem, 1-blocks, Used, Available, Capacity, Mounted on (the name may hold spaces).
  const disk = parts.get("disk")?.[1]?.split(/\s+/).slice(-5) ?? [];
  const parsed = ServerSchema.safeParse({
    cpus: parts.get("cpus")?.[0],
    load: parts.get("load")?.[0]?.split(/\s+/).slice(0, 3),
    memory: { total: memory.total, available: memory.available },
    disk: { total: disk[0], used: disk[1], free: disk[2] },
  });
  if (!parsed.success) return undefined;
  const { cpus, load, memory: mem, disk: d } = parsed.data;
  return {
    cpus,
    load1: load[0],
    load5: load[1],
    load15: load[2],
    memory: { usedBytes: Math.max(0, mem.total - mem.available), totalBytes: mem.total },
    disk: { usedBytes: d.used, freeBytes: d.free, totalBytes: d.total },
  };
}

const UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
};

/** `12.5MiB` (Docker's sizes) in bytes; undefined for anything else. */
function sizeBytes(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?i?B|kB)$/.exec(text.trim());
  const unit = match?.[2] === undefined ? undefined : UNITS[match[2]];
  return match?.[1] === undefined || unit === undefined
    ? undefined
    : Math.round(Number(match[1]) * unit);
}

const StatsSchema = z.object({
  Name: z.string(),
  CPUPerc: z
    .string()
    .regex(/^\d+(\.\d+)?%$/)
    .transform((text) => Number.parseFloat(text)),
  MemUsage: z.string().transform((text, ctx) => {
    const used = sizeBytes(text.split("/")[0] ?? "");
    if (used === undefined) {
      ctx.addIssue({ code: "custom", message: "not a size" });
      return z.NEVER;
    }
    return used;
  }),
});

const InspectSchema = z.object({
  name: z.string().transform((name) => name.replace(/^\//, "")),
  restarts: Count,
  startedAt: z.string(),
  memoryLimit: Count,
});

/** Each line parsed with `schema` as JSON; lines that are not are left out. */
function jsonLines<T extends z.ZodType>(lines: readonly string[], schema: T): z.output<T>[] {
  return lines.flatMap((line) => {
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The containers' figures from `docker stats --format '{{json .}}'` and `docker inspect --format`
 * ({@link INSPECT_FORMAT}) lines, joined by name; `serviceOf` names each container's service, or
 * leaves it out. Lines that are neither are ignored, and nothing but these fields is kept.
 */
function parseContainers(
  stats: readonly string[],
  inspect: readonly string[],
  serviceOf: (name: string) => string | undefined,
): ContainerReading[] {
  const details = new Map(jsonLines(inspect, InspectSchema).map((d) => [d.name, d]));
  return jsonLines(stats, StatsSchema).flatMap((figures) => {
    const detail = details.get(figures.Name);
    const service = serviceOf(figures.Name);
    if (detail === undefined || service === undefined) return [];
    return [
      {
        service,
        cpuPercent: figures.CPUPerc,
        memory: {
          usedBytes: figures.MemUsage,
          ...(detail.memoryLimit > 0 ? { limitBytes: detail.memoryLimit } : {}),
        },
        restarts: detail.restarts,
        startedAt: detail.startedAt,
      },
    ];
  });
}

/** The figures part of a reading, before its time and flags. */
type Figures = Pick<ResourceReading, "server" | "containers" | "unavailable" | "edgeRequests">;

/**
 * The shell and command that read the figures: on the user's own server, the admin login
 * `connectOwnServer` checks (host key pinned) with the command as root where it can be; on a
 * server OpsCrew created, the deploy user's shell (`deployShell`).
 */
async function figuresShell(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions,
): Promise<{ remote: RemoteExec; command: string }> {
  const command = serverFiguresCommand(plan.app.name);
  if (plan.target.provider === "own") {
    const { remote } = await connectOwnServer(deps, {
      hostKey: options.hostKey,
      services: options.services?.own,
    });
    return { remote, command: asAdmin(command) };
  }
  const remote = await deployShell(deps, plan, options.services);
  if (remote === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has no SSH login to the server on this computer (its address or the project's deploy key is missing), so it could not read the server's figures.",
      {
        hint: "Run the command on the computer that ran `opscrew provision` (the address is kept there, in .opscrew/server.json, and the deploy key in ~/.opscrew).",
      },
    );
  }
  return { remote, command };
}

/** The figures of the app's server, OpsCrew's or the user's own, with one fixed command. */
async function serverFigures(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions,
): Promise<Figures> {
  const { remote, command } = await figuresShell(deps, plan, options);
  return figuresOver(deps, plan, remote, command);
}

/**
 * The figures `command` reads over `remote`: on the app's server, or on the extra server `extra`
 * (named in the step, the audit entry and the error).
 */
async function figuresOver(
  deps: PhaseDeps,
  plan: DeployPlan,
  remote: RemoteExec,
  command: string,
  extra?: string,
): Promise<Figures> {
  const app = plan.app.name;
  const whose = extra === undefined ? "the server's" : `server ${extra}'s`;
  deps.reporter.step(`Reading ${whose} and the app's figures (read-only)`);
  const result = await remote.run(command, { timeoutMs: 60_000 });
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the server's and the app's figures (read-only)",
    target:
      extra !== undefined
        ? `server ${extra}`
        : plan.target.provider === "own"
          ? "own server"
          : "server",
    decision: "allow",
  });
  // The command ends with `true`: only ssh's own failure (255) or a shell that ran none of it
  // leaves no figures.
  if (result.exitCode === 255 || !result.stdout.includes(MARK)) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read ${whose} figures over SSH (exit code ${result.exitCode}).`,
      {
        hint: "Check that the server is on and that this computer reaches it over SSH, then try again (`opscrew verify` checks the deployment).",
      },
    );
  }
  const parts = sections(result.stdout);
  const server = parseServer(parts);
  const oneShot = oneShotServices(plan);
  const containers = parseContainers(
    parts.get("stats") ?? [],
    parts.get("inspect") ?? [],
    (name) => {
      const service = containerService(app, name);
      return service === undefined || oneShot.has(service) ? undefined : service;
    },
  );
  return {
    ...(server !== undefined ? { server } : {}),
    containers,
    unavailable:
      server === undefined
        ? ["the server's load, memory and disk (OpsCrew could not read them from its answer)"]
        : [],
  };
}

/** The figures of the app's stack in the user's Portainer, through Docker's API there. */
async function portainerFigures(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions,
): Promise<Figures> {
  const client = portainerClientFor(deps, {
    connection: await requirePortainerConnection(deps, plan),
    token: requirePortainerToken(deps),
    client: options.services?.portainer?.client,
  });
  deps.reporter.step("Reading the app's figures in your Portainer (read-only)");
  const environment = portainerTarget(plan.target).environmentId;
  const stack = portainerStackName(plan);
  const planned = plannedComponents(plan).map((component) => component.service);
  const listed = (await client.listContainers(environment)).flatMap(({ id, project, service }) =>
    project === stack && service !== undefined && planned.includes(service)
      ? [{ id, service }]
      : [],
  );
  // Without Docker's /info, the containers' figures still stand; the totals are named below.
  const info: { cpus?: number; memoryBytes?: number } = await client
    .dockerInfo(environment)
    .catch((error: unknown) => {
      if (!isUserFacingError(error)) throw error;
      return {};
    });
  const hidden = new Set(planned.filter((s) => !listed.some((c) => c.service === s)));
  const read = await Promise.all(
    listed.map(async ({ id, service }): Promise<ContainerReading | string> => {
      try {
        const [figures, inspection] = await Promise.all([
          client.containerStats(environment, id),
          client.containerInspect(environment, id),
        ]);
        return {
          service,
          cpuPercent: figures.cpuPercent,
          memory: {
            usedBytes: figures.memoryUsedBytes,
            ...(inspection.memoryLimitBytes !== undefined
              ? { limitBytes: inspection.memoryLimitBytes }
              : {}),
          },
          restarts: inspection.restartCount,
          startedAt: inspection.startedAt,
        };
      } catch (error) {
        // A standard user's token reads only that user's own stacks' containers (spike result 7).
        if (error instanceof PortainerApiError && error.status === 403) return service;
        throw error;
      }
    }),
  );
  const containers = read.filter((entry): entry is ContainerReading => typeof entry !== "string");
  for (const entry of read) if (typeof entry === "string") hidden.add(entry);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "read the app's containers' figures (read-only)",
    target: "portainer",
    decision: "allow",
  });
  const { cpus, memoryBytes } = info;
  const totals = cpus !== undefined && memoryBytes !== undefined;
  const unavailable = [
    totals
      ? "the host's load, memory in use and disk (Docker's API through Portainer does not give them)"
      : "the host's CPUs, memory, load and disk (Portainer did not give Docker's figures for them)",
  ];
  if (hidden.size > 0) {
    unavailable.push(
      `the figures of ${listText([...hidden])}: no container of theirs is visible to the token's user (a standard user's token sees only that user's own stacks; use an administrator's token, or the token of the user who deployed the stack, as PORTAINER_API_KEY)`,
    );
  }
  return {
    ...(totals ? { server: { cpus, memory: { totalBytes: memoryBytes } } } : {}),
    containers,
    unavailable,
  };
}

/** The figures of the app's Compose project in this computer's Docker. */
async function localFigures(deps: PhaseDeps, plan: DeployPlan): Promise<Figures> {
  const docker = async (args: string[]) => {
    const result = await deps.runner.run("docker", args, { timeoutMs: 60_000 });
    return result.exitCode === 0 ? result.stdout.split(/\r?\n/).map((l) => l.trim()) : [];
  };
  const oneShot = oneShotServices(plan);
  const listed = await docker([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${localComposeProject(plan)}`,
    "--filter",
    "label=com.docker.compose.oneoff=False",
    "--format",
    '{{.Names}}|{{.Label "com.docker.compose.service"}}',
  ]);
  const services = new Map(
    listed.flatMap((line) => {
      const [name, service] = line.split("|");
      return name && service && !oneShot.has(service) ? [[name, service] as const] : [];
    }),
  );
  const names = [...services.keys()];
  const read =
    names.length === 0
      ? []
      : parseContainers(
          await docker(["stats", "--no-stream", "--format", "{{json .}}", ...names]),
          await docker(["inspect", "--format", INSPECT_FORMAT, ...names]),
          (name) => services.get(name),
        );
  const [info] = jsonLines(
    await docker(["info", "--format", INFO_FORMAT]),
    z.object({ cpus: z.int().positive(), memoryBytes: z.int().positive() }),
  );
  return {
    ...(info !== undefined
      ? { server: { cpus: info.cpus, memory: { totalBytes: info.memoryBytes } } }
      : {}),
    containers: read,
    unavailable: [
      "this computer's load, memory in use and disk (OpsCrew reads only Docker's figures here)",
    ],
  };
}

/**
 * What a site on Cloudflare's hosting or GitHub Pages gives: a server-rendered app's Worker, its
 * requests, exceptions and CPU time of the last 24 hours (`workersAnalytics`); a site that runs
 * no code, nothing.
 */
async function siteFigures(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ComponentStatusOptions["services"],
): Promise<Figures> {
  const { target } = plan;
  if (target.provider !== "cloudflare-workers") {
    return {
      containers: [],
      unavailable: [
        "resource figures (GitHub Pages serves the site's files without running any code, so there are none)",
      ],
    };
  }
  if (target.render !== "ssr") {
    return {
      containers: [],
      unavailable: [
        "request figures (Cloudflare serves the site's files without running any code, so it counts no requests)",
      ],
    };
  }
  const { client, accountId } = await cloudflareWorkerAccount(deps, plan, services);
  const since = new Date(deps.clock.now().getTime() - DAY_MS);
  deps.reporter.step(`Reading the Worker's figures of the last 24 hours at Cloudflare (read-only)`);
  const figures = await client.workersAnalytics(accountId, target.worker, since);
  return {
    containers: [],
    edgeRequests: { since: since.toISOString(), ...figures },
    unavailable: [],
  };
}

/** A component's words: `the web process (app)`, or the service's name for another one. */
function componentWords(plan: DeployPlan): (service: string) => string {
  const what = new Map(plannedComponents(plan).map((c) => [c.service, c.what]));
  return (service) => {
    const words = what.get(service);
    return words === undefined ? service : `${words} (${service})`;
  };
}

/** Bytes as `512 MB` or `3.8 GB` (MB and GB of 1024, as memory limits are given). */
function bytesText(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/** The disk's fill in percent, as `df` rounds it (up). */
function diskPercent(disk: NonNullable<NonNullable<ResourceReading["server"]>["disk"]>): number {
  const size = disk.usedBytes + disk.freeBytes;
  return size === 0 ? 0 : Math.ceil((disk.usedBytes * 100) / size);
}

/**
 * The thresholds of US2: memory at 90% of a limit, the disk at 85% and 95%, any restart. With
 * extra servers, the disk's flag names its server (`server`, default the app's).
 */
export function resourceFlags(
  plan: DeployPlan,
  figures: Figures,
  flag = "",
  server = APP_SERVER,
): ResourceFlag[] {
  const words = componentWords(plan);
  const flags: ResourceFlag[] = [];
  const disk = figures.server?.disk;
  const named = hasExtraServers(plan) ? server : undefined;
  if (disk !== undefined) {
    const percent = diskPercent(disk);
    if (percent >= DISK_WARN_PERCENT) {
      flags.push({
        figure: named === undefined ? "the server's disk" : `server ${named}'s disk`,
        severity: percent >= DISK_HIGH_PERCENT ? "high" : "warning",
        meaning: `${named === undefined ? "The server's" : `Server ${named}'s`} disk is ${percent}% full (${bytesText(disk.freeBytes)} free). When it is full, the database and the app can no longer write, and deploys fail.`,
        fix: "Free space: old images (`docker image prune` as the deploy user) and logs usually fill it. Or give the server a bigger disk.",
      });
    }
  }
  for (const container of figures.containers) {
    const name = words(container.service);
    const { usedBytes, limitBytes } = container.memory;
    if (limitBytes !== undefined && usedBytes * 100 >= limitBytes * MEMORY_WARN_PERCENT) {
      flags.push({
        figure: `the memory of ${name}`,
        severity: "warning",
        meaning: `${upperFirst(name)} uses ${Math.round((usedBytes * 100) / limitBytes)}% of its ${bytesText(limitBytes)} memory limit. At the limit, the system stops it and Docker starts it again.`,
        fix: `Raise ${container.service === "cron" ? "`app.memoryMb` (the cron jobs run with the web process's memory)" : "its `memoryMb`"} in opscrew/plan.yaml and run \`opscrew provision${flag}\` (it shows the plan first), or find what in the app holds on to memory.`,
      });
    }
    if (container.restarts > 0) {
      flags.push({
        figure: `the restarts of ${name}`,
        severity: "warning",
        meaning: `${upperFirst(name)} restarted ${plural(container.restarts, "time")} since the last deploy: it stopped (it crashed or ran out of memory) and Docker started it again.`,
        fix: `See why in its logs: \`opscrew logs${flag} --service ${container.service}\`.`,
      });
    }
  }
  return flags;
}

/**
 * The resource figures of the app's environment (FR-1704), read now and read-only, with the
 * figures past a threshold flagged:
 * - on a server OpsCrew created or the user's own, one fixed command as the deploy user (audited
 *   without the address);
 * - in the user's Portainer, Docker's API through it: the host's disk is named as not available,
 *   and containers the token's user cannot see as not visible to that user;
 * - on this computer, local Docker, with `docker info`'s totals;
 * - on Cloudflare's hosting, a server-rendered app's requests, exceptions and CPU time of the
 *   last 24 hours, against Workers Free's limits;
 * - for a site that runs no code (a static site on Cloudflare, GitHub Pages), none (named in
 *   `unavailable`).
 */
export async function readResources(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ComponentStatusOptions = {},
): Promise<ResourceReading> {
  const { provider } = plan.target;
  const figures = isServerlessProvider(provider)
    ? await siteFigures(deps, plan, options.services)
    : provider === "portainer"
      ? await portainerFigures(deps, plan, options)
      : provider === "localhost"
        ? await localFigures(deps, plan)
        : await serverFigures(deps, plan, options);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  return {
    takenAt: deps.clock.now().toISOString(),
    ...figures,
    flags: resourceFlags(plan, figures, flag),
  };
}

/**
 * The figures of the extra server `server` (FR-1811) over its shell `remote`, with the same
 * command and thresholds as the app's server: as root where the admin login of a server the user
 * owns (`own`) can be, else as `deploy`.
 */
export async function readServerResources(
  deps: PhaseDeps,
  plan: DeployPlan,
  server: string,
  remote: RemoteExec,
  own: boolean,
): Promise<ResourceReading> {
  const command = serverFiguresCommand(plan.app.name);
  const figures = await figuresOver(deps, plan, remote, own ? asAdmin(command) : command, server);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  return {
    takenAt: deps.clock.now().toISOString(),
    ...figures,
    flags: resourceFlags(plan, figures, flag, server),
  };
}

/** `2 days`, `3 hours`, `5 minutes` or `less than a minute` since `startedAt`. */
function sinceText(startedAt: string, now: Date): string {
  const ms = now.getTime() - Date.parse(startedAt);
  if (Number.isNaN(ms)) return "at an unknown time";
  if (ms >= 2 * 86_400_000) return `${plural(Math.floor(ms / 86_400_000), "day")} ago`;
  if (ms >= 2 * 3_600_000) return `${plural(Math.floor(ms / 3_600_000), "hour")} ago`;
  if (ms >= 60_000) return `${plural(Math.floor(ms / 60_000), "minute")} ago`;
  return "less than a minute ago";
}

/**
 * The server's line: load against the CPUs, memory used of total, disk used and free; with extra
 * servers it names the server (`named`).
 */
function serverLine(server: NonNullable<ResourceReading["server"]>, named?: string): string {
  const { cpus, load1, load5, load15, memory, disk } = server;
  const parts = [
    load1 === undefined || load5 === undefined || load15 === undefined
      ? plural(cpus, "CPU")
      : `load ${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)} (1, 5 and 15 minutes) on ${plural(cpus, "CPU")}`,
    memory.usedBytes === undefined
      ? `memory ${bytesText(memory.totalBytes)}`
      : `memory ${bytesText(memory.usedBytes)} used of ${bytesText(memory.totalBytes)}`,
  ];
  if (disk !== undefined) {
    parts.push(
      `disk ${bytesText(disk.usedBytes)} used, ${bytesText(disk.freeBytes)} free of ${bytesText(disk.totalBytes)} (${diskPercent(disk)}% full)`,
    );
  }
  return `  Server${named === undefined ? "" : ` ${named}`}: ${parts.join("; ")}`;
}

/**
 * The Worker's lines: its last 24 hours against Workers Free's requests a day and CPU time per
 * request, then what the figures leave out.
 */
function workerLines(figures: NonNullable<ResourceReading["edgeRequests"]>): string[] {
  const { freeRequestsPerDay, freeCpuMs } = providerProfile("cloudflare-workers").plans;
  const count = (n: number) => n.toLocaleString("en-US");
  const share = Math.round((figures.requests * 100) / freeRequestsPerDay);
  const requests = `${count(figures.requests)} request${figures.requests === 1 ? "" : "s"}`;
  return [
    `  The Worker (last 24 hours): ${requests} (${share}% of Workers Free's ${count(freeRequestsPerDay)} a day), ${plural(figures.errors, "error")}; CPU time per request ${figures.cpuTimeP50Ms.toFixed(1)} ms median and ${figures.cpuTimeP99Ms.toFixed(1)} ms at the 99th percentile (Workers Free allows ${freeCpuMs} ms)`,
    "  Requests served from the site's files run no code, so they are not counted. Errors are only the exceptions the Worker threw, not its 4xx or 5xx answers. The figures lag about a minute.",
  ];
}

/**
 * The status lines of a reading of `server` (default the app's): the server, each container, what
 * is not available, the flags. With extra servers, the heading and the server's line name it.
 */
export function resourceLines(
  plan: DeployPlan,
  reading: ResourceReading,
  now: Date,
  server = APP_SERVER,
): string[] {
  const words = componentWords(plan);
  const named = hasExtraServers(plan) ? server : undefined;
  const lines = [`Resources${named === undefined ? "" : ` on server ${named}`} (read now):`];
  if (reading.server !== undefined) lines.push(serverLine(reading.server, named));
  if (reading.edgeRequests !== undefined) lines.push(...workerLines(reading.edgeRequests));
  for (const container of reading.containers) {
    const { usedBytes, limitBytes } = container.memory;
    const memory =
      limitBytes === undefined
        ? `memory ${bytesText(usedBytes)} (no limit)`
        : `memory ${bytesText(usedBytes)} of ${bytesText(limitBytes)} (${Math.round((usedBytes * 100) / limitBytes)}%)`;
    lines.push(
      `  ${upperFirst(words(container.service))}: CPU ${container.cpuPercent.toFixed(1)}%, ${memory}, ${plural(container.restarts, "restart")}, started ${sinceText(container.startedAt, now)}`,
    );
  }
  for (const entry of reading.unavailable) lines.push(`  Not available: ${entry}`);
  for (const flag of reading.flags) {
    lines.push(`  ${flag.severity === "high" ? "High" : "Warning"}: ${flag.meaning} ${flag.fix}`);
  }
  return lines;
}
