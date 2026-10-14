import {
  connectOwnServer,
  inspectOwnServer,
  type OwnServerDesignInput,
  type PhaseDeps,
  runDesign,
} from "@opscrew/agents";
import { type Money, type Requirements, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { deployServicesOf } from "../ui/deploy-services";
import { chooseOption } from "../ui/options";
import { addHostKeyOption, checkApproveFlags } from "./provision";

interface DesignFlags {
  option?: string;
  hostKey?: string;
}

/**
 * A server the user owns: connects with the login the interview recorded (the host key confirmed
 * in the terminal, or `--host-key`, and pinned), inspects it read-only and returns what design
 * needs (architecture, CPUs, memory, free disk, operating system). Design itself never connects.
 */
export async function inspectForDesign(
  ctx: CliContext,
  deps: PhaseDeps,
  hostKey: string | undefined,
): Promise<OwnServerDesignInput> {
  const own = deployServicesOf(ctx).provision?.own ?? {};
  deps.reporter.step("Connecting to your server to read its size (read-only)");
  const session = await connectOwnServer(deps, {
    ...(hostKey === undefined ? {} : { hostKey }),
    ...(own.remote === undefined ? {} : { remote: own.remote }),
    ...(own.homeDir === undefined ? {} : { homeDir: own.homeDir }),
  });
  if (session.pinned) {
    deps.reporter.success(`Pinned your server's SSH host key ${session.hostKey.fingerprint}.`);
  }
  const host = own.host;
  const inspect =
    host?.inspect === undefined
      ? undefined
      : (remote: Parameters<NonNullable<typeof host.inspect>>[0]) => {
          const fake = host as Required<typeof host>;
          return fake.inspect(remote);
        };
  const { server } = await inspectOwnServer(session, inspect === undefined ? {} : { inspect });
  return { facts: server };
}

/**
 * `opscrew design`: prices 2–3 options on the provider chosen in the interview (live when its API
 * token is set, otherwise its dated static price table), lets the user pick one in the terminal (or takes `--option <id>`, or the
 * recommendation when no terminal is available) and writes `opscrew/plan.yaml` (FR-107). For a
 * server the user already owns it first connects and inspects the server (read-only) and offers it
 * as the one option, without a price (FR-913).
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("design")
    .description("Design the production architecture and estimate its monthly cost")
    .option("--option <id>", "Choose this option without asking (ids are listed by the command)");
  addHostKeyOption(command).action(async (flags: DesignFlags) => {
    checkApproveFlags("design", flags);
    const deps = createPhaseDeps(ctx, { ai: false });
    const { catalog } = servicesOf(ctx);
    const optionId = flags.option?.trim() || undefined;
    const interactive = optionId === undefined && ctx.isInteractive;

    const requirements: Requirements | undefined = await readArtifact(
      "requirements",
      deps.paths.files.requirements,
    ).catch(() => undefined);
    const budget: Money | undefined = interactive ? requirements?.budgetMonthly : undefined;
    const ownServer =
      requirements?.provider === "own" && catalog === undefined
        ? await inspectForDesign(ctx, deps, flags.hostKey?.trim())
        : undefined;
    const prompts = promptsOf(ctx);
    const result = await runDesign(deps, {
      ...(optionId === undefined ? {} : { optionId }),
      ...(catalog === undefined ? {} : { catalog }),
      ...(ownServer === undefined ? {} : { ownServer }),
      ...(interactive
        ? {
            choose: (options) =>
              chooseOption(options, {
                prompts,
                write: ctx.stdout,
                ...(budget === undefined ? {} : { budget }),
              }),
          }
        : {}),
    });

    if (optionId === undefined && !interactive) {
      const others = result.options.filter((option) => option.id !== result.chosen.id);
      ctx.stdout(
        `\nChose the recommended option, ${result.chosen.id}.${
          others.length > 0
            ? ` To plan another one, run \`opscrew design --option <id>\` with one of: ${others.map((o) => o.id).join(", ")}.`
            : ""
        }\n`,
      );
    }
    // runDesign itself prints the next step (`opscrew adapt`).
  });
}
