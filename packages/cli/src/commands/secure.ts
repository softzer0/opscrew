import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew secure` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(program, ctx, "secure", "Harden the servers and write the security report");
}
