import { PHASES } from "@opscrew/contracts";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import type { Command } from "commander";
import type { CliContext } from "../context";

/** `opscrew status`: which phases have run in this project, with their result and time. */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("Show which OpsCrew phases have run in this project")
    .action(async () => {
      const paths = resolveProjectPaths(ctx.cwd, { env: ctx.env });
      const state = await new ProjectStateStore(paths.files.state).read();
      if (Object.keys(state.phases).length === 0) {
        ctx.stdout("No phases have run yet. Start with `opscrew scan`.\n");
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
      ctx.stdout(`${lines.join("\n")}\n`);
    });
}
