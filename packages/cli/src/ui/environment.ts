import { environmentFlag, resolveEnvironment } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { promptsOf } from "../deps";
import { cancelled } from "./prompts";

/** Help text of `--env <name>`. */
export const ENV_DESCRIPTION =
  "The app's environment to act on, for example staging (default: the only one; with several, a terminal asks and a script must name it)";

/** Adds `--env <name>` to `command`. */
export function addEnvOption(command: Command): Command {
  return command.option("--env <name>", ENV_DESCRIPTION);
}

/** The environment a command acts on, and how the commands it suggests name it. */
export interface ChosenEnvironment {
  name: string;
  /**
   * ` --env <name>` while the app has several environments (a script must then name it), else
   * empty: added to every `opscrew …` command the run suggests.
   */
  flag: string;
}

/**
 * The environment of this run (`--env`, agents' `resolveEnvironment`): `requested`, else the only
 * one, else (with several) the one the user picks in a terminal; a script gets the names and
 * `--env`. Cancelling the choice changes nothing.
 */
export async function chooseEnvironment(
  ctx: CliContext,
  requested: string | undefined,
  command: string,
): Promise<ChosenEnvironment> {
  const prompts = promptsOf(ctx);
  const name = await resolveEnvironment(ctx.cwd, requested?.trim() || undefined, {
    ...(ctx.isInteractive
      ? {
          choose: async (names) => {
            const answer = await prompts.select({
              message: "Which environment is this for?",
              options: names.map((value) => ({ value, label: value })),
            });
            if (prompts.isCancel(answer)) throw cancelled("the choice", `opscrew ${command}`);
            return answer;
          },
        }
      : {}),
  });
  return { name, flag: await environmentFlag(ctx.cwd, name) };
}
