import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  addressFromOutputs,
  readServerAddresses,
  type ServerAddress,
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

/**
 * The servers of the move recorded in `plan.retarget`. Each address comes from the local state;
 * a missing one from the deployment's address (the old server before the switch, the new one
 * after it), else from the root-module outputs (`server_*` follows the server that gets traffic,
 * `other_server_*` the other one). What was found is recorded again. Stops with
 * `PHASE_PRECONDITION` when the old server's address is unknown.
 */
export async function loadMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  command: string,
  outputs?: ReadOutputs,
): Promise<MoveServers> {
  const move = plan.retarget;
  const local = await readServerAddresses(deps.paths);
  const switched = move?.step === "switched";
  const created = move !== undefined && move.step !== "started" && move.step !== "renamed";
  let from = local.retarget?.from ?? (switched ? undefined : local.deployment);
  let next = local.retarget?.next ?? (switched ? local.deployment : undefined);
  if ((from === undefined || (next === undefined && created)) && outputs !== undefined) {
    const read = await outputs().catch(() => undefined);
    if (read !== undefined) {
      const live = addressFromOutputs(read, "server");
      const other = addressFromOutputs(read, "other_server");
      from ??= switched ? other : live;
      next ??= switched ? live : other;
    }
  }
  if (from === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not know the address of the server being replaced on this computer, so it cannot continue the move. Nothing was changed.",
      {
        hint: `Run \`${command}\` on the computer that started the move, or copy its .opscrew/server.json (with the .opscrew/tfstate folder) here, then try again.`,
      },
    );
  }
  const servers: MoveServers = { from, ...(next !== undefined ? { next } : {}) };
  if (
    local.retarget?.from === undefined ||
    (next !== undefined && local.retarget.next === undefined)
  ) {
    await recordMoveServers(deps, servers);
  }
  return servers;
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
