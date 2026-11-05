/**
 * Advise's size rules (feature 021, US3, US4; plan.md "4. The rules"): a container at its memory
 * limit, a server short of memory or CPUs, one far too big, and a filling disk. A type change is
 * priced from the provider's catalogue and says what research R5 (S1) found: the app is offline a
 * while, the addresses stay, and a disk that grows can't shrink again.
 */
import type { ComputeOffer } from "@opscrew/contracts";
import { plural } from "@opscrew/core";
import { edgeMemoryMb, edgeProxy, serviceSpec } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  isServerlessProvider,
  servicesOn,
} from "@opscrew/plan-schema";
import { onAppServer } from "../../design/placement";
import { cheapestServerOffer, extraServerNeed } from "../../design/servers";
import { providerProfile } from "../../providers";
import { appMemoryMb, memoryHeadroom, monitoringLimits } from "../../shared/memory";
import {
  type Basis,
  type PlanChange,
  type Proposal,
  type Readings,
  type Reason,
  type ServerHistory,
  type ServerReadings,
  THRESHOLDS,
} from "../types";
import {
  type CloudServer,
  cloudServers,
  diskFilling,
  historyBasis,
  isPriced,
  otherTypes,
  PLAN,
  type PricedServer,
  percent,
  percentAbove,
  planTargets,
  readingBasis,
  sizeOf,
  typeChange,
} from "./shared";

const GIB = 1024 ** 3;
/** A raised memory limit is a multiple of this many MB. */
const LIMIT_STEP_MB = 64;

/** `4 GB`, `3.9 GB`. */
function gbText(gb: number): string {
  return `${Number(gb.toFixed(1))} GB`;
}

/** `512 MB`. */
function mbText(mb: number): string {
  return `${Math.round(mb)} MB`;
}

/** A share (0–1) of the server, and what it rests on. */
interface Share {
  share: number;
  basis: Basis;
}

/** The server's memory in use: its p95 over the history, else the one reading's. */
function memoryInUse({ now, history }: ServerReadings): Share | undefined {
  if (history?.memoryP95 !== undefined) {
    return { share: history.memoryP95, basis: historyBasis(history) };
  }
  const memory = now.server?.memory;
  if (memory?.usedBytes === undefined) return undefined;
  return { share: memory.usedBytes / memory.totalBytes, basis: readingBasis(now) };
}

/**
 * The load past the server's `cpus` (US3-2): over the history, for `loadHighShare` of the period
 * (then one CPU more at least); else on the reading, the 15-minute load above them (then CPUs for
 * it), with the CPUs it has. Undefined when the load stays under.
 */
function loadAbove(
  { now, history }: ServerReadings,
  cpus: number,
): { reason: Reason; vcpus: number; cpus: number } | undefined {
  const share = history?.loadOverCpus;
  if (history !== undefined && share !== undefined) {
    if (share < THRESHOLDS.loadHighShare) return undefined;
    return {
      reason: {
        text: `The 15-minute load was above the server's ${plural(cpus, "CPU")}`,
        figure: `${percent(share)} of the time`,
        basis: historyBasis(history),
      },
      vcpus: cpus + 1,
      cpus,
    };
  }
  const load = now.server?.load15;
  if (load === undefined || load <= cpus) return undefined;
  return {
    reason: {
      text: `The 15-minute load is above the server's ${plural(cpus, "CPU")}`,
      figure: load.toFixed(2),
      basis: readingBasis(now),
    },
    vcpus: Math.ceil(load),
    cpus,
  };
}

/** A container of the plan on a server: its Compose service, its plan entry, in words. */
interface PlannedContainer {
  service: string;
  container: Extract<PlanChange, { kind: "memory-limit" }>["container"];
  words: string;
  copies: number;
}

/**
 * The plan's containers on `server` that `--apply` can give another memory limit: on the app's,
 * the web process and each enabled worker; on every server, its enabled services. The cron jobs
 * and OpsCrew's own containers are none of them.
 */
function plannedContainers(plan: DeployPlan, server: string): PlannedContainer[] {
  const services = servicesOn(plan, server).map(
    (s): PlannedContainer => ({
      service: s.name,
      container: { kind: "service", name: s.name },
      words: `${serviceSpec(s.kind).title} (${s.name})`,
      copies: 1,
    }),
  );
  if (server !== APP_SERVER) return services;
  return [
    { service: "app", container: { kind: "web" }, words: "the web process", copies: 1 },
    ...plan.processes.workers
      .filter((w) => w.enabled)
      .map(
        (w): PlannedContainer => ({
          service: w.name,
          container: { kind: "worker", name: w.name },
          words: `worker ${w.name}`,
          copies: w.count,
        }),
      ),
    ...services,
  ];
}

/** A container at its limit: its limit now, the one proposed, and why. */
interface AtLimit extends PlannedContainer {
  memoryMb: number;
  /** The memory the higher limit adds on the server, all copies together. */
  raiseGb: number;
  reasons: Reason[];
}

/**
 * `planned` when it reached its limit (`containerAtLimit` of it at its peak, or killed for memory
 * in the period; on one reading, its use now), with the limit `limitRaise` times higher, rounded up
 * to {@link LIMIT_STEP_MB}.
 */
function atLimit(planned: PlannedContainer, { now, history }: ServerReadings): AtLimit | undefined {
  const { service, words } = planned;
  const running = now.containers.filter((c) => c.service === service);
  const past = history?.containers.find((c) => c.service === service);
  const reasons: Reason[] = [];
  let limitBytes: number | undefined;
  if (history !== undefined && (past?.memoryMax !== undefined || past?.oomKills !== undefined)) {
    const basis = historyBasis(history);
    // A server whose figures stopped answers no limit (research R5, S2): the reading has it.
    limitBytes = past.limit ?? running.find((c) => c.memory.limitBytes)?.memory.limitBytes;
    const peak = past.memoryMax === undefined || !limitBytes ? 0 : past.memoryMax / limitBytes;
    if (limitBytes && peak >= THRESHOLDS.containerAtLimit) {
      reasons.push({
        text: `The memory use of ${words} reached its limit`,
        figure: `${percent(peak)} of ${mbText(limitBytes / 1024 ** 2)}`,
        basis,
      });
    }
    const kills = past.oomKills ?? 0;
    if (kills > 0) {
      reasons.push({
        text: `The system stopped ${words} for lack of memory`,
        figure: plural(kills, "time"),
        basis,
      });
    }
  } else {
    const fullest = running
      .flatMap(({ memory: { usedBytes, limitBytes: limit } }) =>
        limit === undefined ? [] : [{ use: usedBytes / limit, limit }],
      )
      .sort((a, b) => b.use - a.use)[0];
    if (fullest !== undefined && fullest.use >= THRESHOLDS.containerAtLimit) {
      limitBytes = fullest.limit;
      reasons.push({
        text: `The memory use of ${words} is at its limit`,
        figure: `${percent(fullest.use)} of ${mbText(limitBytes / 1024 ** 2)}`,
        basis: readingBasis(now),
      });
    }
  }
  if (reasons.length === 0 || !limitBytes) return undefined;
  const limitMb = limitBytes / 1024 ** 2;
  const memoryMb = Math.ceil((limitMb * THRESHOLDS.limitRaise) / LIMIT_STEP_MB) * LIMIT_STEP_MB;
  return { ...planned, memoryMb, raiseGb: ((memoryMb - limitMb) * planned.copies) / 1024, reasons };
}

/** The plan edit giving `limit` its higher limit. */
function limitProposal(server: string, limit: AtLimit, room: Reason): Proposal {
  return {
    id: `size.${server}.${limit.service}-limit`,
    category: "size",
    urgency: "now",
    server,
    title: `Raise the memory limit of ${limit.words} to ${limit.memoryMb} MB`,
    reasons: [...limit.reasons, room],
    apply: {
      kind: "plan",
      change: { kind: "memory-limit", container: limit.container, memoryMb: limit.memoryMb },
    },
  };
}

/** The memory in use above `memoryHigh` of the server's `totalGb`. */
function memoryReason(memory: Share, totalGb: number): Reason {
  const what =
    memory.basis.kind === "history" ? "Memory in use at the 95th percentile" : "Memory in use";
  return {
    text: `${what} is above ${percent(THRESHOLDS.memoryHigh)} of the server`,
    figure: `${percentAbove(memory.share)} of ${gbText(totalGb)}`,
    basis: memory.basis,
  };
}

/** What `memory`'s share of `totalGb` would be on `offer`. */
function memoryOnReason(memory: Share, totalGb: number, offer: ComputeOffer): Reason {
  const share = (memory.share * totalGb) / offer.memoryGb;
  return { text: `On ${offer.id} it would be ${percent(share)}`, basis: PLAN };
}

/** What the size rules know of one server they read. */
interface SizedServer {
  /** The plan's name: `app` or an extra server. */
  name: string;
  /** Its target's provider: a cloud one, `own`, `portainer` or `localhost`. */
  provider: string;
  figures: ServerReadings;
  /** The server OpsCrew created, when it is one. */
  cloud: CloudServer | undefined;
  /** {@link cloud} when the prices list its type. */
  priced: PricedServer | undefined;
  memory: Share | undefined;
  /** Its memory: its type's, else the reading's. */
  totalGb: number | undefined;
}

/**
 * Why OpsCrew doesn't resize `server` that needs `need` (`at least 5 GB of memory and 3 CPUs`),
 * and what the user does instead (US3-3, the edge case "The user's own server"): a server OpsCrew
 * created whose type is the largest, or not in the price list, gets `opscrew design`; the others,
 * a step by hand.
 */
function noLargerType(
  { name, provider, cloud }: SizedServer,
  need: string,
  flags: string,
): { reason: Reason; apply: Proposal["apply"] } {
  const design = `opscrew design${flags}`;
  if (cloud !== undefined) {
    const { displayName } = providerProfile(cloud.provider);
    return {
      reason: {
        text: `No larger type in ${displayName}'s price list for ${cloud.location} holds it: \`${design}\` shows the options`,
        basis: PLAN,
      },
      apply: { kind: "command", command: design },
    };
  }
  const [reason, text] =
    provider === "own"
      ? [
          `OpsCrew can't resize a server you own: give it ${need}, then run \`${design}\` again so the plan knows`,
          `Give server ${name} ${need}, then run \`${design}\``,
        ]
      : provider === "portainer"
        ? [
            `OpsCrew doesn't change the host your Portainer runs on: give it ${need} there`,
            `Give the host your Portainer runs on ${need}`,
          ]
        : [
            `OpsCrew can't change this computer: give Docker ${need} in its settings, or close other programs`,
            `Give Docker on this computer ${need}`,
          ];
  return { reason: { text: reason, basis: PLAN }, apply: { kind: "manual", text } };
}

/** {@link limitRules}'s outcome. */
interface Limits {
  /** A higher limit for each container the server has room for. */
  proposals: Proposal[];
  /** Why the others need a larger server. */
  roomless: Reason[];
  /** The memory in use with the raises that fit, in GB. */
  withRaisesGb: number;
  /** The raises that don't fit, in GB. */
  roomlessGb: number;
}

/**
 * A higher limit for each container of `server` at its limit while the server has room for it,
 * the first ones first; the others' reasons and raises, for a larger server. Where the memory in
 * use can't be read (a Portainer, this computer), every raise, asking the user to check the room.
 */
function limitRules(plan: DeployPlan, server: SizedServer): Limits {
  const { name, figures, memory, totalGb } = server;
  const limits: Limits = {
    proposals: [],
    roomless: [],
    withRaisesGb: memory === undefined || totalGb === undefined ? 0 : memory.share * totalGb,
    roomlessGb: 0,
  };
  for (const planned of plannedContainers(plan, name)) {
    const limit = atLimit(planned, figures);
    if (limit === undefined) continue;
    if (memory === undefined || totalGb === undefined) {
      limits.proposals.push(
        limitProposal(name, limit, {
          text: `OpsCrew can't read the memory in use on this host: check it has ${mbText(limit.raiseGb * 1024)} to spare for the higher limit`,
          basis: PLAN,
        }),
      );
      continue;
    }
    const after = (limits.withRaisesGb + limit.raiseGb) / totalGb;
    if (after <= THRESHOLDS.memoryHigh) {
      limits.withRaisesGb += limit.raiseGb;
      limits.proposals.push(
        limitProposal(name, limit, {
          text: `The server has room for the higher limit: its memory in use plus the raise stays at or under ${percent(THRESHOLDS.memoryHigh)}`,
          figure: `${percent(after)} of ${gbText(totalGb)}`,
          basis: memory.basis,
        }),
      );
    } else {
      limits.roomlessGb += limit.raiseGb;
      limits.roomless.push(...limit.reasons, {
        text: `The server has no room to raise the limit of ${limit.words} to ${limit.memoryMb} MB: its memory in use plus the raise would pass ${percent(THRESHOLDS.memoryHigh)}`,
        figure: `${percentAbove(after)} of ${gbText(totalGb)}`,
        basis: memory.basis,
      });
    }
  }
  return limits;
}

/**
 * A larger server for memory (in use above `memoryHigh`, or the raises it has no room for) or
 * load, holding a filling disk too; without a larger type to move to, what would fit, unpriced.
 */
function largerRule(
  flags: string,
  server: SizedServer,
  { roomless, withRaisesGb, roomlessGb }: Limits,
  filling: ReturnType<typeof diskFilling>,
): Proposal | undefined {
  const { name, figures, memory, totalGb, cloud, priced } = server;
  const current = priced?.prices.offer;
  const short = memory !== undefined && memory.share > THRESHOLDS.memoryHigh ? memory : undefined;
  const memoryNeed = short !== undefined || roomless.length > 0;
  const needGb = withRaisesGb + roomlessGb;
  const id = `size.${name}.larger`;
  const cpus = figures.now.server?.cpus ?? current?.vcpus;
  const load = cpus === undefined ? undefined : loadAbove(figures, cpus);
  if (priced !== undefined && current !== undefined && (memoryNeed || load !== undefined)) {
    // A filling disk grows with the type: the larger type holds what the disk needs too.
    const offer = cheapestServerOffer(
      otherTypes(priced).filter((o) => filling === undefined || o.diskGb > current.diskGb),
      priced.location,
      {
        memoryMb:
          Math.max(current.memoryGb, memoryNeed ? needGb / THRESHOLDS.memoryHigh : 0) * 1024,
        vcpus: Math.max(current.vcpus, load?.vcpus ?? 0),
      },
      filling === undefined ? current.diskGb : diskNeedGb(figures),
    );
    if (offer !== undefined) {
      const reasons = [
        ...(short === undefined
          ? []
          : [
              memoryReason(short, current.memoryGb),
              memoryOnReason(short, current.memoryGb, offer),
            ]),
        ...(load === undefined ? [] : [load.reason]),
        ...roomless,
        ...(filling === undefined ? [] : diskReasons(filling.reasons)),
      ];
      const urgency = roomless.length > 0 || filling?.urgency === "now" ? "now" : "soon";
      return typeChange(priced, offer, { id, category: "size", urgency, reasons });
    }
  }
  const memoryGb =
    memoryNeed && totalGb !== undefined ? Math.ceil(needGb / THRESHOLDS.memoryHigh) : undefined;
  if (memoryGb === undefined && load === undefined) return undefined;
  // No larger type to move to: what would fit, without a price.
  const need = `at least ${[
    ...(memoryGb === undefined ? [] : [`${memoryGb} GB of memory`]),
    ...(load === undefined ? [] : [plural(load.vcpus, "CPU")]),
  ].join(" and ")}`;
  const cpusOnly =
    load !== undefined && memoryGb === undefined
      ? `Server ${name} needs more ${cloud === undefined ? `than its ${plural(load.cpus, "CPU")}` : `CPUs than its ${cloud.serverType} has`}`
      : undefined;
  const why = noLargerType(server, need, flags);
  return {
    id,
    category: "size",
    urgency: roomless.length > 0 ? "now" : "soon",
    server: name,
    title: cpusOnly ?? `Give server ${name} ${need}`,
    reasons: [
      ...(short === undefined || totalGb === undefined ? [] : [memoryReason(short, totalGb)]),
      ...(load === undefined ? [] : [load.reason]),
      ...roomless,
      why.reason,
    ],
    apply: why.apply,
  };
}

/**
 * The size proposals of one server: {@link limitRules}, {@link largerRule}, the disk when no larger
 * type is proposed, and only when none of these, a smaller server (so never while it grows: a
 * priced server short of memory or CPUs always gets a larger proposal).
 */
function serverRules(readings: Readings, server: SizedServer): Proposal[] {
  const { name, figures, priced } = server;
  const limits = limitRules(readings.plan, server);
  const filling = diskFilling(name, figures);
  const larger = largerRule(readings.flags, server, limits, filling);
  const proposals = [...limits.proposals, ...(larger === undefined ? [] : [larger])];
  if (filling !== undefined && larger?.apply.kind !== "plan") {
    proposals.push(diskRule(name, figures, filling, priced));
  }
  if (proposals.length === 0 && priced !== undefined && figures.history !== undefined) {
    const smaller = smallerRule(readings, priced, figures.history);
    if (smaller !== undefined) proposals.push(smaller);
  }
  return proposals;
}

/** The disk a type needs to hold what is in use under `diskHigh`, in GB. */
function diskNeedGb(figures: ServerReadings): number {
  return (figures.now.server?.disk?.usedBytes ?? 0) / GIB / THRESHOLDS.diskHigh;
}

/** `diskFilling`'s reasons, and cleaning up as the way that changes nothing. */
function diskReasons(reasons: readonly Reason[]): Reason[] {
  return [
    ...reasons,
    {
      text: "Old images and logs usually fill a disk: `docker image prune`, run on the server as the deploy user, deletes the images no container uses",
      basis: PLAN,
    },
  ];
}

/**
 * The disk filling or full (`diskFilling`) on a server no larger type is proposed for: a type with
 * a larger disk that brings its use under `diskHigh` (the only way to grow it), with cleaning up as
 * the other way; without such a type (or on a server the user owns), cleaning up, by hand on the
 * server.
 */
function diskRule(
  name: string,
  figures: ServerReadings,
  filling: NonNullable<ReturnType<typeof diskFilling>>,
  priced: PricedServer | undefined,
): Proposal {
  const { urgency } = filling;
  const reasons = diskReasons(filling.reasons);
  const id = `size.${name}.disk`;
  if (priced !== undefined) {
    const current = priced.prices.offer;
    const offer = cheapestServerOffer(
      otherTypes(priced).filter((o) => o.diskGb > current.diskGb),
      priced.location,
      sizeOf(current),
      diskNeedGb(figures),
    );
    if (offer !== undefined) {
      return typeChange(priced, offer, { id, category: "size", urgency, reasons });
    }
  }
  return {
    id,
    category: "size",
    urgency,
    server: name,
    title: `Free space on server ${name}'s disk`,
    reasons,
    apply: {
      kind: "manual",
      text: `On server ${name}, as the deploy user, run \`docker image prune\`: it deletes the images no container uses`,
    },
  };
}

/**
 * True when `offer` holds the containers the plan puts on server `name` as design sizes them: on
 * the app's server their memory limits (and the previews another environment runs there,
 * `sharedPreviewsMb`) next to the edge and the system's reserve, on an extra server its services
 * and add-ons (`extraServerNeed`). So the next `opscrew design` doesn't grow a smaller server
 * straight back.
 */
function holdsContainers(
  { plan, sharedPreviewsMb = 0 }: Pick<Readings, "plan" | "sharedPreviewsMb">,
  name: string,
  offer: ComputeOffer,
): boolean {
  const serverMb = offer.memoryGb * 1024;
  if (name === APP_SERVER) {
    const limitsMb = appMemoryMb(onAppServer(plan)) + sharedPreviewsMb;
    return memoryHeadroom(serverMb, limitsMb, edgeMemoryMb(edgeProxy(plan))).fits;
  }
  const need = extraServerNeed(servicesOn(plan, name), monitoringLimits(plan, name));
  return serverMb >= need.memoryMb && offer.vcpus >= need.vcpus;
}

/**
 * The next smaller type, with at least `minHistoryDaysToShrink` days of history (never on one
 * reading, FR-2106): cheaper, with no more CPUs or memory and fewer of one, at least the current
 * disk (neither provider shrinks one), room for the p95 CPU and memory with `shrinkHeadroom` to
 * spare, and for the plan's containers ({@link holdsContainers}); of those, the closest to the
 * current type.
 */
function smallerRule(
  readings: Readings,
  priced: PricedServer,
  history: ServerHistory,
): Proposal | undefined {
  const { cpuP95, memoryP95, days } = history;
  if (days < THRESHOLDS.minHistoryDaysToShrink || cpuP95 === undefined || memoryP95 === undefined) {
    return undefined;
  }
  const current = priced.prices.offer;
  const usable = 1 - THRESHOLDS.shrinkHeadroom;
  const cpuOn = (o: ComputeOffer) => (cpuP95 * current.vcpus) / o.vcpus;
  const memoryOn = (o: ComputeOffer) => (memoryP95 * current.memoryGb) / o.memoryGb;
  const next = otherTypes(priced)
    .filter(
      (o) =>
        o.monthly.amount < current.monthly.amount &&
        o.diskGb >= current.diskGb &&
        o.vcpus <= current.vcpus &&
        o.memoryGb <= current.memoryGb &&
        (o.vcpus < current.vcpus || o.memoryGb < current.memoryGb) &&
        cpuOn(o) <= usable &&
        memoryOn(o) <= usable &&
        holdsContainers(readings, priced.name, o),
    )
    .sort(
      (a, b) =>
        b.monthly.amount - a.monthly.amount ||
        b.memoryGb - a.memoryGb ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0];
  if (next === undefined) return undefined;
  const basis = historyBasis(history);
  const users = readings.requirements?.expectedMonthlyUsers;
  return typeChange(priced, next, {
    id: `size.${priced.name}.smaller`,
    category: "size",
    urgency: "when-convenient",
    reasons: [
      {
        text: "The CPUs were in use at the 95th percentile",
        figure: `${percent(cpuP95)} of ${current.vcpus} vCPU`,
        basis,
      },
      {
        text: "The memory was in use at the 95th percentile",
        figure: `${percent(memoryP95)} of ${current.memoryGb} GB`,
        basis,
      },
      {
        text: `On ${next.id} the CPUs would be ${percent(cpuOn(next))} in use and the memory ${percent(memoryOn(next))}`,
        basis: PLAN,
      },
      {
        text: `OpsCrew proposes a smaller type only when both stay at or under ${percent(usable)} of it over at least ${plural(THRESHOLDS.minHistoryDaysToShrink, "day")}, and it still holds the containers' memory limits`,
        basis: PLAN,
      },
      ...(users === undefined
        ? []
        : [
            {
              text: `Sized on ${plural(Math.floor(days), "day")} of figures rather than the expected ${users} monthly users`,
              basis: PLAN,
            },
          ]),
    ],
  });
}

/**
 * The size proposals (US3, US4, FR-2106): per server read, a container at its limit, a larger or
 * smaller server, the disk. On the user's own server, in a Portainer or on this computer, no
 * resize or price: containers' limits, what a server short of memory or CPUs needs, and cleaning
 * up a full disk by hand. None for Cloudflare's hosting or GitHub Pages.
 */
export function sizeRules(readings: Readings): Proposal[] {
  const { plan } = readings;
  if (isServerlessProvider(plan.target.provider)) return [];
  const cloud = new Map(cloudServers(readings).map((s) => [s.name, s]));
  return planTargets(plan).flatMap(({ name, target }) => {
    const figures = readings.servers[name];
    if (figures === undefined) return [];
    const server = cloud.get(name);
    const priced = server !== undefined && isPriced(server) ? server : undefined;
    const totalBytes = figures.now.server?.memory.totalBytes;
    return serverRules(readings, {
      name,
      provider: target.provider,
      figures,
      cloud: server,
      priced,
      memory: memoryInUse(figures),
      totalGb:
        priced?.prices.offer.memoryGb ?? (totalBytes === undefined ? undefined : totalBytes / GIB),
    });
  });
}
