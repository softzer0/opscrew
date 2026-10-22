import { localTrust } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";

/** Runs `localhost trust` or `untrust` (contracts/localhost.md "localTrust"). */
async function trust(ctx: CliContext, action: "trust" | "untrust"): Promise<void> {
  const services = servicesOf(ctx).localhost;
  await localTrust(createPhaseDeps(ctx, { ai: false }), {
    action,
    ...(services === undefined ? {} : { services }),
  });
}

/**
 * `opscrew localhost trust|untrust`: adds OpsCrew's local CA to this computer's trusted
 * certificates, so browsers open the local stack's `https://<app>.localhost` without a warning, or
 * takes that trust back. It shows the exact command first and runs it only after the user agrees
 * in a terminal; a script only prints it.
 */
export function register(program: Command, ctx: CliContext): void {
  const localhost = program
    .command("localhost")
    .description("Trust or untrust OpsCrew's local certificate authority on this computer");
  localhost
    .command("trust")
    .description(
      "Trust OpsCrew's local CA, so browsers open https://<app>.localhost without a warning (shows the command and asks first)",
    )
    .action(() => trust(ctx, "trust"));
  localhost
    .command("untrust")
    .description(
      "Stop trusting OpsCrew's local CA on this computer (shows the command and asks first)",
    )
    .action(() => trust(ctx, "untrust"));
}
