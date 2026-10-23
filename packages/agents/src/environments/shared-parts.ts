import {
  canonicalJson,
  listText,
  OpsCrewError,
  type ProjectPaths,
  toPosixRelative,
} from "@opscrew/core";
import { type DeployPlan, type PlanService, readOptionalArtifact } from "@opscrew/plan-schema";
import { imageSource } from "../localhost/image";
import { environmentPaths } from "./paths";

/**
 * The parts of the app every environment shares (data-model.md "Shared parts"), by their place in
 * the plan, besides its services: how it is built and served, and what runs next to it. They
 * follow the image (FR-1539): an environment that builds takes them from its own design, and the
 * design of one that runs another environment's image ({@link sharedPartsSource}) copies them from
 * that environment's plan; provision refuses such an environment whose copy differs.
 */
const SHARED_PARTS = {
  "app.build": (plan) => plan.app.build,
  "app.port": (plan) => plan.app.port,
  "app.healthPath": (plan) => plan.app.healthPath,
  "app.releaseCommand": (plan) => plan.app.releaseCommand,
  processes: (plan) => plan.processes,
  "storage.sqlite": (plan) => plan.storage?.sqlite,
  externalServices: (plan) => plan.externalServices,
  // The source environment's workflow signs, and the promoted one's verify job checks it.
  "supplyChain.sign": (plan) => plan.supplyChain.sign,
} satisfies Record<string, (plan: DeployPlan) => unknown>;

/**
 * What `plan` lacks of the shared parts of `source`, the plan it takes them from: each service of
 * `source` missing in `plan` or with other settings (`services.cache (missing)`), then each other
 * part that differs (by its place in the plan, `app.port`). Services `plan` has beyond the
 * source's are not differences: the image it runs may still use them.
 */
export function sharedPartsDiffer(source: DeployPlan, plan: DeployPlan): string[] {
  const own = new Map(plan.services.map((service) => [service.name, canonicalJson(service)]));
  const services = source.services.flatMap((service) => {
    const theirs = own.get(service.name);
    if (theirs === canonicalJson(service)) return [];
    return [`services.${service.name} (${theirs === undefined ? "missing" : "other settings"})`];
  });
  const parts = Object.entries(SHARED_PARTS)
    .filter(([, part]) => canonicalJson(part(source)) !== canonicalJson(part(plan)))
    .map(([name]) => name);
  return [...services, ...parts];
}

/**
 * `plan` with the shared parts of `source` (the rest of `storage` stays the plan's own): the
 * source's services, then the `kept` ones the image the environment runs may still use.
 */
export function withSharedParts(
  plan: DeployPlan,
  source: DeployPlan,
  kept: readonly PlanService[] = [],
): DeployPlan {
  const { build: _build, releaseCommand: _release, ...app } = plan.app;
  const { storage: _storage, ...rest } = plan;
  const { sqlite: _sqlite, ...ownStorage } = plan.storage ?? {};
  const sqlite = source.storage?.sqlite;
  const storage = { ...ownStorage, ...(sqlite === undefined ? {} : { sqlite }) };
  return {
    ...rest,
    app: {
      ...app,
      port: source.app.port,
      healthPath: source.app.healthPath,
      ...(source.app.build === undefined ? {} : { build: source.app.build }),
      ...(source.app.releaseCommand === undefined
        ? {}
        : { releaseCommand: source.app.releaseCommand }),
    },
    processes: source.processes,
    services: [...source.services, ...kept],
    externalServices: source.externalServices,
    ...(Object.keys(storage).length === 0 ? {} : { storage }),
    supplyChain: { ...plan.supplyChain, sign: source.supplyChain.sign },
  };
}

/** The environment whose image another one runs, with its plan: where its shared parts come from. */
export interface SharedPartsSource {
  name: string;
  plan: DeployPlan;
}

/**
 * Where the environment `paths` belong to takes its shared parts from (FR-1539): the environment
 * whose image it runs. That is the one it is promoted from (by its plan's `environment` block), or
 * for a plan on this computer that pulls its image (`target.image: registry`) the one
 * `imageSource` names, prod's for one built from main. `undefined` when it builds its own image
 * (prod included, a localhost environment on the local runner that follows a branch, or before its
 * target is known), since it then takes them from its own design.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming the source when it is promoted from an
 * environment that has no plan yet.
 */
export async function sharedPartsSource(
  paths: ProjectPaths,
  plan: Pick<DeployPlan, "environment"> & { target?: { provider: string; image?: string } },
): Promise<SharedPartsSource | undefined> {
  const from = plan.environment?.deploySource;
  if (from?.from !== "promote") {
    if (plan.target?.provider !== "localhost" || plan.target.image !== "registry") return undefined;
    const image = await imageSource(paths, plan);
    return image === undefined ? undefined : { name: image.environment, plan: image.plan };
  }
  const { source } = from;
  const file = environmentPaths(paths, source).files.plan;
  const sourcePlan = await readOptionalArtifact("plan", file);
  if (sourcePlan !== undefined) return { name: source, plan: sourcePlan };
  const name = paths.environment;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${name} environment is promoted from ${source}, so it takes what every environment shares (the build, the components, the port) from ${source}'s plan, and ${toPosixRelative(paths.root, file)} does not exist yet. Nothing was changed.`,
    {
      hint: `Run \`opscrew design --env ${source}\` first, then \`opscrew design --env ${name}\`.`,
    },
  );
}

/**
 * Provision's preflight: stops (`PHASE_PRECONDITION`, nothing changed) when the plan of an
 * environment that runs another one's image lacks shared parts of that environment's plan
 * ({@link sharedPartsSource}, {@link sharedPartsDiffer}), naming them and the source. An
 * environment that builds its own image is not checked.
 */
export async function requireSharedParts(paths: ProjectPaths, plan: DeployPlan): Promise<void> {
  const source = await sharedPartsSource(paths, plan);
  if (source === undefined) return;
  const differ = sharedPartsDiffer(source.plan, plan);
  if (differ.length === 0) return;
  const name = paths.environment;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${name} environment runs ${source.name}'s image, and its plan differs from ${source.name}'s in what every environment shares: ${listText(differ)}. Nothing was changed.`,
    {
      hint: `Run \`opscrew design --env ${name}\` to take them from ${source.name}'s plan, then run the command again.`,
    },
  );
}
