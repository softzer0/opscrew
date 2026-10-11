import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew scan` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(
    program,
    ctx,
    "scan",
    "Scan the repository for security problems (free, no model needed)",
  );
}
