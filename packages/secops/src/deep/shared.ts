import { randomBytes } from "node:crypto";
import type { CheckResult, CommandResult } from "@opscrew/contracts";
import { errorMessage } from "@opscrew/core";
import {
  DEEP_TOOL_NAME,
  type DeepPins,
  type DeepTool,
  type DeepToolResult,
  type LocalDocker,
} from "./types";

/** The release in an image pin's tag: `3.9.0` for `positronsecurity/ssh-audit:v3.9.0@sha256:…`. */
export function imageVersion(ref: string): string {
  const tag = /:([^:@/]+)@/.exec(ref)?.[1] ?? ref;
  return tag.replace(/^v/, "");
}

/** A unique name for one run's container, so a run that times out can be removed. */
export function containerName(tool: DeepTool): string {
  return `opscrew-${tool}-${randomBytes(6).toString("hex")}`;
}

/** The command's stdout as JSON; undefined when it is not JSON. */
export function json(result: CommandResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * `docker run --rm --name <unique> …args` on this computer within `timeoutMs`. On a timeout the
 * container, which outlives the killed `docker` client, is removed with `docker rm -f`.
 */
export async function runLocalContainer(
  docker: LocalDocker,
  tool: DeepTool,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const name = containerName(tool);
  const result = await docker.run(["run", "--rm", "--name", name, ...args], { timeoutMs });
  if (result.timedOut) await docker.run(["rm", "-f", name], { timeoutMs: 30_000 });
  return result;
}

/** The last non-empty line of a command's output (stderr first), without terminal colours. */
export function lastLine(result: CommandResult): string {
  for (const text of [result.stderr, result.stdout]) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes.
    const lines = text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
    const line = lines.map((l) => l.trim()).findLast((l) => l !== "");
    if (line !== undefined) return line;
  }
  return `exit code ${result.exitCode}`;
}

/** The version `tool` runs at: Lynis's tarball, or the image pin's tag. */
export function pinnedVersion(tool: DeepTool, pins: DeepPins): string {
  if (tool === "lynis") return pins.lynis.version;
  return imageVersion(tool === "ssh-audit" ? pins.sshAudit : pins.testssl);
}

/** A tool's one `skip` result, at its pinned version: why it did not run, and how to make it run. */
export function skippedTool(
  tool: DeepTool,
  pins: DeepPins,
  reason: string,
  remediation: string,
): DeepToolResult {
  return {
    tool,
    version: pinnedVersion(tool, pins),
    results: [skipResult(tool, reason, remediation)],
  };
}

/** A `skip` result of `tool`. */
export function skipResult(
  tool: DeepTool,
  message: string,
  remediation: string,
  target?: string,
): CheckResult {
  return {
    id: `${tool}-skipped`,
    title: `${DEEP_TOOL_NAME[tool]} ran`,
    status: "skip",
    severity: "info",
    message,
    remediation,
    source: tool,
    ...(target !== undefined ? { target } : {}),
  };
}

const INSTALL_DOCKER =
  "Install Docker Desktop (or Docker Engine on Linux) on this computer and start it, then run `opscrew secure --deep` again.";

/**
 * Why `docker` cannot run on this computer (not installed, or its engine not running), with how to
 * enable it; `undefined` when it can.
 */
export async function localDockerProblem(
  docker: LocalDocker,
): Promise<{ message: string; remediation: string } | undefined> {
  let result: CommandResult;
  try {
    result = await docker.run(["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 30_000,
    });
  } catch (error) {
    return {
      message: `Docker is not installed on this computer (${errorMessage(error)}), so the outside audits did not run.`,
      remediation: INSTALL_DOCKER,
    };
  }
  if (result.exitCode === 0 && !result.timedOut) return undefined;
  return {
    message: `Docker is installed but its engine is not running (${lastLine(result)}), so the outside audits did not run.`,
    remediation:
      "Start Docker Desktop (or the Docker service), then run `opscrew secure --deep` again.",
  };
}

/** The skip for a local tool whose `docker run` timed out or failed before the tool answered. */
export function dockerRunSkip(
  tool: DeepTool,
  result: CommandResult,
  what: string,
  limit: string,
  target?: string,
): CheckResult {
  const name = DEEP_TOOL_NAME[tool];
  return result.timedOut
    ? skipResult(
        tool,
        `${name} did not finish ${what} within ${limit}, so it gives no result: the connection was blocked or timed out.`,
        "Check that this computer can reach the server (fail2ban may have blocked its address for a while), then run `opscrew secure --deep` again.",
        target,
      )
    : skipResult(
        tool,
        `${name} could not finish ${what}: ${lastLine(result)}.`,
        "Check that this computer can reach the server and Docker can pull the image, then run `opscrew secure --deep` again.",
        target,
      );
}
