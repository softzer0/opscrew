import { commandFlags, resolveEnvironment } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { promptsOf } from "../deps";
import { addAppOption, resolveCliApp } from "./app";
import { cancelled } from "./prompts";

/** Help text of `--env <name>`. */
export const ENV_DESCRIPTION =
  "The app's environment to act on, for example staging (default: the only one; with several, a terminal asks and a script must name it)";

/** `--app <key>` and `--env <name>`, as commander parses them. */
export interface AppEnvFlags {
  app?: string;
  env?: string;
}

/** Adds `--app <key>` and `--env <name>` to `command`: an environment is always an app's. */
export function addEnvOption(command: Command): Command {
  return addAppOption(command).option("--env <name>", ENV_DESCRIPTION);
}

/** The app and environment a command acts on, and how the commands it suggests name them. */
export interface ChosenEnvironment {
  /** A further app's key; `undefined` for the repository's first app. */
  app: string | undefined;
  name: string;
  /**
   * The app's ` --app <key>` (` --app .` for the first app beside further apps), then
   * ` --env <name>` while the app has several environments (a script must then name them), else
   * empty: added to every `opscrew …` command the run suggests.
   */
  flag: string;
}

/**
 * The app (`--app`, see `resolveCliApp`) and environment of this run (`--env`, agents'
 * `resolveEnvironment`): each as requested, else the only one, else (with several) the one the
 * user picks in a terminal; a script gets the names and the flag. Cancelling a choice changes
 * nothing.
 */
export async function chooseEnvironment(
  ctx: CliContext,
  flags: AppEnvFlags,
  command: string,
): Promise<ChosenEnvironment> {
  const app = await resolveCliApp(ctx, flags.app, command);
  const prompts = promptsOf(ctx);
  const name = await resolveEnvironment(ctx.cwd, flags.env?.trim() || undefined, {
    app,
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
  return { app, name, flag: await commandFlags(ctx.cwd, name, app) };
}
