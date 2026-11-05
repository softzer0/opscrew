import type { ComputeCatalog, ComputeOffer } from "@opscrew/contracts";
import { listText, OpsCrewError, plural } from "@opscrew/core";
import { providerBucket } from "@opscrew/iac-templates";
import type { DeployPlan, Previews, ProjectFacts } from "@opscrew/plan-schema";
import { storageVariableKind } from "../shared/app-env";
import {
  type AppMemoryInput,
  appMemoryLimits,
  memoryHeadroom,
  SYSTEM_RESERVE_MB,
} from "../shared/memory";
import type { PlacementEdits, PreviewAddon } from "./placement-edits";
import { type Sizing, usableOffer } from "./sizing";

/** The most previews a preview server runs at once (`environment.previews.cap`'s bound). */
const MAX_PREVIEW_CAP = 20;

/** What design is told about a new preview environment (`opscrew env add --previews`). */
export interface PreviewDesignInput {
  /** The Cloudflare zone the wildcard record `*.<previews.domain>` goes in, found by `env add`. */
  zone: string;
  /** The server type the user chose (`--size`): the cap is what its memory holds. */
  serverType?: string;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/**
 * The memory line of a preview server: the cap, each preview's memory limits (the app and its
 * services, as the runtime renders them), the edge's and the system's share and what stays free.
 */
export function previewMemoryText(
  components: AppMemoryInput,
  cap: number,
  serverMb: number,
  edgeMb: number,
): string {
  const limits = appMemoryLimits(components);
  const each = limits.reduce((sum, limit) => sum + limit.memoryMb, 0);
  const free = Math.max(0, serverMb - cap * each - edgeMb - SYSTEM_RESERVE_MB);
  return `Memory limits: up to ${plural(cap, "preview")} at once, each ${each} MB (${limits.map((l) => `${l.name} ${l.memoryMb} MB`).join(", ")}); OpsCrew's edge and the system ${edgeMb + SYSTEM_RESERVE_MB} MB; ${gb(free)} of ${gb(serverMb)} free.`;
}

/** How many previews of `eachMb` a server of `serverMb` holds next to the edge and the system. */
function capFor(serverMb: number, eachMb: number, edgeMb: number): number {
  return Math.min(MAX_PREVIEW_CAP, Math.floor((serverMb - SYSTEM_RESERVE_MB - edgeMb) / eachMb));
}

/**
 * The catalogue and cap a preview server is designed with: the cap as given, or with a server
 * type chosen (`serverType`), the catalogue of that type only and the cap its memory holds. The
 * type must be one design can choose for one preview (`sizing`, `sizeFor`'s): x86, available,
 * not deprecated, shared vCPUs (previews ask for no dedicated ones), the vCPUs, disk and memory
 * floor of the sizing, and room for a preview.
 * @throws OpsCrewError `INVALID_INPUT`, listing those it can choose, for any other type.
 */
export async function previewCapacity(
  catalog: ComputeCatalog,
  input: { cap: number; serverType?: string | undefined },
  sizing: Sizing,
  locations: readonly string[],
): Promise<{ catalog: ComputeCatalog; cap: number }> {
  const { serverType } = input;
  if (serverType === undefined) return { catalog, cap: input.cap };
  const capOf = (offer: ComputeOffer) =>
    capFor(offer.memoryGb * 1024, sizing.limitsMb, sizing.edgeMb);
  const choosable = (await Promise.all(locations.map((l) => catalog.listOffers(l))))
    .flat()
    .filter(
      (o) =>
        usableOffer(o) &&
        o.cpuType === "shared" &&
        o.vcpus >= sizing.vcpus &&
        o.diskGb >= sizing.diskGb &&
        o.memoryGb >= sizing.memoryGb &&
        capOf(o) >= 1,
    );
  const offer = choosable.find((o) => o.id === serverType);
  if (offer === undefined) {
    const types = [...new Set(choosable.map((o) => o.id))].sort();
    throw new OpsCrewError(
      "INVALID_INPUT",
      `There is no ${serverType} server type previews can use here; choose one of ${listText(types)}. Nothing was written.`,
      { hint: "Give one of them with --size, or give --cap instead." },
    );
  }
  const only: ComputeCatalog = {
    provider: catalog.provider,
    listOffers: async (location) =>
      (await catalog.listOffers(location)).filter((o) => o.id === serverType),
    extras: (location) => catalog.extras(location),
  };
  return { catalog: only, cap: capOf(offer) };
}

/**
 * Refuses (`PHASE_PRECONDITION`) a server the user owns whose memory, after the system's and the
 * edge's share, does not hold `cap` previews of `eachMb`.
 */
export function requirePreviewsFit(
  serverMb: number,
  cap: number,
  eachMb: number,
  edgeMb: number,
): void {
  if (memoryHeadroom(serverMb, cap * eachMb, edgeMb).fits) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Your server has ${Math.round(serverMb)} MB of memory. After ${SYSTEM_RESERVE_MB} MB for the system and ${edgeMb} MB for OpsCrew's edge, ${plural(cap, "preview")} of ${eachMb} MB each (the app and its services' memory limits) do not fit. Nothing was written.`,
    {
      hint: "Lower the cap (environment.previews.cap in the environment's plan.yaml, or --cap with `opscrew env add`), lower the memory limits there, or add memory to the server; then design the environment again.",
    },
  );
}

/**
 * The app's object storage in a preview environment: no bucket at a provider (a bucket's key would
 * be every preview's, and provision would ask for it), so the variables that point the app at its
 * bucket are the user's own, from the environment's values file. Garage, a service of the preview
 * server, stays: each preview runs its own.
 */
function previewStorage(plan: DeployPlan): Pick<DeployPlan, "storage" | "app"> {
  if (providerBucket(plan) === undefined) return { storage: plan.storage, app: plan.app };
  const { objectStorage: _bucket, ...storage } = plan.storage ?? {};
  const env = plan.app.env.map((variable) =>
    variable.source === "derived" && storageVariableKind(variable.name) !== undefined
      ? { ...variable, source: "user" as const }
      : variable,
  );
  return { storage, app: { ...plan.app, env } };
}

/**
 * The line design says for a preview environment of an app with a bucket at a provider (see
 * {@link previewPlan}); `undefined` without one.
 */
export function previewStorageLine(designed: DeployPlan, name: string): string | undefined {
  const bucket = providerBucket(designed);
  if (bucket === undefined) return undefined;
  return `Previews get no bucket: each preview uses the object storage .env.${name} names (for example a test bucket of yours), not ${bucket.bucket}.`;
}

/**
 * The plan of a preview environment, from the one design made for it: a DNS-only Cloudflare zone
 * without a hostname of its own (its base is `previews.domain`, data-model.md), open to everyone
 * on ports 80 and 443, no signing and no deploy tags, no bucket at a provider (its storage
 * variables come from the values file, {@link previewStorageLine}), and the detected seed command
 * when its `previews` set none (`null` when detection found none).
 */
export function previewPlan(plan: DeployPlan, zone: string, facts: ProjectFacts): DeployPlan {
  const { environment } = plan;
  // A later design's block is the previous plan's, which it keeps once this plan is made.
  const previews = environment?.previews;
  const seed = previews?.seed === undefined ? (facts.build.seedCommand ?? null) : previews.seed;
  return {
    ...plan,
    ...previewStorage(plan),
    ...(environment === undefined || previews === undefined
      ? {}
      : { environment: { ...environment, previews: { ...previews, seed } } }),
    // Each preview's site is a Caddy site that gets its own certificate.
    ...("edge" in plan.target ? { target: { ...plan.target, edge: "caddy" as const } } : {}),
    dns: { provider: "cloudflare", zone, proxied: false, www: false },
    security: { ...plan.security, httpAllowedFrom: "any" },
    supplyChain: { ...plan.supplyChain, sign: false },
    cicd: { ...plan.cicd, deployTags: { enabled: false, release: false } },
  };
}

/** Why each add-on is off in a preview environment. */
const ADDON_OFF: Record<PreviewAddon, string> = {
  beszel: "Beszel is off: it watches prod's servers, not previews.",
  grafanaCloud: "Grafana Cloud is off: it watches prod's servers, not previews.",
  check: "The scheduled check is off: it watches a deployed app, and previews come and go.",
};

/**
 * What a preview environment leaves out of the placement `edits` plan.yaml holds, a line each:
 * every preview runs on its one server, so its extra servers, the self-hosted monitoring and the
 * add-ons go (design places nothing).
 */
export function previewEdits(edits: PlacementEdits): string[] {
  const lines = edits.servers.map((server) => {
    const services = Object.keys(edits.placed).filter((name) => edits.placed[name] === server.name);
    const there =
      services.length === 0
        ? ""
        : `, so ${listText(services)} ${services.length === 1 ? "runs" : "run"} there too`;
    return `Server ${server.name} is left out: every preview runs on the preview environment's one server${there}.`;
  });
  if (edits.monitoring?.enabled === true) {
    lines.push("The self-hosted monitoring is off: it watches prod's servers, not previews.");
  }
  for (const addon of edits.addonsOff ?? []) lines.push(ADDON_OFF[addon]);
  return lines;
}

/** What the previews are, in a line: the cap, their addresses, their lifetime and their seed. */
export function previewsLine(previews: Previews): string {
  const seed =
    previews.seed === null || previews.seed === undefined
      ? "with no seed command"
      : `seeded once with \`${previews.seed}\``;
  return `Previews: up to ${plural(previews.cap, "preview")} at once at pr-<number>.${previews.domain}, each removed after ${plural(previews.lifetimeDays, "day")} without a push, ${seed}.`;
}
