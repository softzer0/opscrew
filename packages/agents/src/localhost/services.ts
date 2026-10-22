/**
 * What the localhost target (contracts/localhost.md "Agents") reaches on this computer, each side
 * effect injected: the OS, the CPU, the ports, the shell, Docker (through the phase's runner and
 * the local executor), HTTPS through 127.0.0.1, GHCR and the clock's sleep. Also the folders under
 * the user's OpsCrew home that the stack, the local CA and the deploy lock live in.
 */
import { createServer } from "node:net";
import { arch as osArch, homedir as osHomedir, hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { dockerArchitecture } from "@opscrew/connector-portainer";
import { localExec } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import {
  exists,
  findExecutable,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  realSleep,
} from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { LocalRequest } from "./https";
import type { LocalRegistry } from "./image";

/** This computer's side effects the localhost target uses; each defaults to the real one. */
export interface LocalhostServices {
  /** The OS (default `process.platform`): the shell and the trust commands depend on it. */
  platform?: NodeJS.Platform;
  /** The CPU as Node names it (default `os.arch()`): `x64` and `arm64` are Docker's two. */
  arch?: string;
  /** Whether nothing listens on the TCP port on 127.0.0.1 (default: binds and closes it there). */
  portFree?: (port: number) => Promise<boolean>;
  /** Finds a program on `PATH` (default `findExecutable` with the phase's environment). */
  which?: (name: string) => string | undefined;
  /** HTTP and HTTPS to 127.0.0.1 with the Host header and SNI (default `node:http(s)`). */
  request?: LocalRequest;
  /** This computer's name, in the local CA's name (default `os.hostname()`). */
  computerName?: string;
  /** The user's home folder, for the trust commands (default `os.homedir()`). */
  homedir?: string;
  /** The app's image on GHCR (default: the GitHub connector with the user's token). */
  registry?: LocalRegistry;
  /** Waits between tries (default: a real sleep). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The computer's CPU as Node names it (`os.arch()`), in Docker's terms; `undefined` for one Docker
 * runs no Linux images for.
 */
export function computerArch(arch: string): "amd64" | "arm64" | undefined {
  return dockerArchitecture(arch === "x64" ? "amd64" : arch);
}

/** {@link LocalhostServices} with every default filled in. */
export type Computer = Required<Omit<LocalhostServices, "registry" | "request">> &
  Pick<LocalhostServices, "registry" | "request">;

/** The services with the real defaults for what a test did not replace. */
export function computer(deps: Pick<PhaseDeps, "env">, services: LocalhostServices = {}): Computer {
  return {
    platform: services.platform ?? process.platform,
    arch: services.arch ?? osArch(),
    portFree: services.portFree ?? portFree,
    which: services.which ?? ((name) => findExecutable(name, deps.env)),
    computerName: services.computerName ?? osHostname(),
    homedir: services.homedir ?? osHomedir(),
    sleep: services.sleep ?? realSleep,
    ...(services.request !== undefined ? { request: services.request } : {}),
    ...(services.registry !== undefined ? { registry: services.registry } : {}),
  };
}

/** True when a server can listen on `port` of 127.0.0.1 now (it is closed again at once). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * The POSIX shell the scripts run with (contracts/localhost.md "Local executor"): `sh` on macOS
 * and Linux; on Windows, Git for Windows' `bash.exe`, found next to `git` (`<Git>/cmd/git.exe`
 * or `<Git>/mingw64/bin/git.exe`, and `<Git>/bin/bash.exe`). `undefined` when there is none.
 */
export async function findShell(
  local: Pick<Computer, "platform" | "which">,
): Promise<string | undefined> {
  if (local.platform !== "win32") return local.which("sh");
  const git = local.which("git");
  if (git === undefined) return undefined;
  for (const up of [[".."], ["..", ".."]]) {
    const bash = join(dirname(git), ...up, "bin", "bash.exe");
    if (await exists(bash)) return bash;
  }
  return undefined;
}

/** {@link findShell}, or the plain stop the preflight gives without one. */
export async function requireShell(local: Pick<Computer, "platform" | "which">): Promise<string> {
  const shell = await findShell(local);
  if (shell === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      local.platform === "win32"
        ? "OpsCrew runs the local stack's scripts with Git for Windows' bash, and it was not found next to git."
        : "OpsCrew runs the local stack's scripts with sh, and none was found on PATH.",
      {
        hint:
          local.platform === "win32"
            ? "Install Git for Windows (https://git-scm.com/download/win), then run the command again."
            : "Install a POSIX shell, then run the command again.",
      },
    );
  }
  return shell;
}

/** The local executor: the scripts piped to `shell -s` with this computer's roots. */
export function localShell(
  deps: Pick<PhaseDeps, "runner" | "env" | "paths">,
  shell: string,
): RemoteExec {
  return localExec({ runner: deps.runner, shell, env: deps.env, homeDir: deps.paths.homeDir });
}

/** The folders the local executor gives the scripts: `<OpsCrew home>/local/srv/apps` and `/edge`. */
export function localRoots(paths: Pick<ProjectPaths, "homeDir">): { apps: string; edge: string } {
  const srv = join(paths.homeDir, "local", "srv");
  return { apps: join(srv, "apps"), edge: join(srv, "edge") };
}

/** The app's folder on this computer, as `/srv/apps/<app>` on a server. */
export function appFolder(
  paths: Pick<ProjectPaths, "homeDir">,
  plan: Pick<DeployPlan, "app">,
): string {
  return join(localRoots(paths).apps, plan.app.name);
}

/** A folder or file under `<OpsCrew home>/local/` as the local plan names it: `srv/apps/<app>`. */
export function localRelative(paths: Pick<ProjectPaths, "homeDir">, path: string): string {
  return path.slice(join(paths.homeDir, "local").length + 1).replaceAll("\\", "/");
}

/** The app's Compose project on this computer: `opscrew-<app>`, apart from the user's own. */
export function composeProject(plan: Pick<DeployPlan, "app">): string {
  return `opscrew-${plan.app.name}`;
}

/**
 * `<app folder>/.opscrew-project`: the id of the project that deployed the app there. The app's
 * folder and Compose project are named by the app alone, so every repository on this computer
 * could reach them; only the project that wrote this file changes or removes them.
 */
export function ownerFile(
  paths: Pick<ProjectPaths, "homeDir">,
  plan: Pick<DeployPlan, "app">,
): string {
  return join(appFolder(paths, plan), ".opscrew-project");
}

/**
 * Stops before anything changes when this app's name belongs to another project on this computer
 * (its folder's {@link ownerFile} names another project): OpsCrew deploys or removes only what this
 * project set up. OpsCrew's edge stays shared by every app, as on a server.
 * @throws OpsCrewError `PHASE_PRECONDITION`.
 */
export async function requireOwnLocalApp(
  paths: Pick<ProjectPaths, "homeDir" | "projectId">,
  plan: Pick<DeployPlan, "app">,
  action: "deploy" | "remove",
): Promise<void> {
  const owner = (await readTextIfExists(ownerFile(paths, plan)))?.trim();
  if (owner === undefined || owner === "" || owner === paths.projectId) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This computer runs an OpsCrew app named "${plan.app.name}" from another project, so OpsCrew ${action === "remove" ? "removes nothing from it" : "does not deploy over it"}. Nothing was changed.`,
    {
      hint:
        action === "remove"
          ? "Run `opscrew destroy` in the project of that app, or check that this project's app.name in its plan is the one you mean."
          : "Give this app another name (app.name in its plan, then `opscrew design`), or remove the other project's app with `opscrew destroy` in that project, then run the command again.",
    },
  );
}

/** A single-quoted POSIX shell word. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A path as the shell scripts take it: forward slashes (`D:/…` on Windows). */
export function shellPath(path: string): string {
  return path.replaceAll("\\", "/");
}
