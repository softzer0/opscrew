import type { Command } from "commander";
import type { CliContext } from "../context";
import { registerStub } from "./stub";

/** `opscrew dns` (not implemented yet). */
export function register(program: Command, ctx: CliContext): void {
  registerStub(program, ctx, "dns", "Point your domain at the new servers through Cloudflare");
}
