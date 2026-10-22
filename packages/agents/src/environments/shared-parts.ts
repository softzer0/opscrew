import { canonicalJson, listText, OpsCrewError, type ProjectPaths } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { environmentPaths } from "./paths";

/**
 * The parts of the app every environment shares (data-model.md "Shared parts"), by their place in
 * the plan: how it is built and served, and what runs next to it. Design copies them from prod's
 * plan; provision refuses an environment whose copy differs.
 */
const SHARED_PARTS = {
  "app.build": (plan) => plan.app.build,
  "app.port": (plan) => plan.app.port,
  "app.healthPath": (plan) => plan.app.healthPath,
  "app.releaseCommand": (plan) => plan.app.releaseCommand,
  processes: (plan) => plan.processes,
  services: (plan) => plan.services,
  "storage.sqlite": (plan) => plan.storage?.sqlite,
  externalServices: (plan) => plan.externalServices,
  // The source environment's workflow signs, and the promoted one's verify job checks it.
  "supplyChain.sign": (plan) => plan.supplyChain.sign,
} satisfies Record<string, (plan: DeployPlan) => unknown>;

/** The shared parts (by their place in the plan, `app.port`) in which `plan` differs from prod's. */
export function sharedPartsDiffer(prodPlan: DeployPlan, plan: DeployPlan): string[] {
  return Object.entries(SHARED_PARTS)
    .filter(([, part]) => canonicalJson(part(prodPlan)) !== canonicalJson(part(plan)))
    .map(([name]) => name);
}

/** `plan` with the shared parts of prod's plan (the rest of `storage` stays the plan's own). */
export function withSharedParts(plan: DeployPlan, prodPlan: DeployPlan): DeployPlan {
  const { build: _build, releaseCommand: _release, ...app } = plan.app;
  const { storage: _storage, ...rest } = plan;
  const { sqlite: _sqlite, ...ownStorage } = plan.storage ?? {};
  const sqlite = prodPlan.storage?.sqlite;
  const storage = { ...ownStorage, ...(sqlite === undefined ? {} : { sqlite }) };
  return {
    ...rest,
    app: {
      ...app,
      port: prodPlan.app.port,
      healthPath: prodPlan.app.healthPath,
      ...(prodPlan.app.build === undefined ? {} : { build: prodPlan.app.build }),
      ...(prodPlan.app.releaseCommand === undefined
        ? {}
        : { releaseCommand: prodPlan.app.releaseCommand }),
    },
    processes: prodPlan.processes,
    services: prodPlan.services,
    externalServices: prodPlan.externalServices,
    ...(Object.keys(storage).length === 0 ? {} : { storage }),
    supplyChain: { ...plan.supplyChain, sign: prodPlan.supplyChain.sign },
  };
}

/**
 * Provision's preflight for an environment other than prod: stops (`PHASE_PRECONDITION`, nothing
 * changed) when its plan's shared parts differ from prod's plan, naming them.
 */
export async function requireSharedParts(paths: ProjectPaths, plan: DeployPlan): Promise<void> {
  const name = paths.environment;
  if (name === "prod") return;
  const prodPlan = await readArtifact("plan", environmentPaths(paths, "prod").files.plan);
  const differ = sharedPartsDiffer(prodPlan, plan);
  if (differ.length === 0) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${name} environment's plan differs from prod's in what every environment shares: ${listText(differ)}. Nothing was changed.`,
    {
      hint: `Run \`opscrew design --env ${name}\` to take them from prod's plan, then run the command again.`,
    },
  );
}
