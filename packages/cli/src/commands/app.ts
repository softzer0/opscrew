import { type AppSummary, addApp, listApps, removeApp } from "@opscrew/agents";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps } from "../deps";
import { resolveCliApp } from "../ui/app";
import { printNextSteps, textTable } from "../ui/output";
import { confirmRemoval } from "../ui/removal";

/** The rows of `opscrew app list`. */
export function appTable(apps: readonly AppSummary[]): string {
  return textTable([
    ["App", "Folder", "Deployed"],
    ...apps.map((app) => [app.key ?? "first app", app.dir, app.deployed ? "yes" : "no"]),
  ]);
}

/**
 * `opscrew app add <key> --dir <folder>`: adds a further app of the repository (its record,
 * `opscrew/apps/<key>/app.yaml`), after agents' checks of the folder and of every name the key
 * gives.
 */
async function add(ctx: CliContext, key: string, dir: string): Promise<void> {
  const app = await addApp(ctx.cwd, key.trim(), dir);
  ctx.stdout(
    `Added the app ${app.key} in ${app.dir} (opscrew/apps/${app.key}/app.yaml). Every command acts on it with \`--app ${app.key}\`.\n`,
  );
  printNextSteps(ctx, [
    `run \`opscrew analyze --app ${app.key}\`, then \`opscrew interview --app ${app.key}\` and \`opscrew design --app ${app.key}\`.`,
  ]);
}

/**
 * `opscrew app remove <key>`: removes a further app's files (agents' `removeApp`: refused for the
 * first app and while the app is deployed). They hold its deploy keys, state passphrases and
 * generated secrets, so a terminal has the key typed back and a script needs `--confirm <key>`.
 */
async function remove(ctx: CliContext, key: string, flags: { confirm?: string }): Promise<void> {
  const app = await resolveCliApp(ctx, key, "app remove");
  const deps = createPhaseDeps(ctx, { ai: false, app });
  // removeApp refuses the first app, a deployed one and one whose GitHub Pages verification
  // record may still be in DNS before it asks.
  await removeApp(deps, {
    confirm: (name) =>
      confirmRemoval(ctx, {
        name,
        confirm: flags.confirm,
        what: "the app's key",
        subject: `the app ${name}`,
        details: `This removes the app ${name}'s files: its record, plans and answers in opscrew/apps/${name}, its infrastructure code and deploy workflows, and what OpsCrew keeps for it on this computer (its deploy keys, state passphrases and generated secrets). Its folder in the repository stays.`,
        again: `opscrew app remove ${name}`,
      }),
  });
}

/**
 * `opscrew app add|list|remove`: the repository's apps (contracts/apps.md "CLI and MCP"). The
 * first app is the repository's own; each further app has its own folder, plans, environments,
 * workflows, secrets, state and approvals, and every command acts on it with `--app <key>`.
 */
export function register(program: Command, ctx: CliContext): void {
  const app = program
    .command("app")
    .description("Add, list or remove the repository's apps, for several apps in one repository");
  app
    .command("add")
    .description(
      "Add a further app of the repository, in its own folder; every command acts on it with --app <key>",
    )
    .argument("<key>", "The app's key, for example docs (lower-case letters, digits, -)")
    .requiredOption("--dir <folder>", "The app's folder in the repository, for example sites/docs")
    .action((key: string, flags: { dir: string }) => add(ctx, key, flags.dir));
  app
    .command("list")
    .description("List the repository's apps: each one's key, folder and whether it is deployed")
    .action(async () => {
      const apps = await listApps(createPhaseDeps(ctx, { ai: false }).paths);
      ctx.stdout(`${appTable(apps)}\n`);
    });
  app
    .command("remove")
    .description(
      "Remove a further app's files (its record, plans, workflows, infrastructure code and local state); refused while it is deployed",
    )
    .argument("<key>", "The app's key")
    .option("--confirm <key>", "The app's key, to remove it without a prompt (scripts)")
    .action((key: string, flags: { confirm?: string }) => remove(ctx, key, flags));
}
