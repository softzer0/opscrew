/**
 * The fixed, read-only Docker commands `logs` runs (FR-1703): listing a part's containers by
 * Compose's labels, and `docker logs` of one container. Every command is fixed text plus checked
 * parts: names against the container-name pattern `status` reads names with, whole numbers, and a
 * `since` of digits. Nothing else can reach a command.
 */
import type { ContainerLogLine } from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import { shellQuote } from "@opscrew/iac-templates";

/** A container name as Docker allows it: the pattern `status` reads names with (`status/components.ts`). */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Docker's `since`: whole Unix seconds, or `<seconds>.<nanoseconds>` (`sinceAfter`). */
const SINCE = /^\d{1,12}(\.\d{9})?$/;

/** The format of the container listing: each container's name, one per line. */
const NAMES_FORMAT = "{{.Names}}";

/** True when `name` is a container, Compose project or Compose service name a command may hold. */
export function isContainerName(name: string): boolean {
  return CONTAINER_NAME.test(name);
}

function checkedName(name: string): string {
  if (!isContainerName(name)) {
    throw new OpsCrewError("INTERNAL", "A container name OpsCrew does not read logs of.");
  }
  return name;
}

/**
 * `docker ps` arguments that list the containers of Compose project `project` and service
 * `service` (one-off containers left out), by name.
 * @throws OpsCrewError `INTERNAL` for a project or service that is no container name.
 */
export function listArgs(project: string, service: string): string[] {
  return [
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${checkedName(project)}`,
    "--filter",
    `label=com.docker.compose.service=${checkedName(service)}`,
    "--filter",
    "label=com.docker.compose.oneoff=False",
    "--format",
    NAMES_FORMAT,
  ];
}

/** What `docker logs` reads: the latest `tail` lines, after `since`, and whether it follows. */
export interface LogsQuery {
  tail: number;
  /** Whole Unix seconds, or `<seconds>.<nanoseconds>`. */
  since?: string;
  follow?: boolean;
}

/**
 * `docker logs --timestamps --tail <n> [--since <unix>] [--follow] <container>` as arguments.
 * @throws OpsCrewError `INTERNAL` for a container that is no container name, a tail that is no
 * positive whole number, or a `since` that is not Docker's Unix form.
 */
export function logsArgs(container: string, query: LogsQuery): string[] {
  const { tail, since } = query;
  if (!Number.isSafeInteger(tail) || tail <= 0) {
    throw new OpsCrewError("INTERNAL", "The log tail is a positive whole number of lines.");
  }
  if (since !== undefined && !SINCE.test(since)) {
    throw new OpsCrewError("INTERNAL", "The log since is whole Unix seconds or <s>.<ns>.");
  }
  return [
    "logs",
    "--timestamps",
    "--tail",
    String(tail),
    ...(since === undefined ? [] : ["--since", since]),
    ...(query.follow === true ? ["--follow"] : []),
    checkedName(container),
  ];
}

/**
 * The shell command line of `docker <args>` built by {@link listArgs} or {@link logsArgs}: their
 * parts are checked or fixed, and the listing's format is quoted.
 */
export function dockerCommand(args: readonly string[]): string {
  return ["docker", ...args.map((arg) => (arg === NAMES_FORMAT ? shellQuote(arg) : arg))].join(" ");
}

/** {@link dockerCommand} for a login that reads Docker through passwordless sudo, or itself. */
export function remoteRead(args: readonly string[], sudo: boolean): string {
  return `${sudo ? "sudo -n " : ""}${dockerCommand(args)}`;
}

/**
 * `command` in the background, ended within a second of the process `parent` going (the measured
 * wrapper of spike result 8): without a terminal, a quiet `docker logs --follow` outlives ssh.
 */
function untilSshGoes(command: string, parent: string): string {
  return `${command} & p=$!; while kill -0 ${parent} 2>/dev/null && kill -0 $p 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null; wait $p`;
}

/**
 * The remote command that follows `docker <args>` and ends when ssh goes: the login shell's parent
 * is sshd's session, so the follower ends with it. Through sudo the wrapper runs as root, whose
 * own parent is sudo (which outlives ssh), so the login shell passes its parent's id in.
 */
export function remoteFollow(args: readonly string[], sudo: boolean): string {
  const command = dockerCommand(args);
  return sudo
    ? `sudo -n sh -c ${shellQuote(untilSshGoes(command, '"$0"'))} "$PPID"`
    : untilSshGoes(command, "$PPID");
}

/** Docker's timestamp at the start of a `--timestamps` line, then a space and the text. */
const TIMESTAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})) ?/;

/**
 * One line of `docker logs --timestamps` on `stream`, split into its time and text; `undefined`
 * for a line without Docker's timestamp (Docker's own error, an ssh warning).
 */
export function dockerLogLine(
  stream: ContainerLogLine["stream"],
  text: string,
): ContainerLogLine | undefined {
  const match = TIMESTAMPED.exec(text);
  if (match === null) return undefined;
  return { stream, time: match[1] as string, line: text.slice(match[0].length) };
}

/** Accepted `--since` forms: a whole number and its unit. */
const DURATION = /^([1-9]\d{0,5})([smhd])$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/**
 * `--since` in seconds: `30s`, `15m`, `2h` or `3d`.
 * @throws OpsCrewError `INVALID_INPUT` for anything else.
 */
export function parseSince(value: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--since takes a whole number and a unit, such as 30s, 15m, 2h or 3d, not "${value}".`,
      { hint: "For example `--since 15m` shows the lines of the last 15 minutes." },
    );
  }
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
}
