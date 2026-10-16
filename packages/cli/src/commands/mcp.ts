import type { Readable } from "node:stream";
import { startStdioServer } from "@opscrew/mcp-server";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { servicesOf } from "../deps";

/** Resolves when `stdin` ends or closes, or (for the process's stdin) on SIGINT/SIGTERM. */
function untilClosed(stdin: Readable, isProcessStdin: boolean): Promise<void> {
  return new Promise((resolve) => {
    const events = ["end", "close"] as const;
    const signals = isProcessStdin ? (["SIGINT", "SIGTERM"] as const) : [];
    const done = () => {
      for (const event of events) stdin.off(event, done);
      for (const signal of signals) process.off(signal, done);
      resolve();
    };
    if (stdin.readableEnded || stdin.destroyed) {
      resolve();
      return;
    }
    for (const event of events) stdin.once(event, done);
    for (const signal of signals) process.once(signal, done);
  });
}

/**
 * `opscrew mcp`: serves the OpsCrew MCP tools over stdio for the project in the current directory
 * until the client closes the connection. Standard output is the MCP channel, so every message of
 * this command goes to standard error.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("mcp")
    .description("Start the OpsCrew MCP server over stdio")
    .action(async () => {
      const { fetch, runner, clock, mcp } = servicesOf(ctx);
      const streams = mcp ?? {};
      const stdin = streams.stdin ?? process.stdin;
      const running = await startStdioServer({
        version: ctx.version,
        cwd: ctx.cwd,
        env: ctx.env,
        redactor: ctx.redactor,
        log: (message) => ctx.stderr(`[opscrew mcp] ${message}\n`),
        stdin,
        ...(streams.stdout === undefined ? {} : { stdout: streams.stdout }),
        ...(fetch === undefined ? {} : { fetch }),
        ...(runner === undefined ? {} : { runner }),
        ...(clock === undefined ? {} : { clock }),
      });
      try {
        await untilClosed(stdin, streams.stdin === undefined);
      } finally {
        await running.close();
      }
      ctx.stderr("[opscrew mcp] Client disconnected; server stopped.\n");
    });
}
