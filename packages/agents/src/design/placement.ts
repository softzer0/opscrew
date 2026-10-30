import type { ComputeCatalog, Money } from "@opscrew/contracts";
import { formatMoney, OpsCrewError } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type CloudProvider,
  type CostEstimate,
  type DeployPlan,
  DeployPlanSchema,
  type DeployTarget,
  type DesignOption,
  type ExtraServer,
  type Move,
  type PlanService,
  type Requirements,
  servicesOn,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  allocateNetwork,
  hasPublicAddress,
  type KeyMaker,
  type NetworkHostFacts,
} from "../network";
import { databaseSize, serverOps } from "../retarget/server-ops";
import { reasonOf } from "../shared/errors";
import { serverRemote } from "../shared/server-address";
import { memoryText, serverMemoryText } from "./components";
import { convertMoney, EXCHANGE_RATE_NOTE } from "./cost";
import { type HopDelay, hopDelay, type ServerPlace } from "./delay";
import { designMove, moveLine, requireMoveServersKept } from "./moves";
import { designOwnServer, type OwnServersOptions } from "./own-servers";
import { hasPlacement, type PlacementEdits } from "./placement-edits";
import { withServerThreads } from "./plan";
import {
  appServerChange,
  extraServerChanges,
  extraServerChangeWarning,
  replacedServers,
} from "./server-changes";
import {
  type DesignedServer,
  designCloudServer,
  serverLine,
  totalCost,
  totalLine,
} from "./servers";

/** Where a server is, for the delay estimate. */
function placeOf(target: DeployTarget | ExtraServer["target"]): ServerPlace {
  return target.provider === "hetzner" || target.provider === "digitalocean"
    ? { provider: target.provider, location: target.location }
    : { provider: "own" };
}

/** Automated backups for a new extra server: the app server's setting, or on. */
function appBackups(target: DeployTarget): boolean {
  return "backups" in target ? target.backups : true;
}

/** How design places services on other servers, besides the phase's deps. */
export interface PlacementOptions extends OwnServersOptions {
  /** Makes the network's key pairs (default Node's x25519; tests pass a deterministic one). */
  keys?: KeyMaker;
}

/** {@link designPlacement}'s input. */
export interface PlacementInput {
  /** The designed plan, without its placement (`readPlanWithEdits`). */
  plan: DeployPlan;
  /** The placement as the user wrote it. */
  edits: PlacementEdits;
  /** The plan being replaced: its deployment says where the services run now. */
  previous: DeployPlan | undefined;
  requirements: Pick<Requirements, "region" | "dataCriticality" | "budgetMonthly">;
  /** The app's server as chosen: its size and price. */
  chosen: DesignOption;
  /** The memory of the app server's edge (MB). */
  edgeMb: number;
  /** The catalogue of a cloud provider, read for a server in `location`. */
  catalogFor: (provider: CloudProvider, location: string) => Promise<ComputeCatalog>;
  /** The app's server when the user owns it: its WireGuard interfaces and UDP ports in use. */
  appNetwork?: NetworkHostFacts;
}

/** {@link designPlacement}'s result. */
export interface DesignedPlacement {
  /** The plan with its servers, each service's server, the network, a move and the total cost. */
  plan: DeployPlan;
  /** The new network members' private keys, by member, for the generated values. */
  privateKeys: Record<string, string>;
  /** Each server with its size, price and memory, the total, each hop's delay and what moves. */
  lines: string[];
  warnings: string[];
}

/** The app's server's part of the plan: its own services only. */
export function onAppServer<T extends Pick<DeployPlan, "services">>(plan: T): T {
  return { ...plan, services: servicesOn(plan, APP_SERVER) };
}

/**
 * The plan's placement, as design completes it from the user's edits (feature 018, FR-1801–1803,
 * FR-1809, FR-1818):
 * - each extra server kept from the edits: one OpsCrew creates gets the app server's provider and
 *   location and the smallest type that holds its services, unless the user set them, and its
 *   price; one the user owns is reached and inspected as an own app server is;
 * - the move a changed `services[].server` asks for on a deployed app;
 * - the private network, allocated or kept, its members following the servers;
 * - the cost: one line per server, and the total, with a warning over the budget;
 * - a warning for each deployed extra server the next provision replaces or resizes.
 *
 * Its lines show each server (provider, location, size, price, its services' memory), the total,
 * each hop's estimated delay, which services have no login, and a move's maintenance window. A
 * plan without placement comes back as it is.
 * @throws OpsCrewError, before plan.yaml changes, for what cannot be placed (see
 * `designCloudServer`, `designOwnServer`, `designMove`, `requireMoveServersKept`) and a plan the
 * schema refuses.
 */
export async function designPlacement(
  deps: PhaseDeps,
  input: PlacementInput,
  options: PlacementOptions = {},
): Promise<DesignedPlacement> {
  const { edits } = input;
  const base = input.plan;
  if (!hasPlacement(edits)) {
    // A service the deployment runs on another server still can't lose it unnoticed.
    designMove({ services: base.services, servers: [] }, input.previous, undefined);
    return { plan: base, privateKeys: {}, lines: [], warnings: [] };
  }
  const services = base.services.map((service) => {
    const server = edits.placed[service.name];
    return server === undefined ? service : { ...service, server };
  });
  const on = (server: string) => servicesOn({ services }, server);
  const warnings: string[] = [];
  const designed: DesignedServer[] = [];
  const facts: Record<string, NetworkHostFacts> = {};
  if (input.appNetwork !== undefined) facts[APP_SERVER] = input.appNetwork;
  const appPublic = hasPublicAddress(base, APP_SERVER);
  for (const edited of edits.servers) {
    const placed = on(edited.name);
    if (edited.target?.provider === "own") {
      const own = await designOwnServer(
        deps,
        { name: edited.name, services: placed, app: base.app.name, appPublic },
        options,
      );
      facts[edited.name] = own.facts;
      designed.push(own);
      continue;
    }
    designed.push(
      await designCloudServer({
        name: edited.name,
        target: edited.target,
        services: placed,
        app: base.target,
        region: input.requirements.region,
        backups: input.requirements.dataCriticality !== "none",
        catalogFor: input.catalogFor,
      }),
    );
  }
  for (const server of designed) warnings.push(...server.warnings);
  const servers = designed.map((d) => d.server);
  const moved = designMove({ services, servers }, input.previous, edits.move);
  warnings.push(...moved.warnings);
  // What the next provision replaces or resizes: said for an extra server, as for the app's, and
  // never in the same provision as a move between them.
  const changes = await extraServerChanges(deps.paths.root, input.previous, {
    servers,
    infra: base.infra,
  });
  for (const [name, change] of changes) warnings.push(extraServerChangeWarning(name, change));
  if (moved.move !== undefined) {
    const replaced = replacedServers(appServerChange(input.previous, base), changes);
    requireMoveServersKept(moved.move, replaced);
  }
  const allocated =
    servers.length > 0 || edits.network !== undefined
      ? allocateNetwork(
          { ...base, servers, ...(edits.network === undefined ? {} : { network: edits.network }) },
          facts,
          options.keys,
        )
      : undefined;
  // Dragonfly's threads follow the vCPUs of the server it runs on.
  const threaded = designed.reduce(
    (all, { server, vcpus }) => withServerThreads(all, vcpus, (s) => s.server === server.name),
    services,
  );
  const parsed = DeployPlanSchema.safeParse({
    ...base,
    services: threaded,
    ...(servers.length === 0 ? {} : { servers }),
    ...(allocated === undefined ? {} : { network: allocated.network }),
    ...(moved.move === undefined ? {} : { move: moved.move }),
    cost: totalCost(base.cost, designed),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew cannot place the services as opscrew/plan.yaml asks: ${issue?.path.join(".") || "plan"} ${issue?.message ?? "is not valid"}. plan.yaml was not changed.`,
      { hint: "Fix the field shown above in opscrew/plan.yaml, then run `opscrew design` again." },
    );
  }
  const plan = parsed.data;
  if (servers.length > 0) {
    const over = overBudget(plan.cost, input.requirements.budgetMonthly, servers.length + 1);
    if (over !== undefined) warnings.push(over);
  }
  const lines = [
    ...(servers.length === 0 ? [] : serverLines(plan, input, designed)),
    ...hopLines(plan, designed, warnings),
    ...(await moveLines(deps, plan, moved.move)),
  ];
  return { plan, privateKeys: allocated?.privateKeys ?? {}, lines, warnings };
}

/**
 * The warning when the app's `count` servers cost more than the interview's budget, compared in
 * the budget's currency at the fixed rate, as design compares one server's options.
 */
function overBudget(total: CostEstimate, budget: Money, count: number): string | undefined {
  const inBudget = convertMoney(total.monthly, budget.currency);
  if (inBudget.amount <= budget.amount) return undefined;
  const cross = total.monthly.currency !== budget.currency;
  const about = cross ? ` (about ${formatMoney(inBudget)})` : "";
  const rate = cross ? ` ${EXCHANGE_RATE_NOTE}` : "";
  return `The app's ${count} servers cost ${formatMoney(total.monthly)}/month together${about}, over your budget of ${formatMoney(budget)}/month.${rate} Raise the budget with \`opscrew interview\`, or keep more services on the app's server.`;
}

/** Each server with its size, price and its services' memory, then the total. */
function serverLines(
  plan: DeployPlan,
  input: Pick<PlacementInput, "chosen" | "edgeMb">,
  designed: readonly DesignedServer[],
): string[] {
  const { target, cost } = input.chosen;
  const provider =
    target.provider === "hetzner" || target.provider === "digitalocean"
      ? target.provider
      : undefined;
  const cloud = provider !== undefined;
  const app: DesignedServer = {
    server: {
      name: APP_SERVER,
      target:
        provider !== undefined
          ? {
              provider,
              mode: "vps-compose",
              location: target.location,
              serverType: target.serverType,
              backups: input.chosen.backups,
            }
          : {
              provider: "own",
              mode: "vps-compose",
              arch: target.architecture === "arm" ? "arm64" : "amd64",
            },
    },
    services: [],
    vcpus: target.vcpus,
    memoryGb: target.memoryGb,
    warnings: [],
    ...(cloud ? { cost } : {}),
  };
  const serverMb = target.memoryGb * 1024;
  return [
    serverLine(app),
    memoryText(
      onAppServer(plan),
      serverMb,
      input.edgeMb,
      cloud ? cost.monthly : undefined,
      APP_SERVER,
    ),
    ...designed.flatMap((server) => [
      serverLine(server),
      serverMemoryText(
        server.server.name,
        server.services,
        server.memoryGb * 1024,
        server.cost?.monthly,
      ),
    ]),
    totalLine(plan.cost, designed),
  ];
}

/**
 * The estimated delay of each hop from the app's server to the services on another server
 * (warnings above the threshold go to `warnings`), and for each service there without a login
 * (Kafka, Redpanda, OpenSearch) that only the app's servers reach it.
 */
function hopLines(
  plan: DeployPlan,
  designed: readonly DesignedServer[],
  warnings: string[],
): string[] {
  const app = placeOf(plan.target);
  return designed.flatMap(({ server, services }) => {
    if (services.length === 0) return [];
    const delay = hopDelay(
      app,
      server.name,
      placeOf(server.target),
      services.map((s) => s.name),
    );
    if (delay.warning !== undefined) warnings.push(delay.warning);
    return [delay.text, ...services.flatMap((service) => noLoginLine(service, server.name))];
  });
}

/** For a service without a login on another server: who reaches it, and how. */
function noLoginLine(service: PlanService, server: string): string[] {
  const spec = serviceSpec(service.kind);
  if (spec.auth !== "internal-only") return [];
  return [
    `${spec.title} (${service.name}) on server ${server} has no login: only the app's servers reach it, through the private network, and no device can be given access to it.`,
  ];
}

/**
 * A move's maintenance window: before the switch, a copy of Postgres reads the database's size over
 * SSH on the server it leaves, as `opscrew retarget` does; a size that cannot be read is said, and
 * provision measures it.
 */
async function moveLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  move: Move | undefined,
): Promise<string[]> {
  if (move === undefined) return [];
  const service = plan.services.find((s) => s.name === move.service) as PlanService;
  if (move.copy === "empty" || move.step === "switched") {
    return [moveLine(move, service, undefined)];
  }
  let size: { bytes: number } | { unknown: string };
  try {
    const from = move.from === APP_SERVER ? "the app's server" : `server ${move.from}`;
    deps.reporter.step(`Measuring ${move.service}'s database on ${from}`);
    const remote = await serverRemote(deps, plan, move.from);
    size = { bytes: await databaseSize(remote, serverOps(plan, deps.redactor)) };
  } catch (error) {
    size = { unknown: deps.redactor.redact(reasonOf(error)) };
  }
  return [moveLine(move, service, size)];
}

/** {@link placementEstimate}'s input. */
export interface PlacementEstimateInput {
  /** The app's plan: its server, services and cost. */
  plan: DeployPlan;
  /** The service to place. */
  service: string;
  /**
   * The server to place it on: one OpsCrew creates (sized for the service alone unless a type is
   * given; backups as the app's server has them unless given), or one the user owns.
   */
  server:
    | { provider: CloudProvider; location: string; serverType?: string; backups?: boolean }
    | { provider: "own" };
  /** The server provider's catalogue, for a server OpsCrew creates. */
  catalog?: ComputeCatalog;
}

/** What placing one service on one server would cost and how much slower each query gets. */
export interface PlacementEstimate {
  /** A server OpsCrew creates: its type, size and monthly price (in its provider's currency). */
  server?: Pick<DesignedServer, "vcpus" | "memoryGb"> & { serverType: string; cost: CostEstimate };
  /** The app's monthly total with that server, in the plan's currency. */
  total: Money;
  /** The hop from the app's server to it. */
  delay: HopDelay;
}

/**
 * The estimate for one service of `plan` on one server (for the MCP server's `placement_estimate`,
 * read-only): the server's type, size and price as design would plan them, the app's monthly
 * total with it, and the estimated delay of each query from the app to it.
 * @throws OpsCrewError `INVALID_INPUT` for a service the plan does not have, or a server type not
 * offered there.
 * @throws Error without the cloud provider's catalogue, or with another provider's.
 */
export async function placementEstimate(input: PlacementEstimateInput): Promise<PlacementEstimate> {
  const { plan, server } = input;
  const service = plan.services.find((s) => s.name === input.service && s.enabled);
  if (service === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The plan has no enabled service named "${input.service}".`,
      {
        hint: `Use one of: ${
          plan.services
            .filter((s) => s.enabled)
            .map((s) => s.name)
            .join(", ") || "none (the plan runs no service)"
        }.`,
      },
    );
  }
  const app = placeOf(plan.target);
  if (server.provider === "own") {
    return {
      total: plan.cost.monthly,
      delay: hopDelay(app, "new", server, [service.name]),
    };
  }
  const { catalog } = input;
  if (catalog?.provider !== server.provider) {
    throw new Error(`The estimate needs the ${server.provider} catalogue.`);
  }
  // Its texts name the server "new": it has no name yet.
  const designed = await designCloudServer({
    name: "new",
    target: server,
    services: [service],
    app: plan.target,
    region: undefined,
    backups: server.backups ?? appBackups(plan.target),
    catalogFor: async () => catalog,
  });
  return {
    server: {
      serverType: designed.server.target.serverType,
      vcpus: designed.vcpus,
      memoryGb: designed.memoryGb,
      cost: designed.cost,
    },
    total: totalCost(plan.cost, [designed]).monthly,
    delay: hopDelay(app, "new", server, [service.name]),
  };
}
