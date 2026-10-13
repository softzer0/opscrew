import { PHASES } from "@opscrew/contracts";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { retargetStatusLine } from "../ui/retarget";

/**
 * `opscrew status`: which phases have run in this project, with their result and time, and a
 * `retarget` line while a move to another provider is in progress (from → to, last completed
 * step, the next command).
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("Show which OpsCrew phases have run and where a move between providers stands")
    .action(async () => {
      const paths = resolveProjectPaths(ctx.cwd, { env: ctx.env });
      const state = await new ProjectStateStore(paths.files.state).read();
      // A missing or unreadable plan simply means no move is recorded.
      const move = await readArtifact("plan", paths.files.plan)
        .then(retargetStatusLine)
        .catch(() => undefined);
      const moveLines = move === undefined ? [] : ["", "Move in progress:", move];
      if (Object.keys(state.phases).length === 0) {
        ctx.stdout("No phases have run yet. Start with `opscrew scan`.\n");
        if (moveLines.length > 0) ctx.stdout(`${moveLines.join("\n")}\n`);
        return;
      }
      const width = Math.max(...PHASES.map((phase) => phase.length));
      const lines = [`OpsCrew phases in ${paths.root}`, ""];
      for (const phase of PHASES) {
        const record = state.phases[phase];
        const name = phase.padEnd(width);
        if (record === undefined) {
          lines.push(`  ${name}  not run`);
          continue;
        }
        const summary = record.summary === undefined ? "" : `  ${record.summary}`;
        lines.push(`  ${name}  ${record.status.padEnd(7)}  ${record.at}${summary}`);
      }
      lines.push(...moveLines);
      ctx.stdout(`${lines.join("\n")}\n`);
    });
}
