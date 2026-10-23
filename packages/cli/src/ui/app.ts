import { appFlag, FIRST_APP, resolveApp } from "@opscrew/agents";
import type { RepositoryApp } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { promptsOf } from "../deps";
import { cancelled } from "./prompts";

/** Help text of `--app <key>`. */
export const APP_DESCRIPTION =
  "The repository's app to act on: a key `opscrew app add` gave, or `.` for the first app (default: the only one; with several, a terminal asks and a script must name it)";

/** Adds `--app <key>` to `command`. */
export function addAppOption(command: Command): Command {
  return command.option("--app <key>", APP_DESCRIPTION);
}

/** The app a command acts on, and how the commands it suggests name it. */
export interface ChosenApp {
  /** A further app's key; `undefined` for the repository's first app. */
  key: string | undefined;
  /**
   * ` --app <key>` for a further app, ` --app .` for the first app beside further apps, else
   * empty: added to every `opscrew …` command the run suggests.
   */
  flag: string;
}

/** How the choice of app shows `app`: `the first app (sites/landing)`, `docs (sites/docs)`. */
export function appLabel(app: RepositoryApp): string {
  return `${app.key ?? "the first app"} (${app.dir})`;
}

/**
 * The further app's key of this run (`--app`, agents' `resolveApp`): `requested` (`.` is the first
 * app), else the only one, else (with several) the one the user picks in a terminal; a script gets
 * the apps and `--app`. Cancelling the choice changes nothing.
 */
export async function resolveCliApp(
  ctx: CliContext,
  requested: string | undefined,
  command: string,
): Promise<string | undefined> {
  const prompts = promptsOf(ctx);
  return resolveApp(ctx.cwd, requested?.trim() || undefined, {
    ...(ctx.isInteractive
      ? {
          choose: async (apps) => {
            const answer = await prompts.select({
              message: "Which app is this for?",
              options: apps.map((app) => ({ value: app.key ?? FIRST_APP, label: appLabel(app) })),
            });
            if (prompts.isCancel(answer)) throw cancelled("the choice", `opscrew ${command}`);
            return answer;
          },
        }
      : {}),
  });
}

/** {@link resolveCliApp} with the app's ` --app <key>` for the commands the run suggests. */
export async function chooseApp(
  ctx: CliContext,
  requested: string | undefined,
  command: string,
): Promise<ChosenApp> {
  const key = await resolveCliApp(ctx, requested, command);
  return { key, flag: await appFlag(ctx.cwd, key) };
}
