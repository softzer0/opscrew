/**
 * Where `logs` reads containers' lines, through the access `status` already uses (FR-1701,
 * FR-1703): a server OpsCrew created as `deploy` with the project's deploy key, the user's own
 * server through its pinned admin login, the user's Portainer through its API, and this computer's
 * Docker; an extra server (feature 018) through its own shell. Each lists a part's containers and
 * reads or follows one container's lines, read-only.
 */
import { setTimeout as delay } from "node:timers/promises";
import { type ContainerLogLine, sinceAfter } from "@opscrew/connector-portainer";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, type Redactor } from "@opscrew/core";
import { portainerTarget } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import type { ProvisionServices } from "../provision/types";
import { appServerShell, portainerClientFor, serverAddress } from "../shared";
import { connectAndInspectOwnServer } from "../shared/own-server";
import { hasExtraServers } from "../status/components";
import { serverShell } from "../status/servers";
import {
  dockerLogLine,
  isContainerName,
  type LogsQuery,
  listArgs,
  logsArgs,
  remoteFollow,
  remoteRead,
} from "./commands";

/** The fakes `logs` takes in tests. */
export type LogServices = Pick<
  ProvisionServices,
  "remote" | "own" | "portainer" | "sleep" | "cloudflare" | "sharedCloudflare"
>;

/** The containers of one part of the app: their Compose project and service. */
export interface ContainersOf {
  project: string;
  composeService: string;
}

/** A place whose containers' lines `logs` reads. */
export interface DockerLogs {
  /** Where the containers are: `on the server`, `in your Portainer`, `on this computer`. */
  where: string;
  /** The audit entry's target, never an address. */
  audit: string;
  /** The containers of the part: checked names, or Portainer's ids. */
  containers(part: ContainersOf): Promise<string[]>;
  /** One container's latest lines. */
  read(container: string, query: Omit<LogsQuery, "follow">): Promise<ContainerLogLine[]>;
  /** One container's new lines, each to `push`, until `signal` aborts (or the container stops). */
  follow(
    container: string,
    query: Omit<LogsQuery, "follow">,
    push: (line: ContainerLogLine) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

/** How often a follow asks Portainer for new lines (it buffers `follow=1`, spike result 7). */
const POLL_MS = 2_000;

/** Runs `docker <args>`, read-only: a read, or a follow sending each line to `onLine`. */
type DockerExec = (
  args: string[],
  options: {
    follow: boolean;
    onLine?: (stream: "stdout" | "stderr", line: string) => void;
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

/** The lines of a `docker logs --timestamps` result, both streams, by time. */
function resultLines(result: CommandResult): ContainerLogLine[] {
  const of = (stream: "stdout" | "stderr", text: string) =>
    text.split(/\r?\n/).flatMap((line) => dockerLogLine(stream, line) ?? []);
  return [...of("stdout", result.stdout), ...of("stderr", result.stderr)].sort(byTime);
}

/** Docker's timestamps are fixed-width UTC, so text order is time order. */
export function byTime(a: { time: string }, b: { time: string }): number {
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

/**
 * {@link DockerLogs} over `exec`, which runs the fixed commands; `failed` turns a failed one into
 * the error to show.
 */
function commandLogs(
  exec: DockerExec,
  words: Pick<DockerLogs, "where" | "audit">,
  failed: (result: CommandResult) => OpsCrewError,
): DockerLogs {
  return {
    ...words,
    async containers({ project, composeService }) {
      const result = await exec(listArgs(project, composeService), { follow: false });
      if (result.exitCode !== 0) throw failed(result);
      // A name Docker would not give is never used in a command.
      return result.stdout
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(isContainerName);
    },
    async read(container, query) {
      const result = await exec(logsArgs(container, query), { follow: false });
      if (result.exitCode !== 0) throw failed(result);
      return resultLines(result);
    },
    async follow(container, query, push, signal) {
      let result: CommandResult;
      try {
        result = await exec(logsArgs(container, { ...query, follow: true }), {
          follow: true,
          onLine: (stream, text) => {
            const line = dockerLogLine(stream, text);
            if (line !== undefined) push(line);
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (result.exitCode !== 0 && !signal.aborted) throw failed(result);
    },
  };
}

/**
 * Docker's (or ssh's) own last words on stderr, redacted, for a failed command's message: never a
 * line the container logged, which carries Docker's timestamp.
 */
function dockerSaid(result: CommandResult, redactor: Redactor): string {
  const own = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && dockerLogLine("stderr", line) === undefined);
  const said = redactor.redact(own.at(-1) ?? "").slice(0, 300);
  return said === "" ? "" : `: ${said}`;
}

/** The plain error of a server that does not answer over SSH. */
function noAnswer(server: string): OpsCrewError {
  return new OpsCrewError(
    "COMMAND_FAILED",
    `${server} did not answer over SSH, so OpsCrew could not read the app's logs.`,
    {
      hint: "Check that it is on, then run `opscrew verify`: it checks the app from the outside and says what fails.",
    },
  );
}

/** {@link DockerLogs} over SSH: `sudo` when the login reads Docker through passwordless sudo. */
function sshLogs(
  deps: Pick<PhaseDeps, "redactor">,
  remote: RemoteExec,
  sudo: boolean,
  words: Pick<DockerLogs, "where" | "audit"> & { server: string },
): DockerLogs {
  const exec: DockerExec = (args, { follow, onLine, signal }) =>
    remote.run(follow ? remoteFollow(args, sudo) : remoteRead(args, sudo), {
      // A follow runs until it is stopped.
      timeoutMs: follow ? Number.POSITIVE_INFINITY : 60_000,
      ...(onLine === undefined ? {} : { onLine }),
      ...(signal === undefined ? {} : { signal }),
    });
  return commandLogs(exec, words, (result) =>
    // ssh's own failure: the server did not answer (or refused the login).
    result.exitCode === 255 || result.timedOut === true
      ? noAnswer(words.server)
      : new OpsCrewError(
          "COMMAND_FAILED",
          `Docker ${words.where} could not read the app's logs (exit code ${result.exitCode})${dockerSaid(result, deps.redactor)}.`,
          { hint: "Run `opscrew status` to see what runs there, then try again." },
        ),
  );
}

/**
 * A server OpsCrew created: as `deploy` with the project's deploy key and the pinned host key, at
 * the address OpsCrew keeps on this computer, as `status` reads it.
 */
async function cloudServerLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: LogServices,
): Promise<DockerLogs> {
  const address = await serverAddress(deps, plan);
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not know the server's address on this computer, so it could not read the app's logs.",
      {
        hint: "Run the command on the computer that ran `opscrew provision` (the address is kept there, in .opscrew/server.json).",
      },
    );
  }
  const remote = await appServerShell(
    deps,
    plan,
    { host: address.ipv4, port: 22 },
    {
      ...(services.remote !== undefined ? { remote: services.remote } : {}),
      // A quiet follow keeps its connection through NAT, and notices a server that went away.
      keepAliveSeconds: 15,
    },
  );
  const named = hasExtraServers(plan);
  return sshLogs(deps, remote, false, {
    where: named ? `on server ${APP_SERVER}` : "on the server",
    audit: "server",
    server: named ? `Server ${APP_SERVER}` : "The server",
  });
}

/**
 * An extra server (feature 018): through its shell (`serverShell`), as `deploy` on a server
 * OpsCrew created or through the recorded admin login on the user's own, reading Docker through
 * passwordless sudo when `serverShell`'s probe says that login needs it.
 */
async function extraServerLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  name: string,
  services: LogServices,
): Promise<DockerLogs> {
  // A quiet follow keeps its connection through NAT, and notices a server that went away.
  const { remote, sudo } = await serverShell(deps, plan, name, services, {
    keepAliveSeconds: 15,
  });
  return sshLogs(deps, remote, sudo, {
    where: `on server ${name}`,
    audit: `server ${name}`,
    server: `Server ${name}`,
  });
}

/**
 * The user's own server: through its recorded admin login with the pinned host key, as `status`
 * connects (`connectAndInspectOwnServer`), reading Docker as root through passwordless sudo when
 * the login is not root.
 */
async function ownServerLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: LogServices,
  hostKey: string | undefined,
): Promise<DockerLogs> {
  let connected: Awaited<ReturnType<typeof connectAndInspectOwnServer>>;
  try {
    connected = await connectAndInspectOwnServer(deps, {
      hostKey,
      services: services.own,
      detail: "the app's logs",
    });
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "COMMAND_FAILED") {
      throw new OpsCrewError("COMMAND_FAILED", error.message, {
        hint: `${error.hint === undefined ? "" : `${error.hint} `}Then run \`opscrew verify\`: it checks the app from the outside and says what fails.`,
        cause: error,
      });
    }
    throw error;
  }
  const { session, facts } = connected;
  const named = hasExtraServers(plan);
  return sshLogs(deps, session.remote, facts.privilege === "sudo", {
    where: named ? `on server ${APP_SERVER}` : "on your server",
    audit: "own server",
    server: named ? `Server ${APP_SERVER}` : "Your server",
  });
}

/**
 * The user's Portainer: its Docker API with the confirmed certificate and `PORTAINER_API_KEY`. A
 * follow asks for the lines after the last one every 2 seconds (spike result 7).
 */
async function portainerLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: LogServices,
): Promise<DockerLogs> {
  const client = portainerClientFor(deps, {
    connection: await requirePortainerConnection(deps, plan),
    token: requirePortainerToken(deps),
    client: services.portainer?.client,
  });
  const environmentId = portainerTarget(plan.target).environmentId;
  const sleep = (ms: number, signal: AbortSignal) =>
    services.sleep?.(ms) ?? delay(ms, undefined, { signal }).catch(() => undefined);
  return {
    where: "in your Portainer",
    audit: "portainer",
    async containers({ project, composeService }) {
      const stack = (await client.listContainers(environmentId)).filter(
        (container) => container.project === project,
      );
      if (stack.length === 0) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "Your Portainer shows this access token none of the app's containers: a standard user's token sees only that user's own stacks, and the app may not be deployed yet.",
          {
            hint: "Use an administrator's access token, or the token of the user who deployed the app's stack, as PORTAINER_API_KEY, then try again. `opscrew status` shows whether the app runs.",
          },
        );
      }
      return stack
        .filter((container) => container.service === composeService)
        .map((container) => container.id);
    },
    read: (container, query) => client.containerLogs(environmentId, container, query),
    async follow(container, query, push, signal) {
      // Without a line yet, from the second the lines were read.
      let since = query.since ?? String(Math.floor(deps.clock.now().getTime() / 1000));
      for (;;) {
        await sleep(POLL_MS, signal);
        if (signal.aborted) return;
        const lines = await client.containerLogs(environmentId, container, {
          tail: query.tail,
          since,
        });
        for (const line of lines) push(line);
        const last = lines.at(-1);
        if (last !== undefined) since = sinceAfter(last.time);
      }
    },
  };
}

/** This computer's Docker, through the phase's runner (no shell). */
function localLogs(deps: Pick<PhaseDeps, "runner" | "redactor">): DockerLogs {
  const exec: DockerExec = (args, { follow, onLine, signal }) =>
    deps.runner.run("docker", args, {
      timeoutMs: follow ? Number.POSITIVE_INFINITY : 60_000,
      ...(onLine === undefined ? {} : { onLine: (line, stream) => onLine(stream, line) }),
      ...(signal === undefined ? {} : { signal }),
    });
  return commandLogs(
    exec,
    { where: "on this computer", audit: "this computer" },
    (result) =>
      new OpsCrewError(
        "COMMAND_FAILED",
        `Docker on this computer could not read the app's logs (exit code ${result.exitCode})${dockerSaid(result, deps.redactor)}.`,
        { hint: "Check that Docker runs, then try again. `opscrew status` shows what runs." },
      ),
  );
}

/**
 * The containers' place of the plan's target, connected (an own server's host key checked): the
 * app's server, or the extra server `server` that runs the part.
 */
export async function dockerLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: {
    services?: LogServices | undefined;
    hostKey?: string | undefined;
    server?: string | undefined;
  },
): Promise<DockerLogs> {
  const services = options.services ?? {};
  if (options.server !== undefined && options.server !== APP_SERVER) {
    return extraServerLogs(deps, plan, options.server, services);
  }
  switch (plan.target.provider) {
    case "portainer":
      return portainerLogs(deps, plan, services);
    case "localhost":
      return localLogs(deps);
    case "own":
      return ownServerLogs(deps, plan, services, options.hostKey);
    case "hetzner":
    case "digitalocean":
      return cloudServerLogs(deps, plan, services);
    default:
      throw new Error(`A site on ${plan.target.provider} has no containers.`);
  }
}
