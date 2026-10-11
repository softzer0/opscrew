import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew interview` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(
    program,
    ctx,
    "interview",
    "Ask a few questions about traffic, budget and your domain",
  );
}
