import type { ProjectPaths } from "@opscrew/core";
import {
  type DeployPlan,
  type DeployProvider,
  environmentsOf,
  readArtifact,
} from "@opscrew/plan-schema";
import { listsHostnames, readCloudflareRecord } from "../provision/shared-cloudflare";
import { hasDeployment, hasState, readPortainerConnection } from "../shared";
import { environmentPaths } from "./paths";

/** One environment, as `opscrew env list` shows it. */
export interface EnvironmentSummary {
  name: string;
  /** Where it runs: `hetzner`, `digitalocean`, `own`, `portainer` or `localhost`. */
  target: DeployProvider;
  /** `main` (built and deployed on each push), or the environment it is promoted from. */
  from: string;
  /** Where its deploy job runs. */
  runner: NonNullable<DeployPlan["environment"]>["runner"];
  /** The runner machine of `runner: host`, by its name. */
  runnerHost?: string;
  /** Whether something of it may be running or left behind ({@link environmentDeployed}). */
  deployed: boolean;
}

/**
 * True while the environment may have something running or left behind: an applied deployment
 * not destroyed since, an infrastructure state while it was never destroyed (a first apply that
 * stopped half-way records nothing in the plan), its hostnames in OpsCrew's shared Cloudflare
 * rules or its origin certificates (provision applies them before the infrastructure, so the
 * record may be all there is), or what OpsCrew created in a Portainer. A damaged record stops.
 */
export async function environmentDeployed(paths: ProjectPaths, plan: DeployPlan): Promise<boolean> {
  if (hasDeployment(plan)) return true;
  if (plan.deployment.destroyedAt === undefined && (await hasState(paths))) return true;
  const cloudflare = await readCloudflareRecord(paths);
  const certificates = cloudflare?.tls?.origin ?? cloudflare?.tls?.client;
  if (cloudflare !== undefined && (listsHostnames(cloudflare) || certificates !== undefined)) {
    return true;
  }
  const created = (await readPortainerConnection(paths))?.created;
  return (
    created !== undefined &&
    (created.stacks.length > 0 || created.registryId !== undefined || created.volumes.length > 0)
  );
}

/**
 * The app's environments in their order (`environmentsOf`: each after its source), each with its
 * target, deploy source, runner and whether it is deployed. `paths` are any environment's.
 */
export async function listEnvironments(paths: ProjectPaths): Promise<EnvironmentSummary[]> {
  const names = await environmentsOf(paths.root);
  return Promise.all(
    names.map(async (name) => {
      const own = environmentPaths(paths, name);
      const plan = await readArtifact("plan", own.files.plan);
      const source = plan.environment?.deploySource;
      return {
        name,
        target: plan.target.provider,
        from: source?.from === "promote" ? source.source : "main",
        runner: plan.environment?.runner ?? "github",
        ...(plan.environment?.runnerHost !== undefined
          ? { runnerHost: plan.environment.runnerHost.name }
          : {}),
        deployed: await environmentDeployed(own, plan),
      };
    }),
  );
}
