import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type LogLine, type LogServices, readLogs, readOwnServer } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { hostKeyNeedsTerminal } from "./elicitation";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/** The most lines `opscrew_logs` returns. */
export const MAX_LOG_LINES = 500;
/** The most bytes of lines `opscrew_logs` returns (64 KiB). */
export const MAX_LOG_BYTES = 64 * 1024;

/** Test-only collaborators for `opscrew_logs` (production connects as `opscrew logs` does). */
export interface LogsToolOptions {
  services?: LogServices;
}

/** One line as the tool returns it in its text: `<time> <service> <text>`. */
function lineText(line: LogLine): string {
  return `${line.time} ${line.service} ${line.text}`;
}

/**
 * The newest of `lines` (oldest first) that fit {@link MAX_LOG_LINES} and {@link MAX_LOG_BYTES},
 * still oldest first, and whether any was left out.
 */
function bounded(lines: readonly LogLine[]): { lines: LogLine[]; truncated: boolean } {
  const kept: LogLine[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_LOG_LINES; i--) {
    const line = lines[i] as LogLine;
    bytes += Buffer.byteLength(`${lineText(line)}\n`);
    if (bytes > MAX_LOG_BYTES) break;
    kept.push(line);
  }
  return { lines: kept.reverse(), truncated: kept.length < lines.length };
}

/**
 * `opscrew_logs` (FR-1715): the app's latest log lines, as `opscrew logs` reads them (read-only,
 * each masked by the redactor), at most {@link MAX_LOG_LINES} lines and {@link MAX_LOG_BYTES}
 * (`truncated: true` past either, the newest kept). It never follows. On the user's own server it
 * connects only once the server's SSH host key was confirmed in a terminal. `options` is for tests
 * only.
 */
export function registerLogsTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: LogsToolOptions = {},
): void {
  server.registerTool(
    "opscrew_logs",
    {
      title: "OpsCrew logs",
      description: `Read the app's latest log lines (newest last, each with its time and part) where it runs: on a server over SSH, in the user's Portainer, in local Docker, or a server-rendered app's requests on Cloudflare's hosting. GitHub Pages and a static site on Cloudflare keep no request logs: their last deploy runs instead. Read-only, never follows, secrets masked; at most ${MAX_LOG_LINES} lines and 64 KiB (truncated: true when more were left out). Call opscrew_status first, then read the failing part with a short since (for example 15m).`,
      inputSchema: {
        ...projectDirInput,
        ...appInput,
        ...environmentInput,
        service: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The part whose lines to read: app (the web process, the default), a worker, a cron job or a service by its name in the plan, cron, or edge (the proxy in front of the app). A wrong name is refused with the names there are.",
          ),
        since: z
          .string()
          .min(1)
          .optional()
          .describe("Only lines of the last 30s, 15m, 2h or 3d. Prefer a short span."),
        tail: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `How many of the latest lines (default 200). At most ${MAX_LOG_LINES} are returned, so never ask for more.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment, service, since, tail }) =>
      runTool(deps, "opscrew_logs", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        // The model cannot confirm a host key: an own server never confirmed is left to the terminal.
        if (plan.target.provider === "own") {
          const recorded = await readOwnServer(phase.paths).catch(() => undefined);
          if (recorded !== undefined && recorded.hostKey === undefined) {
            throw hostKeyNeedsTerminal("logs", "Nothing was read.");
          }
        }
        const read = await readLogs(phase, plan, {
          ...(service === undefined ? {} : { service }),
          ...(since === undefined ? {} : { since }),
          // Asking for more lines than are returned only reads more.
          ...(tail === undefined ? {} : { tail: Math.min(tail, MAX_LOG_LINES) }),
          ...(options.services === undefined ? {} : { services: options.services }),
        });
        const all: LogLine[] = [];
        for await (const line of read) all.push(line);
        const kept = bounded(all);
        // A tail past the bound was cut only when the read filled it.
        const truncated =
          kept.truncated || ((tail ?? 0) > MAX_LOG_LINES && all.length >= MAX_LOG_LINES);
        const text = [
          read.first,
          ...kept.lines.map(lineText),
          ...(truncated
            ? [
                `(Only the newest ${kept.lines.length} lines are shown: at most ${MAX_LOG_LINES} lines and 64 KiB. Use a shorter since, or service, to see the part that matters.)`,
              ]
            : []),
        ].join("\n");
        return { text, data: { first: read.first, lines: kept.lines, truncated } };
      }),
  );
}
