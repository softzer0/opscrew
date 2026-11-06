import { dialStdioTransport, dockerClient, volumeCarrier } from "@opscrew/connector-docker";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import { appDirs } from "@opscrew/connector-ssh-host";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import {
  durationText,
  errorMessage,
  listText,
  NodeStreamRunner,
  OpsCrewError,
  replaceNames,
} from "@opscrew/core";
import {
  APPS_DIR,
  EDGE_PROXIES,
  type EdgeProxy,
  edgeProxy,
  IMAGES,
  MONITORING_PROJECT,
} from "@opscrew/iac-templates";
import { APP_SERVER, monitoringServerName, servicesOn } from "@opscrew/plan-schema";
import { sshArgs } from "../../shared";
import type { MoveServer } from "../removal";
import {
  hasReleaseService,
  isAppHealthy,
  reloadEdge,
  runRelease,
  type ServerOpOptions,
  serverOps,
  startService,
  stopService,
  waitAppHealthy,
} from "../server-ops";
import { auditMove, type MoveBase, remoteFor, waitsOf } from "../session";
import { sideTarget } from ".";
import {
  type MoveSide,
  type SideDocker,
  type SideSource,
  type SideVolume,
  STOP_SECONDS,
} from "./types";

/** The Compose labels a side reads on containers. */
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

const MINUTE = 60_000;

/** Where `deploy` logs in to a side's server over SSH. */
export interface DeployLogin {
  host: string;
  port: number;
}

/** What a side over SSH (cloud or own) tells {@link sshSide} about itself. */
export interface SshSideInput {
  /** The side being left, or the new one. */
  which: MoveServer;
  /** The side's server in words (`the new server`), for messages and audit: never its address. */
  words(session: MoveBase): string;
  /** Where `deploy` logs in to the side's server. */
  login(session: MoveBase): Promise<DeployLogin>;
  /**
   * Other apps may share the server's edge (a server the user owns): while they are there, the
   * edge stays running, so they keep serving.
   */
  sharedEdge?: boolean;
  /**
   * Whether the monitoring stack on the side's server is the app's: on a server the user owns it
   * may be another app's. Absent, it is (a server OpsCrew created for the app).
   */
  ownsMonitoring?(session: MoveBase): Promise<boolean>;
}

/** What every side over SSH shares: everything but preparing and removing it. */
export type SshSideParts = Omit<MoveSide, "kind" | "prepare" | "remove">;

/** The typed server operations' options for the session's app. */
function opsOf(session: MoveBase): ServerOpOptions {
  return { ...serverOps(session.plan, session.deps.redactor), command: session.command };
}

/**
 * The parts of a move's side that reach its server over SSH as `deploy` with the project's deploy
 * key and pinned host key: the Docker API through `docker system dial-stdio`, the app's, its
 * services' and the edge's stops and starts through the typed server operations, the health
 * check and the app's data mounts. Messages and audit entries name the side in words, never its
 * address.
 */
export function sshSide(input: SshSideInput): SshSideParts {
  /** The deploy user's shell on the side's server: the injected one, else SSH. */
  async function remoteOf(session: MoveBase): Promise<RemoteExec> {
    const { host, port } = await input.login(session);
    return remoteFor(session.deps, session.services, session.deployKey.privateKeyFile, host, port);
  }

  /** What to do after a failed command on the server, in words. */
  function serverHint(session: MoveBase): string {
    const { folder } = opsOf(session);
    return `As deploy on ${input.words(session)}, \`docker compose ps\` in ${folder} shows what runs and \`docker compose logs --tail 200\` why; then run \`${session.command}\` again.`;
  }

  /**
   * Runs `act`; an error it throws names the side in words instead of its address. A command's
   * hint (which names the address) becomes {@link serverHint}; the Docker API's (`keepHint`), which
   * names none, stays.
   */
  async function inWords<T>(
    session: MoveBase,
    act: () => Promise<T>,
    keepHint = false,
  ): Promise<T> {
    try {
      return await act();
    } catch (error) {
      if (!(error instanceof OpsCrewError)) throw error;
      const { host } = await input.login(session);
      const hint = keepHint ? error.hint : serverHint(session);
      throw new OpsCrewError(
        error.code,
        replaceNames(error.message, [host], input.words(session)),
        hint === undefined ? {} : { hint },
      );
    }
  }

  /** True when the side's server runs the app's own monitoring stack (`where: app`). */
  async function hasMonitoring(session: MoveBase): Promise<boolean> {
    return (
      monitoringServerName(session.plan) === APP_SERVER &&
      (input.ownsMonitoring === undefined || (await input.ownsMonitoring(session)))
    );
  }

  /** `docker compose stop` or `up -d` of the app's stateful services `names`. */
  async function compose(
    session: MoveBase,
    verb: "stop" | "up -d",
    names: readonly string[],
  ): Promise<void> {
    if (names.length === 0) return;
    const known = new Set(servicesOn(session.plan, APP_SERVER).map((service) => service.name));
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new OpsCrewError(
        "INTERNAL",
        `${listText(unknown)} ${unknown.length === 1 ? "is not a service" : "are not services"} of the app's server in opscrew/plan.yaml.`,
        { hint: "This is a bug in OpsCrew; please report it." },
      );
    }
    const { folder } = opsOf(session);
    // A stateful service gets 120 s to stop cleanly (T2306), so its files are whole.
    const args = verb === "stop" ? `stop -t ${STOP_SECONDS}` : verb;
    await run(
      session,
      `cd ${folder} && docker compose ${args} ${names.join(" ")}`,
      `${verb === "stop" ? "stop" : "start"} ${listText([...names])}`,
    );
  }

  /**
   * Stops (with time to stop cleanly) or starts the monitoring stack's project when the side's
   * server runs the app's own (`docker compose -p`, its containers as its setup made them).
   */
  async function monitoringStack(session: MoveBase, verb: "stop" | "start"): Promise<void> {
    if (!(await hasMonitoring(session))) return;
    const args = verb === "stop" ? `stop -t ${STOP_SECONDS}` : "start";
    await run(
      session,
      `docker compose -p ${MONITORING_PROJECT} ${args}`,
      `${verb} the monitoring stack`,
    );
  }

  /** Runs `command` as deploy on the side's server; a failure says it could not do `action`. */
  async function run(session: MoveBase, command: string, action: string): Promise<void> {
    const remote = await remoteOf(session);
    const { redact } = opsOf(session);
    const timeoutMs = 5 * MINUTE;
    const what = `${action} on ${input.words(session)}`;
    // What ssh or Compose said may name the server's address: inWords puts the words in its place.
    await inWords(session, async () => {
      const failed = (detail: string) => {
        const said = redact(detail.trim()).slice(0, 500).replace(/\.$/, "");
        return new OpsCrewError("COMMAND_FAILED", `Could not ${what}${said ? `: ${said}` : ""}.`);
      };
      let result: CommandResult;
      try {
        result = await remote.run(command, { timeoutMs });
      } catch (error) {
        throw failed(errorMessage(error));
      }
      if (result.timedOut) throw failed(`it did not finish within ${durationText(timeoutMs)}`);
      if (result.exitCode !== 0) throw failed(result.stderr || `exit code ${result.exitCode}`);
    });
  }

  async function docker(session: MoveBase): Promise<SideDocker> {
    const { host, port } = await input.login(session);
    const streams = session.deps.streams ?? new NodeStreamRunner();
    const args = [
      ...sshArgs({
        host,
        port,
        keyFile: session.deployKey.privateKeyFile,
        knownHostsFile: session.deps.paths.files.knownHosts,
        fresh: true,
        // A volume's stream can stay quiet for a while (a carrier emptying it, a slow side).
        keepAliveSeconds: 15,
      }),
      "docker system dial-stdio",
    ];
    const transport = dialStdioTransport(() => streams.open("ssh", args));
    const client = dockerClient(transport);
    // ssh's own messages (a lost connection, a timeout) reach the errors and name the server:
    // they name it in words instead.
    const words = input.words(session);
    return {
      client: inWordsApi(client, host, words),
      // Only the app's own data folder may be bound into a carrier.
      carrier: inWordsApi(
        volumeCarrier(client, IMAGES.busybox.ref, [dataRoot(session)]),
        host,
        words,
      ),
      close: async () => {
        await transport.close?.();
      },
    };
  }

  /** Runs `use` with the side's Docker API, closed afterwards. */
  async function withDocker<T>(
    session: MoveBase,
    use: (side: SideDocker) => Promise<T>,
  ): Promise<T> {
    const side = await docker(session);
    try {
      return await inWords(session, () => use(side), true);
    } finally {
      await side.close();
    }
  }

  /**
   * True when the edge must stay as it is: other apps' Compose projects (`/srv/apps/<other>`) are
   * on a server whose edge they share.
   */
  async function edgeShared(session: MoveBase): Promise<boolean> {
    if (input.sharedEdge !== true) return false;
    const app = session.plan.app.name;
    const containers = await withDocker(session, (side) =>
      side.client.listContainers([COMPOSE_PROJECT_LABEL]),
    );
    return containers.some(
      (container) =>
        container.labels[COMPOSE_PROJECT_LABEL] !== app &&
        (container.labels[WORKING_DIR_LABEL] ?? "").startsWith(`${APPS_DIR}/`),
    );
  }

  /** Says that the shared edge stays running for the other apps on the side's server. */
  function edgeStays(session: MoveBase, edge: EdgeProxy): void {
    session.deps.reporter.info(
      `${EDGE_PROXIES[edge].label} on ${input.words(session)} keeps running: other apps there use it too.`,
    );
  }

  async function stopEdge(session: MoveBase): Promise<void> {
    const edge = edgeProxy({ ...session.plan, target: sideTarget(session, input.which) });
    if (await edgeShared(session)) return edgeStays(session, edge);
    const remote = await remoteOf(session);
    await inWords(session, () => stopService(remote, edge, opsOf(session)));
  }

  /**
   * Starts the edge; one other apps share kept running, so it is reloaded instead: the app's
   * hostnames get their certificates right after DNS switched to this server.
   */
  async function startEdge(session: MoveBase): Promise<void> {
    const edge = edgeProxy({ ...session.plan, target: sideTarget(session, input.which) });
    const remote = await remoteOf(session);
    if (await edgeShared(session)) {
      await inWords(session, () => reloadEdge(remote, edge, opsOf(session)));
      return;
    }
    await inWords(session, () => startService(remote, edge, opsOf(session)));
  }

  return {
    docker,

    async deploy(session) {
      const { deps, plan } = session;
      const words = input.words(session);
      const edge = edgeProxy({ ...session.plan, target: sideTarget(session, input.which) });
      deps.reporter.step(`Checking the app on ${words} over SSH`);
      const remote = await remoteOf(session);
      await inWords(session, () =>
        waitAppHealthy(remote, plan.app.port, plan.app.healthPath, {
          ...opsOf(session),
          edge,
          ...waitsOf(session.services),
        }),
      );
      if (await edgeShared(session)) {
        edgeStays(session, edge);
        return undefined;
      }
      deps.reporter.step(
        `Stopping ${EDGE_PROXIES[edge].label} on ${words} until traffic is switched to it`,
      );
      await inWords(session, () => stopService(remote, edge, opsOf(session)));
      await auditMove(session, {
        kind: "remote-exec",
        action: `stop ${edge}`,
        decision: "approved",
        detail: `on ${words}, until traffic is switched to it`,
      });
      return undefined;
    },

    async stopApp(session) {
      const remote = await remoteOf(session);
      await inWords(session, () => stopService(remote, "app", opsOf(session)));
    },

    async startApp(session) {
      const remote = await remoteOf(session);
      await inWords(session, () => startService(remote, "app", opsOf(session)));
    },

    // The app's own monitoring stack on the server stops and starts with its services, so its
    // volumes are copied whole.
    async stopServices(session, names) {
      await compose(session, "stop", names);
      await monitoringStack(session, "stop");
    },
    async startServices(session, names) {
      await monitoringStack(session, "start");
      await compose(session, "up -d", names);
    },
    stopEdge,
    startEdge,

    async healthy(session) {
      const { plan } = session;
      const remote = await remoteOf(session);
      return isAppHealthy(
        remote,
        plan.app.port,
        plan.app.healthPath,
        edgeProxy({ ...session.plan, target: sideTarget(session, input.which) }),
        plan.app.name,
      );
    },

    async release(session, bytes) {
      const remote = await remoteOf(session);
      const ops = opsOf(session);
      await inWords(session, async () => {
        // The version deployed there decides: its compose file has a `release` service or not.
        if (await hasReleaseService(remote, ops)) await runRelease(remote, bytes, ops);
      });
    },

    async volumes(session) {
      // The monitoring stack's data, when it runs on the app's server and is the app's.
      const monitoring = await hasMonitoring(session);
      return withDocker(session, (side) => dataMounts(session, side, monitoring));
    },
  };
}

/**
 * `api` (a Docker client or a carrier: an object of functions) whose errors name the server in
 * `words` instead of `host`. The error itself is kept (its message, and an `OpsCrewError`'s hint,
 * changed in place), so a caller that tests its class (Docker's 404 for a missing image) still can.
 */
function inWordsApi<T extends object>(api: T, host: string, words: string): T {
  const rename = (error: unknown): unknown => {
    if (!(error instanceof Error)) return error;
    error.message = replaceNames(error.message, [host], words);
    if (error instanceof OpsCrewError && error.hint !== undefined) {
      (error as { hint?: string }).hint = replaceNames(error.hint, [host], words);
    }
    return error;
  };
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(api)) {
    wrapped[name] =
      typeof value === "function"
        ? async (...args: unknown[]) => {
            try {
              return await value(...args);
            } catch (error) {
              throw rename(error);
            }
          }
        : value;
  }
  return wrapped as T;
}

/**
 * The app's data mounts on a side's server, from its containers' mounts: named volumes, and folders
 * bound from the app's data folder (`/srv/data/<app>/…`). Other binds (settings files, sockets)
 * are no data. The owner is the plan's service on the app's server whose container mounts it,
 * `monitoring` for the monitoring stack's project (with `monitoring`: the stack is the app's), else
 * `app`. Each mount is listed once, with its size.
 */
async function dataMounts(
  session: MoveBase,
  side: SideDocker,
  monitoring: boolean,
): Promise<SideVolume[]> {
  const { plan } = session;
  const app = plan.app.name;
  const root = dataRoot(session);
  const services = new Set(servicesOn(plan, APP_SERVER).map((service) => service.name));
  const projects = [app, ...(monitoring ? [MONITORING_PROJECT] : [])];
  const found = new Map<string, Omit<SideVolume, "bytes">>();
  for (const project of projects) {
    for (const container of await side.client.listContainers([
      `${COMPOSE_PROJECT_LABEL}=${project}`,
    ])) {
      const service = container.labels[COMPOSE_SERVICE_LABEL] ?? "";
      const owner =
        project === MONITORING_PROJECT ? "monitoring" : services.has(service) ? service : "app";
      for (const mount of container.mounts) {
        const source: SideSource | undefined =
          mount.type === "volume" && mount.name !== undefined
            ? { kind: "volume", name: mount.name }
            : mount.type === "bind" && mount.source.startsWith(root)
              ? { kind: "bind", path: mount.source }
              : undefined;
        if (source === undefined) continue;
        const id = source.kind === "volume" ? `volume ${source.name}` : `bind ${source.path}`;
        if (!found.has(id)) found.set(id, { owner, key: mount.destination, source });
      }
    }
  }
  const volumes: SideVolume[] = [];
  for (const mount of found.values()) {
    volumes.push({ ...mount, bytes: await side.carrier.sourceSize(mount.source) });
  }
  return volumes.sort((a, b) => a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key));
}

/** The app's data folder on a server (`/srv/data/<app>/`): the only folders a side copies. */
function dataRoot(session: MoveBase): string {
  return `${appDirs(session.plan.app.name).data}/`;
}
