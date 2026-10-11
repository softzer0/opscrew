import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NodeCommandRunner } from "@opscrew/core";
import type { OpscrewMcpDeps } from "./deps";
import { createOpscrewMcpServer } from "./server";

/** Options for {@link startStdioServer}; anything omitted comes from the current process. */
export interface StdioServerOptions extends Partial<OpscrewMcpDeps> {
  /** OpsCrew version reported to the client. */
  version: string;
  /** MCP input (default `process.stdin`). */
  stdin?: Readable;
  /** MCP output (default `process.stdout`). Nothing else may write to it. */
  stdout?: Writable;
  /** Diagnostics output (default `process.stderr`). */
  stderr?: Writable;
}

/** A running stdio server. */
export interface RunningStdioServer {
  server: McpServer;
  /** Closes the transport and restores `console` when it was redirected. */
  close(): Promise<void>;
}

type ConsoleMethod = "log" | "info" | "debug";

/**
 * Starts the OpsCrew MCP server over stdio (`opscrew mcp`). Defaults: `process.env`, global
 * `fetch`, `NodeCommandRunner`, `process.cwd()`. stdout is the MCP channel, so diagnostics go to
 * stderr and, when the default stdout is used, `console.log/info/debug` are redirected to stderr
 * while the server runs.
 */
export async function startStdioServer(options: StdioServerOptions): Promise<RunningStdioServer> {
  const stderr = options.stderr ?? process.stderr;
  const log = options.log ?? ((message: string) => void stderr.write(`[opscrew mcp] ${message}\n`));
  const deps: OpscrewMcpDeps = {
    ...options,
    version: options.version,
    env: options.env ?? process.env,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    runner: options.runner ?? new NodeCommandRunner(),
    cwd: options.cwd ?? process.cwd(),
    log,
  };

  const restore: Array<() => void> = [];
  if (options.stdout === undefined) {
    for (const method of ["log", "info", "debug"] as const satisfies readonly ConsoleMethod[]) {
      const original = console[method];
      console[method] = (...args: unknown[]) => console.error(...args);
      restore.push(() => {
        console[method] = original;
      });
    }
  }

  const server = createOpscrewMcpServer(deps);
  const transport = new StdioServerTransport(
    options.stdin ?? process.stdin,
    options.stdout ?? process.stdout,
  );
  transport.onerror = (error) => log(`transport error: ${error.message}`);
  await server.connect(transport);
  log(`OpsCrew MCP server ${options.version} ready on stdio (project: ${deps.cwd}).`);

  let closed = false;
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } finally {
        for (const undo of restore) undo();
      }
    },
  };
}
