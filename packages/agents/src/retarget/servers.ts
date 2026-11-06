import { OpsCrewError } from "@opscrew/core";
import type { CloudProvider, DeployPlan, DeployTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  readServerAddresses,
  type ServerAddress,
  sameIp,
  serverOfProvider,
  updateServerAddresses,
} from "../shared";
import { moveOf } from "./session";

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
  return (
    sameIp(a.ipv4, b.ipv4) ||
    (a.ipv6 !== undefined && b.ipv6 !== undefined && sameIp(a.ipv6, b.ipv6))
  );
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

/** The cloud provider of a side's target, or `undefined` for the user's own server or Portainer. */
function cloudOf(target: Pick<DeployTarget, "provider">): CloudProvider | undefined {
  return target.provider === "hetzner" || target.provider === "digitalocean"
    ? target.provider
    : undefined;
}

/**
 * The servers of the move recorded in `plan.retarget`. Each address comes from the local state,
 * else, for a cloud side, from the root-module output `servers`, which lists every server module
 * by provider: the side being replaced is `plan.retarget.from.target`'s provider, the new one
 * `plan.target`'s (a move between clouds always changes the provider). The user's own server and
 * Portainer are addresses the move recorded in the local state. Neither the step nor the last
 * applied layout is used to guess which server is which. What was found is recorded again. Stops
 * with `PHASE_PRECONDITION`, before acting on any server, when the old side is reached over SSH
 * and its address is unknown (unless `oldServerOptional`: `--finish`, where that server may
 * already be deleted) or both servers share an address (FR-810); `ARTIFACT_INVALID` when the
 * local record is damaged. A Portainer old side has an address only when the move read it from
 * the app's records on Cloudflare.
 */
export async function loadMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  command: string,
  outputs: ReadOutputs,
  options: { oldServerOptional?: boolean } = {},
): Promise<MoveServers> {
  const move = moveOf({ plan });
  const local = (await readServerAddresses(deps.paths)).retarget;
  let from = local?.from;
  let next = local?.next;
  const oldCloud = cloudOf(move.from.target);
  const newCloud = cloudOf(plan.target);
  if ((from === undefined && oldCloud) || (next === undefined && newCloud)) {
    const read = await outputs().catch(() => undefined);
    if (read !== undefined) {
      if (oldCloud) from ??= serverOfProvider(read, oldCloud);
      if (newCloud) next ??= serverOfProvider(read, newCloud);
    }
  }
  const overSsh = move.from.target.provider !== "portainer";
  if (from === undefined && overSsh && options.oldServerOptional !== true) {
    throw unknownOldServer(command);
  }
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

/**
 * Records the move's servers in the local state, keeping the rest of the move's record (the old
 * side's set-aside connection, `fromOwn` or `fromPortainer`).
 */
export async function recordMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  servers: MoveServers,
): Promise<void> {
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    retarget: { ...current.retarget, ...servers },
  }));
}

/**
 * Records a new move's servers in the local state: its sides' addresses replace any an earlier,
 * unfinished start left, and the old side's set-aside connection stays.
 */
export async function startMoveServers(
  deps: Pick<PhaseDeps, "paths">,
  servers: MoveServers,
): Promise<void> {
  await updateServerAddresses(deps.paths, (current) => {
    const { from: _from, next: _next, ...kept } = current.retarget ?? {};
    return { ...current, retarget: { ...kept, ...servers } };
  });
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
