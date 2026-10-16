import {
  formatServerAddress,
  type PhaseDeps,
  phaseStatusLines,
  type ServerAddress,
  serverAddress,
} from "@opscrew/agents";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps } from "../deps";
import { retargetStatusLine } from "../ui/retarget";

/**
 * The server's address from OpsCrew's local state (or the infrastructure state), never from the
 * repository; `undefined` without a plan or a known server.
 */
async function addressOf(
  deps: PhaseDeps,
  plan: DeployPlan | undefined,
): Promise<ServerAddress | undefined> {
  return plan === undefined ? undefined : serverAddress(deps, plan);
}

/**
 * The lines that show the server's address on this computer. A damaged `.opscrew/server.json`
 * (`ARTIFACT_INVALID`) does not stop `opscrew status`: the phases are still shown, with a note
 * that says what to do.
 */
async function addressLines(deps: PhaseDeps, plan: DeployPlan | undefined): Promise<string[]> {
  let address: ServerAddress | undefined;
  try {
    address = await addressOf(deps, plan);
  } catch (error) {
    if (!isUserFacingError(error) || error.code !== "ARTIFACT_INVALID") throw error;
    const note = `Server address: unknown. ${error.message}${error.hint ? ` ${error.hint}` : ""}`;
    return ["", deps.redactor.redact(note)];
  }
  if (address === undefined) return [];
  return [
    "",
    "Server address (kept on this computer only, never in the repository):",
    `  ${formatServerAddress(address)}`,
  ];
}

/**
 * `opscrew status`: which phases have run in this project, with their result and time, the
 * server's address (from OpsCrew's local state; it is never committed) and a `retarget` line while
 * a move to another provider is in progress (from → to, last completed step, the next command).
 * `--ip` prints only the server's IPv4 address, for scripts such as
 * `ssh deploy@$(opscrew status --ip)`.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("Show which OpsCrew phases have run and where a move between providers stands")
    .option(
      "--ip",
      "Print only the server's IPv4 address (for scripts, e.g. ssh deploy@$(opscrew status --ip))",
    )
    .action(async (flags: { ip?: boolean }) => {
      const deps = createPhaseDeps(ctx, { ai: false });
      const { paths } = deps;
      // A missing or unreadable plan simply means nothing is deployed and no move is recorded.
      const plan = await readArtifact("plan", paths.files.plan).catch(() => undefined);
      if (flags.ip === true) {
        const address = await addressOf(deps, plan);
        if (address === undefined) {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            "OpsCrew does not know the server's address on this computer.",
            {
              hint: "Run `opscrew status --ip` on the computer that ran `opscrew provision` (the address is kept there, in .opscrew/server.json), or run `opscrew provision` here first.",
            },
          );
        }
        ctx.stdout(`${address.ipv4}\n`);
        return;
      }
      const state = await deps.state.read();
      const move = plan === undefined ? undefined : retargetStatusLine(plan);
      const moveLines = move === undefined ? [] : ["", "Move in progress:", move];
      const serverLines = await addressLines(deps, plan);
      if (Object.keys(state.phases).length === 0) {
        ctx.stdout("No phases have run yet. Start with `opscrew scan`.\n");
        const extra = [...serverLines, ...moveLines];
        if (extra.length > 0) ctx.stdout(`${extra.join("\n")}\n`);
        return;
      }
      const lines = [
        `OpsCrew phases in ${paths.root}`,
        "",
        ...phaseStatusLines(state.phases),
        ...serverLines,
        ...moveLines,
      ];
      ctx.stdout(`${lines.join("\n")}\n`);
    });
}
