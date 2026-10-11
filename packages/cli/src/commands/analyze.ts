import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew analyze` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(
    program,
    ctx,
    "analyze",
    "Analyse the app: frameworks, services and environment variables",
  );
}
