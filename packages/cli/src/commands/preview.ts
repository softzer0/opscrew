import { destroyPreview, listPreviews, previewListLines, previewLogs } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import { FlagConfirmation } from "../approval";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { quietReporter } from "../reporter";
import { type AppEnvFlags, addEnvOption, chooseEnvironment } from "../ui/environment";
import { ON_HOSTING_INSTEAD, requireServer } from "../ui/hosting";

interface ListFlags extends AppEnvFlags {
  json?: boolean;
}

interface DestroyFlags extends AppEnvFlags {
  /** `--confirm pr-<n>`: the typed confirmation, in a script. */
  confirm?: string;
}

/**
 * The deps and plan of the preview environment this run names (`--app`, `--env`), with
 * `phase`'s reporter or approval wrapper, and the deploy user's shell (fakes in tests).
 */
async function previewRun(
  ctx: CliContext,
  flags: AppEnvFlags,
  command: string,
  phase: Pick<
    NonNullable<Parameters<typeof createPhaseDeps>[1]>,
    "reporter" | "wrapApprovals"
  > = {},
) {
  const { app, name } = await chooseEnvironment(ctx, flags, command);
  const deps = createPhaseDeps(ctx, { ai: false, app, environment: name, ...phase });
  const plan = await readArtifact("plan", deps.paths.files.plan);
  requireServer(plan, `\`opscrew ${command}\``, ON_HOSTING_INSTEAD.previews);
  const services = servicesOf(ctx).provision;
  return { deps, plan, options: services === undefined ? {} : { services } };
}

/**
 * `opscrew preview list|logs|destroy` (FR-2219, spec.md US6): the previews of a preview
 * environment, from this computer through the preview server's own command, with no SSH by hand.
 * `list` and `logs` are read-only; `destroy <n>` removes one preview with its data after `pr-<n>`
 * is typed (`--confirm pr-<n>` in a script). Every line passes through the redactor; the server's
 * address is never shown.
 */
export function register(program: Command, ctx: CliContext): void {
  const preview = program
    .command("preview")
    .description(
      "List a preview environment's previews, read one's logs or remove one (one preview per pull request)",
    );
  const listing = preview
    .command("list")
    .description(
      "List the previews on the preview server: pull request, address, state, commit and age (read-only)",
    )
    .option("--json", "Print the previews as JSON");
  addEnvOption(listing).action(async (flags: ListFlags) => {
    const json = flags.json === true;
    const { deps, plan, options } = await previewRun(
      ctx,
      flags,
      "preview list",
      json ? { reporter: quietReporter(ctx.reporter) } : {},
    );
    const list = await listPreviews(deps, plan, options);
    ctx.stdout(
      `${json ? JSON.stringify(list, null, 2) : previewListLines(list, deps.clock.now()).join("\n")}\n`,
    );
  });
  const logs = preview
    .command("logs")
    .description("Show the latest lines of each of a preview's containers (read-only)")
    .argument("<n>", "The pull request's number, for example 42 for pr-42");
  addEnvOption(logs).action(async (number: string, flags: AppEnvFlags) => {
    const { deps, plan, options } = await previewRun(ctx, flags, "preview logs");
    const lines = await previewLogs(deps, plan, number.trim(), options);
    if (lines.length > 0) ctx.stdout(`${lines.join("\n")}\n`);
  });
  const destroying = preview
    .command("destroy")
    .description(
      "Remove one preview with its data, as if its pull request closed; a new push creates it again, empty",
    )
    .argument("<n>", "The pull request's number, for example 42 for pr-42")
    .option("--confirm <pr-n>", "pr-<n>, to remove it without a prompt (scripts)");
  addEnvOption(destroying).action(async (number: string, flags: DestroyFlags) => {
    const confirm = flags.confirm?.trim();
    const { deps, plan, options } = await previewRun(ctx, flags, "preview destroy", {
      wrapApprovals: (base, clock) =>
        new FlagConfirmation(base, {
          kinds: ["remote-exec"],
          what: "removing a preview with its data",
          names: confirm === undefined ? [] : [confirm],
          hashes: [],
          interactive: ctx.isInteractive,
          print: ctx.stdout,
          clock,
        }),
    });
    await destroyPreview(deps, plan, number.trim(), options);
  });
}
