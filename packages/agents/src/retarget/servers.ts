import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  readServerAddresses,
  type ServerAddress,
  serverOfProvider,
  updateServerAddresses,
} from "../shared";
import { moveProvider } from "../shared/vps-target";

/**
 * The two servers of a move, from OpsCrew's local state (`.opscrew/server.json`): the server being
 * replaced and the new one, once created. Their addresses are never written to
 * `opscrew/plan.yaml`.
 */
export interface MoveServers {
  /**
   * The server being replaced (`plan.retarget.from`). Always known, except during `--finish`
   * once that server is deleted and this computer lost its record (see {@link oldServer}).
   */
  from?: ServerAddress;
  /** The new server, once created. */
  next?: ServerAddress;
}

/** The error when the old server's address is needed but unknown on this computer. */
export function unknownOldServer(command: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew cannot tell which server is which on this computer: the address of the server being replaced is neither in .opscrew/server.json nor in the infrastructure state, so it cannot continue the move. Nothing was changed.",
    { hint: hintFor(command) },
  );
}

/**
 * The error when the server being replaced and the new server share an address (FR-810): a
 * command meant for one would reach the other, so OpsCrew stops.
 */
export function indistinctServers(command: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew cannot tell which server is which on this computer: the server being replaced and the new server have the same address in .opscrew/server.json or in the infrastructure state, so it cannot continue the move. Nothing was changed.",
    { hint: hintFor(command) },
  );
}

/** True when two servers share their IPv4 or their IPv6 address. */
export function sameAddress(a: ServerAddress, b: ServerAddress): boolean {
  const v6 = (address: ServerAddress) => address.ipv6?.toLowerCase();
  return a.ipv4 === b.ipv4 || (v6(a) !== undefined && v6(a) === v6(b));
}

/**
 * Stops with {@link indistinctServers} when the move's two servers share an address. Call it
 * before any command reaches either server.
 */
export function assertDistinctServers(servers: MoveServers, command: string): void {
  if (servers.from !== undefined && servers.next !== undefined) {
    if (sameAddress(servers.from, servers.next)) throw indistinctServers(command);
  }
}

/** The old server's address; stops with `PHASE_PRECONDITION` when it is unknown, never guessing. */
export function oldServer(session: { servers: MoveServers; command: string }): ServerAddress {
  const from = session.servers.from;
  if (from === undefined) throw unknownOldServer(session.command);
  return from;
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
 * acting on any server, when the old server's address is unknown (unless `oldServerOptional`:
 * `--finish`, where that server may already be deleted) or both servers share an address
 * (FR-810); `ARTIFACT_INVALID` when the local record is damaged.
 */
export async function loadMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  command: string,
  outputs: ReadOutputs,
  options: { oldServerOptional?: boolean } = {},
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
      next ??= serverOfProvider(read, moveProvider(plan.target));
    }
  }
  if (from === undefined && options.oldServerOptional !== true) throw unknownOldServer(command);
  const servers: MoveServers = {
    ...(from !== undefined ? { from } : {}),
    ...(next !== undefined ? { next } : {}),
  };
  assertDistinctServers(servers, command);
  if (
    (from !== undefined && local?.from === undefined) ||
    (next !== undefined && local?.next === undefined)
  ) {
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
