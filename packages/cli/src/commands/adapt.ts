import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew adapt` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(
    program,
    ctx,
    "adapt",
    "Adapt the app for self-hosting (Dockerfile, config, CI workflow)",
  );
}
