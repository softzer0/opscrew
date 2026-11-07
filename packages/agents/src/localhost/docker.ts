/**
 * Read-only questions to this computer's Docker, through the phase's runner: whether it runs and
 * what it has (`docker info`), Compose's version, the containers, networks and volumes of a
 * Compose project, found by Compose's own labels, and the host ports running containers publish.
 * Nothing here changes anything: changes go through the local executor's scripts.
 */
import { isUserFacingError } from "@opscrew/core";
import { EDGE_PROJECT } from "@opscrew/iac-templates";
import { z } from "zod";
import type { PhaseDeps } from "../context";

/** Compose's label of a container's, network's or volume's project. */
const PROJECT_LABEL = "com.docker.compose.project";

/** What `docker info` says about the Docker this computer runs. */
export interface DockerInfo {
  /** The memory Docker's containers share, in bytes (Docker Desktop's VM, or the host's). */
  memTotal: number;
  /** For example `Docker Desktop`, `Ubuntu 24.04 LTS`. */
  operatingSystem: string;
  /** `linux`, or `windows` for Windows containers (which the stack cannot use). */
  osType: string;
  /** Docker's CPU: `x86_64` or `aarch64`. */
  architecture: string;
}

const InfoSchema = z.looseObject({
  MemTotal: z.number(),
  OperatingSystem: z.string(),
  OSType: z.string(),
  Architecture: z.string(),
});

/**
 * `docker info`, or why there is none: `missing` when the `docker` command is not installed,
 * `stopped` when it does not reach a running Docker.
 */
export async function dockerInfo(
  deps: Pick<PhaseDeps, "runner">,
): Promise<DockerInfo | "missing" | "stopped"> {
  let result: Awaited<ReturnType<PhaseDeps["runner"]["run"]>>;
  try {
    result = await deps.runner.run("docker", ["info", "--format", "{{json .}}"], {
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (isUserFacingError(error)) return "missing";
    throw error;
  }
  if (result.exitCode !== 0) return "stopped";
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return "stopped";
  }
  const info = InfoSchema.safeParse(json);
  if (!info.success) return "stopped";
  return {
    memTotal: info.data.MemTotal,
    operatingSystem: info.data.OperatingSystem,
    osType: info.data.OSType,
    architecture: info.data.Architecture,
  };
}

/** Compose's version (`2.38.2`, without a `v`), or `undefined` when Compose is not installed. */
export async function composeVersion(deps: Pick<PhaseDeps, "runner">): Promise<string | undefined> {
  const result = await deps.runner
    .run("docker", ["compose", "version", "--short"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return undefined;
  return result.stdout.trim().replace(/^v/, "") || undefined;
}

/** One container of a Compose project. */
export interface ProjectContainer {
  name: string;
  /** Its Compose service. */
  service: string;
  running: boolean;
  /** Docker's list of its published ports, for example `127.0.0.1:8443->443/tcp`. */
  ports: string;
}

/** What Docker has of a Compose project. */
export interface ProjectObjects {
  /** Its containers, one-off ones (`docker compose run`) left out. */
  containers: ProjectContainer[];
  networks: string[];
  volumes: string[];
}

/** The lines of a read-only `docker` command's output; none when it fails. */
async function lines(deps: Pick<PhaseDeps, "runner">, args: string[]): Promise<string[]> {
  const result = await deps.runner.run("docker", args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** True when Docker has the network `name` (the edge's, which no Compose project owns). */
export async function networkExists(
  deps: Pick<PhaseDeps, "runner">,
  name: string,
): Promise<boolean> {
  return (await lines(deps, ["network", "ls", "--format", "{{.Name}}"])).includes(name);
}

/** The containers, networks and volumes Docker has of the Compose project `project`. */
export async function projectObjects(
  deps: Pick<PhaseDeps, "runner">,
  project: string,
): Promise<ProjectObjects> {
  const filter = ["--filter", `label=${PROJECT_LABEL}=${project}`];
  const containers = await lines(deps, [
    "ps",
    "-a",
    ...filter,
    "--format",
    '{{.Names}}|{{.State}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.oneoff"}}|{{.Ports}}',
  ]);
  return {
    containers: containers.flatMap((line) => {
      const [name, state, service, oneoff, ports] = line.split("|");
      if (name === undefined || service === undefined || service === "" || oneoff === "True") {
        return [];
      }
      return [{ name, service, running: state === "running", ports: ports ?? "" }];
    }),
    networks: await lines(deps, ["network", "ls", ...filter, "--format", "{{.Name}}"]),
    volumes: await lines(deps, ["volume", "ls", ...filter, "--format", "{{.Name}}"]),
  };
}

/**
 * The host ports running containers publish, each with the name of the container holding it,
 * OpsCrew's own edge left out. Docker Desktop holds them inside its VM, where a listener on
 * 127.0.0.1 does not show them. None when Docker is not installed or does not answer.
 */
export async function publishedPorts(
  deps: Pick<PhaseDeps, "runner">,
): Promise<Map<number, string>> {
  const format = '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Ports}}';
  const running = await lines(deps, ["ps", "--format", format]).catch((error: unknown) => {
    if (isUserFacingError(error)) return [];
    throw error;
  });
  const held = new Map<number, string>();
  for (const line of running) {
    const [name = "", project, ports = ""] = line.split("|");
    if (project === EDGE_PROJECT) continue;
    // For example `0.0.0.0:80->80/tcp, [::]:80->80/tcp, 127.0.0.1:8000-8001->8000-8001/tcp`.
    for (const [, from = "", to] of ports.matchAll(/(?:^|[\s,])(?:\S*:)?(\d+)(?:-(\d+))?->/g)) {
      for (let port = Number(from); port <= Number(to ?? from); port++) held.set(port, name);
    }
  }
  return held;
}
