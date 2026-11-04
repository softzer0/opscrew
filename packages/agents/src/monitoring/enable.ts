/**
 * `opscrew addon enable monitoring`: the self-hosted monitoring written into the plan, after the
 * checks of plan.md 9., with what it costs, takes and keeps. Only the plan changes (FR-2002).
 */
import { type HostFacts, otherActiveApps } from "@opscrew/connector-ssh-host";
import type { ComputeCatalog, Money } from "@opscrew/contracts";
import { formatMoney, listText, OpsCrewError, upperFirst } from "@opscrew/core";
import { edgeMemoryMb, edgeProxy } from "@opscrew/iac-templates";
import {
  ADDON_MEMORY_DEFAULTS,
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  type DeployTarget,
  type ExtraServer,
  MONITORING_SERVER,
  MonitoringSchema,
  type MonitoringSettings,
  monitoringOf,
} from "@opscrew/plan-schema";
import { ADDON_PHASE } from "../addons/settings";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { pricedOffer } from "../design/cost";
import { onAppServer } from "../design/placement";
import { extraCatalogs } from "../design/run";
import {
  type DesignedCloudServer,
  type DesignedServer,
  designCloudServer,
  serverLine,
  sizeExtraServer,
  totalCost,
  withoutServerCost,
} from "../design/servers";
import { OWN_SERVER_MEMORY_TOLERANCE } from "../design/sizing";
import { commandFlags } from "../environments/choice";
import { allocateNetwork, type KeyMaker, type NetworkHostFacts } from "../network";
import { otherServer } from "../network/owner";
import { providerProfile } from "../providers";
import { requireNoMoveInProgress } from "../provision/guard";
import { planFile } from "../runners/words";
import { recordGeneratedEntries } from "../shared/app-secrets";
import {
  appMemoryMb,
  type MemoryLimit,
  memoryHeadroom,
  monitoringLimits,
  SYSTEM_RESERVE_MB,
} from "../shared/memory";
import { writePlanIfChanged } from "../shared/plan-file";
import { hasDeployment, serverWords } from "../shared/server-address";
import { appServers } from "../shared/servers";
import { networkServer, type VpnServices } from "../vpn/servers";
import {
  estimateDisk,
  type FiguresRemote,
  fittingDays,
  type MonitoringEstimate,
  type ReadLoad,
  readLoads,
} from "./estimate";
import { readOwnerPlan, repositoryMonitoring, senderPlans } from "./repository";
import {
  DEFAULT_RETENTION,
  MONITORING_VERSIONS,
  requireMonitoringTarget,
  withMonitoring,
} from "./settings";

const GIB = 1024 ** 3;
/** The app's server runs the stack only from 4 GB of memory (FR-2005). */
const ON_APP_MIN_GB = 4;

/** The services `monitoringEnable` reaches the servers and prices through (fakes in tests). */
export interface MonitoringServices {
  /** The login's shell on a plan's server, by name (default `serverRemote`; Docker through sudo). */
  remote?: FiguresRemote;
  /** Read-only inspection of a server (default the host adapter's `inspectHost`). */
  host?: VpnServices["host"];
  /** Makes the network's key pairs (default Node's x25519). */
  keys?: KeyMaker;
  /** A cloud provider's catalogue for a location (default its live one, else its price list). */
  catalogFor?: (provider: CloudProvider, location: string) => Promise<ComputeCatalog>;
}

/** {@link monitoringEnable}'s options. */
export interface MonitoringEnableOptions {
  /** `app`: the stack on the app's server; `server` (default): on a server of its own. */
  on?: "app" | "server";
  /** A monitoring server of this environment's own, even when the repository has one. */
  newServer?: boolean;
  /** Days figures are kept (1–90), instead of the plan's or 15 (`--metrics-days`). */
  metricsDays?: number;
  /** Days logs are kept (1–30), instead of the plan's or 7 (`--logs-days`). */
  logsDays?: number;
  services?: MonitoringServices;
}

/** The retention's options with their flags (`--metrics-days`, `--logs-days`). */
const RETENTION_FLAGS = { metricsDays: "--metrics-days", logsDays: "--logs-days" } as const;

/** The options given, as the flags that give them again: ` --on app --metrics-days 30`. */
export function enableFlags(options: Omit<MonitoringEnableOptions, "services">): string {
  return [
    options.on === undefined ? "" : ` --on ${options.on}`,
    options.newServer === true ? " --new-server" : "",
    ...(["metricsDays", "logsDays"] as const).map((field) =>
      options[field] === undefined ? "" : ` ${RETENTION_FLAGS[field]} ${options[field]}`,
    ),
  ].join("");
}

/**
 * Stops unless the retention asked for is within the plan's bounds, and this environment keeps
 * its own (a sender's is its owner's).
 */
function requireRetention(options: MonitoringEnableOptions, where: Where): void {
  const fields = (["metricsDays", "logsDays"] as const).filter((f) => options[f] !== undefined);
  for (const field of fields) {
    const bounds = MonitoringSchema.shape.retention.shape[field];
    if (bounds.safeParse(options[field]).success) continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${RETENTION_FLAGS[field]} must be a whole number of days from 1 to ${field === "metricsDays" ? 90 : 30}. Nothing was changed.`,
      { hint: `Run the command again with ${RETENTION_FLAGS[field]} in those bounds.` },
    );
  }
  if (fields.length > 0 && where.kind === "shared") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `This environment sends to the repository's monitoring server, which keeps every environment's figures and logs as long as ${where.owner.plan} says, so ${fields.map((f) => `\`${RETENTION_FLAGS[f]}\``).join(" and ")} can't be set here. Nothing was changed.`,
      {
        hint: `Leave ${fields.length === 1 ? "it" : "them"} out, or change the retention in the environment of ${where.owner.plan} with this command there.`,
      },
    );
  }
}

/** A change to the plan's monitoring: only the plan is written. */
export interface MonitoringChange {
  /** The plan with the change. */
  plan: DeployPlan;
  /** What changes, with the price, memory, retention, disk and licences, in plain words. */
  summary: string;
}

type Where = MonitoringSettings["where"];
type CloudTarget = Extract<DeployTarget | ExtraServer["target"], { serverType: string }>;

/** True for a server OpsCrew creates (it has a type at a provider). */
function isCloud(target: DeployTarget | ExtraServer["target"]): target is CloudTarget {
  return target.provider === "hetzner" || target.provider === "digitalocean";
}

/** The target of `plan`'s server `name`. */
function targetOf(plan: DeployPlan, name: string): DeployTarget | ExtraServer["target"] {
  if (name === APP_SERVER) return plan.target;
  return ((plan.servers ?? []).find((server) => server.name === name) as ExtraServer).target;
}

/** One of the plan's servers as the checks see it: its memory and price. */
interface Room {
  name: string;
  serverMb: number;
  /** A server OpsCrew created: its monthly price (server, address and backups). */
  monthly?: Money;
  /** Its type, at a provider. */
  cloud?: { target: CloudTarget; catalog: ComputeCatalog; memoryGb: number };
  /** A server the user owns: what inspection read. */
  facts?: HostFacts;
}

/** The memory and price of the server `name` with `target` (facts for one the user owns). */
async function roomOf(
  name: string,
  target: DeployTarget | ExtraServer["target"],
  facts: HostFacts | undefined,
  catalogFor: NonNullable<MonitoringServices["catalogFor"]>,
): Promise<Room> {
  if (!isCloud(target)) {
    const found = facts as HostFacts;
    return { name, serverMb: found.memoryBytes / 1024 ** 2, facts: found };
  }
  const { provider, location, serverType } = target;
  const catalog = await catalogFor(provider, location);
  const offer = (await catalog.listOffers(location)).find(
    (o) => o.id === serverType && o.location === location,
  );
  if (offer === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew can't find the type ${serverType} of ${serverWords(name)} in ${location}, so it can't check its memory for monitoring. Nothing was changed.`,
      { hint: "Run `opscrew design` to check the plan's servers, then run this command again." },
    );
  }
  const { cost } = pricedOffer(offer, await catalog.extras(location), {
    backups: target.backups,
    backupPercent: providerProfile(provider).backupPercent,
  });
  return {
    name,
    serverMb: offer.memoryGb * 1024,
    monthly: cost.monthly,
    cloud: { target, catalog, memoryGb: offer.memoryGb },
  };
}

/** `the app's server (cx23)`, `server data (your own)`. */
function roomWords(room: Room): string {
  const what = room.cloud !== undefined ? room.cloud.target.serverType : "your own";
  return `${serverWords(room.name)} (${what}, ${(room.serverMb / 1024).toFixed(1)} GB of memory)`;
}

/** What else holds `room`'s memory: the other OpsCrew apps on a server the user owns. */
function othersMb(room: Room, app: string): number {
  return otherActiveApps(room.facts?.apps ?? [], app).reduce(
    (sum, other) => sum + other.memoryMb,
    0,
  );
}

/** The cheapest type at `room`'s provider and location whose memory holds `needMb` and the system. */
async function largerType(room: Room, needMb: number): Promise<string | undefined> {
  if (room.cloud === undefined) return undefined;
  const { catalog, target } = room.cloud;
  const offer = await sizeExtraServer(catalog, target.location, [], 0, [
    { name: "all", memoryMb: needMb },
  ]);
  return offer?.id;
}

/**
 * What the server `room` holds with monitoring on (`draft`): its containers' limits with
 * monitoring's, the edge on the app's server, the other apps on the user's own.
 */
function loadOf(draft: DeployPlan, room: Room): { limitsMb: number; edgeMb: number } {
  if (room.name === APP_SERVER) {
    return {
      limitsMb: appMemoryMb(onAppServer(draft)) + othersMb(room, draft.app.name),
      edgeMb: edgeMemoryMb(edgeProxy(draft)),
    };
  }
  const services = draft.services.filter((s) => s.enabled && s.server === room.name);
  const limits = [...services, ...monitoringLimits(draft, room.name)];
  return {
    limitsMb:
      limits.reduce((sum, limit) => sum + limit.memoryMb, 0) + othersMb(room, draft.app.name),
    edgeMb: 0,
  };
}

/**
 * Stops unless `room` holds monitoring's containers (`added`) next to everything else on it, naming
 * a type that would at a provider.
 */
async function requireRoom(draft: DeployPlan, room: Room, added: readonly MemoryLimit[]) {
  const { limitsMb, edgeMb } = loadOf(draft, room);
  if (memoryHeadroom(room.serverMb, limitsMb, edgeMb).fits) return;
  const larger = await largerType(room, limitsMb + edgeMb);
  const addedMb = added.reduce((sum, limit) => sum + limit.memoryMb, 0);
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${upperFirst(roomWords(room))} has no room for ${listText(added.map((l) => l.name))} (${addedMb} MB): its containers' memory limits would come to ${limitsMb + edgeMb} MB, and the system keeps ${SYSTEM_RESERVE_MB} MB. Nothing was changed.`,
    {
      hint:
        room.cloud === undefined
          ? "Add memory to the server, or lower a memory limit in opscrew/plan.yaml, then run this command again."
          : `Give it a larger type${larger === undefined ? "" : `, such as ${larger}`} (${room.name === APP_SERVER ? "`opscrew design` lists them" : `servers[].target.serverType in opscrew/plan.yaml, then \`opscrew design\``}), or lower a memory limit in opscrew/plan.yaml, then run this command again.`,
    },
  );
}

/** The stack's server as the summary and the estimate see it. */
interface StackServer {
  /** Its line: provider, type, location and price, or the user's own server. */
  line: string;
  /** In a sentence: `server monitoring`, `the app's server`. */
  words: string;
  /** Its disk in GB (free disk on a server that holds more than the stack). */
  diskGb: number;
  vcpus: number;
  /** This plan's own (`where.kind` "server"): its entry, size and price for the plan. */
  designed?: DesignedServer;
}

/**
 * The monitoring settings: the retention asked for, else kept from the plan's, else the defaults;
 * a sender's versions and retention its owner's (`copied`).
 */
function settingsFor(
  plan: DeployPlan,
  where: Where,
  asked: Pick<MonitoringEnableOptions, "metricsDays" | "logsDays">,
  copied?: Pick<MonitoringSettings, "versions" | "retention">,
): MonitoringSettings {
  const current = plan.observability?.monitoring;
  const grafana = plan.observability?.grafanaCloud;
  return {
    enabled: true,
    where,
    versions: copied?.versions ?? {
      ...MONITORING_VERSIONS,
      // One Alloy sends to both: Grafana Cloud's pinned version.
      ...(grafana?.enabled === true ? { alloy: grafana.version } : {}),
    },
    retention: copied?.retention ?? {
      metricsDays:
        asked.metricsDays ?? current?.retention.metricsDays ?? DEFAULT_RETENTION.metricsDays,
      logsDays: asked.logsDays ?? current?.retention.logsDays ?? DEFAULT_RETENTION.logsDays,
      metricsMaxGb: 1,
    },
    memoryMb: current?.memoryMb ?? { ...ADDON_MEMORY_DEFAULTS.monitoring },
  };
}

/** Where the stack goes: kept when monitoring is on, else as asked, else the repository's server. */
async function chooseWhere(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: MonitoringEnableOptions,
  flag: string,
): Promise<Where> {
  if (options.on === "app" && options.newServer === true) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "`--on app` runs the stack on the app's server and `--new-server` gives it a server of its own, so OpsCrew can't do both. Nothing was changed.",
      { hint: "Run the command again with one of them." },
    );
  }
  const current = monitoringOf(plan)?.where;
  if (current !== undefined) {
    const moved =
      (options.on === "app" && current.kind !== "app") ||
      (options.on === "server" && current.kind === "app") ||
      (options.newServer === true && current.kind !== "server");
    if (moved) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `Monitoring is already on, ${current.kind === "app" ? "on the app's server" : current.kind === "server" ? `on server ${current.server}` : `sending to server ${current.owner.server} of ${current.owner.plan}`}, and OpsCrew doesn't move it in place. Nothing was changed.`,
        {
          hint: `Turn it off with \`opscrew addon disable monitoring${flag}\` and \`opscrew provision${flag}\` first, then run this command again.`,
        },
      );
    }
    return current;
  }
  if (options.on === "app") return { kind: "app" };
  const repository = options.newServer === true ? undefined : await repositoryMonitoring(deps);
  if (repository !== undefined) return { kind: "shared", owner: repository };
  return { kind: "server", server: MONITORING_SERVER };
}

/**
 * The user's own servers of `plan`, inspected read-only: a server runs one Alloy (and one stack),
 * so another app's there stops it (as a second Grafana Cloud agent is refused).
 */
async function inspectOwnServers(
  deps: PhaseDeps,
  plan: DeployPlan,
  where: Where,
  services: MonitoringServices,
): Promise<Record<string, HostFacts>> {
  const facts: Record<string, HostFacts> = {};
  for (const name of appServers(plan)) {
    if (isCloud(targetOf(plan, name))) continue;
    const server = await networkServer(deps, plan, name, inspection(services, plan), ADDON_PHASE);
    const addons = server.facts.record?.addons;
    const stack =
      (where.kind === "app" && name === APP_SERVER) ||
      (where.kind === "server" && where.server === name);
    const owner = [addons?.alloy, stack ? addons?.monitoring : undefined].find(
      (app) => app !== undefined && app !== plan.app.name,
    );
    if (owner !== undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${upperFirst(serverWords(name))} is your own, and its monitoring already belongs to the app "${owner}": a server runs one Grafana Alloy${stack ? " and one monitoring stack" : ""}, so OpsCrew doesn't turn monitoring on for a second app there. Nothing was changed.`,
        {
          hint: `Turn monitoring and Grafana Cloud off in the project of "${owner}" first, or run this app on a server of its own, then run this command again.`,
        },
      );
    }
    facts[name] = server.facts;
  }
  return facts;
}

/** `services`' shell and inspection for `plan`'s servers, as `networkServer` takes them. */
function inspection(
  services: MonitoringServices,
  plan: DeployPlan,
): Pick<VpnServices, "remote" | "host"> {
  const { remote, host } = services;
  return {
    ...(remote === undefined ? {} : { remote: (name: string) => remote(name, plan) }),
    ...(host === undefined ? {} : { host }),
  };
}

/** A server the user owns as design shows it, from what inspection read. */
function ownServerOf(entry: ExtraServer, facts: HostFacts): DesignedServer {
  return {
    server: entry,
    services: [],
    vcpus: Math.max(1, facts.cpus),
    memoryGb: Math.floor((facts.memoryBytes / GIB) * 10) / 10,
    warnings: [],
  };
}

/** A server OpsCrew creates for the stack alone (in `plan`), sized and priced through design's code. */
function designStackServer(
  plan: DeployPlan,
  name: string,
  target: Exclude<ExtraServer["target"], { provider: "own" }> | undefined,
  backups: boolean,
  catalogFor: NonNullable<MonitoringServices["catalogFor"]>,
): Promise<DesignedCloudServer> {
  return designCloudServer({
    name,
    target,
    services: [],
    addons: monitoringLimits(plan, name),
    app: plan.target,
    region: undefined,
    backups,
    catalogFor,
  });
}

/** The stack's server `designed`, as `words` say it, with `diskGb` of disk. */
function stackOf(designed: DesignedServer, words: string, diskGb: number): StackServer {
  return { line: serverLine(designed), words, diskGb, vcpus: designed.vcpus };
}

/**
 * The stack's own server of this plan (`where.kind` "server"): a server OpsCrew creates sized for
 * the stack and priced through design's code (its type kept when the plan sets one), or one the
 * user owns checked against what inspection read.
 */
async function ownStackServer(
  draft: DeployPlan,
  name: string,
  facts: Record<string, HostFacts>,
  catalogFor: NonNullable<MonitoringServices["catalogFor"]>,
  command: string,
): Promise<StackServer & { designed: DesignedServer }> {
  const entry = draft.servers?.find((server) => server.name === name);
  const words = `server ${name}`;
  if (entry !== undefined && !isCloud(entry.target)) {
    const room = await roomOf(name, entry.target, facts[name], catalogFor);
    await requireRoom(draft, room, monitoringLimits(draft, name));
    const found = room.facts as HostFacts;
    const designed = ownServerOf(entry, found);
    return { ...stackOf(designed, words, found.diskFreeBytes / GIB), designed };
  }
  if (entry === undefined && !isCloud(draft.target)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew puts the monitoring server at the app's provider and location, and this app runs on your own server, which has neither. Nothing was changed.",
      {
        hint: `Run \`${command} --on app\` to run the stack on your server (it needs at least ${ON_APP_MIN_GB} GB of memory).`,
      },
    );
  }
  const designed = await designStackServer(
    draft,
    name,
    entry?.target as Exclude<ExtraServer["target"], { provider: "own" }> | undefined,
    false,
    catalogFor,
  );
  return { ...stackOf(designed, words, designed.diskGb), designed };
}

/**
 * The repository's monitoring server this plan sends to (`where.kind` "shared"), inspected
 * read-only through its owner's server record (for the network's port), and priced as its owner's
 * design prices it.
 */
async function sharedStackServer(
  deps: PhaseDeps,
  owner: { plan: string; server: string },
  ownerPlan: DeployPlan,
  services: MonitoringServices,
  catalogFor: NonNullable<MonitoringServices["catalogFor"]>,
): Promise<StackServer & { facts: HostFacts }> {
  const paths = appPaths(deps.paths, ownerPlan.app.key, ownerPlan.environment?.name);
  const { facts } = await networkServer(
    { ...deps, paths },
    ownerPlan,
    owner.server,
    inspection(services, ownerPlan),
    ADDON_PHASE,
  );
  const entry = ownerPlan.servers?.find((server) => server.name === owner.server) as ExtraServer;
  const words = otherServer(owner);
  if (!isCloud(entry.target)) {
    return { ...stackOf(ownServerOf(entry, facts), words, facts.diskFreeBytes / GIB), facts };
  }
  const designed = await designStackServer(
    ownerPlan,
    owner.server,
    entry.target,
    entry.target.backups,
    catalogFor,
  );
  return { ...stackOf(designed, words, designed.diskGb), facts };
}

/** `draft` with monitoring's settings set to `where` (not yet checked by the schema). */
function withWhere(draft: DeployPlan, where: Where): DeployPlan {
  const monitoring = draft.observability?.monitoring as MonitoringSettings;
  return {
    ...draft,
    observability: { ...draft.observability, monitoring: { ...monitoring, where } },
  };
}

/**
 * Stops unless the app's server (`room`) has 4 GB and the stack's limits fit next to the app's
 * (FR-2005), naming the type that would, and the price of a monitoring server of its own.
 */
async function requireOnApp(
  draft: DeployPlan,
  room: Room,
  catalogFor: NonNullable<MonitoringServices["catalogFor"]>,
  flag: string,
): Promise<void> {
  const { limitsMb, edgeMb } = loadOf(draft, room);
  const minMb = ON_APP_MIN_GB * 1024;
  const large =
    (room.cloud?.memoryGb ?? room.serverMb / 1024) * 1024 >=
    minMb * (room.cloud === undefined ? OWN_SERVER_MEMORY_TOLERANCE : 1);
  const fits = memoryHeadroom(room.serverMb, limitsMb, edgeMb).fits;
  if (large && fits) return;
  const needMb = Math.max(minMb - SYSTEM_RESERVE_MB, limitsMb + edgeMb);
  const larger = await largerType(room, needMb);
  let own = "";
  if (isCloud(draft.target)) {
    const server = withWhere(draft, { kind: "server", server: MONITORING_SERVER });
    const designed = await designStackServer(
      server,
      MONITORING_SERVER,
      undefined,
      false,
      catalogFor,
    );
    own = ` (a ${designed.server.target.serverType} at ${formatMoney(designed.cost.monthly)}/month)`;
  }
  const why = large
    ? `with the stack its containers' memory limits would come to ${limitsMb + edgeMb} MB, which doesn't fit beside the system's ${SYSTEM_RESERVE_MB} MB`
    : `it has less than ${ON_APP_MIN_GB} GB`;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The monitoring stack runs on the app's server only when it has at least ${ON_APP_MIN_GB} GB of memory and the stack's limits fit next to the app's. ${upperFirst(roomWords(room))}: ${why}. Nothing was changed.`,
    {
      hint: `Run \`opscrew addon enable monitoring${flag}\` without \`--on app\` for a monitoring server of its own${own}, or move the app to a larger server${larger === undefined ? "" : `, such as ${larger},`} with \`opscrew design\`.`,
    },
  );
}

/** `2.4 GB`, or `less than 0.1 GB`. */
function gb(value: number): string {
  return value < 0.1 ? "less than 0.1 GB" : `${value.toFixed(1)} GB`;
}

/** `about 2.4 GB`, or `less than 0.1 GB`. */
function about(value: number): string {
  return value < 0.1 ? gb(value) : `about ${gb(value)}`;
}

/**
 * Where the refusal of a retention that doesn't fit sends the user: the command with
 * `--logs-days`/`--metrics-days` on a first enable (`command`), else the plan file holding the
 * retention (`file`: this plan's, or a sender's owner's).
 */
interface RetentionAdvice {
  file: string;
  command?: (field: keyof typeof RETENTION_FLAGS, days: number) => string;
}

/**
 * The refusal of a retention whose estimate passes 80% of the disk (FR-2020), naming the longest
 * retention that fits and a type with more disk for a server OpsCrew creates.
 */
async function tooLarge(
  estimate: MonitoringEstimate,
  loads: readonly ReadLoad[],
  retention: MonitoringSettings["retention"],
  stack: StackServer,
  addons: readonly MemoryLimit[],
  catalogFor: NonNullable<MonitoringServices["catalogFor"]>,
  advice: RetentionAdvice,
): Promise<OpsCrewError> {
  const { diskGb } = estimate;
  const fitting = (["logsDays", "metricsDays"] as const).flatMap((field) => {
    const days = fittingDays(loads, retention, diskGb, field);
    return days === undefined ? [] : [{ field, days }];
  });
  let larger: string | undefined;
  const target = stack.designed?.server.target;
  if (target !== undefined && isCloud(target)) {
    const catalog = await catalogFor(target.provider, target.location);
    const needDisk = Math.ceil((estimate.figuresGb + estimate.logsGb) / 0.8);
    larger = (await sizeExtraServer(catalog, target.location, [], needDisk, addons))?.id;
  }
  const { command, file } = advice;
  const more =
    larger === undefined
      ? undefined
      : `give ${stack.words} a type with more disk, such as ${larger} (servers[].target.serverType in ${file})`;
  let hint: string;
  if (command !== undefined) {
    // Monitoring is not in the plan yet: the command's flags set the retention.
    const shorter = fitting.map((f) => `\`${command(f.field, f.days)}\``);
    hint = [
      shorter.length === 0
        ? "Free up disk on it, then run this command again."
        : `Keep them for less time: run ${shorter.join(" or ")}.`,
      ...(more === undefined ? [] : [`Once monitoring is in the plan, you can also ${more}.`]),
    ].join(" ");
  } else {
    const what = { logsDays: "logs", metricsDays: "figures" } as const;
    const shorter = fitting.map((f) => `${what[f.field]} ${f.days} days (retention.${f.field})`);
    const choices = [
      ...(shorter.length === 0
        ? []
        : [`keep ${shorter.join(" or ")} in observability.monitoring of ${file}`]),
      ...(more === undefined ? [] : [more]),
    ];
    hint = `${upperFirst(choices.join(", or ") || "free up disk on it")}, then run this command again.`;
  }
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `Keeping figures ${retention.metricsDays} days and logs ${retention.logsDays} days would take about ${gb(estimate.figuresGb + estimate.logsGb)} of the ${gb(diskGb)} disk on ${stack.words}, more than 80% of it. Nothing was changed.`,
    { hint },
  );
}

/** What the summary says, besides the plan. */
interface SummaryInput {
  after: DeployPlan;
  stack: StackServer;
  rooms: readonly Room[];
  estimate: MonitoringEstimate;
  logBytes24h: number;
  servers: number;
  /** The network was created, or the monitoring server joined it. */
  network: "created" | "joined" | undefined;
  /** This plan's file. */
  file: string;
  /** The other plans' files that got the stack's settings too (the owner's, senders' copies). */
  copies: readonly string[];
  flag: string;
}

/**
 * What turning monitoring on does, in plain words (FR-2001): the server and its price, what runs
 * on it, Alloy's memory and price share on each server, the retention and its disk, where the data
 * stays, the licences, who sees the dashboards of a shared server, and the next step.
 */
function summaryText(input: SummaryInput): string {
  const { after, stack, estimate } = input;
  const settings = monitoringOf(after) as MonitoringSettings;
  const { where, retention } = settings;
  const alloyMb = settings.memoryMb.alloy + settings.memoryMb.proxy;
  const share = (mb: number, room: Pick<Room, "monthly" | "serverMb">) =>
    room.monthly === undefined
      ? ""
      : ` (${formatMoney({ amount: (room.monthly.amount * mb) / room.serverMb, currency: room.monthly.currency })}/month of its price)`;
  // The stack's own server isn't among the rooms: its memory and price are its design's.
  const rooms: Pick<Room, "name" | "serverMb" | "monthly">[] = [
    ...input.rooms,
    ...(where.kind === "server"
      ? [
          {
            name: where.server,
            serverMb: (stack.designed?.memoryGb ?? 0) * 1024,
            monthly: stack.designed?.cost?.monthly,
          },
        ]
      : []),
  ];
  const lines: string[] = [];
  if (where.kind === "shared") {
    lines.push(
      `This environment sends its figures and logs to the repository's monitoring server, ${stack.words}, which already keeps every environment's; no new server. ${stack.line}`,
      `A device on any of ${stack.words}'s private networks sees every environment's dashboards, this one's too.`,
    );
  } else {
    lines.push(
      where.kind === "app"
        ? "The monitoring stack runs on the app's server; no new server."
        : `The monitoring stack runs on a server of its own. ${stack.line}`,
      "It keeps the figures in Prometheus and the logs in Loki, and shows them in Grafana's dashboards; a front takes only what your servers send. None of it is public.",
    );
    const server = where.kind === "app" ? APP_SERVER : where.server;
    const stackLimits = monitoringLimits(after, server).filter((l) => l.name !== "Grafana Alloy");
    const room = rooms.find((r) => r.name === server) as (typeof rooms)[number];
    lines.push(
      `The stack's memory limits on ${serverWords(server)}: ${stackLimits.map((l) => `${l.name} ${l.memoryMb} MB${share(l.memoryMb, room)}`).join(", ")}.`,
    );
  }
  const alloy = rooms.map((room) => `${serverWords(room.name)}${share(alloyMb, room)}`);
  lines.push(
    `Grafana Alloy collects them, with its Docker proxy, in ${alloyMb} MB of memory on each of this environment's servers: ${listText(alloy)}.`,
    `Figures are kept ${retention.metricsDays} days (at most ${retention.metricsMaxGb} GB) and logs ${retention.logsDays} days: ${about(estimate.figuresGb + estimate.logsGb)} of the ${gb(estimate.diskGb)} disk on ${stack.words} (${estimate.series.toLocaleString("en-US")} series and ${gb(input.logBytes24h / GIB)} of logs a day from ${input.servers} servers).`,
    "The figures and logs stay on your own servers: nothing goes to Grafana Labs or anyone else.",
    "Grafana and Loki are licensed AGPL-3.0; OpsCrew runs them unmodified, as containers.",
  );
  if (input.network === "created") {
    lines.push(
      `The private network ${after.network?.range} is created for it, with ${listText((after.network?.members ?? []).map((m) => serverWords(m.name)))} as its members.`,
    );
  } else if (input.network === "joined") {
    lines.push(`${upperFirst(stack.words)} joins this environment's private network.`);
  }
  const { copies } = input;
  if (copies.length > 0) {
    lines.push(
      `Every environment that sends to ${stack.words} keeps the same settings, so ${listText(copies)} ${copies.length === 1 ? "gets" : "get"} them too: figures ${retention.metricsDays} days (at most ${retention.metricsMaxGb} GB) and logs ${retention.logsDays} days.`,
    );
  }
  lines.push(
    `Only ${listText([input.file, ...copies])} changed: run \`opscrew provision${input.flag}\` to set it up, each change shown for your approval.`,
  );
  return lines.join("\n");
}

/**
 * `opscrew addon enable monitoring` (FR-2001–FR-2007): writes `observability.monitoring` into the
 * plan, and nothing else (no server, account or repository changes; provision applies it).
 * - Refused before any change: a target without a server; a move in progress; no deployment;
 *   `--on app` with `--new-server`; moving monitoring that is on; another app's monitoring on one
 *   of the user's own servers; a server without room for Alloy; `--on app` below 4 GB or not
 *   fitting; a retention estimated above 80% of the disk.
 * - Where: kept when on; `--on app`; else the repository's monitoring server (`shared`, its
 *   versions and retention copied) unless `--new-server`; else a server `monitoring` at the app's
 *   provider and location, sized for the stack and priced through design's code (one the user owns,
 *   set in the plan, is checked against its memory instead).
 * - The network: created when absent, the monitoring server a member (a shared one's interface is
 *   allocated from its facts); new members' private keys go to the generated values.
 * - The retention: the days asked for (`metricsDays`, `logsDays`), else the plan's, else 15 and 7;
 *   a sender's is its owner's. One that doesn't fit is refused naming what does: the flags on a
 *   first enable, the plan's fields after it.
 * - The estimate: every sending server read once, `retention.metricsMaxGb` from it (a sender
 *   keeps its owner's, or lowers it when they all need less).
 * - The other plans of the stack whose versions or retention now differ (the owner's, the senders'
 *   copies) get this plan's too, so every copy stays its owner's.
 * @returns the plan written and the summary.
 */
export async function monitoringEnable(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: MonitoringEnableOptions = {},
): Promise<MonitoringChange> {
  const services = options.services ?? {};
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const command = `opscrew addon enable monitoring${flag}`;
  requireMonitoringTarget(plan, command);
  requireNoMoveInProgress(plan);
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "There is no deployment to monitor yet. Nothing was changed.",
      { hint: `Run \`opscrew provision${flag}\` first, then run this command again.` },
    );
  }
  const where = await chooseWhere(deps, plan, options, flag);
  requireRetention(options, where);
  const catalogFor =
    services.catalogFor ?? extraCatalogs(deps, undefined, (text) => deps.reporter.warn(text));
  const ownFacts = await inspectOwnServers(deps, plan, where, services);
  const ownerPlan =
    where.kind === "shared"
      ? await readOwnerPlan(deps, where.owner, "Nothing was changed.")
      : undefined;
  const copied = ownerPlan === undefined ? undefined : monitoringOf(ownerPlan);
  let draft: DeployPlan = {
    ...plan,
    observability: {
      ...plan.observability,
      monitoring: settingsFor(plan, where, options, copied),
    },
  };
  let stack: StackServer | undefined;
  const networkFacts: Record<string, NetworkHostFacts> = { ...ownFacts };
  if (where.kind === "server") {
    const own = await ownStackServer(draft, where.server, ownFacts, catalogFor, command);
    const servers = draft.servers ?? [];
    const kept = servers.some((s) => s.name === where.server);
    draft = {
      ...draft,
      servers: kept
        ? servers.map((s) => (s.name === where.server ? own.designed.server : s))
        : [...servers, own.designed.server],
    };
    stack = own;
  } else if (where.kind === "shared") {
    const shared = await sharedStackServer(
      deps,
      where.owner,
      ownerPlan as DeployPlan,
      services,
      catalogFor,
    );
    // Its interface on this environment's network takes a port its facts show free.
    networkFacts[where.owner.server] = shared.facts;
    stack = shared;
  }
  // Room for Alloy (and on the app's server, with `--on app`, the stack) on every server.
  const rooms: Room[] = [];
  for (const name of appServers(draft)) {
    if (where.kind === "server" && name === where.server) continue;
    const room = await roomOf(name, targetOf(draft, name), ownFacts[name], catalogFor);
    rooms.push(room);
    if (where.kind === "app" && name === APP_SERVER) {
      await requireOnApp(draft, room, catalogFor, flag);
    } else {
      await requireRoom(draft, room, monitoringLimits(draft, name));
    }
  }
  const allocated =
    where.kind === "app" ? undefined : allocateNetwork(draft, networkFacts, services.keys);
  // The estimate: every environment that sends to the stack, this one as it will be.
  const others = (await senderPlans(deps, ownerPlan ?? draft)).filter(
    (other) => planFile(other) !== planFile(plan),
  );
  const plans = ownerPlan === undefined ? [draft, ...others] : [ownerPlan, ...others, draft];
  const loads = await readLoads(deps, plans, stack?.vcpus ?? 0, services.remote);
  if (stack === undefined) {
    const app = loads.find((load) => load.plan === draft && load.server === APP_SERVER)
      ?.figures as NonNullable<ReadLoad["figures"]>;
    stack = { line: "", words: "the app's server", diskGb: app.diskFreeGb, vcpus: app.cpus };
  }
  const settings = draft.observability?.monitoring as MonitoringSettings;
  const estimate = estimateDisk(loads, settings.retention, stack.diskGb);
  if (!estimate.fits) {
    const addons = where.kind === "server" ? monitoringLimits(draft, where.server) : [];
    const first = monitoringOf(plan) === undefined && where.kind !== "shared";
    // The command again, with the retention that fits for `field` and the other as given.
    const again = (field: keyof typeof RETENTION_FLAGS, days: number) =>
      `${command}${enableFlags({ ...options, [field]: days })}`;
    const advice: RetentionAdvice = {
      file: where.kind === "shared" ? where.owner.plan : planFile(plan),
      ...(first ? { command: again } : {}),
    };
    throw await tooLarge(estimate, loads, settings.retention, stack, addons, catalogFor, advice);
  }
  // A sender keeps its owner's cap, unless all of them together need a lower one.
  const metricsMaxGb =
    where.kind === "shared"
      ? Math.min(settings.retention.metricsMaxGb, estimate.metricsMaxGb)
      : estimate.metricsMaxGb;
  const final = { ...settings, retention: { ...settings.retention, metricsMaxGb } };
  // The stack runs with its owner's settings, which every sender copies: the other plans whose
  // settings now differ get them too (the owner's cap a sender lowered, the senders' copies).
  const copies = (ownerPlan === undefined ? others : [ownerPlan, ...others]).flatMap((other) => {
    const kept = monitoringOf(other) as MonitoringSettings;
    const same = JSON.stringify([kept.versions, kept.retention]);
    if (same === JSON.stringify([final.versions, final.retention])) return [];
    return [
      withMonitoring(other, { ...kept, versions: final.versions, retention: final.retention }),
    ];
  });
  const { designed } = stack;
  const after = withMonitoring(plan, final, {
    servers: draft.servers,
    network: allocated?.network ?? plan.network,
    cost:
      designed === undefined
        ? plan.cost
        : totalCost(withoutServerCost(plan.cost, designed.server.name), [designed]),
  });
  const keys = allocated?.privateKeys ?? {};
  if (Object.keys(keys).length > 0) {
    for (const key of Object.values(keys)) deps.redactor.addLiteral(key, "network-key");
    await recordGeneratedEntries(deps, "network", keys);
  }
  await writePlanIfChanged(deps, after);
  for (const copy of copies) {
    const paths = appPaths(deps.paths, copy.app.key, copy.environment?.name);
    await writePlanIfChanged({ paths, clock: deps.clock }, copy);
  }
  const joined =
    plan.network !== undefined &&
    (after.network?.members.length ?? 0) > plan.network.members.length;
  return {
    plan: after,
    summary: summaryText({
      after,
      stack,
      rooms,
      estimate,
      logBytes24h: loads.reduce((sum, load) => sum + load.logBytes24h, 0),
      servers: loads.length,
      network:
        plan.network === undefined && after.network !== undefined
          ? "created"
          : joined
            ? "joined"
            : undefined,
      file: planFile(plan),
      copies: copies.map(planFile),
      flag,
    }),
  };
}
