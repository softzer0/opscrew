import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  readServerAddresses,
  type ServerAddress,
  serverOfProvider,
  updateServerAddresses,
} from "../shared";

/**
 * The two servers of a move, from OpsCrew's local state (`.opscrew/server.json`): the server being
 * replaced and the new one, once created. Their addresses are never written to
 * `opscrew/plan.yaml`.
 */
export interface MoveServers {
  /** The server being replaced (`plan.retarget.from`). */
  from: ServerAddress;
  /** The new server, once created. */
  next?: ServerAddress;
}

/** Root-module outputs, read when the local state lacks an address (best effort). */
export type ReadOutputs = () => Promise<Record<string, unknown> | undefined>;

/** Where to get the addresses when this computer does not have them. */
function hintFor(command: string): string {
  return `Run \`${command}\` on the computer that started the move, or copy its .opscrew/server.json (with the .opscrew/tfstate folder) here, then try again.`;
}

/**
 * The servers of the move recorded in `plan.retarget`. Each address comes from the local state,
 * else from the root-module output `servers`, which lists every server by provider: the server
 * being replaced is `plan.retarget.from.target`'s provider, the new one `plan.target`'s (a move
 * always changes the provider). Neither the step nor the last applied layout is used to guess
 * which server is which. What was found is recorded again. Stops with `PHASE_PRECONDITION`, before
 * acting on any server, when the old server's address is unknown; `ARTIFACT_INVALID` when the local
 * record is damaged.
 */
export async function loadMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  command: string,
  outputs: ReadOutputs,
): Promise<MoveServers> {
  const move = plan.retarget;
  if (move === undefined) {
    throw new OpsCrewError("INTERNAL", "No move is recorded in opscrew/plan.yaml.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  const local = (await readServerAddresses(deps.paths)).retarget;
  let from = local?.from;
  let next = local?.next;
  if (from === undefined || next === undefined) {
    const read = await outputs().catch(() => undefined);
    if (read !== undefined) {
      from ??= serverOfProvider(read, move.from.target.provider);
      next ??= serverOfProvider(read, plan.target.provider);
    }
  }
  if (from === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew cannot tell which server is which on this computer: the address of the server being replaced is neither in .opscrew/server.json nor in the infrastructure state, so it cannot continue the move. Nothing was changed.",
      { hint: hintFor(command) },
    );
  }
  const servers: MoveServers = { from, ...(next !== undefined ? { next } : {}) };
  if (local?.from === undefined || (next !== undefined && local.next === undefined)) {
    await recordMoveServers(deps, servers);
  }
  return servers;
}

/**
 * The error when the new server's address is needed but unknown on this computer: OpsCrew stops
 * rather than guess.
 */
export function unknownNewServer(command: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew cannot tell which server is which on this computer: the new server's address is neither in .opscrew/server.json nor in the infrastructure state, so OpsCrew stopped before acting on it.",
    { hint: hintFor(command) },
  );
}

/** Records the move's servers in the local state. */
export async function recordMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  servers: MoveServers,
): Promise<void> {
  await updateServerAddresses(deps.paths, (current) => ({ ...current, retarget: servers }));
}

/**
 * Ends the move in the local state: `deployment` becomes the server that keeps the app (the new
 * one after `--finish`, the old one after `--abort`; unchanged when unknown) and the move's
 * servers are forgotten.
 */
export async function endMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  deployment: ServerAddress | undefined,
): Promise<void> {
  await updateServerAddresses(deps.paths, ({ retarget: _move, ...rest }) =>
    deployment === undefined ? rest : { ...rest, deployment },
  );
}
