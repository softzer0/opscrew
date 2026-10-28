import type { ProjectPaths } from "@opscrew/core";
import { checkEnvironmentKey, type RenderedFile, renderCheck } from "@opscrew/iac-templates";
import { appsOf, type DeployPlan, environmentsOf, readArtifact } from "@opscrew/plan-schema";
import { appPaths } from "../apps/list";
import { readOwnServer } from "../shared/server-record";

/** The repository the check runs in, and how to read its visibility (only when needed). */
export interface CheckRepo {
  owner: string;
  name: string;
  isPublic: () => Promise<boolean>;
}

/**
 * The check's id of a server the user owns: `own-` and its pinned host key's fingerprint
 * (base64url), which identifies the server without its address.
 */
function ownServerId(hostKey: string): string {
  return `own-${hostKey
    .replace(/^SHA256:/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
}

/** Every other app's and environment's plan in the repository than `plan`'s, with its paths. */
export async function otherPlans(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  plan: DeployPlan,
): Promise<{ plan: DeployPlan; paths: ProjectPaths }[]> {
  const key = checkEnvironmentKey(plan);
  const others: { plan: DeployPlan; paths: ProjectPaths }[] = [];
  for (const app of await appsOf(paths.root)) {
    for (const name of await environmentsOf(paths.root, app.key)) {
      const own = appPaths(paths, app.key, name);
      const other = await readArtifact("plan", own.files.plan);
      if (checkEnvironmentKey(other) !== key) others.push({ plan: other, paths: own });
    }
  }
  return others;
}

/**
 * The scheduled check's files (`renderCheck`), re-rendered from every app's and environment's plan
 * in the repository, with `plan` (this run's, perhaps changed since it was read) in place of its
 * own file. Each own server's id is its pinned host key's fingerprint, from its environment's
 * record on this computer, so environments on one server are checked once. None when no plan has
 * the check on (the repository's visibility is then not read).
 */
export async function checkFiles(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  plan: DeployPlan,
  repo: CheckRepo,
): Promise<RenderedFile[]> {
  const entries = [
    { plan, paths: appPaths(paths, plan.app.key, plan.environment?.name) },
    ...(await otherPlans(paths, plan)),
  ];
  const checked = entries.some(
    (entry) =>
      entry.plan.observability?.check?.enabled === true &&
      entry.plan.deployment.destroyedAt === undefined,
  );
  if (!checked) return [];
  const serverIds: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.plan.target.provider !== "own") continue;
    const hostKey = (await readOwnServer(entry.paths))?.hostKey;
    if (hostKey !== undefined) serverIds[checkEnvironmentKey(entry.plan)] = ownServerId(hostKey);
  }
  return renderCheck({
    plans: entries.map((entry) => entry.plan),
    repo: { owner: repo.owner, name: repo.name, public: await repo.isPublic() },
    serverIds,
  });
}
