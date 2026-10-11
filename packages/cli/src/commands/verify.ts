import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew verify` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(program, ctx, "verify", "Check that the deployment is up, healthy and secure");
}
