import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew design` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(
    program,
    ctx,
    "design",
    "Design the production architecture and estimate its monthly cost",
  );
}
