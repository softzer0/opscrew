import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { plural } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { trackedFiles } from "../shared";

/** The committed Cloudflare configuration of a Portainer root: its directory and the modules. */
function staleRootDirs(plan: DeployPlan): [string, string] {
  const dir = plan.infra.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return [dir, `${posix.dirname(dir)}/modules`];
}

/**
 * Files of the earlier Cloudflare configuration that are deleted in the working copy but still
 * committed: an earlier run removed them (after its approval) and stopped before its commit.
 */
export function uncommittedRemovals(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  return trackedFiles(deps, staleRootDirs(plan), { deleted: true });
}

/**
 * After the removal of an earlier Cloudflare setup: takes its committed configuration (the root
 * module under `plan.infra.dir` and the vendored modules beside it) out of the repository, after a
 * `repo-write` approval that lists the files. Returns the removed paths (relative, for the commit).
 */
export async function removeStaleRoot(deps: PhaseDeps, plan: DeployPlan): Promise<string[]> {
  const [dir, modules] = staleRootDirs(plan);
  const paths = await trackedFiles(deps, [dir, modules]);
  if (paths.length === 0) return [];
  const approval = await deps.approvals.request({
    kind: "repo-write",
    title: `Remove the Cloudflare configuration this setup no longer uses from the repository (${plural(paths.length, "file")})`,
    details: paths.map((path) => `  removed  ${path}`).join("\n"),
  });
  if (!approval.approved) {
    deps.reporter.warn(
      `The Cloudflare configuration under ${dir}/ stays in the repository although nothing in Cloudflare uses it any more; remove it yourself when you are ready.`,
    );
    return [];
  }
  for (const path of paths) await rm(join(deps.paths.root, path), { force: true });
  deps.reporter.success(
    `Removed ${plural(paths.length, "file")} of the earlier Cloudflare configuration.`,
  );
  return paths;
}
