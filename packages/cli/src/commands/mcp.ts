import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew mcp` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(program, ctx, "mcp", "Start the OpsCrew MCP server over stdio");
}
