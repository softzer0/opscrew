import { listText, OpsCrewError } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type Move,
  type PlanService,
  REDIS_PROTOCOL_KINDS,
} from "@opscrew/plan-schema";
import { downtimeMinutes, sizeText } from "../retarget/texts";
import { hasDeployment } from "../shared/server-address";

/** `server db` or `the app's server`. */
function serverWords(server: string): string {
  return server === APP_SERVER ? "the app's server" : `server ${server}`;
}

/** `db (PostgreSQL)`. */
function serviceWords(service: Pick<PlanService, "name" | "kind">): string {
  return `${service.name} (${serviceSpec(service.kind).title})`;
}

/** What `opscrew provision` does for a move, and how to finish it. */
const FINISH =
  "`opscrew provision` moves it; afterwards `opscrew provision --finish-move` removes the old copy, after you type the service's name";

/**
 * Where each enabled service of the deployed app runs now: `deployment.placement`, which provision
 * writes after a deploy succeeds. A deployment that has none was made before placement existed, so
 * every service runs on the app's server. `undefined` before the first deployment: nothing runs
 * yet, so nothing moves.
 */
function runningOn(previous: DeployPlan | undefined): Record<string, string> | undefined {
  if (previous === undefined) return undefined;
  const { placement } = previous.deployment;
  if (placement !== undefined) return placement;
  if (!hasDeployment(previous)) return undefined;
  return Object.fromEntries(
    previous.services.filter((s) => s.enabled).map((s) => [s.name, APP_SERVER]),
  );
}

/** {@link designMove}'s result. */
export interface DesignedMove {
  /** The move to make (or the one in progress), for `plan.move`. */
  move?: Move;
  /** The services' warnings: an engine that starts empty. */
  warnings: string[];
}

/**
 * The move a placement asks for (FR-1809). With the app deployed ({@link runningOn}), a service
 * whose `server` differs from where it runs moves there: Postgres's data is copied (`dump`), and
 * Valkey, Redis and Dragonfly start empty (`empty`, with the warning about queued jobs). A move in
 * progress (`current`) is kept while the plan still asks for it.
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any change: another kind's move on a live app
 * (until 022), a second move while one is in progress or asked for at once, and a server that
 * would go away while it still holds a moving service's data.
 */
export function designMove(
  plan: Pick<DeployPlan, "services" | "servers">,
  previous: DeployPlan | undefined,
  current: Move | undefined,
): DesignedMove {
  const where = runningOn(previous);
  const moved = plan.services.filter((service) => {
    const now = where?.[service.name];
    return service.enabled && now !== undefined && now !== (service.server ?? APP_SERVER);
  });
  if (current !== undefined) {
    const others = moved.filter(
      (s) => s.name !== current.service || (s.server ?? APP_SERVER) !== current.to,
    );
    const same = plan.services.find((s) => s.name === current.service);
    if (others.length > 0 || (same !== undefined && (same.server ?? APP_SERVER) !== current.to)) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${current.service} is moving from ${serverWords(current.from)} to ${serverWords(current.to)}, and OpsCrew moves one service at a time. plan.yaml was not changed.`,
        {
          hint: `Set services[].server of ${current.service} to ${current.to === APP_SERVER ? "nothing (the app's server)" : current.to}, and the other services' as they run now, finish the move with \`opscrew provision\`, then change it.`,
        },
      );
    }
    requireServerKept(plan, current.from, current.service);
    return { move: current, warnings: [] };
  }
  const [first, ...rest] = moved;
  if (first === undefined) return { warnings: [] };
  if (rest.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `plan.yaml moves ${listText(moved.map((s) => s.name))} to other servers at once, and OpsCrew moves one service at a time. plan.yaml was not changed.`,
      {
        hint: `Move ${first.name} first (keep the others' services[].server as they were): run \`opscrew design\`, then ${FINISH}. Then move the next one.`,
      },
    );
  }
  const from = where?.[first.name] ?? APP_SERVER;
  const to = first.server ?? APP_SERVER;
  const service = serviceWords(first);
  if (
    first.kind !== "postgres" &&
    !(REDIS_PROTOCOL_KINDS as readonly string[]).includes(first.kind)
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${service} runs on ${serverWords(from)} with its data, and OpsCrew cannot move its data to ${serverWords(to)} yet: only Postgres's data is copied, and Valkey, Redis and Dragonfly start empty. Moving the others comes with retargeting anywhere (feature 022). plan.yaml was not changed.`,
      {
        hint: `Keep ${first.name} on ${serverWords(from)} (services[].server as it was). A service the app has not deployed yet can be placed on any server.`,
      },
    );
  }
  requireServerKept(plan, from, first.name);
  const copy = first.kind === "postgres" ? "dump" : "empty";
  const move: Move = { service: first.name, from, to, step: "started", copy };
  if (copy === "dump") return { move, warnings: [] };
  return {
    move,
    warnings: [
      `${service} starts empty on ${serverWords(to)}: what it holds on ${serverWords(from)} is not copied, so jobs waiting in it are lost. Let the queue drain before \`opscrew provision\`.`,
    ],
  };
}

/**
 * Stops when the next provision would replace (another location or provider) a server the move
 * leaves or goes to, `replaced`: the move's copy needs both servers as they are.
 */
export function requireMoveServersKept(move: Move, replaced: ReadonlySet<string>): void {
  const server = [move.to, move.from].find((name) => replaced.has(name));
  if (server === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${move.service} moves from ${serverWords(move.from)} to ${serverWords(move.to)}, and the next \`opscrew provision\` would also replace ${serverWords(server)} (another location or provider). OpsCrew does one at a time. plan.yaml was not changed.`,
    {
      hint: `Do one, run \`opscrew provision\`, then the other: keep ${serverWords(server)} where it runs now for the move (${server === APP_SERVER ? "`opscrew design --option <id>` with an option in its location" : "servers[].target.location as it was"}), or put services[].server of ${move.service} back and change the server first.`,
    },
  );
}

/** Stops when the server a move leaves would go away while it still holds the old copy. */
function requireServerKept(plan: Pick<DeployPlan, "servers">, from: string, service: string): void {
  if (from === APP_SERVER || (plan.servers ?? []).some((s) => s.name === from)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Server ${from} still holds ${service}'s data, which moves away from it, so it must stay in servers until the move is finished. plan.yaml was not changed.`,
    {
      hint: `Put server ${from} back in servers in opscrew/plan.yaml, then ${FINISH}. Remove the server afterwards.`,
    },
  );
}

/**
 * What a move's maintenance window looks like (FR-1809): for a copy, its length from the
 * database's size (`size.bytes`, as retarget estimates it), or that it is measured when the window
 * starts when the size could not be read (`unknown`, the reason); for an engine that starts empty,
 * the switch alone. After the switch, where the old copy waits.
 */
export function moveLine(
  move: Move,
  service: Pick<PlanService, "name" | "kind">,
  size: { bytes: number } | { unknown: string } | undefined,
): string {
  if (move.step === "switched") {
    return `${serviceWords(service)} runs on ${serverWords(move.to)} now. Its old copy stays, stopped, on ${serverWords(move.from)} until \`opscrew provision --finish-move\` removes it, after you type the service's name.`;
  }
  const what = `Moving ${serviceWords(service)} from ${serverWords(move.from)} to ${serverWords(move.to)}`;
  const keep = `Any failure starts the app again on the old copy, which stays, stopped, on ${serverWords(move.from)} until \`opscrew provision --finish-move\`.`;
  if (move.copy === "empty") {
    return `${what} needs a short maintenance window: the app stops, starts against the new, empty ${service.name}, and is checked. ${keep}`;
  }
  if (size === undefined || "unknown" in size) {
    const why = size === undefined ? "" : ` (${size.unknown})`;
    return `${what} needs a maintenance window: the app stops, the data is copied, and the app starts against ${serverWords(move.to)}. OpsCrew could not read the database's size${why}, so \`opscrew provision\` measures it and shows the window's length before it starts. ${keep}`;
  }
  return `${what} needs a maintenance window of about ${downtimeMinutes(size.bytes)} minutes for the database's ${sizeText(size.bytes)}: the app stops, the data is copied, and the app starts against ${serverWords(move.to)}. ${keep}`;
}
