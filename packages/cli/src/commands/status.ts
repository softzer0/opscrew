import {
  buildStatusLines,
  componentStatusReport,
  formatServerAddress,
  type PhaseDeps,
  phaseStatusLines,
  type ServerAddress,
  serverAddress,
  serverAddressesFile,
  supplyChainLines,
  tlsStatusReport,
} from "@opscrew/agents";
import { errorText, isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { type DeployPlan, isServerlessProvider, readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, servicesOf } from "../deps";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { retargetStatusLine } from "../ui/retarget";
import { addHostKeyOption, checkApproveFlags } from "./provision";

interface StatusFlags {
  ip?: boolean;
  hostKey?: string;
  /** `--app <key>`: the repository's app. */
  app?: string;
  /** `--env <name>`: the app's environment. */
  env?: string;
}

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
    const note = `Server address: unknown. ${errorText(error)}`;
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
 * The plan's components and, once the app was deployed, whether each runs (FR-1331): a server
 * the user owns is read with its pinned host key, or `--host-key` on the first connection. With a
 * private network (feature 018), each server's own, then the network's links, devices, grants and
 * public SSH.
 */
async function componentLines(
  ctx: CliContext,
  deps: PhaseDeps,
  plan: DeployPlan,
  hostKey: string | undefined,
): Promise<string[]> {
  const { provision, vpn } = servicesOf(ctx);
  const { lines } = await componentStatusReport(deps, plan, {
    ...(hostKey === undefined ? {} : { hostKey }),
    services: provision ?? {},
    ...(vpn === undefined ? {} : { network: vpn }),
  });
  return ["", ...lines];
}

/**
 * The server's proxy, each certificate OpsCrew manages with its expiry, and the recovery copy's
 * last update, key count and whether it is behind (FR-1462).
 */
async function tlsLines(ctx: CliContext, deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const { verify, provision } = servicesOf(ctx);
  const { lines } = await tlsStatusReport(deps, plan, {
    ...(verify?.tlsConnect !== undefined ? { tlsConnect: verify.tlsConnect } : {}),
    ...(provision !== undefined ? { services: provision } : {}),
  });
  return ["", ...lines];
}

/**
 * `opscrew status`: which phases have run in this project, with their result and time, the
 * image builder and the deploy strategy with their reasons, the supply-chain settings (signing,
 * deploy tags, image retention), the app's components and whether each runs, the server's proxy,
 * the certificates OpsCrew manages with their expiry, the recovery copy's state, the server's
 * address (from OpsCrew's local state; it is never committed) and a `retarget` line while a move
 * to another provider is in progress (from → to, last completed step, the next command).
 * `--ip` prints only the server's IPv4 address, for scripts such as
 * `ssh deploy@$(opscrew status --ip)`.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("status")
    .description(
      "Show which OpsCrew phases have run, the app's components and whether they run on each server, the private network, and where a move between providers stands",
    )
    .option(
      "--ip",
      "Print only the server's IPv4 address (for scripts, e.g. ssh deploy@$(opscrew status --ip))",
    );
  addEnvOption(command);
  addHostKeyOption(command).action(async (flags: StatusFlags) => {
    checkApproveFlags("status", flags);
    const { app, name, flag } = await chooseEnvironment(ctx, flags, "status");
    const deps = createPhaseDeps(ctx, { ai: false, app, environment: name });
    const { paths } = deps;
    // A missing or unreadable plan simply means nothing is deployed and no move is recorded.
    const plan = await readArtifact("plan", paths.files.plan).catch(() => undefined);
    if (flags.ip === true) {
      if (plan !== undefined && isServerlessProvider(plan.target.provider)) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `A site on ${plan.target.provider === "github-pages" ? "GitHub Pages" : "Cloudflare's hosting"} has no server, so it has no server address.`,
          { hint: `Run \`opscrew status${flag}\` to see the version it runs and its domains.` },
        );
      }
      const address = await addressOf(deps, plan);
      if (address === undefined) {
        const record = toPosixRelative(paths.root, serverAddressesFile(paths));
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "OpsCrew does not know the server's address on this computer.",
          {
            hint: `Run \`opscrew status${flag} --ip\` on the computer that ran \`opscrew provision${flag}\` (the address is kept there, in ${record}), or run \`opscrew provision${flag}\` here first.`,
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
    // A site on Cloudflare's hosting or GitHub Pages has no image: its running version instead.
    const imageLines =
      plan === undefined || isServerlessProvider(plan.target.provider)
        ? []
        : [...buildStatusLines(plan), ...supplyChainLines(plan)];
    const buildLines =
      plan === undefined
        ? []
        : [
            "",
            ...imageLines,
            ...(await componentLines(ctx, deps, plan, flags.hostKey?.trim())),
            ...(await tlsLines(ctx, deps, plan)),
          ];
    if (Object.keys(state.phases).length === 0) {
      ctx.stdout("No phases have run yet. Start with `opscrew scan`.\n");
      const extra = [...buildLines, ...serverLines, ...moveLines];
      if (extra.length > 0) ctx.stdout(`${extra.join("\n")}\n`);
      return;
    }
    const lines = [
      `OpsCrew phases in ${paths.root}`,
      "",
      ...phaseStatusLines(state.phases),
      ...buildLines,
      ...serverLines,
      ...moveLines,
    ];
    ctx.stdout(`${lines.join("\n")}\n`);
  });
}
