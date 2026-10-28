import { createHash } from "node:crypto";
import type {
  ContainerLogLine,
  ContainerSummary,
  PortainerClient,
} from "@opscrew/connector-portainer";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  RemoteExec,
  RemoteRunOptions,
} from "@opscrew/contracts";

/** One log line of a fake container: Docker's timestamp (RFC 3339, nanoseconds), stream, text. */
export interface FakeLogLine {
  time: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** A container of the fake Docker: its Compose labels and the lines it logged, oldest first. */
export interface FakeLogContainer {
  name: string;
  project: string;
  service: string;
  lines: FakeLogLine[];
}

/** Nanoseconds since the epoch of a Docker timestamp, or of a `since` (`<s>` or `<s>.<ns>`). */
function nanos(value: string): bigint {
  const since = /^(\d+)(?:\.(\d{9}))?$/.exec(value);
  if (since !== null) return BigInt(since[1] as string) * 1_000_000_000n + BigInt(since[2] ?? 0);
  const time = /^(.+?)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (time === null) throw new Error(`not a Docker timestamp: ${value}`);
  const seconds = BigInt(Date.parse(`${time[1]}Z`) / 1000);
  return seconds * 1_000_000_000n + BigInt((time[2] ?? "").padEnd(9, "0"));
}

/** A rejection like the runner's when `signal` aborts a command. */
function aborted(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/**
 * Docker for `logs` tests: it answers the fixed `docker ps` and `docker logs` commands, over SSH
 * (with or without `sudo -n` and the follow wrapper) or as a runner's `docker` arguments, and
 * records each one. A follow sends the container's lines as `docker logs` would, then waits for its
 * signal and rejects as the runner does; {@link FakeDocker.log} adds a line while it waits.
 */
export class FakeDocker {
  containers: FakeLogContainer[] = [];
  /** Every command line run over SSH, and `docker <args>` of every runner call. */
  readonly commands: string[] = [];
  /** ssh fails as it does for a server that does not answer (exit 255). */
  unreachable = false;
  /** What every `docker logs` read answers instead, as a failing Docker would. */
  logsFailure: CommandResult | undefined;
  /** The followers waiting for new lines, by container name. */
  readonly #followers = new Map<string, ((stream: "stdout" | "stderr", line: string) => void)[]>();

  constructor(containers: FakeLogContainer[] = []) {
    this.containers = containers;
  }

  /** How many follows still wait for new lines (0 once every one was stopped). */
  get following(): number {
    return [...this.#followers.values()].reduce((sum, list) => sum + list.length, 0);
  }

  /** The container `name` logs a line: kept, and sent to its followers. */
  log(name: string, line: FakeLogLine): void {
    const container = this.containers.find((c) => c.name === name);
    if (container === undefined) throw new Error(`no container ${name}`);
    container.lines.push(line);
    for (const send of this.#followers.get(name) ?? []) {
      send(line.stream, `${line.time} ${line.text}`);
    }
  }

  /** The fake server's shell: the commands run as `docker` would answer them. */
  remote(host = "server"): RemoteExec {
    return {
      host,
      run: async (command: string, options: RemoteRunOptions = {}) => {
        this.commands.push(command);
        if (this.unreachable) {
          return {
            exitCode: 255,
            stdout: "",
            stderr: "ssh: connect to host: Connection timed out",
          };
        }
        if (command === "true") return { exitCode: 0, stdout: "", stderr: "" };
        return this.#docker(dockerArgs(command), options);
      },
    };
  }

  /** A runner whose `docker` is this Docker (the localhost target); any other program fails. */
  runner(): CommandRunner {
    return {
      run: async (command: string, args: readonly string[], options: CommandOptions = {}) => {
        if (command !== "docker") return { exitCode: 127, stdout: "", stderr: "not found" };
        this.commands.push(["docker", ...args].join(" "));
        const { onLine, signal } = options;
        return this.#docker([...args], {
          ...(onLine === undefined ? {} : { onLine: (stream, line) => onLine(line, stream) }),
          ...(signal === undefined ? {} : { signal }),
        });
      },
    };
  }

  /** The lines of `name` after `since`, the latest `tail` of them, oldest first. */
  linesOf(name: string, tail: number, since?: string): FakeLogLine[] {
    const container = this.containers.find((c) => c.name === name);
    if (container === undefined) return [];
    const after = since === undefined ? undefined : nanos(since);
    const kept = container.lines.filter((l) => after === undefined || nanos(l.time) >= after);
    return kept.slice(-tail);
  }

  /** `docker ps` and `docker logs` as the commands `logs` builds use them. */
  async #docker(
    args: string[],
    options: Pick<RemoteRunOptions, "onLine" | "signal">,
  ): Promise<CommandResult> {
    if (args[0] === "ps") {
      const label = (key: string) =>
        args.find((a) => a.startsWith(`label=com.docker.compose.${key}=`))?.split("=")[2];
      const names = this.containers
        .filter((c) => c.project === label("project") && c.service === label("service"))
        .map((c) => c.name);
      return { exitCode: 0, stdout: names.map((n) => `${n}\n`).join(""), stderr: "" };
    }
    if (args[0] !== "logs") throw new Error(`unexpected docker command: ${args.join(" ")}`);
    const value = (flag: string) => {
      const at = args.indexOf(flag);
      return at === -1 ? undefined : args[at + 1];
    };
    const name = args.at(-1) as string;
    if (!this.containers.some((c) => c.name === name)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error response from daemon: No such container: ${name}\n`,
      };
    }
    const lines = this.linesOf(name, Number(value("--tail")), value("--since"));
    if (!args.includes("--follow")) {
      if (this.logsFailure !== undefined) return this.logsFailure;
      const of = (stream: "stdout" | "stderr") =>
        lines
          .filter((l) => l.stream === stream)
          .map((l) => `${l.time} ${l.text}\n`)
          .join("");
      return { exitCode: 0, stdout: of("stdout"), stderr: of("stderr") };
    }
    const { onLine, signal } = options;
    if (onLine === undefined || signal === undefined) throw new Error("a follow without onLine");
    for (const l of lines) onLine(l.stream, `${l.time} ${l.text}`);
    const followers = this.#followers.get(name) ?? [];
    followers.push(onLine);
    this.#followers.set(name, followers);
    return new Promise((_resolve, reject) => {
      const stop = () => {
        followers.splice(followers.indexOf(onLine), 1);
        reject(aborted());
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }
}

/** The `docker` arguments of a command line `logs` sends over SSH (sudo and the wrapper removed). */
function dockerArgs(command: string): string[] {
  let text = command;
  const sudoShell = /^sudo -n sh -c '(.*)' "\$PPID"$/.exec(text);
  if (sudoShell !== null) text = sudoShell[1] as string;
  text = text.replace(/^sudo -n /, "").replace(/ & p=\$!; while kill -0 .*$/, "");
  const words = text.split(" ");
  if (words[0] !== "docker") throw new Error(`not a docker command: ${command}`);
  return words.slice(1).map((word) => word.replace(/^'(.*)'$/, "$1"));
}

/** One `containerLogs` call of {@link fakePortainerLogs}. */
export interface PortainerLogsCall {
  environmentId: number;
  containerId: string;
  tail: number;
  since?: number | string;
}

/** Docker's container id of a fake container (64 hex digits from its name). */
export function fakeContainerId(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

/**
 * A Portainer client over {@link FakeDocker}'s containers: `listContainers` (none when `visible`
 * is false, as for a standard user's token and another user's stack) and `containerLogs`, sorted
 * by time as the connector returns them. Every other method is missing.
 */
export function fakePortainerLogs(docker: FakeDocker, options: { visible?: boolean } = {}) {
  const calls: PortainerLogsCall[] = [];
  const client = {
    async listContainers(_environmentId: number): Promise<ContainerSummary[]> {
      if (options.visible === false) return [];
      return docker.containers.map((c) => ({
        id: fakeContainerId(c.name),
        project: c.project,
        service: c.service,
        running: true,
        publishedPorts: [],
      }));
    },
    async containerLogs(
      environmentId: number,
      containerId: string,
      query: { tail: number; since?: number | string },
    ): Promise<ContainerLogLine[]> {
      calls.push({ environmentId, containerId, ...query });
      const container = docker.containers.find((c) => fakeContainerId(c.name) === containerId);
      if (container === undefined) throw new Error(`no container ${containerId}`);
      const since = query.since === undefined ? undefined : String(query.since);
      return docker
        .linesOf(container.name, query.tail, since)
        .map((l) => ({ stream: l.stream, time: l.time, line: l.text }))
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    },
  } as unknown as PortainerClient;
  return { client: () => client, calls };
}
