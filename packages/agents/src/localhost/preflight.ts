/**
 * The local preflight (contracts/localhost.md "Agents", FR-1502, FR-1509): every check that must
 * pass before the localhost stack changes, each problem with its fix, and the notes given once.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { dockerArchitecture } from "@opscrew/connector-portainer";
import { exists, listText, type OpsCrewError, toPosixRelative } from "@opscrew/core";
import { EDGE_PROJECT, serviceSpec } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { composeVersion, dockerInfo, projectObjects } from "./docker";
import { emulationNote, imageSource, localBuild, planBuildsLocally } from "./image";
import {
  computer,
  type LocalhostServices,
  localRoots,
  requireOwnLocalApp,
  requireShell,
} from "./services";
import { localTarget } from "./site";
import { edgePorts, stackMemoryMb } from "./stack";

/** The oldest Docker Compose OpsCrew's scripts work with. */
const MIN_COMPOSE = [2, 23] as const;

/** Said once whenever Docker Desktop is, or may become, this computer's Docker (FR-1509). */
export const DOCKER_DESKTOP_LICENCE =
  "Docker Desktop is free for personal use, education, open-source projects and companies with fewer than 250 employees and less than US$10 million in yearly revenue; larger companies and governments need a paid subscription. Free alternatives: Docker Engine on Linux, Colima on macOS, Rancher Desktop and Podman. OpsCrew works with any of them and enforces nothing.";

/**
 * Why the localhost target runs no service of `kind` that needs a kernel setting of the Docker host
 * (the search engines' `vm.max_map_count`): OpsCrew never changes this computer's Docker host.
 * Undefined for a kind that needs none.
 */
export function localhostHostSettingProblem(
  kind: Parameters<typeof serviceSpec>[0],
): string | undefined {
  const spec = serviceSpec(kind);
  const settings = Object.entries(spec.hostSettings?.sysctl ?? {});
  if (settings.length === 0) return undefined;
  const lines = listText(settings.map(([key, value]) => `${key} = ${value}`));
  return `${spec.title} needs the Docker host's kernel setting ${lines}, which OpsCrew does not change on this computer, so it does not run ${spec.title} on it: use a hosted ${spec.title}, or deploy the app to a server OpsCrew sets up, where it makes the setting itself.`;
}

/** True when the Compose version `version` is at least {@link MIN_COMPOSE}. */
function composeNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major > MIN_COMPOSE[0] || (major === MIN_COMPOSE[0] && minor >= MIN_COMPOSE[1]);
}

/** The other apps OpsCrew runs on this computer (their folders), besides `app`. */
export async function otherLocalApps(appsDir: string, app: string): Promise<string[]> {
  const entries = await readdir(appsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && entry.name !== app).map((e) => e.name);
}

/**
 * Runs every check of the local preflight, without changing anything:
 * - Docker answers (`docker info`) and runs Linux containers;
 * - Docker Compose is 2.23 or newer;
 * - the sum of the stack's memory limits fits the memory Docker has;
 * - the plan's ports on 127.0.0.1 are free, or OpsCrew's own edge holds them, and they are the
 *   ports the edge already serves this computer's other OpsCrew apps on;
 * - the shell the scripts run with is found;
 * - Docker runs the plan's CPU; a local build has its Dockerfile;
 * - no service needs a kernel setting of the Docker host, and the bucket is Garage's.
 *
 * Each problem says what to do. The notes: Docker Desktop's licence terms (once, when it is the
 * Docker here or none runs yet), and that the image differs from production's on another CPU.
 */
export async function localPreflight(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: LocalhostServices = {},
): Promise<{ problems: string[]; notes: string[] }> {
  const target = localTarget(plan);
  const local = computer(deps, services);
  const file = toPosixRelative(deps.paths.root, deps.paths.files.plan);
  const problems: string[] = [];
  const notes = new Set<string>();

  // The app's name belongs to this project on this computer.
  await requireOwnLocalApp(deps.paths, plan, "deploy").catch((error: OpsCrewError) =>
    problems.push(`${error.message} ${error.hint ?? ""}`.trim()),
  );
  // No service needs a kernel setting of the Docker host (design keeps such engines external).
  for (const service of plan.services.filter((s) => s.enabled)) {
    const problem = localhostHostSettingProblem(service.kind);
    if (problem !== undefined) {
      problems.push(
        `${problem} Turn the service ${service.name} off in ${file} (services → ${service.name} → enabled: false) and give the app the hosted one's address in its environment.`,
      );
    }
  }

  const bucket = plan.storage?.objectStorage;
  if (bucket !== undefined && bucket.provider !== "garage") {
    problems.push(
      `The app's bucket is planned at ${bucket.provider}, which OpsCrew creates only for an app on a server. On this computer, set storage.objectStorage.provider to garage in ${file} (Garage runs next to the app), then run the command again.`,
    );
  }

  const info = await dockerInfo(deps);
  if (info === "missing" || info === "stopped") {
    problems.push(
      info === "missing"
        ? "Docker is not installed on this computer. Install Docker Desktop (Windows, macOS), Docker Engine (Linux) or Colima (macOS), start it, then run the command again."
        : "Docker does not answer on this computer: it is not running. Start Docker Desktop (or the Docker service, or `colima start`), then run the command again.",
    );
    notes.add(DOCKER_DESKTOP_LICENCE);
  } else {
    if (/docker desktop/i.test(info.operatingSystem)) notes.add(DOCKER_DESKTOP_LICENCE);
    if (info.osType !== "linux") {
      problems.push(
        "Docker on this computer runs Windows containers, and the app's stack needs Linux containers. Switch Docker Desktop to Linux containers (its menu: Switch to Linux containers), then run the command again.",
      );
    }
    const version = await composeVersion(deps);
    if (version === undefined || !composeNewEnough(version)) {
      problems.push(
        `${version === undefined ? "Docker Compose is not installed" : `Docker Compose is version ${version}`}, and OpsCrew needs ${MIN_COMPOSE.join(".")} or newer. Update Docker Desktop, or install the Docker Compose plugin, then run the command again.`,
      );
    }
    const limits = stackMemoryMb(plan);
    const memory = Math.floor(info.memTotal / 1024 / 1024);
    if (limits > memory) {
      problems.push(
        `The stack's memory limits add up to ${limits} MB, but Docker on this computer has ${memory} MB. Give Docker more memory (Docker Desktop: Settings → Resources; with WSL 2, memory= in .wslconfig in your user folder; Colima: colima start --memory), or lower the limits in ${file} (app.memoryMb, and the workers' and services' memoryMb), then run the command again.`,
      );
    }
    const arch = dockerArchitecture(info.architecture);
    if (arch !== undefined && arch !== target.arch) {
      problems.push(
        `Docker on this computer runs ${arch} images, and ${file} says ${target.arch} (target.arch). Run \`opscrew design\` again on this computer, then run the command again.`,
      );
    }
    const edge = await projectObjects(deps, EDGE_PROJECT);
    const ours = (port: number) =>
      edge.containers.some((container) => container.ports.includes(`127.0.0.1:${port}->`));
    for (const [kind, port, fallback] of [
      ["HTTPS", target.ports.https, 8443],
      ["HTTP", target.ports.http, 8080],
    ] as const) {
      if (ours(port) || (await local.portFree(port))) continue;
      const field = kind === "HTTPS" ? "https" : "http";
      problems.push(
        port === fallback
          ? `Port ${port} on 127.0.0.1 is in use by another program. Stop it, then run the command again.`
          : `Port ${port} on 127.0.0.1 is in use by another program (on Windows often IIS or another web server). Stop it, or set target.ports.${field} to ${fallback} in ${file}, then run the command again.`,
      );
    }
  }
  const serving = await edgePorts(deps.paths);
  const others = await otherLocalApps(localRoots(deps.paths).apps, plan.app.name);
  if (
    serving !== undefined &&
    others.length > 0 &&
    (serving.https !== target.ports.https || serving.http !== target.ports.http)
  ) {
    problems.push(
      `OpsCrew's edge on this computer serves its other apps (${listText(others)}) on ports ${serving.https} and ${serving.http}, and every app there shares it. Set target.ports to { https: ${serving.https}, http: ${serving.http} } in ${file}, then run the command again.`,
    );
  }

  await requireShell(local).catch((error: OpsCrewError) =>
    problems.push(`${error.message} ${error.hint ?? ""}`.trim()),
  );

  const from = plan.environment?.deploySource;
  if (target.image === "local-build" && from?.from === "promote") {
    problems.push(
      `The ${deps.paths.environment} environment is promoted from ${from.source}, so it runs ${from.source}'s exact image, which a build on this computer would not be. Set target.image to registry in ${file}, then run the command again.`,
    );
  } else if (target.image === "local-build") {
    const { dockerfile } = localBuild(plan);
    if (!planBuildsLocally(plan)) {
      problems.push(
        `This computer cannot build the app's image as GitHub Actions does (its builder adds to it there). Set target.image to registry in ${file}, then run the command again.`,
      );
    } else if (!(await exists(join(deps.paths.root, dockerfile)))) {
      problems.push(
        `${dockerfile} is not in the repository yet, so this computer has nothing to build. Run \`opscrew adapt\`, merge its pull request and pull it, then run the command again.`,
      );
    }
  }
  const source = await imageSource(deps.paths, plan);
  if (source !== undefined && source.arch !== target.arch) {
    notes.add(
      target.image === "local-build"
        ? `This computer runs ${target.arch} and ${source.environment}'s image is built for ${source.arch}, so OpsCrew builds the app's image on this computer: it differs from the image ${source.environment} runs.`
        : emulationNote(target.arch, `${source.environment}'s`, source.arch),
    );
  }
  return { problems, notes: [...notes] };
}
