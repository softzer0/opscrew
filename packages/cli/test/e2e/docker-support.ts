/**
 * Docker for the gated local passes (`docker.test.ts` over `examples/`, `engines.test.ts` over the
 * catalog's search and analytics engines): when they run, the Docker CLI and Compose, OpsCrew's
 * server Compose file adapted to this computer, and what each container of a project shows.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { EDGE_PROJECT, renderCompose, renderRuntimeFiles } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { parse, stringify } from "yaml";

export const DOCKER = findExecutable("docker");
export const TEN_MINUTES = 600_000;
export const TWO_MINUTES = 120_000;

/** On every container these tests start themselves (Compose projects carry their own labels). */
export const LABEL = "opscrew.test=docker-pass";

/** Why the Docker tests skip (OPSCREW_DOCKER_TESTS=1 and a running daemon), or undefined. */
export function dockerSkipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  if (DOCKER === undefined) return "docker is not installed";
  const info = spawnSync(DOCKER, ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 30_000,
    stdio: "ignore",
  });
  return info.status === 0 ? undefined : "the Docker daemon is not running (`docker info` failed)";
}

const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });

export function docker(args: string[], timeoutMs = 60_000) {
  return runner.run(DOCKER ?? "docker", args, { timeoutMs });
}

/** The last `lines` lines of a log (build output, container output). */
export function tail(text: string, lines = 60): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

/** A Compose project a test started: its name, its file and the variables it interpolates. */
export interface ComposeProject {
  name: string;
  file: string;
  envFile?: string;
}

export function compose(project: ComposeProject, args: string[], timeoutMs = TWO_MINUTES) {
  const envFile = project.envFile === undefined ? [] : ["--env-file", project.envFile];
  return docker(
    ["compose", "-p", project.name, ...envFile, "-f", project.file, ...args],
    timeoutMs,
  );
}

/** `docker compose <args>`; fails with the end of its output when it exits non-zero. */
export async function composeOk(
  project: ComposeProject,
  what: string,
  args: string[],
  timeoutMs = TWO_MINUTES,
): Promise<string> {
  const result = await compose(project, args, timeoutMs);
  if (result.exitCode !== 0 || result.timedOut) {
    const failure = result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`;
    throw new Error(`${what} ${failure}:\n${tail(`${result.stdout}\n${result.stderr}`)}`);
  }
  return result.stdout;
}

/** A service of a Compose file, with what these tests read. */
export interface ComposeService {
  volumes?: string[];
  configs?: { source: string; target: string }[];
  ports?: string[];
  networks?: string[];
  mem_limit?: string;
  memswap_limit?: string;
}

/** A folder for a service's data on a server: `/srv/data/<app>/<service>[/<name>]:<target>`. */
const DATA_FOLDER = /^\/srv\/data\/[\w-]+\/([\w-]+)(?:\/([\w-]+))?:(.+)$/;

/** A file next to compose.yaml mounted read-only: `./<path>:<target>:ro`. */
const FILE_MOUNT = /^\.\/([\w./-]+):([^:]+):ro$/;

/** The one-shot `sysctl` container's mount of the host's kernel settings. */
const SYSCTL_MOUNT = "/etc/sysctl.d:/etc/sysctl.d";

/**
 * The settings files the deploy puts next to compose.yaml on a server (`renderRuntimeFiles`
 * without the edge's), by their path there: `services/mysql/my.cnf`, `crontab`.
 */
export function runtimeFiles(plan: DeployPlan): Map<string, string> {
  return new Map(
    renderRuntimeFiles(plan).map((file) => [
      path.posix.relative("opscrew/runtime", file.path),
      file.content,
    ]),
  );
}

/**
 * OpsCrew's server Compose file for `plan` (`renderCompose`) adapted to this computer:
 * - each folder under `/srv/data/<app>/` becomes a named volume of the project, `<service>` or
 *   `<service>-<name>`;
 * - each settings file the deploy puts next to compose.yaml ({@link runtimeFiles}) is an inline
 *   config instead of a mounted file: Docker Desktop shows a mounted Windows file as writable by
 *   everyone, and MySQL ignores such a file;
 * - the one-shot `sysctl` container writes OpsCrew's file to a volume, not into Docker's own
 *   machine (it still raises the kernel setting, which is the host's);
 * - the app leaves the shared edge's network, which only a server has, and publishes its port on
 *   127.0.0.1 (`appPort`) for the checks.
 */
export function localServerCompose(plan: DeployPlan, appPort?: number): string {
  const files = runtimeFiles(plan);
  const doc = parse(renderCompose(plan).content) as {
    services: Record<string, ComposeService>;
    networks?: Record<string, unknown>;
    volumes?: Record<string, unknown>;
    configs?: Record<string, { content: string }>;
  };
  const volumes: Record<string, unknown> = { ...doc.volumes };
  const configs: Record<string, { content: string }> = {};
  for (const [name, service] of Object.entries(doc.services)) {
    const local: string[] = [];
    for (const volume of service.volumes ?? []) {
      const data = DATA_FOLDER.exec(volume);
      const file = FILE_MOUNT.exec(volume);
      if (name === "sysctl" && volume === SYSCTL_MOUNT) {
        volumes.sysctl = {};
        local.push("sysctl:/etc/sysctl.d");
      } else if (data?.[1] !== undefined && data[3] !== undefined) {
        const volumeName = data[2] === undefined ? data[1] : `${data[1]}-${data[2]}`;
        volumes[volumeName] = {};
        local.push(`${volumeName}:${data[3]}`);
      } else if (file?.[1] !== undefined && file[2] !== undefined) {
        const text = files.get(file[1]);
        if (text === undefined) throw new Error(`No rendered file ${file[1]} for ${name}.`);
        const source = file[1].replaceAll("/", "-");
        // `$$` keeps Compose from reading `$NATS_TOKEN` as one of its own variables.
        configs[source] = { content: text.replaceAll("$", () => "$$") };
        service.configs = [...(service.configs ?? []), { source, target: file[2] }];
      } else {
        local.push(volume);
      }
    }
    if (local.length > 0) service.volumes = local;
    else delete service.volumes;
    service.networks = service.networks?.filter((network) => network !== EDGE_PROJECT);
  }
  delete doc.networks?.[EDGE_PROJECT];
  if (Object.keys(volumes).length > 0) doc.volumes = volumes;
  if (Object.keys(configs).length > 0) doc.configs = configs;
  const app = doc.services.app;
  if (app !== undefined && appPort !== undefined) app.ports = [`127.0.0.1::${appPort}`];
  return stringify(doc, { lineWidth: 0 });
}

/** One container of a Compose project, as `docker inspect` shows it. */
export interface ProjectContainer {
  name: string;
  service: string;
  /** Bytes; 0 without a limit. */
  memory: number;
  memorySwap: number;
  /** Published host ports, `127.0.0.1:49153`. */
  ports: string[];
  /** Volumes by name (an anonymous volume's name is its 64-digit id), and bind mounts. */
  mounts: { type: string; name?: string; destination: string }[];
  running: boolean;
  exitCode: number;
  /** The kernel stopped it at its memory limit (the last time it stopped). */
  oomKilled: boolean;
  restarts: number;
  startedAt: string;
}

/** Every container of the Compose project `project`, running or not. */
export async function projectContainers(project: string): Promise<ProjectContainer[]> {
  const listed = await docker([
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  const ids = listed.stdout.split(/\s+/).filter((id) => id !== "");
  if (ids.length === 0) return [];
  const inspected = await docker(["inspect", ...ids]);
  if (inspected.exitCode !== 0)
    throw new Error(`docker inspect failed:\n${tail(inspected.stderr)}`);
  const containers = JSON.parse(inspected.stdout) as {
    Name: string;
    Config: { Labels: Record<string, string> };
    HostConfig: { Memory: number; MemorySwap: number };
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
    Mounts: { Type: string; Name?: string; Destination: string }[];
    State: { Running: boolean; ExitCode: number; OOMKilled: boolean; StartedAt: string };
    RestartCount: number;
  }[];
  return containers.map((c) => ({
    name: c.Name.replace(/^\//, ""),
    service: c.Config.Labels["com.docker.compose.service"] ?? "",
    memory: c.HostConfig.Memory,
    memorySwap: c.HostConfig.MemorySwap,
    ports: Object.values(c.NetworkSettings.Ports ?? {})
      .flatMap((bindings) => bindings ?? [])
      .map((binding) => `${binding.HostIp}:${binding.HostPort}`),
    mounts: c.Mounts.map((m) => ({
      type: m.Type,
      ...(m.Name === undefined ? {} : { name: m.Name }),
      destination: m.Destination,
    })),
    running: c.State.Running,
    exitCode: c.State.ExitCode,
    oomKilled: c.State.OOMKilled,
    restarts: c.RestartCount,
    startedAt: c.State.StartedAt,
  }));
}

/** `512m` as bytes. */
function megabytes(limit: string): number {
  const match = /^(\d+)m$/.exec(limit);
  if (!match?.[1]) throw new Error(`Unexpected memory limit ${limit} in the Compose file.`);
  return Number(match[1]) * 1024 * 1024;
}

/**
 * Each container that lacks its service's memory limit from the Compose file (`mem_limit`, and
 * `memswap_limit` the same, so it cannot swap), as a sentence naming the container.
 */
export function limitProblems(
  containers: readonly ProjectContainer[],
  services: Readonly<Record<string, ComposeService>>,
): string[] {
  return containers.flatMap((container) => {
    const service = services[container.service];
    if (service?.mem_limit === undefined) {
      return [`${container.name}: its service has no mem_limit in the Compose file`];
    }
    const limit = megabytes(service.mem_limit);
    const problems: string[] = [];
    if (service.memswap_limit !== service.mem_limit) {
      problems.push(`${container.name}: memswap_limit ${service.memswap_limit} in the file`);
    }
    if (container.memory !== limit) {
      problems.push(`${container.name}: memory ${container.memory} bytes, not ${limit}`);
    }
    if (container.memorySwap !== limit) {
      problems.push(
        `${container.name}: memory and swap ${container.memorySwap} bytes, not ${limit}`,
      );
    }
    return problems;
  });
}
